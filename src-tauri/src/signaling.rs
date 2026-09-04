//! Embedded signaling server.
//!
//! An installed RemoteDesk must be able to host a session with nothing else
//! running — no Node process, no cloud service. So the host process itself
//! serves the rendezvous point that carries SDP offers/answers and ICE
//! candidates between peers. Media never passes through here; once WebRTC has
//! negotiated, the peers talk directly.
//!
//! The wire protocol is plain JSON over a WebSocket at `/rtc`, framed as
//! `{"event": string, "data": value}` in both directions. `src/utils/signaling.ts`
//! is the matching client and `server/index.ts` is an optional standalone relay
//! speaking the same protocol for peers that cannot reach each other directly.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::sync::Mutex as AsyncMutex;
use tower_http::cors::{Any, CorsLayer};

use crate::tunnel::{self, TunnelStart};

/// First port tried. The next few are used if it is taken, so two RemoteDesk
/// instances on one machine (a common way to test) both come up.
pub const DEFAULT_PORT: u16 = 4000;
/// How many consecutive ports to try before giving up.
const PORT_SCAN_RANGE: u16 = 10;

/// How long the host has to answer a PIN-gated join request.
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Failed joins tolerated inside `FAILED_JOIN_WINDOW` before the peer is cut off.
const MAX_FAILED_JOINS: usize = 10;
const FAILED_JOIN_WINDOW: Duration = Duration::from_secs(60);

type PeerId = String;

struct Room {
    room_id: String,
    host: PeerId,
    clients: HashSet<PeerId>,
    /// AnyDesk-style plug-and-play: clients are admitted without prompting.
    unattended: bool,
    pin: Option<String>,
}

struct PendingAuth {
    client: PeerId,
    room_id: String,
}

#[derive(Default)]
struct Hub {
    /// Outbound frame sink per connected peer.
    peers: HashMap<PeerId, UnboundedSender<String>>,
    rooms: HashMap<String, Room>,
    pending: HashMap<String, PendingAuth>,
    failed_joins: HashMap<PeerId, Vec<Instant>>,
}

impl Hub {
    fn send(&self, peer: &str, event: &str, data: Value) {
        if let Some(tx) = self.peers.get(peer) {
            let frame = json!({ "event": event, "data": data }).to_string();
            // A closed receiver just means the peer raced us to disconnect; its
            // reader task cleans up room membership.
            let _ = tx.send(frame);
        }
    }

    /// Records a failed join and reports whether the peer has burned its budget.
    fn record_failed_join(&mut self, peer: &str) -> bool {
        let now = Instant::now();
        let history = self.failed_joins.entry(peer.to_string()).or_default();
        history.retain(|t| now.duration_since(*t) < FAILED_JOIN_WINDOW);
        history.push(now);
        history.len() >= MAX_FAILED_JOINS
    }

    /// Finds the room this peer participates in, as host or as client.
    fn room_of(&self, peer: &str) -> Option<&Room> {
        self.rooms
            .values()
            .find(|r| r.host == peer || r.clients.contains(peer))
    }

    /// Drops the peer from every room and tears down any room it was hosting.
    fn remove_peer(&mut self, peer: &str) {
        let mut notify_hosts: Vec<(PeerId, String)> = Vec::new();
        for room in self.rooms.values_mut() {
            if room.clients.remove(peer) {
                notify_hosts.push((room.host.clone(), room.room_id.clone()));
            }
        }
        for (host, room_id) in notify_hosts {
            self.send(&host, "peer:left", json!({ "peerId": peer }));
            self.send(
                &host,
                "peer-left",
                json!({ "peerId": peer, "senderId": peer, "roomId": room_id }),
            );
        }

        let orphaned: Vec<String> = self
            .rooms
            .values()
            .filter(|r| r.host == peer)
            .map(|r| r.room_id.clone())
            .collect();

        for room_id in orphaned {
            if let Some(room) = self.rooms.remove(&room_id) {
                for client in &room.clients {
                    self.send(
                        client,
                        "session:ended",
                        json!({ "roomId": room_id, "reason": "Host disconnected" }),
                    );
                    self.send(
                        client,
                        "peer-left",
                        json!({ "peerId": peer, "senderId": peer, "roomId": room_id }),
                    );
                }
            }
        }

        self.pending.retain(|_, p| p.client != peer);
        self.peers.remove(peer);
        self.failed_joins.remove(peer);
    }
}

/// Public URL of the running quick tunnel, plus the child process keeping it
/// alive. Held behind an async mutex because starting one awaits `cloudflared`.
#[derive(Default)]
struct TunnelState {
    url: Option<String>,
    child: Option<tokio::process::Child>,
}

/// Resolves a request path to the embedded frontend asset and its MIME type.
///
/// Boxed rather than typed against Tauri so this module stays independent of
/// the app runtime; it is installed during setup, once the app handle exists.
pub type AssetProvider = Box<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// Executes one host-control command on behalf of the local browser UI.
///
/// Implemented in `lib.rs`, where the input engine and clipboard live, so this
/// module stays free of Tauri types.
pub type ControlHandler = Box<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

#[derive(Clone)]
pub struct SignalingHandle {
    hub: Arc<Mutex<Hub>>,
    /// Port the server actually bound, once it is listening.
    port: Arc<Mutex<Option<u16>>>,
    ids: Arc<AtomicU64>,
    tunnel: Arc<AsyncMutex<TunnelState>>,
    /// Serves the web client. `None` until the app installs it.
    assets: Arc<Mutex<Option<AssetProvider>>>,
    /// Executes host-control commands. `None` until the app installs it.
    control: Arc<Mutex<Option<ControlHandler>>>,
    /// Shared secret the local UI must present to drive this machine.
    control_token: Arc<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub port: u16,
    /// URLs another machine on the same network can reach this host at.
    pub lan_addresses: Vec<String>,
    /// Public quick-tunnel URL, once one has been started. `None` otherwise.
    pub tunnel_url: Option<String>,
    pub rooms: usize,
    pub connections: usize,
}

impl SignalingHandle {
    fn new() -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub::default())),
            port: Arc::new(Mutex::new(None)),
            ids: Arc::new(AtomicU64::new(1)),
            tunnel: Arc::new(AsyncMutex::new(TunnelState::default())),
            assets: Arc::new(Mutex::new(None)),
            control: Arc::new(Mutex::new(None)),
            control_token: Arc::new(generate_token()),
        }
    }

    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}{:x}", self.ids.fetch_add(1, Ordering::Relaxed))
    }

    pub fn port(&self) -> Option<u16> {
        *self.port.lock().ok()?
    }

    /// Installs the handler that executes host-control commands.
    pub fn set_control_handler(&self, handler: ControlHandler) {
        if let Ok(mut slot) = self.control.lock() {
            *slot = Some(handler);
        }
    }

    /// Secret the local UI presents to prove the operator opened it.
    pub fn control_token(&self) -> &str {
        &self.control_token
    }

    /// Installs the frontend asset source, enabling the web client routes.
    pub fn set_asset_provider(&self, provider: AssetProvider) {
        if let Ok(mut slot) = self.assets.lock() {
            *slot = Some(provider);
        }
    }

    /// URL a browser on this machine should open to run the session UI.
    ///
    /// Carries the control token, which is what distinguishes the page the
    /// operator opened here from any other browser that can reach this port.
    /// The page strips it from the address bar as soon as it has read it.
    pub fn local_url(&self) -> Option<String> {
        self.port()
            .map(|p| format!("http://127.0.0.1:{p}/?rdtoken={}", self.control_token))
    }

    /// URL without the secret, for logging and for display to the operator.
    pub fn local_url_public(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}/"))
    }

    pub fn network_info(&self) -> NetworkInfo {
        let port = self.port().unwrap_or(DEFAULT_PORT);
        let (rooms, connections) = match self.hub.lock() {
            Ok(hub) => (hub.rooms.len(), hub.peers.len()),
            Err(poisoned) => {
                let hub = poisoned.into_inner();
                (hub.rooms.len(), hub.peers.len())
            }
        };
        NetworkInfo {
            port,
            lan_addresses: lan_ipv4_addresses()
                .into_iter()
                .map(|ip| format!("http://{ip}:{port}"))
                .collect(),
            // `try_lock` keeps this synchronous getter usable from Tauri
            // commands; a tunnel mid-start simply reports as not-yet-available.
            tunnel_url: self.tunnel.try_lock().ok().and_then(|t| t.url.clone()),
            rooms,
            connections,
        }
    }
}

/// 256 bits of OS randomness, hex encoded.
///
/// This gates control of the machine, so it must not be derived from the clock
/// or a counter. A failure to read the OS entropy source is fatal rather than
/// silently falling back to something guessable.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison, so a caller cannot learn the token byte by byte.
fn token_matches(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Enumerates non-loopback IPv4 addresses, so the operator can read off an
/// address a peer on the same network can actually dial.
pub fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .filter_map(|iface| match iface.addr.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket surface
// ---------------------------------------------------------------------------

async fn healthz(State(handle): State<SignalingHandle>) -> impl IntoResponse {
    let info = handle.network_info();
    Json(json!({
        "status": "ok",
        "port": info.port,
        "rooms": info.rooms,
        "connections": info.connections,
        "lanAddresses": info.lan_addresses,
    }))
}

async fn network_info(State(handle): State<SignalingHandle>) -> impl IntoResponse {
    Json(handle.network_info())
}

/// Starts (or reports the already-running) public tunnel to this host.
async fn start_tunnel(
    State(handle): State<SignalingHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> axum::response::Response {
    use axum::http::StatusCode;

    // Publishing this host to the public internet is the operator's call, made
    // by clicking Generate Public URL in the app they are sitting at. The
    // server binds 0.0.0.0 for signaling, so without this check any other
    // machine on the LAN — not just a peer already in a session — could POST
    // here and force the host onto a public Cloudflare URL with no consent and
    // no visible prompt.
    if !peer.ip().is_loopback() {
        eprintln!("[remotedesk] refused a tunnel start request from {peer} (not loopback)");
        return (StatusCode::FORBIDDEN, "starting a public tunnel is available on loopback only")
            .into_response();
    }

    let port = handle.port().unwrap_or(DEFAULT_PORT);
    let mut state = handle.tunnel.lock().await;

    if let Some(url) = &state.url {
        return Json(json!({ "ok": true, "tunnelUrl": url })).into_response();
    }

    let (result, child) = tunnel::start(port).await;
    match result {
        TunnelStart::Started(url) => {
            state.url = Some(url.clone());
            state.child = child;
            println!("[remotedesk] public tunnel: {url}");
            Json(json!({ "ok": true, "tunnelUrl": url })).into_response()
        }
        TunnelStart::Unavailable(reason) | TunnelStart::Failed(reason) => {
            Json(json!({ "ok": false, "tunnelUrl": Value::Null, "reason": reason })).into_response()
        }
    }
}

/// Extensions the download endpoint will offer. Anything else is ignored.
const INSTALLER_EXTENSIONS: [&str; 6] = [".exe", ".msi", ".deb", ".rpm", ".appimage", ".dmg"];

const RELEASES_URL: &str = "https://github.com/Smileys-Helping-hand/myremotedesktop/releases";

/// Where this process looks for desktop installers to hand out.
///
/// A packaged app does not ship installers — it would have to contain itself —
/// so this is normally empty and the UI falls back to the release page. It
/// exists so that a machine acting as the office's download point can drop the
/// files next to the executable and serve them over the LAN, with no internet
/// and no second web server.
fn installers_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("REMOTEDESK_INSTALLERS_DIR") {
        return Some(std::path::PathBuf::from(dir));
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("installers"))
}

fn classify_installer(file: &str) -> (&'static str, &'static str) {
    let lower = file.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        ("windows", "exe")
    } else if lower.ends_with(".msi") {
        ("windows", "msi")
    } else if lower.ends_with(".deb") {
        ("linux", "deb")
    } else if lower.ends_with(".rpm") {
        ("linux", "rpm")
    } else if lower.ends_with(".appimage") {
        ("linux", "appimage")
    } else if lower.ends_with(".dmg") {
        ("macos", "dmg")
    } else {
        ("linux", "unknown")
    }
}

/// First `major.minor.patch` in a filename, however the bundler spelled the rest.
fn version_from_filename(file: &str) -> Option<String> {
    let bytes: Vec<char> = file.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == '.') {
            if bytes[i] == '.' {
                dots += 1;
            }
            i += 1;
        }
        let candidate: String = bytes[start..i].iter().collect();
        let parts: Vec<&str> = candidate.split('.').collect();
        if dots >= 2 && parts.len() >= 3 && parts[..3].iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            return Some(parts[..3].join("."));
        }
    }
    None
}

fn list_installers() -> Vec<Value> {
    let Some(dir) = installers_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut assets = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if !INSTALLER_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
            continue;
        }
        let (platform, kind) = classify_installer(&name);
        assets.push(json!({
            "file": name,
            "platform": platform,
            "kind": kind,
            "sizeBytes": meta.len(),
            "url": format!("/download/{name}"),
        }));
    }
    assets
}

/// Lists the desktop installers this server can hand out.
///
/// Mirrors `/api/downloads` in `server/index.ts`; the frontend reads one shape
/// regardless of which server answered.
async fn downloads() -> impl IntoResponse {
    let assets = list_installers();
    let version = assets
        .iter()
        .filter_map(|a| a.get("file").and_then(Value::as_str))
        .find_map(version_from_filename);

    Json(json!({
        "version": version,
        "assets": assets,
        "releasesUrl": RELEASES_URL,
    }))
}

/// Serves one installer file.
///
/// The requested name is reduced to its final component and the resolved path
/// is required to sit directly in the installers directory, so no crafted path
/// can escape it.
async fn download_installer(
    axum::extract::Path(file): axum::extract::Path<String>,
) -> impl IntoResponse {
    use axum::http::{header, StatusCode};

    let Some(dir) = installers_dir() else {
        return (StatusCode::NOT_FOUND, "no installer directory").into_response();
    };

    let name = std::path::Path::new(&file)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "invalid file name").into_response();
    }

    let lower = name.to_ascii_lowercase();
    if !INSTALLER_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return (StatusCode::NOT_FOUND, "not an installer").into_response();
    }

    let full = dir.join(&name);
    if full.parent() != Some(dir.as_path()) {
        return (StatusCode::BAD_REQUEST, "invalid file name").into_response();
    }

    // Installers run up to ~80MB. Reading that synchronously on this async
    // handler's own task would block whichever tokio worker thread drew it for
    // as long as the read takes — stalling any signaling or control-channel
    // work that lands on the same thread mid-download. spawn_blocking moves it
    // onto the blocking pool instead.
    let read_result = tokio::task::spawn_blocking(move || std::fs::read(&full)).await;

    match read_result {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{name}\""),
                ),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(_)) => (StatusCode::NOT_FOUND, "no such installer").into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "download task panicked").into_response(),
    }
}

/// Serves the embedded web client.
///
/// Unknown paths fall back to `index.html` so the single-page app keeps working
/// on a deep link or a refresh, which is what a browser-based client does.
async fn serve_asset(
    State(handle): State<SignalingHandle>,
    uri: axum::http::Uri,
) -> axum::response::Response {
    use axum::http::{header, StatusCode};

    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    let resolved = {
        let guard = match handle.assets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.as_ref() {
            // Try the exact path first, then the SPA entry point.
            Some(provider) => provider(path).or_else(|| provider("index.html")),
            None => None,
        }
    };

    match resolved {
        Some((bytes, mime)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime),
                // The bundle is content-hashed by Vite, but index.html is not,
                // so nothing here may be cached across an app update.
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
            bytes,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "RemoteDesk web client is not available in this build.",
        )
            .into_response(),
    }
}

/// Host-control channel for the browser UI running on this machine.
///
/// Two independent gates, because what is on the other side of this socket can
/// move the mouse and type on the host:
///
/// * the caller must be on the loopback interface, so nothing on the network
///   can reach it even though the server binds `0.0.0.0` for signaling; and
/// * it must present the token, so another local process or a page the
///   operator did not open cannot drive the machine either.
async fn control_upgrade(
    State(handle): State<SignalingHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    use axum::http::StatusCode;

    if !peer.ip().is_loopback() {
        eprintln!("[remotedesk] refused a control connection from {peer} (not loopback)");
        return (StatusCode::FORBIDDEN, "control is available on loopback only").into_response();
    }

    let provided = params.get("token").map(String::as_str).unwrap_or_default();
    if !token_matches(handle.control_token(), provided) {
        eprintln!("[remotedesk] refused a control connection with a bad token");
        return (StatusCode::UNAUTHORIZED, "invalid control token").into_response();
    }

    ws.on_upgrade(move |socket| control_session(socket, handle))
}

/// Serves one control connection: a JSON request/response channel.
///
/// Frames in:  `{"id": 1, "cmd": "inject_mouse_move", "args": {...}}`
/// Frames out: `{"id": 1, "ok": true, "result": ...}` or `{"id": 1, "ok": false, "error": "..."}`
///
/// A frame with no `id` is fire-and-forget, which is what the high-frequency
/// mouse stream uses so it never waits on a reply.
async fn control_session(socket: WebSocket, handle: SignalingHandle) {
    let (mut sink, mut stream) = socket.split();
    println!("[remotedesk] host control channel opened");

    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };

        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(cmd) = frame.get("cmd").and_then(Value::as_str) else {
            continue;
        };
        let args = frame.get("args").cloned().unwrap_or(Value::Null);
        let id = frame.get("id").cloned();

        // Injection is a blocking OS call — and on Wayland the very first one
        // may wait on a desktop-portal prompt. Running it on the blocking pool
        // keeps this connection responsive; awaiting it keeps input ordered.
        let control = Arc::clone(&handle.control);
        let cmd_owned = cmd.to_string();
        let outcome = tokio::task::spawn_blocking(move || {
            let guard = match control.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            match guard.as_ref() {
                Some(handler) => handler(&cmd_owned, args),
                None => Err("host control is not available".to_string()),
            }
        })
        .await
        .unwrap_or_else(|e| Err(format!("control command panicked: {e}")));

        // Only answer when the caller asked to be answered.
        let Some(id) = id else { continue };
        let reply = match outcome {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        if sink.send(Message::Text(reply.to_string().into())).await.is_err() {
            break;
        }
    }

    println!("[remotedesk] host control channel closed");
}

async fn ws_upgrade(
    State(handle): State<SignalingHandle>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| peer_session(socket, handle))
}

/// Owns one connected peer for its lifetime: a writer task draining an mpsc
/// queue, and this task reading and dispatching inbound frames.
async fn peer_session(socket: WebSocket, handle: SignalingHandle) {
    let peer_id = handle.next_id("p");
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    {
        let mut hub = lock(&handle);
        hub.peers.insert(peer_id.clone(), tx);
        hub.send(&peer_id, "welcome", json!({ "peerId": peer_id }));
    }

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => break,
            // Ping/Pong are answered by axum; binary frames are not part of this
            // protocol and are ignored rather than treated as fatal.
            _ => continue,
        };

        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(event) = frame.get("event").and_then(Value::as_str) else {
            continue;
        };
        let data = frame.get("data").cloned().unwrap_or(Value::Null);

        if handle_event(&handle, &peer_id, event, data) == Verdict::Disconnect {
            break;
        }
    }

    lock(&handle).remove_peer(&peer_id);
    writer.abort();
}

/// Normalizes a PIN the way both peers must agree on before comparison.
fn normalize_pin(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_uppercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn str_field<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// Accepts both the object form (`{roomId: "..."}`) and the bare-string form
/// that older callers send.
fn room_id_of(data: &Value) -> String {
    match data {
        Value::String(s) => s.trim().to_string(),
        _ => str_field(data, "roomId").unwrap_or("").trim().to_string(),
    }
}

/// Whether a peer may stay connected after the frame it just sent.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    KeepAlive,
    /// The peer exhausted its failed-join budget; drop it so a brute-force
    /// sweep of Desk IDs has to pay for a new connection each time.
    Disconnect,
}

fn lock(handle: &SignalingHandle) -> MutexGuard<'_, Hub> {
    match handle.hub.lock() {
        Ok(hub) => hub,
        // A panicking handler must not take the whole signaling server down
        // with it; the hub is plain data and stays usable.
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn handle_event(handle: &SignalingHandle, peer_id: &str, event: &str, data: Value) -> Verdict {
    match event {
        "host:create" => host_create(handle, peer_id, &data),
        "client:join" => return client_join(handle, peer_id, &data),
        "host:auth-result" => host_auth_result(handle, peer_id, &data),
        "signal" => relay_signal(handle, peer_id, &data),
        "offer" | "answer" | "ice-candidate" => relay_direct(handle, peer_id, event, &data),
        "leave" => {
            let mut hub = lock(handle);
            // Keep the transport open; the peer may re-join another room.
            let tx = hub.peers.get(peer_id).cloned();
            hub.remove_peer(peer_id);
            if let Some(tx) = tx {
                hub.peers.insert(peer_id.to_string(), tx);
            }
        }
        _ => {}
    }
    Verdict::KeepAlive
}

fn host_create(handle: &SignalingHandle, peer_id: &str, data: &Value) {
    let room_id = room_id_of(data);

    let valid = (3..=32).contains(&room_id.len())
        && room_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        lock(handle).send(
            peer_id,
            "host:create:result",
            json!({ "ok": false, "reason": "Invalid Desk ID format" }),
        );
        return;
    }

    let unattended = data
        .get("unattended")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let pin = normalize_pin(str_field(data, "pin"));

    let mut hub = lock(handle);

    // Refuse to steal a room from a host that is still connected.
    if let Some(existing) = hub.rooms.get(&room_id) {
        if existing.host != peer_id && hub.peers.contains_key(&existing.host) {
            hub.send(
                peer_id,
                "host:create:result",
                json!({ "ok": false, "reason": "Desk ID already in use" }),
            );
            return;
        }
    }

    // A reconnecting host keeps whichever clients are still attached.
    let clients = hub
        .rooms
        .get(&room_id)
        .map(|r| r.clients.clone())
        .unwrap_or_default();

    hub.rooms.insert(
        room_id.clone(),
        Room {
            room_id: room_id.clone(),
            host: peer_id.to_string(),
            clients,
            unattended,
            pin,
        },
    );

    hub.send(
        peer_id,
        "host:create:result",
        json!({ "ok": true, "roomId": room_id, "peerId": peer_id }),
    );
}

/// Whether a room's PIN (if it has one) admits a client presenting `provided`.
///
/// A room with no PIN admits everyone — that is what unattended access or an
/// empty pin field means. Otherwise the comparison is constant-time: this is
/// the authoritative check (the same rule the control token uses), and a PIN
/// is exactly the kind of short, guessable secret a timing side-channel is
/// worth denying an attacker, even though exploiting one over a network is a
/// stretch.
fn pin_grants_entry(room_pin: Option<&str>, provided: Option<&str>) -> bool {
    match (room_pin, provided) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(expected), Some(provided)) => token_matches(expected, provided),
    }
}

fn client_join(handle: &SignalingHandle, peer_id: &str, data: &Value) -> Verdict {
    let room_id = room_id_of(data);
    let pin = normalize_pin(str_field(data, "pin"));

    let mut hub = lock(handle);

    let Some(room) = hub.rooms.get(&room_id) else {
        hub.send(
            peer_id,
            "join:result",
            json!({ "granted": false, "reason": "No host is currently sharing that Desk ID" }),
        );
        if hub.record_failed_join(peer_id) {
            hub.send(
                peer_id,
                "join:result",
                json!({ "granted": false, "reason": "Too many failed attempts" }),
            );
            return Verdict::Disconnect;
        }
        return Verdict::KeepAlive;
    };

    let unattended = room.unattended;
    let host = room.host.clone();
    let pin_matches = pin_grants_entry(room.pin.as_deref(), pin.as_deref());

    if unattended || pin_matches {
        hub.failed_joins.remove(peer_id);
        if let Some(room) = hub.rooms.get_mut(&room_id) {
            room.clients.insert(peer_id.to_string());
        }

        hub.send(
            peer_id,
            "join:result",
            json!({
                "granted": true,
                "roomId": room_id,
                "hostId": host,
                "peerId": peer_id,
            }),
        );
        hub.send(&host, "peer:joined", json!({ "peerId": peer_id }));
        hub.send(
            &host,
            "peer-joined",
            json!({ "peerId": peer_id, "senderId": peer_id, "roomId": room_id }),
        );
        return Verdict::KeepAlive;
    }

    // Otherwise defer to the host operator, with a deadline.
    let request_id = handle.next_id("req");
    hub.pending.insert(
        request_id.clone(),
        PendingAuth { client: peer_id.to_string(), room_id: room_id.clone() },
    );
    hub.send(
        &host,
        "peer:join-request",
        json!({
            "requestId": request_id,
            "peerId": peer_id,
            "pin": pin.unwrap_or_default(),
        }),
    );
    drop(hub);

    let handle = handle.clone();
    tokio::spawn(async move {
        tokio::time::sleep(AUTH_TIMEOUT).await;
        let mut hub = lock(&handle);
        if let Some(pending) = hub.pending.remove(&request_id) {
            let client = pending.client.clone();
            hub.send(
                &client,
                "join:result",
                json!({ "granted": false, "reason": "Host did not respond in time" }),
            );
        }
    });

    Verdict::KeepAlive
}

fn host_auth_result(handle: &SignalingHandle, peer_id: &str, data: &Value) {
    let Some(request_id) = str_field(data, "requestId") else {
        return;
    };
    let granted = data.get("granted").and_then(Value::as_bool).unwrap_or(false);
    let reason = str_field(data, "reason").unwrap_or("Rejected by host").to_string();

    let mut hub = lock(handle);
    let Some(pending) = hub.pending.get(request_id) else {
        return;
    };
    let client = pending.client.clone();
    let room_id = pending.room_id.clone();

    // Only the room's own host may rule on its join requests.
    match hub.rooms.get(&room_id) {
        Some(room) if room.host == peer_id => {}
        _ => return,
    }
    hub.pending.remove(request_id);

    if !granted {
        hub.send(&client, "join:result", json!({ "granted": false, "reason": reason }));
        hub.record_failed_join(&client);
        return;
    }

    hub.failed_joins.remove(&client);
    if let Some(room) = hub.rooms.get_mut(&room_id) {
        room.clients.insert(client.clone());
    }

    hub.send(
        &client,
        "join:result",
        json!({
            "granted": true,
            "roomId": room_id,
            "hostId": peer_id,
            "peerId": client,
        }),
    );
    hub.send(peer_id, "peer:joined", json!({ "peerId": client }));
    hub.send(
        peer_id,
        "peer-joined",
        json!({ "peerId": client, "senderId": client, "roomId": room_id }),
    );
}

/// Resolves who should receive a signaling frame from `peer_id` within its room.
/// Shared by both signaling shapes so the room-membership check cannot be
/// bypassed by using the other one.
fn signal_targets(hub: &Hub, peer_id: &str, target_id: Option<&str>) -> (Vec<PeerId>, String) {
    let Some(room) = hub.room_of(peer_id) else {
        return (Vec::new(), String::new());
    };
    let room_id = room.room_id.clone();

    if let Some(target) = target_id {
        // Only ever address a peer that is actually in the same room.
        let is_peer = room.host == target || room.clients.contains(target);
        let targets = if is_peer { vec![target.to_string()] } else { Vec::new() };
        return (targets, room_id);
    }

    let targets = if room.host == peer_id {
        room.clients.iter().cloned().collect()
    } else {
        vec![room.host.clone()]
    };
    (targets, room_id)
}

fn relay_signal(handle: &SignalingHandle, peer_id: &str, data: &Value) {
    let Some(kind) = str_field(data, "kind") else {
        return;
    };
    let payload = data.get("data").cloned().unwrap_or(Value::Null);
    let target_id = str_field(data, "targetId");

    let hub = lock(handle);
    let (targets, room_id) = signal_targets(&hub, peer_id, target_id);
    for target in targets {
        hub.send(
            &target,
            "signal",
            json!({ "fromId": peer_id, "kind": kind, "data": payload }),
        );
        hub.send(
            &target,
            kind,
            json!({ "senderId": peer_id, "roomId": room_id, "data": payload }),
        );
    }
}

fn relay_direct(handle: &SignalingHandle, peer_id: &str, event: &str, data: &Value) {
    let target_id = str_field(data, "targetId");
    let payload = data.get("data").cloned().unwrap_or_else(|| data.clone());

    let hub = lock(handle);
    let (targets, room_id) = signal_targets(&hub, peer_id, target_id);
    for target in targets {
        hub.send(
            &target,
            "signal",
            json!({ "fromId": peer_id, "kind": event, "data": payload }),
        );
        hub.send(
            &target,
            event,
            json!({ "senderId": peer_id, "roomId": room_id, "data": payload }),
        );
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

fn router(handle: SignalingHandle) -> Router {
    // Every caller of these endpoints is cross-origin: the Tauri webview is
    // served from `tauri://localhost`, and a browser client from wherever it was
    // loaded. The data here is a port number and this machine's own LAN
    // addresses — already visible to anyone who can reach the port at all — and
    // no credentials are accepted, so a permissive policy costs nothing.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/healthz", get(healthz))
        .route("/network-info", get(network_info))
        .route("/api/tunnel/start", post(start_tunnel))
        .route("/api/downloads", get(downloads))
        .route("/download/{file}", get(download_installer))
        .route("/rtc", get(ws_upgrade))
        .route("/control", get(control_upgrade))
        // Everything else is the web client. Registered last so the API and the
        // WebSocket endpoint keep priority over the SPA fallback.
        .fallback(get(serve_asset))
        .layer(cors)
        .with_state(handle)
}

/// Starts the signaling server on a background Tokio runtime and returns once
/// it is bound. Errors only if no port in the scan range could be claimed.
pub fn start() -> Result<SignalingHandle, String> {
    let handle = SignalingHandle::new();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("failed to start signaling runtime: {e}"))?;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    let server_handle = handle.clone();

    std::thread::Builder::new()
        .name("remotedesk-signaling".into())
        .spawn(move || {
            runtime.block_on(async move {
                let mut bound = None;
                for offset in 0..PORT_SCAN_RANGE {
                    let port = DEFAULT_PORT + offset;
                    let addr = SocketAddr::from(([0, 0, 0, 0], port));
                    if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
                        bound = Some((listener, port));
                        break;
                    }
                }

                let Some((listener, port)) = bound else {
                    let _ = ready_tx.send(Err(format!(
                        "no free port in {DEFAULT_PORT}..{}",
                        DEFAULT_PORT + PORT_SCAN_RANGE
                    )));
                    return;
                };

                if let Ok(mut slot) = server_handle.port.lock() {
                    *slot = Some(port);
                }
                let _ = ready_tx.send(Ok(port));

                let app = router(server_handle);
                // `into_make_service_with_connect_info` is what makes the peer
                // address available, which the control endpoint checks.
                let app = app.into_make_service_with_connect_info::<SocketAddr>();
                if let Err(err) = axum::serve(listener, app).await {
                    eprintln!("[remotedesk] signaling server stopped: {err}");
                }
            });
        })
        .map_err(|e| format!("failed to spawn signaling thread: {e}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(port)) => {
            println!("[remotedesk] signaling server listening on 0.0.0.0:{port}");
            for ip in lan_ipv4_addresses() {
                println!("[remotedesk]   reachable at http://{ip}:{port}");
            }
            Ok(handle)
        }
        Ok(Err(err)) => Err(err),
        Err(_) => Err("signaling server did not start within 10s".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub_with_room() -> (Hub, PeerId, PeerId) {
        let mut hub = Hub::default();
        let host: PeerId = "host1".into();
        let client: PeerId = "client1".into();
        hub.rooms.insert(
            "784920".into(),
            Room {
                room_id: "784920".into(),
                host: host.clone(),
                clients: HashSet::from([client.clone()]),
                unattended: true,
                pin: None,
            },
        );
        (hub, host, client)
    }

    #[test]
    fn host_broadcasts_to_every_client_when_no_target_is_named() {
        let (hub, host, client) = hub_with_room();
        let (targets, room_id) = signal_targets(&hub, &host, None);
        assert_eq!(targets, vec![client]);
        assert_eq!(room_id, "784920");
    }

    #[test]
    fn client_signals_are_routed_to_the_host() {
        let (hub, host, client) = hub_with_room();
        let (targets, _) = signal_targets(&hub, &client, None);
        assert_eq!(targets, vec![host]);
    }

    #[test]
    fn signals_cannot_be_addressed_to_a_peer_outside_the_room() {
        let (hub, host, _) = hub_with_room();
        let (targets, _) = signal_targets(&hub, &host, Some("stranger"));
        assert!(targets.is_empty(), "outsiders must not be addressable");
    }

    #[test]
    fn peers_with_no_room_have_nowhere_to_signal() {
        let hub = Hub::default();
        let (targets, _) = signal_targets(&hub, "nobody", None);
        assert!(targets.is_empty());
    }

    #[test]
    fn a_client_is_disconnected_once_it_burns_through_failed_joins() {
        let handle = SignalingHandle::new();
        // No room exists, so every join fails. The budget must run out and the
        // last attempt must cost the peer its connection.
        let payload = json!({ "roomId": "no-such-desk" });
        for _ in 0..MAX_FAILED_JOINS - 1 {
            assert_eq!(client_join(&handle, "attacker", &payload), Verdict::KeepAlive);
        }
        assert_eq!(client_join(&handle, "attacker", &payload), Verdict::Disconnect);
    }

    #[test]
    fn failed_joins_trip_only_after_the_budget_is_exhausted() {
        let mut hub = Hub::default();
        for _ in 0..MAX_FAILED_JOINS - 1 {
            assert!(!hub.record_failed_join("peer"));
        }
        assert!(hub.record_failed_join("peer"));
    }

    #[test]
    fn installer_names_are_classified_by_extension() {
        // Names differ per bundler and have already changed once, so the
        // extension is what decides which OS can run the file.
        assert_eq!(classify_installer("RemoteDesk_1.1.0_x64-setup.exe"), ("windows", "exe"));
        assert_eq!(classify_installer("RemoteDesk_1.1.0_amd64.deb"), ("linux", "deb"));
        assert_eq!(classify_installer("RemoteDesk-1.1.0-1.x86_64.rpm"), ("linux", "rpm"));
        assert_eq!(classify_installer("RemoteDesk_1.1.0_amd64.AppImage"), ("linux", "appimage"));
        assert_eq!(classify_installer("RemoteDesk_1.1.0_universal.dmg"), ("macos", "dmg"));
    }

    #[test]
    fn versions_are_read_from_any_bundler_naming() {
        assert_eq!(
            version_from_filename("RemoteDesk_1.1.0_x64-setup.exe").as_deref(),
            Some("1.1.0")
        );
        // The rpm name carries a release number after the version.
        assert_eq!(
            version_from_filename("RemoteDesk-1.1.0-1.x86_64.rpm").as_deref(),
            Some("1.1.0")
        );
        assert_eq!(
            version_from_filename("RemoteDesk_10.20.30_amd64.AppImage").as_deref(),
            Some("10.20.30")
        );
    }

    #[test]
    fn names_without_a_full_version_yield_nothing() {
        assert_eq!(version_from_filename("RemoteDesk-setup.exe"), None);
        // Two components is not a version; guessing one would be worse than
        // reporting none, since the UI prints it next to the download.
        assert_eq!(version_from_filename("RemoteDesk_1.1_amd64.deb"), None);
    }

    #[test]
    fn control_tokens_are_long_random_hex() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64, "256 bits, hex encoded");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "each start must get a fresh token");
    }

    #[test]
    fn only_the_exact_control_token_is_accepted() {
        let token = generate_token();
        assert!(token_matches(&token, &token));
        assert!(!token_matches(&token, ""));
        assert!(!token_matches(&token, &token[..63]), "a prefix must not pass");

        let mut tampered = token.clone();
        tampered.pop();
        tampered.push(if token.ends_with('a') { 'b' } else { 'a' });
        assert!(!token_matches(&token, &tampered));
    }

    #[test]
    fn pins_compare_case_and_whitespace_insensitively() {
        assert_eq!(normalize_pin(Some("  ab12 ")).as_deref(), Some("AB12"));
        assert_eq!(normalize_pin(Some("   ")), None);
        assert_eq!(normalize_pin(None), None);
    }

    #[test]
    fn room_ids_are_read_from_both_payload_shapes() {
        assert_eq!(room_id_of(&json!("  784920 ")), "784920");
        assert_eq!(room_id_of(&json!({ "roomId": "desk-1" })), "desk-1");
        assert_eq!(room_id_of(&json!({})), "");
    }

    #[test]
    fn a_room_with_no_pin_admits_anyone() {
        assert!(pin_grants_entry(None, None));
        assert!(pin_grants_entry(None, Some("AB12")));
        assert!(pin_grants_entry(None, Some("")));
    }

    #[test]
    fn a_pin_protected_room_requires_an_exact_match() {
        assert!(pin_grants_entry(Some("AB12"), Some("AB12")));
        assert!(!pin_grants_entry(Some("AB12"), Some("ZZ99")));
        assert!(!pin_grants_entry(Some("AB12"), None));
        // Case and whitespace are normalize_pin's job, applied before this
        // point — this function itself must not paper over a mismatch.
        assert!(!pin_grants_entry(Some("AB12"), Some("ab12")));
    }

    #[test]
    fn losing_the_host_ends_the_room_for_its_clients() {
        let (mut hub, host, client) = hub_with_room();
        hub.remove_peer(&host);
        assert!(hub.rooms.is_empty(), "room must not outlive its host");
        assert!(hub.room_of(&client).is_none());
    }
}

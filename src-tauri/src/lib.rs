//! RemoteDesk Tauri host process.
//!
//! Exposes the OS-level capabilities the webview cannot have on its own:
//! enumerating physical displays, injecting mouse/keyboard input, and the
//! safety interlocks around that injection.

mod input;
mod keymap;
mod platform;
mod signaling;
mod tunnel;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use input::{InjectionStatus, InputState, TargetRect};

/// How often the host cursor is sampled to detect physical operator input.
const KILL_SWITCH_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Accelerator that immediately revokes remote control.
const PANIC_ACCELERATOR: &str = "CmdOrCtrl+Alt+Shift+K";

pub struct AppState {
    pub input: Arc<InputState>,
    /// `None` when the embedded signaling server could not bind a port; the app
    /// still runs and can join a session hosted elsewhere.
    pub signaling: Option<signaling::SignalingHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    /// Physical pixel dimensions of the monitor.
    pub width: u32,
    pub height: u32,
    /// Physical desktop-space origin, used to address multi-monitor layouts.
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillSwitchEvent {
    pub suspended_until_ms: u64,
    pub cooldown_ms: u64,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Enumerates real, attached displays. There is no fallback list — if the OS
/// reports no monitors, that is surfaced as an error rather than papered over.
#[tauri::command]
fn get_displays(app: AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("failed to enumerate monitors: {e}"))?;

    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());

    if monitors.is_empty() {
        return Err("the operating system reported no attached displays".into());
    }

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let name = m.name().cloned().unwrap_or_else(|| format!("Display {}", index + 1));
            let size = m.size();
            let position = m.position();
            DisplayInfo {
                id: format!("display-{index}"),
                is_primary: primary_name.as_ref() == Some(&name),
                name,
                width: size.width,
                height: size.height,
                x: position.x,
                y: position.y,
                scale_factor: m.scale_factor(),
            }
        })
        .collect())
}

/// Selects which physical region normalized remote coordinates project onto.
#[tauri::command]
fn set_target_display(state: State<'_, AppState>, display: DisplayInfo) -> Result<(), String> {
    state.input.set_target(TargetRect {
        x: display.x,
        y: display.y,
        width: display.width as i32,
        height: display.height as i32,
    })
}

/// Host operator's grant or revocation of remote control.
#[tauri::command]
fn set_control_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<InjectionStatus, String> {
    state.input.set_control_enabled(enabled);
    if enabled {
        state.input.clear_kill_switch();
    }
    let status = state.input.status();
    let _ = app.emit("injection-status", &status);
    Ok(status)
}

#[tauri::command]
fn set_kill_switch_armed(state: State<'_, AppState>, armed: bool) {
    state.input.set_kill_switch_armed(armed);
}

#[tauri::command]
fn get_injection_status(state: State<'_, AppState>) -> InjectionStatus {
    state.input.status()
}

#[tauri::command]
fn inject_mouse_move(state: State<'_, AppState>, norm_x: f64, norm_y: f64) -> Result<(), String> {
    state.input.move_mouse(norm_x, norm_y)
}

#[tauri::command]
fn inject_mouse_button(
    state: State<'_, AppState>,
    button: String,
    pressed: bool,
    norm_x: Option<f64>,
    norm_y: Option<f64>,
) -> Result<(), String> {
    state.input.mouse_button(&button, pressed, norm_x, norm_y)
}

#[tauri::command]
fn inject_mouse_wheel(state: State<'_, AppState>, delta_x: i32, delta_y: i32) -> Result<(), String> {
    state.input.scroll(delta_x, delta_y)
}

/// Returns `false` when the key code has no OS equivalent and was skipped.
#[tauri::command]
fn inject_key(state: State<'_, AppState>, code: String, pressed: bool) -> Result<bool, String> {
    state.input.key(&code, pressed)
}

/// Immediately revokes control. Safe to call from any state.
#[tauri::command]
fn panic_revoke(app: AppHandle, state: State<'_, AppState>, reason: String) -> InjectionStatus {
    state.input.set_control_enabled(false);
    state.input.trigger_kill_switch();
    let status = state.input.status();
    let _ = app.emit("panic-revoked", &reason);
    let _ = app.emit("injection-status", &status);
    status
}

/// Whether this installation can replace itself, and if not, why not.
///
/// The updater rewrites the installed application in place, which is only
/// possible for packages the app itself owns. A Windows NSIS install and a Linux
/// AppImage qualify. A `.deb` or `.rpm` does not: those files belong to dpkg or
/// rpm, live under `/usr`, and would need root to touch — so the honest answer
/// there is to point at the system package manager rather than to offer a button
/// that cannot work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCapability {
    pub supported: bool,
    /// How this copy was installed: nsis, appimage, macos, system-package, dev.
    pub install_kind: String,
    /// Present only when `supported` is false; explains what to do instead.
    pub reason: Option<String>,
    pub current_version: String,
}

#[tauri::command]
fn update_capability(app: AppHandle) -> UpdateCapability {
    let current_version = app.package_info().version.to_string();

    // A dev build is run from the target directory; there is nothing to replace.
    if tauri::is_dev() {
        return UpdateCapability {
            supported: false,
            install_kind: "dev".into(),
            reason: Some("This is a development build, so there is nothing to update.".into()),
            current_version,
        };
    }

    #[cfg(target_os = "linux")]
    {
        // The AppImage runtime exports this to the process it launches; its
        // presence is the reliable way to know we are running from one.
        if std::env::var_os("APPIMAGE").is_some() {
            return UpdateCapability {
                supported: true,
                install_kind: "appimage".into(),
                reason: None,
                current_version,
            };
        }
        UpdateCapability {
            supported: false,
            install_kind: "system-package".into(),
            reason: Some(
                "RemoteDesk was installed from a .deb or .rpm, which your package manager owns.                  Update it with `sudo apt install --only-upgrade remotedesk` or                  `sudo dnf upgrade remotedesk`, or switch to the AppImage, which updates itself."
                    .into(),
            ),
            current_version,
        }
    }

    #[cfg(target_os = "windows")]
    {
        UpdateCapability {
            supported: true,
            install_kind: "nsis".into(),
            reason: None,
            current_version,
        }
    }

    #[cfg(target_os = "macos")]
    {
        UpdateCapability {
            supported: true,
            install_kind: "macos".into(),
            reason: None,
            current_version,
        }
    }
}

#[tauri::command]
fn system_diagnostics() -> platform::Diagnostics {
    platform::diagnostics()
}

/// What the webview actually supports on this machine.
///
/// Screen capture is provided by the platform webview (WebView2 on Windows,
/// WebKitGTK on Linux), not by us, and its availability varies with runtime
/// version and — on Linux — with the desktop portal. The frontend probes for it
/// at startup and reports back here so the answer shows up in the host log
/// alongside the rest of the platform diagnostics, which is the first thing to
/// check when a host cannot start sharing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCapabilities {
    pub has_get_display_media: bool,
    pub has_web_rtc: bool,
    pub has_data_channels: bool,
    pub user_agent: String,
    pub origin: String,
    pub is_secure_context: bool,
}

/// Guards the one-shot browser handoff.
#[cfg(target_os = "linux")]
static WEB_CLIENT_OPENED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The running app, for the few places that need it outside a command's own
/// arguments. Set once during setup.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[tauri::command]
fn report_webview_capabilities(caps: WebviewCapabilities) {
    println!(
        "[remotedesk] webview: getDisplayMedia={} webrtc={} datachannels={}",
        caps.has_get_display_media, caps.has_web_rtc, caps.has_data_channels
    );
    println!(
        "[remotedesk] webview origin: {} (secure context: {})",
        caps.origin, caps.is_secure_context
    );
    if !caps.has_get_display_media {
        eprintln!(
            "[remotedesk] WARNING: this webview cannot capture the screen, so this machine              cannot act as a host. On Windows, update the WebView2 Runtime. On Linux, install              xdg-desktop-portal and a backend for your desktop (xdg-desktop-portal-gnome,              -kde, or -wlr) and make sure webkit2gtk 2.38 or newer is present."
        );
    }
    // Without RTCPeerConnection nothing works in either direction, so say so at
    // startup rather than letting it surface as a failed connection later.
    if !caps.has_web_rtc {
        eprintln!(
            "[remotedesk] this webview has no RTCPeerConnection, so the session cannot run in \
             this window. On Linux that is expected: the WebKitGTK that Ubuntu, Debian and \
             Fedora ship is built without WebRTC."
        );

        // Hand the session to a browser that does have WebRTC, once.
        #[cfg(target_os = "linux")]
        {
            use std::sync::atomic::Ordering;
            if !WEB_CLIENT_OPENED.swap(true, Ordering::SeqCst) {
                if let Some(app) = APP.get() {
                    open_web_client(app);
                }
            }
        }
    }

    println!("[remotedesk] webview user agent: {}", caps.user_agent);
}

/// Origin of the signaling server this app runs. The frontend connects here by
/// default so a freshly installed RemoteDesk can host without any other process.
#[tauri::command]
fn get_signal_url(state: State<'_, AppState>) -> Option<String> {
    let port = state.signaling.as_ref()?.port()?;
    Some(format!("http://127.0.0.1:{port}"))
}

/// Addresses a peer on the same network should dial to reach this host.
#[tauri::command]
fn get_network_info(state: State<'_, AppState>) -> Result<signaling::NetworkInfo, String> {
    state
        .signaling
        .as_ref()
        .map(|s| s.network_info())
        .ok_or_else(|| "the embedded signaling server is not running".to_string())
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Samples the real cursor position; if it moved somewhere we did not put it,
/// a human is at the host machine and remote injection is suspended.
fn spawn_kill_switch_watcher(app: AppHandle, state: Arc<InputState>) {
    thread::spawn(move || loop {
        thread::sleep(KILL_SWITCH_POLL_INTERVAL);

        if state.detect_physical_movement().is_some() {
            let suspended_until_ms = state.trigger_kill_switch();
            let _ = app.emit(
                "kill-switch",
                KillSwitchEvent {
                    suspended_until_ms,
                    cooldown_ms: input::KILL_SWITCH_COOLDOWN_MS,
                    reason: "Physical mouse movement detected at the host".into(),
                },
            );
            let _ = app.emit("injection-status", state.status());
        }
    });
}

/// Turns on the WebKitGTK settings that screen sharing and WebRTC depend on.
///
/// WebKitGTK ships `enable-media-stream` and `enable-webrtc` **off** by default,
/// and neither Tauri nor wry enables them. Left alone, `navigator.mediaDevices`
/// does not exist in the Linux webview, so a Linux machine cannot share a screen.
/// Windows (WebView2) needs none of this.
///
/// Note that these settings can only expose what the WebKitGTK build actually
/// contains. Some distributions — Ubuntu 22.04 among them — compile WebKitGTK
/// with `ENABLE_WEB_RTC=OFF`, and on those `RTCPeerConnection` is absent no
/// matter what is set here. `report_webview_capabilities` detects that case and
/// says so, rather than leaving the operator to discover it mid-session.
#[cfg(target_os = "linux")]
fn enable_linux_media_capture(app: &AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[remotedesk] main window missing; cannot enable webview media capture");
        return;
    };

    let result = window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};

        let Some(settings) = WebViewExt::settings(&webview.inner()) else {
            eprintln!("[remotedesk] could not read webkitgtk settings; screen sharing may fail");
            return;
        };

        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
        settings.set_enable_webrtc(true);

        // Read back rather than assume: a property that refuses to stick is a
        // different problem from a build that has no WebRTC to switch on.
        println!(
            "[remotedesk] webkitgtk: media-stream={} webrtc={}",
            settings.enables_media_stream(),
            settings.enables_webrtc()
        );
    });

    if let Err(err) = result {
        eprintln!("[remotedesk] could not configure the webview for capture: {err}");
    }
}

/// Wires the local browser UI to this machine's input engine and clipboard.
///
/// On Linux the host UI runs in a browser because the webview has no WebRTC,
/// and a browser page cannot call Tauri IPC. Without this, a Linux host could
/// stream its screen but never accept a click — so the same commands are
/// exposed over the loopback-only, token-gated control channel.
///
/// Every injection still goes through `InputState`, so the operator's grant and
/// the kill switch apply exactly as they do for the webview.
fn install_control_handler(app: &AppHandle) {
    let Some(signaling) = app.state::<AppState>().signaling.clone() else {
        return;
    };
    let app = app.clone();

    signaling.set_control_handler(Box::new(move |cmd: &str, args: Value| {
        let state = app.state::<AppState>();
        let input = &state.input;

        /// Reads a required field, naming the command in the error.
        fn field<'a>(args: &'a Value, key: &str) -> Result<&'a Value, String> {
            args.get(key).ok_or_else(|| format!("missing argument: {key}"))
        }
        fn num(args: &Value, key: &str) -> Result<f64, String> {
            field(args, key)?
                .as_f64()
                .ok_or_else(|| format!("{key} must be a number"))
        }
        fn text(args: &Value, key: &str) -> Result<String, String> {
            field(args, key)?
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{key} must be a string"))
        }
        fn flag(args: &Value, key: &str) -> Result<bool, String> {
            field(args, key)?
                .as_bool()
                .ok_or_else(|| format!("{key} must be a boolean"))
        }

        match cmd {
            "get_displays" => {
                let displays = get_displays(app.clone())?;
                serde_json::to_value(displays).map_err(|e| e.to_string())
            }
            "set_target_display" => {
                let display: DisplayInfo = serde_json::from_value(field(&args, "display")?.clone())
                    .map_err(|e| format!("invalid display: {e}"))?;
                input.set_target(TargetRect {
                    x: display.x,
                    y: display.y,
                    width: display.width as i32,
                    height: display.height as i32,
                })?;
                Ok(Value::Null)
            }
            "set_control_enabled" => {
                let enabled = flag(&args, "enabled")?;
                input.set_control_enabled(enabled);
                if enabled {
                    input.clear_kill_switch();
                }
                let status = input.status();
                let _ = app.emit("injection-status", &status);
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            "get_injection_status" => {
                serde_json::to_value(input.status()).map_err(|e| e.to_string())
            }
            "inject_mouse_move" => {
                input.move_mouse(num(&args, "normX")?, num(&args, "normY")?)?;
                Ok(Value::Null)
            }
            "inject_mouse_button" => {
                let button = text(&args, "button")?;
                let pressed = flag(&args, "pressed")?;
                // Position is optional: a press may follow an earlier move.
                let nx = args.get("normX").and_then(Value::as_f64);
                let ny = args.get("normY").and_then(Value::as_f64);
                input.mouse_button(&button, pressed, nx, ny)?;
                Ok(Value::Null)
            }
            "inject_mouse_wheel" => {
                let dx = num(&args, "deltaX")? as i32;
                let dy = num(&args, "deltaY")? as i32;
                input.scroll(dx, dy)?;
                Ok(Value::Null)
            }
            "inject_key" => {
                let mapped = input.key(&text(&args, "code")?, flag(&args, "pressed")?)?;
                Ok(Value::Bool(mapped))
            }
            "panic_revoke" => {
                let reason = args
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("User panic");
                input.set_control_enabled(false);
                input.trigger_kill_switch();
                let status = input.status();
                let _ = app.emit("panic-revoked", reason);
                let _ = app.emit("injection-status", &status);
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            "clipboard_read" => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                match app.clipboard().read_text() {
                    Ok(contents) => Ok(Value::String(contents)),
                    // An empty or non-text clipboard is normal, not an error.
                    Err(_) => Ok(Value::Null),
                }
            }
            "clipboard_write" => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                app.clipboard()
                    .write_text(text(&args, "text")?)
                    .map_err(|e| format!("clipboard write failed: {e}"))?;
                Ok(Value::Bool(true))
            }
            other => Err(format!("unknown control command: {other}")),
        }
    }));

    println!("[remotedesk] host control channel ready (loopback only, token required)");
}

/// Lets the embedded server serve the same frontend the webview runs.
///
/// The assets are the ones Tauri already bundled, so a browser pointed at this
/// machine gets byte-identical files — no second copy, nothing to drift.
fn install_web_client(app: &AppHandle) {
    let Some(signaling) = app.state::<AppState>().signaling.clone() else {
        return;
    };

    let resolver = app.asset_resolver();
    signaling.set_asset_provider(Box::new(move |path: &str| {
        let asset = resolver.get(format!("/{path}"))?;
        Some((asset.bytes, asset.mime_type))
    }));

    if let Some(url) = signaling.local_url_public() {
        println!("[remotedesk] web client available at {url}");
    }

    // The operator needs the keyed link whenever the session has to run in a
    // browser — including when the automatic handoff fails on a headless box or
    // with no default browser set. It goes to this app's own stdout and nowhere
    // else: anyone who can read this terminal can already act as you here.
    if let Some(url) = signaling.local_url() {
        println!("[remotedesk] ----------------------------------------------------------");
        println!("[remotedesk] Session UI — open this if no browser appears:");
        println!("[remotedesk]   {url}");
        println!("[remotedesk] That link carries the key that lets the page control this");
        println!("[remotedesk] machine. Treat it like a password; do not share or paste it.");
        println!("[remotedesk] ----------------------------------------------------------");
    }
}

/// Opens the session UI in the operator's own browser.
///
/// Only used where the webview cannot run a session itself. The browser is a
/// full peer: it loads the same app from this process and talks to the same
/// signaling server, so nothing about the session is second-class.
#[cfg(target_os = "linux")]
fn open_web_client(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;

    let Some(signaling) = app.state::<AppState>().signaling.clone() else {
        eprintln!("[remotedesk] no signaling server; cannot open the web client");
        return;
    };
    let Some(url) = signaling.local_url() else {
        return;
    };

    match app.opener().open_url(url.clone(), None::<&str>) {
        Ok(()) => println!("[remotedesk] opened the session UI in your browser"),
        Err(err) => {
            // The tokenless address is useless for hosting: without the token
            // the page cannot reach the control channel, so the session would
            // silently be view-only. Printing the real link to our own stdout
            // is the same trade Jupyter makes — the operator launched this
            // process and can see its terminal, and the token is worthless to
            // anyone off this machine because the channel refuses non-loopback
            // callers regardless.
            eprintln!("[remotedesk] could not open a browser ({err}).");
            eprintln!("[remotedesk] open this link yourself to run the session:");
            eprintln!("[remotedesk]   {url}");
            eprintln!(
                "[remotedesk] it carries a one-time key for this run; without it the page can                  show a remote screen but cannot let anyone control this machine."
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let input_state = Arc::new(InputState::new());

    // Started before the window so the frontend's first connection attempt
    // already has somewhere to land.
    let signaling = match signaling::start() {
        Ok(handle) => Some(handle),
        Err(err) => {
            eprintln!("[remotedesk] embedded signaling server unavailable: {err}");
            None
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { input: Arc::clone(&input_state), signaling })
        .setup({
            let input_state = Arc::clone(&input_state);
            move |app| {
                platform::log_startup_diagnostics();

                let _ = APP.set(app.handle().clone());

                install_web_client(app.handle());
                install_control_handler(app.handle());

                #[cfg(target_os = "linux")]
                enable_linux_media_capture(app.handle());

                spawn_kill_switch_watcher(app.handle().clone(), Arc::clone(&input_state));

                register_panic_shortcut(app.handle(), Arc::clone(&input_state));

                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_displays,
            set_target_display,
            set_control_enabled,
            set_kill_switch_armed,
            get_injection_status,
            inject_mouse_move,
            inject_mouse_button,
            inject_mouse_wheel,
            inject_key,
            panic_revoke,
            system_diagnostics,
            update_capability,
            get_signal_url,
            get_network_info,
            report_webview_capabilities,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RemoteDesk");
}

fn register_panic_shortcut(app: &AppHandle, state: Arc<InputState>) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let handle = app.clone();
    let result = app.global_shortcut().on_shortcut(PANIC_ACCELERATOR, move |_app, _shortcut, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        state.set_control_enabled(false);
        state.trigger_kill_switch();
        let _ = handle.emit("panic-revoked", "Global panic shortcut pressed");
        let _ = handle.emit("injection-status", state.status());
    });

    if let Err(err) = result {
        // A shortcut conflict is not fatal; the in-app panic button still works.
        eprintln!("[remotedesk] could not register panic shortcut {PANIC_ACCELERATOR}: {err}");
    }
}

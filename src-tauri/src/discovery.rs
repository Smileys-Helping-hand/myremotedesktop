//! Finds RemoteDesk hosts on the networks this machine is attached to.
//!
//! The frontend can sweep a subnet with `fetch` on its own, and for a plain
//! browser with no app behind it that is the only option. It is a poor one: a
//! browser keeps a single, small socket pool, and an address with nothing at it
//! holds a connect attempt open until the OS gives up. Aborting the `fetch`
//! does not hand the socket back. Sweeping a /24 with a few hundred dead
//! addresses therefore starves the live ones — measured on this project's own
//! network, every real host timed out while 500 dead addresses were in flight,
//! so the scan reported nothing while a host sat there answering curl.
//!
//! Scanning from here has no such limit: connects are made and dropped on a
//! fixed deadline, and nothing queues behind anything else.

use std::collections::BTreeSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::timeout;

/// Long enough for any machine on the same LAN, short enough that a dead
/// address costs little.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
/// A responder that has accepted the connection but says nothing is some other
/// service, not a host; this is how long we wait to find that out.
const READ_TIMEOUT: Duration = Duration::from_millis(1500);
const CONCURRENCY: usize = 128;
/// Networks swept at once. A machine with a stack of virtual adapters would
/// otherwise turn one click into thousands of connects.
const MAX_NETWORKS: usize = 4;
/// Nothing this endpoint reads is anywhere near this large.
const MAX_BODY: usize = 256 * 1024;

/// A RemoteDesk server found on the network.
///
/// The two room fields are forwarded exactly as the remote reported them rather
/// than interpreted here: the frontend already knows how to read both the
/// current `/hosts` shape and the older `activeRooms` list, and duplicating
/// that rule in a second language is how the two drift apart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundHost {
    pub origin: String,
    /// What the machine calls itself, when it said. Older builds do not.
    pub name: Option<String>,
    pub rooms: usize,
    pub connections: usize,
    /// Body of the remote's `/hosts`, when it has that endpoint.
    pub hosts: Option<Vec<Value>>,
    /// Desk IDs from the remote's `/network-info`, on older builds.
    pub active_rooms: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub hosts: Vec<FoundHost>,
    /// Addresses probed, so "found nothing" can say what it looked at.
    pub scanned: usize,
    /// Networks swept, as `192.168.1.x`.
    pub networks: Vec<String>,
}

/// Addresses worth probing: every /24 this machine is on, minus itself.
///
/// Probing our own address would find our own server, which is not a discovery
/// — reporting it as one is worse than finding nothing, because it looks like
/// success and connects to a machine that is not sharing anything.
fn candidates(ports: &[u16], own: &[Ipv4Addr]) -> (Vec<SocketAddr>, Vec<String>) {
    let mine: BTreeSet<Ipv4Addr> = own.iter().copied().collect();
    let mut prefixes: Vec<[u8; 3]> = Vec::new();
    for ip in own {
        let o = ip.octets();
        let prefix = [o[0], o[1], o[2]];
        if !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    prefixes.truncate(MAX_NETWORKS);

    let mut addresses = Vec::new();
    let mut networks = Vec::new();
    for prefix in &prefixes {
        networks.push(format!("{}.{}.{}.x", prefix[0], prefix[1], prefix[2]));
        for last in 1..=254u8 {
            let ip = Ipv4Addr::new(prefix[0], prefix[1], prefix[2], last);
            if mine.contains(&ip) {
                continue;
            }
            for port in ports {
                addresses.push(SocketAddr::from((ip, *port)));
            }
        }
    }
    (addresses, networks)
}

/// Ports to look on, given the one this machine ended up with.
///
/// Probing only our own port was a real and invisible failure: RemoteDesk walks
/// up from 4000 when a port is taken, so a machine that had to settle for 4001
/// — because something unrelated held 4000 — searched the whole network for
/// other machines on 4001 and found none, while they sat on 4000 answering
/// anyone who asked. The default is always searched, and so is ours; the extra
/// port costs one more connect per address and buys the case where both
/// machines had to move.
fn ports_to_probe(own_port: u16) -> Vec<u16> {
    let mut ports = vec![DEFAULT_PROBE_PORT, DEFAULT_PROBE_PORT + 1];
    if !ports.contains(&own_port) {
        ports.push(own_port);
    }
    ports
}

/// Where RemoteDesk starts looking for a free port, and so where a host most
/// likely is. Mirrors `DEFAULT_PORT` in `signaling.rs`.
const DEFAULT_PROBE_PORT: u16 = 4000;

/// Reads a JSON body out of a raw HTTP/1.x response.
///
/// Written by hand because the alternative is pulling an HTTP client into the
/// app for two fixed GETs. Chunked responses are decoded: `Content-Length` is
/// what both of this project's servers send today, but a response without it is
/// perfectly legal and would otherwise be read as garbage.
pub fn parse_http_json(raw: &[u8]) -> Option<Value> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let body = &raw[split + 4..];

    let status_ok = head
        .lines()
        .next()
        .map(|line| line.contains(" 200"))
        .unwrap_or(false);
    if !status_ok {
        return None;
    }

    if head.contains("transfer-encoding: chunked") {
        return serde_json::from_slice(&dechunk(body)?).ok();
    }
    serde_json::from_slice(body).ok()
}

/// Joins the chunks of a chunked body, ignoring any trailer.
fn dechunk(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let header = std::str::from_utf8(&rest[..line_end]).ok()?;
        // A chunk size may carry extensions after a semicolon.
        let size_text = header.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if rest.len() < size {
            return None;
        }
        out.extend_from_slice(&rest[..size]);
        // Each chunk is followed by its own CRLF.
        rest = rest.get(size + 2..)?;
    }
}

/// One GET against one address, on a deadline at every step.
async fn get_json(addr: SocketAddr, path: &str) -> Option<Value> {
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    timeout(READ_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .ok()?
        .ok()?;

    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = timeout(READ_TIMEOUT, stream.read(&mut chunk)).await.ok()?.ok()?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        if raw.len() > MAX_BODY {
            break;
        }
    }
    parse_http_json(&raw)
}

/// Probes one address and reports a host if RemoteDesk answered there.
async fn probe(addr: SocketAddr) -> Option<FoundHost> {
    let info = get_json(addr, "/network-info").await?;
    let rooms = info.get("rooms")?.as_u64()? as usize;
    let connections = info
        .get("connections")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;

    let name = info
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|n| !n.is_empty());

    let active_rooms = info.get("activeRooms").and_then(Value::as_array).map(|ids| {
        ids.iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect()
    });

    // Absent on builds older than this endpoint, and on a server that serves
    // the frontend for unknown paths it comes back as HTML — either way the
    // host is still found, only its Desk ID has to be typed by hand.
    let hosts = get_json(addr, "/hosts")
        .await
        .and_then(|listing| listing.get("hosts").and_then(Value::as_array).cloned());

    Some(FoundHost {
        origin: format!("http://{addr}"),
        name,
        rooms,
        connections,
        hosts,
        active_rooms,
    })
}

/// Sweeps every local network for RemoteDesk servers.
///
/// Hosts that are actually sharing sort first: that is what the operator is
/// looking for, and a machine merely running the app is noise beside it.
pub async fn scan(port: u16, own: Vec<Ipv4Addr>) -> DiscoveryReport {
    let (addresses, networks) = candidates(&ports_to_probe(port), &own);
    let scanned = addresses.len();

    let permits = Arc::new(Semaphore::new(CONCURRENCY));
    let mut tasks = JoinSet::new();
    for addr in addresses {
        let permits = permits.clone();
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await.ok()?;
            probe(addr).await
        });
    }

    let mut hosts: Vec<FoundHost> = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        if let Ok(Some(host)) = joined {
            hosts.push(host);
        }
    }

    hosts.sort_by(|a, b| b.rooms.cmp(&a.rooms).then_with(|| a.origin.cmp(&b.origin)));
    DiscoveryReport {
        hosts,
        scanned,
        networks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_cover_the_whole_subnet_of_every_address_held() {
        let (addresses, networks) = candidates(
            &[4000],
            &[Ipv4Addr::new(192, 168, 1, 23), Ipv4Addr::new(10, 0, 0, 7)],
        );
        assert_eq!(networks, vec!["192.168.1.x", "10.0.0.x"]);
        // Two /24s, each missing the one address that is ours.
        assert_eq!(addresses.len(), 253 * 2);
        assert!(addresses.contains(&SocketAddr::from(([192, 168, 1, 254], 4000))));
        assert!(addresses.contains(&SocketAddr::from(([10, 0, 0, 1], 4000))));
    }

    #[test]
    fn candidates_never_include_this_machine() {
        // Our own server always answers, so probing ourselves would report a
        // discovery on every scan while the real host stayed unfound.
        let (addresses, _) = candidates(&[4000], &[Ipv4Addr::new(192, 168, 1, 23)]);
        assert!(!addresses.contains(&SocketAddr::from(([192, 168, 1, 23], 4000))));
    }

    #[test]
    fn candidates_collapse_two_addresses_on_one_network() {
        let (addresses, networks) = candidates(
            &[4000],
            &[Ipv4Addr::new(192, 168, 1, 23), Ipv4Addr::new(192, 168, 1, 90)],
        );
        assert_eq!(networks, vec!["192.168.1.x"]);
        assert_eq!(addresses.len(), 252);
    }

    #[test]
    fn a_machine_pushed_off_the_default_port_still_looks_on_it() {
        // The failure this prevents: this machine settled for 4001 because
        // something else held 4000, then searched the network for peers on
        // 4001 only — and every peer was on 4000, answering nobody.
        assert_eq!(ports_to_probe(4001), vec![4000, 4001]);
        assert_eq!(ports_to_probe(4000), vec![4000, 4001]);
        assert_eq!(ports_to_probe(4007), vec![4000, 4001, 4007]);

        let (addresses, _) = candidates(&ports_to_probe(4007), &[Ipv4Addr::new(192, 168, 1, 23)]);
        assert!(addresses.contains(&SocketAddr::from(([192, 168, 1, 206], 4000))));
        assert!(addresses.contains(&SocketAddr::from(([192, 168, 1, 206], 4007))));
    }

    #[test]
    fn candidates_are_empty_without_a_local_address() {
        let (addresses, networks) = candidates(&[4000], &[]);
        assert!(addresses.is_empty());
        assert!(networks.is_empty());
    }

    #[test]
    fn reads_a_json_body_with_a_content_length() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"rooms\":1}\r\n";
        let value = parse_http_json(raw).unwrap();
        assert_eq!(value["rooms"], 1);
    }

    #[test]
    fn reads_a_chunked_json_body() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"room\r\n5\r\ns\":1}\r\n0\r\n\r\n";
        let value = parse_http_json(raw).unwrap();
        assert_eq!(value["rooms"], 1);
    }

    #[test]
    fn ignores_a_response_that_is_not_json_or_not_ok() {
        // The frontend served for an unknown path, which is what an older
        // server answers /hosts with.
        let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html><html></html>";
        assert!(parse_http_json(html).is_none());

        let not_found = b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}";
        assert!(parse_http_json(not_found).is_none());

        assert!(parse_http_json(b"nonsense").is_none());
    }
}

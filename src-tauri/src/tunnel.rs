//! Optional public reachability via a Cloudflare Quick Tunnel.
//!
//! LAN sessions need nothing beyond the embedded signaling server, but two
//! peers on different networks cannot dial each other's private addresses. A
//! quick tunnel publishes this host's signaling port on a temporary
//! `*.trycloudflare.com` URL the remote peer can reach.
//!
//! This is deliberately opt-in and best-effort: `cloudflared` is not bundled,
//! so if it is not installed the caller is told exactly that rather than being
//! left with a silent failure.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// How long to wait for `cloudflared` to print its assigned hostname.
const URL_TIMEOUT: Duration = Duration::from_secs(45);

pub enum TunnelStart {
    Started(String),
    /// `cloudflared` is not on PATH; the message explains how to get it.
    Unavailable(String),
    Failed(String),
}

/// Extracts the assigned hostname from a line of `cloudflared` output.
///
/// The banner format has changed between releases, so this scans for the
/// hostname itself rather than matching the surrounding decoration.
pub fn parse_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    if url.ends_with(".trycloudflare.com") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Path to an empty config file used to isolate our tunnel from the user's own.
///
/// `cloudflared` reads `~/.cloudflared/config.yml` whenever `--config` is not
/// given. If the operator already runs a named tunnel for something else — a
/// very common case for anyone who has used Cloudflare before — that file's
/// `ingress:` rules take over and `--url` is silently ignored. The quick tunnel
/// still starts and still prints a URL, but every request to it is answered by
/// the other tunnel's catch-all rule, which is usually `http_status:404`. The
/// operator sees a working-looking public URL that serves nothing.
///
/// Pointing `--config` at an empty file removes those rules from consideration
/// and makes `--url` authoritative again, without touching the user's own
/// configuration.
fn isolated_config_path() -> std::io::Result<PathBuf> {
    let path = std::env::temp_dir().join("remotedesk-cloudflared-empty.yml");
    if !path.exists() {
        std::fs::write(&path, b"# Intentionally empty.
# Keeps RemoteDesk's quick tunnel from inheriting ~/.cloudflared/config.yml.
")?;
    }
    Ok(path)
}

/// Spawns a quick tunnel pointing at `port` and resolves once the public URL
/// has been announced. The child is returned so the caller can keep it alive —
/// dropping it kills the tunnel.
pub async fn start(port: u16) -> (TunnelStart, Option<Child>) {
    let config = match isolated_config_path() {
        Ok(path) => path,
        Err(err) => {
            return (
                TunnelStart::Failed(format!(
                    "could not create the temporary cloudflared config: {err}"
                )),
                None,
            )
        }
    };

    let mut child = match Command::new("cloudflared")
        .args([
            "tunnel",
            "--no-autoupdate",
            "--config",
            &config.to_string_lossy(),
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (
                TunnelStart::Unavailable(
                    "cloudflared is not installed. Install it from \
                     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ \
                     to expose this host over the internet, or connect over your local network instead."
                        .into(),
                ),
                None,
            );
        }
        Err(err) => return (TunnelStart::Failed(format!("could not start cloudflared: {err}")), None),
    };

    // cloudflared announces the hostname on stderr, but has used stdout in some
    // releases, so both are watched.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let found = tokio::time::timeout(URL_TIMEOUT, async move {
        let mut out_lines = stdout.map(|s| BufReader::new(s).lines());
        let mut err_lines = stderr.map(|s| BufReader::new(s).lines());

        loop {
            let line = tokio::select! {
                Some(Ok(Some(line))) = async {
                    match out_lines.as_mut() {
                        Some(lines) => Some(lines.next_line().await),
                        None => None,
                    }
                } => line,
                Some(Ok(Some(line))) = async {
                    match err_lines.as_mut() {
                        Some(lines) => Some(lines.next_line().await),
                        None => None,
                    }
                } => line,
                else => return None,
            };

            if let Some(url) = parse_tunnel_url(&line) {
                return Some(url);
            }
        }
    })
    .await;

    match found {
        Ok(Some(url)) => (TunnelStart::Started(url), Some(child)),
        Ok(None) => (
            TunnelStart::Failed("cloudflared exited before announcing a URL".into()),
            None,
        ),
        Err(_) => (
            TunnelStart::Failed("cloudflared did not announce a URL within 45s".into()),
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_hostname_in_the_banner_line() {
        let line = "2024-01-01T00:00:00Z INF |  https://calm-forest-1234.trycloudflare.com  |";
        assert_eq!(
            parse_tunnel_url(line).as_deref(),
            Some("https://calm-forest-1234.trycloudflare.com")
        );
    }

    #[test]
    fn tolerates_trailing_punctuation() {
        let line = "Visit https://calm-forest-1234.trycloudflare.com.";
        assert_eq!(
            parse_tunnel_url(line).as_deref(),
            Some("https://calm-forest-1234.trycloudflare.com")
        );
    }

    // Regression: without an explicit --config, cloudflared inherits
    // ~/.cloudflared/config.yml. An operator with an existing named tunnel then
    // gets a quick-tunnel URL that answers 404 to everything, because the other
    // tunnel's catch-all ingress rule handles the request instead.
    #[test]
    fn writes_an_empty_config_to_shadow_the_users_own() {
        let path = isolated_config_path().expect("temp dir must be writable");
        assert!(path.exists());

        let contents = std::fs::read_to_string(&path).expect("config must be readable");
        assert!(
            !contents.contains("ingress"),
            "the isolating config must declare no ingress rules, got: {contents}"
        );

        // Calling it again must be idempotent rather than failing on an
        // existing file, since a session can start more than one tunnel.
        let again = isolated_config_path().expect("second call must succeed");
        assert_eq!(path, again);
    }

    #[test]
    fn ignores_unrelated_urls() {
        assert!(parse_tunnel_url("see https://developers.cloudflare.com/docs").is_none());
        assert!(parse_tunnel_url("INF Starting tunnel").is_none());
    }
}

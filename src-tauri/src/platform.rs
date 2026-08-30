//! Platform capability reporting.
//!
//! Screen capture and input injection have materially different constraints per
//! OS and, on Linux, per display server. This module reports what is actually
//! detectable at runtime; it does not assert capabilities it cannot verify.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub platform: String,
    pub display_server: String,
    pub is_wayland: bool,
    /// Whether an xdg-desktop-portal implementation was found (Linux). Screen
    /// capture, and input injection under GNOME/KDE Wayland, both go through it.
    pub portal_available: Option<bool>,
    pub desktop_session: Option<String>,
    /// Human-readable notes for the host operator, ordered most important first.
    pub notes: Vec<String>,
}

pub fn diagnostics() -> Diagnostics {
    #[cfg(target_os = "linux")]
    {
        linux_diagnostics()
    }
    #[cfg(target_os = "windows")]
    {
        windows_diagnostics()
    }
    #[cfg(target_os = "macos")]
    {
        macos_diagnostics()
    }
}

#[cfg(target_os = "linux")]
fn linux_diagnostics() -> Diagnostics {
    use std::path::Path;

    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let is_wayland = session_type == "wayland" || wayland_display.is_some();

    // The portal ships as a D-Bus activatable service, so the service file is a
    // more reliable signal than a running process.
    let portal_available = [
        "/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service",
        "/usr/local/share/dbus-1/services/org.freedesktop.portal.Desktop.service",
        "/usr/libexec/xdg-desktop-portal",
        "/usr/lib/xdg-desktop-portal",
    ]
    .iter()
    .any(|p| Path::new(p).exists());

    let mut notes = Vec::new();

    if is_wayland {
        // Under Wayland there is no XTest. Injection goes through either the
        // RemoteDesktop portal (GNOME, KDE) or the wlroots virtual-input
        // protocols (Sway, Hyprland) — both compiled in, chosen at runtime.
        notes.push(
            "Wayland session detected. Screen capture goes through xdg-desktop-portal and              PipeWire, and you will be asked to pick a display when sharing starts."
                .to_string(),
        );
        if portal_available {
            notes.push(
                "Input injection uses the wlroots virtual-input protocols, which Sway and                  Hyprland provide. GNOME and KDE do not, so on those run the session under                  Xorg (or XWayland) if you need the remote peer to control this machine."
                    .to_string(),
            );
        } else {
            notes.push(
                "No xdg-desktop-portal implementation was found, so neither screen capture                  nor input injection will work. Install xdg-desktop-portal plus the backend                  for your desktop (xdg-desktop-portal-gnome, -kde, or -wlr)."
                    .to_string(),
            );
        }
    } else {
        notes.push(
            "X11 session detected. XTest input injection is available and needs no extra              permission."
                .to_string(),
        );
        if !portal_available {
            notes.push(
                "xdg-desktop-portal was not found. Screen capture in the webview may fall                  back to an X11 path, or fail; installing it is recommended."
                    .to_string(),
            );
        }
    }

    Diagnostics {
        platform: "linux".into(),
        display_server: if is_wayland { "wayland".into() } else { "x11".into() },
        is_wayland,
        portal_available: Some(portal_available),
        desktop_session: std::env::var("XDG_CURRENT_DESKTOP")
            .or_else(|_| std::env::var("DESKTOP_SESSION"))
            .ok(),
        notes,
    }
}

#[cfg(target_os = "windows")]
fn windows_diagnostics() -> Diagnostics {
    Diagnostics {
        platform: "windows".into(),
        display_server: "dwm".into(),
        is_wayland: false,
        portal_available: None,
        desktop_session: None,
        notes: vec![
            "Input injection uses SendInput and requires no extra permission at the same \
             integrity level."
                .to_string(),
            "While a UAC prompt is on the Secure Desktop, Windows blocks both capture and \
             injection. The stream freezes until the prompt is dismissed at the host."
                .to_string(),
        ],
    }
}

#[cfg(target_os = "macos")]
fn macos_diagnostics() -> Diagnostics {
    Diagnostics {
        platform: "macos".into(),
        display_server: "quartz".into(),
        is_wayland: false,
        portal_available: None,
        desktop_session: None,
        notes: vec![
            "Screen Recording permission is required before the capture picker will list \
             displays (System Settings > Privacy & Security > Screen Recording)."
                .to_string(),
            "Accessibility permission is required for input injection (System Settings > \
             Privacy & Security > Accessibility)."
                .to_string(),
        ],
    }
}

pub fn log_startup_diagnostics() {
    let d = diagnostics();
    println!("[remotedesk] platform: {} ({})", d.platform, d.display_server);
    if let Some(available) = d.portal_available {
        println!("[remotedesk] xdg-desktop-portal present: {available}");
    }
    for note in &d.notes {
        println!("[remotedesk] note: {note}");
    }
}

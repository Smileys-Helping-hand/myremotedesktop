//! Native OS input injection.
//!
//! This module is the security boundary for remote control. The webview can ask
//! for an injection, but every request is gated here by two pieces of state the
//! renderer cannot reach:
//!
//! * `control_enabled` — the host operator explicitly granted remote control.
//! * `suspended_until_ms` — the kill switch: physical input at the host machine
//!   suspends remote injection for a cooldown period.
//!
//! A compromised or buggy renderer therefore cannot inject input the host has
//! not authorized.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};

use crate::keymap::code_to_key;

/// How long remote injection stays suspended after physical host input.
pub const KILL_SWITCH_COOLDOWN_MS: u64 = 2_500;

/// Cursor displacement (in pixels) that counts as deliberate physical movement
/// rather than rounding drift from our own injection.
const PHYSICAL_MOVEMENT_THRESHOLD_PX: i32 = 12;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The screen region remote coordinates are projected onto.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TargetRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Default for TargetRect {
    fn default() -> Self {
        Self { x: 0, y: 0, width: 1920, height: 1080 }
    }
}

/// Mirrored by `InjectionStatus` in `src/utils/tauriBridge.ts`; the rename keeps
/// the two spellings of these field names in sync.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionStatus {
    pub control_enabled: bool,
    pub kill_switch_active: bool,
    pub suspended_remaining_ms: u64,
    pub target: TargetRect,
}

pub struct InputState {
    enigo: Mutex<Option<Enigo>>,
    target: Mutex<TargetRect>,
    control_enabled: AtomicBool,
    suspended_until_ms: AtomicU64,
    /// Where we last placed the cursor, used to distinguish our own motion from
    /// the host operator's.
    last_injected_x: AtomicI32,
    last_injected_y: AtomicI32,
    kill_switch_armed: AtomicBool,
}

impl Default for InputState {
    fn default() -> Self {
        Self::new()
    }
}

/// Moves the cursor a few pixels and checks it landed, then puts it back.
///
/// Reports what the operator actually has, because "the backend connected" and
/// "the backend works" are different things on Linux.
#[cfg(target_os = "linux")]
fn report_backend(name: &str, engine: &mut Enigo) {
    let Ok((x, y)) = engine.location() else {
        println!("[remotedesk] input backend: {name} (cursor position unreadable)");
        return;
    };

    // Somewhere certain to be on-screen and a real change. The first XTest
    // motion after a fresh connection is sometimes dropped, so this retries
    // rather than condemning a backend that does work.
    let (probe_x, probe_y) = (x + 17, y + 13);
    let mut landed = false;
    for _ in 0..3 {
        if engine.move_mouse(probe_x, probe_y, Coordinate::Abs).is_err() {
            continue;
        }
        if let Ok((nx, ny)) = engine.location() {
            if (nx - probe_x).abs() <= 2 && (ny - probe_y).abs() <= 2 {
                landed = true;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let _ = engine.move_mouse(x, y, Coordinate::Abs);

    match landed {
        true => println!("[remotedesk] input backend: {name} — verified, cursor responds"),
        false => println!(
            "[remotedesk] input backend: {name} — WARNING: the cursor did not move. Remote \
             control will not work on this session. On Wayland this means the compositor does \
             not implement the virtual-input protocols; run the session under Xorg/XWayland."
        ),
    }
}

/// Builds the OS input engine, choosing the Linux backend deliberately.
///
/// enigo probes every backend it was compiled with and keeps whichever
/// connected, and libwayland connects to `wayland-0` regardless of whether
/// `WAYLAND_DISPLAY` is set. On a compositor that does not implement the wlroots
/// virtual-input protocols — GNOME, KDE, WSLg — that backend accepts every call
/// and moves nothing: injection reports success while the cursor stays put, and
/// the kill switch then trips because the cursor is not where we placed it.
///
/// X11/XTest works on X sessions and, through XWayland, on most Wayland desktops
/// too, so it is asked for first. Wayland is used only when there is no X11
/// connection to be had, which is the case on a bare wlroots session.
#[cfg(target_os = "linux")]
fn new_input_engine() -> Result<Enigo, String> {
    let prefer_x11 = Settings {
        // A name no compositor listens on, so the Wayland backend cannot connect
        // and enigo is left with X11.
        wayland_display: Some("remotedesk-prefer-x11".to_string()),
        ..Default::default()
    };

    match Enigo::new(&prefer_x11) {
        Ok(mut engine) => {
            report_backend("X11/XTest", &mut engine);
            Ok(engine)
        }
        Err(x11_err) => {
            // No X11 at all — a bare Wayland session. Let enigo connect normally.
            match Enigo::new(&Settings::default()) {
                Ok(mut engine) => {
                    println!("[remotedesk] no X11 input connection ({x11_err})");
                    report_backend("Wayland (wlroots virtual input)", &mut engine);
                    Ok(engine)
                }
                Err(wayland_err) => Err(format!(
                    "no usable input backend: X11 ({x11_err}), Wayland ({wayland_err})"
                )),
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn new_input_engine() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| e.to_string())
}

impl InputState {
    pub fn new() -> Self {
        Self {
            enigo: Mutex::new(None),
            target: Mutex::new(TargetRect::default()),
            control_enabled: AtomicBool::new(false),
            suspended_until_ms: AtomicU64::new(0),
            last_injected_x: AtomicI32::new(i32::MIN),
            last_injected_y: AtomicI32::new(i32::MIN),
            kill_switch_armed: AtomicBool::new(true),
        }
    }

    /// Lazily constructs the Enigo handle. Creating it eagerly at startup fails
    /// on Linux before a display server connection exists.
    ///
    /// Both construction and injection are wrapped in `catch_unwind`: these call
    /// into platform backends that talk to whatever display server the host has,
    /// and some of them panic on a missing portal or protocol rather than
    /// returning an error. A remote peer's input must never be able to take the
    /// host process down, so a panic is turned into a failed command.
    fn with_enigo<T>(&self, f: impl FnOnce(&mut Enigo) -> Result<T, String>) -> Result<T, String> {
        use std::panic::{catch_unwind, AssertUnwindSafe};

        let mut guard = self.enigo.lock().map_err(|_| "input engine lock poisoned".to_string())?;
        if guard.is_none() {
            let engine = catch_unwind(AssertUnwindSafe(new_input_engine))
                .map_err(|_| {
                    "the OS input engine panicked while starting. On Linux this usually means \
                     no usable input backend: X11/XTest is unavailable and the compositor does \
                     not offer the wlroots virtual-input protocols."
                        .to_string()
                })?
                .map_err(|e| format!("failed to initialize OS input engine: {e}"))?;
            *guard = Some(engine);
        }
        let engine = guard.as_mut().expect("engine initialized above");
        catch_unwind(AssertUnwindSafe(|| f(engine)))
            .map_err(|_| "the OS input engine panicked while injecting".to_string())?
    }

    pub fn set_control_enabled(&self, enabled: bool) {
        self.control_enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.last_injected_x.store(i32::MIN, Ordering::SeqCst);
            self.last_injected_y.store(i32::MIN, Ordering::SeqCst);
        }
    }

    pub fn set_kill_switch_armed(&self, armed: bool) {
        self.kill_switch_armed.store(armed, Ordering::SeqCst);
    }

    pub fn set_target(&self, rect: TargetRect) -> Result<(), String> {
        if rect.width <= 0 || rect.height <= 0 {
            return Err("target rect must have positive dimensions".into());
        }
        *self.target.lock().map_err(|_| "target lock poisoned".to_string())? = rect;
        Ok(())
    }

    pub fn target(&self) -> TargetRect {
        self.target.lock().map(|t| *t).unwrap_or_default()
    }

    /// Suspends injection for the cooldown window. Returns the new deadline.
    pub fn trigger_kill_switch(&self) -> u64 {
        let until = now_ms() + KILL_SWITCH_COOLDOWN_MS;
        self.suspended_until_ms.store(until, Ordering::SeqCst);
        until
    }

    pub fn clear_kill_switch(&self) {
        self.suspended_until_ms.store(0, Ordering::SeqCst);
    }

    pub fn suspended_remaining_ms(&self) -> u64 {
        self.suspended_until_ms.load(Ordering::SeqCst).saturating_sub(now_ms())
    }

    /// Single gate every injection passes through.
    fn authorize(&self) -> Result<(), String> {
        if !self.control_enabled.load(Ordering::SeqCst) {
            return Err("remote control is not authorized by the host".into());
        }
        let remaining = self.suspended_remaining_ms();
        if remaining > 0 {
            return Err(format!("kill switch active — injection suspended for {remaining}ms"));
        }
        Ok(())
    }

    pub fn status(&self) -> InjectionStatus {
        let remaining = self.suspended_remaining_ms();
        InjectionStatus {
            control_enabled: self.control_enabled.load(Ordering::SeqCst),
            kill_switch_active: remaining > 0,
            suspended_remaining_ms: remaining,
            target: self.target(),
        }
    }

    /// Projects normalized [0,1] stream coordinates onto absolute desktop pixels.
    fn resolve(&self, norm_x: f64, norm_y: f64) -> (i32, i32) {
        let rect = self.target();
        let nx = norm_x.clamp(0.0, 1.0);
        let ny = norm_y.clamp(0.0, 1.0);
        // Subtract one pixel so norm = 1.0 lands on the last addressable pixel
        // rather than one past the edge of the monitor.
        let x = rect.x + (nx * (rect.width - 1).max(0) as f64).round() as i32;
        let y = rect.y + (ny * (rect.height - 1).max(0) as f64).round() as i32;
        (x, y)
    }

    fn remember_injected(&self, x: i32, y: i32) {
        self.last_injected_x.store(x, Ordering::SeqCst);
        self.last_injected_y.store(y, Ordering::SeqCst);
    }

    pub fn move_mouse(&self, norm_x: f64, norm_y: f64) -> Result<(), String> {
        self.authorize()?;
        let (x, y) = self.resolve(norm_x, norm_y);
        self.with_enigo(|e| {
            e.move_mouse(x, y, Coordinate::Abs)
                .map_err(|err| format!("move_mouse failed: {err}"))
        })?;
        self.remember_injected(x, y);
        Ok(())
    }

    pub fn mouse_button(
        &self,
        button: &str,
        pressed: bool,
        norm_x: Option<f64>,
        norm_y: Option<f64>,
    ) -> Result<(), String> {
        self.authorize()?;

        let btn = match button {
            "left" => Button::Left,
            "middle" => Button::Middle,
            "right" => Button::Right,
            other => return Err(format!("unsupported mouse button: {other}")),
        };
        let direction = if pressed { Direction::Press } else { Direction::Release };

        // Position first so press and release land on the same pixel even if a
        // move packet was dropped by the unreliable channel.
        let resolved = match (norm_x, norm_y) {
            (Some(nx), Some(ny)) => Some(self.resolve(nx, ny)),
            _ => None,
        };

        self.with_enigo(|e| {
            if let Some((x, y)) = resolved {
                e.move_mouse(x, y, Coordinate::Abs)
                    .map_err(|err| format!("move_mouse failed: {err}"))?;
            }
            e.button(btn, direction)
                .map_err(|err| format!("button injection failed: {err}"))
        })?;

        if let Some((x, y)) = resolved {
            self.remember_injected(x, y);
        }
        Ok(())
    }

    pub fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), String> {
        self.authorize()?;
        self.with_enigo(|e| {
            if delta_y != 0 {
                e.scroll(delta_y, Axis::Vertical)
                    .map_err(|err| format!("vertical scroll failed: {err}"))?;
            }
            if delta_x != 0 {
                e.scroll(delta_x, Axis::Horizontal)
                    .map_err(|err| format!("horizontal scroll failed: {err}"))?;
            }
            Ok(())
        })
    }

    pub fn key(&self, code: &str, pressed: bool) -> Result<bool, String> {
        self.authorize()?;
        let Some(key) = code_to_key(code) else {
            // Unmapped keys are a no-op, not a failure — reporting `false` lets
            // the host surface it without tearing the session down.
            return Ok(false);
        };
        let direction = if pressed { Direction::Press } else { Direction::Release };
        self.with_enigo(|e| {
            e.key(key, direction)
                .map_err(|err| format!("key injection failed: {err}"))
        })?;
        Ok(true)
    }

    /// Reads the live cursor position and reports whether it has diverged from
    /// where we last put it — i.e. whether a human at the host moved the mouse.
    ///
    /// Returns `None` when there is nothing to compare against yet.
    pub fn detect_physical_movement(&self) -> Option<(i32, i32)> {
        if !self.kill_switch_armed.load(Ordering::SeqCst) {
            return None;
        }
        if !self.control_enabled.load(Ordering::SeqCst) {
            return None;
        }

        let expected_x = self.last_injected_x.load(Ordering::SeqCst);
        let expected_y = self.last_injected_y.load(Ordering::SeqCst);
        if expected_x == i32::MIN || expected_y == i32::MIN {
            return None;
        }

        let actual = self
            .with_enigo(|e| e.location().map_err(|err| format!("cursor read failed: {err}")))
            .ok()?;

        let (ax, ay) = actual;
        if (ax - expected_x).abs() >= PHYSICAL_MOVEMENT_THRESHOLD_PX
            || (ay - expected_y).abs() >= PHYSICAL_MOVEMENT_THRESHOLD_PX
        {
            // Re-baseline so one physical nudge does not retrigger every poll.
            self.remember_injected(ax, ay);
            return Some((ax, ay));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_is_denied_until_host_grants_control() {
        let state = InputState::new();
        assert!(state.authorize().is_err());
        state.set_control_enabled(true);
        assert!(state.authorize().is_ok());
    }

    #[test]
    fn kill_switch_blocks_injection_until_cooldown_elapses() {
        let state = InputState::new();
        state.set_control_enabled(true);
        state.trigger_kill_switch();
        assert!(state.authorize().is_err());
        state.clear_kill_switch();
        assert!(state.authorize().is_ok());
    }

    #[test]
    fn normalized_coordinates_map_across_the_full_target_rect() {
        let state = InputState::new();
        state
            .set_target(TargetRect { x: 100, y: 50, width: 1920, height: 1080 })
            .unwrap();

        assert_eq!(state.resolve(0.0, 0.0), (100, 50));
        assert_eq!(state.resolve(1.0, 1.0), (100 + 1919, 50 + 1079));
        assert_eq!(state.resolve(0.5, 0.5), (100 + 960, 50 + 540));
    }

    #[test]
    fn out_of_range_coordinates_are_clamped_into_the_rect() {
        let state = InputState::new();
        state
            .set_target(TargetRect { x: 0, y: 0, width: 800, height: 600 })
            .unwrap();

        assert_eq!(state.resolve(-3.0, -3.0), (0, 0));
        assert_eq!(state.resolve(9.0, 9.0), (799, 599));
    }

    #[test]
    fn zero_area_targets_are_rejected() {
        let state = InputState::new();
        assert!(state
            .set_target(TargetRect { x: 0, y: 0, width: 0, height: 1080 })
            .is_err());
    }
}

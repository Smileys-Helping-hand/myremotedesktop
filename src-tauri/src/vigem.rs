//! ViGEm virtual Xbox 360 controller driver integration.
//!
//! Provides genuine virtual controller emulation on Windows hosts when the ViGEmBus
//! driver is installed. Allows remote clients (Linux laptops, Steam Decks, macOS, or Windows)
//! to appear as physical local Player 2 controllers in Windows games.
//!
//! Non-Windows platforms compile safe stubs with `supported = false`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VigemStatus {
    pub supported: bool,
    pub driver_installed: bool,
    pub controller_plugged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct X360Report {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub thumb_lx: i16,
    pub thumb_ly: i16,
    pub thumb_rx: i16,
    pub thumb_ry: i16,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    pub struct VigemState {
        target: Mutex<Option<Xbox360Wired<Client>>>,
    }

    impl VigemState {
        pub fn new() -> Self {
            Self {
                target: Mutex::new(None),
            }
        }

        pub fn status(&self) -> VigemStatus {
            let guard = self.target.lock().unwrap_or_else(|e| e.into_inner());
            let plugged = guard.as_ref().map(|ctrl| ctrl.is_attached()).unwrap_or(false);

            let driver_installed = Client::connect().is_ok();

            VigemStatus {
                supported: true,
                driver_installed,
                controller_plugged: plugged,
            }
        }

        pub fn plugin(&self) -> Result<(), String> {
            let mut guard = self.target.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Ok(());
            }

            let client = Client::connect().map_err(|e| {
                format!(
                    "ViGEmBus driver connection failed: {:?}. Please install ViGEmBus driver.",
                    e
                )
            })?;

            let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
            target.plugin().map_err(|e| format!("failed to plug in virtual controller: {:?}", e))?;
            let _ = target.wait_ready();

            *guard = Some(target);
            Ok(())
        }

        pub fn unplug(&self) -> Result<(), String> {
            let mut guard = self.target.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut target) = guard.take() {
                let _ = target.unplug();
            }
            Ok(())
        }

        pub fn update(&self, report: X360Report) -> Result<(), String> {
            let mut guard = self.target.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref mut target) = *guard {
                let gamepad = XGamepad {
                    buttons: XButtons(report.buttons),
                    left_trigger: report.left_trigger,
                    right_trigger: report.right_trigger,
                    thumb_lx: report.thumb_lx,
                    thumb_ly: report.thumb_ly,
                    thumb_rx: report.thumb_rx,
                    thumb_ry: report.thumb_ry,
                };
                target
                    .update(&gamepad)
                    .map_err(|e| format!("vigem update error: {:?}", e))?;
            }
            Ok(())
        }
    }

    impl Drop for VigemState {
        fn drop(&mut self) {
            let _ = self.unplug();
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    pub struct VigemState;

    impl VigemState {
        pub fn new() -> Self {
            Self
        }

        pub fn status(&self) -> VigemStatus {
            VigemStatus {
                supported: false,
                driver_installed: false,
                controller_plugged: false,
            }
        }

        pub fn plugin(&self) -> Result<(), String> {
            Err("ViGEmBus virtual controller is only supported on Windows hosts".into())
        }

        pub fn unplug(&self) -> Result<(), String> {
            Ok(())
        }

        pub fn update(&self, _report: X360Report) -> Result<(), String> {
            Ok(())
        }
    }
}

pub use imp::VigemState;

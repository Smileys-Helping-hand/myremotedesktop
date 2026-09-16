//! This machine's own identity: its Desk ID, its name, and how it admits peers.
//!
//! The Desk ID used to be drawn at random when the Host tab mounted, so it
//! changed on every launch — and on every page reload. Nothing could be saved
//! against it: a device book entry, a connect link sent to someone, a bookmark,
//! all stale the moment the app restarted. An ID that identifies a machine has
//! to outlive the process, so it lives here, in the app's config directory,
//! written once and read by every surface that needs it.
//!
//! The access password lives here for the same reason. A rotating PIN cannot be
//! saved by the other side by definition, so one-click reconnection needs a
//! secret that holds still — the same trade every remote desktop tool makes for
//! unattended access.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// How this machine decides whether to admit a client.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    /// Anyone who knows the Desk ID gets in. Convenient and wide open.
    Open,
    /// A fixed password admits a client with no prompt. What saved devices use.
    Password,
    /// A PIN that rotates every minute, read off this screen each time.
    Rotating,
    /// Nobody gets in until the person at this machine says yes. The default,
    /// because it is the only one that cannot surprise the owner of the machine.
    #[default]
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Six digits, stable for the life of this installation.
    pub desk_id: String,
    /// What other people see this machine called.
    pub name: String,
    #[serde(default)]
    pub access_mode: AccessMode,
    /// The fixed password, when the mode is `Password`.
    #[serde(default)]
    pub access_password: Option<String>,
}

impl Profile {
    fn new(name: String) -> Self {
        Profile {
            desk_id: generate_desk_id(),
            name,
            access_mode: AccessMode::default(),
            access_password: None,
        }
    }
}

struct Store {
    path: PathBuf,
    profile: Mutex<Profile>,
}

static STORE: OnceLock<Store> = OnceLock::new();

/// Loads this machine's profile, creating one the first time.
pub fn init(path: PathBuf) {
    let profile = match load(&path) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            let fresh = Profile::new(machine_name());
            if let Err(err) = persist(&path, &fresh) {
                eprintln!("[remotedesk] could not write the machine profile: {err}");
            }
            fresh
        }
        Err(err) => {
            // A profile that cannot be read must not hand out a new Desk ID and
            // silently break every link already shared; say so loudly, and use
            // a temporary identity for this run only.
            eprintln!("[remotedesk] could not read the machine profile at {path:?}: {err}");
            eprintln!("[remotedesk] using a temporary Desk ID for this run");
            Profile::new(machine_name())
        }
    };

    println!(
        "[remotedesk] this machine is \"{}\", Desk ID {}",
        profile.name, profile.desk_id
    );
    let _ = STORE.set(Store {
        path,
        profile: Mutex::new(profile),
    });
}

fn load(path: &Path) -> io::Result<Option<Profile>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// This machine's profile. A default one before setup has run, so a caller
/// never has to handle "not ready yet".
pub fn current() -> Profile {
    match STORE.get() {
        Some(store) => match store.profile.lock() {
            Ok(profile) => profile.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        },
        None => Profile::new(machine_name()),
    }
}

/// Applies the parts of a profile the operator is allowed to change.
///
/// The Desk ID is deliberately not one of them: other people have it written
/// down, and changing it would break their saved devices with no way for them
/// to find out why.
pub fn update(name: Option<String>, mode: Option<AccessMode>, password: Option<Option<String>>) -> Result<Profile, String> {
    let store = STORE.get().ok_or("no profile is configured")?;
    let mut profile = match store.profile.lock() {
        Ok(profile) => profile,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(name) = name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            profile.name = trimmed.to_string();
        }
    }
    if let Some(mode) = mode {
        profile.access_mode = mode;
    }
    if let Some(password) = password {
        profile.access_password = password
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
    }

    // A password mode with no password would admit everyone, which is the
    // opposite of what was asked for.
    if profile.access_mode == AccessMode::Password && profile.access_password.is_none() {
        return Err("set a password before choosing password access".into());
    }

    persist(&store.path, &profile)?;
    Ok(profile.clone())
}

fn persist(path: &Path, profile: &Profile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(profile).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    write_private(&temp, &json).map_err(|e| format!("could not write {temp:?}: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("could not replace {path:?}: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)
}

/// Six digits from the OS random source.
///
/// Not from the clock: two machines set up by the same script at the same
/// moment would collide, and a Desk ID is what tells them apart.
fn generate_desk_id() -> String {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        return "100000".into();
    }
    let value = u32::from_le_bytes(bytes) % 900_000 + 100_000;
    value.to_string()
}

/// A name a person would recognise, falling back to something honest.
fn machine_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME", "HOST"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Ok(name) = fs::read_to_string("/etc/hostname") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "RemoteDesk host".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desk_id_is_six_digits() {
        for _ in 0..50 {
            let id = generate_desk_id();
            assert_eq!(id.len(), 6, "{id}");
            assert!(id.chars().all(|c| c.is_ascii_digit()));
            assert!(!id.starts_with('0'));
        }
    }

    #[test]
    fn asking_is_the_default_so_a_fresh_install_is_not_open() {
        let profile = Profile::new("test".into());
        assert_eq!(profile.access_mode, AccessMode::Ask);
        assert!(profile.access_password.is_none());
    }

    #[test]
    fn a_profile_round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("remotedesk-profile-{}", std::process::id()));
        let path = dir.join("profile.json");
        let _ = fs::remove_dir_all(&dir);

        let profile = Profile {
            desk_id: "903117".into(),
            name: "Linux laptop".into(),
            access_mode: AccessMode::Password,
            access_password: Some("hunter2".into()),
        };
        persist(&path, &profile).unwrap();

        let read = load(&path).unwrap().unwrap();
        assert_eq!(read.desk_id, "903117");
        assert_eq!(read.access_mode, AccessMode::Password);
        assert_eq!(read.access_password.as_deref(), Some("hunter2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_profile_without_access_fields_still_loads() {
        // Upgrading must not lose the Desk ID other people have written down.
        let profile: Profile =
            serde_json::from_str(r#"{"deskId":"903117","name":"Laptop"}"#).unwrap();
        assert_eq!(profile.desk_id, "903117");
        assert_eq!(profile.access_mode, AccessMode::Ask);
    }
}

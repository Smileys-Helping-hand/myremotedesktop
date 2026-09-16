//! The saved device book: machines this operator connects to, by name.
//!
//! Typing a six-digit Desk ID and a PIN read off another screen is the whole
//! friction of a remote session, and it has to be done every time because both
//! change. A saved device carries what a connection needs — where the machine
//! is, which desk to join, and the secret that admits us — so reconnecting is
//! one click.
//!
//! It lives in the app rather than in browser storage for a reason: on Linux
//! the session UI runs in the operator's own browser, served by this process,
//! and a device saved in the app window has to be there in the browser page
//! too. One file, one owner, both surfaces.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// A machine worth remembering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Stable key. Supplied by the caller so the same machine saved twice
    /// updates its entry instead of appearing twice.
    pub id: String,
    /// What the operator calls it: "Linux laptop", not "192.168.31.206".
    pub name: String,
    /// Desk ID to join. May be empty for a machine whose ID is not fixed yet.
    #[serde(default)]
    pub desk_id: String,
    /// Where to look for it, in the order to try: LAN addresses first, then a
    /// public tunnel. A machine that moves between networks keeps them all.
    #[serde(default)]
    pub addresses: Vec<String>,
    /// The PIN or password that admits us, when the operator chose to save it.
    #[serde(default)]
    pub pin: Option<String>,
    /// Unix seconds of the last successful connection, for ordering the list.
    #[serde(default)]
    pub last_connected: Option<u64>,
    #[serde(default)]
    pub created: Option<u64>,
    /// Free-text note from the operator.
    #[serde(default)]
    pub note: Option<String>,
}

/// Everything the book holds, as written to disk.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Book {
    #[serde(default)]
    devices: Vec<Device>,
}

struct Store {
    path: PathBuf,
    book: Mutex<Book>,
}

static STORE: OnceLock<Store> = OnceLock::new();

/// Points the book at a file and loads what is already there.
///
/// A file that cannot be read — corrupt, or written by a newer version — is
/// not fatal: the operator gets an empty book and a log line, rather than an
/// app that will not start. It is not overwritten until something is saved.
pub fn init(path: PathBuf) {
    let book = match load(&path) {
        Ok(book) => book,
        Err(err) => {
            eprintln!("[remotedesk] could not read the device book at {path:?}: {err}");
            Book::default()
        }
    };
    let count = book.devices.len();
    if STORE
        .set(Store {
            path,
            book: Mutex::new(book),
        })
        .is_ok()
    {
        println!("[remotedesk] device book loaded ({count} saved)");
    }
}

fn load(path: &Path) -> io::Result<Book> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Book::default()),
        Err(err) => Err(err),
    }
}

/// Every saved device, most recently connected first.
pub fn list() -> Vec<Device> {
    let Some(store) = STORE.get() else {
        return Vec::new();
    };
    let book = match store.book.lock() {
        Ok(book) => book,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut devices = book.devices.clone();
    devices.sort_by(|a, b| {
        b.last_connected
            .unwrap_or(0)
            .cmp(&a.last_connected.unwrap_or(0))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    devices
}

/// Adds a device, or replaces the one already saved under its id.
pub fn save(mut device: Device) -> Result<Device, String> {
    let store = STORE.get().ok_or("no device book is configured")?;
    if device.id.trim().is_empty() {
        return Err("a device needs an id".into());
    }
    let mut book = match store.book.lock() {
        Ok(book) => book,
        Err(poisoned) => poisoned.into_inner(),
    };

    match book.devices.iter_mut().find(|d| d.id == device.id) {
        Some(existing) => {
            // Keep what the caller did not send: a rename must not wipe the
            // saved PIN, and saving from a scan must not forget when we last
            // connected.
            device.created = existing.created.or_else(now);
            device.last_connected = device.last_connected.or(existing.last_connected);
            if device.pin.is_none() {
                device.pin = existing.pin.clone();
            }
            *existing = device.clone();
        }
        None => {
            device.created = device.created.or_else(now);
            book.devices.push(device.clone());
        }
    }

    persist(&store.path, &book)?;
    Ok(device)
}

/// Forgets a device. Removing one that is not there is not an error.
pub fn remove(id: &str) -> Result<(), String> {
    let store = STORE.get().ok_or("no device book is configured")?;
    let mut book = match store.book.lock() {
        Ok(book) => book,
        Err(poisoned) => poisoned.into_inner(),
    };
    book.devices.retain(|d| d.id != id);
    persist(&store.path, &book)
}

/// Stamps a device as connected just now, so it rises to the top of the list.
pub fn touch(id: &str) -> Result<(), String> {
    let store = STORE.get().ok_or("no device book is configured")?;
    let mut book = match store.book.lock() {
        Ok(book) => book,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(device) = book.devices.iter_mut().find(|d| d.id == id) {
        device.last_connected = now();
    }
    persist(&store.path, &book)
}

fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Writes the book, replacing the old file only once the new one is complete.
///
/// The file holds saved PINs, so on Unix it is created readable by its owner
/// alone. A crash mid-write must not leave a truncated file in place of a
/// working one, hence the temporary file and rename.
fn persist(path: &Path, book: &Book) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(book).map_err(|e| e.to_string())?;

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
    // Windows has no mode bits to set here; the file lands in the user's own
    // roaming profile, which is already user-scoped.
    fs::write(path, bytes)
}

/// Parses the body of a save request into a device.
///
/// Kept separate from the HTTP layer so the rules — an id is required, blank
/// strings are not addresses, a blank PIN means "no PIN" rather than a PIN of
/// zero length — are testable without a server.
pub fn device_from_json(value: &serde_json::Value) -> Result<Device, String> {
    let object = value.as_object().ok_or("expected a device object")?;
    let text = |key: &str| -> Option<String> {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let id = text("id").ok_or("a device needs an id")?;
    let name = text("name").unwrap_or_else(|| id.clone());

    let addresses = object
        .get("addresses")
        .and_then(|v| v.as_array())
        .map(|items| {
            let mut seen = BTreeMap::new();
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter(|s| seen.insert(s.to_string(), ()).is_none())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    Ok(Device {
        id,
        name,
        desk_id: text("deskId").unwrap_or_default(),
        addresses,
        pin: text("pin"),
        last_connected: object.get("lastConnected").and_then(|v| v.as_u64()),
        created: object.get("created").and_then(|v| v.as_u64()),
        note: text("note"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_device_needs_an_id() {
        assert!(device_from_json(&json!({ "name": "Laptop" })).is_err());
        assert!(device_from_json(&json!("not an object")).is_err());
    }

    #[test]
    fn a_device_without_a_name_is_named_after_its_id() {
        let device = device_from_json(&json!({ "id": "abc" })).unwrap();
        assert_eq!(device.name, "abc");
    }

    #[test]
    fn blank_fields_are_dropped_rather_than_saved_as_empty() {
        // A PIN of "" would otherwise be offered to the server as a real PIN
        // and rejected, which reads to the operator as a wrong password.
        let device = device_from_json(&json!({
            "id": "abc",
            "name": "  Laptop  ",
            "pin": "   ",
            "deskId": "",
            "addresses": ["http://192.168.1.5:4000", "  ", "http://192.168.1.5:4000"],
        }))
        .unwrap();

        assert_eq!(device.name, "Laptop");
        assert_eq!(device.pin, None);
        assert_eq!(device.desk_id, "");
        // Blanks dropped, duplicates collapsed.
        assert_eq!(device.addresses, vec!["http://192.168.1.5:4000"]);
    }

    #[test]
    fn addresses_keep_the_order_they_were_given() {
        // LAN first, tunnel last: connecting tries them in this order, and a
        // reordered list would send every local connection over the internet.
        let device = device_from_json(&json!({
            "id": "abc",
            "addresses": ["http://192.168.1.5:4000", "https://x.trycloudflare.com"],
        }))
        .unwrap();
        assert_eq!(
            device.addresses,
            vec!["http://192.168.1.5:4000", "https://x.trycloudflare.com"]
        );
    }

    #[test]
    fn the_book_round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("remotedesk-devices-{}", std::process::id()));
        let path = dir.join("devices.json");
        let _ = fs::remove_dir_all(&dir);

        let book = Book {
            devices: vec![Device {
                id: "one".into(),
                name: "Linux laptop".into(),
                desk_id: "903117".into(),
                addresses: vec!["http://192.168.31.206:4000".into()],
                pin: Some("TEST12".into()),
                last_connected: Some(42),
                created: Some(1),
                note: None,
            }],
        };
        persist(&path, &book).unwrap();

        let read = load(&path).unwrap();
        assert_eq!(read.devices.len(), 1);
        assert_eq!(read.devices[0].pin.as_deref(), Some("TEST12"));
        assert_eq!(read.devices[0].desk_id, "903117");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_book_reads_as_empty_rather_than_failing() {
        let dir = std::env::temp_dir().join(format!("remotedesk-bad-{}", std::process::id()));
        let path = dir.join("devices.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, b"{ not json").unwrap();

        assert!(load(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

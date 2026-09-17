//! Updates, served between machines instead of from a cloud.
//!
//! The app already hands out installers over its own HTTP server so a machine
//! on the LAN can install it with nothing else available. This turns that into
//! a real update channel: the same directory, described as the manifest the
//! Tauri updater expects, so one machine updates from another with no internet,
//! no account, and no release infrastructure.
//!
//! What makes that safe is that the manifest is not trusted. Every package the
//! updater applies must carry a minisign signature that verifies against the
//! public key compiled into this binary, and only the holder of the private key
//! can produce one. A peer on the network can offer an update; it cannot forge
//! one, and a tampered package is refused before anything is written.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

/// A package this machine can offer, as the updater needs to see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    /// The updater's platform key, e.g. `windows-x86_64`.
    pub target: String,
    pub file: String,
    pub version: String,
    /// Contents of the sibling `.sig`, which is what the updater verifies.
    pub signature: String,
}

/// The updater's platform key for a package, or `None` if it cannot update.
///
/// A `.deb` or `.rpm` is owned by the system package manager: replacing one
/// behind its back would leave the package database describing a version that
/// is no longer installed, so those are offered as downloads but never as
/// updates. On Linux the AppImage is the whole application in one file, which
/// is why it is the only shape the updater can replace in place.
pub fn updater_target(file: &str) -> Option<&'static str> {
    let lower = file.to_ascii_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".msi") {
        Some("windows-x86_64")
    } else if lower.ends_with(".appimage") {
        Some("linux-x86_64")
    } else if lower.ends_with(".app.tar.gz") {
        Some("darwin-x86_64")
    } else {
        None
    }
}

/// Builds the manifest from what is on disk, newest version only.
///
/// Offering a mixture of versions would let one platform update to 1.2 while
/// another sat on 1.1 from the same manifest, which is how two machines end up
/// unable to talk to each other. One version is published at a time: the
/// highest that has at least one signed package.
pub fn build_manifest(base_url: &str, packages: &[Package], notes: Option<&str>) -> Option<Value> {
    let newest = packages
        .iter()
        .map(|p| p.version.as_str())
        .max_by(|a, b| compare_versions(a, b))?
        .to_string();

    let mut platforms = serde_json::Map::new();
    // BTreeMap so the manifest is byte-identical between calls; a manifest that
    // reorders itself makes any diff or cache check meaningless.
    let mut by_target: BTreeMap<&str, &Package> = BTreeMap::new();
    for package in packages.iter().filter(|p| p.version == newest) {
        by_target.entry(package.target.as_str()).or_insert(package);
    }

    for (target, package) in by_target {
        platforms.insert(
            target.to_string(),
            json!({
                "signature": package.signature,
                "url": format!("{}/download/{}", base_url.trim_end_matches('/'), package.file),
            }),
        );
    }

    if platforms.is_empty() {
        return None;
    }

    Some(json!({
        "version": newest,
        "notes": notes.unwrap_or("Update served by a RemoteDesk machine on your network."),
        "pub_date": pub_date(),
        "platforms": Value::Object(platforms),
    }))
}

/// Now, in the RFC 3339 form the updater parses.
///
/// Built by hand rather than pulling in a date crate for one field. A clock
/// that cannot be read is not worth failing the whole manifest over — the
/// updater compares versions, not dates.
fn pub_date() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Days since the epoch, converted with the civil-from-days algorithm.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Orders two `major.minor.patch` strings.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .take(3)
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (left, right) = (parse(a), parse(b));
    for i in 0..3 {
        let ordering = left.get(i).unwrap_or(&0).cmp(right.get(i).unwrap_or(&0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// Reads the signed packages out of a directory.
///
/// A package with no `.sig` beside it is skipped rather than offered: the
/// updater would refuse it on arrival, and the honest place to find that out is
/// here, where the manifest is built, not on the other machine after an 80 MB
/// download.
pub fn packages_in(dir: &Path) -> Vec<Package> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut packages = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(target) = updater_target(&name) else {
            continue;
        };
        let Some(version) = crate::signaling::version_from_filename(&name) else {
            continue;
        };
        let signature_path = dir.join(format!("{name}.sig"));
        let Ok(signature) = std::fs::read_to_string(&signature_path) else {
            continue;
        };
        packages.push(Package {
            target: target.to_string(),
            file: name,
            version,
            signature: signature.trim().to_string(),
        });
    }
    packages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(file: &str, version: &str) -> Package {
        Package {
            target: updater_target(file).unwrap().to_string(),
            file: file.to_string(),
            version: version.to_string(),
            signature: format!("sig-for-{file}"),
        }
    }

    #[test]
    fn only_packages_the_updater_can_actually_apply_get_a_target() {
        assert_eq!(updater_target("RemoteDesk_1.1.4_x64-setup.exe"), Some("windows-x86_64"));
        assert_eq!(updater_target("RemoteDesk_1.1.4_amd64.AppImage"), Some("linux-x86_64"));
        // Owned by the system package manager: a download, never an update.
        assert_eq!(updater_target("RemoteDesk_1.1.4_amd64.deb"), None);
        assert_eq!(updater_target("RemoteDesk-1.1.4-1.x86_64.rpm"), None);
    }

    #[test]
    fn the_manifest_offers_one_version_across_every_platform() {
        let manifest = build_manifest(
            "http://192.168.1.5:4000",
            &[
                package("RemoteDesk_1.1.4_x64-setup.exe", "1.1.4"),
                package("RemoteDesk_1.1.4_amd64.AppImage", "1.1.4"),
                // An older build left in the directory must not be offered to
                // the platform whose newest package happens to be missing.
                package("RemoteDesk_1.1.0_amd64.AppImage", "1.1.0"),
            ],
            None,
        )
        .unwrap();

        assert_eq!(manifest["version"], "1.1.4");
        assert_eq!(
            manifest["platforms"]["windows-x86_64"]["url"],
            "http://192.168.1.5:4000/download/RemoteDesk_1.1.4_x64-setup.exe"
        );
        assert_eq!(
            manifest["platforms"]["linux-x86_64"]["url"],
            "http://192.168.1.5:4000/download/RemoteDesk_1.1.4_amd64.AppImage"
        );
        assert_eq!(
            manifest["platforms"]["linux-x86_64"]["signature"],
            "sig-for-RemoteDesk_1.1.4_amd64.AppImage"
        );
    }

    #[test]
    fn a_platform_missing_from_the_newest_version_is_simply_absent() {
        // Better than quietly offering it the previous release: the updater
        // would install it and report success, having gone backwards.
        let manifest = build_manifest(
            "http://host:4000",
            &[
                package("RemoteDesk_1.1.4_x64-setup.exe", "1.1.4"),
                package("RemoteDesk_1.1.0_amd64.AppImage", "1.1.0"),
            ],
            None,
        )
        .unwrap();
        assert!(manifest["platforms"].get("linux-x86_64").is_none());
    }

    #[test]
    fn nothing_to_offer_is_no_manifest_at_all() {
        assert!(build_manifest("http://host:4000", &[], None).is_none());
    }

    #[test]
    fn versions_order_numerically_not_alphabetically() {
        use std::cmp::Ordering;
        // "1.1.10" sorts before "1.1.9" as text, which would offer an update
        // that is actually a downgrade.
        assert_eq!(compare_versions("1.1.10", "1.1.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.0", "1.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.1.4", "1.1.4"), Ordering::Equal);
        assert_eq!(compare_versions("v1.1.4", "1.1.4"), Ordering::Equal);
    }

    #[test]
    fn the_publication_date_is_rfc_3339() {
        let date = pub_date();
        assert_eq!(date.len(), 20, "{date}");
        assert!(date.ends_with('Z'));
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[10..11], "T");
        // A plausible year, which is the part a wrong civil-date conversion
        // would get spectacularly wrong.
        let year: i32 = date[..4].parse().unwrap();
        assert!((2020..2100).contains(&year), "{date}");
    }
}

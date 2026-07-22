//! Optional, opt-in auto-update over an internal (UNC) file share. Windows-only.
//!
//! **Dormant by default.** If no `update.json` config file is present next to
//! the exe (preferred) or under `assets/`, none of this runs and the app makes
//! no network access whatsoever — the offline-first guarantee is preserved.
//!
//! The NWC add-on package overlays `assets/update.json` (see nwc-addon) to
//! enable the feature, pointing `source` at an internal file share. On startup
//! `main()` spawns a background thread that reads the manifest, compares the
//! advertised version against `CARGO_PKG_VERSION`, and — when newer — prefetches
//! the installer into a temp dir and notifies the webview (a banner offers
//! "Install now"). On acceptance the app launches the installer silently and
//! relaunches itself; the stable Inno AppId makes it an in-place upgrade.
//!
//! Transport is a plain filesystem path (UNC `\\server\share\...` or local), so
//! there is no HTTP-client dependency and no TLS to manage.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Contents of `update.json`. Absent / `enabled:false` ⇒ feature off.
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Directory (UNC or local) holding the manifest + installer exe.
    #[serde(default)]
    pub source: String,
    /// Manifest filename within `source`. Defaults to `latest.json`.
    #[serde(default = "default_manifest")]
    pub manifest: String,
    /// Timeout for the manifest reachability probe, in ms. An unreachable UNC
    /// share can otherwise block an SMB read for tens of seconds; past this we
    /// give up (on a helper thread, so nothing else is held up).
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_manifest() -> String {
    "latest.json".to_string()
}
fn default_timeout() -> u64 {
    4000
}

/// Version manifest published on the share (`source/<manifest>`).
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    /// Latest available semver, e.g. `"0.16.0"`.
    version: String,
    /// Installer filename relative to `source`, e.g.
    /// `"MdPreviewer-NWC-Full-Setup-0.16.0.exe"`.
    setup: String,
    /// Optional short note shown in the update banner.
    #[serde(default)]
    notes: String,
}

/// A confirmed-newer update whose installer has been prefetched (or, on
/// prefetch failure, whose `setup_temp` still points at the share).
#[derive(Debug, Clone)]
pub struct UpdateReady {
    pub version: String,
    pub notes: String,
    pub setup_temp: PathBuf,
}

/// Read `update.json` from `exe_dir` (preferred) or `assets_dir`. Returns `None`
/// when the file is absent, disabled, empty-sourced, or malformed — the common
/// case, which keeps the app fully offline.
pub fn load_config(exe_dir: &Path, assets_dir: &Path) -> Option<UpdateConfig> {
    let candidates = [exe_dir.join("update.json"), assets_dir.join("update.json")];
    for path in candidates.iter() {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue, // not this location; try the next
        };
        match serde_json::from_slice::<UpdateConfig>(&bytes) {
            Ok(cfg) => {
                if cfg.enabled && !cfg.source.trim().is_empty() {
                    crate::dbg_log_write(&format!(
                        "updater: enabled via {:?} (source={}, manifest={})",
                        path, cfg.source, cfg.manifest
                    ));
                    return Some(cfg);
                }
                crate::dbg_log_write(&format!("updater: config at {:?} disabled/empty", path));
                return None;
            }
            Err(e) => {
                crate::dbg_log_write(&format!("updater: bad config {:?}: {}", path, e));
                return None;
            }
        }
    }
    None
}

/// Parse a semver-ish string into a `(major, minor, patch)` tuple. Tolerant: a
/// leading `v`, missing components, and non-numeric suffixes (e.g. `0.16.0-rc1`)
/// are handled by taking the leading digits of each dotted component.
pub fn parse_semver(s: &str) -> (u32, u32, u32) {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let parts: Vec<u32> = s
        .split('.')
        .map(|p| {
            let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().unwrap_or(0)
        })
        .collect();
    (
        parts.first().copied().unwrap_or(0),
        parts.get(1).copied().unwrap_or(0),
        parts.get(2).copied().unwrap_or(0),
    )
}

/// True when `latest` is strictly newer than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    parse_semver(latest) > parse_semver(current)
}

/// Read a file with a wall-clock timeout. The blocking `fs::read` runs on a
/// helper thread; if the share is unreachable and the read hangs past
/// `timeout_ms`, we return `None` and let the orphaned thread finish/die on its
/// own (it holds nothing else up). Returns `None` on any read error too.
fn read_with_timeout(path: &Path, timeout_ms: u64) -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let p = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = tx.send(std::fs::read(&p));
    });
    match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(Ok(bytes)) => Some(bytes),
        Ok(Err(e)) => {
            crate::dbg_log_write(&format!("updater: manifest read failed {:?}: {}", path, e));
            None
        }
        Err(_) => {
            crate::dbg_log_write(&format!(
                "updater: manifest read timed out after {}ms ({:?})",
                timeout_ms, path
            ));
            None
        }
    }
}

/// Read the manifest from the share, compare versions and — when a newer
/// version is advertised — prefetch the installer into a temp dir. Returns
/// `None` (silently, logging only) on any failure so the UI is never disturbed.
///
/// Runs on a background thread; performs blocking filesystem I/O on `source`.
pub fn check_and_prepare(cfg: &UpdateConfig, current_version: &str) -> Option<UpdateReady> {
    let source = Path::new(&cfg.source);
    let manifest_path = source.join(&cfg.manifest);

    let bytes = match read_with_timeout(&manifest_path, cfg.timeout_ms) {
        Some(b) => b,
        None => return None, // unreachable / timed out / read error (logged inside)
    };
    let manifest: Manifest = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            crate::dbg_log_write(&format!("updater: manifest parse failed: {}", e));
            return None;
        }
    };

    if !is_newer(&manifest.version, current_version) {
        crate::dbg_log_write(&format!(
            "updater: up to date (latest={}, current={})",
            manifest.version, current_version
        ));
        return None;
    }
    crate::dbg_log_write(&format!(
        "updater: update available {} -> {}",
        current_version, manifest.version
    ));

    // Prefetch the installer to a temp dir so "Install now" is instant. On
    // failure, fall back to running the installer straight from the share.
    let setup_src = source.join(&manifest.setup);
    let setup_name = Path::new(&manifest.setup)
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("MdPreviewer-Setup.exe"));
    let temp_dir = std::env::temp_dir().join("mdp-update");
    let _ = std::fs::create_dir_all(&temp_dir);
    let setup_temp = temp_dir.join(&setup_name);

    match std::fs::copy(&setup_src, &setup_temp) {
        Ok(n) => {
            crate::dbg_log_write(&format!(
                "updater: prefetched {} bytes to {:?}",
                n, setup_temp
            ));
            Some(UpdateReady {
                version: manifest.version,
                notes: manifest.notes,
                setup_temp,
            })
        }
        Err(e) => {
            crate::dbg_log_write(&format!(
                "updater: prefetch failed ({}); will run from share {:?}",
                e, setup_src
            ));
            Some(UpdateReady {
                version: manifest.version,
                notes: manifest.notes,
                setup_temp: setup_src,
            })
        }
    }
}

/// Launch the (per-user, no-UAC) installer silently for an in-place upgrade,
/// then relaunch the freshly-installed exe — optionally reopening `open_file`.
///
/// Spawns a detached `cmd` that (1) waits ~1s so this process fully exits and
/// releases its own exe's file lock, (2) runs the Inno installer with
/// `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, then (3) `start`s the new exe.
/// `cmd /S /C "…"` strips only the outer quotes, so the internal quotes around
/// each path are preserved verbatim. The caller should request app exit right
/// after this returns.
#[cfg(windows)]
pub fn launch_installer_and_relaunch(
    setup: &Path,
    exe: &Path,
    open_file: Option<&Path>,
) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Strip stray quotes from paths (paths shouldn't contain `"`; belt-and-braces).
    let setup_s = setup.to_string_lossy().replace('"', "");
    let exe_s = exe.to_string_lossy().replace('"', "");
    let reopen = match open_file {
        Some(p) => format!(" \"{}\"", p.to_string_lossy().replace('"', "")),
        None => String::new(),
    };

    // `ping` is used as a console-independent ~1s delay (`timeout` needs a real
    // console and fails when detached).
    let inner = format!(
        "ping -n 2 127.0.0.1 >nul & \"{}\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART & start \"\" \"{}\"{}",
        setup_s, exe_s, reopen
    );
    let full = format!("/S /C \"{}\"", inner);
    crate::dbg_log_write(&format!("updater: launching installer: cmd {}", full));

    std::process::Command::new("cmd")
        .raw_arg(&full)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parse() {
        assert_eq!(parse_semver("0.15.0"), (0, 15, 0));
        assert_eq!(parse_semver("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_semver("0.16"), (0, 16, 0));
        assert_eq!(parse_semver("10.0.99"), (10, 0, 99));
        assert_eq!(parse_semver("0.16.0-rc1"), (0, 16, 0));
        assert_eq!(parse_semver("garbage"), (0, 0, 0));
        assert_eq!(parse_semver("  0.15.0  "), (0, 15, 0));
    }

    #[test]
    fn newer_comparisons() {
        assert!(is_newer("0.16.0", "0.15.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(is_newer("0.15.1", "0.15.0"));
        assert!(!is_newer("0.15.0", "0.15.0")); // equal ⇒ not newer
        assert!(!is_newer("0.15.0", "0.16.0")); // older ⇒ not newer
        assert!(!is_newer("garbage", "0.15.0")); // unparseable ⇒ (0,0,0) ⇒ not newer
    }

    #[test]
    fn config_gate() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("update.json");

        // enabled + explicit fields (with an unknown `_readme` note key, as the
        // shipped update.json files carry — must be ignored, not rejected).
        std::fs::write(
            &cfg_path,
            br#"{"_readme":"note","enabled":true,"source":"\\\\srv\\share","manifest":"m.json","timeoutMs":1000}"#,
        )
        .unwrap();
        let c = load_config(dir.path(), dir.path()).expect("enabled config should load");
        assert!(c.enabled);
        assert_eq!(c.source, r"\\srv\share");
        assert_eq!(c.manifest, "m.json");
        assert_eq!(c.timeout_ms, 1000);

        // enabled but empty source ⇒ off
        std::fs::write(&cfg_path, br#"{"enabled":true,"source":"  "}"#).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());

        // disabled ⇒ off
        std::fs::write(&cfg_path, br#"{"enabled":false,"source":"x"}"#).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());

        // absent ⇒ off (the common, offline case)
        std::fs::remove_file(&cfg_path).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());
    }

    #[test]
    fn detect_and_prefetch() {
        let share = tempfile::tempdir().unwrap();
        let setup_name = "dummy-mdp-test-setup.exe";
        std::fs::write(share.path().join(setup_name), b"MZ dummy installer").unwrap();
        std::fs::write(
            share.path().join("latest.json"),
            format!(r#"{{"version":"9.9.9","setup":"{}","notes":"t"}}"#, setup_name),
        )
        .unwrap();

        let cfg = UpdateConfig {
            enabled: true,
            source: share.path().to_string_lossy().to_string(),
            manifest: "latest.json".to_string(),
            timeout_ms: 2000,
        };

        // Newer version advertised ⇒ Some, installer prefetched to temp.
        let r = check_and_prepare(&cfg, "0.15.0").expect("update should be detected");
        assert_eq!(r.version, "9.9.9");
        assert_eq!(r.notes, "t");
        assert!(r.setup_temp.exists(), "installer should be prefetched");
        let _ = std::fs::remove_file(&r.setup_temp);

        // Same or older current version ⇒ None.
        assert!(check_and_prepare(&cfg, "9.9.9").is_none());
        assert!(check_and_prepare(&cfg, "10.0.0").is_none());
    }

    #[test]
    fn unreachable_source_is_silent() {
        let cfg = UpdateConfig {
            enabled: true,
            source: r"\\NO-SUCH-HOST-xyz\share".to_string(),
            manifest: "latest.json".to_string(),
            timeout_ms: 500,
        };
        // Unreachable share ⇒ None (never panics, never blocks past the timeout).
        assert!(check_and_prepare(&cfg, "0.15.0").is_none());
    }
}

//! Optional, opt-in auto-update over an internal (UNC) file share. Windows-only.
//!
//! **Dormant by default.** If no `update.json` config file is present next to
//! the exe (preferred) or under `assets/`, none of this runs and the app makes
//! no network access whatsoever — the offline-first guarantee is preserved.
//!
//! A distributor's package overlays `assets/update.json` to enable the
//! feature, pointing `source` at an internal file share.
//!
//! **Content first.** None of this runs at startup. `main()` only kicks off the
//! worker once the preview reports its initial render (`renderdone:`), with a
//! watchdog timer as a floor — so share I/O can never compete with webview
//! creation or the `app://` asset reads for the document the user wants to see.
//!
//! The check is then **two-phase**, so the banner is not gated behind a
//! multi-MB download: [`check_manifest`] does one timed manifest read plus a
//! semver compare and hands back an [`UpdateFound`] that is *immediately*
//! installable (its path points at the share), and only afterwards does
//! [`prefetch_installer`] copy the installer into a temp dir so a later
//! "Install now" is instant. On acceptance the app launches the installer
//! silently and relaunches itself; the stable Inno AppId makes it an in-place
//! upgrade.
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
    /// `"MdPreviewer-Setup-0.16.0.exe"`.
    setup: String,
    /// Optional short note shown in the update banner.
    #[serde(default)]
    notes: String,
}

/// The installer for a confirmed-newer update, ready to run *now*.
///
/// Deliberately just the path: the version and notes the banner displays live
/// on [`UpdateFound`], and the two consumers here — the `update:install` IPC
/// and the exit-time path — only ever launch the file. `setup_temp` points at
/// the local prefetch once [`prefetch_installer`] has upgraded it, and at the
/// share before that (or if the prefetch failed), which is why it is always
/// launchable regardless of how far the download has got.
#[derive(Debug, Clone)]
pub struct UpdateReady {
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

/// A newer version confirmed on the share, *before* its installer has been
/// fetched. This is the phase-1 result: cheap enough (one timed manifest read
/// plus a semver compare) that the banner can go up straight away.
#[derive(Debug, Clone)]
pub struct UpdateFound {
    pub version: String,
    pub notes: String,
    /// The installer as published on the share: `<source>/<manifest.setup>`.
    pub setup_src: PathBuf,
}

impl UpdateFound {
    /// The handle to publish *before* the prefetch runs.
    ///
    /// `setup_temp` deliberately points at the **share**: both `update:install`
    /// and the exit-time path already accept that (it has always been the
    /// prefetch-failure fallback), so a click that lands mid-download is merely
    /// slower, never broken.
    pub fn as_ready(&self) -> UpdateReady {
        UpdateReady {
            setup_temp: self.setup_src.clone(),
        }
    }
}

/// Where a share-side installer is cached locally: `%TEMP%\mdp-update\<name>`.
///
/// Split out so the name derivation is unit-testable without touching a share.
/// A `setup` carrying directory components keeps only its final component.
fn installer_temp_path(setup_src: &Path) -> PathBuf {
    let name = setup_src
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("MdPreviewer-Setup.exe"));
    std::env::temp_dir().join("mdp-update").join(name)
}

/// **Phase 1.** Read `<source>/<manifest>` under `cfg.timeout_ms`, parse it, and
/// semver-compare against `current_version`. Returns `Some` only when the share
/// advertises something strictly newer.
///
/// **Performs no copy** — the multi-MB download is [`prefetch_installer`]'s job,
/// deliberately kept out of this call so the UI can be notified first. Returns
/// `None` (silently, logging only) on an unreachable share, a timeout, bad JSON,
/// or when we are already up to date.
///
/// Runs on a background thread; performs blocking filesystem I/O on `source`.
pub fn check_manifest(cfg: &UpdateConfig, current_version: &str) -> Option<UpdateFound> {
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

    Some(UpdateFound {
        version: manifest.version,
        notes: manifest.notes,
        setup_src: source.join(&manifest.setup),
    })
}

/// **Phase 2.** Copy the installer from the share into `%TEMP%\mdp-update\` so
/// "Install now" is instant. Returns the local path on success; `None` on any
/// failure, in which case the caller simply keeps the share path it already
/// published and the install still works, straight from the share.
///
/// The copy goes to a `.part` file and is then `rename`d into place. Several
/// instances of the app can be running against the same temp directory, and
/// because the caller now publishes an installable handle *before* this runs,
/// instance B could otherwise observe the path of a file instance A is still
/// writing. `fs::rename` replaces atomically on Windows, so the published name
/// only ever refers to a complete file.
///
/// Runs on a background thread; performs blocking filesystem I/O on `source`.
pub fn prefetch_installer(found: &UpdateFound) -> Option<PathBuf> {
    let setup_temp = installer_temp_path(&found.setup_src);
    if let Some(parent) = setup_temp.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let part = setup_temp.with_extension("part");

    match std::fs::copy(&found.setup_src, &part) {
        Ok(n) => match std::fs::rename(&part, &setup_temp) {
            Ok(()) => {
                crate::dbg_log_write(&format!(
                    "updater: prefetched {} bytes to {:?}",
                    n, setup_temp
                ));
                Some(setup_temp)
            }
            Err(e) => {
                crate::dbg_log_write(&format!(
                    "updater: prefetch rename failed ({}); will run from share {:?}",
                    e, found.setup_src
                ));
                let _ = std::fs::remove_file(&part);
                None
            }
        },
        Err(e) => {
            crate::dbg_log_write(&format!(
                "updater: prefetch failed ({}); will run from share {:?}",
                e, found.setup_src
            ));
            let _ = std::fs::remove_file(&part);
            None
        }
    }
}

/// Build the `cmd /S /C "…"` argument string that runs the installer.
///
/// Pure string work, so it is unit-tested and not `#[cfg(windows)]`-gated.
/// The command always (1) waits ~1s — `ping` is a console-independent delay
/// (`timeout` needs a real console and fails when detached) — so this process
/// fully exits and releases its own exe's file lock, then (2) runs the Inno
/// installer with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`. When `relaunch`
/// is `Some((exe, open_file))` it additionally (3) `start`s the new exe,
/// optionally reopening `open_file`; with `None` the chain stops after the
/// install, which is what the "終了後に更新" path wants (the user quit on
/// purpose, so nothing is reopened).
///
/// `cmd /S /C "…"` strips only the outer quotes, so the internal quotes around
/// each path are preserved verbatim.
fn installer_cmd_line(setup: &Path, relaunch: Option<(&Path, Option<&Path>)>) -> String {
    // Strip stray quotes from paths (paths shouldn't contain `"`; belt-and-braces).
    let setup_s = setup.to_string_lossy().replace('"', "");
    let tail = match relaunch {
        Some((exe, open_file)) => {
            let exe_s = exe.to_string_lossy().replace('"', "");
            let reopen = match open_file {
                Some(p) => format!(" \"{}\"", p.to_string_lossy().replace('"', "")),
                None => String::new(),
            };
            format!(" & start \"\" \"{}\"{}", exe_s, reopen)
        }
        None => String::new(),
    };

    let inner = format!(
        "ping -n 2 127.0.0.1 >nul & \"{}\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART{}",
        setup_s, tail
    );
    format!("/S /C \"{}\"", inner)
}

/// Launch the (per-user, no-UAC) installer silently for an in-place upgrade.
///
/// Spawns the detached `cmd` built by [`installer_cmd_line`]; see there for the
/// meaning of `relaunch`. The caller should request app exit right after this
/// returns — and when called from the exit path itself, it must be called
/// **synchronously**, since a detached worker thread can be killed before its
/// `spawn()` completes.
#[cfg(windows)]
pub fn launch_installer(
    setup: &Path,
    relaunch: Option<(&Path, Option<&Path>)>,
) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let full = installer_cmd_line(setup, relaunch);
    crate::dbg_log_write(&format!("updater: launching installer: cmd {}", full));

    std::process::Command::new("cmd")
        .raw_arg(&full)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(())
}

/// Install, then relaunch the freshly-installed exe — optionally reopening
/// `open_file`. Thin wrapper over [`launch_installer`] ("今すぐ更新" path).
#[cfg(windows)]
pub fn launch_installer_and_relaunch(
    setup: &Path,
    exe: &Path,
    open_file: Option<&Path>,
) -> std::io::Result<()> {
    launch_installer(setup, Some((exe, open_file)))
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

    /// Build a fake "share" (a temp dir) holding a manifest + a dummy installer.
    fn fake_share() -> (tempfile::TempDir, UpdateConfig, &'static str) {
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
        (share, cfg, setup_name)
    }

    #[test]
    fn phase1_detects_without_downloading() {
        let (share, cfg, setup_name) = fake_share();

        let found = check_manifest(&cfg, "0.15.0").expect("update should be detected");
        assert_eq!(found.version, "9.9.9");
        assert_eq!(found.notes, "t");

        // The whole point of the split: phase 1 points at the SHARE and has
        // copied nothing, so the banner is never gated behind a download.
        assert_eq!(found.setup_src, share.path().join(setup_name));
        let temp = installer_temp_path(&found.setup_src);
        let _ = std::fs::remove_file(&temp); // a previous run may have left one
        assert!(!temp.exists(), "phase 1 must not prefetch");

        // …and the handle published before the prefetch is directly installable.
        assert_eq!(found.as_ready().setup_temp, found.setup_src);

        // Same or older current version ⇒ None.
        assert!(check_manifest(&cfg, "9.9.9").is_none());
        assert!(check_manifest(&cfg, "10.0.0").is_none());
    }

    #[test]
    fn phase2_prefetch_upgrades_to_temp() {
        let (_share, cfg, _) = fake_share();
        let found = check_manifest(&cfg, "0.15.0").unwrap();

        let temp = prefetch_installer(&found).expect("prefetch should succeed");
        assert!(temp.exists());
        assert_eq!(std::fs::read(&temp).unwrap(), b"MZ dummy installer");
        // The `.part` staging file must not survive a successful rename.
        assert!(!temp.with_extension("part").exists());
        let _ = std::fs::remove_file(&temp);
    }

    #[test]
    fn phase2_failure_is_soft() {
        // The manifest advertises an installer that is not on the share: phase 1
        // still succeeds (so the banner shows and "install from share" is
        // offered), and only phase 2 reports failure.
        let share = tempfile::tempdir().unwrap();
        std::fs::write(
            share.path().join("latest.json"),
            r#"{"version":"9.9.9","setup":"absent-mdp-test-setup.exe","notes":""}"#,
        )
        .unwrap();
        let cfg = UpdateConfig {
            enabled: true,
            source: share.path().to_string_lossy().to_string(),
            manifest: "latest.json".to_string(),
            timeout_ms: 2000,
        };

        let found = check_manifest(&cfg, "0.15.0").expect("phase 1 should still succeed");
        assert!(prefetch_installer(&found).is_none());
        assert!(!installer_temp_path(&found.setup_src)
            .with_extension("part")
            .exists());
    }

    #[test]
    fn installer_temp_path_uses_file_name_only() {
        let p = installer_temp_path(Path::new(r"\\srv\share\rel\dir\Setup-1.2.3.exe"));
        assert_eq!(p.file_name().unwrap(), "Setup-1.2.3.exe");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "mdp-update");
        assert!(p.starts_with(std::env::temp_dir()));
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
        assert!(check_manifest(&cfg, "0.15.0").is_none());
    }

    // ---- installer_cmd_line ------------------------------------------------
    // Both paths must keep the ~1s `ping` delay (the exe lock is still held for
    // a moment after exit) and the silent-install switches; they differ only in
    // whether the freshly-installed exe is started afterwards.

    #[test]
    fn installer_cmd_line_relaunches() {
        let cmd = installer_cmd_line(
            Path::new(r"C:\Temp\mdp-update\Setup.exe"),
            Some((Path::new(r"C:\Apps\md-previewer.exe"), None)),
        );
        assert!(cmd.starts_with(r#"/S /C "ping -n 2 127.0.0.1 >nul & "#), "{}", cmd);
        assert!(cmd.contains("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"), "{}", cmd);
        assert!(cmd.contains(r#"& start "" "C:\Apps\md-previewer.exe""#), "{}", cmd);
        assert!(cmd.ends_with('"'), "{}", cmd);
    }

    #[test]
    fn installer_cmd_line_reopens_file() {
        let cmd = installer_cmd_line(
            Path::new(r"C:\Temp\Setup.exe"),
            Some((
                Path::new(r"C:\Apps\md-previewer.exe"),
                Some(Path::new(r"C:\Docs\メモ.md")),
            )),
        );
        assert!(
            cmd.contains(r#"start "" "C:\Apps\md-previewer.exe" "C:\Docs\メモ.md""#),
            "{}",
            cmd
        );
    }

    #[test]
    fn installer_cmd_line_without_relaunch_stops_after_install() {
        let cmd = installer_cmd_line(Path::new(r"C:\Temp\Setup.exe"), None);
        assert!(cmd.contains("ping -n 2 127.0.0.1 >nul"), "{}", cmd);
        assert!(cmd.contains("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"), "{}", cmd);
        // The whole point of the "終了後に更新" path: no relaunch.
        assert!(!cmd.contains("start"), "{}", cmd);
        assert_eq!(
            cmd,
            r#"/S /C "ping -n 2 127.0.0.1 >nul & "C:\Temp\Setup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART""#
        );
    }

    #[test]
    fn installer_cmd_line_strips_stray_quotes() {
        let cmd = installer_cmd_line(Path::new(r#"C:\Te"mp\Setup.exe"#), None);
        assert!(cmd.contains(r#""C:\Temp\Setup.exe""#), "{}", cmd);
    }
}

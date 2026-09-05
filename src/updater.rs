//! Startup update check + background install. Windows-only.
//!
//! Two **providers** share one flow — check, notify, download, silent install,
//! relaunch — and differ only in where the new version comes from:
//!
//! * **`github`** (the default) — the public GitHub Releases feed for this
//!   repository, read over HTTPS via [`crate::http_win`] (WinHTTP, so no HTTP
//!   crate and no TLS to manage; the OS supplies the certificate store and the
//!   corporate proxy).
//! * **`share`** — a directory on an internal file share (UNC `\\server\...`
//!   or local), read with plain `std::fs`. This is what an organisation
//!   overlays when updates must never leave the intranet.
//!
//! `assets/update.json` ships with the app and selects `github`. Deleting it,
//! or setting `enabled:false`, turns the whole feature off. **The offline-first
//! guarantee is about *viewing* a document** — rendering pulls nothing from the
//! network — and the update check is deliberately outside it.
//!
//! **Content first.** None of this runs at startup. `main()` only kicks off the
//! worker once the preview reports its initial render (`renderdone:`), with a
//! watchdog timer as a floor — so update I/O can never compete with webview
//! creation or the `app://` asset reads for the document the user wants to see.
//!
//! The check is then **two-phase**, so the banner is not gated behind a
//! multi-MB download: [`check_manifest`] does one timed read plus a semver
//! compare and hands back an [`UpdateFound`], and only afterwards does
//! [`prefetch_installer`] fetch the installer into a temp dir. On acceptance the
//! app launches the installer silently and relaunches itself; the stable Inno
//! AppId makes it an in-place upgrade.
//!
//! ⚠ The two providers differ in one visible way: a share path is launchable
//! *before* the copy finishes, so [`UpdateFound::as_ready`] returns `Some` right
//! away, whereas a GitHub asset does not exist locally until it is downloaded
//! and `as_ready()` is therefore `None`. `src/main.rs` covers that gap with its
//! `install_when_ready` reservation — see `.claude/docs/auto-update.md`.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// The repository whose Releases feed the default configuration reads.
pub const DEFAULT_GITHUB_REPO: &str = "yvvakimoto/md_previewer";

/// Cap on the release JSON. A sanity bound, not a real limit (the payload is a
/// few KB); it exists so a wrong URL cannot stream forever into memory.
const MANIFEST_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Cap on the installer download. The real artifact is ~8 MB.
const INSTALLER_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Longest a release note may be after summarising, in chars. The banner is a
/// single small card, not a changelog viewer.
const NOTES_MAX_CHARS: usize = 160;

/// Where the update comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// A directory on a file share (UNC or local).
    Share,
    /// This repository's GitHub Releases feed.
    GitHub,
}

/// Contents of `update.json`. Absent / `enabled:false` ⇒ feature off.
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateConfig {
    #[serde(default)]
    pub enabled: bool,
    /// `"github"` or `"share"`. Empty ⇒ inferred, see [`resolve_provider`].
    #[serde(default)]
    pub provider: String,
    /// **share:** directory (UNC or local) holding the manifest + installer exe.
    #[serde(default)]
    pub source: String,
    /// **share:** manifest filename within `source`. Defaults to `latest.json`.
    #[serde(default = "default_manifest")]
    pub manifest: String,
    /// **github:** `owner/repo`. A full `https://github.com/owner/repo` URL is
    /// accepted too and normalised away.
    #[serde(default = "default_repo")]
    pub repo: String,
    /// Timeout for the check, in ms. An unreachable UNC share can otherwise
    /// block an SMB read for tens of seconds, and a black-holed TCP connect is
    /// no better. `None` ⇒ the per-provider default (see
    /// [`effective_timeout_ms`]); HTTPS gets the longer one because it pays for
    /// DNS plus a TLS handshake before any byte of the answer.
    #[serde(rename = "timeoutMs", default)]
    pub timeout_ms: Option<u64>,
    /// **github:** don't contact the API again within this many minutes.
    /// See [`should_check`] for why this is not optional in practice.
    #[serde(rename = "minCheckIntervalMinutes", default = "default_min_interval")]
    pub min_check_interval_minutes: u64,
}

fn default_manifest() -> String {
    "latest.json".to_string()
}
fn default_repo() -> String {
    DEFAULT_GITHUB_REPO.to_string()
}
fn default_min_interval() -> u64 {
    360 // 6 hours
}

/// The timeout actually used, resolving the per-provider default.
pub fn effective_timeout_ms(cfg: &UpdateConfig) -> u64 {
    cfg.timeout_ms.unwrap_or(match resolve_provider(cfg) {
        Provider::Share => 4_000,
        Provider::GitHub => 8_000,
    })
}

/// Which provider a config selects.
///
/// ⚠ The inference branch is a **backward-compatibility guarantee**, not a
/// convenience: `update.json` files already deployed inside organisations
/// predate `provider` and carry only `source`. Those must keep reading their
/// share, so a non-empty `source` with no explicit `provider` means `share`.
/// Everything else — including a bare `{"enabled":true}` — means `github`.
pub fn resolve_provider(cfg: &UpdateConfig) -> Provider {
    match cfg.provider.trim().to_ascii_lowercase().as_str() {
        "" => {
            if cfg.source.trim().is_empty() {
                Provider::GitHub
            } else {
                Provider::Share
            }
        }
        "github" | "gh" => Provider::GitHub,
        "share" | "file" | "unc" => Provider::Share,
        other => {
            crate::dbg_log_write(&format!(
                "updater: unknown provider {:?}; inferring from `source`",
                other
            ));
            if cfg.source.trim().is_empty() {
                Provider::GitHub
            } else {
                Provider::Share
            }
        }
    }
}

/// Version manifest published on a **share** (`source/<manifest>`).
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

/// The subset of GitHub's release payload we consume.
#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    browser_download_url: String,
}

/// The installer for a confirmed-newer update, ready to run *now*.
///
/// Deliberately just the path: the version and notes the banner displays live
/// on [`UpdateFound`], and the two consumers here — the `update:install` IPC
/// and the exit-time path — only ever launch the file.
#[derive(Debug, Clone)]
pub struct UpdateReady {
    pub setup_temp: PathBuf,
}

/// Where a confirmed update's installer lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupSource {
    /// Already reachable as a file: `<source>/<manifest.setup>` on the share.
    SharePath(PathBuf),
    /// Reachable only over HTTPS; must be downloaded before it can be run.
    HttpUrl {
        url: String,
        file_name: String,
        /// Expected byte count, from the release metadata. `0` ⇒ unknown.
        size: u64,
    },
}

/// A newer version confirmed upstream, *before* its installer has been fetched.
/// This is the phase-1 result: cheap enough (one timed read plus a semver
/// compare) that the banner can go up straight away.
#[derive(Debug, Clone)]
pub struct UpdateFound {
    pub version: String,
    pub notes: String,
    pub setup: SetupSource,
}

impl UpdateFound {
    /// The handle to publish *before* the prefetch runs — `None` when there is
    /// nothing launchable yet.
    ///
    /// For a **share** this is `Some` pointing at the share itself: both
    /// `update:install` and the exit-time path already accept that (it has
    /// always been the prefetch-failure fallback), so a click that lands
    /// mid-copy is merely slower, never broken.
    ///
    /// ⚠ For **GitHub** it is `None` — an `https://` asset simply is not a file
    /// yet. The banner still appears immediately (that is the whole point of
    /// the two-phase split), but a click before the download finishes has
    /// nothing to launch, which `src/main.rs` handles by reserving the install
    /// until the prefetch publishes a path.
    pub fn as_ready(&self) -> Option<UpdateReady> {
        match &self.setup {
            SetupSource::SharePath(p) => Some(UpdateReady {
                setup_temp: p.clone(),
            }),
            SetupSource::HttpUrl { .. } => None,
        }
    }
}

/// Read `update.json` from `exe_dir` (preferred) or `assets_dir`. Returns `None`
/// when the file is absent, disabled, malformed, or missing the field its
/// provider needs.
pub fn load_config(exe_dir: &Path, assets_dir: &Path) -> Option<UpdateConfig> {
    let candidates = [exe_dir.join("update.json"), assets_dir.join("update.json")];
    for path in candidates.iter() {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue, // not this location; try the next
        };
        match serde_json::from_slice::<UpdateConfig>(&bytes) {
            Ok(cfg) => {
                if !cfg.enabled {
                    crate::dbg_log_write(&format!("updater: config at {:?} disabled", path));
                    return None;
                }
                // Each provider has one field it cannot work without.
                let ok = match resolve_provider(&cfg) {
                    Provider::Share => !cfg.source.trim().is_empty(),
                    Provider::GitHub => !cfg.repo.trim().is_empty(),
                };
                if !ok {
                    crate::dbg_log_write(&format!("updater: config at {:?} incomplete", path));
                    return None;
                }
                match resolve_provider(&cfg) {
                    Provider::Share => crate::dbg_log_write(&format!(
                        "updater: enabled via {:?} (provider=share, source={}, manifest={})",
                        path, cfg.source, cfg.manifest
                    )),
                    Provider::GitHub => crate::dbg_log_write(&format!(
                        "updater: enabled via {:?} (provider=github, repo={})",
                        path, cfg.repo
                    )),
                }
                return Some(cfg);
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

/// Run blocking work with a wall-clock ceiling.
///
/// The work runs on a helper thread; past `timeout_ms` we give up and let the
/// orphan finish or die on its own (it holds nothing else up). This is the
/// outer guard for *both* providers: an unreachable UNC share hangs on the SMB
/// timeout, and a black-holed TCP connect hangs on WinHTTP's own per-phase
/// timeouts, which do not compose into a single request-level bound.
fn run_with_timeout<T, F>(timeout_ms: u64, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_millis(timeout_ms))
        .ok()
}

/// Read a file with a wall-clock timeout. Returns `None` on any read error too.
fn read_with_timeout(path: &Path, timeout_ms: u64) -> Option<Vec<u8>> {
    let p = path.to_path_buf();
    match run_with_timeout(timeout_ms, move || std::fs::read(&p)) {
        Some(Ok(bytes)) => Some(bytes),
        Some(Err(e)) => {
            crate::dbg_log_write(&format!("updater: manifest read failed {:?}: {}", path, e));
            None
        }
        None => {
            crate::dbg_log_write(&format!(
                "updater: manifest read timed out after {}ms ({:?})",
                timeout_ms, path
            ));
            None
        }
    }
}

/// Where a fetched installer is cached locally: `%TEMP%\mdp-update\<name>`.
///
/// Split out so the name derivation is unit-testable without touching a share
/// or the network. A name carrying directory components keeps only its final
/// component — it comes from a remote manifest, so it must not be able to
/// steer the write anywhere else.
fn installer_temp_path_for_name(name: &str) -> PathBuf {
    let leaf = Path::new(name)
        .file_name()
        .map(|n| n.to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| std::ffi::OsString::from("MdPreviewer-Setup.exe"));
    std::env::temp_dir().join("mdp-update").join(leaf)
}

fn installer_temp_path(setup_src: &Path) -> PathBuf {
    installer_temp_path_for_name(&setup_src.to_string_lossy())
}

// ---------------------------------------------------------------------------
// Phase 1 — detect
// ---------------------------------------------------------------------------

/// **Phase 1.** Ask the configured provider what the latest version is and
/// semver-compare it against `current_version`. Returns `Some` only when
/// something strictly newer is on offer.
///
/// **Performs no download** — that is [`prefetch_installer`]'s job, deliberately
/// kept out of this call so the UI can be notified first. Returns `None`
/// (silently, logging only) on an unreachable source, a timeout, bad data, or
/// when we are already up to date.
///
/// Runs on a background thread; performs blocking I/O.
pub fn check_manifest(cfg: &UpdateConfig, current_version: &str) -> Option<UpdateFound> {
    match resolve_provider(cfg) {
        Provider::Share => check_share_manifest(cfg, current_version),
        Provider::GitHub => check_github_release(cfg, current_version),
    }
}

/// Phase 1 for `provider: "share"` — read `<source>/<manifest>` and compare.
fn check_share_manifest(cfg: &UpdateConfig, current_version: &str) -> Option<UpdateFound> {
    let source = Path::new(&cfg.source);
    let manifest_path = source.join(&cfg.manifest);

    let bytes = read_with_timeout(&manifest_path, effective_timeout_ms(cfg))?;
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
        setup: SetupSource::SharePath(source.join(&manifest.setup)),
    })
}

/// Normalise `repo` into the `releases/latest` API URL.
///
/// Accepts `owner/repo` and the browser URL people actually copy
/// (`https://github.com/owner/repo`, with or without a trailing `/` or `.git`).
pub fn github_api_url(repo: &str) -> String {
    let mut s = repo.trim().trim_end_matches('/');
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
        "github.com/",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    let s = s.trim_end_matches(".git").trim_matches('/');
    format!("https://api.github.com/repos/{}/releases/latest", s)
}

/// The stamp recording when the GitHub API was last contacted.
fn check_stamp_path() -> PathBuf {
    std::env::temp_dir().join("mdp-update").join("last-check")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether enough time has passed since the last check.
///
/// ⚠ This throttle is **not** a nicety. Unauthenticated GitHub API requests are
/// limited to **60 per hour per IP**, and a whole office sits behind one NAT
/// address: without it, an organisation of any size burns the budget and every
/// further check returns 403 — i.e. update notifications stop appearing, with
/// nothing to distinguish that from "you are up to date".
///
/// Permissive at the edges on purpose: no stamp, a zero interval, or a clock
/// that has gone backwards all mean "check". Being locked out by a bad stamp
/// would be worse than one extra request.
pub fn should_check(now: u64, last: u64, interval_minutes: u64) -> bool {
    if interval_minutes == 0 || last == 0 || now < last {
        return true;
    }
    now - last >= interval_minutes.saturating_mul(60)
}

fn read_check_stamp(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

fn write_check_stamp(path: &Path, now: u64) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, now.to_string());
}

/// Phase 1 for `provider: "github"` — read the Releases feed and compare.
#[cfg(windows)]
fn check_github_release(cfg: &UpdateConfig, current_version: &str) -> Option<UpdateFound> {
    let stamp = check_stamp_path();
    let now = unix_now();
    let last = read_check_stamp(&stamp);
    if !should_check(now, last, cfg.min_check_interval_minutes) {
        crate::dbg_log_write(&format!(
            "updater: skipped, checked {}s ago (minCheckIntervalMinutes={})",
            now.saturating_sub(last),
            cfg.min_check_interval_minutes
        ));
        return None;
    }

    let url = github_api_url(&cfg.repo);
    let timeout = effective_timeout_ms(cfg);
    let u = url.clone();
    let fetched = run_with_timeout(timeout, move || {
        crate::http_win::get(&u, "application/vnd.github+json", timeout, MANIFEST_MAX_BYTES)
    });

    // Stamp the attempt regardless of how it went. A 403 is exactly the case
    // the throttle protects against, and a transport failure means the machine
    // is offline — where retrying every launch buys nothing and only repeats
    // the timeout. The cost is that connectivity returning mid-interval is
    // noticed up to `minCheckIntervalMinutes` late, which is acceptable for a
    // background notification.
    write_check_stamp(&stamp, now);

    let bytes = match fetched {
        Some(Ok(b)) => b,
        Some(Err(e)) => {
            crate::dbg_log_write(&format!("updater: github check failed ({}): {}", url, e));
            return None;
        }
        None => {
            crate::dbg_log_write(&format!(
                "updater: github check timed out after {}ms ({})",
                timeout, url
            ));
            return None;
        }
    };
    parse_github_release(&bytes, current_version)
}

#[cfg(not(windows))]
fn check_github_release(_cfg: &UpdateConfig, _current_version: &str) -> Option<UpdateFound> {
    None // no HTTP transport off Windows; the app is Windows-only anyway
}

/// Turn a GitHub release payload into an [`UpdateFound`], or `None`.
///
/// Pure: no I/O, so the whole GitHub branch's decision-making is unit-testable
/// against a captured payload.
fn parse_github_release(json: &[u8], current_version: &str) -> Option<UpdateFound> {
    let rel: GithubRelease = match serde_json::from_slice(json) {
        Ok(r) => r,
        Err(e) => {
            crate::dbg_log_write(&format!("updater: github release parse failed: {}", e));
            return None;
        }
    };
    // `/releases/latest` already excludes these; belt-and-braces for a config
    // that ever points somewhere else.
    if rel.draft || rel.prerelease {
        crate::dbg_log_write("updater: latest release is a draft/prerelease; ignoring");
        return None;
    }

    let tag = if rel.tag_name.trim().is_empty() {
        rel.name.trim()
    } else {
        rel.tag_name.trim()
    };
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    if version.is_empty() {
        crate::dbg_log_write("updater: github release has no tag");
        return None;
    }

    if !is_newer(&version, current_version) {
        crate::dbg_log_write(&format!(
            "updater: up to date (latest={}, current={})",
            version, current_version
        ));
        return None;
    }

    let asset = match pick_setup_asset(&rel.assets) {
        Some(a) => a,
        None => {
            crate::dbg_log_write(&format!(
                "updater: release {} carries no installer asset",
                version
            ));
            return None;
        }
    };
    crate::dbg_log_write(&format!(
        "updater: update available {} -> {} ({}, {} bytes)",
        current_version, version, asset.name, asset.size
    ));

    Some(UpdateFound {
        version,
        notes: summarize_notes(&rel.body),
        setup: SetupSource::HttpUrl {
            url: asset.browser_download_url.clone(),
            file_name: asset.name.clone(),
            size: asset.size,
        },
    })
}

/// Pick the installer out of a release's assets.
///
/// Prefers the name `build-installer.ps1` produces; falls back to any `.exe` so
/// a rename upstream degrades into "still works" rather than "silently stops
/// offering updates".
fn pick_setup_asset(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    let is_exe = |a: &&GithubAsset| a.name.to_ascii_lowercase().ends_with(".exe");
    assets
        .iter()
        .find(|a| {
            let n = a.name.to_ascii_lowercase();
            n.starts_with("mdpreviewer-setup-") && n.ends_with(".exe")
        })
        .or_else(|| assets.iter().find(is_exe))
        .filter(|a| !a.browser_download_url.trim().is_empty())
}

/// Squash a Markdown release body into one line for the banner card.
///
/// The body is the `HISTORY.md` section verbatim — headings, bullets, bold and
/// inline code. The banner is a small fixed-width card, so this takes the first
/// real sentence-ish worth of text, drops the markers that would otherwise show
/// up literally, and truncates on a **char** boundary (the notes are Japanese;
/// slicing by byte would panic).
fn summarize_notes(body: &str) -> String {
    let mut out = String::new();
    for raw in body.lines() {
        let mut line = raw.trim();
        // Strip a leading list marker or heading.
        for m in ["- ", "* ", "+ ", "#### ", "### ", "## ", "# "] {
            if let Some(rest) = line.strip_prefix(m) {
                line = rest.trim_start();
                break;
            }
        }
        let line = line.replace("**", "").replace("__", "").replace('`', "");
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
        if out.chars().count() >= NOTES_MAX_CHARS {
            break;
        }
    }
    if out.chars().count() > NOTES_MAX_CHARS {
        out = out.chars().take(NOTES_MAX_CHARS).collect::<String>();
        out.push('…');
    }
    out
}

// ---------------------------------------------------------------------------
// Phase 2 — fetch
// ---------------------------------------------------------------------------

/// **Phase 2.** Bring the installer to `%TEMP%\mdp-update\` so "Install now" is
/// instant. Returns the local path on success.
///
/// Failure is soft and provider-dependent: for a **share** the caller simply
/// keeps the share path it already published and the install still works
/// straight from the share; for **GitHub** there is no fallback, so the caller
/// must surface the failure (see `main.rs`'s `UpdateInstallFailed`).
///
/// The transfer goes to a `.part` file and is then `rename`d into place.
/// Several instances of the app can be running against the same temp directory,
/// and because the caller publishes a handle *before* this runs, instance B
/// could otherwise observe the path of a file instance A is still writing.
/// `fs::rename` replaces atomically on Windows, so the published name only ever
/// refers to a complete file.
///
/// Runs on a background thread and is deliberately **untimed** — a multi-MB
/// transfer over a slow link is allowed to take as long as it takes.
pub fn prefetch_installer(found: &UpdateFound) -> Option<PathBuf> {
    match &found.setup {
        SetupSource::SharePath(src) => prefetch_from_share(src),
        SetupSource::HttpUrl {
            url,
            file_name,
            size,
        } => prefetch_from_http(url, file_name, *size),
    }
}

fn prefetch_from_share(src: &Path) -> Option<PathBuf> {
    let setup_temp = installer_temp_path(src);
    let part = stage_path(&setup_temp)?;

    match std::fs::copy(src, &part) {
        Ok(n) => finish_stage(&part, &setup_temp, n),
        Err(e) => {
            crate::dbg_log_write(&format!(
                "updater: prefetch failed ({}); will run from share {:?}",
                e, src
            ));
            let _ = std::fs::remove_file(&part);
            None
        }
    }
}

#[cfg(windows)]
fn prefetch_from_http(url: &str, file_name: &str, size: u64) -> Option<PathBuf> {
    let setup_temp = installer_temp_path_for_name(file_name);
    let part = stage_path(&setup_temp)?;

    // No timeout here on purpose: this is ~8 MB, and a slow link is not a
    // failure. The per-phase WinHTTP timeouts still stop a truly dead socket.
    match crate::http_win::download(url, &part, 30_000, INSTALLER_MAX_BYTES) {
        Ok(n) => {
            // The only integrity signal GitHub gives us. It catches a truncated
            // transfer, which would otherwise reach the user as an installer
            // that fails halfway through replacing their app.
            if size > 0 && n != size {
                crate::dbg_log_write(&format!(
                    "updater: prefetch size mismatch (got {}, expected {}); discarding",
                    n, size
                ));
                let _ = std::fs::remove_file(&part);
                return None;
            }
            finish_stage(&part, &setup_temp, n)
        }
        Err(e) => {
            crate::dbg_log_write(&format!("updater: download failed ({}): {}", url, e));
            let _ = std::fs::remove_file(&part);
            None
        }
    }
}

#[cfg(not(windows))]
fn prefetch_from_http(_url: &str, _file_name: &str, _size: u64) -> Option<PathBuf> {
    None
}

/// Prepare `<temp>.part` next to the eventual destination.
fn stage_path(setup_temp: &Path) -> Option<PathBuf> {
    if let Some(parent) = setup_temp.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    Some(setup_temp.with_extension("part"))
}

/// Publish a staged file under its real name.
fn finish_stage(part: &Path, setup_temp: &Path, n: u64) -> Option<PathBuf> {
    match std::fs::rename(part, setup_temp) {
        Ok(()) => {
            crate::dbg_log_write(&format!(
                "updater: prefetched {} bytes to {:?}",
                n, setup_temp
            ));
            Some(setup_temp.to_path_buf())
        }
        Err(e) => {
            crate::dbg_log_write(&format!("updater: prefetch rename failed ({})", e));
            let _ = std::fs::remove_file(part);
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

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

    fn cfg_from(json: &str) -> UpdateConfig {
        serde_json::from_str(json).expect("test config should parse")
    }

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

    // ---- provider resolution ----------------------------------------------

    #[test]
    fn provider_resolution() {
        // Explicit wins.
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"provider":"github","source":"\\\\srv\\s"}"#)),
            Provider::GitHub
        );
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"provider":"SHARE","source":"\\\\srv\\s"}"#)),
            Provider::Share
        );
        // ⚠ Back-compat: an org's pre-`provider` config has only `source`, and
        // must keep reading its share.
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"enabled":true,"source":"\\\\srv\\s"}"#)),
            Provider::Share
        );
        // Nothing to go on ⇒ the new default.
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"enabled":true}"#)),
            Provider::GitHub
        );
        // Garbage provider falls back to inference rather than disabling.
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"provider":"ftp","source":"\\\\srv\\s"}"#)),
            Provider::Share
        );
        assert_eq!(
            resolve_provider(&cfg_from(r#"{"provider":"ftp"}"#)),
            Provider::GitHub
        );
    }

    #[test]
    fn timeout_defaults_per_provider() {
        assert_eq!(effective_timeout_ms(&cfg_from(r#"{"source":"x"}"#)), 4_000);
        assert_eq!(effective_timeout_ms(&cfg_from(r#"{}"#)), 8_000);
        // An explicit value wins for either provider.
        assert_eq!(
            effective_timeout_ms(&cfg_from(r#"{"source":"x","timeoutMs":1234}"#)),
            1_234
        );
    }

    #[test]
    fn config_gate() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("update.json");

        // enabled + explicit share fields (with an unknown `_readme` note key,
        // as the shipped update.json files carry — must be ignored, not rejected).
        std::fs::write(
            &cfg_path,
            br#"{"_readme":"note","enabled":true,"source":"\\\\srv\\share","manifest":"m.json","timeoutMs":1000}"#,
        )
        .unwrap();
        let c = load_config(dir.path(), dir.path()).expect("enabled config should load");
        assert!(c.enabled);
        assert_eq!(resolve_provider(&c), Provider::Share);
        assert_eq!(c.source, r"\\srv\share");
        assert_eq!(c.manifest, "m.json");
        assert_eq!(effective_timeout_ms(&c), 1000);

        // The shipped default: github, no source at all.
        std::fs::write(
            &cfg_path,
            br#"{"enabled":true,"provider":"github","repo":"o/r","minCheckIntervalMinutes":15}"#,
        )
        .unwrap();
        let c = load_config(dir.path(), dir.path()).expect("github config should load");
        assert_eq!(resolve_provider(&c), Provider::GitHub);
        assert_eq!(c.repo, "o/r");
        assert_eq!(c.min_check_interval_minutes, 15);

        // A github config keeps the built-in repo when it names none.
        std::fs::write(&cfg_path, br#"{"enabled":true,"provider":"github"}"#).unwrap();
        let c = load_config(dir.path(), dir.path()).unwrap();
        assert_eq!(c.repo, DEFAULT_GITHUB_REPO);

        // share + empty source ⇒ off (the field it cannot work without)
        std::fs::write(&cfg_path, br#"{"enabled":true,"provider":"share","source":"  "}"#).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());

        // disabled ⇒ off
        std::fs::write(&cfg_path, br#"{"enabled":false,"source":"x"}"#).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());

        // absent ⇒ off
        std::fs::remove_file(&cfg_path).unwrap();
        assert!(load_config(dir.path(), dir.path()).is_none());
    }

    /// The file the installer actually ships must be a valid, github-selecting,
    /// enabled config — this is what makes the feature on by default.
    #[test]
    fn shipped_update_json_selects_github() {
        let dir = tempfile::tempdir().unwrap();
        let shipped = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/update.json");
        std::fs::copy(shipped, dir.path().join("update.json")).unwrap();

        let c = load_config(dir.path(), dir.path()).expect("shipped update.json must load");
        assert!(c.enabled);
        assert_eq!(resolve_provider(&c), Provider::GitHub);
        assert_eq!(c.repo, DEFAULT_GITHUB_REPO);
    }

    // ---- github phase 1 ----------------------------------------------------

    #[test]
    fn github_api_url_normalises() {
        let want = "https://api.github.com/repos/o/r/releases/latest";
        assert_eq!(github_api_url("o/r"), want);
        assert_eq!(github_api_url("  o/r  "), want);
        assert_eq!(github_api_url("https://github.com/o/r"), want);
        assert_eq!(github_api_url("https://github.com/o/r/"), want);
        assert_eq!(github_api_url("https://github.com/o/r.git"), want);
        assert_eq!(github_api_url("github.com/o/r"), want);
    }

    /// Shaped exactly like the live payload (field names and nesting verified
    /// against `gh api repos/yvvakimoto/md_previewer/releases/latest`).
    fn release_json(tag: &str) -> String {
        format!(
            r#"{{
              "tag_name": "{tag}",
              "name": "{tag}",
              "draft": false,
              "prerelease": false,
              "body": "- **Marp のテーマが 8 色になりました** — `magenta` などが選べます。\n  - さらに `S` キーの一覧に ⚙ が付きます。",
              "assets": [
                {{"name":"THIRD_PARTY_LICENSES.txt","size":12,"browser_download_url":"https://example.com/l.txt"}},
                {{"name":"MdPreviewer-Setup-0.33.0.exe","size":7596206,
                  "browser_download_url":"https://github.com/o/r/releases/download/{tag}/MdPreviewer-Setup-0.33.0.exe"}}
              ]
            }}"#
        )
    }

    #[test]
    fn parses_a_release_into_an_update() {
        let found = parse_github_release(release_json("v0.33.0").as_bytes(), "0.15.0")
            .expect("newer release should be detected");
        assert_eq!(found.version, "0.33.0"); // the leading `v` is dropped
        assert!(found.notes.starts_with("Marp のテーマが 8 色になりました"));
        assert!(!found.notes.contains("**") && !found.notes.contains('`'));
        match &found.setup {
            SetupSource::HttpUrl {
                url,
                file_name,
                size,
            } => {
                assert!(url.ends_with("/MdPreviewer-Setup-0.33.0.exe"));
                assert_eq!(file_name, "MdPreviewer-Setup-0.33.0.exe");
                assert_eq!(*size, 7_596_206);
            }
            other => panic!("expected an HttpUrl, got {:?}", other),
        }
    }

    #[test]
    fn same_or_older_release_is_not_an_update() {
        assert!(parse_github_release(release_json("v0.33.0").as_bytes(), "0.33.0").is_none());
        assert!(parse_github_release(release_json("v0.33.0").as_bytes(), "1.0.0").is_none());
    }

    /// ⚠ The one behavioural difference from the share provider: an https asset
    /// is not a file yet, so there is nothing to launch until phase 2 lands.
    /// `main.rs`'s `install_when_ready` exists because of this.
    #[test]
    fn github_found_is_not_ready_before_download() {
        let found = parse_github_release(release_json("v0.33.0").as_bytes(), "0.1.0").unwrap();
        assert!(found.as_ready().is_none());
    }

    #[test]
    fn draft_and_prerelease_are_ignored() {
        let j = release_json("v9.9.9").replace(r#""draft": false"#, r#""draft": true"#);
        assert!(parse_github_release(j.as_bytes(), "0.1.0").is_none());
        let j = release_json("v9.9.9").replace(r#""prerelease": false"#, r#""prerelease": true"#);
        assert!(parse_github_release(j.as_bytes(), "0.1.0").is_none());
    }

    #[test]
    fn a_release_without_an_installer_is_not_an_update() {
        let j = r#"{"tag_name":"v9.9.9","draft":false,"prerelease":false,"body":"",
                    "assets":[{"name":"notes.txt","size":1,"browser_download_url":"https://x/n.txt"}]}"#;
        assert!(parse_github_release(j.as_bytes(), "0.1.0").is_none());
        // No assets at all is the same story.
        let j = r#"{"tag_name":"v9.9.9","draft":false,"prerelease":false,"body":"","assets":[]}"#;
        assert!(parse_github_release(j.as_bytes(), "0.1.0").is_none());
        // Garbage JSON must not panic.
        assert!(parse_github_release(b"not json", "0.1.0").is_none());
    }

    #[test]
    fn picks_the_installer_among_assets() {
        let mk = |n: &str| GithubAsset {
            name: n.to_string(),
            size: 1,
            browser_download_url: format!("https://x/{}", n),
        };
        // The conventional name wins even when another .exe comes first.
        let assets = vec![mk("helper.exe"), mk("MdPreviewer-Setup-1.2.3.exe")];
        assert_eq!(pick_setup_asset(&assets).unwrap().name, "MdPreviewer-Setup-1.2.3.exe");
        // Renamed upstream ⇒ fall back to any .exe rather than going silent.
        let assets = vec![mk("readme.txt"), mk("Installer.exe")];
        assert_eq!(pick_setup_asset(&assets).unwrap().name, "Installer.exe");
        // An asset with no download URL is unusable.
        let assets = vec![GithubAsset {
            name: "MdPreviewer-Setup-1.0.0.exe".into(),
            size: 1,
            browser_download_url: String::new(),
        }];
        assert!(pick_setup_asset(&assets).is_none());
    }

    #[test]
    fn summarises_release_notes() {
        assert_eq!(summarize_notes("- **Bold** and `code`"), "Bold and code");
        assert_eq!(summarize_notes("## Heading\n\n- item"), "Heading item");
        assert_eq!(summarize_notes(""), "");
        // Truncation counts CHARS, not bytes — the notes are Japanese, and a
        // byte slice would land mid-codepoint and panic.
        let long = "あ".repeat(500);
        let s = summarize_notes(&long);
        assert_eq!(s.chars().count(), NOTES_MAX_CHARS + 1); // + the ellipsis
        assert!(s.ends_with('…'));
    }

    #[test]
    fn throttle_boundaries() {
        let hour = 3_600;
        // No stamp / zero interval / clock skew ⇒ always check.
        assert!(should_check(hour, 0, 360));
        assert!(should_check(hour, hour, 0));
        assert!(should_check(hour, hour * 5, 360));
        // Inside the window ⇒ skip; at or past it ⇒ check.
        assert!(!should_check(hour + 1, hour, 60));
        assert!(should_check(hour * 2, hour, 60));
        assert!(should_check(hour * 2 + 1, hour, 60));
    }

    #[test]
    fn check_stamp_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join("last-check");
        assert_eq!(read_check_stamp(&p), 0); // absent ⇒ 0 ⇒ "check"
        write_check_stamp(&p, 1_700_000_000);
        assert_eq!(read_check_stamp(&p), 1_700_000_000);
        std::fs::write(&p, "garbage").unwrap();
        assert_eq!(read_check_stamp(&p), 0);
    }

    /// Live end-to-end: WinHTTP → GitHub API → JSON → semver. Ignored by
    /// default (needs the network): `cargo test -- --ignored github_live_check`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn github_live_check() {
        let cfg = cfg_from(r#"{"enabled":true,"provider":"github","minCheckIntervalMinutes":0}"#);
        let found = check_github_release(&cfg, "0.1.0")
            .expect("the live feed should advertise something newer than 0.1.0");
        assert!(!found.version.is_empty());
        match found.setup {
            SetupSource::HttpUrl { url, size, .. } => {
                assert!(url.starts_with("https://"), "{}", url);
                assert!(size > 1_000_000, "installer looks too small: {}", size);
            }
            other => panic!("expected an HttpUrl, got {:?}", other),
        }
    }

    // ---- share provider (unchanged behaviour) ------------------------------

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
        let cfg = cfg_from(&format!(
            r#"{{"enabled":true,"provider":"share","source":{},"manifest":"latest.json","timeoutMs":2000}}"#,
            serde_json::to_string(&share.path().to_string_lossy().to_string()).unwrap()
        ));
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
        assert_eq!(
            found.setup,
            SetupSource::SharePath(share.path().join(setup_name))
        );
        let temp = installer_temp_path_for_name(setup_name);
        let _ = std::fs::remove_file(&temp); // a previous run may have left one
        assert!(!temp.exists(), "phase 1 must not prefetch");

        // …and the handle published before the prefetch is directly installable.
        assert_eq!(
            found.as_ready().expect("a share path is launchable at once").setup_temp,
            share.path().join(setup_name)
        );

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
        let cfg = cfg_from(&format!(
            r#"{{"enabled":true,"provider":"share","source":{},"timeoutMs":2000}}"#,
            serde_json::to_string(&share.path().to_string_lossy().to_string()).unwrap()
        ));

        let found = check_manifest(&cfg, "0.15.0").expect("phase 1 should still succeed");
        assert!(prefetch_installer(&found).is_none());
        assert!(!installer_temp_path_for_name("absent-mdp-test-setup.exe")
            .with_extension("part")
            .exists());
    }

    #[test]
    fn installer_temp_path_uses_file_name_only() {
        let p = installer_temp_path(Path::new(r"\\srv\share\rel\dir\Setup-1.2.3.exe"));
        assert_eq!(p.file_name().unwrap(), "Setup-1.2.3.exe");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "mdp-update");
        assert!(p.starts_with(std::env::temp_dir()));

        // A remote manifest supplies this name, so it must not be able to steer
        // the write out of the temp directory.
        let p = installer_temp_path_for_name("../../evil.exe");
        assert_eq!(p.file_name().unwrap(), "evil.exe");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "mdp-update");
    }

    #[test]
    fn unreachable_source_is_silent() {
        let cfg = cfg_from(
            r#"{"enabled":true,"provider":"share","source":"\\\\NO-SUCH-HOST-xyz\\share","timeoutMs":500}"#,
        );
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

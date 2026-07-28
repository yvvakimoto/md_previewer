#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::env;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::webview::WebViewBuilder;
use wry::http::Response;
use serde::{Deserialize, Serialize};
use notify::{Watcher, RecursiveMode, RecommendedWatcher, recommended_watcher};
use regex::Regex;
use std::collections::{HashMap, HashSet};

#[cfg(windows)]
mod cdp_win;
mod clipboard_win;
mod editor_registry;
mod ime_win;
mod mdx;
#[cfg(windows)]
mod pdf_win;
#[cfg(windows)]
mod png_win;
mod updater;
use editor_registry::EditorRegistry;

// Path to a markdown file currently being viewed. Wrapped in Arc<Mutex>
// for sharing between the event loop, IPC handler, and file watcher.
pub(crate) type CurrentFile = Arc<Mutex<Option<PathBuf>>>;

#[derive(Serialize, Deserialize)]
struct FileData {
    filename: String,
    filepath: String,
    /// The markdown the webview renders. Local images used to be inlined here as
    /// base64; they are now served lazily through the `/userfile/` protocol route
    /// instead (see *Preview Pipeline* in CLAUDE.md), so this equals `raw`.
    content: String,
    /// The canonical source markdown. Kept as a separate channel — the webview
    /// holds it as `currentMarkdownRaw` and it is what any host-bound save
    /// (e.g. the Marp theme picker's `savefile:`) writes back to disk, so a
    /// future display-only rewrite of `content` can never leak into the `.md`.
    raw: String,
}

#[derive(Serialize, Clone, Debug)]
struct HeadingEntry {
    level: u8,
    text: String,
    slug: String,
}

#[derive(Serialize, Clone, Debug)]
struct TocNode {
    kind: String, // "file" or "dir"
    name: String,
    #[serde(rename = "relPath")]
    rel_path: String,
    #[serde(rename = "absPath")]
    abs_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TocNode>>,
    // File-only: the document's h1 title (first h1 in the source) and the full
    // list of headings used to build the foldable sub-tree in the sidebar.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    headings: Vec<HeadingEntry>,
}

#[derive(Serialize, Clone, Debug)]
struct Workspace {
    root: String,
    tree: Vec<TocNode>,
    #[serde(rename = "fromToc")]
    from_toc: bool,
    #[serde(rename = "firstFile", skip_serializing_if = "Option::is_none")]
    first_file: Option<String>,
}

#[derive(Debug, Clone)]
enum CustomEvent {
    FileChanged(PathBuf),
    OpenFile(PathBuf),
    OpenDirectory(PathBuf),
    OpenImage(PathBuf),
    DirectoryChanged,
    ToggleFullscreen,
    // Editor window lifecycle.
    OpenEditorWindow { line: u32 },
    EditorCloseRequested,
    // Editor → preview: cursor moved to line.
    EditorCursorMoved { line: u32 },
    // Editor saved file → tell preview to re-render from in-memory content
    // without touching disk again.
    EditorSavedContent { path: PathBuf, content: String },
    // Editor live (unsaved) content → re-render preview without disk write,
    // and re-anchor scroll to cursor `line`.
    EditorLiveContent { path: PathBuf, content: String, line: u32 },
    // OS IME open-status changed for the editor window. Posted by the polling
    // thread spawned alongside the editor; main loop pushes the bool down to
    // the editor JS (`window.__setImeOpen`) so it can tint the cursor.
    EditorImeStatus(bool),
    // Preview JS reports an external CSV/TSV file referenced by a `plotly`
    // block. Main loop adds it to the filesystem watcher so live-edits in
    // the CSV trigger a re-render. CsvWatchReset is fired at the start of
    // every render to flush the prior set.
    CsvWatch(PathBuf),
    CsvWatchReset,
    // PDF export: print the document currently in the webview to `PathBuf`
    // via WebView2's CDP `Page.printToPDF` (see `pdf_win`). PdfExportDone is
    // posted from the async completion handler so the preview can toast.
    // PrintPdf stashes the target path and asks the preview to rasterize any
    // <video> to its chosen frame (`__beforePdfPrint`); the JS posts
    // `pdfprintready:` when the DOM is ready → PrintPdfNow runs the actual print.
    PrintPdf(PathBuf),
    PrintPdfNow,
    PdfExportDone { ok: bool, path: PathBuf },
    // PNG capture (headless `--export-png` mode). The preview JS posts
    // `renderdone:` once the initial render (incl. async Marp/mermaid/KaTeX)
    // settles → CaptureStart initializes the capture loop. For each target
    // slide the JS posts `captureready:` with the clip rect + layout metrics →
    // CaptureReady runs CDP `Page.captureScreenshot` (see `png_win`).
    // CaptureDone is posted from the async completion handler; the loop then
    // advances to the next slide, or writes `layout.json` and exits.
    CaptureStart { marp: bool, slides: usize },
    CaptureReady { index: usize, clip: CaptureClip, layout: Option<SlideLayout> },
    CaptureDone { index: usize, ok: bool },
    // Opt-in auto-update (see `updater`, Windows-only). The background startup
    // check found a newer version on the internal share → show the preview's
    // update banner. QuitForUpdate exits the app after the silent installer has
    // been launched so the running exe unlocks for in-place replacement.
    UpdateAvailable { version: String, notes: String },
    QuitForUpdate,
}

/// CLI `--export-png` configuration, parsed from argv in `main()`.
#[derive(Clone, Debug)]
struct CaptureConfig {
    out_dir: PathBuf,
    /// 1-based slide spec like "1,3,5-7"; None = all slides. Marp only.
    slides_spec: Option<String>,
    /// Screenshot zoom factor (CDP clip.scale). Default 2.0.
    scale: f64,
}

/// Screenshot region reported by the preview JS (`captureready:`), in CSS px.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
struct CaptureClip {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Per-slide layout metrics reported by the preview JS (from `fitMarpSlides()`),
/// written into `layout.json`. `file` is filled in by the host after capture.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct SlideLayout {
    // Filled in by the host after capture (JS doesn't send these two).
    #[serde(default)]
    index: usize,
    #[serde(default)]
    file: String,
    overflow: bool,
    scale: f64,
    #[serde(rename = "flooredAtMin")]
    floored_at_min: bool,
    #[serde(rename = "contentH")]
    content_h: f64,
    avail: f64,
}

/// Live capture-loop progress, initialized on `CaptureStart`.
struct CaptureState {
    out_dir: PathBuf,
    scale: f64,
    marp: bool,
    /// 0-based slide indices to capture, in output order.
    indices: Vec<usize>,
    /// Position within `indices` currently being captured.
    cursor: usize,
    /// Collected per-slide metrics (Marp only), written to `layout.json`.
    layouts: Vec<SlideLayout>,
}

/// Resolve a 1-based `--slides` spec ("1,3,5-7") against `count` slides into a
/// deduped, order-preserving list of 0-based indices. None/empty → all slides.
/// Out-of-range values are silently dropped.
fn parse_slides_spec(spec: &Option<String>, count: usize) -> Vec<usize> {
    let spec = match spec {
        Some(s) if !s.trim().is_empty() => s,
        _ => return (0..count).collect(),
    };
    let mut out: Vec<usize> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let push = |n: usize, out: &mut Vec<usize>, seen: &mut HashSet<usize>| {
        if n >= 1 && n <= count {
            let idx = n - 1;
            if seen.insert(idx) {
                out.push(idx);
            }
        }
    };
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<usize>(), b.trim().parse::<usize>()) {
                let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
                for n in lo..=hi {
                    push(n, &mut out, &mut seen);
                }
            }
        } else if let Ok(n) = part.parse::<usize>() {
            push(n, &mut out, &mut seen);
        }
    }
    out
}

/// Output filename for a captured slide: `slide-NN.png` (Marp, 1-based) or
/// `page.png` (a non-Marp full-page capture).
fn slide_png_name(marp: bool, index: usize) -> String {
    if marp {
        format!("slide-{:02}.png", index + 1)
    } else {
        "page.png".to_string()
    }
}

const APP_NAME: &str = "Markdown Previewer";

// Forensic log written next to the exe. Truncated on each launch. Used to
// diagnose "works in target/release, broken when copied" reports — release
// builds run under windows_subsystem="windows", so eprintln! is swallowed.
static DBG_LOG: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();

fn dbg_log_init(exe_dir: &Path) {
    let path = exe_dir.join("md-previewer.log");
    let file = fs::File::create(&path).ok();
    let _ = DBG_LOG.set(Mutex::new(file));
}

pub(crate) fn dbg_log_write(msg: &str) {
    if let Some(lock) = DBG_LOG.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "{}", msg);
                let _ = f.flush();
            }
        }
    }
}

macro_rules! dbg_log {
    ($($arg:tt)*) => { dbg_log_write(&format!($($arg)*)) };
}

fn format_title(filename: Option<&str>) -> String {
    match filename {
        Some(name) if !name.is_empty() => format!("{} — {}", name, APP_NAME),
        _ => APP_NAME.to_string(),
    }
}

// Thread-safe storage for the current markdown file's parent directory
pub(crate) type CurrentDir = Arc<Mutex<Option<PathBuf>>>;

/// Paths we wrote ourselves, whose next `notify` event must be ignored so a save
/// does not bounce back as an external change and re-render (or loop).
pub(crate) type SuppressedSaves = Arc<Mutex<HashSet<PathBuf>>>;

/// How long a self-written path stays suppressed. A safety net rather than a
/// handshake: if the watcher event never arrives, the entry simply expires.
const SAVE_SUPPRESS_MS: u64 = 1500;

/// Mark `path` as self-written and schedule the mark's removal on a detached
/// thread. Idempotent and non-blocking; call it *before* writing so the watcher
/// can never observe a partial write.
pub(crate) fn suppress_watcher(path: &Path, suppressed: &SuppressedSaves) {
    suppressed.lock().unwrap().insert(path.to_path_buf());
    let suppressed = suppressed.clone();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SAVE_SUPPRESS_MS));
        suppressed.lock().unwrap().remove(&path);
    });
}

/// [`suppress_watcher`] followed by `fs::write`. Returns the write's result
/// unchanged so each caller keeps its own error message and follow-up work.
pub(crate) fn write_suppressed(
    path: &Path,
    content: &[u8],
    suppressed: &SuppressedSaves,
) -> std::io::Result<()> {
    suppress_watcher(path, suppressed);
    fs::write(path, content)
}

/// Parent directory of the currently-previewed file, if any. Used to seed native
/// Save-As dialogs and to resolve document-relative paths off the IPC thread.
fn current_file_dir(current_file: &CurrentFile) -> Option<PathBuf> {
    current_file
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Apply `dir` as the dialog's starting directory when one is known.
fn with_initial_dir(dialog: rfd::FileDialog, dir: Option<PathBuf>) -> rfd::FileDialog {
    match dir {
        Some(d) => dialog.set_directory(d),
        None => dialog,
    }
}

/// Build `if (typeof window.<f> === 'function') { window.<f>(<args…>); }`.
///
/// The guard matters because the host can push before `index.html`'s script has
/// run. `args` are already-serialized JS expressions (`serde_json` output, or a
/// number / bool rendered with `to_string()`) and are inserted verbatim — this
/// does no escaping, so never pass unsanitized text.
pub(crate) fn js_call(f: &str, args: &[&str]) -> String {
    format!(
        "if (typeof window.{f} === 'function') {{ window.{f}({}); }}",
        args.join(", ")
    )
}

/// [`js_call`] + `evaluate_script`, discarding the always-ignored result. Takes
/// `&WebView` (not the `Arc<Mutex<…>>`) so both the preview and the editor
/// registry can use it after their own locking.
pub(crate) fn eval_js_fn(webview: &wry::webview::WebView, f: &str, args: &[&str]) {
    let _ = webview.evaluate_script(&js_call(f, args));
}

/// Serialize a [`FileData`] and wrap it in the guarded `loadFileFromRust(...)`
/// call — the one step every render path shares. `raw` is set equal to
/// `content`; the two stay distinct fields so the webview's save channel
/// (`currentMarkdownRaw` → `savefile:`) keeps its own source of truth.
///
/// Callers keep what actually differs between them: where the content came
/// from, and whether they also set the title / `current_file` / `current_dir`
/// or push to the paired editor.
fn build_load_file_script(filename: &str, filepath: &str, content: &str) -> String {
    let file_data = FileData {
        filename: filename.to_string(),
        filepath: filepath.to_string(),
        content: content.to_string(),
        raw: content.to_string(),
    };
    let json = serde_json::to_string(&file_data).unwrap_or_else(|_| "null".into());
    js_call("loadFileFromRust", &[&json])
}

// Compare two filesystem paths for equality. Case-insensitive on Windows
// to match the OS, so editors using a different drive-letter case still match.
pub(crate) fn paths_equal(a: &Path, b: &Path) -> bool {
    let na = a.to_string_lossy().to_lowercase().replace('/', "\\");
    let nb = b.to_string_lossy().to_lowercase().replace('/', "\\");
    na == nb
}

// Determine MIME type based on file extension
pub(crate) fn get_mime_type(path: &PathBuf) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        // Web assets
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") => "application/javascript",

        // Fonts
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",

        // Images
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("tiff") | Some("tif") => "image/tiff",
        Some("avif") => "image/avif",

        // Video
        Some("mov") => "video/quicktime",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("ogv") | Some("ogg") => "video/ogg",

        // Other common types
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("tsv") => "text/tab-separated-values; charset=utf-8",

        // Default
        _ => "application/octet-stream",
    }
}

/// Parse a single HTTP `Range` header value into an inclusive `(start, end)`
/// byte range clamped to `total`. Supports `bytes=start-end`, `bytes=start-`,
/// and the suffix form `bytes=-N` (last N bytes). Returns `None` for malformed
/// or unsatisfiable ranges so the caller can fall back to a full 200 response.
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (s, e) = first.split_once('-')?;
    let (start, end) = if s.is_empty() {
        let n: u64 = e.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        let n = n.min(total);
        (total - n, total - 1)
    } else {
        let start: u64 = s.trim().parse().ok()?;
        let end = if e.trim().is_empty() {
            total - 1
        } else {
            e.trim().parse::<u64>().ok()?.min(total - 1)
        };
        (start, end)
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end))
}

/// A local file to copy alongside an exported HTML artifact. `src` is an
/// absolute filesystem path; `dest` is the destination path relative to the
/// export root (e.g. `media/clip.mp4`).
#[derive(Deserialize)]
struct MediaItem {
    src: String,
    dest: String,
}

/// Copy each media file into `base_dir`/`dest`, creating parent directories.
/// Used by both the single-file and workspace HTML export handlers so local
/// videos referenced by `<video>` embeds are bundled with the artifact.
fn copy_export_media(base_dir: &Path, media: &[MediaItem]) {
    for item in media {
        let rel = item.dest.trim_start_matches(['/', '\\']);
        let target = base_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let src = PathBuf::from(item.src.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Err(e) = std::fs::copy(&src, &target) {
            eprintln!("export: failed to copy media {} -> {}: {}", src.display(), target.display(), e);
        }
    }
}

/// Open a just-exported file with its OS default program (既定のプログラムで開く).
/// Mirrors the `openinstalldir:` pattern; `explorer <file>` uses the default handler.
fn open_with_default(path: &Path) {
    if let Err(e) = std::process::Command::new("explorer").arg(path).spawn() {
        eprintln!("open exported: failed to open {}: {}", path.display(), e);
    }
}

// Normalize a path to absolute without the `\\?\` Windows prefix.
fn to_abs(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}

fn is_markdown_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

fn is_image_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            matches!(
                e.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
                    | "bmp" | "ico" | "avif" | "tif" | "tiff"
            )
        })
        .unwrap_or(false)
}

// Mirror of `generateHeadingId` in assets/index.html. Keep these two in sync —
// the exported HTML relies on the JS-generated `id` matching the slug we wrote
// into sidebar `<a href="...html#slug">` links.
fn slugify(text: &str, existing: &mut std::collections::HashSet<String>) -> String {
    let lower = text.to_lowercase();
    let trimmed = lower.trim();
    // Replace any run of whitespace with a single hyphen.
    let space_re = Regex::new(r"\s+").unwrap();
    let s1 = space_re.replace_all(trimmed, "-").to_string();
    // Strip everything that isn't word-class, CJK/Kana/Hangul block, or hyphen.
    let allow_re = Regex::new(r"[^\w぀-ゟ゠-ヿ一-龯㐀-䶿\-]").unwrap();
    let s2 = allow_re.replace_all(&s1, "").to_string();
    let dash_re = Regex::new(r"^-|-$").unwrap();
    let s3 = dash_re.replace_all(&s2, "").to_string();
    let mut base = if s3.is_empty() { "heading".to_string() } else { s3 };
    let stem = base.clone();
    let mut counter = 1;
    while existing.contains(&base) {
        base = format!("{}-{}", stem, counter);
        counter += 1;
    }
    existing.insert(base.clone());
    base
}

fn extract_headings_from_md(md: &str) -> Vec<HeadingEntry> {
    use pulldown_cmark::{Parser, Event, Tag, HeadingLevel};
    let mut out: Vec<HeadingEntry> = Vec::new();
    let mut in_heading: Option<u8> = None;
    let mut buf = String::new();
    let parser = Parser::new(md);
    for ev in parser {
        match ev {
            Event::Start(Tag::Heading(level, _, _)) => {
                in_heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
                buf.clear();
            }
            Event::End(Tag::Heading(_, _, _)) => {
                if let Some(level) = in_heading {
                    let text = buf.trim().to_string();
                    if !text.is_empty() {
                        out.push(HeadingEntry { level, text, slug: String::new() });
                    }
                }
                in_heading = None;
            }
            Event::Text(t) | Event::Code(t) => {
                if in_heading.is_some() { buf.push_str(&t); }
            }
            _ => {}
        }
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for h in out.iter_mut() {
        h.slug = slugify(&h.text, &mut seen);
    }
    out
}

// Read the file and return (h1 title, headings). Returns empty values on error.
fn read_file_headings(path: &Path) -> (Option<String>, Vec<HeadingEntry>) {
    match fs::read_to_string(path) {
        Ok(md) => {
            let headings = extract_headings_from_md(&md);
            let title = headings.iter().find(|h| h.level == 1).map(|h| h.text.clone());
            (title, headings)
        }
        Err(_) => (None, Vec::new()),
    }
}

// Skip dot-prefixed names and common noise directories.
fn is_skipped_entry(name: &str) -> bool {
    if name.starts_with('.') { return true; }
    matches!(name, "node_modules" | "target" | "dist" | "build")
}

// Build a TocNode tree by walking the directory. Dirs first, files second; both
// alphabetical (case-insensitive). Skips hidden / noise dirs. A dir branch with
// no markdown descendants is dropped.
fn walk_tree(dir: &Path, root: &Path) -> Vec<TocNode> {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if is_skipped_entry(&name) { continue; }
        if p.is_dir() {
            dirs.push(p);
        } else if p.is_file() && is_markdown_ext(&p) {
            // Hide the special _toc.md from the listing — it's metadata.
            if name.eq_ignore_ascii_case("_toc.md") { continue; }
            files.push(p);
        }
    }
    dirs.sort_by(|a, b| {
        a.file_name().unwrap_or_default().to_string_lossy().to_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });
    files.sort_by(|a, b| {
        a.file_name().unwrap_or_default().to_string_lossy().to_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_string_lossy().to_lowercase())
    });

    let mut out: Vec<TocNode> = Vec::new();
    for d in dirs {
        let children = walk_tree(&d, root);
        if children.is_empty() { continue; }
        let name = d.file_name().unwrap_or_default().to_string_lossy().to_string();
        let rel = d.strip_prefix(root).unwrap_or(&d).to_string_lossy().replace('\\', "/");
        out.push(TocNode {
            kind: "dir".to_string(),
            name,
            rel_path: rel,
            abs_path: d.to_string_lossy().to_string(),
            children: Some(children),
            title: None,
            headings: Vec::new(),
        });
    }
    for f in files {
        let name = f.file_name().unwrap_or_default().to_string_lossy().to_string();
        let rel = f.strip_prefix(root).unwrap_or(&f).to_string_lossy().replace('\\', "/");
        let (title, headings) = read_file_headings(&f);
        out.push(TocNode {
            kind: "file".to_string(),
            name,
            rel_path: rel,
            abs_path: f.to_string_lossy().to_string(),
            children: None,
            title,
            headings,
        });
    }
    out
}

// Find the first file node, depth-first.
fn first_file_node(tree: &[TocNode]) -> Option<&TocNode> {
    for n in tree {
        if n.kind == "file" { return Some(n); }
        if let Some(c) = n.children.as_ref() {
            if let Some(f) = first_file_node(c) { return Some(f); }
        }
    }
    None
}

// Parse `_toc.md` (a nested markdown bullet list of `[Title](relative/path.md)`
// links) into a TocNode tree. Sub-lists become folder groups whose label comes
// from the parent line's link text (or plain text). Files not referenced are
// appended at the end via `append_unlisted_files`.
fn parse_toc_md(root: &Path, toc_text: &str) -> Vec<TocNode> {
    use pulldown_cmark::{Parser, Event, Tag};

    // We model the parse as a stack of "current list level" vectors.
    let mut stack: Vec<Vec<TocNode>> = vec![Vec::new()];
    // For each open <item>, store the pending node (built from the link/text on that line).
    // When the item closes, if it accumulated children from a nested list, attach them and
    // upgrade kind to "dir".
    let mut item_stack: Vec<Option<TocNode>> = Vec::new();
    // Buffer for current item's text/link.
    let mut cur_text = String::new();
    let mut cur_href: Option<String> = None;
    // `cur_text` / `cur_href` are single shared buffers that every Start(Item)
    // clears, so an item's own text does not survive its nested list — the
    // parent would end up named after its LAST child. Stash the enclosing
    // item's text/href across each nested list and restore it on the way out.
    let mut outer_item: Vec<(String, Option<String>)> = Vec::new();
    let mut in_item = false;
    let mut in_link = false;

    let parser = Parser::new(toc_text);
    for ev in parser {
        match ev {
            Event::Start(Tag::List(_)) => {
                stack.push(Vec::new());
                outer_item.push((std::mem::take(&mut cur_text), cur_href.take()));
            }
            Event::End(Tag::List(_)) => {
                let level = stack.pop().unwrap_or_default();
                // Restore the enclosing item's own text/href, which this list's
                // items overwrote, before End(Tag::Item) reads them for the name.
                if let Some((text, href)) = outer_item.pop() {
                    cur_text = text;
                    cur_href = href;
                }
                // Attach to the currently-open item, if any. The slot may not
                // exist yet (item only had text + nested list, no link), in which
                // case create a placeholder dir node now and let End(Tag::Item)
                // fill in the name.
                if let Some(slot) = item_stack.last_mut() {
                    if let Some(node) = slot.as_mut() {
                        node.kind = "dir".to_string();
                        node.children = Some(level);
                    } else {
                        *slot = Some(TocNode {
                            kind: "dir".to_string(),
                            name: String::new(),
                            rel_path: String::new(),
                            abs_path: String::new(),
                            children: Some(level),
                            title: None,
                            headings: Vec::new(),
                        });
                    }
                    continue;
                }
                // Not inside an item: merge into outer list level.
                if let Some(outer) = stack.last_mut() {
                    outer.extend(level);
                } else {
                    stack.push(level);
                }
            }
            Event::Start(Tag::Item) => {
                in_item = true;
                cur_text.clear();
                cur_href = None;
                item_stack.push(None);
            }
            Event::End(Tag::Item) => {
                in_item = false;
                let slot = item_stack.pop().unwrap_or(None);
                let text = cur_text.trim().to_string();
                let href = cur_href.take();
                // Build the node if not already built by a nested list.
                let node = if let Some(mut n) = slot {
                    // nested-list path already attached; just update name if empty.
                    if n.name.is_empty() && !text.is_empty() { n.name = text.clone(); }
                    // Use the href as path if file-style link.
                    if let Some(h) = href.as_ref() {
                        if is_markdown_href(h) && n.children.is_none() {
                            n.kind = "file".to_string();
                            let rel = normalize_rel(h);
                            let abs = root.join(&rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                            let (title, headings) = read_file_headings(&abs);
                            n.rel_path = rel;
                            n.abs_path = abs.to_string_lossy().to_string();
                            n.title = title;
                            n.headings = headings;
                        }
                    }
                    n
                } else if let Some(h) = href.filter(|h| is_markdown_href(h)) {
                    // Non-markdown hrefs (external URLs, assets) are ignored the
                    // same way the nested-list branch above ignores them, so they
                    // fall through to the plain-label node instead of becoming a
                    // "file" whose relPath is a URL that resolves nowhere.
                    let rel = normalize_rel(&h);
                    let abs = root.join(&rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let (title, headings) = read_file_headings(&abs);
                    TocNode {
                        kind: "file".to_string(),
                        name: if text.is_empty() {
                            std::path::Path::new(&rel).file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or(rel.clone())
                        } else { text },
                        rel_path: rel,
                        abs_path: abs.to_string_lossy().to_string(),
                        children: None,
                        title,
                        headings,
                    }
                } else {
                    TocNode {
                        kind: "dir".to_string(),
                        name: text,
                        rel_path: String::new(),
                        abs_path: String::new(),
                        children: Some(Vec::new()),
                        title: None,
                        headings: Vec::new(),
                    }
                };
                if let Some(level) = stack.last_mut() {
                    level.push(node);
                }
            }
            Event::Start(Tag::Link(_, dest, _)) => {
                in_link = true;
                cur_href = Some(dest.to_string());
            }
            Event::End(Tag::Link(_, _, _)) => { in_link = false; }
            Event::Text(t) => {
                if in_item { cur_text.push_str(&t); }
                let _ = in_link;
            }
            Event::Code(t) => { if in_item { cur_text.push_str(&t); } }
            _ => {}
        }
    }

    let mut result = stack.pop().unwrap_or_default();
    append_unlisted_files(root, &mut result);
    result
}

fn is_markdown_href(href: &str) -> bool {
    let h = href.split('#').next().unwrap_or("");
    let lower = h.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn normalize_rel(href: &str) -> String {
    let h = href.split('#').next().unwrap_or("").trim_start_matches("./");
    h.replace('\\', "/")
}

// Collect every relPath already present in the tree (recursively).
fn collect_paths(tree: &[TocNode], acc: &mut std::collections::HashSet<String>) {
    for n in tree {
        if n.kind == "file" && !n.rel_path.is_empty() {
            acc.insert(n.rel_path.to_lowercase());
        }
        if let Some(c) = n.children.as_ref() { collect_paths(c, acc); }
    }
}

// Append .md files present on disk but not referenced in _toc.md, preserving
// their on-disk structure (alphabetical).
fn append_unlisted_files(root: &Path, tree: &mut Vec<TocNode>) {
    let mut listed: std::collections::HashSet<String> = std::collections::HashSet::new();
    collect_paths(tree, &mut listed);
    let auto = walk_tree(root, root);
    // Recursively filter out anything already listed.
    fn filter(node: TocNode, listed: &std::collections::HashSet<String>) -> Option<TocNode> {
        match node.kind.as_str() {
            "file" => {
                if listed.contains(&node.rel_path.to_lowercase()) { None } else { Some(node) }
            }
            "dir" => {
                if let Some(children) = node.children {
                    let filtered: Vec<TocNode> = children.into_iter()
                        .filter_map(|c| filter(c, listed)).collect();
                    if filtered.is_empty() { None } else {
                        Some(TocNode { children: Some(filtered), ..node })
                    }
                } else { None }
            }
            _ => None,
        }
    }
    let leftover: Vec<TocNode> = auto.into_iter().filter_map(|n| filter(n, &listed)).collect();
    if !leftover.is_empty() {
        tree.push(TocNode {
            kind: "dir".to_string(),
            name: "Other".to_string(),
            rel_path: String::new(),
            abs_path: String::new(),
            children: Some(leftover),
            title: None,
            headings: Vec::new(),
        });
    }
}

fn build_workspace(root: &Path) -> Workspace {
    let abs_root = to_abs(root);
    let toc_path = abs_root.join("_toc.md");
    let (tree, from_toc) = if toc_path.is_file() {
        match fs::read_to_string(&toc_path) {
            Ok(s) => (parse_toc_md(&abs_root, &s), true),
            Err(_) => (walk_tree(&abs_root, &abs_root), false),
        }
    } else {
        (walk_tree(&abs_root, &abs_root), false)
    };
    let first_file = first_file_node(&tree).map(|n| n.abs_path.clone());
    Workspace {
        root: abs_root.to_string_lossy().to_string(),
        tree,
        from_toc,
        first_file,
    }
}

/// Read the markdown file at `path` and push the resulting `FileData` into the
/// webview via `loadFileFromRust`. Also updates `current_dir` so subsequent
/// relative-path lookups (images / CSV / video via `/userfile/`) resolve.
fn load_and_render(
    path: &Path,
    webview: &Arc<Mutex<wry::webview::WebView>>,
    current_dir: &CurrentDir,
    current_file: &CurrentFile,
    editor_registry: &EditorRegistry,
) {
    load_and_render_named(path, None, webview, current_dir, current_file, editor_registry);
}

/// Like [`load_and_render`], but `display_name`, when `Some`, overrides the
/// shown filename (window title + `FileData.filename`) without changing the
/// real `path` used for disk reads / `current_file` / editor pairing. Used for
/// `.mdx` bundles, whose extracted entry is e.g. `index.md` on disk but should
/// display as `foo.mdx`.
fn load_and_render_named(
    path: &Path,
    display_name: Option<&str>,
    webview: &Arc<Mutex<wry::webview::WebView>>,
    current_dir: &CurrentDir,
    current_file: &CurrentFile,
    editor_registry: &EditorRegistry,
) {
    let base_dir = path.parent().map(|p| p.to_path_buf());
    if let Some(ref parent) = base_dir {
        *current_dir.lock().unwrap() = Some(parent.clone());
    }

    match fs::read_to_string(path) {
        Ok(content) => {
            let filename = display_name
                .map(|s| s.to_string())
                .or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()))
                .unwrap_or_else(|| "Unknown".to_string());
            let filepath = path.to_string_lossy().to_string();
            // Not `eval_js_fn`: this is the one site that surfaces the error.
            let script = build_load_file_script(&filename, &filepath, &content);

            if let Ok(webview_guard) = webview.lock() {
                webview_guard.window().set_title(&format_title(Some(&filename)));
                if let Err(e) = webview_guard.evaluate_script(&script) {
                    eprintln!("Failed to update webview: {}", e);
                }
            }

            *current_file.lock().unwrap() = Some(path.to_path_buf());

            // If a paired editor window is open, propagate the file switch.
            editor_registry.push_file_to_editor(path, &content);
        }
        Err(e) => eprintln!("Failed to read file {:?}: {}", path, e),
    }
}

/// If the just-saved `saved_path` belongs to an open `.mdx` bundle (it is the
/// entry file or lives inside the bundle's temp dir), repack the temp dir back
/// into the original `.mdx`. The `.mdx` path is added to `suppressed_saves` for
/// ~1.5s (same mechanism as `editor:save:` / `savefile:`) so our own write does
/// not trigger a watcher reload loop.
fn maybe_repack_mdx(
    saved_path: &Path,
    mdx_session: &Arc<Mutex<Option<mdx::MdxSession>>>,
    suppressed_saves: &SuppressedSaves,
) {
    let (temp_dir, mdx_path) = {
        let guard = mdx_session.lock().unwrap();
        match guard.as_ref() {
            Some(sess)
                if paths_equal(saved_path, &sess.entry)
                    || saved_path.starts_with(sess.temp.path()) =>
            {
                (sess.temp.path().to_path_buf(), sess.mdx_path.clone())
            }
            _ => return,
        }
    };
    // Suppress-only: the write itself is `repack_mdx`, not `fs::write`.
    suppress_watcher(&mdx_path, suppressed_saves);
    if let Err(e) = mdx::repack_mdx(&temp_dir, &mdx_path) {
        eprintln!("mdx: repack failed for {:?}: {}", mdx_path, e);
    }
}

fn main() -> wry::Result<()> {
    // Check for command-line arguments (file or directory path)
    let args: Vec<String> = env::args().collect();

    // Separate flags from the single positional path. `--export-png <dir>`
    // enables headless PNG capture (see CaptureConfig / png_win); `--slides`
    // and `--png-scale` refine it. Everything else stays back-compatible: the
    // first non-flag argument is the file/dir/mdx to open, as before.
    let mut positional: Option<String> = None;
    let mut cap_out: Option<PathBuf> = None;
    let mut cap_slides: Option<String> = None;
    let mut cap_scale: f64 = 2.0;
    {
        let mut i = 1;
        while i < args.len() {
            match args[i].as_str() {
                "--export-png" => {
                    cap_out = args.get(i + 1).map(PathBuf::from);
                    i += 2;
                }
                "--slides" => {
                    cap_slides = args.get(i + 1).cloned();
                    i += 2;
                }
                "--png-scale" => {
                    cap_scale = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(2.0);
                    i += 2;
                }
                a => {
                    if positional.is_none() && !a.starts_with("--") {
                        positional = Some(a.to_string());
                    }
                    i += 1;
                }
            }
        }
    }
    let capture_config: Option<CaptureConfig> = cap_out.map(|out_dir| CaptureConfig {
        out_dir,
        slides_spec: cap_slides,
        scale: if cap_scale > 0.0 { cap_scale } else { 2.0 },
    });

    let cli_path: Option<PathBuf> = positional.map(PathBuf::from);

    // If the CLI arg is an `.mdx` bundle, extract it now; the extracted entry
    // `.md` then flows through the normal single-file path below. `mdx_initial`
    // holds the live session (kept alive in `mdx_session`); `mdx_display_name`
    // is the `.mdx` filename to show instead of the extracted `index.md`.
    let mut mdx_initial: Option<mdx::MdxSession> = None;
    let mut mdx_display_name: Option<String> = None;

    // Distinguish file vs directory. A directory opens as a workspace; a file
    // opens directly (back-compat with existing CLI / double-click flow).
    let (file_path, dir_path): (Option<PathBuf>, Option<PathBuf>) = match cli_path.as_ref() {
        Some(p) if p.is_dir() => (None, Some(to_abs(p))),
        Some(p) if mdx::is_mdx_ext(p) && p.is_file() => {
            let abs = to_abs(p);
            match mdx::open_mdx(&abs) {
                Ok(sess) => {
                    mdx_display_name =
                        abs.file_name().map(|n| n.to_string_lossy().to_string());
                    let entry = sess.entry.clone();
                    mdx_initial = Some(sess);
                    (Some(entry), None)
                }
                Err(e) => {
                    eprintln!("Failed to open .mdx {:?}: {}", abs, e);
                    (None, None)
                }
            }
        }
        Some(p) if p.is_file() => (Some(p.clone()), None),
        _ => (None, None),
    };

    // If a directory was supplied, also queue its first file (if any) for
    // initial rendering.
    let initial_workspace: Option<Workspace> = dir_path.as_ref().map(|d| build_workspace(d));
    let initial_workspace_file: Option<PathBuf> = initial_workspace
        .as_ref()
        .and_then(|w| w.first_file.as_ref().map(PathBuf::from));
    let effective_file_path: Option<PathBuf> = file_path.clone().or(initial_workspace_file.clone());

    // Read file content if provided
    let initial_file: Option<FileData> = effective_file_path.as_ref().and_then(|path| {
        if path.exists() && path.is_file() {
            let filename = mdx_display_name
                .clone()
                .or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()))?;
            // Convert to absolute path for proper relative image resolution
            // Use current_dir().join() instead of canonicalize() to avoid \\?\ prefix on Windows
            let abs_path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir().unwrap_or_default().join(path)
            };
            let filepath = abs_path.to_string_lossy().to_string();
            // A file with no parent directory is not something we can serve
            // `/userfile/` assets for, so bail out exactly as before.
            abs_path.parent()?;

            match fs::read_to_string(&path) {
                Ok(raw) => Some(FileData { filename, filepath, content: raw.clone(), raw }),
                Err(e) => {
                    eprintln!("Error reading file: {}", e);
                    None
                }
            }
        } else {
            eprintln!("File does not exist or is not a file: {:?}", path);
            None
        }
    });

    // Create thread-safe storage for current file directory (for relative image paths)
    // Must use absolute path to properly resolve relative image paths
    let current_dir: CurrentDir = Arc::new(Mutex::new(
        effective_file_path.as_ref().and_then(|p| {
            let abs_path = to_abs(p);
            abs_path.parent().map(|d| d.to_path_buf())
        })
    ));

    // Workspace state shared with the event loop and file watcher.
    let workspace: Arc<Mutex<Option<Workspace>>> = Arc::new(Mutex::new(initial_workspace.clone()));

    // The open `.mdx` bundle (if any). Holds the extracted temp dir alive and
    // maps the extracted entry back to the original `.mdx` for title display,
    // watching, and save-time repacking.
    let mdx_session: Arc<Mutex<Option<mdx::MdxSession>>> = Arc::new(Mutex::new(mdx_initial));

    // Create event loop and window
    let event_loop = EventLoop::<CustomEvent>::with_user_event();
    let event_proxy = event_loop.create_proxy();
    let initial_title = format_title(
        mdx_display_name
            .clone()
            .or_else(|| {
                effective_file_path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .as_deref(),
    );
    // Clamp the initial window size to fit within the primary monitor's visible
    // area (minus a margin for the taskbar / window chrome), then center it.
    // Without this, on smaller / high-DPI displays the bottom of the 800-logical-px
    // window can fall off-screen behind the taskbar. Shared with the editor window.
    let (init_w, init_h, init_pos) =
        editor_registry::clamped_window_geometry(&event_loop, 1200.0, 800.0);
    let mut window_builder = WindowBuilder::new()
        .with_title(&initial_title)
        .with_inner_size(tao::dpi::LogicalSize::new(init_w, init_h));
    if let Some(pos) = init_pos {
        window_builder = window_builder.with_position(pos);
    }
    // In `--export-png` capture mode the window is a throwaway render surface —
    // keep it hidden so the user never sees it flash. CDP `Page.captureScreenshot`
    // with `captureBeyondViewport:true` rasterizes off the renderer, not the
    // window surface, so a hidden window still produces valid PNGs.
    if capture_config.is_some() {
        window_builder = window_builder.with_visible(false);
    }
    let window = window_builder.build(&event_loop).unwrap();

    // Prepare initialization script: optional workspace payload + optional file load.
    let workspace_init = if let Some(ref w) = initial_workspace {
        let json = serde_json::to_string(w).unwrap();
        format!(
            "if (typeof window.loadDirectoryFromRust === 'function') {{ window.loadDirectoryFromRust({}); }} else {{ window.__pendingWorkspace = {}; }}",
            json, json
        )
    } else {
        String::new()
    };

    let init_script = if let Some(ref file_data) = initial_file {
        let json_data = serde_json::to_string(file_data).unwrap();
        format!(
            r#"
            window.addEventListener('DOMContentLoaded', function() {{
                {ws}
                console.log('Loading file from command line...');
                if (typeof window.loadFileFromRust === 'function') {{
                    window.loadFileFromRust({fd});
                }} else {{
                    setTimeout(function() {{
                        if (typeof window.loadFileFromRust === 'function') {{
                            window.loadFileFromRust({fd});
                        }}
                    }}, 100);
                }}
            }});
            "#,
            ws = workspace_init, fd = json_data
        )
    } else if !workspace_init.is_empty() {
        // Workspace but no first file: render the tree, leave preview empty/drop-zone.
        format!(
            r#"
            window.addEventListener('DOMContentLoaded', function() {{
                {ws}
                if (typeof window.__showDropZone === 'function') {{
                    window.__showDropZone();
                }}
            }});
            "#,
            ws = workspace_init
        )
    } else {
        r#"
        window.addEventListener('DOMContentLoaded', function() {
            if (typeof window.__showDropZone === 'function') {
                window.__showDropZone();
            }
        });
        "#.to_string()
    };

    // Get the current executable directory to locate assets
    let exe_path = env::current_exe().unwrap();
    let exe_dir = exe_path.parent().unwrap();
    let assets_dir = exe_dir.join("assets");

    dbg_log_init(exe_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    dbg_log!("=== launch unix={} ===", stamp);
    dbg_log!("exe_path     = {:?}", exe_path);
    dbg_log!("assets_dir   = {:?}", assets_dir);
    dbg_log!("assets meta  = {:?}", assets_dir.metadata().map(|m| m.is_dir()));
    let marp_dir = assets_dir.join("marp");
    dbg_log!("marp_dir     = {:?}", marp_dir);
    dbg_log!("marp meta    = {:?}", marp_dir.metadata().map(|m| m.is_dir()));

    // Discover user-defined style sheets dropped into assets/. `editor.css`
    // is reserved for the editor window and excluded from the preview's
    // M-key style cycle.
    let user_styles: Vec<String> = match fs::read_dir(&assets_dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("css")).unwrap_or(false) {
                    let name = p.file_name().and_then(|n| n.to_str()).map(String::from);
                    match name.as_deref() {
                        Some(n) if n.eq_ignore_ascii_case("editor.css") => None,
                        _ => name,
                    }
                } else { None }
            })
            .collect(),
        Err(e) => {
            dbg_log!("read_dir(assets_dir) FAILED: {}", e);
            Vec::new()
        }
    };
    let user_styles_json = serde_json::to_string(&user_styles).unwrap_or_else(|_| "[]".into());
    dbg_log!("user_styles  = {}", user_styles_json);

    // For each <base>.css discovered above, probe for a sibling <base>_export.js.
    // If present, the css participates in the style-specific exporter dispatch
    // performed by exportHtml() in assets/index.html. The general export path
    // is used when no entry exists for the active style.
    let mut style_exporters: HashMap<String, String> = HashMap::new();
    for css in &user_styles {
        if let Some(base) = css.strip_suffix(".css").or_else(|| css.strip_suffix(".CSS")) {
            let js_name = format!("{}_export.js", base);
            if assets_dir.join(&js_name).is_file() {
                style_exporters.insert(css.clone(), js_name);
            }
        }
    }
    let style_exporters_json = serde_json::to_string(&style_exporters).unwrap_or_else(|_| "{}".into());
    dbg_log!("style_exporters = {}", style_exporters_json);

    // Discover user-defined Marp themes dropped into assets/marp/
    let marp_themes: Vec<String> = match fs::read_dir(&marp_dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("css")).unwrap_or(false) {
                    p.file_name().and_then(|n| n.to_str()).map(String::from)
                } else { None }
            })
            .collect(),
        Err(e) => {
            dbg_log!("read_dir(assets/marp) FAILED: {}", e);
            Vec::new()
        }
    };
    let marp_themes_json = serde_json::to_string(&marp_themes).unwrap_or_else(|_| "[]".into());
    dbg_log!("marp_themes  = {}", marp_themes_json);

    let app_version_json =
        serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| "\"\"".into());
    // In capture mode, tell the preview to emit `renderdone:` after the initial
    // render settles and to expose `window.__prepareCapture(index)`.
    let capture_init = match &capture_config {
        Some(c) => format!("window.__captureConfig = {{ scale: {} }};\n", c.scale),
        None => String::new(),
    };
    let init_script = format!(
        "window.__appVersion = {};\nwindow.__userStyles = {};\nwindow.__marpThemes = {};\nwindow.__styleExporters = {};\n{}{}",
        app_version_json, user_styles_json, marp_themes_json, style_exporters_json, capture_init, init_script
    );

    // Opt-in auto-update (Windows-only, off unless an `update.json` config is
    // present — see `updater`). Holds the prefetched installer info once the
    // background check confirms a newer version; the `update:install` IPC reads
    // it. Absent config ⇒ no thread, no network, offline as before.
    let update_ready: Arc<Mutex<Option<updater::UpdateReady>>> = Arc::new(Mutex::new(None));
    if capture_config.is_none() {
        if let Some(cfg) = updater::load_config(exe_dir, &assets_dir) {
            let proxy = event_proxy.clone();
            let ver = env!("CARGO_PKG_VERSION").to_string();
            let ready_state = update_ready.clone();
            std::thread::spawn(move || {
                if let Some(r) = updater::check_and_prepare(&cfg, &ver) {
                    let version = r.version.clone();
                    let notes = r.notes.clone();
                    *ready_state.lock().unwrap() = Some(r);
                    let _ = proxy.send_event(CustomEvent::UpdateAvailable { version, notes });
                }
            });
        }
    }

    // Clone current_dir for use in the protocol handler closure
    let current_dir_clone = current_dir.clone();
    let assets_dir_for_proto = assets_dir.clone();

    // Create webview with custom protocol handler
    let mut webview_builder = WebViewBuilder::new(window)?
        .with_custom_protocol("app".into(), move |request| {
            let assets_dir = &assets_dir_for_proto;
            let path = request.uri().path();

            // JS-side forensic log bridge: GET app://localhost/__log/<percent-encoded msg>
            // writes the decoded message to md-previewer.log.
            if let Some(rest) = path.strip_prefix("/__log/") {
                let decoded = urlencoding::decode(rest)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| rest.to_string());
                dbg_log!("[js] {}", decoded);
                return Ok(Response::builder()
                    .status(204)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::<u8>::new().into())
                    .unwrap());
            }

            // Check if this is a user file request (for relative images)
            if path.starts_with("/userfile/") {
                let file_path_str = &path["/userfile/".len()..];

                // URL decode the path (handle spaces, special characters)
                let decoded_path = urlencoding::decode(file_path_str)
                    .unwrap_or_else(|_| file_path_str.into());

                // Normalize path separators for Windows (convert / to \)
                let normalized_path = decoded_path.replace("/", std::path::MAIN_SEPARATOR_STR);
                let file_path = PathBuf::from(&normalized_path);

                // Resolve the path
                let resolved_path = if file_path.is_absolute() {
                    file_path
                } else {
                    // Resolve relative to current markdown file's directory
                    let current = current_dir_clone.lock().unwrap();
                    match current.as_ref() {
                        Some(dir) => {
                            // Normalize the path (handle ../ and ./)
                            let mut resolved = dir.clone();
                            for component in file_path.components() {
                                match component {
                                    std::path::Component::ParentDir => {
                                        resolved.pop();
                                    }
                                    std::path::Component::Normal(name) => {
                                        resolved.push(name);
                                    }
                                    std::path::Component::CurDir => {
                                        // Do nothing for ./
                                    }
                                    _ => {
                                        resolved.push(component);
                                    }
                                }
                            }
                            resolved
                        }
                        None => {
                            return Ok(Response::builder()
                                .status(404)
                                .body("No file loaded".as_bytes().to_vec().into())
                                .unwrap());
                        }
                    }
                };

                // Read and serve the user file. Honor an HTTP `Range` request so
                // WebView2 can seek/scrub videos (a full-body 200 makes the player
                // re-download from byte 0 on every seek and breaks duration probing).
                let range_header = request
                    .headers()
                    .get("Range")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                match fs::metadata(&resolved_path) {
                    Ok(meta) => {
                        let total = meta.len();
                        let mime_type = get_mime_type(&resolved_path);

                        match range_header.as_deref().and_then(|h| parse_byte_range(h, total)) {
                            Some((start, end)) => {
                                use std::io::{Read, Seek, SeekFrom};
                                let len = end - start + 1;
                                let body = (|| -> std::io::Result<Vec<u8>> {
                                    let mut f = std::fs::File::open(&resolved_path)?;
                                    f.seek(SeekFrom::Start(start))?;
                                    let mut buf = vec![0u8; len as usize];
                                    f.read_exact(&mut buf)?;
                                    Ok(buf)
                                })();
                                match body {
                                    Ok(buf) => Ok(Response::builder()
                                        .status(206)
                                        .header("Content-Type", mime_type)
                                        .header("Access-Control-Allow-Origin", "*")
                                        .header("Accept-Ranges", "bytes")
                                        .header("Content-Range", format!("bytes {}-{}/{}", start, end, total))
                                        .header("Content-Length", len.to_string())
                                        .body(buf.into())
                                        .unwrap()),
                                    Err(e) => {
                                        eprintln!("Failed to read range of {:?}: {}", resolved_path, e);
                                        Ok(Response::builder()
                                            .status(500)
                                            .body(format!("Read error: {:?}", resolved_path).into_bytes().into())
                                            .unwrap())
                                    }
                                }
                            }
                            None => match fs::read(&resolved_path) {
                                Ok(content) => Ok(Response::builder()
                                    .header("Content-Type", mime_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Accept-Ranges", "bytes")
                                    .body(content.into())
                                    .unwrap()),
                                Err(e) => {
                                    eprintln!("Failed to read user file {:?}: {}", resolved_path, e);
                                    dbg_log!("userfile 404 uri={} resolved={:?} err={}", path, resolved_path, e);
                                    Ok(Response::builder()
                                        .status(404)
                                        .body(format!("File not found: {:?}", resolved_path).into_bytes().into())
                                        .unwrap())
                                }
                            },
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to stat user file {:?}: {}", resolved_path, e);
                        dbg_log!("userfile 404 uri={} resolved={:?} err={}", path, resolved_path, e);
                        Ok(Response::builder()
                            .status(404)
                            .body(format!("File not found: {:?}", resolved_path).into_bytes().into())
                            .unwrap())
                    }
                }
            } else {
                // Original asset file handling
                let file_path = if path == "/" || path == "/index.html" {
                    assets_dir.join("index.html")
                } else {
                    // Remove leading slash and construct path
                    assets_dir.join(&path[1..])
                };

                // Read the file
                match fs::read(&file_path) {
                    Ok(content) => {
                        let mime_type = get_mime_type(&file_path);
                        Ok(Response::builder()
                            .header("Content-Type", mime_type)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(content.into())
                            .unwrap())
                    }
                    Err(e) => {
                        eprintln!("Failed to read file {:?}: {}", file_path, e);
                        if path.starts_with("/marp/") || path.ends_with(".css") {
                            dbg_log!("protocol 404 uri={} resolved={:?} err={}", path, file_path, e);
                        }
                        Ok(Response::builder()
                            .status(404)
                            .body(format!("File not found: {:?}", file_path).into_bytes().into())
                            .unwrap())
                    }
                }
            }
        })
        .with_url("app://localhost/index.html")?
        .with_hotkeys_zoom(true);

    // Tracks which markdown file the previewer is currently rendering.
    let current_file: CurrentFile = Arc::new(Mutex::new(
        effective_file_path.as_ref().and_then(|p| {
            let abs_path = to_abs(p);
            if abs_path.exists() { Some(abs_path) } else { None }
        }),
    ));

    // Editor↔preview pairing registry. The editor window (when open) is held
    // here and routed only to/from this preview — no broadcast, no WS, no
    // chance of cross-file mixing.
    let editor_registry: EditorRegistry = EditorRegistry::new();

    // Set of file paths whose next `notify` event should be suppressed because
    // we just wrote them ourselves (from the editor's Ctrl+S). Entries are
    // checked by the watcher thread and cleared on use; we also clear stale
    // entries on a 1.5s timeout to avoid lockout if the OS event never arrives.
    let suppressed_saves: SuppressedSaves = Arc::new(Mutex::new(HashSet::new()));

    // Capture-loop progress for `--export-png` mode; owned by the event loop.
    let capture_state: Arc<Mutex<Option<CaptureState>>> = Arc::new(Mutex::new(None));

    // Target path for an in-flight PDF export, stashed by PrintPdf while the
    // preview rasterizes its videos (__beforePdfPrint) and consumed by
    // PrintPdfNow once the JS posts `pdfprintready:`.
    let pending_pdf: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));

    let ipc_event_proxy = event_proxy.clone();
    let ipc_current_file = current_file.clone();
    let ipc_editor_registry = editor_registry.clone();
    let ipc_suppressed_saves = suppressed_saves.clone();
    // Owned copy of the install directory (exe_dir is a borrowed &Path) so the
    // `openinstalldir:` IPC branch can open it in Explorer from the move closure.
    let ipc_install_dir = exe_dir.to_path_buf();
    // Auto-update: the prefetched-installer handle + this exe's path, so the
    // `update:install` IPC branch can launch the silent installer + relaunch
    // (Windows-only; the install branch below is cfg-gated).
    #[cfg(windows)]
    let ipc_update_ready = update_ready.clone();
    #[cfg(windows)]
    let ipc_exe_path = exe_path.clone();
    webview_builder = webview_builder.with_ipc_handler(move |window, message| {
        if let Some(name) = message.strip_prefix("settitle:") {
            window.set_title(&format_title(Some(name)));
        } else if let Some(path_str) = message.strip_prefix("openmd:") {
            let path = PathBuf::from(path_str);
            if path.is_dir() {
                if let Err(e) = ipc_event_proxy.send_event(CustomEvent::OpenDirectory(path)) {
                    eprintln!("Failed to dispatch OpenDirectory: {}", e);
                }
            } else if let Err(e) = ipc_event_proxy.send_event(CustomEvent::OpenFile(path)) {
                eprintln!("Failed to dispatch OpenFile: {}", e);
            }
        } else if let Some(path_str) = message.strip_prefix("opendir:") {
            let path = PathBuf::from(path_str);
            if let Err(e) = ipc_event_proxy.send_event(CustomEvent::OpenDirectory(path)) {
                eprintln!("Failed to dispatch OpenDirectory: {}", e);
            }
        } else if let Some(payload) = message.strip_prefix("exportdir:") {
            // Webview asks the host to write a folder of HTML pages mirroring the
            // workspace tree. Payload is JSON:
            // { "pages": [{"relPath":"foo/bar.html", "html":"<...>"}], "indexHtml": "<...>" }
            #[derive(Deserialize)]
            struct PagePayload { #[serde(rename = "relPath")] rel_path: String, html: String }
            #[derive(Deserialize)]
            struct ExportDirPayload {
                pages: Vec<PagePayload>,
                #[serde(rename = "indexHtml", default)]
                index_html: String,
                #[serde(rename = "rootName", default)]
                root_name: String,
                #[serde(default)]
                media: Vec<MediaItem>,
            }
            match serde_json::from_str::<ExportDirPayload>(payload) {
                Ok(p) => {
                    std::thread::spawn(move || {
                        let dialog = rfd::FileDialog::new()
                            .set_title(&format!("Choose output folder for {}", if p.root_name.is_empty() { "export" } else { &p.root_name }));
                        if let Some(out_dir) = dialog.pick_folder() {
                            for page in &p.pages {
                                let rel = page.rel_path.trim_start_matches(['/', '\\']);
                                let target = out_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                                if let Some(parent) = target.parent() {
                                    let _ = std::fs::create_dir_all(parent);
                                }
                                if let Err(e) = std::fs::write(&target, page.html.as_bytes()) {
                                    eprintln!("exportdir: failed to write {}: {}", target.display(), e);
                                }
                            }
                            copy_export_media(&out_dir, &p.media);
                            if !p.index_html.is_empty() {
                                let idx = out_dir.join("index.html");
                                match std::fs::write(&idx, p.index_html.as_bytes()) {
                                    Ok(()) => open_with_default(&idx),
                                    Err(e) => eprintln!("exportdir: failed to write index: {}", e),
                                }
                            }
                        }
                    });
                }
                Err(e) => eprintln!("exportdir: bad payload: {}", e),
            }
        } else if let Some(payload) = message.strip_prefix("exporthtml:") {
            // Webview asks the host to save an HTML artifact via a native Save-As dialog.
            // Payload is JSON: { "suggestedName": "...", "html": "..." }.
            #[derive(Deserialize)]
            struct ExportPayload {
                #[serde(rename = "suggestedName")] suggested_name: String,
                html: String,
                #[serde(default)]
                media: Vec<MediaItem>,
            }
            match serde_json::from_str::<ExportPayload>(payload) {
                Ok(p) => {
                    let initial_dir = current_file_dir(&ipc_current_file);
                    let export_proxy = ipc_event_proxy.clone();
                    // rfd's save_file() blocks; run on a worker thread so we don't tie up
                    // the IPC handler and (more importantly) so dialog errors don't
                    // propagate as a hung webview.
                    std::thread::spawn(move || {
                        // Two filters so the user picks the format in the Save dialog.
                        // If the chosen path is `.pdf` we print the live webview to
                        // PDF instead (the pre-built HTML artifact is discarded).
                        let dialog = with_initial_dir(
                            rfd::FileDialog::new()
                                .add_filter("HTML", &["html"])
                                .add_filter("PDF", &["pdf"])
                                .set_file_name(&p.suggested_name),
                            initial_dir,
                        );
                        if let Some(path) = dialog.save_file() {
                            let is_pdf = path
                                .extension()
                                .map(|e| e.eq_ignore_ascii_case("pdf"))
                                .unwrap_or(false);
                            if is_pdf {
                                // PDF must be produced on the UI thread (COM STA);
                                // hand off to the main loop.
                                let _ = export_proxy.send_event(CustomEvent::PrintPdf(path));
                            } else {
                                match std::fs::write(&path, p.html.as_bytes()) {
                                    Ok(()) => {
                                        if let Some(base) = path.parent() {
                                            copy_export_media(base, &p.media);
                                        }
                                        open_with_default(&path);
                                    }
                                    Err(e) => eprintln!("export: failed to write {}: {}", path.display(), e),
                                }
                            }
                        }
                    });
                }
                Err(e) => eprintln!("export: bad payload: {}", e),
            }
        } else if message == "fullscreen:toggle" {
            if let Err(e) = ipc_event_proxy.send_event(CustomEvent::ToggleFullscreen) {
                eprintln!("Failed to dispatch ToggleFullscreen: {}", e);
            }
        } else if message == "pdfprintready:" {
            // Preview finished swapping <video> → still frames; run the print now.
            if let Err(e) = ipc_event_proxy.send_event(CustomEvent::PrintPdfNow) {
                eprintln!("Failed to dispatch PrintPdfNow: {}", e);
            }
        } else if message == "openinstalldir:" {
            // Open the install directory (exe + assets) in Explorer (Ctrl+D).
            // Off-thread like the other dialog/spawn handlers so the IPC thread
            // is never blocked.
            let dir = ipc_install_dir.clone();
            std::thread::spawn(move || {
                if let Err(e) = std::process::Command::new("explorer").arg(&dir).spawn() {
                    eprintln!("openinstalldir: failed to open {}: {}", dir.display(), e);
                }
            });
        } else if message == "update:install" {
            // User accepted the update banner. Launch the (prefetched) silent
            // installer + relaunch, then quit so the running exe unlocks for
            // in-place replacement. Windows-only (updater is cfg(windows)).
            #[cfg(windows)]
            {
                let ready = ipc_update_ready.lock().unwrap().clone();
                if let Some(r) = ready {
                    let exe = ipc_exe_path.clone();
                    let open_file = ipc_current_file.lock().unwrap().clone();
                    let proxy = ipc_event_proxy.clone();
                    std::thread::spawn(move || {
                        match updater::launch_installer_and_relaunch(
                            &r.setup_temp,
                            &exe,
                            open_file.as_deref(),
                        ) {
                            Ok(()) => {
                                let _ = proxy.send_event(CustomEvent::QuitForUpdate);
                            }
                            Err(e) => {
                                eprintln!("update:install: failed to launch installer: {}", e);
                            }
                        }
                    });
                }
            }
        } else if message == "newfile:" {
            // New document (Ctrl+N) — pick a save location via a native dialog,
            // create a blank `.md`, then open it through the normal OpenFile flow.
            let initial_dir = current_file_dir(&ipc_current_file);
            let proxy = ipc_event_proxy.clone();
            // rfd's save_file() blocks; run it off the IPC thread (same pattern as
            // the `exporthtml:` / `exportdir:` handlers).
            std::thread::spawn(move || {
                let dialog = with_initial_dir(
                    rfd::FileDialog::new()
                        .add_filter("Markdown", &["md", "markdown"])
                        .set_file_name("untitled.md"),
                    initial_dir,
                );
                if let Some(mut path) = dialog.save_file() {
                    // Ensure a markdown extension so the OpenFile handler accepts it.
                    let ok_ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| {
                            let e = e.to_ascii_lowercase();
                            e == "md" || e == "markdown"
                        })
                        .unwrap_or(false);
                    if !ok_ext {
                        path.set_extension("md");
                    }
                    // Create an empty file only for a new path. If the chosen path
                    // already exists, open it as-is (never truncate existing content).
                    if !path.exists() {
                        if let Err(e) = std::fs::write(&path, b"") {
                            eprintln!("newfile: failed to create {}: {}", path.display(), e);
                            return;
                        }
                    }
                    let _ = proxy.send_event(CustomEvent::OpenFile(path));
                }
            });
        } else if let Some(line_str) = message.strip_prefix("openeditor:") {
            let line = line_str.trim().parse::<u32>().unwrap_or(1);
            if let Err(e) = ipc_event_proxy.send_event(CustomEvent::OpenEditorWindow { line }) {
                eprintln!("Failed to dispatch OpenEditorWindow: {}", e);
            }
        } else if let Some(line_str) = message.strip_prefix("jumpto:") {
            // Preview click → tell the paired editor to jump to this line.
            if let Ok(line) = line_str.trim().parse::<u32>() {
                let cur = ipc_current_file.lock().unwrap().clone();
                if let Some(path) = cur {
                    ipc_editor_registry.push_jump_to_editor(&path, line);
                }
            }
        } else if let Some(payload) = message.strip_prefix("editor:save:") {
            // Editor saved → write to disk, suppress watcher, then re-render preview.
            #[derive(Deserialize)]
            struct SavePayload { path: String, content: String }
            match serde_json::from_str::<SavePayload>(payload) {
                Ok(p) => {
                    let path = PathBuf::from(&p.path);
                    match write_suppressed(&path, p.content.as_bytes(), &ipc_suppressed_saves) {
                        Ok(()) => {
                            let _ = ipc_event_proxy.send_event(CustomEvent::EditorSavedContent {
                                path,
                                content: p.content,
                            });
                        }
                        Err(e) => eprintln!("editor:save: failed: {}", e),
                    }
                }
                Err(e) => eprintln!("editor:save: bad payload: {}", e),
            }
        } else if let Some(payload) = message.strip_prefix("savefile:") {
            // Preview-initiated file write (currently used by the S-key Marp
            // theme picker to rewrite the front-matter `theme:` line). Same
            // disk write + watcher suppression as `editor:save:`, but also
            // pushes the new content into the paired editor (if any) so its
            // buffer doesn't drift from disk.
            #[derive(Deserialize)]
            struct SaveFilePayload { path: String, content: String }
            match serde_json::from_str::<SaveFilePayload>(payload) {
                Ok(p) => {
                    let path = PathBuf::from(&p.path);
                    match write_suppressed(&path, p.content.as_bytes(), &ipc_suppressed_saves) {
                        Ok(()) => {
                            ipc_editor_registry.push_file_to_editor(&path, &p.content);
                            let _ = ipc_event_proxy.send_event(CustomEvent::EditorSavedContent {
                                path,
                                content: p.content,
                            });
                        }
                        Err(e) => eprintln!("savefile: write failed: {}", e),
                    }
                }
                Err(e) => eprintln!("savefile: bad payload: {}", e),
            }
        } else if let Some(line_str) = message.strip_prefix("editor:cursor:") {
            if let Ok(line) = line_str.trim().parse::<u32>() {
                let _ = ipc_event_proxy.send_event(CustomEvent::EditorCursorMoved { line });
            }
        } else if message == "editor:close:" {
            let _ = ipc_event_proxy.send_event(CustomEvent::EditorCloseRequested);
        } else if message == "csvwatchreset:" {
            let _ = ipc_event_proxy.send_event(CustomEvent::CsvWatchReset);
        } else if let Some(rel) = message.strip_prefix("csvwatch:") {
            // Resolve the (probably-relative) path against the directory of the
            // currently-loaded .md so the watcher can monitor it.
            let raw = PathBuf::from(rel);
            let abs = if raw.is_absolute() {
                Some(raw)
            } else {
                current_file_dir(&ipc_current_file).map(|d| d.join(&raw))
            };
            if let Some(p) = abs {
                let _ = ipc_event_proxy.send_event(CustomEvent::CsvWatch(p));
            }
        } else if let Some(payload) = message.strip_prefix("renderdone:") {
            // Capture mode: initial render (incl. async Marp/mermaid/KaTeX) has
            // settled. Kick off the per-slide capture loop.
            #[derive(Deserialize)]
            struct RenderDoneMsg { marp: bool, slides: usize }
            match serde_json::from_str::<RenderDoneMsg>(payload) {
                Ok(m) => {
                    let _ = ipc_event_proxy.send_event(CustomEvent::CaptureStart {
                        marp: m.marp,
                        slides: m.slides,
                    });
                }
                Err(e) => dbg_log!("renderdone: bad payload: {}", e),
            }
        } else if let Some(payload) = message.strip_prefix("captureready:") {
            // Capture mode: the preview has isolated slide `index` at 1280x720
            // and reports its clip rect + layout metrics. Hand off to the event
            // loop, which owns the webview lock for the CDP screenshot call.
            #[derive(Deserialize)]
            struct CaptureReadyMsg {
                index: usize,
                clip: CaptureClip,
                #[serde(default)]
                layout: Option<SlideLayout>,
            }
            match serde_json::from_str::<CaptureReadyMsg>(payload) {
                Ok(m) => {
                    let _ = ipc_event_proxy.send_event(CustomEvent::CaptureReady {
                        index: m.index,
                        clip: m.clip,
                        layout: m.layout,
                    });
                }
                Err(e) => dbg_log!("captureready: bad payload: {}", e),
            }
        }
    });

    // Drag-and-drop opening. On Windows, WebView2's own HTML5 drag-drop consumes
    // file drops over the webview, so JS `drop` events never carry a file path
    // (and only folders, which HTML5 can't accept, used to bubble up to tao's
    // `WindowEvent::DroppedFile`). Registering a wry file-drop handler revokes
    // WebView2's drop target and hands us the dropped items' real absolute paths —
    // the only way to learn a dropped file's path. We route them through the same
    // OpenDirectory / OpenFile / OpenImage pipelines as double-click / CLI /
    // cross-file navigation, so `current_dir` / `current_file`, the file watcher,
    // and the editor pairing are all set up identically (pressing `E` then opens
    // the companion editor on a dropped file). Preference: directory > markdown >
    // image; other files are ignored. NOTE: this disables the webview's HTML5
    // drag-drop, so the JS `handleDrop` path in assets/index.html is now a
    // no-op fallback only.
    let file_drop_event_proxy = event_proxy.clone();
    webview_builder = webview_builder.with_file_drop_handler(move |_window, event| {
        if let wry::webview::FileDropEvent::Dropped(paths) = event {
            if let Some(dir) = paths.iter().find(|p| p.is_dir()) {
                let _ = file_drop_event_proxy.send_event(CustomEvent::OpenDirectory(dir.clone()));
            } else if let Some(md) = paths.iter().find(|p| is_markdown_ext(p)) {
                let _ = file_drop_event_proxy.send_event(CustomEvent::OpenFile(md.clone()));
            } else if let Some(mdx) = paths.iter().find(|p| mdx::is_mdx_ext(p)) {
                let _ = file_drop_event_proxy.send_event(CustomEvent::OpenFile(mdx.clone()));
            } else if let Some(img) = paths.iter().find(|p| is_image_ext(p)) {
                let _ = file_drop_event_proxy.send_event(CustomEvent::OpenImage(img.clone()));
            }
        }
        // The return value is ignored by wry's Windows webview2 file-drop impl
        // (the drop is always consumed since WebView2's HTML5 DnD was revoked).
        false
    });

    // Add initialization script if we have a file to load
    if !init_script.is_empty() {
        webview_builder = webview_builder.with_initialization_script(&init_script);
    }

    let webview = webview_builder.build()?;
    let webview = Arc::new(Mutex::new(webview));

    // Setup swappable file watcher
    let (watcher_tx, watcher_rx) = std::sync::mpsc::channel();
    let watcher: Arc<Mutex<Option<RecommendedWatcher>>> = Arc::new(Mutex::new(
        recommended_watcher(watcher_tx).map_err(|e| {
            eprintln!("Failed to create file watcher: {}", e);
            e
        }).ok()
    ));
    let watched_path: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    // Tracks whether the active watch is a directory (workspace mode) or a file.
    let watched_is_dir: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    // External CSV/TSV files referenced by ```plotly blocks in the current
    // document. The preview JS re-populates this set every render via the
    // CsvWatch / CsvWatchReset events. Used by the watcher thread to trigger
    // a re-render of the active .md when any tracked CSV changes on disk.
    let watched_csvs: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));

    // Initial watch: directory if workspace was provided, else the file.
    if let Some(ref dpath) = dir_path {
        if let Some(w) = watcher.lock().unwrap().as_mut() {
            match w.watch(dpath, RecursiveMode::Recursive) {
                Ok(()) => {
                    *watched_path.lock().unwrap() = Some(dpath.clone());
                    *watched_is_dir.lock().unwrap() = true;
                }
                Err(e) => eprintln!("Failed to watch directory: {}", e),
            }
        }
    } else if let Some(ref path) = file_path {
        // For an `.mdx` bundle, watch the archive itself (not the extracted
        // temp entry) so external edits to the `.mdx` trigger a re-extract.
        let watch_target = mdx_session
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.mdx_path.clone())
            .unwrap_or_else(|| path.clone());
        if let Some(w) = watcher.lock().unwrap().as_mut() {
            match w.watch(&watch_target, RecursiveMode::NonRecursive) {
                Ok(()) => *watched_path.lock().unwrap() = Some(watch_target),
                Err(e) => eprintln!("Failed to watch file: {}", e),
            }
        }
    }

    // Spawn receiver thread that forwards notify events to the event loop.
    // In dir mode: distinguish between "active file modified" (FileChanged) and
    // "other .md file created/removed/renamed" (DirectoryChanged → tree rebuild).
    {
        let event_proxy_clone = event_proxy.clone();
        let watched_path_clone = watched_path.clone();
        let watched_is_dir_clone = watched_is_dir.clone();
        let current_file_clone = current_file.clone();
        let suppressed = suppressed_saves.clone();
        let watched_csvs_clone = watched_csvs.clone();
        std::thread::spawn(move || {
            loop {
                match watcher_rx.recv() {
                    Ok(Ok(event)) => {
                        let is_dir = *watched_is_dir_clone.lock().unwrap();
                        let kind = event.kind.clone();
                        let paths = event.paths.clone();
                        // Suppress events for paths we just saved ourselves.
                        let all_suppressed = {
                            let s = suppressed.lock().unwrap();
                            !paths.is_empty() && paths.iter().all(|p| s.contains(p))
                        };
                        if all_suppressed { continue; }
                        if is_dir {
                            // Workspace mode: branch by event kind.
                            let mut tree_dirty = false;
                            let mut active_dirty = false;
                            let cur = current_file_clone.lock().unwrap().clone();
                            let csvs = watched_csvs_clone.lock().unwrap().clone();
                            for p in &paths {
                                let is_md = is_markdown_ext(p);
                                let is_tracked_csv = csvs.iter().any(|c| paths_equal(p, c));
                                match &kind {
                                    notify::EventKind::Create(_) | notify::EventKind::Remove(_) => {
                                        if is_md || p.is_dir() { tree_dirty = true; }
                                    }
                                    notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                                        tree_dirty = true;
                                    }
                                    notify::EventKind::Modify(_) => {
                                        if let Some(c) = cur.as_ref() {
                                            if paths_equal(p, c) { active_dirty = true; }
                                        }
                                        if is_tracked_csv { active_dirty = true; }
                                        // Any .md edit may change its heading list,
                                        // so refresh the sidebar tree too.
                                        if is_md { tree_dirty = true; }
                                    }
                                    _ => {}
                                }
                            }
                            if active_dirty {
                                if let Some(p) = cur {
                                    let _ = event_proxy_clone.send_event(CustomEvent::FileChanged(p));
                                }
                            }
                            if tree_dirty {
                                let _ = event_proxy_clone.send_event(CustomEvent::DirectoryChanged);
                            }
                            std::thread::sleep(Duration::from_millis(150));
                            while watcher_rx.try_recv().is_ok() {}
                        } else {
                            match kind {
                                notify::EventKind::Modify(_) | notify::EventKind::Create(_) => {
                                    // Event paths from notify may belong to the watched
                                    // .md, a tracked CSV, or noise we don't care about.
                                    // In all "fire a re-render" cases we re-render the
                                    // active .md, since the CSV is consumed by its
                                    // ```plotly blocks.
                                    let active = watched_path_clone.lock().unwrap().clone();
                                    let csvs = watched_csvs_clone.lock().unwrap().clone();
                                    let should_fire = paths.iter().any(|p| {
                                        active.as_ref().map_or(false, |a| paths_equal(p, a))
                                            || csvs.iter().any(|c| paths_equal(p, c))
                                    }) || paths.is_empty(); // empty path list → fall back to active
                                    if should_fire {
                                        if let Some(p) = active {
                                            if let Err(e) = event_proxy_clone.send_event(CustomEvent::FileChanged(p)) {
                                                eprintln!("Failed to send file change event: {}", e);
                                                break;
                                            }
                                        }
                                    }
                                    std::thread::sleep(Duration::from_millis(100));
                                    while watcher_rx.try_recv().is_ok() {}
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(Err(e)) => eprintln!("Watch error: {}", e),
                    Err(e) => {
                        eprintln!("Channel error: {}", e);
                        break;
                    }
                }
            }
        });
    }

    // Editor-window builder context. The editor is spawned lazily on the first
    // 'E' keypress and lives in `editor_registry` thereafter. Only these two need
    // their own binding: `assets_dir` is not otherwise used inside the event loop
    // (so it moves), and `suppressed_saves` is reached only through this alias.
    // `event_proxy` / `current_file` / `current_dir` are captured by the closure
    // directly, so aliasing them here would just be an extra clone.
    let editor_assets_dir = assets_dir;
    // Also used by the event loop to repack saves back into an open `.mdx` bundle.
    let evloop_suppressed = suppressed_saves.clone();
    // Capture config consumed by the CaptureStart arm (moved in — unused after).
    let evloop_capture_config = capture_config;

    // Run event loop
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                // If the editor window was closed, just drop it. If the preview
                // (main) window was closed, exit.
                if editor_registry.is_editor_window(window_id) {
                    if let Some(path) = editor_registry.close_take_dirty_path() {
                        if path.exists() {
                            load_and_render(&path, &webview, &current_dir, &current_file, &editor_registry);
                        }
                    }
                } else {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::WindowEvent {
                event: WindowEvent::DroppedFile(path),
                ..
            } => {
                // Drag-drop is normally handled by the wry file-drop handler
                // registered on the webview (see `with_file_drop_handler` above),
                // which has the real paths and routes folders / markdown / images.
                // This tao-level event is a fallback for any drop that bypasses it;
                // keep it folder-only as before.
                if path.is_dir() {
                    let _ = event_proxy.send_event(CustomEvent::OpenDirectory(path));
                }
            }
            Event::UserEvent(CustomEvent::ToggleFullscreen) => {
                if let Ok(wv) = webview.lock() {
                    let win = wv.window();
                    let next = if win.fullscreen().is_some() {
                        None
                    } else {
                        Some(tao::window::Fullscreen::Borderless(None))
                    };
                    win.set_fullscreen(next);
                }
            }
            Event::UserEvent(CustomEvent::FileChanged(path)) => {
                if mdx::is_mdx_ext(&path) {
                    // The watched `.mdx` changed on disk (external edit) —
                    // re-extract into a fresh temp dir and re-render its entry.
                    match mdx::open_mdx(&path) {
                        Ok(sess) => {
                            let entry = sess.entry.clone();
                            let display = path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string());
                            *mdx_session.lock().unwrap() = Some(sess);
                            load_and_render_named(
                                &entry,
                                display.as_deref(),
                                &webview,
                                &current_dir,
                                &current_file,
                                &editor_registry,
                            );
                        }
                        Err(e) => eprintln!("mdx: re-extract failed for {:?}: {}", path, e),
                    }
                } else {
                    load_and_render(&path, &webview, &current_dir, &current_file, &editor_registry);
                }
            }
            Event::UserEvent(CustomEvent::CsvWatchReset) => {
                // Flush all CSV watches. In workspace mode the root is watched
                // recursively so unwatching individual files would error — just
                // clear the membership set so the watcher thread stops triggering
                // re-renders for the previous document's CSVs.
                let prev: Vec<PathBuf> = {
                    let mut set = watched_csvs.lock().unwrap();
                    let v = set.iter().cloned().collect();
                    set.clear();
                    v
                };
                if !*watched_is_dir.lock().unwrap() {
                    if let Some(w) = watcher.lock().unwrap().as_mut() {
                        for p in &prev { let _ = w.unwatch(p); }
                    }
                }
            }
            Event::UserEvent(CustomEvent::CsvWatch(path)) => {
                let already = {
                    let mut set = watched_csvs.lock().unwrap();
                    if set.contains(&path) { true } else { set.insert(path.clone()); false }
                };
                if !already && !*watched_is_dir.lock().unwrap() {
                    if let Some(w) = watcher.lock().unwrap().as_mut() {
                        if let Err(e) = w.watch(&path, RecursiveMode::NonRecursive) {
                            eprintln!("Failed to watch CSV {:?}: {}", path, e);
                        }
                    }
                }
            }
            Event::UserEvent(CustomEvent::PrintPdf(path)) => {
                // Stash the target and ask the preview to rasterize its <video>
                // elements to still frames; the JS posts `pdfprintready:` when the
                // DOM is ready → PrintPdfNow performs the actual print. The handshake
                // is a no-op (immediate ready) for documents without videos.
                *pending_pdf.lock().unwrap() = Some(path);
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script("window.__beforePdfPrint && window.__beforePdfPrint()");
                }
            }
            Event::UserEvent(CustomEvent::PrintPdfNow) => {
                let path = pending_pdf.lock().unwrap().take();
                if let Some(path) = path {
                    // Print the live webview to PDF on the UI thread (COM STA).
                    #[cfg(windows)]
                    {
                        if let Ok(wv) = webview.lock() {
                            pdf_win::print_current_to_pdf(&wv, path, event_proxy.clone());
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = path;
                    }
                }
            }
            Event::UserEvent(CustomEvent::PdfExportDone { ok, path }) => {
                // Restore the swapped-out <video> elements (undo __beforePdfPrint).
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name_js = serde_json::to_string(&name).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "window.__afterPdfPrint && window.__afterPdfPrint(); window.__pdfExportDone && window.__pdfExportDone({}, {});",
                    ok, name_js
                );
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&script);
                }
                if ok {
                    open_with_default(&path);
                }
            }
            Event::UserEvent(CustomEvent::UpdateAvailable { version, notes }) => {
                // Background startup check found a newer version → show the
                // preview's update banner (the JS gates on its own opt-out flag).
                let info = serde_json::to_string(&serde_json::json!({
                    "version": version,
                    "notes": notes,
                }))
                .unwrap_or_else(|_| "{}".to_string());
                let script = format!(
                    "window.__updateAvailable && window.__updateAvailable({});",
                    info
                );
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&script);
                }
            }
            Event::UserEvent(CustomEvent::QuitForUpdate) => {
                // The silent installer has been launched; exit so the running
                // exe unlocks for in-place replacement (the installer relaunches
                // the new exe afterwards).
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(CustomEvent::CaptureStart { marp, slides }) => {
                // `--export-png`: the initial render settled. Build the capture
                // plan and ask the preview to isolate the first target slide.
                let cfg = match &evloop_capture_config {
                    Some(c) => c.clone(),
                    None => return,
                };
                if let Err(e) = std::fs::create_dir_all(&cfg.out_dir) {
                    dbg_log!("capture: create_dir_all {:?} failed: {}", cfg.out_dir, e);
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                // Marp: one PNG per (selected) slide. Non-Marp: a single
                // full-page PNG (index 0).
                let indices: Vec<usize> = if marp {
                    parse_slides_spec(&cfg.slides_spec, slides)
                } else {
                    vec![0]
                };
                if indices.is_empty() {
                    dbg_log!("capture: no slides to capture (marp={}, slides={})", marp, slides);
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                let first = indices[0];
                *capture_state.lock().unwrap() = Some(CaptureState {
                    out_dir: cfg.out_dir.clone(),
                    scale: cfg.scale,
                    marp,
                    indices,
                    cursor: 0,
                    layouts: Vec::new(),
                });
                dbg_log!("capture: start marp={} slides={} first={}", marp, slides, first);
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&format!("window.__prepareCapture({});", first));
                }
            }
            Event::UserEvent(CustomEvent::CaptureReady { index, clip, layout }) => {
                // The preview isolated slide `index`; capture it via CDP.
                dbg_log!("capture: ready index={} clip=({},{},{},{})", index, clip.x, clip.y, clip.width, clip.height);
                let (out_path, scale) = {
                    let mut guard = capture_state.lock().unwrap();
                    let st = match guard.as_mut() {
                        Some(s) => s,
                        None => return,
                    };
                    if let Some(mut l) = layout {
                        l.index = index + 1;
                        l.file = slide_png_name(st.marp, index);
                        st.layouts.push(l);
                    }
                    (st.out_dir.join(slide_png_name(st.marp, index)), st.scale)
                };
                #[cfg(windows)]
                {
                    dbg_log!("capture: invoking CDP screenshot -> {:?}", out_path);
                    if let Ok(wv) = webview.lock() {
                        png_win::capture_clip_to_png(
                            &wv,
                            out_path,
                            (clip.x, clip.y, clip.width, clip.height),
                            scale,
                            index,
                            event_proxy.clone(),
                        );
                    }
                }
                #[cfg(not(windows))]
                {
                    let _ = (out_path, scale, clip);
                    let _ = event_proxy.send_event(CustomEvent::CaptureDone { index, ok: false });
                }
            }
            Event::UserEvent(CustomEvent::CaptureDone { index, ok }) => {
                if !ok {
                    dbg_log!("capture: slide index={} FAILED", index);
                }
                // Advance the loop: next slide, or finish (write layout.json, exit).
                let next: Option<usize> = {
                    let mut guard = capture_state.lock().unwrap();
                    match guard.as_mut() {
                        Some(st) => {
                            st.cursor += 1;
                            st.indices.get(st.cursor).copied()
                        }
                        None => None,
                    }
                };
                match next {
                    Some(n) => {
                        if let Ok(wv) = webview.lock() {
                            let _ = wv.evaluate_script(&format!("window.__prepareCapture({});", n));
                        }
                    }
                    None => {
                        if let Some(st) = capture_state.lock().unwrap().as_ref() {
                            let report = serde_json::json!({
                                "marp": st.marp,
                                "slides": st.layouts,
                            });
                            let path = st.out_dir.join("layout.json");
                            match serde_json::to_string_pretty(&report) {
                                Ok(s) => {
                                    if let Err(e) = std::fs::write(&path, s.as_bytes()) {
                                        dbg_log!("capture: write layout.json failed: {}", e);
                                    }
                                }
                                Err(e) => dbg_log!("capture: serialize layout.json failed: {}", e),
                            }
                            dbg_log!("capture: done, {} PNG(s) in {:?}", st.indices.len(), st.out_dir);
                        }
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::UserEvent(CustomEvent::OpenEditorWindow { line }) => {
                if editor_registry.is_open() {
                    editor_registry.focus();
                    // Re-sync the already-open editor's cursor to the previewed line.
                    let cur = current_file.lock().unwrap().clone();
                    if let Some(path) = cur {
                        editor_registry.push_jump_to_editor(&path, line);
                    }
                    return;
                }
                let cur = current_file.lock().unwrap().clone();
                if let Some(path) = cur {
                    if let Err(e) = editor_registry::spawn_editor_window(
                        target,
                        &editor_assets_dir,
                        event_proxy.clone(),
                        editor_registry.clone(),
                        current_file.clone(),
                        evloop_suppressed.clone(),
                        &path,
                        line,
                    ) {
                        eprintln!("Failed to spawn editor window: {}", e);
                    }
                } else {
                    eprintln!("openeditor: no file is currently loaded");
                }
            }
            Event::UserEvent(CustomEvent::EditorCloseRequested) => {
                if let Some(path) = editor_registry.close_take_dirty_path() {
                    if path.exists() {
                        load_and_render(&path, &webview, &current_dir, &current_file, &editor_registry);
                    }
                }
            }
            Event::UserEvent(CustomEvent::EditorImeStatus(open)) => {
                editor_registry.push_ime_status(open);
            }
            Event::UserEvent(CustomEvent::EditorCursorMoved { line }) => {
                // Editor → preview: scroll preview to mirror cursor line.
                if let Ok(wv) = webview.lock() {
                    eval_js_fn(&wv, "applyEditorScroll", &[&line.to_string()]);
                }
            }
            Event::UserEvent(CustomEvent::EditorSavedContent { path, content }) => {
                // Update current_dir for relative image resolution.
                if let Some(parent) = path.parent() {
                    *current_dir.lock().unwrap() = Some(parent.to_path_buf());
                }
                // If this save belongs to an open `.mdx`, keep the `.mdx` name in
                // the title instead of the extracted entry's name.
                let mdx_name: Option<String> = {
                    let g = mdx_session.lock().unwrap();
                    g.as_ref()
                        .filter(|s| {
                            paths_equal(&path, &s.entry) || path.starts_with(s.temp.path())
                        })
                        .and_then(|s| {
                            s.mdx_path.file_name().map(|n| n.to_string_lossy().to_string())
                        })
                };
                let filename = mdx_name
                    .or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "Unknown".to_string());
                let script = build_load_file_script(
                    &filename, &path.to_string_lossy(), &content,
                );
                if let Ok(wv) = webview.lock() {
                    wv.window().set_title(&format_title(Some(&filename)));
                    let _ = wv.evaluate_script(&script);
                }
                *current_file.lock().unwrap() = Some(path.clone());
                // Persist the edit back into the source `.mdx` bundle, if any.
                maybe_repack_mdx(&path, &mdx_session, &evloop_suppressed);
            }
            Event::UserEvent(CustomEvent::EditorLiveContent { path, content, line }) => {
                // Live (unsaved) editor content — re-render preview from memory
                // and re-anchor scroll to the cursor line. Skip disk, title,
                // and current_file updates (path is already the paired file).
                let filename = path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());
                // One script, so the re-render and the scroll re-anchor land in
                // the same evaluation and the preview never paints in between.
                let script = format!(
                    "{} {}",
                    build_load_file_script(&filename, &path.to_string_lossy(), &content),
                    js_call("applyEditorScroll", &[&line.to_string()]),
                );
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&script);
                }
            }
            Event::UserEvent(CustomEvent::OpenFile(path)) => {
                let abs_path = to_abs(&path);

                if !abs_path.exists() || !abs_path.is_file() {
                    eprintln!("OpenFile: not a file: {:?}", abs_path);
                    return;
                }

                // `.mdx` bundle: extract to a temp dir, watch the archive (so
                // external edits re-extract), and render its entry `.md`.
                if mdx::is_mdx_ext(&abs_path) {
                    match mdx::open_mdx(&abs_path) {
                        Ok(sess) => {
                            let entry = sess.entry.clone();
                            let display =
                                abs_path.file_name().map(|n| n.to_string_lossy().to_string());
                            let in_workspace = workspace.lock().unwrap().is_some();
                            if !in_workspace {
                                if let Some(w) = watcher.lock().unwrap().as_mut() {
                                    let old = watched_path.lock().unwrap().clone();
                                    if let Some(old_path) = old {
                                        let _ = w.unwatch(&old_path);
                                    }
                                    match w.watch(&abs_path, RecursiveMode::NonRecursive) {
                                        Ok(()) => {
                                            *watched_path.lock().unwrap() = Some(abs_path.clone());
                                            *watched_is_dir.lock().unwrap() = false;
                                        }
                                        Err(e) => eprintln!("Failed to watch .mdx: {}", e),
                                    }
                                }
                            }
                            *mdx_session.lock().unwrap() = Some(sess);
                            load_and_render_named(
                                &entry,
                                display.as_deref(),
                                &webview,
                                &current_dir,
                                &current_file,
                                &editor_registry,
                            );
                        }
                        Err(e) => eprintln!("OpenFile: failed to open .mdx {:?}: {}", abs_path, e),
                    }
                    return;
                }

                if !is_markdown_ext(&abs_path) {
                    eprintln!("OpenFile: not a markdown file: {:?}", abs_path);
                    return;
                }

                // Switching to a plain `.md` ends any active `.mdx` session
                // (drops the temp dir).
                *mdx_session.lock().unwrap() = None;

                // Swap watcher target only if we are NOT in workspace mode.
                // In workspace mode the recursive watch on the root already
                // covers every file, so we keep that watch alive.
                let in_workspace = workspace.lock().unwrap().is_some();
                if !in_workspace {
                    if let Some(w) = watcher.lock().unwrap().as_mut() {
                        let old = watched_path.lock().unwrap().clone();
                        if let Some(old_path) = old {
                            let _ = w.unwatch(&old_path);
                        }
                        match w.watch(&abs_path, RecursiveMode::NonRecursive) {
                            Ok(()) => {
                                *watched_path.lock().unwrap() = Some(abs_path.clone());
                                *watched_is_dir.lock().unwrap() = false;
                            }
                            Err(e) => eprintln!("Failed to watch new file: {}", e),
                        }
                    }
                }

                load_and_render(&abs_path, &webview, &current_dir, &current_file, &editor_registry);

                // Highlight the active file in the file tree.
                if in_workspace {
                    let abs_str = serde_json::to_string(&abs_path.to_string_lossy().to_string())
                        .unwrap_or_else(|_| "\"\"".into());
                    if let Ok(wv) = webview.lock() {
                        eval_js_fn(&wv, "__setActiveFile", &[&abs_str]);
                    }
                }
            }
            Event::UserEvent(CustomEvent::OpenImage(path)) => {
                let abs_path = to_abs(&path);
                if !abs_path.exists() || !abs_path.is_file() {
                    eprintln!("OpenImage: not a file: {:?}", abs_path);
                    return;
                }
                // Point current_dir at the image's folder so the `/userfile/` route
                // resolves the bare filename, then ask the webview to display it.
                if let Some(parent) = abs_path.parent() {
                    *current_dir.lock().unwrap() = Some(parent.to_path_buf());
                }
                // A dropped image is not a markdown document: clear current_file so
                // the editor has nothing to (incorrectly) pair with.
                *current_file.lock().unwrap() = None;
                let name = abs_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name_json = serde_json::to_string(&name).unwrap_or_else(|_| "\"\"".into());
                if let Ok(wv) = webview.lock() {
                    wv.window().set_title(&format_title(Some(&name)));
                    eval_js_fn(&wv, "loadImageFromRust", &[&name_json]);
                }
            }
            Event::UserEvent(CustomEvent::OpenDirectory(path)) => {
                let abs_path = to_abs(&path);
                if !abs_path.exists() || !abs_path.is_dir() {
                    eprintln!("OpenDirectory: not a directory: {:?}", abs_path);
                    return;
                }
                let ws = build_workspace(&abs_path);
                let first = ws.first_file.clone();
                *workspace.lock().unwrap() = Some(ws.clone());

                // Swap watcher: drop any previous (file or dir) watch, install recursive.
                if let Some(w) = watcher.lock().unwrap().as_mut() {
                    let old = watched_path.lock().unwrap().clone();
                    if let Some(old_path) = old {
                        let _ = w.unwatch(&old_path);
                    }
                    match w.watch(&abs_path, RecursiveMode::Recursive) {
                        Ok(()) => {
                            *watched_path.lock().unwrap() = Some(abs_path.clone());
                            *watched_is_dir.lock().unwrap() = true;
                        }
                        Err(e) => eprintln!("Failed to watch directory: {}", e),
                    }
                }

                // Push workspace to the webview.
                let json = serde_json::to_string(&ws).unwrap_or_else(|_| "null".into());
                if let Ok(wv) = webview.lock() {
                    eval_js_fn(&wv, "loadDirectoryFromRust", &[&json]);
                }

                if let Some(first) = first {
                    let p = PathBuf::from(first);
                    load_and_render(&p, &webview, &current_dir, &current_file, &editor_registry);
                    let abs_str = serde_json::to_string(&p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| "\"\"".into());
                    if let Ok(wv) = webview.lock() {
                        eval_js_fn(&wv, "__setActiveFile", &[&abs_str]);
                    }
                }
            }
            Event::UserEvent(CustomEvent::DirectoryChanged) => {
                // Rebuild the workspace tree (preserve root) and push to webview.
                let root = workspace.lock().unwrap().as_ref().map(|w| PathBuf::from(&w.root));
                if let Some(root) = root {
                    if root.is_dir() {
                        let ws = build_workspace(&root);
                        *workspace.lock().unwrap() = Some(ws.clone());
                        let json = serde_json::to_string(&ws).unwrap_or_else(|_| "null".into());
                        if let Ok(wv) = webview.lock() {
                            eval_js_fn(&wv, "refreshFileTree", &[&json]);
                        }
                    }
                }
            }
            _ => (),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_slides_spec -------------------------------------------------

    fn slides(spec: &str, count: usize) -> Vec<usize> {
        parse_slides_spec(&Some(spec.to_string()), count)
    }

    #[test]
    fn slides_spec_absent_or_blank_selects_everything() {
        assert_eq!(parse_slides_spec(&None, 3), vec![0, 1, 2]);
        assert_eq!(slides("", 3), vec![0, 1, 2]);
        assert_eq!(slides("   ", 3), vec![0, 1, 2]);
        assert_eq!(parse_slides_spec(&None, 0), Vec::<usize>::new());
    }

    #[test]
    fn slides_spec_parses_lists_and_ranges() {
        assert_eq!(slides("1,3", 5), vec![0, 2]);
        assert_eq!(slides("5-7", 8), vec![4, 5, 6]);
        assert_eq!(slides("1, 2 , 3", 5), vec![0, 1, 2]);
        assert_eq!(slides("2-2", 5), vec![1]);
    }

    #[test]
    fn slides_spec_reverses_descending_ranges_but_keeps_ascending_output() {
        // `5-3` is accepted and normalized to 3..=5, so the emitted order is
        // ascending -- NOT the reversed 5,4,3 one might expect from the spelling.
        assert_eq!(slides("5-3", 8), vec![2, 3, 4]);
    }

    #[test]
    fn slides_spec_dedupes_and_preserves_first_seen_order() {
        assert_eq!(slides("1,1,2", 5), vec![0, 1]);
        assert_eq!(slides("3,1", 5), vec![2, 0]);
        assert_eq!(slides("2-4,3", 5), vec![1, 2, 3]);
    }

    #[test]
    fn slides_spec_drops_out_of_range_and_malformed_parts() {
        assert_eq!(slides("0,99", 3), Vec::<usize>::new()); // 1-based: 0 is invalid
        assert_eq!(slides("1,99", 3), vec![0]);
        assert_eq!(slides("abc", 3), Vec::<usize>::new());
        assert_eq!(slides("1,,2", 3), vec![0, 1]);
        // Open-ended ranges are NOT supported: `split_once('-')` succeeds but the
        // empty side fails to parse, so the whole part is silently dropped.
        assert_eq!(slides("-3", 5), Vec::<usize>::new());
        assert_eq!(slides("3-", 5), Vec::<usize>::new());
    }

    // ---- slide_png_name ----------------------------------------------------

    #[test]
    fn slide_png_name_is_one_based_and_zero_padded() {
        // layout.json consumers depend on this exact naming.
        assert_eq!(slide_png_name(true, 0), "slide-01.png");
        assert_eq!(slide_png_name(true, 9), "slide-10.png");
        assert_eq!(slide_png_name(true, 99), "slide-100.png");
        assert_eq!(slide_png_name(false, 5), "page.png");
    }

    // ---- format_title ------------------------------------------------------

    #[test]
    fn format_title_uses_em_dash_and_falls_back_to_app_name() {
        assert_eq!(format_title(Some("a.md")), "a.md \u{2014} Markdown Previewer");
        assert_eq!(format_title(Some("")), "Markdown Previewer");
        assert_eq!(format_title(None), "Markdown Previewer");
    }

    // ---- paths_equal -------------------------------------------------------

    #[test]
    fn paths_equal_folds_case_and_separators() {
        assert!(paths_equal(Path::new(r"C:\a\B.md"), Path::new(r"c:\A\b.md")));
        assert!(paths_equal(Path::new("C:/a/b.md"), Path::new(r"C:\a\b.md")));
        assert!(!paths_equal(Path::new(r"C:\a\b.md"), Path::new(r"C:\a\c.md")));
    }

    // ---- get_mime_type -----------------------------------------------------

    #[test]
    fn mime_type_covers_served_kinds_and_defaults_to_octet_stream() {
        let mime = |p: &str| get_mime_type(&PathBuf::from(p));
        assert_eq!(mime("a.html"), "text/html");
        assert_eq!(mime("a.PNG"), "image/png"); // extension match is case-insensitive
        assert_eq!(mime("a.mp4"), "video/mp4");
        assert_eq!(mime("a.csv"), "text/csv; charset=utf-8");
        assert_eq!(mime("a.tsv"), "text/tab-separated-values; charset=utf-8");
        assert_eq!(mime("a.txt"), "text/plain; charset=utf-8");
        // The default is why a non-image extension can never be usefully inlined.
        assert_eq!(mime("a.unknown"), "application/octet-stream");
        assert_eq!(mime("noext"), "application/octet-stream");
    }

    // ---- parse_byte_range --------------------------------------------------

    #[test]
    fn byte_range_handles_open_closed_and_suffix_forms() {
        assert_eq!(parse_byte_range("bytes=0-", 10), Some((0, 9)));
        assert_eq!(parse_byte_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_byte_range("bytes=5-999", 10), Some((5, 9))); // clamped
        assert_eq!(parse_byte_range("bytes=-3", 10), Some((7, 9))); // last 3 bytes
        assert_eq!(parse_byte_range("bytes=-100", 10), Some((0, 9))); // clamped
        assert_eq!(parse_byte_range(" bytes=2-5 ", 10), Some((2, 5)));
    }

    #[test]
    fn byte_range_rejects_unsatisfiable_and_malformed() {
        assert_eq!(parse_byte_range("bytes=0-5", 0), None); // empty resource
        assert_eq!(parse_byte_range("bytes=-0", 10), None); // zero-length suffix
        assert_eq!(parse_byte_range("bytes=100-200", 10), None); // past the end
        assert_eq!(parse_byte_range("bytes=5-2", 10), None); // start > end
        assert_eq!(parse_byte_range("bytes=abc", 10), None);
        assert_eq!(parse_byte_range("0-5", 10), None); // missing unit
        assert_eq!(parse_byte_range("", 10), None);
    }

    #[test]
    fn byte_range_uses_only_the_first_of_a_multi_range() {
        assert_eq!(parse_byte_range("bytes=0-1,5-6", 10), Some((0, 1)));
    }

    // ---- js_call / build_load_file_script ----------------------------------

    #[test]
    fn js_call_reproduces_the_hand_written_guard_strings_byte_for_byte() {
        // These are the exact strings the call sites used before extraction; the
        // spacing (incl. ", " between args) must not drift.
        assert_eq!(
            js_call("loadFileFromRust", &["X"]),
            "if (typeof window.loadFileFromRust === 'function') { window.loadFileFromRust(X); }"
        );
        assert_eq!(
            js_call("__listDirResult", &["7", "[]"]),
            "if (typeof window.__listDirResult === 'function') { window.__listDirResult(7, []); }"
        );
        assert_eq!(
            js_call("__showDropZone", &[]),
            "if (typeof window.__showDropZone === 'function') { window.__showDropZone(); }"
        );
    }

    #[test]
    fn load_file_script_sets_raw_equal_to_content_and_escapes_json() {
        let script = build_load_file_script("a\"b.md", r"C:\d\a.md", "# Hi\n");
        assert!(script.starts_with(
            "if (typeof window.loadFileFromRust === 'function') { window.loadFileFromRust({"
        ));
        assert!(script.ends_with("); }"));
        // Quotes / backslashes / newlines must arrive as valid JSON, not raw text.
        assert!(script.contains(r#"\"b.md"#), "{script}");
        assert!(script.contains(r"C:\\d\\a.md"), "{script}");
        assert!(script.contains(r##""content":"# Hi\n""##), "{script}");
        assert!(script.contains(r##""raw":"# Hi\n""##), "{script}");
    }

    // ---- slugify -----------------------------------------------------------

    fn slug(text: &str) -> String {
        slugify(text, &mut std::collections::HashSet::new())
    }

    #[test]
    fn slugify_lowercases_and_hyphenates() {
        assert_eq!(slug("Hello World"), "hello-world");
        assert_eq!(slug("  Spaced   Out  "), "spaced-out"); // whitespace runs collapse
        assert_eq!(slug("A/B:C"), "abc"); // punctuation dropped
    }

    #[test]
    fn slugify_keeps_cjk_and_strips_edge_hyphens() {
        assert_eq!(slug("\u{65E5}\u{672C}\u{8A9E} \u{898B}\u{51FA}\u{3057}"),
                   "\u{65E5}\u{672C}\u{8A9E}-\u{898B}\u{51FA}\u{3057}");
        // Only ONE hyphen is stripped per end, not a run — `^-|-$`, not `^-+|-+$`.
        // The JS `generateHeadingId` uses the same regex, so the two agree.
        assert_eq!(slug("- leading and trailing -"), "-leading-and-trailing-");
    }

    #[test]
    fn slugify_falls_back_to_heading_and_dedupes() {
        let mut seen = std::collections::HashSet::new();
        assert_eq!(slugify("!!!", &mut seen), "heading");
        assert_eq!(slugify("???", &mut seen), "heading-1");
        assert_eq!(slugify("***", &mut seen), "heading-2");

        let mut seen = std::collections::HashSet::new();
        assert_eq!(slugify("Intro", &mut seen), "intro");
        assert_eq!(slugify("Intro", &mut seen), "intro-1");
        assert_eq!(slugify("Intro", &mut seen), "intro-2");
    }

    #[test]
    fn slugify_unicode_word_class_diverges_from_js_generate_heading_id() {
        // KNOWN PRE-EXISTING DIVERGENCE -- pinning current behavior, not endorsing it.
        // Rust's `regex` treats `\w` as Unicode-aware, so the accented letter is
        // kept; the JS `generateHeadingId` in assets/index.html uses JS `\w`, which
        // is ASCII-only, and produces "caf". An exported HTML artifact's sidebar
        // anchor (Rust-generated) therefore misses the in-page id (JS-generated)
        // for accented non-CJK headings. Fixing it is a behavior change and needs
        // its own change window; see CLAUDE.md.
        assert_eq!(slug("Caf\u{00E9}"), "caf\u{00E9}");
    }

    // ---- is_markdown_href / normalize_rel / extension helpers --------------

    #[test]
    fn markdown_href_detection_ignores_fragments_and_case() {
        assert!(is_markdown_href("a.md"));
        assert!(is_markdown_href("a.MARKDOWN"));
        assert!(is_markdown_href("dir/a.md#section"));
        assert!(!is_markdown_href("a.txt"));
        assert!(!is_markdown_href("https://example.com/"));
    }

    #[test]
    fn normalize_rel_drops_fragment_and_dot_slash_and_folds_separators() {
        assert_eq!(normalize_rel("./dir/a.md"), "dir/a.md");
        assert_eq!(normalize_rel("dir/a.md#frag"), "dir/a.md");
        assert_eq!(normalize_rel(r"dir\a.md"), "dir/a.md");
    }

    #[test]
    fn markdown_and_image_ext_detection() {
        assert!(is_markdown_ext(Path::new("a.MD")));
        assert!(is_markdown_ext(Path::new("a.markdown")));
        assert!(!is_markdown_ext(Path::new("a.mdx"))); // .mdx is a separate format
        assert!(is_image_ext(Path::new("a.JPEG")));
        assert!(!is_image_ext(Path::new("a.mp4")));
    }

    // ---- extract_headings_from_md -----------------------------------------

    #[test]
    fn headings_capture_level_text_and_slug() {
        let hs = extract_headings_from_md("# Title\n\ntext\n\n## Sub A\n\n### Deep\n");
        let got: Vec<_> = hs.iter().map(|h| (h.level, h.text.as_str(), h.slug.as_str())).collect();
        assert_eq!(got, vec![
            (1, "Title", "title"),
            (2, "Sub A", "sub-a"),
            (3, "Deep", "deep"),
        ]);
    }

    #[test]
    fn headings_include_inline_code_text_and_support_setext() {
        let hs = extract_headings_from_md("Title\n=====\n\n## Use `foo()`\n");
        assert_eq!(hs.len(), 2);
        assert_eq!((hs[0].level, hs[0].text.as_str()), (1, "Title"));
        assert_eq!((hs[1].level, hs[1].text.as_str()), (2, "Use foo()"));
    }

    #[test]
    fn headings_skip_fenced_code_and_empty_headings() {
        let hs = extract_headings_from_md("# Real\n\n```\n# Not a heading\n```\n\n##\n");
        let got: Vec<_> = hs.iter().map(|h| h.text.as_str()).collect();
        assert_eq!(got, vec!["Real"]);
    }

    #[test]
    fn headings_dedupe_slugs_across_the_document() {
        let hs = extract_headings_from_md("## Setup\n\n## Setup\n");
        assert_eq!(hs[0].slug, "setup");
        assert_eq!(hs[1].slug, "setup-1");
    }

    // ---- parse_toc_md ------------------------------------------------------
    //
    // Against an EMPTY root every `read_file_headings` misses and
    // `append_unlisted_files` contributes nothing, so the output is a pure
    // function of `toc_text` -- no markdown fixtures on disk are needed.

    fn toc(text: &str) -> Vec<TocNode> {
        let dir = tempfile::tempdir().unwrap();
        parse_toc_md(dir.path(), text)
    }

    #[test]
    fn toc_flat_list_of_links_becomes_files() {
        let t = toc("- [Intro](intro.md)\n- [Next](sub/next.md)\n");
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str(), t[0].rel_path.as_str()),
                   ("file", "Intro", "intro.md"));
        assert_eq!((t[1].kind.as_str(), t[1].name.as_str(), t[1].rel_path.as_str()),
                   ("file", "Next", "sub/next.md"));
        assert!(t[0].children.is_none());
    }

    #[test]
    fn toc_nested_list_upgrades_the_parent_to_a_dir() {
        let t = toc("- Chapters\n  - [One](a.md)\n  - [Two](b.md)\n");
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str()), ("dir", "Chapters"));
        let kids = t[0].children.as_ref().unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0].rel_path, "a.md");
        assert_eq!(kids[1].rel_path, "b.md");
    }

    #[test]
    fn toc_bullet_with_both_link_and_children_stays_a_dir_and_ignores_the_href() {
        // The `n.children.is_none()` guard means a parent that also carries a link
        // keeps its `dir` kind and never gets a rel_path.
        let t = toc("- [Group](group.md)\n  - [Inner](inner.md)\n");
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str()), ("dir", "Group"));
        assert_eq!(t[0].rel_path, "");
        assert_eq!(t[0].children.as_ref().unwrap()[0].rel_path, "inner.md");
    }

    #[test]
    fn toc_link_without_text_falls_back_to_the_file_name() {
        let t = toc("- [](sub/page.md)\n");
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str()), ("file", "page.md"));
    }

    #[test]
    fn toc_childless_plain_text_bullet_is_an_empty_dir() {
        let t = toc("- Just a label\n");
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str()), ("dir", "Just a label"));
        assert_eq!(t[0].children.as_ref().unwrap().len(), 0);
    }

    #[test]
    fn toc_non_markdown_href_is_not_treated_as_a_file() {
        let t = toc("- [Site](https://example.com/)\n");
        assert_eq!(t.len(), 1);
        // No .md/.markdown suffix -> the file branch is skipped entirely, so the
        // URL never leaks into relPath/absPath. The bullet keeps its label.
        assert_eq!((t[0].kind.as_str(), t[0].name.as_str()), ("dir", "Site"));
        assert_eq!(t[0].rel_path, "");
        assert_eq!(t[0].abs_path, "");
    }

    #[test]
    fn toc_group_name_survives_its_nested_list() {
        // Regression: `cur_text` is shared across items, so before the outer_item
        // save/restore the group below was named "Third" (its last child).
        let t = toc("- Group\n  - [First](a.md)\n  - [Second](b.md)\n  - [Third](c.md)\n");
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "Group");
        assert_eq!(t[0].children.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn toc_group_names_survive_two_levels_of_nesting() {
        let t = toc("- Outer\n  - Inner\n    - [Leaf](a.md)\n  - [Sibling](b.md)\n");
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "Outer");
        let kids = t[0].children.as_ref().unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0].name, "Inner");
        assert_eq!(kids[0].children.as_ref().unwrap()[0].name, "Leaf");
        assert_eq!(kids[1].name, "Sibling");
    }

    #[test]
    fn toc_real_workspace_sample_labels_its_group_correctly() {
        // End-to-end against the shipped sample, which is what surfaced the bug.
        let root = Path::new("samples/workspace");
        let txt = fs::read_to_string(root.join("_toc.md")).unwrap();
        let t = parse_toc_md(root, &txt);
        let names: Vec<_> = t.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["Introduction", "Chapters", "Conclusion", "Other"]);
    }

    #[test]
    fn toc_strips_dot_slash_and_fragments_from_hrefs() {
        let t = toc("- [A](./docs/a.md#intro)\n");
        assert_eq!(t[0].rel_path, "docs/a.md");
    }

    #[test]
    fn toc_appends_on_disk_files_missing_from_the_list_under_other() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("listed.md"), "# Listed\n").unwrap();
        fs::write(dir.path().join("stray.md"), "# Stray\n").unwrap();

        let t = parse_toc_md(dir.path(), "- [Listed](listed.md)\n");
        // The listed file keeps its position and now resolves its real headings.
        assert_eq!(t[0].rel_path, "listed.md");
        assert_eq!(t[0].title.as_deref(), Some("Listed"));
        // The unlisted one is appended in a synthetic trailing group.
        let other = t.last().unwrap();
        assert_eq!(other.kind, "dir");
        let names: Vec<_> = other.children.as_ref().unwrap()
            .iter().map(|n| n.rel_path.as_str()).collect();
        assert!(names.contains(&"stray.md"), "expected stray.md in {:?}", names);
        assert!(!names.contains(&"listed.md"), "listed.md must not be duplicated");
    }
}

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
use base64::{Engine as _, engine::general_purpose};
use regex::Regex;
use std::collections::{HashMap, HashSet};

mod editor_registry;
mod ime_win;
use editor_registry::EditorRegistry;

// Path to a markdown file currently being viewed. Wrapped in Arc<Mutex>
// for sharing between the event loop, IPC handler, and file watcher.
pub(crate) type CurrentFile = Arc<Mutex<Option<PathBuf>>>;

#[derive(Serialize, Deserialize)]
struct FileData {
    filename: String,
    filepath: String,
    content: String,
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
    DirectoryChanged,
    ToggleFullscreen,
    // Editor window lifecycle.
    OpenEditorWindow,
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

// Compare two filesystem paths for equality. Case-insensitive on Windows
// to match the OS, so editors using a different drive-letter case still match.
pub(crate) fn paths_equal(a: &Path, b: &Path) -> bool {
    let na = a.to_string_lossy().to_lowercase().replace('/', "\\");
    let nb = b.to_string_lossy().to_lowercase().replace('/', "\\");
    na == nb
}

// Determine MIME type based on file extension
pub(crate) fn get_mime_type(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
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

/// Embed local images as base64 data URIs in markdown content.
/// This bypasses WebView2's limitation where dynamically-loaded images
/// don't go through the custom protocol handler.
fn embed_images_as_base64(markdown: &str, base_dir: &Path) -> String {
    // Regex to match markdown image syntax: ![alt](path)
    let re = Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").unwrap();

    re.replace_all(markdown, |caps: &regex::Captures| {
        let alt = &caps[1];
        let path_str = &caps[2];

        // Skip URLs and data URIs - don't embed external resources
        if path_str.starts_with("http://") || path_str.starts_with("https://")
           || path_str.starts_with("data:") || path_str.starts_with("//") {
            return caps[0].to_string();
        }

        // Resolve the image path
        let img_path = if PathBuf::from(path_str).is_absolute() {
            PathBuf::from(path_str)
        } else {
            base_dir.join(path_str)
        };

        // Read the image file and convert to base64
        match fs::read(&img_path) {
            Ok(data) => {
                let mime = get_mime_type(&img_path);
                let b64 = general_purpose::STANDARD.encode(&data);
                format!("![{}](data:{};base64,{})", alt, mime, b64)
            }
            Err(_) => {
                // Keep original if file can't be read (might be broken link)
                caps[0].to_string()
            }
        }
    }).to_string()
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
    let mut in_item = false;
    let mut in_link = false;

    let parser = Parser::new(toc_text);
    for ev in parser {
        match ev {
            Event::Start(Tag::List(_)) => {
                stack.push(Vec::new());
            }
            Event::End(Tag::List(_)) => {
                let level = stack.pop().unwrap_or_default();
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
                } else if let Some(h) = href {
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

/// Read the markdown file at `path`, embed its local images as base64, and push
/// the resulting `FileData` into the webview via `loadFileFromRust`. Also updates
/// `current_dir` so subsequent relative-path lookups resolve correctly.
fn load_and_render(
    path: &Path,
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
            let filename = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown".to_string());
            let filepath = path.to_string_lossy().to_string();
            let content_embedded = if let Some(ref dir) = base_dir {
                embed_images_as_base64(&content, dir)
            } else {
                content.clone()
            };

            let file_data = FileData { filename, filepath: filepath.clone(), content: content_embedded };
            let json_data = serde_json::to_string(&file_data).unwrap();
            let script = format!(
                "if (typeof window.loadFileFromRust === 'function') {{ window.loadFileFromRust({}); }}",
                json_data
            );

            if let Ok(webview_guard) = webview.lock() {
                webview_guard.window().set_title(&format_title(Some(&file_data.filename)));
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

fn main() -> wry::Result<()> {
    // Check for command-line arguments (file or directory path)
    let args: Vec<String> = env::args().collect();

    let cli_path: Option<PathBuf> = if args.len() > 1 {
        Some(PathBuf::from(&args[1]))
    } else {
        None
    };

    // Distinguish file vs directory. A directory opens as a workspace; a file
    // opens directly (back-compat with existing CLI / double-click flow).
    let (file_path, dir_path): (Option<PathBuf>, Option<PathBuf>) = match cli_path.as_ref() {
        Some(p) if p.is_dir() => (None, Some(to_abs(p))),
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
            let filename = path.file_name()?.to_string_lossy().to_string();
            // Convert to absolute path for proper relative image resolution
            // Use current_dir().join() instead of canonicalize() to avoid \\?\ prefix on Windows
            let abs_path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir().unwrap_or_default().join(path)
            };
            let filepath = abs_path.to_string_lossy().to_string();
            let base_dir = abs_path.parent()?;

            match fs::read_to_string(&path) {
                Ok(content) => {
                    // Embed local images as base64 data URIs
                    let content = embed_images_as_base64(&content, base_dir);
                    Some(FileData { filename, filepath, content })
                }
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

    // Create event loop and window
    let event_loop = EventLoop::<CustomEvent>::with_user_event();
    let event_proxy = event_loop.create_proxy();
    let initial_title = format_title(
        effective_file_path.as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
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

    let init_script = format!(
        "window.__userStyles = {};\nwindow.__marpThemes = {};\nwindow.__styleExporters = {};\n{}",
        user_styles_json, marp_themes_json, style_exporters_json, init_script
    );

    // Clone current_dir for use in the protocol handler closure
    let current_dir_clone = current_dir.clone();
    let assets_dir_for_proto = assets_dir.clone();
    let assets_dir = assets_dir; // keep original around for the editor spawner

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

                // Read and serve the user file
                match fs::read(&resolved_path) {
                    Ok(content) => {
                        let mime_type = get_mime_type(&resolved_path);
                        Ok(Response::builder()
                            .header("Content-Type", mime_type)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(content.into())
                            .unwrap())
                    }
                    Err(e) => {
                        eprintln!("Failed to read user file {:?}: {}", resolved_path, e);
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
    let suppressed_saves: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));

    let ipc_event_proxy = event_proxy.clone();
    let ipc_current_file = current_file.clone();
    let ipc_editor_registry = editor_registry.clone();
    let ipc_suppressed_saves = suppressed_saves.clone();
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
                            if !p.index_html.is_empty() {
                                let idx = out_dir.join("index.html");
                                if let Err(e) = std::fs::write(&idx, p.index_html.as_bytes()) {
                                    eprintln!("exportdir: failed to write index: {}", e);
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
            struct ExportPayload { #[serde(rename = "suggestedName")] suggested_name: String, html: String }
            match serde_json::from_str::<ExportPayload>(payload) {
                Ok(p) => {
                    let initial_dir = ipc_current_file
                        .lock()
                        .unwrap()
                        .as_ref()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                    // rfd's save_file() blocks; run on a worker thread so we don't tie up
                    // the IPC handler and (more importantly) so dialog errors don't
                    // propagate as a hung webview.
                    std::thread::spawn(move || {
                        let mut dialog = rfd::FileDialog::new()
                            .add_filter("HTML", &["html"])
                            .set_file_name(&p.suggested_name);
                        if let Some(dir) = initial_dir {
                            dialog = dialog.set_directory(dir);
                        }
                        if let Some(path) = dialog.save_file() {
                            if let Err(e) = std::fs::write(&path, p.html.as_bytes()) {
                                eprintln!("export: failed to write {}: {}", path.display(), e);
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
        } else if message == "openeditor:" {
            if let Err(e) = ipc_event_proxy.send_event(CustomEvent::OpenEditorWindow) {
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
                    {
                        let mut s = ipc_suppressed_saves.lock().unwrap();
                        s.insert(path.clone());
                    }
                    let suppressed = ipc_suppressed_saves.clone();
                    let path_for_clear = path.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(1500));
                        suppressed.lock().unwrap().remove(&path_for_clear);
                    });
                    match std::fs::write(&path, p.content.as_bytes()) {
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
                    {
                        let mut s = ipc_suppressed_saves.lock().unwrap();
                        s.insert(path.clone());
                    }
                    let suppressed = ipc_suppressed_saves.clone();
                    let path_for_clear = path.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(1500));
                        suppressed.lock().unwrap().remove(&path_for_clear);
                    });
                    match std::fs::write(&path, p.content.as_bytes()) {
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
                ipc_current_file
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|p| p.parent().map(|d| d.join(&raw)))
            };
            if let Some(p) = abs {
                let _ = ipc_event_proxy.send_event(CustomEvent::CsvWatch(p));
            }
        }
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
        if let Some(w) = watcher.lock().unwrap().as_mut() {
            match w.watch(path, RecursiveMode::NonRecursive) {
                Ok(()) => *watched_path.lock().unwrap() = Some(path.clone()),
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
    // 'E' keypress and lives in `editor_registry` thereafter.
    let editor_assets_dir = assets_dir.clone();
    let editor_event_proxy = event_proxy.clone();
    let editor_current_file_for_spawn = current_file.clone();
    let editor_current_dir_for_spawn = current_dir.clone();
    let editor_suppressed_for_spawn = suppressed_saves.clone();

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
                // Folder drop opens a workspace. File drops fall through to the
                // webview's own drag-drop handler (which supports md+images bundle).
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
                load_and_render(&path, &webview, &current_dir, &current_file, &editor_registry);
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
            Event::UserEvent(CustomEvent::OpenEditorWindow) => {
                if editor_registry.is_open() {
                    editor_registry.focus();
                    return;
                }
                let cur = current_file.lock().unwrap().clone();
                if let Some(path) = cur {
                    if let Err(e) = editor_registry::spawn_editor_window(
                        target,
                        &editor_assets_dir,
                        editor_event_proxy.clone(),
                        editor_registry.clone(),
                        editor_current_file_for_spawn.clone(),
                        editor_current_dir_for_spawn.clone(),
                        editor_suppressed_for_spawn.clone(),
                        &path,
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
                let script = format!(
                    "if (typeof window.applyEditorScroll === 'function') {{ window.applyEditorScroll({}); }}",
                    line
                );
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&script);
                }
            }
            Event::UserEvent(CustomEvent::EditorSavedContent { path, content }) => {
                // Update current_dir for relative image resolution.
                if let Some(parent) = path.parent() {
                    *current_dir.lock().unwrap() = Some(parent.to_path_buf());
                }
                let base_dir = path.parent().map(|p| p.to_path_buf());
                let content_embedded = if let Some(ref dir) = base_dir {
                    embed_images_as_base64(&content, dir)
                } else {
                    content.clone()
                };
                let filename = path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());
                let file_data = FileData {
                    filename: filename.clone(),
                    filepath: path.to_string_lossy().to_string(),
                    content: content_embedded,
                };
                let json = serde_json::to_string(&file_data).unwrap();
                let script = format!(
                    "if (typeof window.loadFileFromRust === 'function') {{ window.loadFileFromRust({}); }}",
                    json
                );
                if let Ok(wv) = webview.lock() {
                    wv.window().set_title(&format_title(Some(&filename)));
                    let _ = wv.evaluate_script(&script);
                }
                *current_file.lock().unwrap() = Some(path);
            }
            Event::UserEvent(CustomEvent::EditorLiveContent { path, content, line }) => {
                // Live (unsaved) editor content — re-render preview from memory
                // and re-anchor scroll to the cursor line. Skip disk, title,
                // and current_file updates (path is already the paired file).
                let base_dir = path.parent().map(|p| p.to_path_buf());
                let content_embedded = if let Some(ref dir) = base_dir {
                    embed_images_as_base64(&content, dir)
                } else {
                    content.clone()
                };
                let filename = path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());
                let file_data = FileData {
                    filename,
                    filepath: path.to_string_lossy().to_string(),
                    content: content_embedded,
                };
                let json = serde_json::to_string(&file_data).unwrap();
                let script = format!(
                    "if (typeof window.loadFileFromRust === 'function') {{ window.loadFileFromRust({}); }} if (typeof window.applyEditorScroll === 'function') {{ window.applyEditorScroll({}); }}",
                    json, line
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

                if !is_markdown_ext(&abs_path) {
                    eprintln!("OpenFile: not a markdown file: {:?}", abs_path);
                    return;
                }

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
                    let script = format!(
                        "if (typeof window.__setActiveFile === 'function') {{ window.__setActiveFile({}); }}",
                        abs_str
                    );
                    if let Ok(wv) = webview.lock() {
                        let _ = wv.evaluate_script(&script);
                    }
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
                let script = format!(
                    "if (typeof window.loadDirectoryFromRust === 'function') {{ window.loadDirectoryFromRust({}); }}",
                    json
                );
                if let Ok(wv) = webview.lock() {
                    let _ = wv.evaluate_script(&script);
                }

                if let Some(first) = first {
                    let p = PathBuf::from(first);
                    load_and_render(&p, &webview, &current_dir, &current_file, &editor_registry);
                    let abs_str = serde_json::to_string(&p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| "\"\"".into());
                    let script = format!(
                        "if (typeof window.__setActiveFile === 'function') {{ window.__setActiveFile({}); }}",
                        abs_str
                    );
                    if let Ok(wv) = webview.lock() {
                        let _ = wv.evaluate_script(&script);
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
                        let script = format!(
                            "if (typeof window.refreshFileTree === 'function') {{ window.refreshFileTree({}); }}",
                            json
                        );
                        if let Ok(wv) = webview.lock() {
                            let _ = wv.evaluate_script(&script);
                        }
                    }
                }
            }
            _ => (),
        }
    });
}

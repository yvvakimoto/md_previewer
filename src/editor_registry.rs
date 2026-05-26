// 1:1 pairing between the preview window and the (at most one) editor window.
//
// The editor lives only in this registry. Every preview→editor and editor→preview
// path goes through it. Because there is no broadcast and no external transport,
// "another file's events leaking in" — the bug we had with the WebSocket sync
// server when multiple VSCode windows were open — cannot happen by construction.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
#[cfg(windows)]
use tao::platform::windows::WindowExtWindows;
use tao::window::{WindowBuilder, WindowId};
use wry::webview::{WebView, WebViewBuilder};
use wry::http::Response;
use serde::Deserialize;

use crate::{CurrentDir, CurrentFile, CustomEvent, get_mime_type};

/// Clamp a desired logical window size to the primary monitor's visible area
/// (minus a margin for the taskbar / window chrome) and center it. Returns the
/// final (width, height) plus a logical position if a monitor was available.
/// Used by both the preview window in `main.rs` and the editor window below so
/// neither can spawn partially off-screen on smaller / high-DPI displays.
pub fn clamped_window_geometry(
    event_loop: &EventLoopWindowTarget<CustomEvent>,
    desired_w: f64,
    desired_h: f64,
) -> (f64, f64, Option<LogicalPosition<f64>>) {
    let margin_w: f64 = 40.0;
    let margin_h: f64 = 80.0;
    let monitor = event_loop
        .primary_monitor()
        .or_else(|| event_loop.available_monitors().next());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let logical = m.size().to_logical::<f64>(scale);
        let max_w = (logical.width - margin_w).max(400.0);
        let max_h = (logical.height - margin_h).max(300.0);
        let w = desired_w.min(max_w);
        let h = desired_h.min(max_h);
        let mpos = m.position().to_logical::<f64>(scale);
        let x = mpos.x + ((logical.width - w) / 2.0).max(0.0);
        let y = mpos.y + ((logical.height - margin_h - h) / 2.0).max(0.0);
        (w, h, Some(LogicalPosition::new(x, y)))
    } else {
        (desired_w, desired_h, None)
    }
}

struct State {
    window_id: WindowId,
    webview: WebView,
    /// Absolute path of the file the editor is currently editing. Used as the
    /// authoritative key when routing save/jump messages — we never trust the
    /// path the JS side sends without comparing to this.
    file: PathBuf,
    /// True iff the editor buffer has diverged from disk since the last save
    /// (i.e. an `editor:change:` arrived after the last `editor:save:` /
    /// file-switch). Maintained by the IPC handlers so the close paths can
    /// decide whether to revert the preview from disk.
    dirty: bool,
}

#[derive(Clone)]
pub struct EditorRegistry {
    inner: Arc<Mutex<Option<State>>>,
}

impl EditorRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(None)) }
    }

    pub fn is_open(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    pub fn is_editor_window(&self, id: WindowId) -> bool {
        self.inner.lock().unwrap().as_ref().map(|s| s.window_id == id).unwrap_or(false)
    }

    pub fn focus(&self) {
        if let Some(s) = self.inner.lock().unwrap().as_ref() {
            s.webview.window().set_focus();
        }
    }

    /// Drop the editor window and, if the buffer was dirty, return the path
    /// of the file it was editing so the caller can revert the preview from
    /// disk. Returns `None` when there was no editor or it was already clean.
    pub fn close_take_dirty_path(&self) -> Option<PathBuf> {
        self.inner.lock().unwrap().take().and_then(|s| if s.dirty { Some(s.file) } else { None })
    }

    pub fn mark_dirty(&self) {
        if let Some(s) = self.inner.lock().unwrap().as_mut() {
            s.dirty = true;
        }
    }

    pub fn mark_clean(&self) {
        if let Some(s) = self.inner.lock().unwrap().as_mut() {
            s.dirty = false;
        }
    }

    /// Preview just loaded a new file (CLI / drag / link click). If the editor
    /// is open, push the new file's content into it.
    pub fn push_file_to_editor(&self, path: &Path, raw_content: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(state) = guard.as_mut() {
            state.file = path.to_path_buf();
            state.dirty = false;
            let payload = serde_json::json!({
                "path": path.to_string_lossy().to_string(),
                "content": raw_content,
            });
            let script = format!(
                "if (typeof window.__loadFile === 'function') {{ window.__loadFile({}); }}",
                payload
            );
            let _ = state.webview.evaluate_script(&script);
            let filename = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Untitled".into());
            state.webview.window().set_title(&format!("{} — Editor", filename));
        }
    }

    /// Push an IME open-status change to the editor JS so it can toggle
    /// `body.ime-open` and tint the cursor. Called from the main loop in
    /// response to `CustomEvent::EditorImeStatus`, which the polling thread
    /// spawned alongside the editor emits on transitions.
    pub fn push_ime_status(&self, open: bool) {
        let guard = self.inner.lock().unwrap();
        if let Some(state) = guard.as_ref() {
            let script = format!(
                "if (typeof window.__setImeOpen === 'function') {{ window.__setImeOpen({}); }}",
                open
            );
            let _ = state.webview.evaluate_script(&script);
        }
    }

    /// Preview was clicked at a given line; tell the editor to jump.
    pub fn push_jump_to_editor(&self, path: &Path, line: u32) {
        let guard = self.inner.lock().unwrap();
        if let Some(state) = guard.as_ref() {
            // Strict filter: only deliver if the editor is editing this file.
            if !crate::paths_equal(&state.file, path) { return; }
            let script = format!(
                "if (typeof window.__previewScrolledTo === 'function') {{ window.__previewScrolledTo({}); }}",
                line
            );
            let _ = state.webview.evaluate_script(&script);
        }
    }

    fn set(&self, state: State) {
        *self.inner.lock().unwrap() = Some(state);
    }
}

/// Spawn the editor window and load the given file into it.
#[allow(clippy::too_many_arguments)]
pub fn spawn_editor_window(
    event_loop: &EventLoopWindowTarget<CustomEvent>,
    assets_dir: &Path,
    event_proxy: EventLoopProxy<CustomEvent>,
    registry: EditorRegistry,
    current_file: CurrentFile,
    _current_dir: CurrentDir,
    suppressed_saves: Arc<Mutex<HashSet<PathBuf>>>,
    initial_file: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let filename = initial_file.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());

    let (init_w, init_h, init_pos) = clamped_window_geometry(event_loop, 900.0, 760.0);
    let mut window_builder = WindowBuilder::new()
        .with_title(&format!("{} — Editor", filename))
        .with_inner_size(LogicalSize::new(init_w, init_h));
    if let Some(pos) = init_pos {
        window_builder = window_builder.with_position(pos);
    }
    let window = window_builder.build(event_loop)?;
    let window_id = window.id();

    let initial_content = std::fs::read_to_string(initial_file).unwrap_or_default();
    let init_payload = serde_json::json!({
        "path": initial_file.to_string_lossy().to_string(),
        "content": initial_content,
    });
    let init_script = format!(
        r#"window.__initialFile = {payload};"#,
        payload = init_payload
    );

    let assets_dir_owned = assets_dir.to_path_buf();
    let proxy_for_ipc = event_proxy.clone();
    let registry_for_ipc = registry.clone();
    let current_file_for_ipc = current_file.clone();
    let suppressed_for_ipc = suppressed_saves.clone();

    let webview = WebViewBuilder::new(window)?
        .with_custom_protocol("app".into(), move |request| {
            let path = request.uri().path();
            let file_path = if path == "/" || path == "/editor.html" {
                assets_dir_owned.join("editor.html")
            } else {
                assets_dir_owned.join(&path[1..])
            };
            match std::fs::read(&file_path) {
                Ok(content) => {
                    let mime = get_mime_type(&file_path);
                    Ok(Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(content.into())
                        .unwrap())
                }
                Err(_) => Ok(Response::builder()
                    .status(404)
                    .body(format!("not found: {:?}", file_path).into_bytes().into())
                    .unwrap()),
            }
        })
        .with_url("app://localhost/editor.html")?
        .with_initialization_script(&init_script)
        .with_ipc_handler(move |_window, message| {
            // editor:ready — webview is ready; nothing to push (initial file
            // was injected via __initialFile).
            if message == "editor:ready" {
                return;
            }
            // editor:log: — forensic-log bridge from editor JS, mirrors the
            // preview's app://__log/ GET channel. Kept around so future
            // editor-side debugging doesn't need a Rust round-trip to wire up.
            if let Some(payload) = message.strip_prefix("editor:log:") {
                crate::dbg_log_write(&format!("[editor:js] {}", payload));
                return;
            }
            if let Some(payload) = message.strip_prefix("editor:save:") {
                #[derive(Deserialize)]
                struct SavePayload { path: String, content: String }
                if let Ok(p) = serde_json::from_str::<SavePayload>(payload) {
                    let path = PathBuf::from(&p.path);
                    // Enforce: editor can only save the file it's paired to.
                    let cur = current_file_for_ipc.lock().unwrap().clone();
                    let allowed = cur.as_ref().map(|c| crate::paths_equal(c, &path)).unwrap_or(false);
                    if !allowed {
                        eprintln!("editor:save: rejected (path mismatch): {:?}", path);
                        return;
                    }
                    {
                        let mut s = suppressed_for_ipc.lock().unwrap();
                        s.insert(path.clone());
                    }
                    let suppressed_clear = suppressed_for_ipc.clone();
                    let path_clear = path.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        suppressed_clear.lock().unwrap().remove(&path_clear);
                    });
                    if let Err(e) = std::fs::write(&path, p.content.as_bytes()) {
                        eprintln!("editor:save: write failed: {}", e);
                        return;
                    }
                    registry_for_ipc.mark_clean();
                    let _ = proxy_for_ipc.send_event(CustomEvent::EditorSavedContent {
                        path,
                        content: p.content,
                    });
                }
                return;
            }
            if let Some(payload) = message.strip_prefix("editor:change:") {
                #[derive(Deserialize)]
                struct ChangePayload { path: String, content: String, line: u32 }
                if let Ok(p) = serde_json::from_str::<ChangePayload>(payload) {
                    let path = PathBuf::from(&p.path);
                    // Same path-equality guard as editor:save:.
                    let cur = current_file_for_ipc.lock().unwrap().clone();
                    let allowed = cur.as_ref().map(|c| crate::paths_equal(c, &path)).unwrap_or(false);
                    if !allowed {
                        return;
                    }
                    registry_for_ipc.mark_dirty();
                    let _ = proxy_for_ipc.send_event(CustomEvent::EditorLiveContent {
                        path,
                        content: p.content,
                        line: p.line,
                    });
                }
                return;
            }
            if let Some(line_str) = message.strip_prefix("editor:cursor:") {
                if let Ok(line) = line_str.trim().parse::<u32>() {
                    // Filter: only forward if editor still edits the previewed file.
                    let cur = current_file_for_ipc.lock().unwrap().clone();
                    let editor_file = registry_for_ipc.inner.lock().unwrap()
                        .as_ref().map(|s| s.file.clone());
                    if let (Some(c), Some(e)) = (cur, editor_file) {
                        if crate::paths_equal(&c, &e) {
                            let _ = proxy_for_ipc.send_event(CustomEvent::EditorCursorMoved { line });
                        }
                    }
                }
                return;
            }
            if let Some(payload) = message.strip_prefix("editor:listdir:") {
                #[derive(Deserialize)]
                struct ListDirPayload { id: u64, base: String, sub: String }
                if let Ok(p) = serde_json::from_str::<ListDirPayload>(payload) {
                    // Safety: only honor listings under the directory of the
                    // currently-paired file. We allow descendants (sub may be a
                    // multi-segment relative path) but reject `..` escape.
                    let base = PathBuf::from(&p.base);
                    let editor_file = registry_for_ipc.inner.lock().unwrap()
                        .as_ref().map(|s| s.file.clone());
                    let allowed = editor_file
                        .as_ref()
                        .and_then(|f| f.parent().map(|d| crate::paths_equal(d, &base)))
                        .unwrap_or(false);
                    if !allowed {
                        let script = format!(
                            "if (typeof window.__listDirResult === 'function') {{ window.__listDirResult({}, []); }}",
                            p.id
                        );
                        if let Some(s) = registry_for_ipc.inner.lock().unwrap().as_ref() {
                            let _ = s.webview.evaluate_script(&script);
                        }
                        return;
                    }
                    // Reject `..` segments in sub.
                    let sub_ok = p.sub.split(|c| c == '/' || c == '\\').all(|seg| seg != "..");
                    let target = if p.sub.is_empty() || !sub_ok { base.clone() } else { base.join(&p.sub) };
                    let mut entries: Vec<(String, bool)> = Vec::new();
                    if sub_ok {
                        if let Ok(rd) = std::fs::read_dir(&target) {
                            for ent in rd.flatten() {
                                let name = ent.file_name().to_string_lossy().to_string();
                                if name.starts_with('.') { continue; }
                                let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
                                entries.push((name, is_dir));
                                if entries.len() >= 500 { break; }
                            }
                        }
                    }
                    entries.sort_by(|a, b| match (a.1, b.1) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
                    });
                    let json_entries: Vec<serde_json::Value> = entries.into_iter()
                        .map(|(name, is_dir)| serde_json::json!({ "name": name, "isDir": is_dir }))
                        .collect();
                    let entries_json = serde_json::Value::Array(json_entries);
                    let script = format!(
                        "if (typeof window.__listDirResult === 'function') {{ window.__listDirResult({}, {}); }}",
                        p.id, entries_json
                    );
                    if let Some(s) = registry_for_ipc.inner.lock().unwrap().as_ref() {
                        let _ = s.webview.evaluate_script(&script);
                    }
                }
                return;
            }
            if let Some(flag) = message.strip_prefix("editor:dirty:") {
                // JS reports a dirty-state transition. Reflect it on the OS
                // window title (chrome + taskbar) so the unsaved marker is
                // visible even when the auto-hiding status bar is collapsed.
                let dirty = flag == "true";
                if let Some(s) = registry_for_ipc.inner.lock().unwrap().as_mut() {
                    s.dirty = dirty;
                    let filename = s.file.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Untitled".into());
                    let prefix = if dirty { "• " } else { "" };
                    s.webview.window().set_title(&format!("{}{} — Editor", prefix, filename));
                }
                return;
            }
            if message == "editor:ime:off" {
                // JS posts this on Vim NORMAL-mode entry. Flip the OS IME
                // back to direct-input (半角) so subsequent NORMAL-mode
                // command keys aren't eaten by IME composition.
                #[cfg(windows)]
                {
                    if let Some(s) = registry_for_ipc.inner.lock().unwrap().as_ref() {
                        let hwnd = s.webview.window().hwnd() as *mut std::ffi::c_void;
                        crate::ime_win::set_ime_open(hwnd, false);
                    }
                }
                return;
            }
            if message == "editor:close:" {
                let _ = proxy_for_ipc.send_event(CustomEvent::EditorCloseRequested);
            }
        })
        .build()?;

    registry.set(State {
        window_id,
        webview,
        file: initial_file.to_path_buf(),
        dirty: false,
    });

    // IME open-status poller. Runs on a background thread; sends state-change
    // events back to the main loop via the proxy, which then calls
    // `EditorRegistry::push_ime_status`. The HWND is shipped across threads
    // as a `usize` (raw pointers are !Send); the thread exits cleanly when
    // the OS window is destroyed (`IsWindow` returns false), so no explicit
    // shutdown signaling from the registry is required.
    #[cfg(windows)]
    {
        let hwnd_raw = {
            let guard = registry.inner.lock().unwrap();
            guard.as_ref().map(|s| s.webview.window().hwnd() as usize).unwrap_or(0)
        };
        if hwnd_raw != 0 {
            let proxy_for_poll = event_proxy.clone();
            std::thread::spawn(move || {
                let hwnd = hwnd_raw as *mut std::ffi::c_void;
                let mut last: Option<bool> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if !crate::ime_win::is_window(hwnd) {
                        return;
                    }
                    let cur = crate::ime_win::get_ime_open(hwnd);
                    if cur != last {
                        if let Some(open) = cur {
                            let _ = proxy_for_poll.send_event(CustomEvent::EditorImeStatus(open));
                        }
                        last = cur;
                    }
                }
            });
        }
    }

    Ok(())
}

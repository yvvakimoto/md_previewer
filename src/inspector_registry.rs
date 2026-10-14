// The (at most one) Mermaid inspector window — see .claude/docs/inspector.md.
//
// A read-only companion to the preview: it is handed one mermaid block's SOURCE
// (never the rendered SVG) and renders it itself in assets/inspector.html. The
// preview owns "which block is followed"; this registry only spawns the window,
// forwards payloads into it and reports its closing. Nothing here writes to disk.
//
// Payload (JSON object, built by the preview's __inspectorPayload()):
//   { kind: "open" | "update", src, ordinal, line, file, dark }

use std::path::Path;
use std::sync::{Arc, Mutex};

use tao::dpi::LogicalSize;
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{WindowBuilder, WindowId};
use wry::http::Response;
use wry::webview::{WebView, WebViewBuilder};

use crate::editor_registry::clamped_window_geometry;
use crate::{get_mime_type, CustomEvent};

/// Validate a payload posted by the preview and re-serialize it, so whatever is
/// later spliced into `__inspectorLoad(...)` is JSON this side produced. Returns
/// `(json, file)`. Anything that is not an object carrying a string `src` is
/// refused rather than forwarded.
pub fn parse_inspector_payload(raw: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    obj.get("src")?.as_str()?;
    let file = obj.get("file").and_then(|f| f.as_str()).unwrap_or("").to_string();
    Some((v.to_string(), file))
}

fn window_title(file: &str) -> String {
    let name = Path::new(file)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty());
    match name {
        Some(n) => format!("{} — Mermaid Inspector", n),
        None => "Mermaid Inspector".to_string(),
    }
}

struct State {
    window_id: WindowId,
    webview: WebView,
}

#[derive(Clone)]
pub struct InspectorRegistry {
    inner: Arc<Mutex<Option<State>>>,
}

impl InspectorRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(None)) }
    }

    pub fn is_open(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    pub fn is_inspector_window(&self, id: WindowId) -> bool {
        self.inner.lock().unwrap().as_ref().map(|s| s.window_id == id).unwrap_or(false)
    }

    /// Hand a (validated) payload to the open window. `focus` is true for an
    /// explicit "open" from the menu and false for live-follow updates, which
    /// must never steal focus from the editor the reader is typing in.
    pub fn push(&self, json: &str, file: &str, focus: bool) {
        if let Some(s) = self.inner.lock().unwrap().as_ref() {
            crate::eval_js_fn(&s.webview, "__inspectorLoad", &[json]);
            s.webview.window().set_title(&window_title(file));
            if focus {
                s.webview.window().set_focus();
            }
        }
    }

    /// Drop the window (dropping the `WebView` destroys it). Returns whether
    /// one was open, so the caller knows to tell the preview to stop following.
    pub fn close(&self) -> bool {
        self.inner.lock().unwrap().take().is_some()
    }

    fn set(&self, state: State) {
        *self.inner.lock().unwrap() = Some(state);
    }
}

/// Spawn the inspector window with `json` (already validated) as its first
/// payload. Must run on the event loop thread — it needs the window target.
pub fn spawn_inspector_window(
    event_loop: &EventLoopWindowTarget<CustomEvent>,
    assets_dir: &Path,
    event_proxy: EventLoopProxy<CustomEvent>,
    registry: InspectorRegistry,
    json: &str,
    file: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let (init_w, init_h, init_pos) = clamped_window_geometry(event_loop, 1200.0, 820.0);
    let mut window_builder = WindowBuilder::new()
        .with_title(&window_title(file))
        .with_inner_size(LogicalSize::new(init_w, init_h));
    if let Some(pos) = init_pos {
        window_builder = window_builder.with_position(pos);
    }
    let window = window_builder.build(event_loop)?;
    let window_id = window.id();

    let init_script = format!("window.__inspectorInit = {};", json);
    let assets_dir_owned = assets_dir.to_path_buf();
    let proxy_for_ipc = event_proxy.clone();

    let webview = WebViewBuilder::new(window)?
        // Assets only — the same origin (app://localhost) as the preview and the
        // editor, which is what lets the window follow `darkMode` / `uiLang`
        // through the shared localStorage with no IPC. No `/userfile/` route:
        // mermaid needs nothing from the document's folder.
        .with_custom_protocol("app".into(), move |request| {
            let path = request.uri().path();
            let file_path = if path == "/" || path == "/inspector.html" {
                assets_dir_owned.join("inspector.html")
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
        .with_url("app://localhost/inspector.html")?
        .with_initialization_script(&init_script)
        // The page owns Ctrl +/-/0 and Ctrl+wheel (its own pan/zoom), exactly
        // like the preview; WebView2's page zoom would scale the toolbar too.
        .with_hotkeys_zoom(false)
        .with_ipc_handler(move |_window, message| {
            if message == "inspector:close" {
                let _ = proxy_for_ipc.send_event(CustomEvent::InspectorCloseRequested);
            }
        })
        .build()?;
    webview.zoom(1.0);
    // Touchpad pinch → Ctrl+wheel → the diagram's own zoom (see the helper).
    #[cfg(windows)]
    crate::enable_touchpad_pinch(&webview);

    registry.set(State { window_id, webview });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_inspector_payload, window_title};

    #[test]
    fn payload_round_trips_and_yields_the_file() {
        let (json, file) = parse_inspector_payload(
            r#"{"kind":"open","src":"flowchart LR\n A-->B","ordinal":1,"line":3,"file":"C:\\d\\a.md"}"#,
        )
        .unwrap();
        assert_eq!(file, "C:\\d\\a.md");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["src"], "flowchart LR\n A-->B");
        assert_eq!(v["ordinal"], 1);
    }

    #[test]
    fn payload_without_src_or_not_an_object_is_refused() {
        assert!(parse_inspector_payload("").is_none());
        assert!(parse_inspector_payload("[1,2]").is_none());
        assert!(parse_inspector_payload(r#"{"kind":"open"}"#).is_none());
        assert!(parse_inspector_payload(r#"{"src":42}"#).is_none());
        // A string that would close the JS call early never reaches eval as-is.
        let (json, _) = parse_inspector_payload(r#"{"src":"</script>); alert(1); ("}"#).unwrap();
        assert!(json.starts_with('{') && json.ends_with('}'));
    }

    #[test]
    fn title_names_the_document_when_known() {
        assert_eq!(window_title("C:\\docs\\energy.md"), "energy.md — Mermaid Inspector");
        assert_eq!(window_title(""), "Mermaid Inspector");
    }
}

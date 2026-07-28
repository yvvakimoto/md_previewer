// Per-slide PNG capture via WebView2's DevTools Protocol (CDP)
// `Page.captureScreenshot`. Companion to `pdf_win` (PDF export) — both go
// through the shared CDP plumbing in `cdp_win`; this module only supplies the
// clip params and the event.
//
// Used only by the headless `--export-png` mode (see CaptureConfig / the
// Capture* events in `main.rs`). The preview JS isolates one Marp slide at the
// logical 1280x720 box anchored at the viewport origin (or, for a non-Marp
// document, the full `#preview` box) and reports the clip rectangle in CSS px.
// We capture that rectangle with `captureBeyondViewport:true` so it works even
// when the region extends past the (hidden) window's viewport, and with
// `clip.scale` set to the requested zoom factor for a crisp, readable PNG.

#![cfg(windows)]

use std::path::PathBuf;

use tao::event_loop::EventLoopProxy;
use wry::webview::WebView;

use crate::CustomEvent;

/// Capture the CSS-px rectangle `clip` (x, y, width, height) of the document
/// currently loaded in `webview` to a PNG at `out_path`, zoomed by `scale`.
/// Non-blocking: the file is written and `CaptureDone { index, ok }` is posted
/// from the async CDP completion handler so the capture loop can advance.
pub fn capture_clip_to_png(
    webview: &WebView,
    out_path: PathBuf,
    clip: (f64, f64, f64, f64),
    scale: f64,
    index: usize,
    proxy: EventLoopProxy<CustomEvent>,
) {
    let (x, y, w, h) = clip;
    let params = format!(
        "{{\"format\":\"png\",\"captureBeyondViewport\":true,\"clip\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"scale\":{}}}}}",
        x, y, w, h, scale
    );

    crate::cdp_win::cdp_call_to_file(
        webview,
        "png",
        "Page.captureScreenshot",
        &params,
        out_path,
        move |ok| {
            let _ = proxy.send_event(CustomEvent::CaptureDone { index, ok });
        },
    );
}

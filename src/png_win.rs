// Per-slide PNG capture via WebView2's DevTools Protocol (CDP)
// `Page.captureScreenshot`. Companion to `pdf_win` (PDF export) — it reuses
// the exact same CDP plumbing: obtain the `ICoreWebView2` from the wry
// `WebView`, call `CallDevToolsProtocolMethod` with an async completion
// handler, then base64-decode the result and write the file.
//
// Used only by the headless `--export-png` mode (see CaptureConfig / the
// Capture* events in `main.rs`). The preview JS isolates one Marp slide at the
// logical 1280x720 box anchored at the viewport origin (or, for a non-Marp
// document, the full `#preview` box) and reports the clip rectangle in CSS px.
// We capture that rectangle with `captureBeyondViewport:true` so it works even
// when the region extends past the (hidden) window's viewport, and with
// `clip.scale` set to the requested zoom factor for a crisp, readable PNG.

#![cfg(windows)]

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use tao::event_loop::EventLoopProxy;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::PCWSTR;
use wry::webview::{WebView, WebviewExtWindows};

use crate::CustomEvent;

#[derive(Deserialize)]
struct ScreenshotResult {
    data: String,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

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
    let controller = webview.controller();
    let core: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(c) => c,
        Err(e) => {
            eprintln!("png: failed to get CoreWebView2: {}", e);
            let _ = proxy.send_event(CustomEvent::CaptureDone { index, ok: false });
            return;
        }
    };

    let (x, y, w, h) = clip;
    let params = format!(
        "{{\"format\":\"png\",\"captureBeyondViewport\":true,\"clip\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"scale\":{}}}}}",
        x, y, w, h, scale
    );

    let method = wide("Page.captureScreenshot");
    let params_w = wide(&params);
    let out_for_cb = out_path.clone();
    let proxy_for_cb = proxy.clone();

    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, json: String| {
            let ok = result.is_ok() && write_png(&out_for_cb, &json);
            let _ = proxy_for_cb.send_event(CustomEvent::CaptureDone { index, ok });
            Ok(())
        },
    ));

    let call = unsafe {
        core.CallDevToolsProtocolMethod(
            PCWSTR::from_raw(method.as_ptr()),
            PCWSTR::from_raw(params_w.as_ptr()),
            &handler,
        )
    };
    if let Err(e) = call {
        eprintln!("png: CallDevToolsProtocolMethod failed: {}", e);
        let _ = proxy.send_event(CustomEvent::CaptureDone { index, ok: false });
    }
}

fn write_png(out_path: &Path, json: &str) -> bool {
    let parsed: ScreenshotResult = match serde_json::from_str(json) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("png: bad CDP result json: {}", e);
            return false;
        }
    };
    let bytes = match STANDARD.decode(parsed.data.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("png: base64 decode failed: {}", e);
            return false;
        }
    };
    if let Err(e) = std::fs::write(out_path, &bytes) {
        eprintln!("png: write {} failed: {}", out_path.display(), e);
        return false;
    }
    true
}

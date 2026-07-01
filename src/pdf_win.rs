// PDF export via WebView2's DevTools Protocol (CDP) `Page.printToPDF`.
//
// We deliberately use CDP rather than `ICoreWebView2_7::PrintToPdf`: the
// PrintToPdf settings interface in this SDK generation exposes no
// outline/bookmark option, so bookmark generation would be runtime-version
// dependent and unreliable. `Page.printToPDF` accepts `generateDocumentOutline`,
// which produces PDF bookmarks (しおり) from the document's heading structure —
// satisfying the "目次を反映" requirement. Internal anchor links
// (`href="#id"`, footnotes, TOC) and external links become clickable PDF
// annotations automatically. Output is vector, text-selectable, and
// (with `printBackground:true`) keeps themed backgrounds.
//
// The CDP call is asynchronous: `CallDevToolsProtocolMethod` returns
// immediately and the completion handler fires later on the UI thread with
// the result JSON (`{"data":"<base64 PDF>"}`). We decode and write the file
// there, then post `CustomEvent::PdfExportDone` back to the main loop so the
// preview can show a toast.

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

// A4 portrait (inches). `printBackground` keeps code-block / theme backgrounds,
// `generateDocumentOutline` builds heading-based bookmarks, `preferCSSPageSize`
// lets any `@page` size in the document win.
const PRINT_PARAMS: &str = concat!(
    "{",
    "\"landscape\":false,",
    "\"printBackground\":true,",
    "\"generateDocumentOutline\":true,",
    "\"preferCSSPageSize\":true,",
    "\"scale\":1,",
    "\"marginTop\":0.4,\"marginBottom\":0.4,\"marginLeft\":0.4,\"marginRight\":0.4,",
    "\"paperWidth\":8.27,\"paperHeight\":11.69",
    "}"
);

#[derive(Deserialize)]
struct PrintResult {
    data: String,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Print the document currently loaded in `webview` to a PDF at `out_path`.
/// Non-blocking: the file is written and `PdfExportDone` is posted from the
/// async CDP completion handler.
pub fn print_current_to_pdf(webview: &WebView, out_path: PathBuf, proxy: EventLoopProxy<CustomEvent>) {
    let controller = webview.controller();
    let core: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(c) => c,
        Err(e) => {
            eprintln!("pdf: failed to get CoreWebView2: {}", e);
            let _ = proxy.send_event(CustomEvent::PdfExportDone { ok: false, path: out_path });
            return;
        }
    };

    let method = wide("Page.printToPDF");
    let params = wide(PRINT_PARAMS);
    let out_for_cb = out_path.clone();
    let proxy_for_cb = proxy.clone();

    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, json: String| {
            let ok = result.is_ok() && write_pdf(&out_for_cb, &json);
            let _ = proxy_for_cb.send_event(CustomEvent::PdfExportDone { ok, path: out_for_cb });
            Ok(())
        },
    ));

    let call = unsafe {
        core.CallDevToolsProtocolMethod(
            PCWSTR::from_raw(method.as_ptr()),
            PCWSTR::from_raw(params.as_ptr()),
            &handler,
        )
    };
    if let Err(e) = call {
        eprintln!("pdf: CallDevToolsProtocolMethod failed: {}", e);
        let _ = proxy.send_event(CustomEvent::PdfExportDone { ok: false, path: out_path });
    }
}

fn write_pdf(out_path: &Path, json: &str) -> bool {
    let parsed: PrintResult = match serde_json::from_str(json) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pdf: bad CDP result json: {}", e);
            return false;
        }
    };
    let bytes = match STANDARD.decode(parsed.data.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("pdf: base64 decode failed: {}", e);
            return false;
        }
    };
    if let Err(e) = std::fs::write(out_path, &bytes) {
        eprintln!("pdf: write {} failed: {}", out_path.display(), e);
        return false;
    }
    true
}

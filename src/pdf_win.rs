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
// The CDP call itself (decode + write + error handling) lives in `cdp_win`,
// shared with `png_win`; this module only supplies the params and the event.

#![cfg(windows)]

use std::path::PathBuf;

use tao::event_loop::EventLoopProxy;
use wry::webview::WebView;

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

/// Print the document currently loaded in `webview` to a PDF at `out_path`.
/// Non-blocking: the file is written and `PdfExportDone` is posted from the
/// async CDP completion handler.
pub fn print_current_to_pdf(
    webview: &WebView,
    out_path: PathBuf,
    proxy: EventLoopProxy<CustomEvent>,
) {
    let path_for_event = out_path.clone();
    crate::cdp_win::cdp_call_to_file(
        webview,
        "pdf",
        "Page.printToPDF",
        PRINT_PARAMS,
        out_path,
        move |ok| {
            let _ = proxy.send_event(CustomEvent::PdfExportDone { ok, path: path_for_event });
        },
    );
}

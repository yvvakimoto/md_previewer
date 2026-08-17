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

/// CSS pixels per inch — the unit `Page.printToPDF` measures paper in.
const CSS_PX_PER_IN: f64 = 96.0;

/// Build the `Page.printToPDF` params.
///
/// `page_px` is the paper size in CSS px, sent up by the preview when it laid
/// itself out for a fixed-size page — today that means a Marp deck, whose slide
/// box (1280×720 for 16:9, 960×720 for 4:3) becomes the paper so each slide
/// fills exactly one page. Such a page gets **zero margins**: the slide is the
/// page. `None` keeps the historical A4 portrait with 0.4in margins, which is
/// what an ordinary Markdown document still wants.
///
/// `printBackground` keeps code-block / theme backgrounds, `generateDocumentOutline`
/// builds heading-based bookmarks, and `preferCSSPageSize` lets the document's own
/// `@page` win — the preview injects one matching `page_px`, so the size is
/// carried by both channels and they agree whichever Chromium honours.
fn print_params(page_px: Option<(f64, f64)>) -> String {
    let (w_in, h_in, margin) = match page_px {
        Some((w, h)) => (w / CSS_PX_PER_IN, h / CSS_PX_PER_IN, 0.0),
        None => (8.27, 11.69, 0.4),
    };
    format!(
        concat!(
            "{{",
            "\"landscape\":false,",
            "\"printBackground\":true,",
            "\"generateDocumentOutline\":true,",
            "\"preferCSSPageSize\":true,",
            "\"scale\":1,",
            "\"marginTop\":{m},\"marginBottom\":{m},\"marginLeft\":{m},\"marginRight\":{m},",
            "\"paperWidth\":{w},\"paperHeight\":{h}",
            "}}"
        ),
        m = margin,
        w = w_in,
        h = h_in
    )
}

/// Print the document currently loaded in `webview` to a PDF at `out_path`.
/// Non-blocking: the file is written and `PdfExportDone` is posted from the
/// async CDP completion handler. See [`print_params`] for `page_px`.
pub fn print_current_to_pdf(
    webview: &WebView,
    out_path: PathBuf,
    page_px: Option<(f64, f64)>,
    proxy: EventLoopProxy<CustomEvent>,
) {
    let path_for_event = out_path.clone();
    crate::cdp_win::cdp_call_to_file(
        webview,
        "pdf",
        "Page.printToPDF",
        &print_params(page_px),
        out_path,
        move |ok| {
            let _ = proxy.send_event(CustomEvent::PdfExportDone { ok, path: path_for_event });
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_params_are_a4_portrait_with_margins() {
        let p = print_params(None);
        assert!(p.contains("\"paperWidth\":8.27"), "{}", p);
        assert!(p.contains("\"paperHeight\":11.69"), "{}", p);
        assert!(p.contains("\"marginTop\":0.4"), "{}", p);
    }

    #[test]
    fn slide_params_use_the_slide_box_and_no_margins() {
        // 16:9 → 13.333…×7.5in. Sub-pixel drift here would push a slide onto a
        // second page, so assert the round trip back to CSS px is exact.
        let p = print_params(Some((1280.0, 720.0)));
        assert!(p.contains("\"paperWidth\":13.333333333333334"), "{}", p);
        assert!(p.contains("\"paperHeight\":7.5"), "{}", p);
        assert!(p.contains("\"marginTop\":0,\"marginBottom\":0"), "{}", p);
        assert!(p.contains("\"marginLeft\":0,\"marginRight\":0"), "{}", p);

        // 4:3 decks (front-matter `size: 4:3`) are 960×720.
        let p = print_params(Some((960.0, 720.0)));
        assert!(p.contains("\"paperWidth\":10,"), "{}", p);
        assert!(p.contains("\"paperHeight\":7.5"), "{}", p);
    }

    #[test]
    fn params_keep_the_outline_and_background_flags() {
        for p in [print_params(None), print_params(Some((1280.0, 720.0)))] {
            assert!(p.contains("\"generateDocumentOutline\":true"), "{}", p);
            assert!(p.contains("\"printBackground\":true"), "{}", p);
            assert!(p.contains("\"preferCSSPageSize\":true"), "{}", p);
        }
    }
}

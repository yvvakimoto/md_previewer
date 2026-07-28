// Shared WebView2 DevTools-Protocol (CDP) plumbing for the two features that
// need a binary artifact out of the live webview: PDF export (`pdf_win`) and
// headless PNG capture (`png_win`).
//
// Both do exactly the same dance — obtain the `ICoreWebView2` from the wry
// `WebView`, call `CallDevToolsProtocolMethod` with an async completion handler,
// then base64-decode the `{"data":"<base64>"}` result and write it to disk —
// and differ only in the CDP method name, the params JSON, and which
// `CustomEvent` they post when finished. That difference lives in the caller;
// everything else, including the one `unsafe` FFI block, lives here.
//
// The call is asynchronous: `CallDevToolsProtocolMethod` returns immediately and
// the handler fires later on the UI thread.

#![cfg(windows)]

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::core::PCWSTR;
use wry::webview::{WebView, WebviewExtWindows};

/// Every CDP method we use returns its payload as base64 under `data`.
#[derive(Deserialize)]
struct CdpDataResult {
    data: String,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Holds the completion callback so that exactly one of the two mutually
/// exclusive outcomes — the dispatch failed, or the async handler fired — can
/// consume it. The compiler cannot see that they are exclusive, so we make the
/// at-most-once guarantee explicit instead of cloning the callback.
struct OnceDone<F: FnOnce(bool)>(Rc<RefCell<Option<F>>>);

impl<F: FnOnce(bool)> OnceDone<F> {
    fn new(f: F) -> Self {
        Self(Rc::new(RefCell::new(Some(f))))
    }

    fn share(&self) -> Self {
        Self(Rc::clone(&self.0))
    }

    fn fire(&self, ok: bool) {
        if let Some(f) = self.0.borrow_mut().take() {
            f(ok);
        }
    }
}

/// Invoke CDP `method` with `params` on `webview`'s CoreWebView2, decode the
/// `{"data":"<base64>"}` result, write the bytes to `out_path`, and hand the
/// success flag to `on_done`.
///
/// Non-blocking — `on_done` runs on the UI thread, either inline (when the call
/// could not be dispatched at all) or later from the completion handler. It is
/// called **exactly once**. Every failure — no CoreWebView2, FFI error, bad
/// JSON, bad base64, write error — logs `"<tag>: …"` to stderr and yields
/// `on_done(false)`.
pub fn cdp_call_to_file<F>(
    webview: &WebView,
    tag: &'static str,
    method: &str,
    params: &str,
    out_path: PathBuf,
    on_done: F,
) where
    F: FnOnce(bool) + 'static,
{
    let done = OnceDone::new(on_done);

    let controller = webview.controller();
    let core: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}: failed to get CoreWebView2: {}", tag, e);
            done.fire(false);
            return;
        }
    };

    let method_w = wide(method);
    let params_w = wide(params);
    let done_for_cb = done.share();

    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, json: String| {
            let ok = result.is_ok() && write_decoded(tag, &out_path, &json);
            done_for_cb.fire(ok);
            Ok(())
        },
    ));

    let call = unsafe {
        core.CallDevToolsProtocolMethod(
            PCWSTR::from_raw(method_w.as_ptr()),
            PCWSTR::from_raw(params_w.as_ptr()),
            &handler,
        )
    };
    if let Err(e) = call {
        // The handler will never fire, so settle the callback here.
        eprintln!("{}: CallDevToolsProtocolMethod failed: {}", tag, e);
        done.fire(false);
    }
}

/// Parse the CDP result, base64-decode `data`, and write it to `out_path`.
fn write_decoded(tag: &str, out_path: &Path, json: &str) -> bool {
    let parsed: CdpDataResult = match serde_json::from_str(json) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}: bad CDP result json: {}", tag, e);
            return false;
        }
    };
    let bytes = match STANDARD.decode(parsed.data.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{}: base64 decode failed: {}", tag, e);
            return false;
        }
    };
    if let Err(e) = std::fs::write(out_path, &bytes) {
        eprintln!("{}: write {} failed: {}", tag, out_path.display(), e);
        return false;
    }
    true
}

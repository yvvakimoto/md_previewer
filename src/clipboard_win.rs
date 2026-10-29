// Win32 OS-clipboard bridge for the companion editor's Vim yank/paste.
//
// The editor webview is served over the insecure `app://localhost` scheme,
// where Chromium does not expose `navigator.clipboard` (and disables
// `execCommand('paste')`). So there is no JS-only way to *read* the OS
// clipboard. To make Vim's `y`/`p` (and `d`/`c`/`x` under unnamedplus
// semantics) interoperate across editor windows and with other applications,
// the editor JS routes clipboard access through Rust IPC, and these helpers do
// the actual Win32 work via the `clipboard-win` crate (which wraps
// OpenClipboard / SetClipboardData / GetClipboardData with proper
// CF_UNICODETEXT handling and clipboard-lock retries).
//
// Both text functions are best-effort: the clipboard can be transiently locked
// by another process, in which case we simply return None / do nothing rather
// than propagate an error to the IPC layer. `set_figure` serves the PREVIEW's
// figure copy instead, which has the same no-navigator.clipboard problem.

#![cfg(windows)]

use clipboard_win::{get_clipboard_string, set_clipboard_string};

/// Read the OS clipboard as text. Returns `None` when the clipboard is empty,
/// holds non-text data, or is transiently locked.
pub fn get_clipboard() -> Option<String> {
    get_clipboard_string().ok()
}

/// Write `text` to the OS clipboard. Best-effort: errors (e.g. a transiently
/// locked clipboard) are swallowed — clipboard sync is not worth failing over.
pub fn set_clipboard(text: &str) {
    let _ = set_clipboard_string(text);
}

/// Put one rendered figure on the OS clipboard (the preview's right-click
/// 「SVG / PNG としてコピー」, the `copyfigure:` IPC). Unlike the text helpers this
/// one reports failure, because the user asked for it and gets a toast.
///
/// All formats go in under ONE open/empty, so a paste never sees a half-written
/// set. Formats are written richest first — some consumers take the first one
/// they recognise in enumeration order.
/// - `png`: the registered `PNG` format (Office, browsers, chat apps keep the
///   bytes as-is) and, when the webview supplied it, a packed `CF_DIB` for the
///   readers that only know bitmaps (Paint, the Win+V history).
/// - `svg`: the registered `image/svg+xml` format (Office 365 / Inkscape paste it
///   as a vector picture) and the same markup as `CF_UNICODETEXT`, for editors.
pub fn set_figure(ext: &str, bytes: &[u8], dib: Option<&[u8]>) -> Result<(), String> {
    use clipboard_win::{formats, options, raw, Clipboard};
    let err = |what: &str, e: clipboard_win::ErrorCode| format!("{}: {}", what, e);
    let register = |name: &str| {
        raw::register_format(name)
            .map(|f| f.get())
            .ok_or_else(|| format!("could not register clipboard format {:?}", name))
    };
    // Held for the whole function: closes the clipboard on drop.
    let _clip = Clipboard::new_attempts(10).map_err(|e| err("open", e))?;
    raw::empty().map_err(|e| err("empty", e))?;
    match ext {
        "png" => {
            raw::set_without_clear(register("PNG")?, bytes).map_err(|e| err("PNG", e))?;
            if let Some(d) = dib {
                raw::set_without_clear(formats::CF_DIB, d).map_err(|e| err("CF_DIB", e))?;
            }
        }
        "svg" => {
            raw::set_without_clear(register("image/svg+xml")?, bytes)
                .map_err(|e| err("image/svg+xml", e))?;
            let text = std::str::from_utf8(bytes).map_err(|e| format!("SVG is not UTF-8: {}", e))?;
            raw::set_string_with(text, options::NoClear).map_err(|e| err("text", e))?;
        }
        _ => return Err(format!("unsupported extension {:?}", ext)),
    }
    Ok(())
}

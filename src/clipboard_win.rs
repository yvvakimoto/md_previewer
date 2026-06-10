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
// Both functions are best-effort: the clipboard can be transiently locked by
// another process, in which case we simply return None / do nothing rather
// than propagate an error to the IPC layer.

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

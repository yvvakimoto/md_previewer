// Win32 IMM bridge for IME (Input Method Editor) control on Windows.
//
// WebView2 / Chromium uses TSF (Text Services Framework) under the hood and
// hosts the editable surface inside a chain of child HWNDs (`Chrome_WidgetWin_1`,
// `Chrome_RenderWidgetHostHWND`, ...). Pure IMM messages aimed at the tao
// top-level window often go nowhere — the focused descendant has its own
// input context, and the actual key open-status lives there.
//
// To turn IME on/off reliably we cast a wide net:
//   1. Read current open-status (so we can short-circuit and verify).
//   2. Across every candidate HWND (focused descendant, all descendants
//      gathered via `EnumChildWindows`, then the tao parent), call both
//      `ImmGetContext` + `ImmSetOpenStatus` (direct API) and
//      `SendMessageW(ImmGetDefaultIMEWnd, WM_IME_CONTROL, IMC_SETOPENSTATUS)`
//      (control-message API).
//   3. Re-read open-status — if it still doesn't match the requested state,
//      `SendInput` a synthetic `VK_KANJI` keystroke (the 半角/全角 toggle
//      key, which most Japanese IMEs honor under both IMM and TSF).
//
// `get_ime_open` is symmetric: it queries every candidate and reports `true`
// if any of them reports open. This handles the case where the focused
// HWND's default-IME-window query returns a stale value while a sibling
// HWND has the real input context.

#![cfg(windows)]

use std::os::raw::c_void;

#[allow(non_camel_case_types)]
type HWND = *mut c_void;
#[allow(non_camel_case_types)]
type UINT = u32;
#[allow(non_camel_case_types)]
type WPARAM = usize;
#[allow(non_camel_case_types)]
type LPARAM = isize;
#[allow(non_camel_case_types)]
type LRESULT = isize;
#[allow(non_camel_case_types)]
type DWORD = u32;
#[allow(non_camel_case_types)]
type BOOL = i32;
#[allow(non_camel_case_types)]
type LONG = i32;
#[allow(non_camel_case_types)]
type WORD = u16;
#[allow(non_camel_case_types)]
type HIMC = *mut c_void;

#[repr(C)]
#[allow(non_snake_case)]
struct RECT {
    left: LONG,
    top: LONG,
    right: LONG,
    bottom: LONG,
}

#[repr(C)]
#[allow(non_snake_case)]
struct GUITHREADINFO {
    cbSize: DWORD,
    flags: DWORD,
    hwndActive: HWND,
    hwndFocus: HWND,
    hwndCapture: HWND,
    hwndMenuOwner: HWND,
    hwndMoveSize: HWND,
    hwndCaret: HWND,
    rcCaret: RECT,
}

// INPUT struct for SendInput. We always send KEYBDINPUT, but the union is
// sized by the largest variant (MOUSEINPUT on x64 = 24 bytes after the type
// field). Lay out the struct so the 4-byte `type` is followed by 4 bytes of
// padding (alignment to 8) and then 24 bytes of payload; KEYBDINPUT is 24
// bytes on x64 (16 on x86, but Windows desktop is x64 in practice).
#[repr(C)]
#[allow(non_snake_case)]
struct KEYBDINPUT {
    wVk: WORD,
    wScan: WORD,
    dwFlags: DWORD,
    time: DWORD,
    dwExtraInfo: usize,
    _pad: [u8; 8],
}

#[repr(C)]
#[allow(non_snake_case)]
struct INPUT {
    r#type: DWORD,
    _align: u32,
    ki: KEYBDINPUT,
}

const WM_IME_CONTROL: UINT = 0x0283;
const IMC_GETOPENSTATUS: WPARAM = 0x0005;
const IMC_SETOPENSTATUS: WPARAM = 0x0006;

const INPUT_KEYBOARD: DWORD = 1;
const KEYEVENTF_KEYUP: DWORD = 0x0002;
const VK_KANJI: WORD = 0x19;

type WNDENUMPROC = unsafe extern "system" fn(HWND, LPARAM) -> BOOL;

#[link(name = "user32")]
extern "system" {
    fn SendMessageW(hwnd: HWND, msg: UINT, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    fn GetWindowThreadProcessId(hwnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
    fn GetGUIThreadInfo(idThread: DWORD, lpgui: *mut GUITHREADINFO) -> BOOL;
    fn IsWindow(hwnd: HWND) -> BOOL;
    fn EnumChildWindows(parent: HWND, lpEnumFunc: WNDENUMPROC, lParam: LPARAM) -> BOOL;
    fn SendInput(cInputs: UINT, pInputs: *mut INPUT, cbSize: i32) -> UINT;
}

#[link(name = "imm32")]
extern "system" {
    fn ImmGetDefaultIMEWnd(hwnd: HWND) -> HWND;
    fn ImmGetContext(hwnd: HWND) -> HIMC;
    fn ImmReleaseContext(hwnd: HWND, himc: HIMC) -> BOOL;
    fn ImmSetOpenStatus(himc: HIMC, open: BOOL) -> BOOL;
    fn ImmGetOpenStatus(himc: HIMC) -> BOOL;
}

unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam as *mut Vec<HWND>);
    list.push(hwnd);
    1 // continue enumeration
}

/// Collect every HWND that could plausibly own the IMM/TSF input context for
/// the editor: the focused descendant first, then every child window of the
/// tao parent (recursive via EnumChildWindows), then the tao parent itself.
/// Deduplicated, focused-first so the most likely target is queried first.
fn candidate_hwnds(parent_hwnd: HWND) -> Vec<HWND> {
    let mut out: Vec<HWND> = Vec::new();
    if parent_hwnd.is_null() {
        return out;
    }
    // 1. Focused descendant of the tao window's GUI thread (best guess).
    if let Some(focus) = focused_hwnd_for(parent_hwnd) {
        out.push(focus);
    }
    // 2. Every child window of the tao top-level.
    let mut children: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            parent_hwnd,
            enum_child_proc,
            &mut children as *mut Vec<HWND> as LPARAM,
        );
    }
    for c in children {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    // 3. The tao parent itself as final fallback.
    if !out.contains(&parent_hwnd) {
        out.push(parent_hwnd);
    }
    out
}

/// Walk to the focused descendant HWND of `parent`'s GUI thread.
fn focused_hwnd_for(parent: HWND) -> Option<HWND> {
    if parent.is_null() {
        return None;
    }
    unsafe {
        let tid = GetWindowThreadProcessId(parent, std::ptr::null_mut());
        if tid == 0 {
            return None;
        }
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as DWORD;
        if GetGUIThreadInfo(tid, &mut info) == 0 {
            return None;
        }
        if info.hwndFocus.is_null() {
            return None;
        }
        Some(info.hwndFocus)
    }
}

/// Read open-status for a single HWND via its `HIMC` (preferred — most direct)
/// or via the default IME window's `IMC_GETOPENSTATUS` (control-message API).
/// `None` if neither path returns a definitive answer.
fn open_status_for(hwnd: HWND) -> Option<bool> {
    if hwnd.is_null() {
        return None;
    }
    unsafe {
        let himc = ImmGetContext(hwnd);
        if !himc.is_null() {
            let r = ImmGetOpenStatus(himc);
            ImmReleaseContext(hwnd, himc);
            return Some(r != 0);
        }
        let ime_wnd = ImmGetDefaultIMEWnd(hwnd);
        if ime_wnd.is_null() {
            return None;
        }
        let r = SendMessageW(ime_wnd, WM_IME_CONTROL, IMC_GETOPENSTATUS, 0);
        Some(r != 0)
    }
}

/// Best-effort: write open-status to a single HWND via both APIs.
fn write_open_status(hwnd: HWND, open: bool) {
    if hwnd.is_null() {
        return;
    }
    let val: LPARAM = if open { 1 } else { 0 };
    unsafe {
        let himc = ImmGetContext(hwnd);
        if !himc.is_null() {
            let _ = ImmSetOpenStatus(himc, val as BOOL);
            ImmReleaseContext(hwnd, himc);
        }
        let ime_wnd = ImmGetDefaultIMEWnd(hwnd);
        if !ime_wnd.is_null() {
            let _ = SendMessageW(ime_wnd, WM_IME_CONTROL, IMC_SETOPENSTATUS, val);
        }
    }
}

/// Final fallback: synthesize a `VK_KANJI` (半角/全角) keystroke via
/// `SendInput`. Most Japanese IMEs (MS-IME, Google IME, ATOK) honor this
/// virtual key as the IME-mode toggle under both IMM and TSF, so it works
/// when the direct API paths are blocked by Chromium's TSF integration.
fn send_kanji_toggle_key() {
    unsafe {
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        inputs[0].r#type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = VK_KANJI;
        inputs[1].r#type = INPUT_KEYBOARD;
        inputs[1].ki.wVk = VK_KANJI;
        inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
        let _ = SendInput(
            2,
            inputs.as_mut_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

/// Turn the IME open-status on (`true` → 全角／日本語入力モード) or off
/// (`false` → 半角 / direct input).
///
/// No-op when the editor window doesn't currently have keyboard focus, so
/// foreground apps are never affected.
pub fn set_ime_open(parent_hwnd: HWND, open: bool) {
    if parent_hwnd.is_null() {
        return;
    }
    // Bail early if no descendant of the editor's GUI thread has focus.
    // (Otherwise the SendInput fallback would yank IME state away from
    // whichever app the user is actually typing into.)
    if focused_hwnd_for(parent_hwnd).is_none() {
        return;
    }

    let candidates = candidate_hwnds(parent_hwnd);

    // Cheap path: if every observable candidate already reports the desired
    // state, no work to do.
    let any_reads = candidates.iter().any(|h| open_status_for(*h).is_some());
    let all_correct = candidates.iter()
        .filter_map(|h| open_status_for(*h))
        .all(|cur| cur == open);
    if any_reads && all_correct {
        return;
    }

    // Try the direct IMM APIs first across all candidates.
    for h in &candidates {
        write_open_status(*h, open);
    }

    // Verify; if any observable candidate still reports the opposite of the
    // requested state, fall back to a synthetic `VK_KANJI` toggle. This
    // handles WebView2 / Chromium's TSF backend, which often ignores IMM
    // state writes — the VK_KANJI keystroke is the only path that actually
    // reaches the IME on those configurations.
    let still_wrong = candidates.iter()
        .filter_map(|h| open_status_for(*h))
        .any(|cur| cur != open);
    if still_wrong {
        send_kanji_toggle_key();
    }
}

/// Thin wrapper over Win32 `IsWindow` so the IME polling thread can detect
/// the editor window's destruction without coupling to the registry.
pub fn is_window(hwnd: HWND) -> bool {
    if hwnd.is_null() {
        return false;
    }
    unsafe { IsWindow(hwnd) != 0 }
}

/// Read the IME open-status for the editor window.
/// Returns `None` when focus isn't on the editor window or no candidate HWND
/// returns a definitive answer.
pub fn get_ime_open(parent_hwnd: HWND) -> Option<bool> {
    focused_hwnd_for(parent_hwnd)?;
    let candidates = candidate_hwnds(parent_hwnd);
    // Prefer the first candidate that returns a definitive answer.
    for h in &candidates {
        if let Some(v) = open_status_for(*h) {
            return Some(v);
        }
    }
    None
}

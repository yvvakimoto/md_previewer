// OS-clipboard-backed Vim yank/paste.
//
// @replit/codemirror-vim keeps yanked/deleted text in an in-process "unnamed"
// register that lives inside a single WebView2 instance, so plain `y`/`p`
// can't cross editor windows or reach other applications. The package *does*
// wire the OS clipboard, but only for the explicit `"+` register
// (`navigator.clipboard.writeText` on `"+y`, `readText` on `"+p`). On top of
// that, the editor is served over the insecure `app://localhost` scheme, where
// Chromium does not expose `navigator.clipboard` at all (and disables
// `execCommand('paste')`), so there is no JS-only clipboard *read* path.
//
// This module makes plain `y`/`d`/`c`/`x` and `p`/`P` use the OS clipboard
// (`set clipboard=unnamedplus` semantics), routing the actual clipboard access
// through Rust IPC (see the editor:clipboard:set: / editor:clipboard:get:
// handlers in src/editor_registry.rs). Because the OS clipboard is system-wide,
// every editor window going through it automatically interoperates with the
// others and with external apps — no editor↔editor channel is needed.
//
// Three pieces:
//   (a) Replace navigator.clipboard.{writeText,readText} with IPC-backed shims
//       (also makes the package's own "+y / "+p reliable on app://).
//   (b) Copy side: wrap the register controller's pushText so any yank / delete
//       / change to the default register mirrors the unnamed register out to
//       the OS clipboard.
//   (c) Paste side: on window focus, pull the OS clipboard *into* the unnamed
//       register (charwise) so plain `p`/`P` paste external / cross-editor
//       content via the package's normal synchronous paste path. A guard
//       against our own last-written text preserves locally-yanked linewise
//       registers (so `yy`→`p` stays linewise).

let __shimInstalled = false;
let __pushTextPatched = false;
let __focusBound = false;

let __pendingClipReads = null; // Map<id, resolve>
let __clipReqId = 0;

// The text we most recently pushed OUT to the OS clipboard. Used by the focus
// sync to avoid clobbering a locally-yanked (possibly linewise) register when
// the clipboard still holds our own copy.
let __lastLocalClip = null;

// (a) IPC-backed navigator.clipboard shim.
function installClipboardShim(ipcSend) {
  if (__shimInstalled) return;
  __shimInstalled = true;
  __pendingClipReads = new Map();

  // Rust calls this back in response to editor:clipboard:get:<id>.
  window.__clipboardResult = (id, text) => {
    const resolve = __pendingClipReads.get(id);
    if (resolve) {
      __pendingClipReads.delete(id);
      resolve(typeof text === 'string' ? text : '');
    }
  };

  const clip = {
    writeText(text) {
      try { ipcSend('editor:clipboard:set:' + (text == null ? '' : String(text))); } catch (_) {}
      return Promise.resolve();
    },
    readText() {
      return new Promise((resolve) => {
        const id = ++__clipReqId;
        __pendingClipReads.set(id, resolve);
        try {
          ipcSend('editor:clipboard:get:' + id);
        } catch (_) {
          __pendingClipReads.delete(id);
          resolve('');
          return;
        }
        // Never hang a paste forever if the host doesn't answer.
        setTimeout(() => {
          if (__pendingClipReads.has(id)) {
            __pendingClipReads.delete(id);
            resolve('');
          }
        }, 1000);
      });
    },
  };

  // On app:// navigator.clipboard is typically undefined → define it. In a
  // secure context where it exists, shadow its methods with our IPC versions
  // (the real readText is permission-gated / unreliable here).
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = clip.writeText;
      navigator.clipboard.readText = clip.readText;
    } else {
      Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    }
  } catch (_) {
    try {
      Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    } catch (_) {}
  }
}

// (b) Mirror default-register yank/delete/change out to the OS clipboard.
function patchPushText(Vim, ipcSend) {
  if (__pushTextPatched) return;
  let rc = null;
  try { rc = Vim.getRegisterController && Vim.getRegisterController(); } catch (_) {}
  if (!rc || typeof rc.pushText !== 'function' || rc.__clipWrapped) return;

  const orig = rc.pushText;
  rc.pushText = function (registerName, operator, text, linewise, blockwise) {
    const ret = orig.call(this, registerName, operator, text, linewise, blockwise);
    try {
      // Only when no explicit register was specified (the default/unnamed
      // path). '_' is the black hole and is truthy, so !registerName excludes
      // it. The package's own "+ path already wrote the clipboard via the shim.
      if (!registerName && this.unnamedRegister) {
        const out = this.unnamedRegister.toString();
        if (out) {
          __lastLocalClip = out;
          ipcSend('editor:clipboard:set:' + out);
        }
      }
    } catch (_) {}
    return ret;
  };
  rc.__clipWrapped = true;
  __pushTextPatched = true;
}

// (c) Pull the OS clipboard into the unnamed register on focus.
function syncFromClipboard(Vim) {
  let rc = null;
  try { rc = Vim.getRegisterController && Vim.getRegisterController(); } catch (_) {}
  if (!rc || !rc.unnamedRegister) return;
  let readText = null;
  try { readText = navigator.clipboard && navigator.clipboard.readText; } catch (_) {}
  if (typeof readText !== 'function') return;

  navigator.clipboard.readText().then((text) => {
    if (typeof text !== 'string' || text === '') return;
    // Unchanged since our own last yank → keep the local register (preserves
    // linewise / blockwise). External text is charwise, which is correct.
    if (text === __lastLocalClip) return;
    try {
      rc.unnamedRegister.setText(text);
      __lastLocalClip = text;
    } catch (_) {}
  }).catch(() => {});
}

// Public entry. Idempotent — safe to call on every vim-enable / boot.
export function installClipboardSync({ Vim, ipcSend } = {}) {
  if (!ipcSend) return;
  installClipboardShim(ipcSend);
  try { patchPushText(Vim, ipcSend); } catch (_) {}

  if (!__focusBound) {
    __focusBound = true;
    // Window 'focus' fires when the OS window regains focus from another
    // window/app — exactly the moment the OS clipboard may have changed
    // (cross-editor copy, external-app copy). Not chatty like focusin.
    window.addEventListener('focus', () => { try { syncFromClipboard(Vim); } catch (_) {} });
  }
  // Initial pull so the first paste reflects the current OS clipboard.
  setTimeout(() => { try { syncFromClipboard(Vim); } catch (_) {} }, 0);
}

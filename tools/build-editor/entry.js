// Editor entrypoint. Bundled as IIFE -> window.MdEditor.create(target, opts).
//
// Wire:
//   window.__initialFile = { path, content }   (injected by Rust)
//   window.__loadFile({path, content})         (called by Rust on switch / save echo)
//   window.__previewScrolledTo(line)           (preview→editor cursor sync)
//   window.ipc.postMessage('editor:ready')
//   window.ipc.postMessage('editor:save:' + JSON.stringify({path, content}))
//   window.ipc.postMessage('editor:cursor:' + line)
//   window.ipc.postMessage('editor:close:')

import { EditorState, Compartment, StateEffect, Transaction } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import {
  foldGutter, foldService, foldedRanges, foldEffect, unfoldEffect,
  unfoldAll, indentOnInput, syntaxHighlighting,
  defaultHighlightStyle, bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { vim, Vim, getCM } from '@replit/codemirror-vim';

import { mathInputAssistKeymap, isInsideMath } from './mathInputAssist.js';
import { charCount } from './charCount.js';
import { texEnvCompletionSource } from './texEnvComplete.js';
import { pathCompletionSource } from './pathComplete.js';
import { installJpWordMotion } from './jpWordMotion.js';

// ---------- ATX heading fold service ----------
function headingLevel(line) {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}
function computeHeadingFoldRange(state, headingLineNum) {
  const startLine = state.doc.line(headingLineNum);
  const lvl = headingLevel(startLine.text);
  if (lvl === 0) return null;
  let end = startLine.to;
  for (let i = startLine.number + 1; i <= state.doc.lines; i++) {
    const ln = state.doc.line(i);
    const lv = headingLevel(ln.text);
    if (lv > 0 && lv <= lvl) break;
    end = ln.to;
  }
  if (end <= startLine.to) return null;
  return { from: startLine.to, to: end };
}
const headingFold = foldService.of((state, lineStart) => {
  const startLine = state.doc.lineAt(lineStart);
  return computeHeadingFoldRange(state, startLine.number);
});

function findHeadingLine(state, fromLine, dir) {
  const total = state.doc.lines;
  let i = fromLine + dir;
  while (i >= 1 && i <= total) {
    if (headingLevel(state.doc.line(i).text) > 0) return i;
    i += dir;
  }
  return 0;
}
function enclosingHeadingLine(state, fromLine) {
  for (let i = fromLine; i >= 1; i--) {
    if (headingLevel(state.doc.line(i).text) > 0) return i;
  }
  return 0;
}
function moveToHeading(view, dir) {
  if (!view) return;
  const state = view.state;
  const curLine = state.doc.lineAt(state.selection.main.head).number;
  const target = findHeadingLine(state, curLine, dir);
  if (!target) return;
  const pos = state.doc.line(target).from;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
}
function isRangeFolded(state, range) {
  let found = false;
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) { found = true; return false; }
  });
  return found;
}
function toggleSectionFold(view) {
  if (!view) return;
  const state = view.state;
  const curLine = state.doc.lineAt(state.selection.main.head).number;
  const headingLn = enclosingHeadingLine(state, curLine);
  if (!headingLn) return;
  const range = computeHeadingFoldRange(state, headingLn);
  if (!range) return;
  const effect = isRangeFolded(state, range)
    ? unfoldEffect.of(range)
    : foldEffect.of(range);
  view.dispatch({ effects: effect });
}
function computeBodyOnlyFoldRange(state, headingLineNum) {
  const startLine = state.doc.line(headingLineNum);
  if (headingLevel(startLine.text) === 0) return null;
  let end = startLine.to;
  for (let i = startLine.number + 1; i <= state.doc.lines; i++) {
    const ln = state.doc.line(i);
    if (headingLevel(ln.text) > 0) break;
    end = ln.to;
  }
  if (end <= startLine.to) return null;
  return { from: startLine.to, to: end };
}
function toggleAllHeadingFolds(view) {
  if (!view) return;
  const state = view.state;
  let anyFolded = false;
  foldedRanges(state).between(0, state.doc.length, () => { anyFolded = true; return false; });
  if (anyFolded) { unfoldAll(view); return; }
  const effects = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    if (headingLevel(state.doc.line(i).text) === 0) continue;
    const range = computeBodyOnlyFoldRange(state, i);
    if (range) effects.push(foldEffect.of(range));
  }
  if (effects.length) view.dispatch({ effects });
}

// ---------- IPC helpers ----------
function ipcSend(msg) {
  try { window.ipc && window.ipc.postMessage && window.ipc.postMessage(msg); } catch (_) {}
}

export function create(root, opts = {}) {
  const status = document.createElement('div');
  status.className = 'status-bar';
  const statusFile = document.createElement('span');
  statusFile.className = 'status-file';
  const statusRight = document.createElement('span');
  statusRight.className = 'status-right';
  const statusInfo = document.createElement('span');
  statusInfo.className = 'status-info';
  statusInfo.style.cursor = 'pointer';
  statusInfo.title = 'Click for character count';
  const statusCtrls = document.createElement('span');
  statusCtrls.className = 'status-ctrls';
  const btnLn = document.createElement('button');
  btnLn.className = 'status-btn';
  btnLn.type = 'button';
  btnLn.title = 'Cycle line number mode (absolute → relative → off)';
  const btnVim = document.createElement('button');
  btnVim.className = 'status-btn';
  btnVim.type = 'button';
  btnVim.title = 'Toggle Vim keybindings';
  const btnTheme = document.createElement('button');
  btnTheme.className = 'status-btn';
  btnTheme.type = 'button';
  btnTheme.title = 'Toggle editor theme (light / dark)';
  statusCtrls.append(btnLn, btnVim, btnTheme);
  statusRight.append(statusInfo, statusCtrls);
  status.appendChild(statusFile);
  status.appendChild(statusRight);

  // Hot-zone strip at the very top of the window that re-opens the status bar
  // on hover (the bar itself auto-hides; see editor.css).
  const hotzone = document.createElement('div');
  hotzone.className = 'status-hotzone';

  const editorHost = document.createElement('div');
  editorHost.className = 'editor-host';

  root.appendChild(editorHost);
  root.appendChild(hotzone);
  root.appendChild(status);

  // Modal for character count (opened with C in Vim NORMAL).
  const modal = document.createElement('div');
  modal.className = 'cc-modal';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="cc-panel" role="dialog" aria-modal="true">
      <button class="cc-close" type="button" aria-label="Close">&times;</button>
      <h2>Character Count</h2>
      <table class="cc-table"><tbody></tbody></table>
      <div class="cc-hint">Click the status bar to reopen · <kbd>Esc</kbd> to close</div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.cc-close').addEventListener('click', () => closeModal());
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  function openModal() {
    document.body.classList.add('status-pinned');
    const text = view.state.doc.toString();
    const sel = view.state.selection.main;
    const selText = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
    const stats = charCount(text);
    const rows = [
      ['Total characters (incl. whitespace)', stats.charsAll],
      ['Total characters (excl. whitespace)', stats.charsNoSpace],
      ['Body characters (excl. YAML/code/math, no whitespace)', stats.bodyChars],
      ['Words (whitespace-separated)', stats.words],
      ['Lines', stats.lines],
      ['Paragraphs', stats.paragraphs],
    ];
    if (selText) {
      const s = charCount(selText);
      rows.push(['—', '']);
      rows.push(['Selection: characters (excl. whitespace)', s.charsNoSpace]);
      rows.push(['Selection: words', s.words]);
    }
    const tbody = modal.querySelector('tbody');
    tbody.innerHTML = rows.map(([k, v]) =>
      `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('');
    modal.style.display = 'flex';
  }
  function closeModal() {
    modal.style.display = 'none';
    document.body.classList.remove('status-pinned');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      e.preventDefault();
      closeModal();
      return;
    }
    // Dismiss Vim ex-command/search result messages (e.g. errors like
    // "E492: Not an editor command: set number") with a keypress instead of
    // requiring a mouse click. Triggered for any non-modifier key so typing
    // continues to clear the prompt naturally; mouse click still works too.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    let dismissed = false;
    const panels = document.querySelectorAll('.cm-vim-panel, .cm-panel-vim');
    panels.forEach((p) => {
      const input = p.querySelector('input, textarea');
      const isInputActive = input && document.activeElement === input;
      if (isInputActive) return;
      // The notification dialog (child of .cm-vim-panel) holds the proper
      // onclick → close() that also clears cm.state.dialog /
      // cm.state.currentNotificationClose. Just removing the panel DOM leaves
      // those refs stale, so the next Vim action re-renders the message.
      const dialog = p.querySelector('div[class=""], div:not([class])') || p.firstElementChild;
      if (dialog && typeof dialog.onclick === 'function') {
        try { dialog.onclick({ preventDefault() {} }); dismissed = true; return; } catch (_) {}
      }
      try {
        const cm = view.cm;
        if (cm && cm.state && typeof cm.state.currentNotificationClose === 'function') {
          cm.state.currentNotificationClose();
          dismissed = true;
          return;
        }
      } catch (_) {}
      if (p.parentNode) { p.parentNode.removeChild(p); dismissed = true; }
    });
    if (dismissed && e.key === 'Escape') {
      e.preventDefault();
    }
  });
  statusInfo.addEventListener('click', openModal);

  // ---------- Editor state ----------
  let currentPath = '';
  let savedDoc = '';
  let dirty = false;
  let suppressEcho = false; // ignore the next __loadFile echo from Rust after our save

  // ---------- Persisted UI prefs ----------
  const LS_VIM = 'editor:vim';
  const LS_LN = 'editor:lineNumbers';
  const LS_THEME = 'editor:theme';
  function readPref(key, valid, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v && valid.indexOf(v) >= 0) return v;
    } catch (_) {}
    return fallback;
  }
  let vimState = readPref(LS_VIM, ['on', 'off'], 'off') === 'on';
  let lineNoState = readPref(LS_LN, ['absolute', 'relative', 'off'], 'absolute');
  let themeState = readPref(LS_THEME, ['light', 'dark'], 'light');

  const vimComp = new Compartment();
  const lineNoComp = new Compartment();
  const themeComp = new Compartment();

  // Apply chrome theme class on initial paint (before any toggle click).
  document.body.classList.toggle('theme-dark', themeState === 'dark');

  function lineNumberExt(mode) {
    if (mode === 'off') return [];
    if (mode === 'relative') {
      return lineNumbers({
        formatNumber: (lineNo, st) => {
          const cur = st.doc.lineAt(st.selection.main.head).number;
          return lineNo === cur ? String(lineNo) : String(Math.abs(lineNo - cur));
        },
      });
    }
    return lineNumbers();
  }

  function updateToolbar() {
    btnVim.textContent = vimState ? 'Vim: ON' : 'Vim: OFF';
    btnVim.classList.toggle('active', vimState);
    const lnLabel = { absolute: '# Abs', relative: '# Rel', off: '# Off' }[lineNoState];
    btnLn.textContent = lnLabel;
    btnLn.classList.toggle('active', lineNoState !== 'absolute');
    btnTheme.textContent = themeState === 'dark' ? 'Theme: Dark' : 'Theme: Light';
    btnTheme.classList.toggle('active', themeState === 'dark');
  }
  function setVim(on) {
    vimState = !!on;
    try { localStorage.setItem(LS_VIM, vimState ? 'on' : 'off'); } catch (_) {}
    view.dispatch({ effects: vimComp.reconfigure(vimState ? vim() : []) });
    if (!vimState) {
      window.__vimMode = '';
      __vimSubAttached = null; // CM5 adapter is gone; force re-attach next time on.
    } else {
      // Defer until after the reconfigure flushes; getCM needs the adapter.
      setTimeout(attachVimModeListener, 0);
    }
    updateToolbar();
    updateStatus();
    setTimeout(() => view.focus(), 0);
  }
  function setLineNo(mode) {
    if (['absolute', 'relative', 'off'].indexOf(mode) < 0) return;
    lineNoState = mode;
    try { localStorage.setItem(LS_LN, mode); } catch (_) {}
    view.dispatch({ effects: lineNoComp.reconfigure(lineNumberExt(mode)) });
    updateToolbar();
  }
  function cycleLineNo() {
    setLineNo({ absolute: 'relative', relative: 'off', off: 'absolute' }[lineNoState]);
  }
  function setTheme(next) {
    if (next !== 'light' && next !== 'dark') return;
    themeState = next;
    try { localStorage.setItem(LS_THEME, themeState); } catch (_) {}
    view.dispatch({ effects: themeComp.reconfigure(themeState === 'dark' ? oneDark : []) });
    document.body.classList.toggle('theme-dark', themeState === 'dark');
    updateToolbar();
    setTimeout(() => view.focus(), 0);
  }
  btnVim.addEventListener('click', () => setVim(!vimState));
  btnLn.addEventListener('click', cycleLineNo);
  btnTheme.addEventListener('click', () => setTheme(themeState === 'dark' ? 'light' : 'dark'));

  function updateTitle() {
    const base = currentPath.split(/[\\/]/).pop() || 'Untitled';
    document.title = `${dirty ? '• ' : ''}${base} — Editor`;
    statusFile.textContent = (dirty ? '• ' : '') + base;
  }
  function updateStatus() {
    if (!view) return;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const col = sel.head - line.from + 1;
    const total = view.state.doc.length;
    const mode = (window.__vimMode || '').toUpperCase();
    const modeStr = mode ? ` · ${mode}` : '';
    statusInfo.textContent = `Ln ${line.number}, Col ${col} · ${total} chars${modeStr}`;
  }

  // Save command
  function doSave() {
    const content = view.state.doc.toString();
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
    ipcSend('editor:save:' + JSON.stringify({ path: currentPath, content }));
    savedDoc = content;
    dirty = false;
    updateTitle();
  }

  // Debounced live-content push to the preview (no disk write).
  let liveTimer = 0;
  function schedulePushLive() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = 0;
      if (!currentPath || suppressEcho) return;
      const content = view.state.doc.toString();
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head).number;
      ipcSend('editor:change:' + JSON.stringify({ path: currentPath, content, line }));
    }, 150);
  }
  // Hook Vim :w / :wq to save.
  try {
    Vim.defineEx('write', 'w', doSave);
    Vim.defineEx('wq', undefined, () => { doSave(); /* keep window — close via main */ });
    Vim.defineEx('quit', 'q', () => ipcSend('editor:close:'));
    Vim.defineEx('set', undefined, (_cm, params) => {
      const arg = (params && params.args && params.args[0]) || '';
      switch (arg) {
        case 'number': case 'nu':              setLineNo('absolute'); break;
        case 'nonumber': case 'nonu':          setLineNo('off');      break;
        case 'relativenumber': case 'rnu':     setLineNo('relative'); break;
        case 'norelativenumber': case 'nornu': setLineNo('absolute'); break;
        default: break;
      }
    });
  } catch (_) {}

  // Heading navigation + section folding (NORMAL mode).
  try {
    Vim.defineAction('mdNextHeading',       (cm) => moveToHeading(cm.cm6, +1));
    Vim.defineAction('mdPrevHeading',       (cm) => moveToHeading(cm.cm6, -1));
    Vim.defineAction('mdToggleSectionFold', (cm) => toggleSectionFold(cm.cm6));
    Vim.defineAction('mdToggleAllFolds',    (cm) => toggleAllHeadingFolds(cm.cm6));
    Vim.mapCommand(']]', 'action', 'mdNextHeading',       {}, { context: 'normal' });
    Vim.mapCommand('[[', 'action', 'mdPrevHeading',       {}, { context: 'normal' });
    Vim.mapCommand('za', 'action', 'mdToggleSectionFold', {}, { context: 'normal' });
    Vim.mapCommand('zA', 'action', 'mdToggleAllFolds',    {}, { context: 'normal' });
  } catch (_) {}

  // Japanese-aware w/b/e/W/B/E (and dw/cw/yw/daw/...) — segment by
  // hiragana / katakana / han / ASCII-word / punctuation class boundaries.
  try { installJpWordMotion(Vim); } catch (_) {}

  const saveKey = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => { doSave(); return true; },
  };

  // (Char-count is opened via the status bar — no keybinding to avoid
  // conflicting with Vim's `c` change operator.)

  // Track Vim mode changes (for the status bar).
  let lastGutterCursorLine = -1;
  const modeListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      const cur = u.state.doc.toString();
      const isDirty = cur !== savedDoc;
      if (isDirty !== dirty) { dirty = isDirty; updateTitle(); }
      schedulePushLive();
    }
    if (u.selectionSet || u.docChanged) {
      updateStatus();
      // Notify preview of cursor line.
      if (!u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head).number;
        ipcSend('editor:cursor:' + line);
      }
      // Force the line-number gutter to refresh in relative mode (CodeMirror
      // doesn't re-call formatNumber for non-active lines on selection change).
      if (lineNoState === 'relative') {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head).number;
        if (line !== lastGutterCursorLine) {
          lastGutterCursorLine = line;
          Promise.resolve().then(() => {
            if (lineNoState === 'relative') {
              view.dispatch({ effects: lineNoComp.reconfigure(lineNumberExt('relative')) });
            }
          });
        }
      }
    }
  });

  // ---------- Build state ----------
  const state = EditorState.create({
    doc: '',
    extensions: [
      vimComp.of(vimState ? vim() : []),    // Vim must come first per docs
      lineNoComp.of(lineNumberExt(lineNoState)),
      themeComp.of(themeState === 'dark' ? oneDark : []),
      foldGutter(),
      headingFold,
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage }),
      search(),
      autocompletion({
        override: [texEnvCompletionSource, pathCompletionSource(() => currentPath)],
        activateOnTyping: true,
        defaultKeymap: false,
      }),
      EditorView.lineWrapping,
      keymap.of([
        saveKey,
        ...completionKeymap,
        ...mathInputAssistKeymap(),
        indentWithTab,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      modeListener,
      EditorView.theme({
        '&': { height: '100%', fontSize: '15px' },
        '.cm-scroller': {
          fontFamily: '"Cascadia Code", "Source Han Code JP", "Yu Gothic UI", Consolas, monospace',
          lineHeight: '1.6',
        },
        '.cm-content': { padding: '12px 16px' },
        '.cm-gutters': { background: 'transparent', border: 'none' },
      }),
    ],
  });
  const view = new EditorView({ state, parent: editorHost });
  updateToolbar();

  // Track CodeMirror Vim mode via event hook (replit-codemirror-vim exposes it on CM).
  try {
    Vim.defineRegister && null; // smoke
  } catch (_) {}
  // Poll the cm-vim mode-name from the DOM attribute. Cheap.
  function pollVimMode() {
    try {
      const cm = view.dom;
      const m = cm.querySelector('.cm-vim-panel');
      // mode is exposed via classes added to the editor when in operator-pending etc.
      // Simpler: listen for Vim events.
    } catch (_) {}
  }
  // Subscribe to Vim mode changes via the CM5 adapter that
  // `@replit/codemirror-vim` attaches when the `vim()` extension is active.
  // The `vim-mode-change` event fires on every INSERT / NORMAL / VISUAL
  // transition (including Esc, Ctrl+[, `:stopinsert`, etc.); we use it to
  // flip the OS IME back to half-width whenever the user leaves INSERT.
  //
  // The CM5 adapter only exists while `vim()` is in the editor's extensions,
  // and a fresh one is created whenever vimComp is reconfigured. So we
  // (re)attach on each Vim-on transition (see `setVim`), plus once now in
  // case Vim is already ON from a previous session.
  //
  // NOTE: this package's `Vim.onChangeMode` is undefined — only the per-cm5
  // `vim-mode-change` event works.
  let __vimSubAttached = null; // the cm5 we currently have a listener on
  function attachVimModeListener() {
    if (!vimState) return;
    let cm5 = null;
    try { cm5 = getCM(view); } catch (_) {}
    if (!cm5 || typeof cm5.on !== 'function') return;
    if (__vimSubAttached === cm5) return;
    __vimSubAttached = cm5;
    cm5.on('vim-mode-change', (modeObj) => {
      const mode = modeObj && modeObj.mode ? modeObj.mode : '';
      window.__vimMode = mode;
      updateStatus();
      if (mode !== 'insert') {
        try { window.ipc && window.ipc.postMessage && window.ipc.postMessage('editor:ime:off'); } catch (_) {}
      }
    });
  }
  setTimeout(attachVimModeListener, 0);

  // Rust-side IME poller pushes open-status changes here so we can tint the
  // cursor in both INSERT (cm-cursor) and NORMAL (cm-fat-cursor) modes. See
  // editor.css's `body.ime-open` rules. Boolean: true = 全角/IME open.
  window.__setImeOpen = (open) => {
    try { document.body.classList.toggle('ime-open', !!open); } catch (_) {}
  };

  // ---------- File loading ----------
  function loadFile(payload) {
    if (suppressEcho) { suppressEcho = false; return; }
    if (!payload || typeof payload.content !== 'string') return;
    if (dirty && payload.path !== currentPath) {
      // Different file & dirty: warn instead of swapping silently.
      const ok = window.confirm(
        `Preview switched to "${payload.path}".\nDiscard unsaved changes in "${currentPath}"?`
      );
      if (!ok) return;
    }
    currentPath = payload.path || '';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: payload.content },
      annotations: Transaction.addToHistory.of(false),
    });
    savedDoc = payload.content;
    dirty = false;
    updateTitle();
    updateStatus();
  }
  window.__loadFile = loadFile;

  // Preview→editor cursor sync.
  window.__previewScrolledTo = (line) => {
    try {
      const total = view.state.doc.lines;
      const target = Math.max(1, Math.min(total, line | 0));
      const pos = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
    } catch (_) {}
  };

  // Initial file injection from Rust.
  if (window.__initialFile) {
    loadFile(window.__initialFile);
  }

  // Warn before closing if dirty.
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Focus the editor on startup.
  setTimeout(() => view.focus(), 0);

  // Pin the status bar whenever a Vim ex/search panel is visible.
  const vimPanelObserver = new MutationObserver(() => {
    const open = !!document.querySelector('.cm-vim-panel, .cm-panel-vim');
    document.body.classList.toggle('vim-panel-open', open);
  });
  vimPanelObserver.observe(document.body, { childList: true, subtree: true });

  ipcSend('editor:ready');
  return view;
}

// Expose under MdEditor.create (IIFE globalName=MdEditor).
export default { create };

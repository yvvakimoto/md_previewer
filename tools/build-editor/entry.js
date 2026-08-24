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

import { EditorState, Compartment, StateEffect, Transaction, Prec } from '@codemirror/state';
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
import { autocompletion, completionKeymap, startCompletion, completionStatus } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { vim, Vim, getCM } from '@replit/codemirror-vim';

import { mathInputAssistKeymap, isInsideMath, leftRightAutoPair } from './mathInputAssist.js';
import { charCount } from './charCount.js';
import { texEnvCompletionSource } from './texEnvComplete.js';
import { katexCommandCompletionSource } from './katexCommandComplete.js';
import { pathCompletionSource } from './pathComplete.js';
import { fencedDivCompletionSource } from './fencedDivComplete.js';
import { spanStyleCompletionSource } from './spanStyleComplete.js';
import { frontMatterCompletionSource, frontMatterBlankFieldAt } from './frontMatterComplete.js';
import { installJpWordMotion } from './jpWordMotion.js';
import {
  KEY_LAYOUTS, DEFAULT_KEY_LAYOUT, keyLayoutKeys, applyKeyLayout,
} from './keyLayout.js';
import { numberedListIndentKeymap } from './numberedListIndent.js';
import { installClipboardSync } from './clipboardSync.js';
import {
  isMarpDocument, insertSlideAfter, copySlide, cutSlide,
  marpSlideKeymap, SLIDE_CLASSES,
} from './marpSlides.js';
import {
  insertTable, tableColumnHighlight, mdTableKeymap, TABLE_ALIGNS,
} from './mdTable.js';
import { tablePaste, plainPasteKeymap } from './tablePaste.js';
import {
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT,
  clampFontSize, stepFontSize, parseFontSizeArg,
  FONT_FAMILIES, FONT_FAMILY_DEFAULT, fontFamilyKeys, fontStackOf,
  editorPrefsKeymap,
} from './editorPrefs.js';
import {
  cellMode, cellModeOf, setCellMode, cellList, cellAt, cellIndexAt, cellRunLine,
  insertCellBelow, selectNextCell, CELL_HELP,
} from './cells.js';

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
  // The bar carries ACTIONS only. Every preference (font size / family, theme,
  // line numbers, Vim, cell mode, table column highlight, table paste, live
  // preview) lives in the settings modal instead — the bar had grown to seven
  // controls, which is what previously forced `editor:tablePaste` to be
  // reachable through `:set notablepaste` alone, with no UI at all.
  const btnSettings = document.createElement('button');
  btnSettings.className = 'status-btn';
  btnSettings.type = 'button';
  btnSettings.title = '表示・編集の設定（文字サイズ / フォント / テーマ / Vim / セルモード …）  ·  :pref';
  btnSettings.textContent = '⚙ 設定';
  // Markdown table insert. An action, not a preference, so it stays on the bar.
  // Unlike the Marp trio it is visible in every document: inserting a table is
  // meaningful anywhere.
  const btnTable = document.createElement('button');
  btnTable.className = 'status-btn';
  btnTable.type = 'button';
  btnTable.title = 'Insert a Markdown table (rows × columns)  ·  :table [R C] / gti / Ctrl+Alt+T';
  btnTable.textContent = '⊞ Table';
  // Marp slide helpers — only shown for Marp documents (see updateMarpButtons).
  const btnSlideAdd = document.createElement('button');
  btnSlideAdd.className = 'status-btn';
  btnSlideAdd.type = 'button';
  btnSlideAdd.title = 'Insert a new slide (pick a class)  ·  :slide / gsi / Ctrl+Alt+N';
  btnSlideAdd.textContent = '+ Slide';
  btnSlideAdd.style.display = 'none';
  const btnSlideCopy = document.createElement('button');
  btnSlideCopy.className = 'status-btn';
  btnSlideCopy.type = 'button';
  btnSlideCopy.title = 'Copy the current slide  ·  :slideyank / gsy / Ctrl+Alt+C';
  btnSlideCopy.textContent = '⧉ Slide';
  btnSlideCopy.style.display = 'none';
  const btnSlideCut = document.createElement('button');
  btnSlideCut.className = 'status-btn';
  btnSlideCut.type = 'button';
  btnSlideCut.title = 'Cut the current slide  ·  :slidecut / gsd / Ctrl+Alt+X';
  btnSlideCut.textContent = '✂ Slide';
  btnSlideCut.style.display = 'none';
  statusCtrls.append(btnSettings, btnTable,
                     btnSlideAdd, btnSlideCopy, btnSlideCut);
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

  // Modal for character count (opened by clicking the status bar — `C` is Vim's
  // change-to-EOL operator, so it is deliberately not bound; see the note next to
  // the Vim mapping block below).
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

  // Marp slide-class picker modal (mirrors the cc-modal pattern).
  const slideModal = document.createElement('div');
  slideModal.className = 'cc-modal';
  slideModal.style.display = 'none';
  slideModal.innerHTML = `
    <div class="cc-panel" role="dialog" aria-modal="true">
      <button class="cc-close" type="button" aria-label="Close">&times;</button>
      <h2>Insert Slide</h2>
      <div class="slide-class-grid"></div>
      <div class="cc-hint">Pick a class · <kbd>Esc</kbd> to cancel</div>
    </div>`;
  document.body.appendChild(slideModal);
  slideModal.querySelector('.cc-close').addEventListener('click', () => closeSlideModal());
  slideModal.addEventListener('click', (e) => { if (e.target === slideModal) closeSlideModal(); });
  {
    const grid = slideModal.querySelector('.slide-class-grid');
    SLIDE_CLASSES.forEach((name) => {
      const b = document.createElement('button');
      b.className = 'slide-class-btn';
      b.type = 'button';
      b.textContent = name === 'none' ? '(no class)' : name;
      b.addEventListener('click', () => {
        closeSlideModal();
        insertSlideAfter(view, name === 'none' ? '' : name);
      });
      grid.appendChild(b);
    });
  }
  function openSlideModal() {
    document.body.classList.add('status-pinned');
    slideModal.style.display = 'flex';
    const first = slideModal.querySelector('.slide-class-btn');
    if (first) setTimeout(() => first.focus(), 0);
  }
  function closeSlideModal() {
    slideModal.style.display = 'none';
    document.body.classList.remove('status-pinned');
    setTimeout(() => view.focus(), 0);
  }

  // Table size picker (mirrors the cc-modal pattern). "Rows" counts the header
  // row; the delimiter row is structural and never counted.
  const tableModal = document.createElement('div');
  tableModal.className = 'cc-modal';
  tableModal.style.display = 'none';
  tableModal.innerHTML = `
    <div class="cc-panel" role="dialog" aria-modal="true">
      <button class="cc-close" type="button" aria-label="Close">&times;</button>
      <h2>Insert Table</h2>
      <div class="table-size-form">
        <label>Rows (incl. header)<input type="number" class="tbl-rows" min="1" max="50" value="3"></label>
        <label>Columns<input type="number" class="tbl-cols" min="1" max="20" value="3"></label>
        <label>Align<select class="tbl-align">
          <option value="">default</option>
          ${TABLE_ALIGNS.map((a) => `<option value="${a}">${a}</option>`).join('')}
        </select></label>
      </div>
      <div class="cc-actions"><button class="cc-btn tbl-insert" type="button">Insert</button></div>
      <div class="cc-hint"><kbd>Enter</kbd> to insert · <kbd>Esc</kbd> to cancel · <kbd>:table 3 4</kbd> for any size</div>
    </div>`;
  document.body.appendChild(tableModal);
  const tblRows = tableModal.querySelector('.tbl-rows');
  const tblCols = tableModal.querySelector('.tbl-cols');
  const tblAlign = tableModal.querySelector('.tbl-align');
  tableModal.querySelector('.cc-close').addEventListener('click', () => closeTableModal());
  tableModal.addEventListener('click', (e) => { if (e.target === tableModal) closeTableModal(); });
  tableModal.querySelector('.tbl-insert').addEventListener('click', () => commitTableModal());
  // Enter submits from any field. Escape is deliberately NOT handled here so it
  // bubbles to the global modal-Esc chain below.
  tableModal.querySelector('.table-size-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTableModal(); }
  });
  function commitTableModal() {
    const r = parseInt(tblRows.value, 10);
    const c = parseInt(tblCols.value, 10);
    closeTableModal();
    insertTable(view, Number.isFinite(r) ? r : 3, Number.isFinite(c) ? c : 3,
                { align: tblAlign.value || null });
  }
  function openTableModal(rows, cols, align) {
    if (Number.isFinite(rows)) tblRows.value = String(rows);
    if (Number.isFinite(cols)) tblCols.value = String(cols);
    if (align) tblAlign.value = align;
    document.body.classList.add('status-pinned');
    tableModal.style.display = 'flex';
    setTimeout(() => { tblRows.focus(); tblRows.select(); }, 0);
  }
  function closeTableModal() {
    tableModal.style.display = 'none';
    document.body.classList.remove('status-pinned');
    setTimeout(() => view.focus(), 0);
  }

  // Cell-mode key list (reuses the cc-modal shell). Built from CELL_HELP so the
  // keymap in cells.js and this list cannot drift apart.
  const cellHelpModal = document.createElement('div');
  cellHelpModal.className = 'cc-modal';
  cellHelpModal.style.display = 'none';
  cellHelpModal.innerHTML = `
    <div class="cc-panel" role="dialog" aria-modal="true">
      <button class="cc-close" type="button" aria-label="Close">&times;</button>
      <h2>セルモード キー一覧</h2>
      <div class="cell-help-grid">
        ${CELL_HELP.map(([k, d]) =>
          `<div class="cell-help-key">${k}</div><div class="cell-help-desc">${d}</div>`).join('')}
      </div>
      <div class="cc-hint"><kbd>Esc</kbd> で閉じる · セル区切りは <kbd>---</kbd> 行</div>
    </div>`;
  document.body.appendChild(cellHelpModal);
  cellHelpModal.querySelector('.cc-close').addEventListener('click', () => closeCellHelp());
  cellHelpModal.addEventListener('click', (e) => {
    if (e.target === cellHelpModal) closeCellHelp();
  });
  function openCellHelp() {
    document.body.classList.add('status-pinned');
    cellHelpModal.style.display = 'flex';
  }
  function closeCellHelp() {
    cellHelpModal.style.display = 'none';
    document.body.classList.remove('status-pinned');
    setTimeout(() => view.focus(), 0);
  }

  // ---------- Settings modal (reuses the cc-modal shell) ----------
  // The single home for every preference. It only ever calls the existing
  // setters, so the Vim `:set` / `gtc` / `gmc` paths keep working untouched and
  // there is exactly one place that owns each pref's state.
  //
  // Each row carries its shortcut / ex-command as a hint: before this modal the
  // status-bar buttons' title= tooltips were the only documentation surface for
  // them, and consolidating the buttons away would otherwise have lost that.
  const settingsModal = document.createElement('div');
  settingsModal.className = 'cc-modal';
  settingsModal.style.display = 'none';
  const fontOptions = FONT_FAMILIES
    .map((f) => `<option value="${f.key}">${f.label}</option>`).join('');
  const keyLayoutOptions = keyLayoutKeys()
    .map((k) => `<option value="${k}">${KEY_LAYOUTS[k].label}</option>`).join('');
  settingsModal.innerHTML = `
    <div class="cc-panel" role="dialog" aria-modal="true" aria-label="エディター設定">
      <button class="cc-close" type="button" aria-label="閉じる">&times;</button>
      <h2>⚙ 設定</h2>
      <div class="settings-body">
        <div class="settings-section">
          <h3>表示</h3>
          <div class="settings-row">
            <span class="settings-label">文字サイズ
              <span class="settings-hint"><code>Ctrl</code>+<code>+</code> / <code>-</code> / <code>0</code> · <code>Ctrl</code>+ホイール · <code>:fontsize</code></span>
            </span>
            <span class="settings-control">
              <button class="settings-step" type="button" data-act="font-minus" aria-label="小さく">−</button>
              <span class="settings-value" data-el="font-value">15px</span>
              <button class="settings-step" type="button" data-act="font-plus" aria-label="大きく">＋</button>
              <button class="settings-reset" type="button" data-act="font-reset">戻す</button>
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-label">フォント
              <span class="settings-hint">編集領域のみ。ステータスバー等は固定サイズです</span>
            </span>
            <span class="settings-control">
              <select data-el="font-family" aria-label="フォント">${fontOptions}</select>
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-label">テーマ</span>
            <span class="settings-control">
              <span class="settings-seg" data-seg="theme">
                <button type="button" data-val="light">Light</button>
                <button type="button" data-val="dark">Dark</button>
              </span>
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-label">行番号
              <span class="settings-hint"><code>:set nu</code> / <code>rnu</code> / <code>nonu</code></span>
            </span>
            <span class="settings-control">
              <span class="settings-seg" data-seg="lineNo">
                <button type="button" data-val="absolute">絶対</button>
                <button type="button" data-val="relative">相対</button>
                <button type="button" data-val="off">なし</button>
              </span>
            </span>
          </div>
        </div>
        <div class="settings-section">
          <h3>編集</h3>
          <div class="settings-row">
            <span class="settings-label">Vim キーバインド
              <span class="settings-hint">OFF で CodeMirror 標準のキー操作</span>
            </span>
            <span class="settings-control"><input type="checkbox" data-el="vim" aria-label="Vim キーバインド"></span>
          </div>
          <div class="settings-row">
            <span class="settings-label">キー配列（Vim コマンド）
              <span class="settings-hint">Dvorak エミュレータ使用時に、コマンドモードのキーを QWERTY の位置で解釈 · <code>:set dvorak</code> / <code>:keylayout</code></span>
            </span>
            <span class="settings-control">
              <select data-el="key-layout" aria-label="キー配列">${keyLayoutOptions}</select>
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-label">セルモード
              <span class="settings-hint"><code>---</code> 区切りの Jupyter 風編集 · <code>:cellmode</code> / <code>gmc</code></span>
            </span>
            <span class="settings-control"><input type="checkbox" data-el="cells" aria-label="セルモード"></span>
          </div>
          <div class="settings-row">
            <span class="settings-label">表の列ハイライト
              <span class="settings-hint"><code>:tablecol</code> / <code>gtc</code> / <code>Ctrl</code>+<code>Alt</code>+<code>H</code></span>
            </span>
            <span class="settings-control"><input type="checkbox" data-el="table-col" aria-label="表の列ハイライト"></span>
          </div>
          <div class="settings-row">
            <span class="settings-label">表の貼り付け変換
              <span class="settings-hint">Excel / Word の表を GFM 表に · 一回だけ素で貼るのは <code>Ctrl</code>+<code>Shift</code>+<code>V</code></span>
            </span>
            <span class="settings-control"><input type="checkbox" data-el="table-paste" aria-label="表の貼り付け変換"></span>
          </div>
        </div>
        <div class="settings-section">
          <h3>連携</h3>
          <div class="settings-row">
            <span class="settings-label">ライブプレビュー
              <span class="settings-hint">OFF なら保存時のみプレビュー更新（重い文書向け）</span>
            </span>
            <span class="settings-control"><input type="checkbox" data-el="live" aria-label="ライブプレビュー"></span>
          </div>
        </div>
      </div>
      <div class="cc-hint"><kbd>Esc</kbd> で閉じる</div>
    </div>`;
  document.body.appendChild(settingsModal);

  // Handles for updateSettingsUI(). Declared with `let` and assigned here so
  // updateSettingsUI can no-op safely if a setter fires before this point.
  let settingsCtl = null;
  {
    const q = (sel) => settingsModal.querySelector(sel);
    const segButtons = (name) =>
      Array.from(settingsModal.querySelectorAll(`[data-seg="${name}"] button`));
    settingsCtl = {
      fontValue: q('[data-el="font-value"]'),
      fontMinus: q('[data-act="font-minus"]'),
      fontPlus: q('[data-act="font-plus"]'),
      fontFamily: q('[data-el="font-family"]'),
      keyLayout: q('[data-el="key-layout"]'),
      vim: q('[data-el="vim"]'),
      cells: q('[data-el="cells"]'),
      tableCol: q('[data-el="table-col"]'),
      tablePaste: q('[data-el="table-paste"]'),
      live: q('[data-el="live"]'),
      setSeg: (name, val) => {
        segButtons(name).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
      },
    };
    // `quiet` on every call: the modal already shows the value, and a toast would
    // pin the status bar behind the backdrop. It also keeps the setters from
    // stealing focus back into the editor mid-interaction.
    q('[data-act="font-minus"]').addEventListener('click', () => zoomFont(-1, true));
    q('[data-act="font-plus"]').addEventListener('click', () => zoomFont(+1, true));
    q('[data-act="font-reset"]').addEventListener('click', () => resetFont(true));
    settingsCtl.fontFamily.addEventListener('change', (e) => setFontFamily(e.target.value, true));
    segButtons('theme').forEach((b) =>
      b.addEventListener('click', () => setTheme(b.dataset.val)));
    segButtons('lineNo').forEach((b) =>
      b.addEventListener('click', () => setLineNo(b.dataset.val)));
    settingsCtl.vim.addEventListener('change', (e) => setVim(e.target.checked));
    settingsCtl.cells.addEventListener('change', (e) => setCells(e.target.checked));
    settingsCtl.tableCol.addEventListener('change', (e) => setTableCol(e.target.checked));
    settingsCtl.tablePaste.addEventListener('change', (e) => setTablePaste(e.target.checked));
    settingsCtl.keyLayout.addEventListener('change', (e) => setKeyLayout(e.target.value));
    settingsCtl.live.addEventListener('change', (e) => setLive(e.target.checked));
  }
  settingsModal.querySelector('.cc-close').addEventListener('click', () => closeSettings());
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  function openSettings() {
    updateSettingsUI();
    document.body.classList.add('status-pinned');
    settingsModal.style.display = 'flex';
  }
  function closeSettings() {
    settingsModal.style.display = 'none';
    document.body.classList.remove('status-pinned');
    setTimeout(() => view.focus(), 0);
  }

  // The cell-mode key gate must stand down while any of these owns the keyboard:
  // openModal() does not move focus, so contentDOM keeps it and the gate would
  // otherwise fire in parallel with the Esc chain below.
  function isModalOpen() {
    return settingsModal.style.display === 'flex'
      || cellHelpModal.style.display === 'flex'
      || tableModal.style.display === 'flex'
      || slideModal.style.display === 'flex'
      || modal.style.display === 'flex';
  }

  document.addEventListener('keydown', (e) => {
    // Newest modal first (same ordering rule that put slideModal ahead of the
    // char-count modal). This chain is hard-coded, so a new modal must be added.
    if (e.key === 'Escape' && settingsModal.style.display === 'flex') {
      e.preventDefault();
      closeSettings();
      return;
    }
    if (e.key === 'Escape' && cellHelpModal.style.display === 'flex') {
      e.preventDefault();
      closeCellHelp();
      return;
    }
    if (e.key === 'Escape' && tableModal.style.display === 'flex') {
      e.preventDefault();
      closeTableModal();
      return;
    }
    if (e.key === 'Escape' && slideModal.style.display === 'flex') {
      e.preventDefault();
      closeSlideModal();
      return;
    }
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
  let lastDirtyPushed = null; // last dirty value sent over `editor:dirty:` IPC (de-dupes title flips)
  let suppressEcho = false; // ignore the next __loadFile echo from Rust after our save

  // ---------- Persisted UI prefs ----------
  const LS_VIM = 'editor:vim';
  const LS_LN = 'editor:lineNumbers';
  const LS_THEME = 'editor:theme';
  const LS_LIVE = 'editor:livePreview';
  const LS_TABLECOL = 'editor:tableColHighlight';
  const LS_TABLEPASTE = 'editor:tablePaste';
  const LS_CELLS = 'editor:cellMode';
  const LS_FONTSIZE = 'editor:fontSize';
  const LS_FONTFAMILY = 'editor:fontFamily';
  const LS_KEYLAYOUT = 'editor:keyLayout';
  function readPref(key, valid, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v && valid.indexOf(v) >= 0) return v;
    } catch (_) {}
    return fallback;
  }
  // readPref validates against an enum, which cannot express a font size. This is
  // the only numeric pref in the file; clampFontSize absorbs every junk form
  // (missing, '', 'abc', out of range), including a hand-edited localStorage.
  function readFontSizePref() {
    try {
      const v = localStorage.getItem(LS_FONTSIZE);
      if (v != null && v !== '') return clampFontSize(v);
    } catch (_) {}
    return FONT_SIZE_DEFAULT;
  }
  let vimState = readPref(LS_VIM, ['on', 'off'], 'off') === 'on';
  let lineNoState = readPref(LS_LN, ['absolute', 'relative', 'off'], 'absolute');
  let themeState = readPref(LS_THEME, ['light', 'dark'], 'light');
  let liveState = readPref(LS_LIVE, ['on', 'off'], 'on') === 'on';
  let tableColState = readPref(LS_TABLECOL, ['on', 'off'], 'on') === 'on';
  // No status-bar button, deliberately: the bar already carries seven controls,
  // and this behaviour is right almost always. The per-paste escape hatch is
  // Mod-Shift-V (plus a single Ctrl+Z); this pref is the permanent opt-out for
  // the rare user who wants it gone, reachable via `:set notablepaste`.
  let tablePasteState = readPref(LS_TABLEPASTE, ['on', 'off'], 'on') === 'on';
  let cellState = readPref(LS_CELLS, ['on', 'off'], 'off') === 'on';
  let fontSizeState = readFontSizePref();
  let fontFamilyState = readPref(LS_FONTFAMILY, fontFamilyKeys(), FONT_FAMILY_DEFAULT);
  let keyLayoutState = readPref(LS_KEYLAYOUT, keyLayoutKeys(), DEFAULT_KEY_LAYOUT);

  const vimComp = new Compartment();
  const lineNoComp = new Compartment();
  const themeComp = new Compartment();
  // A Compartment is required, not optional: the highlight's ViewPlugin only
  // recomputes on doc / selection / syntax-tree change, so gating it behind a
  // plain flag would leave stale decorations on screen until the next edit.
  // Reconfiguring to [] destroys the plugin and drops its marks in the same
  // transaction.
  const tableColComp = new Compartment();
  // Cell mode's ON/OFF axis. A Compartment (not a flag) so OFF means literally
  // zero extensions — no decorations, no gutter, and crucially the Prec.highest
  // pre-Vim key gate is not even registered, so a user who never turns cell mode
  // on cannot be affected by it. The Edit/Command axis inside is a StateField and
  // its *look* is a body class; see the header comment in cells.js.
  const cellComp = new Compartment();

  // Apply chrome theme class on initial paint (before any toggle click).
  document.body.classList.toggle('theme-dark', themeState === 'dark');
  document.body.classList.toggle('cell-mode', cellState);
  document.body.classList.toggle('cellmode-edit', cellState);
  // Typography is CSS variables rather than a Compartment: it holds no state and
  // renders no decorations, so there is nothing to go stale — the same rule
  // setTablePaste follows below. Applied here, before `new EditorView`, so a
  // persisted size never flashes at 15px first.
  applyFontVars();

  function applyFontVars() {
    const root = document.documentElement;
    root.style.setProperty('--editor-font-size', fontSizeState + 'px');
    root.style.setProperty('--editor-font-family', fontStackOf(fontFamilyState));
  }

  // Setters hand focus back to the editor so a status-bar click doesn't leave the
  // caret stranded. That is wrong while the settings modal owns the screen: it
  // would pull focus out from under the control the user just clicked and send
  // their next keystroke into the editor behind the backdrop. Every setter that
  // the modal can invoke routes its focus restore through here.
  function refocusEditor() {
    if (settingsModal.style.display === 'flex') return;
    setTimeout(() => view.focus(), 0);
  }

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

  // Reflect current state into the settings modal's controls. Every setter calls
  // this, so a preference changed from anywhere — a Vim `:set`, a `gtc` mapping,
  // a Ctrl+= keypress — shows up correctly the next time the modal is opened.
  // Cheap enough to run unconditionally: the modal is a handful of nodes, and
  // guarding on "is it open" would leave the DOM stale for openSettings() to fix
  // anyway.
  function updateSettingsUI() {
    if (!settingsCtl) return;   // called before the modal is built
    settingsCtl.fontValue.textContent = fontSizeState + 'px';
    settingsCtl.fontMinus.disabled = fontSizeState <= FONT_SIZE_MIN;
    settingsCtl.fontPlus.disabled = fontSizeState >= FONT_SIZE_MAX;
    settingsCtl.fontFamily.value = fontFamilyState;
    settingsCtl.keyLayout.value = keyLayoutState;
    settingsCtl.setSeg('theme', themeState);
    settingsCtl.setSeg('lineNo', lineNoState);
    settingsCtl.vim.checked = vimState;
    settingsCtl.cells.checked = cellState;
    settingsCtl.tableCol.checked = tableColState;
    settingsCtl.tablePaste.checked = tablePasteState;
    settingsCtl.live.checked = liveState;
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
    updateSettingsUI();
    updateStatus();
    refocusEditor();
  }
  function setLineNo(mode) {
    if (['absolute', 'relative', 'off'].indexOf(mode) < 0) return;
    lineNoState = mode;
    try { localStorage.setItem(LS_LN, mode); } catch (_) {}
    view.dispatch({ effects: lineNoComp.reconfigure(lineNumberExt(mode)) });
    updateSettingsUI();
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
    updateSettingsUI();
    refocusEditor();
  }
  function setLive(on) {
    liveState = !!on;
    try { localStorage.setItem(LS_LIVE, liveState ? 'on' : 'off'); } catch (_) {}
    if (liveState) {
      // Flush the current buffer to the preview immediately so re-enabling
      // doesn't leave a stale render until the next edit.
      pushLiveNow();
    } else if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = 0;
    }
    updateSettingsUI();
    refocusEditor();
  }
  function setTableCol(on) {
    tableColState = !!on;
    try { localStorage.setItem(LS_TABLECOL, tableColState ? 'on' : 'off'); } catch (_) {}
    view.dispatch({
      effects: tableColComp.reconfigure(tableColState ? tableColumnHighlight() : []),
    });
    updateSettingsUI();
    refocusEditor();
  }
  // No reconfigure: tablePaste() reads this through an isEnabled closure. It
  // holds no state and renders nothing, so unlike the column highlight above
  // there are no stale decorations to drop.
  function setTablePaste(on) {
    tablePasteState = !!on;
    try { localStorage.setItem(LS_TABLEPASTE, tablePasteState ? 'on' : 'off'); } catch (_) {}
    // `:set notablepaste` has no other feedback, but inside the modal the
    // checkbox is the feedback and the hint would render behind the backdrop.
    if (settingsModal.style.display !== 'flex') {
      showHint('表の貼り付け変換: ' + (tablePasteState ? 'ON' : 'OFF'));
    }
    refocusEditor();
  }
  // Keyboard-layout translation for Vim command mode. No Compartment and no
  // reconfigure: this drives Vim's global `langmap`, which lives on the Vim
  // singleton and renders nothing, so there is no state to go stale — the same
  // reasoning as setTablePaste above. Independent of vimComp, so it is also
  // correct to set while Vim mode is OFF.
  function setKeyLayout(name) {
    if (keyLayoutKeys().indexOf(name) < 0) return;
    keyLayoutState = name;
    try { localStorage.setItem(LS_KEYLAYOUT, keyLayoutState); } catch (_) {}
    try { applyKeyLayout(Vim, keyLayoutState); } catch (_) {}
    updateSettingsUI();
    if (settingsModal.style.display !== 'flex') {
      showHint('キー配列: ' + KEY_LAYOUTS[keyLayoutState].label);
    }
    refocusEditor();
  }
  // Typography. No reconfigure for the same reason as setTablePaste above — but
  // unlike it, a size change invalidates CodeMirror's cached character width and
  // line height, so requestMeasure() is mandatory: EditorView.lineWrapping is on,
  // and without a re-measure the wrap points and the caret drift away from the
  // rendered glyphs. `quiet` suppresses the toast when the settings modal is the
  // caller (the value is already visible there) and keeps focus in the modal.
  function setFontSize(px, quiet) {
    const next = clampFontSize(px);
    const changed = next !== fontSizeState;
    fontSizeState = next;
    try { localStorage.setItem(LS_FONTSIZE, String(fontSizeState)); } catch (_) {}
    applyFontVars();
    if (view) view.requestMeasure();
    updateSettingsUI();
    if (!quiet) {
      // At a clamp boundary say so, otherwise a repeated keypress looks broken.
      showHint(changed ? '文字サイズ ' + fontSizeState + 'px'
                       : '文字サイズ ' + fontSizeState + 'px（下限/上限）');
      setTimeout(() => view.focus(), 0);
    }
  }
  function zoomFont(delta, quiet) {
    setFontSize(stepFontSize(fontSizeState, delta), quiet);
  }
  function resetFont(quiet) {
    setFontSize(FONT_SIZE_DEFAULT, quiet);
  }
  function setFontFamily(key, quiet) {
    if (fontFamilyKeys().indexOf(key) < 0) return;
    fontFamilyState = key;
    try { localStorage.setItem(LS_FONTFAMILY, fontFamilyState); } catch (_) {}
    applyFontVars();
    // A different family means a different advance width, so re-measure too.
    if (view) view.requestMeasure();
    updateSettingsUI();
    if (!quiet) setTimeout(() => view.focus(), 0);
  }
  // Cell mode's callback bundle: cells.js stays free of chrome (modals, body
  // classes, IPC), exactly like marpSlides.js / mdTable.js.
  function cellCallbacks() {
    return {
      isModalOpen,
      isMarp: () => isMarpDoc,
      onSave: () => doSave(),
      onCycleLineNo: () => cycleLineNo(),
      onHelp: () => openCellHelp(),
      onClassPicker: () => openSlideModal(),
      onHint: (msg) => showHint(msg),
      onEnterCommand: () => {
        // Mirror the Vim-NORMAL behaviour so `i` starts in half-width.
        try { ipcSend('editor:ime:off'); } catch (_) {}
      },
      onEnterInsert: (v) => {
        // With Vim on, `i` should also mean INSERT there, so the two agree.
        try { if (vimState) Vim.handleKey(getCM(v), 'i', 'user'); } catch (_) {}
      },
      onModeChange: (mode) => {
        document.body.classList.toggle('cellmode-command', mode === 'command');
        document.body.classList.toggle('cellmode-edit', mode !== 'command');
        updateStatus();
      },
      onRun: (v, mode) => runCell(mode),
    };
  }
  function setCells(on) {
    cellState = !!on;
    try { localStorage.setItem(LS_CELLS, cellState ? 'on' : 'off'); } catch (_) {}
    view.dispatch({
      effects: cellComp.reconfigure(cellState ? cellMode(cellCallbacks()) : []),
    });
    document.body.classList.toggle('cell-mode', cellState);
    // Leaving cell mode must not strand the Command-mode look.
    document.body.classList.toggle('cellmode-command', false);
    document.body.classList.toggle('cellmode-edit', cellState);
    updateSettingsUI();
    updateStatus();
    refocusEditor();
  }

  btnSettings.addEventListener('click', () => openSettings());
  btnTable.addEventListener('click', () => openTableModal());
  btnSlideAdd.addEventListener('click', () => openSlideModal());
  btnSlideCopy.addEventListener('click', () => copySlide(view));
  btnSlideCut.addEventListener('click', () => cutSlide(view));

  // Show the Marp slide buttons only for Marp documents.
  let isMarpDoc = false;
  function updateMarpButtons() {
    let marp = false;
    try { marp = isMarpDocument(view.state.doc.toString()); } catch (_) {}
    isMarpDoc = marp;
    const disp = marp ? '' : 'none';
    btnSlideAdd.style.display = disp;
    btnSlideCopy.style.display = disp;
    btnSlideCut.style.display = disp;
  }

  function updateTitle() {
    const base = currentPath.split(/[\\/]/).pop() || 'Untitled';
    document.title = `${dirty ? '• ' : ''}${base} — Editor`;
    statusFile.textContent = (dirty ? '• ' : '') + base;
    // Push dirty flips to the Rust host so the OS window title (chrome / taskbar)
    // can show the unsaved marker too — the auto-hiding status bar isn't enough.
    if (dirty !== lastDirtyPushed) {
      lastDirtyPushed = dirty;
      try { ipcSend('editor:dirty:' + (dirty ? 'true' : 'false')); } catch (_) {}
    }
  }
  // Transient one-line message in the status bar (pinned so it is actually seen).
  // Used for cell-mode keys that are deliberately inert in the current document.
  let hintMsg = '';
  let hintTimer = 0;
  function showHint(msg) {
    hintMsg = msg || '';
    document.body.classList.add('status-pinned');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hintTimer = 0;
      hintMsg = '';
      if (!isModalOpen()) document.body.classList.remove('status-pinned');
      updateStatus();
    }, 1800);
    updateStatus();
  }

  function updateStatus() {
    if (!view) return;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const col = sel.head - line.from + 1;
    const total = view.state.doc.length;
    const mode = (window.__vimMode || '').toUpperCase();
    const modeStr = mode ? ` · ${mode}` : '';
    let cellStr = '';
    if (cellState) {
      const cs = cellModeOf(view.state);
      const n = cellIndexAt(view.state, sel.head) + 1;
      cellStr = ` · CELL ${n}${cs.mode === 'command' ? ' CMD' : ''}${cs.pending ? ' ' + cs.pending : ''}`;
    }
    const hintStr = hintMsg ? ` · ${hintMsg}` : '';
    statusInfo.textContent =
      `Ln ${line.number}, Col ${col} · ${total} chars${modeStr}${cellStr}${hintStr}`;
  }

  // Save command
  function doSave() {
    const content = view.state.doc.toString();
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
    ipcSend('editor:save:' + JSON.stringify({ path: currentPath, content }));
    savedDoc = content;
    lastPushedDoc = content; // Rust re-renders the preview from this save
    dirty = false;
    updateTitle();
  }

  // Debounced live-content push to the preview (no disk write).
  let liveTimer = 0;
  let marpTimer = 0; // debounces Marp-button visibility re-checks on edit
  // Last document text the preview was given. Lets cell-mode "run" ask for a
  // scroll-only sync when nothing changed — see runCell().
  let lastPushedDoc = null;
  function pushLiveNow(lineOverride) {
    if (!currentPath || suppressEcho) return;
    const content = view.state.doc.toString();
    const head = view.state.selection.main.head;
    const line = lineOverride == null ? view.state.doc.lineAt(head).number : lineOverride;
    lastPushedDoc = content;
    ipcSend('editor:change:' + JSON.stringify({ path: currentPath, content, line }));
  }
  function schedulePushLive() {
    if (!liveState) return;
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = 0;
      pushLiveNow();
    }, 150);
  }

  // ---------- cell "run" = sync the preview to a cell ----------
  //
  // No new Rust IPC: `editor:change:` already re-renders AND scrolls in one
  // concatenated script (CustomEvent::EditorLiveContent), and `editor:cursor:`
  // scrolls alone (EditorCursorMoved).
  //
  // Two deliberate choices:
  //  - cancel the 150ms live debounce, or it fires straight after with the
  //    CURSOR's line instead of the cell's and undoes the scroll (doSave() sets
  //    the same precedent);
  //  - when the document is unchanged, send `editor:cursor:` instead of
  //    `editor:change:`. That skips a full re-render, but more importantly avoids
  //    a real side effect: the `editor:change:` handler calls mark_dirty(), and
  //    the JS side only pushes `editor:dirty:` on TRANSITIONS, so a spurious
  //    mark_dirty() is never corrected and close_take_dirty_path() would reload an
  //    unedited file from disk when the editor closes.
  //
  // Note pushLiveNow() has no `liveState` gate (only schedulePushLive does), so
  // running works with Live: OFF — that combination is a fully manual,
  // run-driven preview, the closest this app gets to real Jupyter semantics.
  function flushRun(line) {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
    if (view.state.doc.toString() === lastPushedDoc) {
      ipcSend('editor:cursor:' + line);
    } else {
      pushLiveNow(line);
    }
  }
  function runCell(mode) {
    const st0 = view.state;
    const cells0 = cellList(st0);
    const idx0 = cellIndexAt(st0, st0.selection.main.head, cells0);

    if (mode === 'insert') {
      // Insert FIRST, then flush, so the preview renders the document that
      // contains the new cell and can actually scroll to it.
      insertCellBelow(view);
      view.dispatch({ effects: setCellMode.of('edit') });
      const st1 = view.state;
      flushRun(cellRunLine(st1, cellAt(st1, st1.selection.main.head)));
      return;
    }
    if (mode === 'next') {
      selectNextCell(view);
      view.dispatch({ effects: setCellMode.of('command') });
      const st1 = view.state;
      flushRun(cellRunLine(st1, cellAt(st1, st1.selection.main.head)));
      return;
    }
    // 'stay'
    view.dispatch({ effects: setCellMode.of('command') });
    flushRun(cellRunLine(st0, cells0[idx0]));
  }
  // `:table` / `:tbl` argument forms:
  //   (none)          -> open the modal
  //   3 4             -> 3 rows x 4 cols
  //   3x4             -> same (also X / * / ,)
  //   4               -> 4x4 (square — unambiguous to explain)
  //   ... center|c|l|r -> alignment as the last argument
  // The two size forms consume a different number of arguments, so the alignment
  // argument's index differs — parse explicitly rather than joining, which is what
  // made `:table 3 4` silently mean 3x3.
  // Unparseable args open the modal instead of erroring, so no Vim error-message
  // plumbing is needed (no existing handler reports errors either).
  const TBL_NUM = /^\d+$/;
  const TBL_PAIR = /^(\d+)[x×*,](\d+)$/i;
  function parseAlignArg(a) {
    const s = String(a || '').trim().toLowerCase();
    if (!s) return null;
    return TABLE_ALIGNS.find((x) => x === s || x[0] === s) || null;
  }
  function runTableEx(_cm, params) {
    const args = ((params && params.args) || []).map((a) => String(a).trim()).filter(Boolean);
    const pair = TBL_PAIR.exec(args[0] || '');
    if (pair) {
      insertTable(view, +pair[1], +pair[2], { align: parseAlignArg(args[1]) });
    } else if (TBL_NUM.test(args[0] || '') && TBL_NUM.test(args[1] || '')) {
      insertTable(view, +args[0], +args[1], { align: parseAlignArg(args[2]) });
    } else if (TBL_NUM.test(args[0] || '')) {
      insertTable(view, +args[0], +args[0], { align: parseAlignArg(args[1]) });
    } else {
      openTableModal();
    }
  }

  // Hook Vim :w / :wq to save.
  try {
    Vim.defineEx('write', 'w', doSave);
    Vim.defineEx('wq', undefined, () => { doSave(); ipcSend('editor:close:'); });
    Vim.defineEx('quit', 'q', () => ipcSend('editor:close:'));
    Vim.defineEx('set', undefined, (_cm, params) => {
      const arg = (params && params.args && params.args[0]) || '';
      switch (arg) {
        case 'number': case 'nu':              setLineNo('absolute'); break;
        case 'nonumber': case 'nonu':          setLineNo('off');      break;
        case 'relativenumber': case 'rnu':     setLineNo('relative'); break;
        case 'norelativenumber': case 'nornu': setLineNo('absolute'); break;
        case 'tablecolumn': case 'tcol':       setTableCol(true);     break;
        case 'notablecolumn': case 'notcol':   setTableCol(false);    break;
        case 'tablepaste': case 'tpaste':      setTablePaste(true);   break;
        case 'notablepaste': case 'notpaste':  setTablePaste(false);  break;
        case 'cellmode': case 'cells':         setCells(true);        break;
        case 'nocellmode': case 'nocells':     setCells(false);       break;
        case 'dvorak':                         setKeyLayout('dvorak'); break;
        case 'nodvorak':                       setKeyLayout('qwerty'); break;
        default: break;
      }
    });
    // Marp slide helpers (ex-commands — guaranteed no conflict with normal keys).
    Vim.defineEx('slide',     undefined, () => openSlideModal());
    Vim.defineEx('slideyank', undefined, () => copySlide(view));
    Vim.defineEx('slidecut',  undefined, () => cutSlide(view));
    // Table helpers. No 1-letter shortName (`:t` is real Vim's :copy). The
    // package matches ex-commands with
    //   name.indexOf(input) === 0 && input.indexOf(shortName) === 0
    // so `:tab` does not reach `table` and `:table` is not ambiguous with
    // `tablecol`.
    Vim.defineEx('table',    undefined, runTableEx);
    Vim.defineEx('tbl',      undefined, runTableEx);
    Vim.defineEx('tablecol', undefined, (_cm, params) => {
      const a = ((params && params.args && params.args[0]) || '').toLowerCase();
      setTableCol(a === 'on' ? true : a === 'off' ? false : !tableColState);
    });
    // Cell mode. ONE name only: registering both `cell` and `cellmode` would make
    // `:cell` ambiguous under the prefix rule above. With one, `:cell` / `:cellm` /
    // `:cellmode` all resolve to it.
    Vim.defineEx('cellmode', undefined, (_cm, params) => {
      const a = ((params && params.args && params.args[0]) || '').toLowerCase();
      setCells(a === 'on' ? true : a === 'off' ? false : !cellState);
    });
    // Font size: `:fontsize 17` / `:fontsize +2` / `:fontsize -2` / `:fontsize`
    // (reset). No existing ex-command starts with `f`, so `:font` resolves here
    // unambiguously under the package's prefix rule documented above.
    Vim.defineEx('fontsize', undefined, (_cm, params) => {
      const arg = (params && params.args && params.args[0]) || '';
      const next = parseFontSizeArg(arg, fontSizeState);
      if (next == null) {
        showHint('E488: 引数が不正です: :fontsize ' + arg);
        return;
      }
      setFontSize(next);
    });
    // Keyboard layout for Vim command mode: `:keylayout dvorak` / `:keylayout
    // qwerty`, or no argument to report the current one. No other ex-command
    // starts with `k`, so `:key` resolves here under the prefix rule above.
    Vim.defineEx('keylayout', undefined, (_cm, params) => {
      const arg = ((params && params.args && params.args[0]) || '').toLowerCase();
      if (!arg) {
        showHint('キー配列: ' + KEY_LAYOUTS[keyLayoutState].label);
        return;
      }
      if (keyLayoutKeys().indexOf(arg) < 0) {
        showHint('E488: 引数が不正です: :keylayout ' + arg
          + '  (' + keyLayoutKeys().join(' / ') + ')');
        return;
      }
      setKeyLayout(arg);
    });
    // Opens the settings modal. Deliberately NOT named `settings` / `set…`:
    // the package resolves with name.indexOf(input) === 0, so any name starting
    // with "set" would make `:set` itself ambiguous and break every option above.
    Vim.defineEx('pref', undefined, () => openSettings());
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

  // Marp slide helpers — NORMAL-mode `gs` leader (gsi insert / gsy yank / gsd
  // cut). `gs*` is unused by @replit/codemirror-vim's default keymap and by our
  // own `]] [[ za zA`, and is not bracket-prefixed so it can't collide with the
  // `]<char>` / `[<char>` catch-all motions.
  try {
    Vim.defineAction('marpSlideInsert', () => openSlideModal());
    Vim.defineAction('marpSlideYank',   (cm) => copySlide(cm.cm6));
    Vim.defineAction('marpSlideCut',    (cm) => cutSlide(cm.cm6));
    Vim.mapCommand('gsi', 'action', 'marpSlideInsert', {}, { context: 'normal' });
    Vim.mapCommand('gsy', 'action', 'marpSlideYank',   {}, { context: 'normal' });
    Vim.mapCommand('gsd', 'action', 'marpSlideCut',    {}, { context: 'normal' });
  } catch (_) {}

  // Table helpers — NORMAL-mode `gt` leader (gti insert / gtc column highlight).
  // Same rationale as `gs*` above: `gt*` is unused by @replit/codemirror-vim's
  // default keymap — real Vim's gt/gT tab-switching is not bound here — and is not
  // bracket-prefixed. No digit after `gt`, which would fight Vim's count parsing.
  // `C` remains unbound throughout: it is Vim's change-to-EOL operator.
  try {
    Vim.defineAction('mdTableInsert',    () => openTableModal());
    Vim.defineAction('mdTableColToggle', () => setTableCol(!tableColState));
    Vim.mapCommand('gti', 'action', 'mdTableInsert',    {}, { context: 'normal' });
    Vim.mapCommand('gtc', 'action', 'mdTableColToggle', {}, { context: 'normal' });
  } catch (_) {}

  // Cell mode — NORMAL-mode `gm` leader, the slot previously reserved here for a
  // future feature. Only `gmc` is taken; once cell mode is on, its own key gate
  // (which runs BEFORE Vim) owns the single-letter commands, so no further Vim
  // mappings are needed.
  try {
    Vim.defineAction('mdCellModeToggle', () => setCells(!cellState));
    Vim.mapCommand('gmc', 'action', 'mdCellModeToggle', {}, { context: 'normal' });
  } catch (_) {}

  // Japanese-aware w/b/e/W/B/E (and dw/cw/yw/daw/...) — segment by
  // hiragana / katakana / han / ASCII-word / punctuation class boundaries.
  try { installJpWordMotion(Vim); } catch (_) {}
  // Vim is a module-level singleton independent of the vimComp Compartment, so
  // the layout is applied unconditionally at boot — including while Vim mode is
  // OFF, so turning it on later already has the right langmap.
  try { applyKeyLayout(Vim, keyLayoutState); } catch (_) {}

  // OS-clipboard-backed yank/paste (unnamedplus): plain y/d/c/x mirror to the
  // OS clipboard, and `p`/`P` paste it (synced in on window focus). Routed
  // through Rust IPC since navigator.clipboard is unavailable on app://.
  try { installClipboardSync({ Vim, ipcSend }); } catch (_) {}

  const saveKey = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => { doSave(); return true; },
  };

  // (Char-count is opened via the status bar — no keybinding to avoid
  // conflicting with Vim's `c` change operator.)

  // Track Vim mode changes (for the status bar).
  let lastGutterCursorLine = -1;
  // Auto-open the completion popup when the caret lands on a *blank* YAML
  // front-matter field, so options (marp / theme / paginate / …) are presented
  // without the user having to type or know them. Guarded to fire only on an
  // actual cursor move or edit (not on e.g. an Escape that closed the popup at
  // the same position) so pressing Esc doesn't immediately reopen it.
  let fmLastAutoPos = -1;
  const modeListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      const cur = u.state.doc.toString();
      const isDirty = cur !== savedDoc;
      if (isDirty !== dirty) { dirty = isDirty; updateTitle(); }
      schedulePushLive();
      if (marpTimer) clearTimeout(marpTimer);
      marpTimer = setTimeout(() => { marpTimer = 0; updateMarpButtons(); }, 300);
    }
    if (u.selectionSet || u.docChanged) {
      updateStatus();
      // Notify preview of cursor line.
      if (!u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head).number;
        ipcSend('editor:cursor:' + line);
      }
      // Front-matter blank-field auto-suggest. Suppressed in cell Command mode:
      // j/k can land on the front-matter pseudo-cell, and the popup that would
      // open there cannot be interacted with (the gate holds the keyboard).
      const sel = u.state.selection.main;
      const inCellCommand = cellModeOf(u.state).mode === 'command';
      if (sel.empty && !inCellCommand && (u.docChanged || sel.head !== fmLastAutoPos)) {
        fmLastAutoPos = sel.head;
        if (!completionStatus(u.state) && frontMatterBlankFieldAt(u.state, sel.head)) {
          setTimeout(() => startCompletion(view), 0);
        }
      } else if (!sel.empty) {
        fmLastAutoPos = -1;
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
      // Jupyter-style cell mode. Position matters twice:
      //  - gutter order is extension order, so sitting after lineNoComp and
      //    before foldGutter() yields [line numbers][cell numbers][fold arrows],
      //    and cycling the line-number mode only adds/removes the leftmost one;
      //  - its run keymap must precede the main keymap.of([… defaultKeymap …])
      //    below to take `Mod-Enter` from insertBlankLine and `Shift-Enter` from
      //    Enter's shift binding.
      // Its key gate carries its OWN Prec.highest, which is what puts it ahead of
      // vimPlugin's keydown handler — being listed after vimComp here does not
      // change that (see the header comment in cells.js).
      cellComp.of(cellState ? cellMode(cellCallbacks()) : []),
      themeComp.of(themeState === 'dark' ? oneDark : []),
      foldGutter(),
      headingFold,
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      // Tints only `background`, so it composes with highlightActiveLine's line
      // background and leaves syntaxHighlighting's colors alone.
      tableColComp.of(tableColState ? tableColumnHighlight() : []),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage }),
      // Ctrl+V of an Office / HTML <table> or an Excel TSV range becomes a GFM
      // pipe table. Prec.highest (inside tablePaste) is what puts it ahead of
      // lang-markdown's pasteURLAsLink, which markdown() above registers by
      // default; the built-in handlers.paste is appended after ALL plugins by
      // computeHandlers(), so it is already behind us. Array position here is
      // irrelevant. No Compartment: the extension holds no state and renders
      // nothing, so a closure flag is correct (unlike tableColComp below).
      tablePaste({
        isEnabled: () => tablePasteState,
        onConvert: (rows, cols) =>
          showHint(rows + '行 × ' + cols + '列の表として貼り付け'
                 + '  Ctrl+Z で取消 / Ctrl+Shift+V でそのまま貼付'),
      }),
      search(),
      autocompletion({
        override: [frontMatterCompletionSource, fencedDivCompletionSource, spanStyleCompletionSource, texEnvCompletionSource, katexCommandCompletionSource, pathCompletionSource(() => currentPath)],
        activateOnTyping: true,
        defaultKeymap: false,
      }),
      leftRightAutoPair(),
      EditorView.lineWrapping,
      // 補完ポップアップ表示中の Enter / 矢印キー等を、markdown の
      // insertNewlineContinueMarkup (Prec.high) より優先させる。
      // acceptCompletion 等はポップアップ非表示時 false を返すので、
      // リスト継続・改行など通常挙動には干渉しない。
      Prec.highest(keymap.of(completionKeymap)),
      // Ctrl+wheel font zoom. The editor webview builds WITHOUT
      // .with_hotkeys_zoom(), and wry defaults zoom_hotkeys_enabled to false ->
      // SetIsZoomControlEnabled(false), so there is no WebView2 browser zoom to
      // fight here — but preventDefault is still needed to stop the scroll.
      // A wheel listener on an element is not passive by default (only the ones
      // on window/document/body are), so preventDefault takes effect.
      EditorView.domEventHandlers({
        wheel(e) {
          if (!e.ctrlKey && !e.metaKey) return false;
          e.preventDefault();
          zoomFont(e.deltaY < 0 ? +1 : -1);
          return true;
        },
      }),
      keymap.of([
        saveKey,
        // Ctrl+= / Ctrl+- / Ctrl+0. A plain keymap layer is enough even with Vim
        // on — see the header comment in editorPrefs.js for why these survive
        // @replit/codemirror-vim's non-insert key swallowing.
        ...editorPrefsKeymap({
          onZoomIn: () => zoomFont(+1),
          onZoomOut: () => zoomFont(-1),
          onZoomReset: () => resetFont(),
        }),
        ...mathInputAssistKeymap(),
        ...numberedListIndentKeymap(),
        ...marpSlideKeymap({
          onInsert: () => openSlideModal(),
          onCopy: () => copySlide(view),
          onCut: () => cutSlide(view),
        }),
        ...mdTableKeymap({
          onInsert: () => openTableModal(),
          onToggleColumn: () => setTableCol(!tableColState),
        }),
        // Arms a one-shot "paste as plain text" flag and returns false so the
        // native paste still runs. Must precede defaultKeymap; Vim sees this as
        // <C-S-V>, not <C-v>, so visual-block is unaffected.
        ...plainPasteKeymap(),
        indentWithTab,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      modeListener,
      // Typography reads the :root CSS variables that setFontSize /
      // setFontFamily write (see editorPrefs.js for why variables rather than a
      // Compartment). The fallbacks keep this correct if the stylesheet ever
      // fails to load. Only `&` (.cm-editor) and .cm-scroller are affected, so
      // the status bar / modals / Vim ex prompt stay at their fixed sizes.
      EditorView.theme({
        '&': { height: '100%', fontSize: 'var(--editor-font-size, 15px)' },
        '.cm-scroller': {
          fontFamily: 'var(--editor-font-family, "Cascadia Code", "Source Han Code JP", "Yu Gothic UI", Consolas, monospace)',
          lineHeight: '1.6',
        },
        '.cm-content': { padding: '12px 16px' },
        '.cm-gutters': { background: 'transparent', border: 'none' },
      }),
    ],
  });
  const view = new EditorView({ state, parent: editorHost });
  updateSettingsUI();
  updateMarpButtons();

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
      // Never land in a new file in cell Command mode with a stale pending latch.
      effects: setCellMode.of('edit'),
    });
    savedDoc = payload.content;
    // The preview is showing exactly this content, so a cell "run" on an untouched
    // buffer can take the cheap scroll-only path.
    lastPushedDoc = payload.content;
    dirty = false;
    updateTitle();
    updateStatus();
    updateMarpButtons();
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
    // Place the cursor where the preview was looking (E key passes the line).
    // Deferred to next frame so the editor layout is settled before scrollIntoView.
    const initLine = window.__initialFile.line | 0;
    if (initLine > 0) {
      requestAnimationFrame(() => window.__previewScrolledTo(initLine));
    }
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

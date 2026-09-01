// UI language (ja / en) for the companion editor window.
//
// ⚠️ Mirror of the I18N table in assets/index.html. The two key spaces are
// disjoint by construction — this file owns `ed.*`, index.html owns everything
// else — so the ONLY keys that must stay byte-identical across the two are
// `common.*`. tools/preview-harness/i18ncheck.py enforces that.
//
// The language itself is NOT an editor-scoped pref: it is stored under the
// unprefixed `uiLang` key, deliberately breaking the `editor:*` convention used
// by every other pref here. The preview (app://localhost/index.html) and this
// window (app://localhost/editor.html) are the same origin in the same WebView2
// user-data folder, so they share localStorage — one key is all the two windows
// need to agree, with no IPC and no Rust change.
//
// Key-major, not language-major: the copy is what gets reviewed, and this shape
// puts each pair on adjacent lines, so an `en` cannot be added without seeing
// the `ja` beside it.
//
// ⚠️ DO NOT TRANSLATE:
//   * `stack` in editorPrefs.js — real font names ("BIZ UDゴシック"), not labels.
//     Translating one makes font selection fail silently.
//   * SLIDE_CLASSES (marpSlides.js) / TABLE_ALIGNS (mdTable.js) — identifiers
//     rendered verbatim in the pickers; they are data, not labels.
//   * `name` in frontMatterComplete.js — front-matter keys. Only `detail` is copy.
//   * Enum pref values ('on'/'off'/'absolute'/'relative'/…) and every
//     data-el / data-val / data-lang / data-seg attribute value.
// Vim's own errors (E492 etc.) come from @replit/codemirror-vim and are out of
// reach without patching the dependency.

export const LANGS = ['ja', 'en'];

export const I18N = {
  // ---- shared with assets/index.html: keep byte-identical ----
  'common.close':            { ja: '閉じる',   en: 'Close' },
  'common.on':               { ja: 'オン',     en: 'On' },
  'common.off':              { ja: 'オフ',     en: 'Off' },
  'common.lang.auto':        { ja: '自動',     en: 'Auto' },
  'common.lang.ja':          { ja: '日本語',   en: '日本語' },
  'common.lang.en':          { ja: 'English',  en: 'English' },

  // ---- status bar ----
  'ed.status.charCountHint': { ja: 'クリックで文字数を表示', en: 'Click for character count' },
  'ed.status.untitled':      { ja: '無題',     en: 'Untitled' },
  'ed.status.settings':      { ja: '⚙ 設定',   en: '⚙ Settings' },
  'ed.status.settingsTitle': { ja: '表示・編集の設定（文字サイズ / フォント / テーマ / Vim / セルモード …）  ·  :pref',
                               en: 'Display and editing preferences (font size / family / theme / Vim / cell mode …)  ·  :pref' },
  'ed.status.table':         { ja: '⊞ 表',     en: '⊞ Table' },
  'ed.status.tableTitle':    { ja: 'Markdown の表を挿入（行 × 列）  ·  :table [R C] / gti / Ctrl+Alt+T',
                               en: 'Insert a Markdown table (rows × columns)  ·  :table [R C] / gti / Ctrl+Alt+T' },
  'ed.status.slideAdd':      { ja: '+ スライド', en: '+ Slide' },
  'ed.status.slideAddTitle': { ja: 'スライドを挿入（クラスを選択）  ·  :slide / gsi / Ctrl+Alt+N',
                               en: 'Insert a new slide (pick a class)  ·  :slide / gsi / Ctrl+Alt+N' },
  'ed.status.slideCopy':     { ja: '⧉ スライド', en: '⧉ Slide' },
  'ed.status.slideCopyTitle':{ ja: '現在のスライドをコピー  ·  :slideyank / gsy / Ctrl+Alt+C',
                               en: 'Copy the current slide  ·  :slideyank / gsy / Ctrl+Alt+C' },
  'ed.status.slideCut':      { ja: '✂ スライド', en: '✂ Slide' },
  'ed.status.slideCutTitle': { ja: '現在のスライドをカット  ·  :slidecut / gsd / Ctrl+Alt+X',
                               en: 'Cut the current slide  ·  :slidecut / gsd / Ctrl+Alt+X' },

  // ---- character count modal ----
  'ed.cc.title':             { ja: '文字数',   en: 'Character Count' },
  'ed.cc.hint':              { ja: 'ステータスバーのクリックで再表示 · <kbd>Esc</kbd> で閉じる',
                               en: 'Click the status bar to reopen · <kbd>Esc</kbd> to close' },
  'ed.cc.charsAll':          { ja: '総文字数（空白を含む）', en: 'Total characters (incl. whitespace)' },
  'ed.cc.charsNoSpace':      { ja: '総文字数（空白を除く）', en: 'Total characters (excl. whitespace)' },
  'ed.cc.bodyChars':         { ja: '本文の文字数（YAML / コード / 数式と空白を除く）',
                               en: 'Body characters (excl. YAML/code/math, no whitespace)' },
  'ed.cc.words':             { ja: '単語数（空白区切り）', en: 'Words (whitespace-separated)' },
  'ed.cc.lines':             { ja: '行数',     en: 'Lines' },
  'ed.cc.paragraphs':        { ja: '段落数',   en: 'Paragraphs' },
  'ed.cc.selChars':          { ja: '選択範囲: 文字数（空白を除く）', en: 'Selection: characters (excl. whitespace)' },
  'ed.cc.selWords':          { ja: '選択範囲: 単語数', en: 'Selection: words' },

  // ---- insert slide modal ----
  'ed.slide.title':          { ja: 'スライドを挿入', en: 'Insert Slide' },
  'ed.slide.hint':           { ja: 'クラスを選択 · <kbd>Esc</kbd> で取消',
                               en: 'Pick a class · <kbd>Esc</kbd> to cancel' },
  'ed.slide.noClass':        { ja: '（クラスなし）', en: '(no class)' },

  // ---- insert table modal ----
  'ed.table.title':          { ja: '表を挿入', en: 'Insert Table' },
  'ed.table.rows':           { ja: '行数（見出し行を含む）', en: 'Rows (incl. header)' },
  'ed.table.cols':           { ja: '列数',     en: 'Columns' },
  'ed.table.align':          { ja: '揃え',     en: 'Align' },
  'ed.table.alignDefault':   { ja: '既定',     en: 'default' },
  'ed.table.insert':         { ja: '挿入',     en: 'Insert' },
  'ed.table.hint':           { ja: '<kbd>Enter</kbd> で挿入 · <kbd>Esc</kbd> で取消 · 任意のサイズは <kbd>:table 3 4</kbd>',
                               en: '<kbd>Enter</kbd> to insert · <kbd>Esc</kbd> to cancel · <kbd>:table 3 4</kbd> for any size' },

  // ---- cell mode key list ----
  'ed.cells.title':          { ja: 'セルモード キー一覧', en: 'Cell Mode Keys' },
  'ed.cells.hint':           { ja: '<kbd>Esc</kbd> で閉じる · セル区切りは <kbd>---</kbd> 行',
                               en: '<kbd>Esc</kbd> to close · cells are separated by a <kbd>---</kbd> line' },
  // Descriptions for CELL_HELP (cells.js keeps the ordered key list; the copy
  // lives here). CELL_HELP is display-only — the keymap is separate switch
  // logic in cellGate() — so localizing these cannot affect any binding.
  'ed.cells.esc':            { ja: 'コマンドモードへ / 保留キーをクリア', en: 'To Command mode / clear a pending key' },
  'ed.cells.enter':          { ja: 'セルを編集（Edit モード）', en: 'Edit the cell (Edit mode)' },
  'ed.cells.i':              { ja: '編集して INSERT モードへ', en: 'Edit and enter INSERT mode' },
  'ed.cells.jk':             { ja: '次 / 前のセルを選択', en: 'Select the next / previous cell' },
  'ed.cells.arrows':         { ja: '次 / 前のセルを選択', en: 'Select the next / previous cell' },
  'ed.cells.gg':             { ja: '最初のセル', en: 'First cell' },
  'ed.cells.G':              { ja: '最後のセル', en: 'Last cell' },
  'ed.cells.ab':             { ja: '上 / 下にセルを挿入', en: 'Insert a cell above / below' },
  'ed.cells.dd':             { ja: 'セルを削除', en: 'Delete the cell' },
  'ed.cells.x':              { ja: 'セルをカット', en: 'Cut the cell' },
  'ed.cells.cy':             { ja: 'セルをコピー', en: 'Copy the cell' },
  'ed.cells.vV':             { ja: '下 / 上に貼り付け', en: 'Paste below / above' },
  'ed.cells.M':              { ja: '下のセルと結合', en: 'Merge with the cell below' },
  'ed.cells.heading':        { ja: '見出しレベルを設定 / 解除', en: 'Set / clear the heading level' },
  'ed.cells.undo':           { ja: '元に戻す', en: 'Undo' },
  'ed.cells.redo':           { ja: 'やり直す', en: 'Redo' },
  'ed.cells.save':           { ja: '保存',     en: 'Save' },
  'ed.cells.lineNo':         { ja: '行番号モードを切り替え', en: 'Cycle the line-number mode' },
  'ed.cells.find':           { ja: '検索',     en: 'Find' },
  'ed.cells.marpClass':      { ja: 'Marp スライドクラスを変更（Marp 文書のみ）',
                               en: 'Change the Marp slide class (Marp documents only)' },
  'ed.cells.help':           { ja: 'このヘルプ', en: 'This help' },
  'ed.cells.runNext':        { ja: '実行して次のセルへ', en: 'Run and go to the next cell' },
  'ed.cells.runStay':        { ja: '実行してとどまる', en: 'Run and stay' },
  'ed.cells.runInsert':      { ja: '実行して下にセルを挿入', en: 'Run and insert a cell below' },
  'ed.cells.split':          { ja: 'カーソル位置でセルを分割', en: 'Split the cell at the cursor' },
  'ed.cells.move':           { ja: 'セルを上 / 下へ移動', en: 'Move the cell up / down' },
  // Runtime hints routed through cb.onHint.
  'ed.cells.notMarp':        { ja: 'm: Marp 文書ではありません', en: 'm: not a Marp document' },
  'ed.cells.multiUnsupported': { ja: '複数セル選択は未対応です', en: 'Multi-cell selection is not supported yet' },

  // ---- settings modal ----
  'ed.settings.aria':        { ja: 'エディター設定', en: 'Editor settings' },
  'ed.settings.title':       { ja: '⚙ 設定',   en: '⚙ Settings' },
  'ed.settings.secDisplay':  { ja: '表示',     en: 'Display' },
  'ed.settings.secEditing':  { ja: '編集',     en: 'Editing' },
  'ed.settings.secIntegration': { ja: '連携',  en: 'Integration' },
  'ed.settings.hint':        { ja: '<kbd>Esc</kbd> で閉じる', en: '<kbd>Esc</kbd> to close' },

  'ed.settings.lang':        { ja: '表示言語', en: 'Language' },
  'ed.settings.langHint':    { ja: 'プレビュー側と共有されます · 「自動」は OS の言語に従います',
                               en: 'Shared with the preview window · “Auto” follows the OS language' },

  'ed.settings.fontSize':    { ja: '文字サイズ', en: 'Font size' },
  'ed.settings.fontSizeHint':{ ja: '<code>Ctrl</code>+<code>+</code> / <code>-</code> / <code>0</code> · <code>Ctrl</code>+ホイール · <code>:fontsize</code>',
                               en: '<code>Ctrl</code>+<code>+</code> / <code>-</code> / <code>0</code> · <code>Ctrl</code>+wheel · <code>:fontsize</code>' },
  'ed.settings.smaller':     { ja: '小さく',   en: 'Smaller' },
  'ed.settings.larger':      { ja: '大きく',   en: 'Larger' },
  'ed.settings.reset':       { ja: '戻す',     en: 'Reset' },
  'ed.settings.fontFamily':  { ja: 'フォント', en: 'Font' },
  'ed.settings.fontFamilyHint': { ja: '編集領域のみ。ステータスバー等は固定サイズです',
                               en: 'The editing area only — the status bar and modals stay at a fixed size' },
  'ed.settings.theme':       { ja: 'テーマ',   en: 'Theme' },
  'ed.settings.lineNo':      { ja: '行番号',   en: 'Line numbers' },
  'ed.settings.lineNoAbs':   { ja: '絶対',     en: 'Absolute' },
  'ed.settings.lineNoRel':   { ja: '相対',     en: 'Relative' },
  'ed.settings.lineNoOff':   { ja: 'なし',     en: 'Off' },

  'ed.settings.vim':         { ja: 'Vim キーバインド', en: 'Vim keybindings' },
  'ed.settings.vimHint':     { ja: 'OFF で CodeMirror 標準のキー操作',
                               en: 'Off gives the stock CodeMirror keybindings' },
  'ed.settings.keyLayout':   { ja: 'キー配列（Vim コマンド）', en: 'Key layout (Vim commands)' },
  'ed.settings.keyLayoutHint': { ja: 'Dvorak エミュレータ使用時に、コマンドモードのキーを QWERTY の位置で解釈 · <code>:set dvorak</code> / <code>:keylayout</code>',
                               en: 'With a Dvorak emulator, read Command-mode keys at their QWERTY positions · <code>:set dvorak</code> / <code>:keylayout</code>' },
  'ed.settings.cells':       { ja: 'セルモード', en: 'Cell mode' },
  'ed.settings.cellsHint':   { ja: '<code>---</code> 区切りの Jupyter 風編集 · <code>:cellmode</code> / <code>gmc</code>',
                               en: 'Jupyter-style editing with <code>---</code> as the separator · <code>:cellmode</code> / <code>gmc</code>' },
  'ed.settings.tableCol':    { ja: '表の列ハイライト', en: 'Table column highlight' },
  'ed.settings.tablePaste':  { ja: '表の貼り付け変換', en: 'Convert pasted tables' },
  'ed.settings.tablePasteHint': { ja: 'Excel / Word の表を GFM 表に · 一回だけ素で貼るのは <code>Ctrl</code>+<code>Shift</code>+<code>V</code>',
                               en: 'Turn an Excel / Word table into a GFM table · <code>Ctrl</code>+<code>Shift</code>+<code>V</code> pastes raw just once' },
  'ed.settings.live':        { ja: 'ライブプレビュー', en: 'Live preview' },
  'ed.settings.liveHint':    { ja: 'OFF なら保存時のみプレビュー更新（重い文書向け）',
                               en: 'Off refreshes the preview only on save (for heavy documents)' },

  // ---- hints / ex-command feedback ----
  'ed.hint.tablePaste':      { ja: '表の貼り付け変換: {state}', en: 'Convert pasted tables: {state}' },
  'ed.hint.keyLayout':       { ja: 'キー配列: {name}', en: 'Key layout: {name}' },
  'ed.hint.fontSize':        { ja: '文字サイズ {size}px', en: 'Font size {size}px' },
  'ed.hint.fontSizeLimit':   { ja: '文字サイズ {size}px（下限/上限）', en: 'Font size {size}px (at the limit)' },
  'ed.hint.lang':            { ja: '表示言語: {lang}', en: 'Language: {lang}' },
  'ed.hint.badFontSize':     { ja: 'E488: 引数が不正です: :fontsize {arg}', en: 'E488: Trailing characters: :fontsize {arg}' },
  'ed.hint.badKeyLayout':    { ja: 'E488: 引数が不正です: :keylayout {arg} (qwerty / dvorak)',
                               en: 'E488: Trailing characters: :keylayout {arg} (qwerty / dvorak)' },
  'ed.hint.tablePasted':     { ja: '{rows}行 × {cols}列の表として貼り付け  Ctrl+Z で取消 / Ctrl+Shift+V でそのまま貼付',
                               en: 'Pasted as a {rows}×{cols} table  Ctrl+Z to undo / Ctrl+Shift+V to paste raw' },

  // ---- key layout labels ----
  'ed.keyLayout.qwerty':     { ja: 'なし (QWERTY)', en: 'None (QWERTY)' },
  'ed.keyLayout.dvorak':     { ja: 'Dvorak → QWERTY', en: 'Dvorak → QWERTY' },

  // ---- font family labels (the `stack` values are NEVER translated) ----
  'ed.font.cascadia':        { ja: 'Cascadia Code（既定）', en: 'Cascadia Code (default)' },
  'ed.font.consolas':        { ja: 'Consolas', en: 'Consolas' },
  'ed.font.bizud':           { ja: 'BIZ UDゴシック', en: 'BIZ UDGothic' },
  'ed.font.yugothic':        { ja: '游ゴシック', en: 'Yu Gothic' },

  // ---- completion popup `detail` text ----
  'ed.complete.parentDir':   { ja: '親フォルダへ', en: 'Parent folder' },

  'ed.complete.fm.marp':     { ja: 'Marpスライドモード (true)', en: 'Marp slide mode (true)' },
  'ed.complete.fm.confidential': { ja: '機密透かし (true)', en: 'Confidential watermark (true)' },
  'ed.complete.fm.watermark':{ ja: '背景透かし文字 (任意文字列, 例: DRAFT)', en: 'Watermark text (any string, e.g. DRAFT)' },
  'ed.complete.fm.title':    { ja: 'タイトル (メタ情報・任意)', en: 'Title (metadata, optional)' },
  'ed.complete.fm.theme':    { ja: 'スライドテーマ', en: 'Slide theme' },
  'ed.complete.fm.paginate': { ja: 'ページ番号 (true/false)', en: 'Page numbers (true/false)' },
  'ed.complete.fm.header':   { ja: 'ヘッダー (全スライド)', en: 'Header (every slide)' },
  'ed.complete.fm.footer':   { ja: 'フッター (全スライド)', en: 'Footer (every slide)' },
  'ed.complete.fm.size':     { ja: 'スライド比率 (16:9 / 4:3)', en: 'Slide ratio (16:9 / 4:3)' },
  'ed.complete.fm.class':    { ja: 'スライドクラス', en: 'Slide class' },
  'ed.complete.fm.classOne': { ja: 'スライドクラス (このスライドのみ)', en: 'Slide class (this slide only)' },
  'ed.complete.fm.bgColor':  { ja: '背景色 (CSS color)', en: 'Background colour (CSS color)' },
  'ed.complete.fm.bgImage':  { ja: '背景画像 (url(...))', en: 'Background image (url(...))' },
  'ed.complete.fm.color':    { ja: '文字色 (CSS color)', en: 'Text colour (CSS color)' },
  'ed.complete.fm.style':    { ja: '追加CSS', en: 'Extra CSS' },
  'ed.complete.fm.math':     { ja: '数式エンジン (katex/mathjax)', en: 'Math engine (katex/mathjax)' },

  'ed.complete.span.color':  { ja: '文字色',   en: 'Text colour' },
  'ed.complete.span.size':   { ja: '文字サイズ', en: 'Font size' },
  'ed.complete.span.font':   { ja: 'フォント', en: 'Font' },
  'ed.complete.span.bg':     { ja: '背景色',   en: 'Background colour' },
  'ed.complete.span.weight': { ja: '文字の太さ', en: 'Font weight' },
  'ed.complete.span.valign': { ja: '縦位置(ベースライン)', en: 'Vertical align (baseline)' },
};

// Test hook, mirroring window.__I18N in assets/index.html.
// tools/preview-harness/i18ncheck.py reads both to check table integrity.
try { window.__editorI18n = I18N; } catch (_) {}

// Resolved once at boot and updated by setLang(). Read through getLang().
let uiLang = 'ja';
const listeners = [];

/** Walk navigator.languages, not navigator.language: someone whose Windows
 *  *display* language is English but whose preferred-language list leads with
 *  Japanese should get Japanese. 'ja-' rather than 'ja' so 'jam' cannot match. */
export function detectLang() {
  const cands = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || ''];
  for (const l of cands) {
    const tag = String(l).toLowerCase();
    if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

/** The stored preference, or null for "auto". The ABSENCE of the key is auto —
 *  there is no 'auto' sentinel, so "back to automatic" is removeItem(). */
export function readLangPref() {
  try {
    const v = localStorage.getItem('uiLang');
    return LANGS.indexOf(v) >= 0 ? v : null;
  } catch (_) {
    return null;
  }
}

export function getLang() { return uiLang; }

/** `persist === false` when the change arrived from the preview window via a
 *  storage event — re-persisting would be redundant and could ping-pong. */
export function setLang(pref, persist) {
  const next = LANGS.indexOf(pref) >= 0 ? pref : null;
  if (persist !== false) {
    try {
      if (next) localStorage.setItem('uiLang', next);
      else localStorage.removeItem('uiLang');
    } catch (_) { /* private mode — the choice just will not survive a restart */ }
  }
  uiLang = next || detectLang();
  document.documentElement.lang = uiLang;
  listeners.forEach((fn) => { try { fn(uiLang); } catch (_) {} });
}

export function onLangChange(fn) { listeners.push(fn); }

/** Fallback chain: uiLang -> ja -> the key itself, so a missing translation is
 *  loud in dev and never blank. The `if (params)` guard keeps the no-params
 *  path a bare lookup — t() is called per node while rendering chrome. */
export function t(key, params) {
  const m = I18N[key];
  let s = (m && (m[uiLang] || m.ja)) || key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) =>
      (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : '{' + k + '}'));
  }
  return s;
}

/** Translate every [data-i18n*] node under `root`.
 *
 *  This is what makes live switching possible without the mount refactor the
 *  editor would otherwise need: all of its modals and the status bar assign
 *  innerHTML ONCE at boot, so nothing is rebuilt on open. Because this pass
 *  only rewrites text and attributes — never structure — the element references
 *  cached in `settingsCtl` and friends stay valid. */
export function applyI18n(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  // innerHTML, fed only from the constant table above (several hints carry <kbd>
  // / <code> markup). Never pass user or document text through this.
  r.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  r.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const i = pair.indexOf(':');
      if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
    });
  });
}

/** Boot: resolve the shared pref and start following the other window.
 *
 *  Cross-window sync with no IPC and no Rust change. `storage` fires only in
 *  OTHER documents, never the writer, so there is no loop. The `focus` re-read
 *  is belt-and-braces for any environment where the event does not cross two
 *  WebView2 windows — the same shape clipboardSync.js already uses to re-read
 *  the OS clipboard. */
export function initLang(onChange) {
  uiLang = readLangPref() || detectLang();
  document.documentElement.lang = uiLang;
  if (onChange) onLangChange(onChange);
  const follow = () => {
    const next = readLangPref() || detectLang();
    if (next !== uiLang) setLang(readLangPref(), false);
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== 'uiLang' && e.key !== null) return;   // null === clear()
    follow();
  });
  window.addEventListener('focus', follow);
  return uiLang;
}

// Editor display preferences: font size (zoom) and font family.
//
// Pure logic + a keymap factory only — the settings modal, the status bar and
// localStorage live in entry.js, same split as mdTable.js / marpSlides.js. That
// split is what makes editorPrefs.test.mjs runnable under bare `node`.
//
// The values produced here are applied as CSS custom properties on :root
// (--editor-font-size / --editor-font-family), NOT through a Compartment.
// Font size holds no state and renders no decorations, so there is nothing to go
// stale — the same reasoning entry.js records for tablePaste's closure flag.
// Reconfiguring a Compartment would be a transaction and a ViewPlugin teardown
// for what is ultimately one CSS variable write.
//
// NOTE the caller must follow every size change with view.requestMeasure():
// CodeMirror caches character width and line height in its heightOracle, and
// EditorView.lineWrapping is on, so without a re-measure the wrap points and the
// caret drift apart from the rendered glyphs.

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 15;   // the historical hard-coded value

// Integer px within [MIN, MAX]. Anything unparseable (null, '', 'abc', NaN,
// Infinity) falls back to the default rather than throwing, because this also
// guards values read back out of localStorage, which a user can hand-edit.
export function clampFontSize(n) {
  const v = typeof n === 'number' ? n : parseFloat(n);
  if (!isFinite(v)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(v)));
}

export function stepFontSize(cur, delta) {
  return clampFontSize(clampFontSize(cur) + (parseFloat(delta) || 0));
}

// Monospace-ish stacks that all render Japanese acceptably. Only the `key` is
// persisted, so entry.js's existing enum validator (readPref) can vet it and no
// arbitrary CSS string can ever reach a style attribute.
export const FONT_FAMILIES = [
  {
    key: 'cascadia',
    label: 'Cascadia Code（既定）',
    stack: '"Cascadia Code", "Source Han Code JP", "Yu Gothic UI", Consolas, monospace',
  },
  {
    key: 'consolas',
    label: 'Consolas',
    stack: 'Consolas, "Yu Gothic UI", monospace',
  },
  {
    key: 'bizud',
    label: 'BIZ UDゴシック',
    stack: '"BIZ UDGothic", "BIZ UDゴシック", "Yu Gothic UI", monospace',
  },
  {
    key: 'yugothic',
    label: '游ゴシック',
    stack: '"Yu Gothic UI", "Yu Gothic", "Meiryo", monospace',
  },
];

export const FONT_FAMILY_DEFAULT = 'cascadia';

export function fontFamilyKeys() {
  return FONT_FAMILIES.map((f) => f.key);
}

export function fontStackOf(key) {
  const hit = FONT_FAMILIES.find((f) => f.key === key);
  return (hit || FONT_FAMILIES[0]).stack;
}

// `:fontsize` argument forms: absolute (`17`), relative (`+2` / `-2`), and
// reset (`reset` / `default` / omitted). Returns the resulting px, or null when
// the argument is present but unintelligible so the caller can report an error
// instead of silently resetting.
export function parseFontSizeArg(arg, cur) {
  const s = String(arg == null ? '' : arg).trim().toLowerCase();
  if (s === '' || s === 'reset' || s === 'default') return FONT_SIZE_DEFAULT;
  if (/^[+-]\d+$/.test(s)) return stepFontSize(cur, parseInt(s, 10));
  if (/^\d+$/.test(s)) return clampFontSize(parseInt(s, 10));
  return null;
}

// Non-Vim keybindings, spread into the editor's keymap.of([...]) before the
// default keymap.
//
// Two constraints shape this list:
//
//   1. Mod-Shift-- is NOT bound, and must never be: cells.js already owns it for
//      "split cell at cursor". Zoom-out is the SHIFT-LESS Mod-- only.
//   2. On a Japanese keyboard `=` is Shift+`-` and `+` is Shift+`;`, so which of
//      Mod-= / Mod-Shift-= / Mod-+ actually fires depends on the layout. All
//      three are bound so zoom-in works on JP and US layouts alike.
//
// A plain keymap layer is sufficient even with Vim on: @replit/codemirror-vim
// only swallows keys whose name is a single character in non-insert mode
// (dist/index.js — `key.length === 1`), and `<C-=>` / `<C-->` / `<C-0>` are
// longer. cells.js's pre-Vim keydown gate likewise returns false for any
// ctrl/meta/alt combo except Ctrl+r, and entry.js's document-level Esc chain
// bails on modifiers. So no Prec.highest(domEventHandlers) gate is needed here.
export function editorPrefsKeymap({ onZoomIn, onZoomOut, onZoomReset }) {
  return [
    { key: 'Mod-=', preventDefault: true, run: () => { onZoomIn(); return true; } },
    { key: 'Mod-Shift-=', preventDefault: true, run: () => { onZoomIn(); return true; } },
    { key: 'Mod-+', preventDefault: true, run: () => { onZoomIn(); return true; } },
    { key: 'Mod--', preventDefault: true, run: () => { onZoomOut(); return true; } },
    { key: 'Mod-0', preventDefault: true, run: () => { onZoomReset(); return true; } },
  ];
}

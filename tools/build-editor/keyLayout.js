// Keyboard-layout translation for Vim command mode (Dvorak -> QWERTY).
//
// The problem: with a Dvorak layout emulator active (やまぶき, the Windows
// US-Dvorak layout, AutoHotkey, ...), pressing the physical key at the QWERTY
// `j` position emits the character `h`. Vim then runs `h` (left) where the
// user's fingers meant `j` (down). Every command-mode key is off by the
// Dvorak permutation.
//
// Pure logic + an install entry point that takes `Vim` as an argument — no
// imports at all — so keyLayout.test.mjs runs under bare `node`, the same split
// jpWordMotion.js / editorPrefs.js follow. The pref, the settings modal and
// localStorage live in entry.js.
//
// -------------------------------------------------------------------------
// Mechanism: Vim's own `langmap`, NOT Vim.map
// -------------------------------------------------------------------------
// @replit/codemirror-vim already implements the `langmap` option — the exact
// feature real Vim provides for this — and nothing in this repo used it. It is
// applied inside vimKeyFromEvent (dist/index.js:1244-1247), i.e. while the DOM
// event is being turned into a key NAME, before the key buffer exists:
//
//     if (vim && !vim.expectLiteralNext && key.length == 1) {
//       if (langmap.keymap && key in langmap.keymap) {
//         if (langmap.remapCtrl != false || !name) key = langmap.keymap[key];
//
// Translating there is what makes multi-key sequences (`gg`, `]]`, and this
// repo's `gsi` / `gtc` / `gmc`), operator-pending motions (`dw`), counts (`3j`)
// and registers all keep working with no further work.
//
// A Vim.map-per-letter implementation cannot do this and was rejected:
//   (a) matchCommand compares the JOINED key buffer string, so a single-letter
//       mapping never matches "gg" and every two-key sequence breaks;
//   (b) commandMatches rewrites the context to 'operatorPending' whenever an
//       operator is pending (dist/index.js:3619), so a 'normal' mapping does
//       not fire for the motion after `d`;
//   (c) a bijective permutation of all letters is a recursion hazard — the
//       guard in doKeyToKey is per-mapping-object identity, not global.
//
// Bonus, and the reason `f`/`r`/`m` behave correctly: `expectLiteralNext`
// (set at dist/index.js:1610 for any command whose keys end in `<character>`)
// suppresses the translation for the ARGUMENT of f/t/F/T/r/m/'. The character
// `f` searches for should be the character actually typed, and it is.
//
// -------------------------------------------------------------------------
// Scope: command mode only
// -------------------------------------------------------------------------
// Insert mode, the ex line (`:`) and the search prompt (`/`) deliberately stay
// in Dvorak — a Dvorak typist touch-types text, and only the COMMANDS carry
// QWERTY muscle memory.
//
// The ex line and search need no work: the four internal call sites
// (dist/index.js:1798, 1828, 1928, 6561) invoke the closure-local
// `vimKeyFromEvent(e)` with no second argument, and the `vim &&` guard above
// means langmap never applies there. Only the main keydown path
// (dist/index.js:8547) goes through the exported `Vim.vimKeyFromEvent(e, vim)`.
//
// Insert mode DOES get langmapped upstream, which is a divergence from real
// Vim. Ordinary typing survives it (no insert-context command matches, so
// findKey returns undefined at dist/index.js:1040-1041 without preventDefault
// and the browser inserts the original character), but macro recording does
// not: handleMacroRecording tests the translated key against 'q'
// (dist/index.js:928), so typing an apostrophe while recording would stop the
// recording. installInsertModeBypass() closes that by dropping the second
// argument in insert mode — see the comment there.

// Each entry is [emitted character, QWERTY character at the same physical key].
// Identity pairs (a, m, A, M, \, |, digits) are omitted: a character absent
// from the table is left alone.
//
// Standard US Dvorak (simplified), by physical QWERTY position:
//   qwerty  ' , . p y f g c r l / =        <- row 2 (QWERTY q..])
//   qwerty  a o e u i d h t n s -          <- row 3 (QWERTY a..')
//   qwerty  ; q j k x b m w v z            <- row 4 (QWERTY z../)
const DVORAK_PAIRS = [
  // number row: QWERTY - =
  ['[', '-'], [']', '='],
  // upper row: QWERTY q w e r t y u i o p [ ]
  ["'", 'q'], [',', 'w'], ['.', 'e'], ['p', 'r'], ['y', 't'], ['f', 'y'],
  ['g', 'u'], ['c', 'i'], ['r', 'o'], ['l', 'p'], ['/', '['], ['=', ']'],
  // home row: QWERTY a s d f g h j k l ; '   (a is identity)
  ['o', 's'], ['e', 'd'], ['u', 'f'], ['i', 'g'], ['d', 'h'], ['h', 'j'],
  ['t', 'k'], ['n', 'l'], ['s', ';'], ['-', "'"],
  // bottom row: QWERTY z x c v b n m , . /   (m is identity)
  [';', 'z'], ['q', 'x'], ['j', 'c'], ['k', 'v'], ['x', 'b'], ['b', 'n'],
  ['w', ','], ['v', '.'], ['z', '/'],

  // ---- shifted ----
  ['{', '_'], ['}', '+'],
  ['"', 'Q'], ['<', 'W'], ['>', 'E'], ['P', 'R'], ['Y', 'T'], ['F', 'Y'],
  ['G', 'U'], ['C', 'I'], ['R', 'O'], ['L', 'P'], ['?', '{'], ['+', '}'],
  ['O', 'S'], ['E', 'D'], ['U', 'F'], ['I', 'G'], ['D', 'H'], ['H', 'J'],
  ['T', 'K'], ['N', 'L'], ['S', ':'], ['_', '"'],
  [':', 'Z'], ['Q', 'X'], ['J', 'C'], ['K', 'V'], ['X', 'B'], ['B', 'N'],
  ['W', '<'], ['V', '>'], ['Z', '?'],
];

// `pairs: null` means "no translation" — the off switch, not a layout.
// `labelKey` is an i18n key resolved at render time, so the label follows a
// language switch. The map's own keys stay English: they are the persisted
// `editor:keyLayout` values and the :keylayout argument.
export const KEY_LAYOUTS = {
  qwerty: { labelKey: 'ed.keyLayout.qwerty', pairs: null },
  dvorak: { labelKey: 'ed.keyLayout.dvorak', pairs: DVORAK_PAIRS },
};

export function keyLayoutKeys() {
  return Object.keys(KEY_LAYOUTS);
}

export const DEFAULT_KEY_LAYOUT = 'qwerty';

// parseLangmap (dist/index.js:1283-1307) splits parts on unescaped `,`, splits
// a `from;to` part on an unescaped `;`, and un-escapes with /\\?(.)/. Our table
// contains `,` and `;` on BOTH sides (`,`->`w`, `s`->`;`), so escaping is not
// optional — without it the string silently parses into a different, mostly
// empty keymap (malformed parts are skipped, never reported).
function escapeLangmapChar(ch) {
  return /[\\,;]/.test(ch) ? '\\' + ch : ch;
}

// Emits the pair-list form ("aAbBcC") as a single part: no unescaped `,` and no
// unescaped `;` anywhere, so upstream's outer split yields one part and its
// semicolon split yields one element, landing in the pair branch.
export function buildLangmap(pairs) {
  if (!pairs || !pairs.length) return '';
  let out = '';
  for (const [from, to] of pairs) {
    out += escapeLangmapChar(from) + escapeLangmapChar(to);
  }
  return out;
}

export function layoutMap(name) {
  const layout = KEY_LAYOUTS[name];
  if (!layout || !layout.pairs) return null;
  const map = Object.create(null);
  for (const [from, to] of layout.pairs) map[from] = to;
  return map;
}

// Module-global, mirroring the fact that upstream's own `langmap` is global to
// the Vim singleton rather than per-EditorView. This app has one editor per
// window, so there is nothing to scope it to.
let currentMap = null;

// For consumers that do their own key dispatch ahead of Vim — currently only
// cells.js's pre-Vim gate, whose Command mode is the same kind of command mode
// and carries the same muscle memory. Identity while the layout is 'qwerty'.
export function mapCommandKey(key) {
  if (!currentMap || typeof key !== 'string' || key.length !== 1) return key;
  const mapped = currentMap[key];
  return mapped === undefined ? key : mapped;
}

let bypassInstalled = false;

// Restrict langmap to command mode, matching real Vim (upstream applies it in
// insert mode too).
//
// dist/index.js:1244 guards the whole langmap block on `vim &&`, so passing a
// falsy second argument disables it for that one call. Wrapping the EXPORTED
// Vim.vimKeyFromEvent is safe and surgical: the main keydown path
// (dist/index.js:8547) is the only caller that reaches it through the exported
// object, so the ex line and search — which call the closure-local binding —
// are untouched either way.
function installInsertModeBypass(Vim) {
  if (bypassInstalled) return;
  if (!Vim || typeof Vim.vimKeyFromEvent !== 'function') return;
  const orig = Vim.vimKeyFromEvent;
  Vim.vimKeyFromEvent = function (e, vim) {
    return vim && vim.insertMode ? orig(e, undefined) : orig(e, vim);
  };
  bypassInstalled = true;
}

// Idempotent; safe to call before the first EditorView exists, since `Vim` is a
// module-level singleton independent of entry.js's vimComp Compartment (so it
// is also correct to call while Vim mode is OFF).
export function applyKeyLayout(Vim, name) {
  const layout = KEY_LAYOUTS[name] ? name : DEFAULT_KEY_LAYOUT;
  currentMap = layoutMap(layout);
  if (!Vim || typeof Vim.langmap !== 'function') return layout;
  installInsertModeBypass(Vim);
  // remapCtrl is fixed at false, not exposed as a pref: dist/index.js:1246 then
  // leaves <C-x> combos alone and translates bare keys only. Emulators of this
  // kind commonly pass Ctrl combos through untouched, so this is the choice
  // that cannot break a Ctrl shortcut that works today.
  Vim.langmap(buildLangmap(KEY_LAYOUTS[layout].pairs), false);
  return layout;
}

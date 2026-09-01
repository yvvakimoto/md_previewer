// Headless regression tests for editorPrefs.js (no browser, no bundle).
//
//   cd tools/build-editor && node editorPrefs.test.mjs
//
// The module is deliberately free of EditorView / DOM so the whole pure layer is
// assertable here. The one fact that needs the browser — that Vim does not
// swallow Ctrl+= in NORMAL mode — lives in tools/preview-harness/prefscheck.py.

import {
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT,
  clampFontSize, stepFontSize, parseFontSizeArg,
  FONT_FAMILIES, FONT_FAMILY_DEFAULT, fontFamilyKeys, fontStackOf,
  editorPrefsKeymap,
} from './editorPrefs.js';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label
    + '  got=' + JSON.stringify(got) + (ok ? '' : '  want=' + JSON.stringify(want)));
};

// ---------- clampFontSize ----------
eq('clamp mid', clampFontSize(18), 18);
eq('clamp min edge', clampFontSize(FONT_SIZE_MIN), FONT_SIZE_MIN);
eq('clamp max edge', clampFontSize(FONT_SIZE_MAX), FONT_SIZE_MAX);
eq('clamp below min', clampFontSize(1), FONT_SIZE_MIN);
eq('clamp above max', clampFontSize(999), FONT_SIZE_MAX);
eq('clamp rounds', clampFontSize(15.6), 16);
eq('clamp numeric string', clampFontSize('20'), 20);
// Guards a hand-edited localStorage value, so every junk form must be tame.
eq('clamp null', clampFontSize(null), FONT_SIZE_DEFAULT);
eq('clamp undefined', clampFontSize(undefined), FONT_SIZE_DEFAULT);
eq('clamp empty', clampFontSize(''), FONT_SIZE_DEFAULT);
eq('clamp junk', clampFontSize('abc'), FONT_SIZE_DEFAULT);
eq('clamp NaN', clampFontSize(NaN), FONT_SIZE_DEFAULT);
eq('clamp Infinity', clampFontSize(Infinity), FONT_SIZE_DEFAULT);

// ---------- stepFontSize ----------
eq('step up', stepFontSize(15, 1), 16);
eq('step down', stepFontSize(15, -1), 14);
eq('step saturates at max', stepFontSize(FONT_SIZE_MAX, 5), FONT_SIZE_MAX);
eq('step saturates at min', stepFontSize(FONT_SIZE_MIN, -5), FONT_SIZE_MIN);
eq('step from junk base', stepFontSize('abc', 1), FONT_SIZE_DEFAULT + 1);
eq('step zero delta', stepFontSize(15, 0), 15);

// ---------- parseFontSizeArg ----------
eq('arg absolute', parseFontSizeArg('17', 15), 17);
eq('arg relative up', parseFontSizeArg('+2', 15), 17);
eq('arg relative down', parseFontSizeArg('-2', 15), 13);
eq('arg relative clamps', parseFontSizeArg('+99', 15), FONT_SIZE_MAX);
eq('arg absolute clamps', parseFontSizeArg('500', 15), FONT_SIZE_MAX);
eq('arg empty resets', parseFontSizeArg('', 22), FONT_SIZE_DEFAULT);
eq('arg omitted resets', parseFontSizeArg(undefined, 22), FONT_SIZE_DEFAULT);
eq('arg reset', parseFontSizeArg('reset', 22), FONT_SIZE_DEFAULT);
eq('arg default', parseFontSizeArg('DEFAULT', 22), FONT_SIZE_DEFAULT);
eq('arg padded', parseFontSizeArg('  +3  ', 15), 18);
// Unintelligible must be null (an error to report), NOT a silent reset.
eq('arg junk is null', parseFontSizeArg('big', 15), null);
eq('arg float is null', parseFontSizeArg('15.5', 15), null);
eq('arg sign only is null', parseFontSizeArg('+', 15), null);

// ---------- font families ----------
eq('default key present', fontFamilyKeys().includes(FONT_FAMILY_DEFAULT), true);
eq('default is first', FONT_FAMILIES[0].key, FONT_FAMILY_DEFAULT);
eq('keys unique', fontFamilyKeys().length, new Set(fontFamilyKeys()).size);
// labelKey, not label: the display label is resolved through i18n.js at render
// time so it follows a language switch. `stack` stays a literal font list --
// it contains real font names and must never be translated.
eq('every family has labelKey+stack',
   FONT_FAMILIES.every((f) => !!f.key && !!f.labelKey && !!f.stack), true);
eq('labelKey is namespaced for the editor table',
   FONT_FAMILIES.every((f) => f.labelKey.startsWith('ed.font.')), true);
eq('unknown key falls back', fontStackOf('nope'), FONT_FAMILIES[0].stack);
eq('null key falls back', fontStackOf(null), FONT_FAMILIES[0].stack);
eq('known key resolves', fontStackOf('consolas'), FONT_FAMILIES[1].stack);
// The default stack must stay byte-identical to the historical hard-coded one,
// so an existing user sees no change until they opt in.
eq('default stack unchanged', fontStackOf(FONT_FAMILY_DEFAULT),
   '"Cascadia Code", "Source Han Code JP", "Yu Gothic UI", Consolas, monospace');

// ---------- keymap ----------
let hits = [];
const km = editorPrefsKeymap({
  onZoomIn: () => hits.push('in'),
  onZoomOut: () => hits.push('out'),
  onZoomReset: () => hits.push('reset'),
});
const keys = km.map((b) => b.key);

// THE load-bearing assertion: cells.js owns Mod-Shift-- for "split cell". If a
// future edit binds it here, cell splitting dies silently.
eq('Mod-Shift-- NOT bound', keys.includes('Mod-Shift--'), false);
eq('Mod-- bound (shift-less zoom out)', keys.includes('Mod--'), true);
// JP keyboards reach `=` only via Shift, so all three zoom-in aliases must exist.
eq('Mod-= bound', keys.includes('Mod-='), true);
eq('Mod-Shift-= bound', keys.includes('Mod-Shift-='), true);
eq('Mod-+ bound', keys.includes('Mod-+'), true);
eq('Mod-0 bound', keys.includes('Mod-0'), true);
eq('no duplicate keys', keys.length, new Set(keys).size);
eq('all preventDefault', km.every((b) => b.preventDefault === true), true);
eq('all return true', km.every((b) => b.run() === true), true);
eq('callbacks routed', hits, ['in', 'in', 'in', 'out', 'reset']);
// Nothing may collide with the editor's other modifier bindings.
const TAKEN = ['Mod-s', 'Mod-Alt-t', 'Mod-Alt-h', 'Mod-Alt-n', 'Mod-Alt-c',
               'Mod-Alt-x', 'Mod-Shift-v', 'Mod-Shift--', 'Mod-Enter',
               'Shift-Enter', 'Alt-Enter', 'Shift-Tab'];
eq('no collision with existing binds',
   keys.filter((k) => TAKEN.includes(k)), []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

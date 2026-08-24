// Pure-logic tests for keyLayout.js. Run with:  node keyLayout.test.mjs
//
// The centrepiece is the round trip through parseLangmapMirror() below: the
// table contains `,` and `;` on both sides, so an escaping mistake produces a
// string upstream silently parses into a DIFFERENT keymap (malformed parts are
// skipped without any error), which no amount of table-shape checking catches.

import {
  KEY_LAYOUTS, DEFAULT_KEY_LAYOUT, keyLayoutKeys,
  buildLangmap, layoutMap, mapCommandKey, applyKeyLayout,
} from './keyLayout.js';

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// Mirror of @replit/codemirror-vim's parseLangmap (dist/index.js:1283-1307).
// KEEP IN SYNC with the installed package — same convention as
// isParagraphLine / __isMdParagraphLine. Verbatim apart from the name.
// ---------------------------------------------------------------------------
function parseLangmapMirror(langmapString) {
  let keymap = {};
  if (!langmapString) return { keymap, string: '' };
  function getEscaped(list) {
    return list.split(/\\?(.)/).filter(Boolean);
  }
  langmapString.split(/((?:[^\\,]|\\.)+),/).map(part => {
    if (!part) return;
    const semicolon = part.split(/((?:[^\\;]|\\.)+);/);
    if (semicolon.length == 3) {
      const from = getEscaped(semicolon[1]);
      const to = getEscaped(semicolon[2]);
      if (from.length !== to.length) return;
      for (let i = 0; i < from.length; ++i) keymap[from[i]] = to[i];
    } else if (semicolon.length == 1) {
      const pairs = getEscaped(part);
      if (pairs.length % 2 !== 0) return;
      for (let i = 0; i < pairs.length; i += 2) keymap[pairs[i]] = pairs[i + 1];
    }
  });
  return { keymap, string: langmapString };
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------
ok(keyLayoutKeys().includes('qwerty'), 'registry has qwerty');
ok(keyLayoutKeys().includes('dvorak'), 'registry has dvorak');
eq(DEFAULT_KEY_LAYOUT, 'qwerty', 'default layout is the off switch');
eq(KEY_LAYOUTS.qwerty.pairs, null, 'qwerty is the off switch, not a table');
eq(layoutMap('qwerty'), null, 'layoutMap(qwerty) is null');
eq(layoutMap('nonsense'), null, 'unknown layout yields no map');

const pairs = KEY_LAYOUTS.dvorak.pairs;

// ---------------------------------------------------------------------------
// Table is a bijection, and shifted mirrors unshifted
// ---------------------------------------------------------------------------
{
  const froms = pairs.map(p => p[0]);
  const tos = pairs.map(p => p[1]);
  eq(new Set(froms).size, froms.length, 'no duplicate source characters');
  eq(new Set(tos).size, tos.length, 'no duplicate target characters');
  for (const [from, to] of pairs) {
    ok(from.length === 1 && to.length === 1, `pair ${from}->${to} is char->char`);
    ok(from !== to, `identity pair ${from}->${to} omitted from the table`);
  }
}

// Shift pairing: every unshifted entry must have a shifted counterpart at the
// same physical position, so a Shift-held command lands where its bare form
// does. `.toUpperCase()` is not the shift partner for punctuation (`;` -> `:`),
// so the QWERTY shift row is spelled out — which pins the punctuation targets
// as a side effect.
{
  const QWERTY_SHIFT = {
    ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
    '-': '_', '=': '+', '[': '{', ']': '}',
  };
  const shiftOf = (ch) => (/^[a-z]$/.test(ch) ? ch.toUpperCase() : QWERTY_SHIFT[ch]);

  const map = layoutMap('dvorak');
  let checked = 0;
  for (const [from, to] of pairs) {
    const shiftedFrom = shiftOf(from);
    const shiftedTo = shiftOf(to);
    // Only the lower half drives this sweep; the upper half is its image.
    if (shiftedFrom === undefined || shiftedTo === undefined) continue;
    if (!pairs.some(p => p[0] === from && /^[a-z'",.\-=/;[\]]$/.test(from))) continue;
    ok(map[shiftedFrom] !== undefined, `shifted counterpart exists for ${from}`);
    eq(map[shiftedFrom], shiftedTo, `${shiftedFrom} maps like ${from}`);
    checked++;
  }
  eq(checked, pairs.length / 2, 'every unshifted entry has a shifted twin');
}

// ---------------------------------------------------------------------------
// Spot checks: the keys this feature exists for
// ---------------------------------------------------------------------------
{
  const m = layoutMap('dvorak');
  // hjkl — the whole point.
  eq(m['d'], 'h', 'Dvorak d sits at QWERTY h');
  eq(m['h'], 'j', 'Dvorak h sits at QWERTY j');
  eq(m['t'], 'k', 'Dvorak t sits at QWERTY k');
  eq(m['n'], 'l', 'Dvorak n sits at QWERTY l');
  // Common operators / motions.
  eq(m['e'], 'd', 'delete operator');
  eq(m['j'], 'c', 'change operator');
  eq(m['f'], 'y', 'yank operator');
  eq(m['c'], 'i', 'insert');
  eq(m['u'], 'f', 'find-char');
  eq(m['i'], 'g', 'g prefix');
  eq(m['.'], 'e', 'word-end motion');
  eq(m[','], 'w', 'word motion');
  eq(m['x'], 'b', 'back-word motion');
  eq(m["'"], 'q', 'macro record');
  // Getting INTO the ex line / search is itself a command, so it moves too.
  eq(m['S'], ':', 'ex prompt is at the QWERTY ; position');
  eq(m['z'], '/', 'search is at the QWERTY / position');
  // Repo-specific two-key mappings must be reachable: ]] / [[.
  eq(m['='], ']', 'next-heading bracket');
  eq(m['/'], '[', 'prev-heading bracket');
  // `a` and `m` are identity and must be absent (append / set-mark keep working
  // without an entry).
  eq(m['a'], undefined, 'a is identity');
  eq(m['m'], undefined, 'm is identity');
}

// ---------------------------------------------------------------------------
// buildLangmap escaping + the round trip through upstream's parser
// ---------------------------------------------------------------------------
{
  eq(buildLangmap(null), '', 'null pairs yield the empty langmap');
  eq(buildLangmap([]), '', 'empty pairs yield the empty langmap');

  eq(buildLangmap([[',', 'w']]), '\\,w', 'comma source is escaped');
  eq(buildLangmap([['s', ';']]), 's\\;', 'semicolon target is escaped');
  eq(buildLangmap([[';', 'z']]), '\\;z', 'semicolon source is escaped');
  eq(buildLangmap([['\\', 'x']]), '\\\\x', 'backslash source is escaped');
  eq(buildLangmap([['h', 'j']]), 'hj', 'ordinary pair is left bare');

  const str = buildLangmap(pairs);
  ok(!/(^|[^\\]),/.test(str), 'no unescaped comma survives in the langmap string');
  ok(!/(^|[^\\]);/.test(str), 'no unescaped semicolon survives in the langmap string');

  // The real assertion: upstream's parser must reproduce the table exactly.
  const parsed = parseLangmapMirror(str).keymap;
  const expected = layoutMap('dvorak');
  eq(Object.keys(parsed).length, pairs.length,
     'parser recovers exactly as many entries as the table has');
  for (const [from, to] of pairs) {
    eq(parsed[from], to, `parser round-trips ${from} -> ${to}`);
  }
  // And nothing extra leaked in (an escaping bug typically invents entries).
  for (const k of Object.keys(parsed)) {
    ok(expected[k] !== undefined, `parser invented no entry for ${JSON.stringify(k)}`);
  }
}

// ---------------------------------------------------------------------------
// mapCommandKey / applyKeyLayout
// ---------------------------------------------------------------------------
{
  // Fake Vim singleton recording what it was handed.
  const calls = [];
  const fakeVim = {
    vimKeyFromEvent: (e, vim) => ({ e, vim }),
    langmap: (str, remapCtrl) => calls.push({ str, remapCtrl }),
  };

  // Default state: identity before any apply.
  eq(mapCommandKey('h'), 'h', 'identity before a layout is applied');

  eq(applyKeyLayout(fakeVim, 'dvorak'), 'dvorak', 'applyKeyLayout returns the resolved name');
  eq(calls.length, 1, 'langmap called once');
  eq(calls[0].str, buildLangmap(pairs), 'langmap got the built string');
  eq(calls[0].remapCtrl, false, 'remapCtrl is false so <C-x> combos are left alone');
  eq(mapCommandKey('h'), 'j', 'mapCommandKey translates under dvorak');
  eq(mapCommandKey('a'), 'a', 'mapCommandKey leaves identity chars alone');
  eq(mapCommandKey('Escape'), 'Escape', 'named keys are never translated');
  eq(mapCommandKey('5'), '5', 'digits are never translated');

  // The insert-mode bypass: the wrapper must drop `vim` in insert mode only.
  const wrapped = fakeVim.vimKeyFromEvent;
  ok(wrapped !== undefined, 'vimKeyFromEvent still present after wrapping');
  eq(wrapped({}, { insertMode: true }).vim, undefined, 'insert mode drops the vim arg');
  const normalVim = { insertMode: false };
  eq(wrapped({}, normalVim).vim, normalVim, 'command mode keeps the vim arg');
  eq(wrapped({}, undefined).vim, undefined, 'a missing vim arg stays missing');

  // Wrapping is installed once, not per apply.
  applyKeyLayout(fakeVim, 'dvorak');
  eq(fakeVim.vimKeyFromEvent, wrapped, 'the bypass wrapper is installed only once');

  eq(applyKeyLayout(fakeVim, 'qwerty'), 'qwerty', 'switching back to qwerty');
  eq(calls[calls.length - 1].str, '', 'qwerty clears the langmap');
  eq(mapCommandKey('h'), 'h', 'mapCommandKey is identity again under qwerty');

  eq(applyKeyLayout(fakeVim, 'bogus'), 'qwerty', 'unknown layout falls back to the default');

  // Must not throw when Vim is unavailable (the try/catch-free boot path).
  eq(applyKeyLayout(null, 'dvorak'), 'dvorak', 'tolerates a missing Vim');
  eq(mapCommandKey('h'), 'j', 'the map is still updated without Vim');
  applyKeyLayout(null, 'qwerty');
}

console.log(failures === 0
  ? `keyLayout.test.mjs: all ${checks} assertions passed`
  : `keyLayout.test.mjs: ${failures} of ${checks} assertions FAILED`);
process.exit(failures === 0 ? 0 : 1);

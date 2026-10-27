// YaTeX-style math input assist for CodeMirror 6.
//
// Only fires inside math context ($...$, $$...$$, \(...\), \[...\], or
// \begin{...}...\end{...}).
// Outside math: the same keys behave normally.

import { EditorSelection, EditorState } from '@codemirror/state';

// Detect whether `pos` lies inside an inline ($) or display ($$) math span,
// or inside a LaTeX \begin{...}...\end{...} block on the current document.
// Counts `$` runs up to `pos`, skipping escaped `\$` and code fences.
export function isInsideMath(state, pos) {
  const text = state.doc.sliceString(0, pos);
  // Strip fenced code blocks (```...```) and inline code (`...`) — math inside
  // them is literal text.
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');

  // Count $$ pairs first (greedy non-overlap).
  let display = 0;
  let s = stripped;
  s = s.replace(/\\\$/g, ' '); // mask escaped
  const dispMatches = s.match(/\$\$/g);
  if (dispMatches) display = dispMatches.length;
  if (display % 2 === 1) return 'display';

  // After removing $$ pairs, count single $.
  const afterDisp = s.replace(/\$\$[\s\S]*?\$\$/g, '');
  const inlineMatches = afterDisp.match(/\$/g);
  if (inlineMatches && inlineMatches.length % 2 === 1) return 'inline';

  // LaTeX-style \( … \) and \[ … \], on the preview's terms (TEX_*_MATH_RE in
  // assets/index.html): `\[` opens only at line start, `\(` never after a
  // backslash (`\\(`), and an inline span cannot cross a newline.
  let tex = null;
  const texRe = /(?<!\\)\\([()[\]])|\n/g;
  let tm;
  while ((tm = texRe.exec(s)) !== null) {
    const d = tm[1];
    if (d === undefined) { if (tex === 'tex-inline') tex = null; }
    else if (d === '(' && tex === null) tex = 'tex-inline';
    else if (d === ')' && tex === 'tex-inline') tex = null;
    else if (d === '[' && tex === null
      && /^[ \t>]*$/.test(s.slice(s.lastIndexOf('\n', tm.index - 1) + 1, tm.index))) tex = 'tex-display';
    else if (d === ']' && tex === 'tex-display') tex = null;
  }
  if (tex) return tex;

  // \begin{...}...\end{...} environments
  let envDepth = 0;
  const envRe = /\\(begin|end)\{[^}]+\}/g;
  let m;
  while ((m = envRe.exec(stripped)) !== null) {
    if (m[1] === 'begin') envDepth++;
    else envDepth = Math.max(0, envDepth - 1);
  }
  if (envDepth > 0) return 'env';

  return null;
}

// Single Tab handler with multiple triggers, all gated by context.
function tabHandler(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos);

  // (1) "$<Tab>" outside math → expand to "$|$"
  if (before.endsWith('$') && !before.endsWith('$$')) {
    const ctx = isInsideMath(state, pos - 1);
    if (ctx === null) {
      view.dispatch({
        changes: { from: pos, insert: '$' },
        selection: EditorSelection.cursor(pos),
      });
      return true;
    }
  }

  // (2) "$$<Tab>" outside math → expand to "$$\n|\n$$"
  if (before.endsWith('$$')) {
    const ctx = isInsideMath(state, pos - 2);
    if (ctx === null) {
      const insert = '\n\n$$';
      view.dispatch({
        changes: { from: pos, insert },
        selection: EditorSelection.cursor(pos + 1),
      });
      return true;
    }
  }

  // (3) "\begin{name}<Tab>" anywhere → insert matching \end{name}
  const beginMatch = /\\begin\{([a-zA-Z*]+)\}\s*$/.exec(before);
  if (beginMatch) {
    const name = beginMatch[1];
    const insert = `\n\n\\end{${name}}`;
    view.dispatch({
      changes: { from: pos, insert },
      selection: EditorSelection.cursor(pos + 1),
    });
    return true;
  }

  // (4) Math context: common command stubs via prefix completion.
  const ctx = isInsideMath(state, pos);
  if (ctx) {
    // Recognize partial commands like "\fra<Tab>" → "\frac{|}{}"
    const cmdMatch = /\\([a-zA-Z]+)$/.exec(before);
    if (cmdMatch) {
      const cmd = cmdMatch[1];
      const expansions = {
        frac: { tail: '{}{}', caret: 1 },
        sqrt: { tail: '{}', caret: 1 },
        sum: { tail: '_{}^{}', caret: 2 },
        int: { tail: '_{}^{}', caret: 2 },
        prod: { tail: '_{}^{}', caret: 2 },
        lim: { tail: '_{}', caret: 2 },
        bar: { tail: '{}', caret: 1 },
        hat: { tail: '{}', caret: 1 },
        vec: { tail: '{}', caret: 1 },
        dot: { tail: '{}', caret: 1 },
        tilde: { tail: '{}', caret: 1 },
        overline: { tail: '{}', caret: 1 },
        underline: { tail: '{}', caret: 1 },
        mathbb: { tail: '{}', caret: 1 },
        mathcal: { tail: '{}', caret: 1 },
        mathrm: { tail: '{}', caret: 1 },
        mathbf: { tail: '{}', caret: 1 },
        boldsymbol: { tail: '{}', caret: 1 },
        text: { tail: '{}', caret: 1 },
        begin: { tail: '{}', caret: 1 },
        end: { tail: '{}', caret: 1 },
      };
      const e = expansions[cmd];
      if (e) {
        view.dispatch({
          changes: { from: pos, insert: e.tail },
          selection: EditorSelection.cursor(pos + e.caret),
        });
        return true;
      }
    }
  }

  return false;
}

// YaTeX-style greek shortcuts inside inline math: typing "a." → "\alpha",
// "b." → "\beta", etc. Triggered on '.' immediately after a single letter.
const greekMap = {
  a: 'alpha', b: 'beta', g: 'gamma', d: 'delta', e: 'epsilon',
  z: 'zeta', h: 'eta', q: 'theta', i: 'iota', k: 'kappa',
  l: 'lambda', m: 'mu', n: 'nu', x: 'xi', o: 'omicron',
  p: 'pi', r: 'rho', s: 'sigma', t: 'tau', u: 'upsilon',
  f: 'phi', c: 'chi', y: 'psi', w: 'omega',
};
function greekDotHandler(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (pos < 1) return false;
  const ctx = isInsideMath(state, pos);
  if (!ctx) return false;
  const prevChar = state.doc.sliceString(pos - 1, pos);
  if (!/[a-z]/.test(prevChar)) return false;
  const prevPrev = pos >= 2 ? state.doc.sliceString(pos - 2, pos - 1) : ' ';
  // Don't intercept if part of a longer word.
  if (/[a-zA-Z]/.test(prevPrev)) return false;
  const name = greekMap[prevChar];
  if (!name) return false;
  view.dispatch({
    changes: { from: pos - 1, to: pos, insert: '\\' + name },
    selection: EditorSelection.cursor(pos - 1 + 1 + name.length),
  });
  return true;
}

// Backspace between a matching `\left<open>` and `\right<closer>` in math
// context removes both tokens at once (the `deleteBracketPair` idea, applied to
// the two-token LaTeX form), so an unwanted auto-pair is undone in one keystroke.
// Falls through to the normal Backspace anywhere else.
function leftRightBackspace(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;

  const before = state.doc.sliceString(Math.max(0, pos - LEFT_RIGHT_MAX_TOKEN), pos);
  const after = state.doc.sliceString(pos, Math.min(state.doc.length, pos + LEFT_RIGHT_MAX_TOKEN));

  for (const [open, close] of LEFT_RIGHT_PAIRS) {
    const openTok = '\\left' + open;
    const closeTok = '\\right' + close;
    if (!before.endsWith(openTok) || !after.startsWith(closeTok)) continue;
    if (!isInsideMath(state, pos)) return false;
    view.dispatch({
      changes: { from: pos - openTok.length, to: pos + closeTok.length, insert: '' },
      selection: EditorSelection.cursor(pos - openTok.length),
      userEvent: 'delete.backward',
    });
    return true;
  }
  return false;
}

export function mathInputAssistKeymap() {
  return [
    { key: 'Tab', run: tabHandler },
    { key: '.', run: greekDotHandler },
    { key: 'Backspace', run: leftRightBackspace },
  ];
}

// Auto-insert matching `\right<closer>` when the user types `\left<delim>`
// inside math context. KaTeX-supported delimiter list, sorted long-first so
// `\langle` wins over `<` and `\|` wins over `|` when both could match.
const LEFT_RIGHT_PAIRS = [
  ['\\lmoustache', '\\rmoustache'],
  ['\\backslash', '/'],
  ['\\langle', '\\rangle'],
  ['\\lfloor', '\\rfloor'],
  ['\\lgroup', '\\rgroup'],
  ['\\lceil', '\\rceil'],
  ['\\{', '\\}'],
  ['\\|', '\\|'],
  ['(', ')'],
  ['[', ']'],
  ['|', '|'],
  ['<', '>'],
  ['/', '\\backslash'],
  ['.', '.'], // null delimiter for one-sided forms
];

// Longest `\left<open>` / `\right<close>` token, used to bound the lookaround
// slices when matching a pair around the cursor.
const LEFT_RIGHT_MAX_TOKEN = 20;

// `\left` / `\right` occurrences. The negative lookahead keeps `\leftarrow` and
// `\rightarrow` (and friends) from being counted as delimiter tokens — a real
// delimiter is never a letter.
const LEFT_RIGHT_TOKEN_SRC = '\\\\(left|right)(?![a-zA-Z])';

// How far ahead to scan for an existing partner before giving up.
const MATH_SCAN_MAX = 4000;

// End of the math region enclosing `pos`, given the kind isInsideMath() returned.
function mathRegionEnd(state, pos, kind) {
  const max = Math.min(state.doc.length, pos + MATH_SCAN_MAX);
  const rest = state.doc.sliceString(pos, max);
  let idx = -1;
  if (kind === 'display') {
    idx = rest.indexOf('$$');
  } else if (kind === 'inline') {
    // First `$` that isn't escaped as `\$`.
    for (let i = rest.indexOf('$'); i >= 0; i = rest.indexOf('$', i + 1)) {
      if (i === 0 || rest[i - 1] !== '\\') { idx = i; break; }
    }
  } else if (kind === 'tex-display') {
    idx = rest.indexOf('\\]');
  } else if (kind === 'tex-inline') {
    idx = rest.indexOf('\\)');
  } else if (kind === 'env') {
    idx = rest.indexOf('\\end{');
  }
  return idx >= 0 ? pos + idx : max;
}

// Whether a `\right` that has no `\left` of its own already waits ahead of the
// cursor — i.e. the `\left` just typed has a partner and needs no new one.
function hasUnmatchedRightAhead(state, pos, kind) {
  const ahead = state.doc.sliceString(pos, mathRegionEnd(state, pos, kind));
  const re = new RegExp(LEFT_RIGHT_TOKEN_SRC, 'g');
  let depth = 0;
  let m;
  while ((m = re.exec(ahead)) !== null) {
    if (m[1] === 'left') depth++;
    else if (depth === 0) return true;
    else depth--;
  }
  return false;
}

export function leftRightAutoPair() {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!tr.isUserEvent('input.type')) return tr;

    const state = tr.state;
    const sel = state.selection.main;
    if (sel.from !== sel.to) return tr;
    const pos = sel.head;

    // Require this transaction to be a single pure insertion ending exactly at
    // the cursor. Matching on "the text before the cursor happens to end with
    // `\left(`" is not enough: @replit/codemirror-vim routes *every* edit it
    // makes — deletions included — through an `input.type.compose` transaction,
    // so deleting an auto-inserted `\right)` would land the cursor right after
    // `\left(` and immediately re-insert it. (Vim INSERT-mode typing does not
    // go through that adapter, so ordinary typing still reaches us here.)
    let inserted = false;
    let changeCount = 0;
    tr.changes.iterChanges((fromA, toA, fromB, toB, ins) => {
      changeCount++;
      if (fromA === toA && ins.length > 0 && toB === pos) inserted = true;
    });
    if (changeCount !== 1 || !inserted) return tr;

    const before = state.doc.sliceString(Math.max(0, pos - LEFT_RIGHT_MAX_TOKEN), pos);

    let closer = null;
    for (const [open, close] of LEFT_RIGHT_PAIRS) {
      if (before.endsWith('\\left' + open)) { closer = close; break; }
    }
    if (closer === null) return tr;

    const kind = isInsideMath(state, pos);
    if (!kind) return tr;

    // Don't add a second closer when this `\left` already has a partner — the
    // `\right` need not be adjacent (`\left(|x + y\right)` when the opener of an
    // existing pair is retyped).
    if (hasUnmatchedRightAhead(state, pos, kind)) return tr;

    return [
      tr,
      {
        changes: { from: pos, insert: '\\right' + closer },
        selection: EditorSelection.cursor(pos),
        sequential: true,
      },
    ];
  });
}

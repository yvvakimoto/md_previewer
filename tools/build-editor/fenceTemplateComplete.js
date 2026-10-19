// Code-fence template completion for the figure / diagram fences.
//
// Typing ``` (or ~~~) at the start of a line offers the fence languages the
// preview renders specially; picking one inserts the language, a minimal
// working body and the matching closing fence, parking the cursor at the first
// thing the user has to fill in. Same shape as fencedDivComplete.js (one
// dispatch from a custom `apply`).
//
// The templates are derived from samples/*.md — keep them renderable. Bodies are
// syntax, not copy, so they are NOT translated; only `detail` is (#15).
//
// Also exports fenceInfoAt(), which pathComplete.js uses to complete the
// `file:` / `mtl:` paths inside plotly / model3d fences.

import { startCompletion } from '@codemirror/autocomplete';
import { t } from './i18n.js';

// Cursor marker inside a template body; stripped on insert.
const CARET = '‸';

// `path: true` re-opens the completion popup right after insertion, so the
// path source (pathComplete.js) lists candidate files for `file: ` at once.
const TEMPLATES = [
  { lang: 'mermaid',     body: `flowchart LR\n  A[${CARET}] --> B` },
  { lang: 'plotly',      body: `file: ${CARET}\ntype: line\nx: \ny: `, path: true },
  { lang: 'model3d',     body: `file: ${CARET}`, path: true },
  { lang: 'csv',         body: `${CARET}Name,Value\nA,1\nB,2` },
  { lang: 'tsv',         body: `${CARET}Name\tValue\nA\t1\nB\t2` },
  { lang: 'abc',         body: `X:1\nT:${CARET}\nM:4/4\nL:1/4\nK:C\nC D E F | G2 G2 |` },
  { lang: 'markwhen',    body: `# ${CARET}\n2025-01-01 / 2025-03-31: Phase 1\n2025-04-01: Milestone` },
  { lang: 'tikz',        body: `\\begin{tikzpicture}\n  ${CARET}\\draw[->] (0,0) -- (2,0) node[right]{$x$};\n\\end{tikzpicture}` },
  { lang: 'tikzcd',      body: `${CARET}A \\arrow[r, "f"] & B` },
  { lang: 'kataskeve',   body: `viewport: -1 -1 6 5\nA = point(0, 0)\nB = point(5, 0)\nC = point(2, 4)\ntriangle(A, B, C)${CARET}` },
  { lang: 'kataskeve3d', body: `view: tilt=26 yaw=32\nunit: 90\ncube(point(0,0,0), 2)${CARET}` },
  { lang: 'feynman',     body: `diagram {\n  in a: $e^-$; out b: $e^-$\n  a -- [fermion${CARET}] b\n}` },
];

const OPENER_RE = /^( {0,3})(`{3,}|~{3,})([A-Za-z0-9_+-]*)$/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FM_OPEN_RE = /^---[ \t]*$/;

// Walk lines 1..lineNumber-1 and return the code fence still open at the start
// of `lineNumber`, as { char, len, lang, openLine }, or null. Skips a leading
// YAML front-matter block (its lines are never fences). CommonMark closing rule:
// same character, at least as long, and no info string.
function openFenceBefore(state, lineNumber) {
  let i = 1;
  if (state.doc.lines >= 1 && FM_OPEN_RE.test(state.doc.line(1).text)) {
    for (let j = 2; j < lineNumber; j++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(state.doc.line(j).text)) { i = j + 1; break; }
    }
  }
  let open = null;
  for (; i < lineNumber; i++) {
    const m = FENCE_LINE_RE.exec(state.doc.line(i).text);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    const info = m[2].trim();
    if (!open) {
      if (char === '`' && info.includes('`')) continue; // not a fence
      open = { char, len, lang: (info.split(/\s+/)[0] || '').toLowerCase(), openLine: i };
    } else if (char === open.char && len >= open.len && info === '') {
      open = null;
    }
  }
  return open;
}

// The code fence enclosing `pos` (the cursor line is a body line of it), or null.
export function fenceInfoAt(state, pos) {
  const line = state.doc.lineAt(pos);
  return openFenceBefore(state, line.number);
}

// True when the opener on `lineNumber` already has its closing fence: the
// fence-like lines below it then pair up with one left over (odd count). A
// brand-new opener leaves an even number (0, or complete blocks below).
function hasCloserBelow(state, lineNumber) {
  let n = 0;
  for (let i = lineNumber + 1; i <= state.doc.lines; i++) {
    if (FENCE_LINE_RE.test(state.doc.line(i).text)) n++;
  }
  return n % 2 === 1;
}

// Insert `<lang>\n<body>\n<fence>` over from..to, caret at the marker.
function applyBody(view, from, to, lang, rawBody, fence, reopen) {
  const caret = rawBody.indexOf(CARET);
  const body = rawBody.replace(CARET, '');
  const insert = `${lang}\n${body}\n${fence}`;
  const anchor = from + lang.length + 1 + (caret < 0 ? body.length : caret);
  view.dispatch({ changes: { from, to, insert }, selection: { anchor }, scrollIntoView: true });
  if (reopen) setTimeout(() => startCompletion(view), 0);
}

// Pure core of the source, exported for templates.test.mjs. Returns null when
// nothing should be offered, else { from, fence, partial, langs } where `langs`
// is the ordered list of offered entries ('' = the plain code block).
//
// ⚠ Prefix matching, never CodeMirror's fuzzy filter: Enter accepts the top
// entry, and fuzzy matching would turn ```py into `plotly` and ```ts into `tsv`.
// So the TOP entry is always the plain block carrying exactly what was typed
// (unless that is itself a template name), and a partial that prefixes no
// template yields no popup at all — Enter is then an ordinary newline.
export function fenceTemplateContext(state, pos) {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;
  const m = OPENER_RE.exec(line.text);
  if (!m) return null;
  // Inside an open block this line is content or the closing fence — never offer.
  if (openFenceBefore(state, line.number)) return null;
  // Editing the opener of a block that is already closed: inserting another
  // closing fence would break the document.
  if (hasCloserBelow(state, line.number)) return null;
  const partial = m[3];
  const lower = partial.toLowerCase();
  const hits = TEMPLATES.filter((x) => x.lang.startsWith(lower)).map((x) => x.lang);
  if (partial && !hits.length) return null;
  const langs = hits.includes(lower) ? [lower, ...hits.filter((l) => l !== lower)] : ['', ...hits];
  return { from: pos - partial.length, fence: m[1] + m[2], partial, langs };
}

export const FENCE_TEMPLATE_LANGS = TEMPLATES.map((x) => x.lang);

export function fenceTemplateCompletionSource(context) {
  const ctx = fenceTemplateContext(context.state, context.pos);
  if (!ctx) return null;
  const options = ctx.langs.map((lang, i) => {
    if (lang === '') {
      return {
        label: ctx.partial || '```',
        type: 'text',
        detail: t('ed.complete.fence.plain'),
        boost: 99 - i,
        apply: (view, _c, from, to) => applyBody(view, from, to, ctx.partial, CARET, ctx.fence, false),
      };
    }
    const tpl = TEMPLATES.find((x) => x.lang === lang);
    return {
      label: lang,
      type: 'keyword',
      detail: t('ed.complete.fence.' + lang),
      boost: 99 - i,
      apply: (view, _c, from, to) => applyBody(view, from, to, lang, tpl.body, ctx.fence, !!tpl.path),
    };
  });
  // filter:false + no validFor: the source re-runs on every keystroke and owns
  // both the matching and the order (see fenceTemplateContext).
  return { from: ctx.from, to: context.pos, options, filter: false };
}

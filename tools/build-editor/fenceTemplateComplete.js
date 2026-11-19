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
//
// Each body lists EVERY option its engine accepts: the active lines render as
// inserted, the optional ones are commented out in that engine's own comment
// syntax. ⚠ The comment syntax and line-order rules differ per engine and are
// load-bearing — see editor-autocomplete.md before editing a body (e.g.
// kataskeve's `#` must be followed by a space, or `#a…` parses as a hex colour;
// a tikzcd matrix must contain no blank line; plotly/model3d keep `file:` first
// for path completion; linkcard comments only below the URL line).
const lines = (...xs) => xs.join('\n');
const C = CARET;

const TEMPLATES = [
  { lang: 'mermaid', body: lines(
    '%% scale: 1.5',
    '%% other types: sequenceDiagram | classDiagram | stateDiagram-v2 | erDiagram | gantt | pie | mindmap | timeline',
    '%% theme / config: a YAML front-matter block (--- config: ... ---) above this line',
    'flowchart LR',
    `  A[${C}Start] --> B(Round)`,
    '  B --> C{Decision}',
    '  C -->|Yes| D[(Database)]',
    '  C -.->|No| E((Circle))',
    '  D ==> F>Flag]',
    '  subgraph G [Group]',
    '    E --- F',
    '  end',
    '  classDef hl fill:#fde68a,stroke:#b45309',
    '  class C hl',
  ) },
  { lang: 'plotly', path: true, body: lines(
    `file: ${C}`,
    'type: line            # line | scatter | bar | histogram | box | heatmap | surface',
    'x: ',
    'y: ',
    '# y: [col1, col2]     # several series',
    '# names: [A, B]       # legend names, paired with the y list',
    '# mode: lines+markers # scatter only',
    '# title: ',
    '# delimiter: tab      # default: by extension (.tsv = tab)',
    '# colorscale: Viridis # heatmap / surface',
    '# layout:',
    '#   height: 400',
    '#   xaxis: { title: { text: X } }',
    '# config:',
    '#   displayModeBar: false',
    '# traces:             # replaces type / x / y',
    '#   - { type: scatter, mode: lines, x: col1, y: col2, name: A }',
  ) },
  { lang: 'model3d', path: true, body: lines(
    `file: ${C}`,
    '# format: stl         # stl | obj | ply | gltf | glb | 3mf (default: by extension)',
    '# mtl:                # OBJ material file',
    '# width: 680          # 80-1024 px',
    '# height: 460         # 80-1024 px',
    '# color: "#8b9bb0"    # quote colours: a bare # starts a comment',
    '# edgeColor: "#333333"',
    '# gridColor: "#c8ccd4"',
    '# background: "#ffffff"  # default: transparent',
    '# edges: false',
    '# wireframe: false',
    '# grid: false',
    '# axes: false',
    '# camera:',
    '#   azimuth: 35',
    '#   elevation: 22',
    '#   distance: 3       # x bounding radius (default: auto fit)',
  ) },
  { lang: 'csv', body: lines(
    `${C}Name,Value,Note`,
    'A,1,plain',
    'B,2,"quoted, with comma"',
    'C,3,"escaped ""quote"""',
  ) },
  { lang: 'tsv', body: lines(
    `${C}Name\tValue\tNote`,
    'A\t1\tplain',
    'B\t2\tno quoting in TSV',
  ) },
  { lang: 'abc', body: lines(
    'X:1',
    `T:${C}`,
    '%C: composer',
    '%O: origin',
    '%R: reel',
    '%N: notes',
    'M:4/4',
    'L:1/8',
    'Q:1/4=120',
    '%V:1 clef=treble     % multi-voice: V:1 / V:2 ...',
    'K:C',
    '% "chord" accidentals ^ _ = ; length 2 /2 ; rest z ; tie - ; slur ( )',
    '|: "C"C2 E2 G2 c2 | "F"A2 ^F2 G4- | "G"G2 (FE) D2 z2 | "C"C8 :|',
    'w: do mi sol do la fa sol * fa mi re do  % one syllable per note; * skips a note',
  ) },
  { lang: 'markwhen', body: lines(
    '---',
    `title: ${C}`,
    '// display: calendar',
    '// country: JP',
    '// legend: false',
    '#done: green',
    '#todo: orange',
    '---',
    '',
    '# Section',
    '2025-01-01 / 2025-03-31: Phase 1 #done',
    '2025-04-01: Milestone',
    '',
    '## Group',
    '2025-04-15 / 2025-06-30: Phase 2 #todo',
    '// a comment line',
  ) },
  { lang: 'tikz', body: lines(
    '% scale: 1.6',
    '\\begin{tikzpicture}[box/.style={draw, rounded corners, fill=blue!10}]',
    `  ${C}\\draw[->, thick] (0,0) -- (3,0) node[right]{$x$};`,
    '  \\draw[->, thick] (0,0) -- (0,2) node[above]{$y$};',
    '  \\draw[red, dashed] (0,0) circle (1);',
    '  \\fill[blue] (1,1) circle (2pt);',
    '  \\node[box] at (2,1.5) {点 P};',
    '  \\foreach \\i in {1,2} { \\draw (\\i,0.1) -- (\\i,-0.1) node[below]{$\\i$}; }',
    '\\end{tikzpicture}',
  ) },
  { lang: 'tikzcd', body: lines(
    '% scale: 1.6',
    `${C}A \\arrow[r, "f"] \\arrow[d, "g"'] & B \\arrow[d, hook] \\\\`,
    'C \\arrow[r, dashed, "h"] \\arrow[ur, two heads] & D \\arrow[u, Rightarrow, bend right]',
  ) },
  { lang: 'kataskeve', body: lines(
    '# viewport: -1 -1 6 5   (xmin ymin xmax ymax; default: auto)',
    '# unit: 40',
    '# grid: on',
    '# axes: on',
    `A = point(0, 0)${C}`,
    'B = point(5, 0)',
    'C = point(2, 4)',
    'triangle(A, B, C) fill=#3498db22',
    'M = midpoint(A, B)',
    'H = foot(C, A, B)',
    'segment(C, H) dashed thin',
    'O = circumcenter(A, B, C)',
    'circle3(A, B, C) color=#c0392b',
    'segment(C, M) thick',
    'A; B; C; M; H; O',
    'label A "A" pos=SW',
    'label B "B" pos=SE',
    'label C "C" pos=N offset=6',
    'label O "O" pos=NE',
    'mark right_angle(C, H, B)',
    'mark angle(B, A, C) arcs=1 radius=0.6',
    'mark tick(segment(A, M)) count=1',
    'mark tick(segment(M, B)) count=1',
  ) },
  { lang: 'kataskeve3d', body: lines(
    'view: tilt=26 yaw=32',
    '# unit: 60             (setting it turns auto fit off)',
    '# projection: ortho',
    '# light: az=135 el=30',
    '# shading: on          (or a density number)',
    '# hidden_lines: dashed (off | faint | dashed)',
    '# axes: on',
    '# grid: on',
    '# width: 680',
    '# height: 460',
    `cube(point(0,0,0), 2)${C}`,
    'sphere(point(0,0,0), 1) color=#2980b9',
    'P = point(1, 1, 1)',
    'segment(point(0,0,0), P) dashed thick',
    'P',
    'label P "P" pos=NE',
  ) },
  { lang: 'linkcard', body: lines(
    `https://${C}`,
    '# title:        (default: the page\'s OGP title)',
    '# description:',
    '# image:        (local path or URL)',
    '# site:',
    '# fetch: false  (do not fetch OGP)',
  ) },
  { lang: 'feynman', body: lines(
    '% edges: plain fermion "anti fermion" scalar "charged scalar" ghost photon boson gluon double majorana graviton',
    '% edge attrs: label= label\'= momentum= arrow=forward|back|none|both bend left[=deg] half left loop=up tension= color= width=',
    '% vertex attrs: dot blob[=hatch|shade] cross square label= size=',
    'diagram tree [direction=right] {',
    `  in  e1: $e^-$${C}, e2: $e^+$`,
    '  out m1: $\\mu^-$, m2: $\\mu^+$',
    '  vertex a [dot]',
    '  e1 -- [fermion] a -- [fermion] e2',
    '  a  -- [photon, label=$\\gamma$, momentum=$q$] b',
    '  m2 -- [fermion] b -- [fermion] m1',
    '}',
    '% equation [height=5] { \\mathcal{M} = @tree + \\dots }',
  ) },
];
export { TEMPLATES };

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

// GFM pipe-table helpers for the CodeMirror 6 companion editor.
//
//   - insertTable(view, rows, cols, opts) — insert a rows x cols table template.
//     `rows` counts the HEADER row; the delimiter row is structural and never
//     counted, so 3 x 4 means "header + 2 data rows, 4 columns".
//   - tableColumnHighlight()            — background-tint the cell of the
//     cursor's column in every row of the table under the cursor.
//
// Edits go through view.dispatch, so the existing modeListener flows them to the
// live preview — no IPC needed (same contract as marpSlides.js).
//
// The column resolver is SYNTAX-TREE based, not hand-rolled: under
// `markdown({ base: markdownLanguage })` (see entry.js) @lezer/markdown already
// emits Table / TableHeader / TableRow / TableDelimiter / TableCell nodes, so
// resolveInner(pos) + walking up to `Table` costs O(tree depth) with no
// document-wide scan and no fence bookkeeping (a table inside a ```md fence
// produces no Table nodes at all).
//
// Two verified parser facts drive the implementation — do not "simplify" them
// away:
//
//  1. Cell boundaries come from the row's TableDelimiter children (the pipes),
//     NOT from TableCell. An EMPTY cell emits no TableCell node, and a freshly
//     inserted template is all-empty cells, so a TableCell-based resolver would
//     fail on exactly the tables this feature creates. Pipes are always present.
//  2. Because an escaped `\|` is part of a TableCell and never becomes a
//     TableDelimiter, the pipe-derived spans are automatically escape-correct.
//     (A `|` inside a code span DOES split cells — that is GFM-spec behaviour and
//     matches what marked renders in the preview, so it must not be "fixed".)

import { EditorSelection, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

const MIN_ROWS = 1;
const MAX_ROWS = 50;
const MIN_COLS = 1;
const MAX_COLS = 20;
// Minimum dash run in the delimiter row (`---`), also the minimum column width.
const MIN_DELIM = 3;

export const TABLE_ALIGNS = ['left', 'center', 'right'];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n | 0));

// A delimiter row: every pipe-separated cell is `-`/`:-`/`-:`/`:-:` with at
// least one dash. Escapes cannot appear here, so a plain split is exact.
export function isDelimiterRow(text) {
  if (typeof text !== 'string' || text.indexOf('-') < 0) return false;
  const cells = stripOuterPipes(text).split('|');
  if (!cells.length) return false;
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

// Delimiter row -> ['left' | 'center' | 'right' | null, ...].
export function parseAlignments(text) {
  return stripOuterPipes(text).split('|').map((c) => {
    const s = c.trim();
    const l = s.startsWith(':');
    const r = s.endsWith(':');
    if (l && r) return 'center';
    if (l) return 'left';
    if (r) return 'right';
    return null;
  });
}

// Drop one leading and one trailing pipe (GFM's optional outer pipes).
function stripOuterPipes(text) {
  let s = String(text).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s;
}

function rowPipes(rowNode) {
  const pipes = [];
  for (let c = rowNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') pipes.push({ from: c.from, to: c.to });
  }
  return pipes;
}

// Cell interiors of one row node, derived from its pipes. See fact (1) above.
function rowCellSpans(rowNode) {
  const pipes = rowPipes(rowNode);
  const spans = [];
  let cur = rowNode.from;
  for (const p of pipes) {
    spans.push({ from: cur, to: p.from });
    cur = p.to;
  }
  spans.push({ from: cur, to: rowNode.to });
  // A leading / trailing pipe does not open / close a cell.
  if (pipes.length && pipes[0].from === rowNode.from) spans.shift();
  if (pipes.length && pipes[pipes.length - 1].to === rowNode.to) spans.pop();
  return spans;
}

// Enclosing Table node, or null. Side -1 is tried first so a cursor sitting just
// after a cell's text resolves into that cell; side 1 is the fallback for the
// boundary case where nothing lies to the left (notably pos 0 of a document that
// opens with a table).
function resolveTable(state, pos) {
  const tree = syntaxTree(state);
  for (const side of [-1, 1]) {
    let node = tree.resolveInner(pos, side);
    while (node && node.name !== 'Table') node = node.parent;
    if (node) return node;
  }
  return null;
}

// The Table node containing `pos`, split into its header / delimiter / body rows.
// Returns null when the cursor is not inside a table.
export function tableAt(state, pos) {
  const node = resolveTable(state, pos);
  if (!node) return null;
  const out = { from: node.from, to: node.to, header: null, delim: null, rows: [] };
  for (let c = node.node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader') out.header = c.node;
    // The delimiter ROW is a single multi-character TableDelimiter child of
    // Table; the one-character ones are the per-cell pipes inside a row.
    else if (c.name === 'TableDelimiter' && c.to - c.from > 1) out.delim = c.node;
    else if (c.name === 'TableRow') out.rows.push(c.node);
  }
  return out.header ? out : null;
}

// Spans of whichever row contains `pos`, or null. The delimiter row is one
// opaque node, so it is split textually (safe — no escapes possible there).
function spansOfRowAt(state, table, pos) {
  // A row holding no pipe at all is not a real row — it is the prose line that
  // GFM absorbs after a table. Discriminating on the pipe count (not the span
  // count) matters because a legitimate SINGLE-column row also yields one span.
  const rowSpans = (r) => (rowPipes(r).length ? rowCellSpans(r) : null);
  if (table.header && pos >= table.header.from && pos <= table.header.to) {
    return rowSpans(table.header);
  }
  for (const r of table.rows) {
    if (pos >= r.from && pos <= r.to) return rowSpans(r);
  }
  const d = table.delim;
  if (d && pos >= d.from && pos <= d.to) {
    const text = state.sliceDoc(d.from, d.to);
    const spans = [];
    let cur = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '|') continue;
      spans.push({ from: d.from + cur, to: d.from + i });
      cur = i + 1;
    }
    spans.push({ from: d.from + cur, to: d.to });
    if (text.startsWith('|')) spans.shift();
    if (text.endsWith('|')) spans.pop();
    return spans;
  }
  return null;
}

// Which column is the cursor in? -> { table, index, colCount } or null.
export function columnAt(state, pos) {
  const table = tableAt(state, pos);
  if (!table) return null;
  const spans = spansOfRowAt(state, table, pos);
  if (!spans || !spans.length) return null;
  // First span that ends at or after the cursor, else the last one. This single
  // rule covers every boundary case: sitting ON a pipe belongs to the cell to
  // its left (natural right after typing a cell), and a cursor before the
  // leading pipe lands on column 0.
  let index = spans.findIndex((s) => pos <= s.to);
  if (index < 0) index = spans.length - 1;
  const headerSpans = table.header ? rowCellSpans(table.header) : spans;
  return { table, index, colCount: headerSpans.length };
}

// ---------- emitter ----------
//
// SYNC OBLIGATION — displayWidth / escapeTableCell / the pad arithmetic below are
// a MIRROR of tblDisplayWidth / tblEscapeCell / tblPadCell / tblEmitRow in
// assets/index.html (~7941-8069, the preview's "Edit table" model). index.html is
// a monolith loaded directly by the preview WebView and cannot import an ES
// module from tools/build-editor, and the two run in separate WebView2 windows
// with no shared global — mirroring is the only option. Keep them in sync.
//
// What may legitimately differ: index.html DETECTS and reproduces the source
// table's own style (indent, optional outer pipes, padding convention) so that
// tblEmit(tblParse(x)) === x byte for byte. emitTable() always writes the
// canonical padded form, because a pasted table has no source style to preserve.
//
// What must NOT differ: the wide-character set, the escape rule, the minimum
// dash run, and the pad arithmetic.

// Display columns, not code units: these documents are mostly Japanese and
// `.length` would misalign every CJK column.
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}

// A cell can never span lines, and `|` must be escaped on the way out. Normalise
// an already-escaped `\|` first so a round trip cannot double-escape it.
export function escapeTableCell(text) {
  return String(text)
    .replace(/\r?\n/g, ' ')
    .replace(/\\\|/g, '|')
    .replace(/\|/g, '\\|')
    .trim();
}

function delimCell(align, width) {
  const l = align === 'left' || align === 'center' ? ':' : '';
  const r = align === 'right' || align === 'center' ? ':' : '';
  const dashes = Math.max(MIN_DELIM, width) - l.length - r.length;
  return l + '-'.repeat(Math.max(1, dashes)) + r;
}

const padRight = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

// Emit any cell matrix as a column-padded GFM pipe table. rows[0] is the header
// (GFM requires one); cells are RAW — escaping happens here, so a caller can
// hand over arbitrary clipboard text.
//
// opts.aligns — per-column (null|'left'|'center'|'right')
// opts.align  — applied to every column when `aligns` is absent
//
// Escaping and padding are deliberately SEPARATE steps: escapeTableCell() trims,
// so padding before escaping would collapse an intentionally blank template cell
// back to ''. Escape first, pad second.
export function emitTable(rows, opts = {}) {
  const grid = (rows || []).map((r) => (r || []).map(escapeTableCell));
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  if (!grid.length || !cols) return { text: '', widths: [], firstCellOffset: 2 };

  const uniform = TABLE_ALIGNS.indexOf(opts.align) >= 0 ? opts.align : null;
  const aligns = [];
  for (let i = 0; i < cols; i++) {
    const a = opts.aligns ? opts.aligns[i] : uniform;
    aligns.push(TABLE_ALIGNS.indexOf(a) >= 0 ? a : null);
  }

  const widths = new Array(cols).fill(MIN_DELIM);
  for (const r of grid) {
    for (let i = 0; i < r.length; i++) widths[i] = Math.max(widths[i], displayWidth(r[i]));
  }

  const row = (cells) =>
    '| ' + widths.map((w, i) => padRight(cells[i] || '', w)).join(' | ') + ' |';
  const lines = [row(grid[0]), row(widths.map((w, i) => delimCell(aligns[i], w)))];
  for (let i = 1; i < grid.length; i++) lines.push(row(grid[i]));
  // Cursor goes at the start of the first header cell's text: '| '.
  return { text: lines.join('\n'), widths, firstCellOffset: 2 };
}

// ---------- template ----------

// Column-padded template — reads correctly in the monospace editor and matches
// what people hand-write. Returns { text, firstCellOffset } so insertTable does
// not have to re-parse to place the cursor.
export function buildTableTemplate(rows, cols, opts = {}) {
  const r = clamp(rows, MIN_ROWS, MAX_ROWS);
  const c = clamp(cols, MIN_COLS, MAX_COLS);
  const heads = [];
  for (let i = 0; i < c; i++) heads.push('Header ' + (i + 1));
  const grid = [heads];
  for (let i = 1; i < r; i++) grid.push(new Array(c).fill(''));
  const { text, firstCellOffset } = emitTable(grid, { align: opts.align });
  return { text, firstCellOffset };
}

// Insert a table at the cursor. A table must be terminated by a blank line (or
// EOF) or the following prose is absorbed as a one-cell row, so a trailer is
// added when needed.
export function insertTable(view, rows, cols, opts = {}) {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const { text, firstCellOffset } = buildTableTemplate(rows, cols, opts);
  const onBlank = /^\s*$/.test(line.text);
  const at = onBlank ? line.from : line.to;
  const head = onBlank ? '' : '\n\n';
  const after = state.sliceDoc(at, Math.min(state.doc.length, at + 2));
  const trailer = at >= state.doc.length ? '\n' : after.startsWith('\n\n') ? '' : '\n';
  view.dispatch({
    changes: { from: at, insert: head + text + trailer },
    // No selection — a selected range would drop Vim into VISUAL mode, which is
    // wrong immediately after an insert.
    selection: EditorSelection.cursor(at + head.length + firstCellOffset),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

// ---------- column highlight ----------

const COL = Decoration.mark({ class: 'cm-md-table-col' });
const COL_HEAD = Decoration.mark({ class: 'cm-md-table-col-head' });

function buildDecorations(state) {
  const info = columnAt(state, state.selection.main.head);
  if (!info) return Decoration.none;
  const b = new RangeSetBuilder();
  const push = (rowNode, deco) => {
    const s = rowCellSpans(rowNode)[info.index];
    // Decoration.mark throws on an empty range — `||` produces one.
    if (s && s.to > s.from) b.add(s.from, s.to, deco);
  };
  // Header yes (it labels the column), delimiter row no (`---` has no content,
  // tinting it is pure noise). Rows are already in document order.
  if (info.table.header) push(info.table.header, COL_HEAD);
  for (const r of info.table.rows) push(r, COL);
  return b.finish();
}

// A ViewPlugin, deliberately NOT EditorView.decorations.compute(['doc','selection']):
// these decorations also depend on the SYNTAX TREE, which CodeMirror's parser
// advances asynchronously. A facet keyed only on doc+selection would not
// recompute when the parse catches up, so on a large document whose initial
// cursor jump (window.__previewScrolledTo) lands past the first parsed chunk the
// highlight would stay missing until the next keystroke. Reading state only (no
// viewport) also means rows scrolled out of view stay marked and there is no
// flicker while scrolling.
export function tableColumnHighlight() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view.state);
      }
      update(u) {
        if (
          u.docChanged ||
          u.selectionSet ||
          syntaxTree(u.startState) != syntaxTree(u.state)
        ) {
          this.decorations = buildDecorations(u.state);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Non-Vim keybindings, spread into the editor's keymap.of([...]) before the
// default keymap. Mod-Alt-t / -h don't collide with anything in @codemirror/* or
// @replit/codemirror-vim (Mod-Alt-n/c/x are marpSlides', Mod-Alt-g is
// @codemirror/search's gotoLine).
export function mdTableKeymap({ onInsert, onToggleColumn }) {
  return [
    { key: 'Mod-Alt-t', preventDefault: true, run: () => { onInsert(); return true; } },
    { key: 'Mod-Alt-h', preventDefault: true, run: () => { onToggleColumn(); return true; } },
  ];
}

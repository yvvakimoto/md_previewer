// Jupyter-style cell mode for the CodeMirror 6 companion editor.
//
// A "cell" is a `---`-delimited unit of the document — the same unit renderMarp()
// turns into a slide — so cell N is preview slide N by construction. Applies to
// every `.md`, not just Marp decks; a leading YAML front-matter block is a
// protected pseudo-cell that no operation may modify.
//
// Two modes, like Jupyter: EDIT (normal typing) and COMMAND (single-letter cell
// operations). `Esc` enters Command mode, `Enter` / `i` returns to Edit.
//
// ── The load-bearing platform facts (all verified against the installed dists;
//    if either package changes, Command mode silently loses every letter key) ──
//
// 1. The whole `keymap` facet is served by ONE DOM keydown handler registered at
//    Prec.default (@codemirror/view: `handleKeyEvents = Prec.default(
//    EditorView.domEventHandlers({keydown}))`). `Prec` on a `keymap.of()` only
//    reorders bindings INSIDE that handler.
// 2. `vim()` returns a plain, un-Prec-wrapped ViewPlugin array
//    (@replit/codemirror-vim: `[vimStyle, vimPlugin, hideNativeSelection, …]`),
//    and entry.js puts it first, so its keydown runs BEFORE the keymap facet.
// 3. In non-insert mode Vim swallows every single-character key:
//    `return !vim.insertMode && (key.length === 1 || …) ? function(){return true;}
//    : undefined` — a truthy handler, so it calls preventDefault.
//
// ⇒ `Prec.highest(keymap.of(…))` CANNOT get `j`/`k`/`a`/`b`/… ahead of Vim. The
//   only mechanism that can is `Prec.highest(EditorView.domEventHandlers(…))`,
//   which lands in the highest ViewPlugin bucket and therefore precedes
//   vimPlugin. That is what cellGate() below is.
//
//   `Esc` is the exception: Vim explicitly declines it in NORMAL ("We're already
//   in normal mode. Let '<Esc>' be handled normally.") so it would reach a keymap
//   too — but the gate handles it as well, so it can inspect pre-Vim state.
//
// Module-split convention (same as marpSlides.js / mdTable.js): pure logic,
// planners and extension factories live here; modals, the status bar, body
// classes, localStorage, Vim ex-commands and the Compartment live in entry.js.

import {
  EditorSelection,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  keymap,
} from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { completionStatus } from '@codemirror/autocomplete';
import { openSearchPanel } from '@codemirror/search';
import { getCM } from '@replit/codemirror-vim';
import {
  SEP_RE,
  padInsert,
  scanSeparators,
  unitAt,
  unitDeleteRange,
} from './mdBlocks.js';
import { writeClipboard } from './marpSlides.js';

// ───────────────────────────── cell model ─────────────────────────────

function mkCell(state, index, kind, from, to, leadSep, trailSep) {
  const bodyFrom = leadSep ? Math.min(to, leadSep.to + 1) : from;
  return {
    index,
    kind,
    inFrontMatter: kind === 'frontmatter',
    from,
    to,
    bodyFrom,
    leadSep,
    trailSep,
    firstLine: state.doc.lineAt(from).number,
    lastLine: state.doc.lineAt(Math.max(from, to - 1)).number,
  };
}

// Every cell in document order. Index 0 is the front-matter pseudo-cell when the
// document has one. There is ALWAYS at least one body cell (possibly empty), so
// navigation always has a target.
export function cellList(state, scan) {
  scan = scan || scanSeparators(state);
  const { fmEnd, seps, docLen } = scan;
  const cells = [];
  if (fmEnd > 0) {
    cells.push(mkCell(state, 0, 'frontmatter', 0, fmEnd, null, seps[0] || null));
  }
  // Body boundaries: the first body cell starts right after the front-matter and
  // has no leading separator; every separator opens a cell.
  const bounds = [{ from: fmEnd, leadSep: null }];
  for (const s of seps) bounds.push({ from: s.from, leadSep: s });
  // A separator sitting immediately at fmEnd (no blank line — hand-written text
  // that violates INV1) would otherwise yield a zero-length phantom first cell.
  if (bounds.length > 1 && bounds[0].from === bounds[1].from) bounds.shift();
  for (let i = 0; i < bounds.length; i++) {
    const to = i + 1 < bounds.length ? bounds[i + 1].from : docLen;
    const trailSep = i + 1 < bounds.length ? bounds[i + 1].leadSep : null;
    cells.push(mkCell(state, cells.length, 'body', bounds[i].from, to, bounds[i].leadSep, trailSep));
  }
  return cells;
}

// Index of the cell containing `pos` (walking backwards, so pos === doc.length
// and pos === 0 both resolve without a special case).
export function cellIndexAt(state, pos, cells) {
  cells = cells || cellList(state);
  for (let i = cells.length - 1; i >= 0; i--) if (pos >= cells[i].from) return i;
  return 0;
}

export function cellAt(state, pos, cells) {
  cells = cells || cellList(state);
  return cells[cellIndexAt(state, pos, cells)];
}

// The first index that is not the front-matter pseudo-cell.
function firstBodyIndex(cells) {
  return cells.length && cells[0].kind === 'frontmatter' ? 1 : 0;
}

// The source line to hand `applyEditorScroll` so the preview lands on this cell.
//
// The preview stamps data-line differently per document kind, but the cell's
// first BODY line is right for both:
//   Marp   — a slide <svg>'s data-line is (its `---` line + 1); see the
//            slideStartLines scan in assets/index.html renderMarp() (`__curStart
//            = i + 2` for 0-based i). Sending the separator's own line would land
//            one slide EARLY.
//   plain  — every top-level block carries its own data-line (stampLineNumbers),
//            and the `---` itself becomes an <hr data-line=sepLine>.
// The front-matter pseudo-cell reports 1: in deck mode no slide has
// data-line <= 1, so applyEditorScroll clamps to the first slide, which is right.
export function cellRunLine(state, cell) {
  if (!cell || cell.inFrontMatter) return 1;
  const base = state.doc.lineAt(cell.from).number;
  const line = cell.leadSep ? base + 1 : base;
  return Math.max(1, Math.min(state.doc.lines, line));
}

// ─────────────────────────── separator hygiene ───────────────────────────
//
// Invariants every planner must preserve, asserted in cells.test.mjs:
//   INV1  every separator line is preceded by a blank line (so it can never be
//         read as a setext <h2> underline — see mdBlocks.isParagraphLine)
//   INV2  no two separator lines with only blank lines between them
//   INV3  at most one trailing newline; padding matches padInsert
//   INV4  the front-matter block is never modified
//   INV5  the caret ends on the target cell's first body line (or the edit point)

const WS_RE = /\s/;

function scanBackWhitespace(state, pos, floor) {
  let p = pos;
  while (p > floor && WS_RE.test(state.sliceDoc(p - 1, p))) p--;
  return p;
}

function scanForwardWhitespace(state, pos, ceil) {
  let p = pos;
  while (p < ceil && WS_RE.test(state.sliceDoc(p, p + 1))) p++;
  return p;
}

// Drop a leading separator line (and the blank lines after it) from pasted text,
// so pasting a cut cell — whose text starts with its own `---` — doesn't produce
// two separators in a row.
function stripLeadingSeparator(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && SEP_RE.test(lines[i])) {
    i++;
    while (i < lines.length && !lines[i].trim()) i++;
    return lines.slice(i).join('\n').replace(/\s+$/, '');
  }
  return String(text || '').replace(/\s+$/, '');
}

// ───────────────────────────── planners ─────────────────────────────
// Each returns { changes, cursor } — or null to refuse. Pure: no view, no
// dispatch, so cells.test.mjs can drive them under plain node.

export function planInsert(state, index, where = 'below', body = '') {
  const scan = scanSeparators(state);
  const cells = cellList(state, scan);
  if (!cells.length) return null;
  const target = cells[Math.max(0, Math.min(cells.length - 1, index))];
  const text = stripLeadingSeparator(body);
  const above = where === 'above';

  // Inserting above the first body cell (or anywhere from the front-matter) makes
  // the NEW cell the first one, and the old first cell has to gain a leading
  // separator. So the separator goes AFTER our body, not before it — the mirror
  // image of unitDeleteRange's "first unit" case. Getting this backwards is the
  // classic cell-editor bug, hence its own tests.
  const asFirst = target.inFrontMatter || (above && !target.leadSep);
  if (asFirst) {
    const at = target.inFrontMatter ? scan.fmEnd : target.from;
    const { insert, bodyOffset } = padInsert(state, at, text + '\n\n---');
    const changes = [{ from: at, insert }];
    return { changes, cursor: at + bodyOffset };
  }

  const at = above ? target.from : target.to;
  const head = '---\n\n';
  const { insert, bodyOffset } = padInsert(state, at, head + text);
  return { changes: [{ from: at, insert }], cursor: at + bodyOffset + head.length };
}

export function planDelete(state, fromIndex, toIndex = fromIndex) {
  const scan = scanSeparators(state);
  const cells = cellList(state, scan);
  const lo = firstBodyIndex(cells);
  let a = Math.max(lo, Math.min(fromIndex, toIndex));
  let b = Math.min(cells.length - 1, Math.max(fromIndex, toIndex));
  if (a > b || b < lo) return null;
  const { from, to } = unitDeleteRange(cells[a], cells[b], scan.docLen);
  if (to <= from) return null;
  return { changes: [{ from, to, insert: '' }], cursor: from };
}

// Strip leading/trailing BLANK LINES only — not intra-line indentation, so a
// cell body that opens with an indented code block survives a move.
function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

// The padding a cell's body slot must carry, derived from its structural context
// rather than from whatever the author happened to type.
//
// lead — a blank line opens the slot whenever anything precedes it, which is the
//   separator line for most cells and the front-matter's closing `---` for the
//   first one. So the test is the POSITION, not `leadSep`: only a cell starting at
//   offset 0 (no front matter, no separator) has nothing above it.
// tail — a slot followed by a separator must END with a blank line (INV1: without
//   it the next `---` is read as a setext <h2> underline). The last cell has no
//   following separator, so it ends with a single newline.
function slotShape(cell) {
  return { lead: cell.bodyFrom > 0 ? '\n' : '', tail: cell.trailSep ? '\n\n' : '\n' };
}

// Move a cell up (-1) or down (+1) by swapping the two cells' body CONTENT and
// re-deriving each slot's padding. The separators stay where they are, which is
// what keeps this well-formed: their kinds may differ (`---` / `***` / `___`) and
// the first cell has none at all, so relocating them is far more fragile than
// moving the content between them.
//
// Swapping the raw slot text is NOT enough: the last cell's body ends with one
// newline while every other cell's ends with a blank line, so a raw swap drops
// the blank line before a separator and silently turns it into a setext heading.
//
// Both ranges are in original-document coordinates in ONE changes array, so
// CodeMirror composes them and it stays a single undo step.
export function planMove(state, index, dir) {
  const cells = cellList(state);
  const lo = firstBodyIndex(cells);
  const i = index;
  const j = index + dir;
  if (i < lo || j < lo || i >= cells.length || j >= cells.length) return null;
  const A = cells[i];
  const B = cells[j];
  const coreA = trimBlankLines(state.sliceDoc(A.bodyFrom, A.to));
  const coreB = trimBlankLines(state.sliceDoc(B.bodyFrom, B.to));
  const sa = slotShape(A);
  const sb = slotShape(B);
  const insA = sa.lead + coreB + sa.tail;
  const insB = sb.lead + coreA + sb.tail;
  if (insA === state.sliceDoc(A.bodyFrom, A.to) && insB === state.sliceDoc(B.bodyFrom, B.to)) {
    return null;
  }
  const changes = [
    { from: A.bodyFrom, to: A.to, insert: insA },
    { from: B.bodyFrom, to: B.to, insert: insB },
  ];
  // Follow the moved content: it now lives in cell j. Moving down shifts slot B
  // by the length change of slot A (which precedes it); moving up doesn't.
  const delta = dir > 0 ? insA.length - (A.to - A.bodyFrom) : 0;
  return { changes, cursor: B.bodyFrom + delta + sb.lead.length };
}

// Split the cell at `pos` into two. Both halves are REBUILT from their trimmed
// cores plus this slot's derived padding, rather than the separator being spliced
// in at the caret: splitting at the end of a cell's content leaves an empty lower
// half, and a naive splice then puts the caret on the FOLLOWING separator instead
// of inside the new cell.
export function planSplit(state, pos) {
  const cells = cellList(state);
  const idx = cellIndexAt(state, pos, cells);
  const cell = cells[idx];
  if (!cell || cell.inFrontMatter) return null;
  const p = Math.max(cell.bodyFrom, Math.min(pos, cell.to));
  const upper = trimBlankLines(state.sliceDoc(cell.bodyFrom, p));
  const lower = trimBlankLines(state.sliceDoc(p, cell.to));
  const sh = slotShape(cell);
  // The upper half keeps this slot's lead and gains a trailing blank line (INV1 —
  // a separator now follows it); the lower half becomes an ordinary cell slot
  // (leading blank line) and inherits this slot's tail.
  const head = sh.lead + upper + '\n\n---\n\n';
  const insert = head + lower + sh.tail;
  // Splitting at bodyFrom leaves an empty UPPER cell; splitting at the end leaves
  // an empty lower one. Both are legal (an empty slide) and both are what Jupyter
  // does, so they are allowed on purpose.
  return {
    changes: [{ from: cell.bodyFrom, to: cell.to, insert }],
    cursor: cell.bodyFrom + head.length,
  };
}

export function planMerge(state, index) {
  const cells = cellList(state);
  const lo = firstBodyIndex(cells);
  if (index < lo || index >= cells.length - 1) return null;
  const upper = cells[index];
  const lower = cells[index + 1];
  const a = scanBackWhitespace(state, upper.to, upper.bodyFrom);
  const b = scanForwardWhitespace(state, lower.bodyFrom, lower.to);
  const insert = '\n\n';
  const changes = [{ from: a, to: b, insert }];
  return { changes, cursor: a + insert.length };
}

const HEADING_RE = /^(\s*)(#{1,6})(\s+)/;
const DIRECTIVE_RE = /^\s*<!--/;

// Set (or with level 0, remove) the heading level of the cell's first content
// line. `pos` is a caret hint used only when the cell has no content line yet.
export function planHeading(state, index, level, pos) {
  const cells = cellList(state);
  const lo = firstBodyIndex(cells);
  if (index < lo || index >= cells.length) return null;
  const cell = cells[index];
  const firstLine = state.doc.lineAt(cell.bodyFrom).number;
  const lastLine = state.doc.lineAt(Math.max(cell.bodyFrom, cell.to - 1)).number;

  for (let n = firstLine; n <= lastLine; n++) {
    const ln = state.doc.line(n);
    if (!ln.text.trim()) continue;
    if (DIRECTIVE_RE.test(ln.text)) continue; // `<!-- _class: … -->`
    const m = HEADING_RE.exec(ln.text);
    const marks = level > 0 ? '#'.repeat(level) + ' ' : '';
    if (m) {
      const from = ln.from + m[1].length;
      const to = from + m[2].length + m[3].length;
      if (state.sliceDoc(from, to) === marks) return null;
      const changes = [{ from, to, insert: marks }];
      return { changes, cursor: from + marks.length };
    }
    if (!level) return null; // nothing to remove
    const changes = [{ from: ln.from, insert: marks }];
    return { changes, cursor: ln.from + marks.length };
  }

  if (!level) return null;
  const hint = Math.max(cell.bodyFrom, Math.min(pos == null ? cell.bodyFrom : pos, cell.to));
  const at = state.doc.lineAt(hint).from;
  const marks = '#'.repeat(level) + ' ';
  return { changes: [{ from: at, insert: marks }], cursor: at + marks.length };
}

// ─────────────────────────── cell clipboard ───────────────────────────
//
// Jupyter's c/x/v use an internal cell buffer, not the OS clipboard, and `v`
// must be instantaneous. So: copy writes BOTH the internal buffer (the
// synchronous read path) and the OS clipboard (cross-window paste). The OS
// clipboard is only READ as a fallback when the buffer is empty, because
// clipboardSync.js's read shim is an async IPC round trip with a 1s timeout.
let cellBuffer = '';

export function cellBufferText() {
  return cellBuffer;
}

// ─────────────────────────── dispatchers ───────────────────────────
//
// `userEvent` MUST start with something other than `input.type` / `delete`:
// @codemirror/commands' joinableUserEvent is /^(input\.type|delete)($|\.)/, and a
// joinable event lets two nearby cell ops collapse into one undo step. With
// `cell.*` every operation is exactly one undo step, for Mod-z and Vim `u` alike.
function apply(view, plan, userEvent) {
  if (!plan) return false;
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.cursor(plan.cursor),
    scrollIntoView: true,
    userEvent,
  });
  return true;
}

function currentIndex(view) {
  return cellIndexAt(view.state, view.state.selection.main.head);
}

export function insertCellAbove(view) {
  return apply(view, planInsert(view.state, currentIndex(view), 'above'), 'cell.insert');
}

export function insertCellBelow(view) {
  return apply(view, planInsert(view.state, currentIndex(view), 'below'), 'cell.insert');
}

export function copyCell(view) {
  const cell = cellAt(view.state, view.state.selection.main.head);
  if (!cell || cell.inFrontMatter) return false;
  cellBuffer = view.state.sliceDoc(cell.from, cell.to);
  writeClipboard(cellBuffer);
  return true;
}

export function cutCell(view) {
  const idx = currentIndex(view);
  const cell = cellList(view.state)[idx];
  if (!cell || cell.inFrontMatter) return false;
  cellBuffer = view.state.sliceDoc(cell.from, cell.to);
  writeClipboard(cellBuffer);
  return apply(view, planDelete(view.state, idx), 'cell.cut');
}

export function deleteCell(view) {
  return apply(view, planDelete(view.state, currentIndex(view)), 'cell.delete');
}

function pasteCell(view, where) {
  const idx = currentIndex(view);
  if (cellBuffer) {
    return apply(view, planInsert(view.state, idx, where, cellBuffer), 'cell.paste');
  }
  // Buffer empty: try the OS clipboard once so a cell yanked in another editor
  // window can be pasted here. Async, hence the deferred dispatch.
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((t) => {
        if (!t) return;
        cellBuffer = t;
        apply(view, planInsert(view.state, currentIndex(view), where, t), 'cell.paste');
      }).catch(() => {});
      return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

export function pasteCellBelow(view) { return pasteCell(view, 'below'); }
export function pasteCellAbove(view) { return pasteCell(view, 'above'); }

export function mergeCellBelow(view) {
  return apply(view, planMerge(view.state, currentIndex(view)), 'cell.merge');
}

export function splitCellAtCursor(view) {
  return apply(view, planSplit(view.state, view.state.selection.main.head), 'cell.split');
}

export function moveCellUp(view) {
  return apply(view, planMove(view.state, currentIndex(view), -1), 'cell.move');
}

export function moveCellDown(view) {
  return apply(view, planMove(view.state, currentIndex(view), 1), 'cell.move');
}

export function setCellHeadingLevel(view, level) {
  const plan = planHeading(view.state, currentIndex(view), level, view.state.selection.main.head);
  return apply(view, plan, 'cell.heading');
}

// Selection-only moves. These deliberately place a bare cursor, never a range —
// a selected range drops Vim into VISUAL mode (the trap mdTable.js documents).
function selectCell(view, idx) {
  const cells = cellList(view.state);
  const lo = firstBodyIndex(cells);
  const i = Math.max(lo, Math.min(cells.length - 1, idx));
  const cell = cells[i];
  if (!cell) return false;
  const pos = Math.min(cell.bodyFrom, view.state.doc.length);
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  return true;
}

export function selectNextCell(view) { return selectCell(view, currentIndex(view) + 1); }
export function selectPrevCell(view) { return selectCell(view, currentIndex(view) - 1); }
export function selectFirstCell(view) { return selectCell(view, 0); }
export function selectLastCell(view) { return selectCell(view, cellList(view.state).length - 1); }

// ─────────────────────────── mode state ───────────────────────────

export const setCellMode = StateEffect.define(); // 'edit' | 'command'
export const setCellPend = StateEffect.define(); // '' | 'd' | 'g'

const MODE_OFF = { mode: 'edit', pending: '', anchorIndex: -1 };

// Edit/Command lives in a StateField, not a module flag and not a Compartment:
//   - a plain flag produces no transaction, so the decoration ViewPlugin would
//     never recompute (the reason entry.js's table highlight needed a
//     Compartment). An effect IS a transaction, so a field is fine.
//   - a Compartment would tear down and rebuild the plugin and its whole RangeSet
//     on every Esc/Enter, and cannot express "same decorations, different colour".
//   - being state-resident is what makes `pending` testable with no EditorView.
// The ON/OFF axis is still a Compartment (in entry.js), so cell mode off means
// zero extensions — the gate is not even registered.
export const cellModeField = StateField.define({
  create: () => MODE_OFF,
  update(value, tr) {
    let next = value;
    let sawPend = false;
    for (const e of tr.effects) {
      if (e.is(setCellMode)) next = { ...next, mode: e.value, pending: '' };
      else if (e.is(setCellPend)) { next = { ...next, pending: e.value }; sawPend = true; }
    }
    // A pending latch (`dd`, `gg`) is cleared by the very next edit or cursor
    // move, so a mouse click elsewhere can never complete a half-typed `dd`.
    // No timeout: neither Jupyter nor Vim operators have one.
    if (!sawPend && next.pending && (tr.docChanged || tr.selection)) {
      next = { ...next, pending: '' };
    }
    return next;
  },
});

export function cellModeOf(state) {
  return state.field(cellModeField, false) || MODE_OFF;
}

// Cached cell list, recomputed only when the document changes. The decoration
// plugin and the gutter both read this, so a selection-only move costs no rescan.
export const cellsField = StateField.define({
  create: (state) => cellList(state),
  update(value, tr) { return tr.docChanged ? cellList(tr.state) : value; },
});

// ─────────────────────────── the key gate ───────────────────────────

function vimStateOf(view) {
  try {
    const cm = getCM(view);
    return (cm && cm.state && cm.state.vim) || null;
  } catch (_) {
    return null;
  }
}

function setMode(view, mode) {
  view.dispatch({ effects: setCellMode.of(mode) });
}

function vimPanelOpen() {
  try {
    return !!document.querySelector('.cm-vim-panel, .cm-panel-vim');
  } catch (_) {
    return false;
  }
}

// Every entry in the Command-mode table. Exported so the help modal and the
// keymap have a single source of truth.
export const CELL_HELP = [
  ['Esc', 'コマンドモードへ / 保留キーをクリア'],
  ['Enter', 'セルを編集（Edit モード）'],
  ['i', '編集して INSERT モードへ'],
  ['j / k', '次 / 前のセルを選択'],
  ['↓ / ↑', '次 / 前のセルを選択'],
  ['g g / Home', '最初のセル'],
  ['G / End', '最後のセル'],
  ['a / b', '上 / 下にセルを挿入'],
  ['d d', 'セルを削除'],
  ['x', 'セルをカット'],
  ['c / y', 'セルをコピー'],
  ['v / V', '下 / 上に貼り付け'],
  ['M', '下のセルと結合'],
  ['1〜6 / 0', '見出しレベルを設定 / 解除'],
  ['z / u', '元に戻す'],
  ['Z / Ctrl+r', 'やり直す'],
  ['s', '保存'],
  ['l', '行番号モードを切り替え'],
  ['f', '検索'],
  ['m', 'Marp スライドクラスを変更（Marp 文書のみ）'],
  ['h', 'このヘルプ'],
  ['Shift+Enter', '実行して次のセルへ'],
  ['Ctrl+Enter', '実行してとどまる'],
  ['Alt+Enter', '実行して下にセルを挿入'],
  ['Ctrl+Shift+-', 'カーソル位置でセルを分割'],
  ['Ctrl+Shift+↑ / ↓', 'セルを上 / 下へ移動'],
];

// Prec.highest ViewPlugin keydown handler — see the header comment for why this,
// and not Prec.highest(keymap.of(…)), is the only thing that beats Vim.
export function cellGate(cb) {
  const handled = (e) => { e.preventDefault(); e.stopPropagation(); return true; };

  return Prec.highest(EditorView.domEventHandlers({
    keydown(e, view) {
      const st = cellModeOf(view.state);

      // Any open UI owns the keyboard. openModal() does not move focus, so the
      // gate would otherwise fire in parallel with entry.js's document-level Esc
      // chain; the completion popup needs Enter/↑/↓/Esc; the Vim ex prompt needs
      // everything.
      if (cb.isModalOpen && cb.isModalOpen()) return false;
      if (completionStatus(view.state)) return false;
      if (vimPanelOpen()) return false;

      if (e.key === 'Escape') {
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
        const vs = vimStateOf(view);
        if (vs) {
          // Let Vim do its normal INSERT/VISUAL exit, and let it cancel a pending
          // operator or count, before we claim Esc for the mode switch.
          if (vs.insertMode || vs.visualMode) return false;
          const is = vs.inputState;
          if (is && (is.operator || (is.keyBuffer && is.keyBuffer.length))) return false;
        }
        if (st.mode === 'command') {
          if (st.pending) view.dispatch({ effects: setCellPend.of('') });
        } else {
          setMode(view, 'command');
          if (cb.onEnterCommand) cb.onEnterCommand();
        }
        // Deliberately NOT preventDefault: vimPlugin's <Esc> branch still clears
        // the Vim search highlight, and the downstream Escape consumers
        // (closeCompletion / closeSearchPanel / simplifySelection) are all safe
        // no-ops when idle. The ladder stays intact.
        return false;
      }

      if (st.mode !== 'command') return false;

      // Modifier combos belong to the keymap layers (save, search, undo, the run
      // keys, Ctrl+Shift+arrows). Ctrl+r is the one we claim, for Vim-style redo.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'r') {
          redo(view);
          return handled(e);
        }
        return false;
      }

      const pending = st.pending;
      const k = e.key;

      if (pending === 'd') {
        view.dispatch({ effects: setCellPend.of('') });
        if (k === 'd') { deleteCell(view); return handled(e); }
        return handled(e); // consume the aborted sequence
      }
      if (pending === 'g') {
        view.dispatch({ effects: setCellPend.of('') });
        if (k === 'g') { selectFirstCell(view); return handled(e); }
        return handled(e);
      }

      switch (k) {
        case 'Enter':
          if (e.shiftKey) return false; // Shift-Enter is a run key (keymap layer)
          setMode(view, 'edit');
          return handled(e);
        case 'i':
          setMode(view, 'edit');
          if (cb.onEnterInsert) cb.onEnterInsert(view);
          return handled(e);

        case 'j': case 'ArrowDown': selectNextCell(view); return handled(e);
        case 'k': case 'ArrowUp': selectPrevCell(view); return handled(e);
        case 'Home': selectFirstCell(view); return handled(e);
        case 'End': case 'G': selectLastCell(view); return handled(e);
        case 'g': view.dispatch({ effects: setCellPend.of('g') }); return handled(e);

        case 'a': insertCellAbove(view); return handled(e);
        case 'b': insertCellBelow(view); return handled(e);
        case 'd': view.dispatch({ effects: setCellPend.of('d') }); return handled(e);
        case 'x': cutCell(view); return handled(e);
        case 'c': case 'y': copyCell(view); return handled(e);
        case 'v': pasteCellBelow(view); return handled(e);
        case 'V': pasteCellAbove(view); return handled(e);
        case 'M': mergeCellBelow(view); return handled(e);

        case 'z': case 'u': undo(view); return handled(e);
        case 'Z': redo(view); return handled(e);

        case 's': if (cb.onSave) cb.onSave(); return handled(e);
        case 'l': if (cb.onCycleLineNo) cb.onCycleLineNo(); return handled(e);
        case 'f': openSearchPanel(view); return handled(e);
        case 'h': if (cb.onHelp) cb.onHelp(); return handled(e);
        case 'm':
          if (cb.isMarp && cb.isMarp()) { if (cb.onClassPicker) cb.onClassPicker(); }
          else if (cb.onHint) cb.onHint('m: Marp 文書ではありません');
          return handled(e);

        // Jupyter extends the cell selection with Shift+J/K. Multi-cell selection
        // is phase 2 (planDelete already takes a range and cellModeField already
        // carries anchorIndex); hint rather than die silently.
        case 'J': case 'K':
          if (cb.onHint) cb.onHint('複数セル選択は未対応です');
          return handled(e);

        default: break;
      }

      if (/^[0-6]$/.test(k)) {
        setCellHeadingLevel(view, Number(k));
        return handled(e);
      }
      // Swallow every other bare printable key so Command mode never types into
      // the document. Named keys (F5, Tab, PageDown…) fall through.
      if (k.length === 1) return handled(e);
      return false;
    },
  }));
}

// ─────────────────────────── run keys ───────────────────────────
//
// These live in a keymap (not the gate) because they must work in EDIT mode too,
// and because Vim declines <S-CR> / <C-CR> / <A-CR> / <C-S-Up> / <C-S-_> so they
// reach the keymap facet in every Vim mode. entry.js places this layer before the
// main keymap.of([… defaultKeymap …]) so `Mod-Enter` is taken from
// defaultKeymap's insertBlankLine and `Shift-Enter` from Enter's shift binding.
export function cellEditKeymap({ onRun }) {
  const run = (mode) => (view) => { if (onRun) onRun(view, mode); return true; };
  return [
    { key: 'Shift-Enter', preventDefault: true, run: run('next') },
    { key: 'Mod-Enter', preventDefault: true, run: run('stay') },
    { key: 'Alt-Enter', preventDefault: true, run: run('insert') },
    // 'Mod-Shift--': runHandlers falls back to base[keyCode] with a Shift- prefix,
    // so this resolves for `_` on both US and JIS layouts.
    { key: 'Mod-Shift--', preventDefault: true, run: (v) => splitCellAtCursor(v) },
    { key: 'Mod-Shift-ArrowUp', preventDefault: true, run: (v) => moveCellUp(v) },
    { key: 'Mod-Shift-ArrowDown', preventDefault: true, run: (v) => moveCellDown(v) },
  ];
}

// ─────────────────────────── visuals ───────────────────────────

const CELL = Decoration.line({ class: 'cm-cell' });
const CELL_FIRST = Decoration.line({ class: 'cm-cell-first' });
const CELL_LAST = Decoration.line({ class: 'cm-cell-last' });
const CELL_ACTIVE = Decoration.line({ class: 'cm-cell-active' });
const CELL_FM = Decoration.line({ class: 'cm-cell-fm' });
const CELL_GAP = Decoration.line({ class: 'cm-cell-gap' });

function buildCellDecorations(view) {
  const state = view.state;
  const cells = state.field(cellsField, false) || cellList(state);
  if (!cells.length) return Decoration.none;
  const activeIdx = cellIndexAt(state, state.selection.main.head, cells);
  const b = new RangeSetBuilder();

  // Only over the viewport: a `Decoration.line` per line would otherwise mean
  // thousands of ranges rebuilt on every keystroke. (This is why it is a
  // ViewPlugin keyed on viewportChanged and not a state-only decorations facet —
  // a different reason from mdTable.js's syntax-tree argument.)
  for (const { from, to } of view.visibleRanges) {
    let lineNo = state.doc.lineAt(from).number;
    const lastNo = state.doc.lineAt(to).number;
    for (; lineNo <= lastNo; lineNo++) {
      const line = state.doc.line(lineNo);
      const idx = cellIndexAt(state, line.from, cells);
      const cell = cells[idx];
      if (!cell) continue;
      // The separator line belongs to no box — it IS the gap between two boxes.
      if (cell.leadSep && lineNo === cell.leadSep.line) {
        b.add(line.from, line.from, CELL_GAP);
        continue;
      }
      b.add(line.from, line.from, CELL);
      if (line.from <= cell.bodyFrom) b.add(line.from, line.from, CELL_FIRST);
      if (lineNo === cell.lastLine) b.add(line.from, line.from, CELL_LAST);
      if (cell.inFrontMatter) b.add(line.from, line.from, CELL_FM);
      if (idx === activeIdx) b.add(line.from, line.from, CELL_ACTIVE);
    }
  }
  return b.finish();
}

export function cellDecorations({ onModeChange } = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildCellDecorations(view);
        this.mode = cellModeOf(view.state).mode;
        // Deliberately NOT calling onModeChange here. This constructor runs
        // *during* `new EditorView(...)`, i.e. before entry.js's `const view = …`
        // is initialized, so any callback that touches `view` throws a TDZ
        // ReferenceError — and CodeMirror catches plugin exceptions and silently
        // DEACTIVATES the plugin, which killed the decorations and the mode class
        // for the whole session. The initial mode is always 'edit' (the field is
        // created fresh whenever the compartment turns cell mode on), and entry.js
        // paints that class itself, so there is nothing to report here anyway.
      }

      update(u) {
        const st = cellModeOf(u.state);
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.startState.field(cellsField, false) !== u.state.field(cellsField, false)
        ) {
          this.decorations = buildCellDecorations(u.view);
        }
        // The Edit/Command look is a body class, so flipping modes repaints with
        // no transaction and no decoration rebuild.
        if (st.mode !== this.mode || cellModeOf(u.startState).pending !== st.pending) {
          this.mode = st.mode;
          if (onModeChange) onModeChange(st.mode, st);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

class CellNumMarker extends GutterMarker {
  constructor(label, active) {
    super();
    this.label = label;
    this.active = active;
  }

  // REQUIRED: SingleGutterView.update re-reads markers() on every update and
  // diffs with RangeSet.eq, which falls back to this. Without it the gutter DOM
  // is rebuilt on every keystroke.
  eq(other) {
    return other.label === this.label && other.active === this.active;
  }

  get elementClass() {
    return this.active ? 'cm-cell-num-active' : '';
  }

  toDOM() {
    const s = document.createElement('span');
    s.textContent = this.label;
    return s;
  }
}

function buildCellNumberMarkers(state) {
  const cells = state.field(cellsField, false) || cellList(state);
  const activeIdx = cellIndexAt(state, state.selection.main.head, cells);
  const marks = [];
  let n = 0;
  for (const cell of cells) {
    const label = cell.inFrontMatter ? '---' : `[${++n}]`;
    const at = state.doc.line(cell.inFrontMatter ? cell.firstLine : Math.min(
      state.doc.lines,
      state.doc.lineAt(cell.bodyFrom).number
    )).from;
    marks.push(new CellNumMarker(label, cell.index === activeIdx).range(at));
  }
  marks.sort((a, b) => a.from - b.from);
  return RangeSet.of(marks, true);
}

export function cellNumberGutter() {
  return gutter({
    class: 'cm-cellNumbers',
    markers: (view) => buildCellNumberMarkers(view.state),
    // Stable width, so the gutter doesn't jitter as cell count crosses 10.
    initialSpacer: () => new CellNumMarker('[99]', false),
  });
}

// ─────────────────────────── the bundle ───────────────────────────
//
// The single value entry.js's cellComp is reconfigured to. Reconfiguring to []
// drops the field, the decorations, the gutter and the key handlers in one
// transaction — no stale boxes, no orphan gutter.
export function cellMode(cb = {}) {
  return [
    cellModeField,
    cellsField,
    cellGate(cb),
    keymap.of(cellEditKeymap(cb)),
    cellNumberGutter(),
    cellDecorations(cb),
  ];
}

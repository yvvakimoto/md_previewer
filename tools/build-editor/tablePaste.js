// Auto-convert an Office / HTML <table> or an Excel TSV range pasted with Ctrl+V
// into a GFM pipe table.
//
// This is the inverse of the preview's "Copy table" button (assets/index.html,
// addTableCopyButtons / copyHtmlViaSelection), which puts a rich table on the
// clipboard as text/html so PowerPoint / Word / Excel receive a native table.
// Pasting one back into the editor previously dropped raw tab-separated text.
//
// NO RUST CHANGE IS INVOLVED. A real DOM `paste` event's clipboardData is built
// by WebView2 from the OS clipboard and already carries text/html (converted
// from CF_HTML). That is entirely independent of src/clipboard_win.rs, which is
// CF_UNICODETEXT-only and backs just the navigator.clipboard readText/writeText
// IPC shim in clipboardSync.js — a path this feature never touches.
//
// WHY Prec.highest. Ordering here is NOT array position:
//   - @codemirror/view's built-in handlers.paste is appended by computeHandlers()
//     after every plugin's handlers, outside the Prec system, so any
//     plugin-registered paste handler already precedes it.
//   - @codemirror/lang-markdown's pasteURLAsLink IS a plugin (enabled by default;
//     entry.js calls markdown({base}) with no opts) and must be beaten, which is
//     what Prec.highest does.
// We therefore MUST return false when declining, or pasting a URL over a
// selection would stop producing a link and plain paste would stop working.
//
// Do NOT call stopImmediatePropagation(): @replit/codemirror-vim registers its
// own native paste listener on contentDOM (it only enters INSERT mode and never
// preventDefaults), and killing it would break Vim's mode tracking.

import { EditorSelection, Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { emitTable } from './mdTable.js';
import { FM_RE, leadPad, tailPad } from './mdBlocks.js';

// Sanity caps. A paste larger than this is not a table someone wants in a
// Markdown document, and converting it would hang the editor on column padding.
const MAX_PASTE_COLS = 64;
const MAX_PASTE_ROWS = 2000;

// ---------- matrix normalisation ----------

// Rectangularise: fill holes, pad short rows, drop fully blank edge rows (Word
// and Excel both emit trailing spacer rows). Columns are never dropped — a
// legitimately empty column must survive.
export function normalizeMatrix(grid) {
  if (!grid || !grid.length) return null;
  let rows = grid.map((r) => Array.from(r || [], (c) => (c == null ? '' : String(c))));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!width) return null;
  rows = rows.map((r) =>
    r.length < width ? r.concat(new Array(width - r.length).fill('')) : r
  );
  const blank = (r) => r.every((c) => c === '');
  while (rows.length && blank(rows[0])) rows.shift();
  while (rows.length && blank(rows[rows.length - 1])) rows.pop();
  if (!rows.length) return null;
  if (width > MAX_PASTE_COLS || rows.length > MAX_PASTE_ROWS) return null;
  return rows;
}

// ---------- text/plain (TSV) ----------

// Excel / Sheets put a strictly rectangular, tab-separated, unindented grid on
// text/plain. This predicate is deliberately strict, because the cost of a false
// positive (silently mangling pasted code) is far higher than the cost of a
// false negative (the user formats the table by hand, as today).
//
// Tab-indented CODE fails (3) or (5); a selected function body fails (2);
// tab-aligned prose fails (5). Returns string[][] or null.
export function tsvToMatrix(text) {
  let s = String(text == null ? '' : text);
  if (s.indexOf('\t') < 0) return null;            // (1) tabs required
  s = s.replace(/\r?\n$/, '');                     //     Excel appends one trailing EOL
  const lines = s.split(/\r\n|\n|\r/);
  if (lines.length < 2 || lines.length > MAX_PASTE_ROWS) return null;
  if (lines.some((l) => l === '')) return null;    // (2) no blank line inside a range
  // (3) EVERY line indented means indentation, not data. This must be `every`,
  // not `some`: an Excel range whose first cell is empty on some row also starts
  // that line with a tab, and `some` rejected those. Uniformly tab-indented code
  // — the case guard (5) cannot catch, because it IS rectangular — is still
  // rejected here. (A wholly empty first column would be rejected too; that is a
  // degenerate selection and declining is the right answer.)
  if (lines.every((l) => /^[ \t]/.test(l))) return null;
  const n = lines[0].split('\t').length;
  if (n < 2 || n > MAX_PASTE_COLS) return null;    // (4) at least two columns
  const rows = lines.map((l) => l.split('\t'));
  if (rows.some((r) => r.length !== n)) return null;   // (5) strictly rectangular
  return normalizeMatrix(rows);
}

// ---------- text/html ----------

// A cell's plain text. Inline formatting is deliberately NOT preserved (out of
// scope): <br> and block boundaries fold to a space, entities and Word's
// &nbsp; / ZWSP litter are normalised away.
//
// `|` is NOT escaped here — that is emitTable's job, which keeps escapeTableCell
// byte-identical to the preview's tblEscapeCell (see the sync note in mdTable.js)
// and lets emitTable accept any raw matrix.
function cellText(el) {
  const clone = el.cloneNode(true);
  for (const br of clone.querySelectorAll('br')) br.replaceWith(' ');
  // Word wraps each paragraph of a cell in <p>; textContent would run "a"+"b"
  // together as "ab" without this.
  for (const b of clone.querySelectorAll('p,div,li,tr')) b.append(' ');
  return (clone.textContent || '')
    .replace(/[\u00a0\u200b]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clampSpan = (v) => Math.max(1, Math.min(MAX_PASTE_COLS, parseInt(v, 10) || 1));

const stripLen = (s) => String(s || '').replace(/[\s\u00a0\u200b]/g, '').length;

// Build a dense matrix from a <table> element (or any element containing <tr>s).
// opts.spanFill: 'repeat' (default) | 'blank' — GFM has no merged cells, and a
// repeated header reads far better than `A | | |`; a blank cell in GFM is also
// indistinguishable from a genuinely empty one, so repeating loses less.
export function htmlTableToMatrix(root, opts = {}) {
  if (!root || !root.querySelectorAll) return null;
  const table = root.querySelector ? root.querySelector('table') : null;

  const all = Array.from((table || root).querySelectorAll('tr'));
  // A nested table's rows also match querySelectorAll('tr') on the outer one;
  // keep only rows whose nearest table ancestor is ours.
  let trs = table ? all.filter((tr) => tr.closest('table') === table) : all;
  trs = trs.filter((tr) => !/display\s*:\s*none/i.test(tr.getAttribute('style') || ''));
  if (!trs.length) return null;

  // DATA-LOSS GUARD. A Word selection can contain a table PLUS surrounding
  // prose; converting just the table would silently discard the prose. Decline
  // instead and let the paste fall through to plain text. Also declines a
  // two-table selection. Skipped for a bare <tr> fragment, which by
  // construction has nothing outside it.
  if (table && stripLen(root.textContent) > stripLen(table.textContent)) return null;

  const grid = [];
  for (let r = 0; r < trs.length; r++) {
    const cells = Array.from(trs[r].children).filter(
      (el) => el.tagName === 'TD' || el.tagName === 'TH'
    );
    let c = 0;
    const out = (grid[r] = grid[r] || []);
    for (const cell of cells) {
      while (out[c] !== undefined) c++; // slot already taken by a rowspan above
      const cs = clampSpan(cell.getAttribute('colspan'));
      const rs = clampSpan(cell.getAttribute('rowspan'));
      const text = cellText(cell);
      for (let dr = 0; dr < rs; dr++) {
        const g = (grid[r + dr] = grid[r + dr] || []);
        for (let dc = 0; dc < cs; dc++) {
          g[c + dc] = dr === 0 && dc === 0
            ? text
            : (opts.spanFill === 'blank' ? '' : text);
        }
      }
      c += cs;
    }
  }
  return normalizeMatrix(grid);
}

// The only DOMParser caller, kept in one place so nothing at module scope
// touches `document` and the pure exports above stay importable under node.
function parseHtmlFragment(html) {
  const s = String(html);
  const clean = (doc) => {
    for (const el of doc.querySelectorAll('style,script,meta,link,title')) el.remove();
    return doc.body;
  };
  const body = clean(new DOMParser().parseFromString(s, 'text/html'));
  // A partial selection can put a bare run of <tr>s on the clipboard with no
  // <table> wrapper. The HTML parser DISCARDS table elements outside a table
  // context (the "in body" insertion mode drops <tr>/<td>/<th>), so the first
  // parse yields only the cells' text and every row is lost — re-parse wrapped.
  if (!body.querySelector('table, tr') && /<t[rdh][\s>]/i.test(s)) {
    const wrapped = clean(
      new DOMParser().parseFromString('<table>' + s + '</table>', 'text/html')
    );
    if (wrapped.querySelector('tr')) return wrapped;
  }
  return body;
}

// HTML first, then TSV — and always fall through when the HTML yields nothing.
// Copying a TSV block out of a text editor also puts a text/html flavour on the
// clipboard (a <pre>/<span> wrapper with no <table>), so falling through is what
// makes Excel and a raw TSV file both work.
export function clipboardTableMatrix(dt) {
  if (!dt) return null;
  let html = '';
  try { html = dt.getData('text/html') || ''; } catch (_) { html = ''; }
  if (html && typeof DOMParser !== 'undefined') {
    try {
      const m = htmlTableToMatrix(parseHtmlFragment(html));
      if (m) return m;
    } catch (_) { /* fall through to text/plain */ }
  }
  let text = '';
  try { text = dt.getData('text/plain') || ''; } catch (_) { text = ''; }
  return text ? tsvToMatrix(text) : null;
}

// ---------- context guard ----------

// Node names meaning "raw text lives here, do not rewrite it". A Table is
// included because a table inside a table is nonsense. Verified against the
// installed @lezer/markdown.
const BLOCKED_NODE =
  /^(FencedCode|CodeBlock|CodeText|CodeMark|InlineCode|Table|TableHeader|TableRow|TableCell|TableDelimiter|HTMLBlock|HTMLTag|Comment|CommentBlock|LinkLabel|URL)$/;

// YAML front matter emits NO syntax-tree node: @lezer/markdown parses
// `---\ntitle: x\n---` as HorizontalRule + SetextHeading2, so resolveInner
// cannot see it. It can only ever start at offset 0, so a bounded head slice is
// O(1). FM_RE is imported rather than re-written so there stays exactly one
// front-matter regex in the editor bundle.
function inFrontMatter(state, pos) {
  if (pos <= 0) return false;
  const head = state.sliceDoc(0, Math.min(state.doc.length, 8192));
  const m = FM_RE.exec(head);
  return !!(m && m.index === 0 && pos < m[0].length);
}

// Would converting at `pos` corrupt something? Errs towards declining: a plain
// paste is always safe, a wrong conversion is not.
export function pasteContextBlocked(state, pos) {
  if (inFrontMatter(state, pos)) return true;
  // ensureSyntaxTree, not syntaxTree: the parse advances asynchronously (the
  // same fact that makes tableColumnHighlight a ViewPlugin), so on a large
  // document the tree may not have reached `pos` yet and a fence would be
  // missed. 200ms is affordable for a one-off user gesture.
  const tree = ensureSyntaxTree(state, pos, 200);
  if (!tree) return true;
  for (const side of [-1, 1]) {
    for (let n = tree.resolveInner(pos, side); n; n = n.parent) {
      if (BLOCKED_NODE.test(n.name)) return true;
    }
  }
  return false;
}

// ---------- plain-paste escape hatch ----------

let plainPasteUntil = 0;

// Mod-Shift-V — "paste as plain text this once", the recovery gesture for a
// wrong conversion (the other being a single Ctrl+Z, since the whole insert is
// one transaction).
//
// The command deliberately returns FALSE: it only arms the flag and lets
// Chromium's own paste-as-plain-text proceed, which the built-in handlers.paste
// turns into a text/plain insert. Blink does NOT strip flavours for
// Ctrl+Shift+V — getData('text/html') still returns the HTML — which is exactly
// why a flag is needed rather than sniffing the event.
//
// The window is short so a stray press cannot disable a real paste minutes
// later; if no paste event follows at all, the flag simply expires.
export function plainPasteKeymap() {
  return [{
    key: 'Mod-Shift-v',
    run: () => { plainPasteUntil = Date.now() + 1500; return false; },
  }];
}

function takePlainPasteOnce() {
  const armed = Date.now() < plainPasteUntil;
  plainPasteUntil = 0;
  return armed;
}

// ---------- the extension ----------

function insertPastedTable(view, matrix) {
  const state = view.state;
  const sel = state.selection.main;
  const { text } = emitTable(matrix);
  // leadPad reads only BEFORE `at` and tailPad reads only AT `at`, so passing
  // sel.from / sel.to is correct even for a non-empty selection. (padInsert
  // applies one `at` to both and therefore cannot be reused verbatim here.)
  // The tail is what terminates the table — without a blank line after it, GFM
  // absorbs the following prose as a one-cell row.
  const lead = leadPad(state, sel.from);
  const tail = tailPad(state, sel.to);
  const insert = lead + text + tail;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    // Cursor past the trailing blank line, NOT a selection — a selection would
    // drop Vim into VISUAL immediately after the paste (same rule as
    // insertTable()). Landing past the tail also matters for correctness, not
    // just ergonomics: a cursor at the table's last character is INSIDE the
    // Table node, so pasteContextBlocked would refuse the very next paste.
    selection: EditorSelection.cursor(sel.from + insert.length),
    scrollIntoView: true,
    // Must not match /^(input\.type|delete)($|\.)/ or @codemirror/commands'
    // joinableUserEvent would let this merge with a neighbouring edit into one
    // undo step. With 'table.paste' the whole conversion is exactly one Ctrl+Z.
    userEvent: 'table.paste',
  });
}

// opts.isEnabled  — () => boolean, the :set tablepaste preference
// opts.onConvert  — (rows, cols) => void, for the status-bar hint
export function tablePaste(opts = {}) {
  return Prec.highest(
    EditorView.domEventHandlers({
      paste(event, view) {
        // Order the checks by cost: flags, then pure string/DOM parsing, and
        // only pay for the syntax tree once we know we actually have a table.
        if (view.state.readOnly) return false;
        if (opts.isEnabled && !opts.isEnabled()) return false;

        let matrix = null;
        try {
          matrix = clipboardTableMatrix(event.clipboardData);
        } catch (_) {
          return false;
        }
        if (!matrix) return false;

        // Spend the one-shot plain-paste flag only once we know this paste would
        // otherwise have been converted. Chromium's Ctrl+Shift+V fires a real
        // paste event, and if that carried no table an earlier check here would
        // burn the flag on it and convert the user's next paste anyway.
        if (takePlainPasteOnce()) return false;

        if (pasteContextBlocked(view.state, view.state.selection.main.from)) return false;

        insertPastedTable(view, matrix);
        if (opts.onConvert) {
          try { opts.onConvert(matrix.length, matrix[0].length); } catch (_) {}
        }
        // runHandlers() calls preventDefault() for us on a truthy return.
        return true;
      },
    })
  );
}

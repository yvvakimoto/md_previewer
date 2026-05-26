// Numbered-list-aware Tab / Shift+Tab for CodeMirror 6.
//
// CommonMark / GFM requires that children of a numbered list item be indented
// to the column of the marker's text (e.g. "1. " → 3 spaces, "10. " → 4).
// The default `indentWithTab` only inserts `indentUnit` (2) spaces, which
// breaks list nesting under numbered parents. These handlers detect the
// nearest enclosing numbered marker and snap indentation to its width.

import { EditorSelection } from '@codemirror/state';

const LIST_MARKER_RE = /^(\s*)(?:[-*+]|\d+\.)\s/;
const NUMBERED_MARKER_RE = /^(\s*)(\d+)\.\s/;
const FENCE_RE = /^\s*(```|~~~)/;

// Walk upward from `line` and return the indent unit (digits + ". ") of the
// nearest numbered-list ancestor whose indent is <= currentIndent. Returns
// null if no such ancestor exists.
function computeNumberedListIndentUnit(state, line) {
  const indentMatch = /^(\s*)/.exec(line.text);
  const currentIndent = indentMatch ? indentMatch[1].length : 0;

  let inFence = false;
  // First, decide whether the *current* line is inside a fenced code block by
  // counting fences from the top. Cheap and good enough — the editor only
  // calls this on Tab.
  for (let i = 1; i < line.number; i++) {
    if (FENCE_RE.test(state.doc.line(i).text)) inFence = !inFence;
  }
  if (inFence) return null;

  let fenceParity = inFence;
  for (let i = line.number - 1; i >= 1; i--) {
    const ln = state.doc.line(i);
    if (FENCE_RE.test(ln.text)) {
      fenceParity = !fenceParity;
      continue;
    }
    if (fenceParity) continue;
    const m = NUMBERED_MARKER_RE.exec(ln.text);
    if (m && m[1].length <= currentIndent) {
      return m[2].length + 2; // digits + "." + " "
    }
  }
  return null;
}

function smartTab(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false; // let indentWithTab handle multiline indent

  const line = state.doc.lineAt(sel.head);
  const before = state.doc.sliceString(line.from, sel.head);
  const desired = computeNumberedListIndentUnit(state, line);
  if (desired == null) return false; // no numbered ancestor → fall through

  // Case A: cursor is somewhere in the leading whitespace (or at column 0 on
  // an otherwise-empty line). Advance to the next multiple of `desired`.
  if (/^\s*$/.test(before)) {
    const currentCol = before.length;
    const target = Math.floor(currentCol / desired) * desired + desired;
    const add = target - currentCol;
    view.dispatch({
      changes: { from: sel.head, insert: ' '.repeat(add) },
      selection: EditorSelection.cursor(sel.head + add),
      userEvent: 'input.indent',
    });
    return true;
  }

  // Case B: line begins with a list marker and the cursor is at/in the marker
  // — promote the marker into a sub-list by inserting `desired` spaces at the
  // line start. This handles "Enter on `1. item1` → `2. ` then Tab to demote"
  // and matches what users expect when nesting freshly-continued markers.
  const markerMatch = LIST_MARKER_RE.exec(line.text);
  if (markerMatch) {
    const markerEnd = line.from + markerMatch[0].length;
    if (sel.head <= markerEnd) {
      view.dispatch({
        changes: { from: line.from, insert: ' '.repeat(desired) },
        selection: EditorSelection.cursor(sel.head + desired),
        userEvent: 'input.indent',
      });
      return true;
    }
  }

  return false;
}

function smartShiftTab(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;

  const line = state.doc.lineAt(sel.head);
  const indentMatch = /^(\s*)/.exec(line.text);
  const leadingLen = indentMatch ? indentMatch[1].length : 0;
  if (leadingLen === 0) return false;

  const desired = computeNumberedListIndentUnit(state, line);
  if (desired == null) return false;

  const remove = Math.min(desired, leadingLen);
  const newHead = Math.max(line.from, sel.head - remove);
  view.dispatch({
    changes: { from: line.from, to: line.from + remove, insert: '' },
    selection: EditorSelection.cursor(newHead),
    userEvent: 'delete.dedent',
  });
  return true;
}

export function numberedListIndentKeymap() {
  return [
    { key: 'Tab', run: smartTab },
    { key: 'Shift-Tab', run: smartShiftTab },
  ];
}

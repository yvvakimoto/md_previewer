// Marp slide editing helpers for the CodeMirror 6 companion editor.
//
// Provides slide-unit aware operations that mirror the previewer's renderMarp()
// boundary logic (assets/index.html): a Marp deck is a YAML front-matter block
// (`marp: true`) followed by slides separated by `---` / `***` / `___` lines.
// The first `---...---` pair is front-matter, not a slide boundary, and
// separators inside fenced code blocks are ignored.
//
//   - insertSlideAfter(view, className) — add a new slide after the current one,
//     optionally with a `<!-- _class: NAME -->` directive.
//   - copySlide(view) / cutSlide(view)  — copy / cut the slide under the cursor
//     (one separator is removed on cut so none is left dangling).
//
// All edits go through view.dispatch, so the existing modeListener flows them to
// the live preview — no IPC needed. In-house module; same shape as the other
// build-editor helpers (numberedListIndent.js etc).

import { EditorSelection } from '@codemirror/state';

const SEP_RE = /^(---|\*\*\*|___)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/;

// Classes offered in the insert picker (split-3 / split-4 omitted for brevity —
// authors can edit the `_class` line by hand when they need them).
export const SLIDE_CLASSES = ['none', 'title', 'section', 'lead', 'invert', 'split'];

// Mirror of isMarpDocument() in assets/index.html — keep the two in sync.
export function isMarpDocument(text) {
  const m = FM_RE.exec(text);
  if (!m || m.index !== 0) return false;
  return /^\s*marp\s*:\s*true\s*$/m.test(m[1]);
}

// One forward pass: locate front-matter and every slide separator (skipping
// front-matter lines and fenced code blocks). Returns
//   { fmEnd, fmLastLine, seps: [{line, from, to}], docLen }
// fmEnd is the char offset just past the front-matter block (0 if none).
export function scanSlides(state) {
  const text = state.doc.toString();
  let fmEnd = 0;
  let fmLastLine = 0;
  const fm = FM_RE.exec(text);
  if (fm && fm.index === 0) {
    fmEnd = fm[0].length;
    fmLastLine = state.doc.lineAt(Math.max(0, fmEnd - 1)).number;
  }
  const seps = [];
  let inFence = false;
  const total = state.doc.lines;
  for (let i = 1; i <= total; i++) {
    if (i <= fmLastLine) continue; // front-matter (incl. its --- delimiters)
    const ln = state.doc.line(i);
    if (FENCE_RE.test(ln.text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (SEP_RE.test(ln.text)) seps.push({ line: i, from: ln.from, to: ln.to });
  }
  return { fmEnd, fmLastLine, seps, docLen: state.doc.length };
}

// The slide unit containing `pos`. A unit spans from its leading separator
// (which belongs to the slide it introduces) to the next separator. The first
// slide has no leading separator and starts right after the front-matter.
export function slideAt(state, pos, scan) {
  scan = scan || scanSlides(state);
  const { fmEnd, seps, docLen } = scan;
  if (fmEnd > 0 && pos < fmEnd) {
    return { inFrontMatter: true, from: 0, to: fmEnd, leadSep: null, trailSep: null };
  }
  let prev = null;
  let next = null;
  for (const s of seps) {
    if (s.from <= pos) prev = s;
    else { next = s; break; }
  }
  const from = prev ? prev.from : fmEnd;
  const to = next ? next.from : docLen;
  return { inFrontMatter: false, from, to, leadSep: prev, trailSep: next };
}

// Insert a new slide after the current one, parking the cursor on its (empty)
// body line. `className` of '' / 'none' omits the `_class` directive.
export function insertSlideAfter(view, className) {
  const state = view.state;
  const pos = state.selection.main.head;
  const scan = scanSlides(state);
  const slide = slideAt(state, pos, scan);
  const at = slide.inFrontMatter ? scan.fmEnd : slide.to;
  const docLen = scan.docLen;
  const cls = (className || '').trim();

  // Ensure we begin on a fresh line even if the doc doesn't end in a newline.
  const before = at > 0 ? state.sliceDoc(at - 1, at) : '\n';
  let head = '';
  if (before !== '\n') head += '\n';
  head += '\n---\n\n';
  if (cls && cls !== 'none') head += `<!-- _class: ${cls} -->\n\n`;

  const cursorPos = at + head.length;          // start of the new empty body line
  const trailer = at < docLen ? '\n\n' : '\n'; // keep a blank line before the next sep / EOF
  const insert = head + trailer;

  view.dispatch({
    changes: { from: at, insert },
    selection: EditorSelection.cursor(cursorPos),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

// Best-effort copy that works under WebView2's custom scheme: async Clipboard
// API first, synchronous execCommand textarea fallback otherwise.
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

export function writeClipboard(text) {
  let p = null;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      p = navigator.clipboard.writeText(text);
    }
  } catch (_) {
    p = null;
  }
  if (p && typeof p.then === 'function') {
    return p.then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

// Copy the current slide (leading separator included) to the clipboard.
// No-op (false) when the cursor is in the front-matter.
export function copySlide(view) {
  const state = view.state;
  const slide = slideAt(state, state.selection.main.head);
  if (slide.inFrontMatter) return Promise.resolve(false);
  const text = state.sliceDoc(slide.from, slide.to);
  return writeClipboard(text);
}

// Cut the current slide: copy it, then delete it together with one separator so
// the deck isn't left with a dangling `---`.
export function cutSlide(view) {
  const state = view.state;
  const scan = scanSlides(state);
  const slide = slideAt(state, state.selection.main.head, scan);
  if (slide.inFrontMatter) return Promise.resolve(false);
  const docLen = scan.docLen;
  const text = state.sliceDoc(slide.from, slide.to);

  let delFrom;
  let delTo;
  if (slide.leadSep) {
    // Drop this slide and its own leading separator; the next slide keeps its.
    delFrom = slide.leadSep.from;
    delTo = slide.trailSep ? slide.trailSep.from : docLen;
  } else if (slide.trailSep) {
    // First slide (no leading sep): drop through the trailing separator + its
    // newline so the following slide becomes a clean first slide.
    delFrom = slide.from;
    delTo = Math.min(docLen, slide.trailSep.to + 1);
  } else {
    // Only slide in the deck — clear its content, keep the front-matter.
    delFrom = slide.from;
    delTo = docLen;
  }

  return writeClipboard(text).then((ok) => {
    view.dispatch({
      changes: { from: delFrom, to: delTo, insert: '' },
      selection: EditorSelection.cursor(delFrom),
      userEvent: 'delete',
    });
    view.focus();
    return ok;
  });
}

// Non-Vim keybindings (added to the editor's keymap.of([...]) before the
// default keymap). Mod-Alt-n / -c / -x don't collide with existing bindings.
export function marpSlideKeymap({ onInsert, onCopy, onCut }) {
  return [
    { key: 'Mod-Alt-n', preventDefault: true, run: () => { onInsert(); return true; } },
    { key: 'Mod-Alt-c', preventDefault: true, run: () => { onCopy(); return true; } },
    { key: 'Mod-Alt-x', preventDefault: true, run: () => { onCut(); return true; } },
  ];
}

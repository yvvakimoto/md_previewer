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
import {
  FM_RE,
  scanSeparators,
  unitAt,
  unitDeleteRange,
  padInsert,
} from './mdBlocks.js';

// The `---` scanning primitives moved to mdBlocks.js so the Jupyter-style cell
// feature could share them (a generic layer must not depend on this Marp-specific
// one). Re-exported under the original names — callers are unchanged.
export { scanSeparators as scanSlides, unitAt as slideAt };

// Classes offered in the insert picker. split-2/3/4 are deliberately omitted to
// keep the grid small; the renderer supports them, and frontMatterComplete.js
// already offers the full set for a hand-typed `_class:` line.
export const SLIDE_CLASSES = ['none', 'title', 'section', 'lead', 'invert', 'split'];

// Mirror of isMarpDocument() in assets/index.html — keep the two in sync.
export function isMarpDocument(text) {
  const m = FM_RE.exec(text);
  if (!m || m.index !== 0) return false;
  return /^\s*marp\s*:\s*true\s*$/m.test(m[1]);
}

// Insert a new slide after the current one, parking the cursor on its (empty)
// body line. `className` of '' / 'none' omits the `_class` directive.
export function insertSlideAfter(view, className) {
  const state = view.state;
  const pos = state.selection.main.head;
  const scan = scanSeparators(state);
  const slide = unitAt(state, pos, scan);
  const at = slide.inFrontMatter ? scan.fmEnd : slide.to;
  const cls = (className || '').trim();

  // The slide's own text: separator, blank, optional directive + blank. The empty
  // body line the cursor lands on is produced by padInsert's trailing newlines.
  let body = '---\n\n';
  if (cls && cls !== 'none') body += `<!-- _class: ${cls} -->\n\n`;
  const { insert, bodyOffset } = padInsert(state, at, body);

  view.dispatch({
    changes: { from: at, insert },
    selection: EditorSelection.cursor(at + bodyOffset + body.length),
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
  const slide = unitAt(state, state.selection.main.head);
  if (slide.inFrontMatter) return Promise.resolve(false);
  const text = state.sliceDoc(slide.from, slide.to);
  return writeClipboard(text);
}

// Cut the current slide: copy it, then delete it together with one separator so
// the deck isn't left with a dangling `---`.
export function cutSlide(view) {
  const state = view.state;
  const scan = scanSeparators(state);
  const slide = unitAt(state, state.selection.main.head, scan);
  if (slide.inFrontMatter) return Promise.resolve(false);
  const text = state.sliceDoc(slide.from, slide.to);
  const { from: delFrom, to: delTo } = unitDeleteRange(slide, slide, scan.docLen);

  return writeClipboard(text).then((ok) => {
    view.dispatch({
      changes: { from: delFrom, to: delTo, insert: '' },
      selection: EditorSelection.cursor(delFrom),
      // NOT 'delete': @codemirror/commands' joinableUserEvent is
      // /^(input\.type|delete)($|\.)/, so a 'delete' userEvent lets two cuts of
      // adjacent ranges within newGroupDelay collapse into one undo step.
      userEvent: 'slide.cut',
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

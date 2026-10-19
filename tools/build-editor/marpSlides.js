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
//   - insertSlideTemplate(view, tpl, p) — a ready-made slide (SLIDE_TEMPLATES).
//   - insertDeckTemplate(view, opts, p) — make the document a Marp deck.
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

// ── Templates ────────────────────────────────────────────────────────────────
// A template body marks the selection with CARET: one marker is a caret, two
// select the placeholder between them so typing replaces it.
export const CARET = '‸';

// Ready-made slides offered in the insert picker under the bare classes. `id` is
// data (never a label — #15); the button text is t('ed.tpl.<id>') and the
// placeholder copy is resolved at insert time so it follows the UI language.
// `path: true` re-opens completion after insert (the caret is inside `![](…)`).
export const SLIDE_TEMPLATES = [
  { id: 'title',   cls: 'title',   body: (p) => `# ${CARET}${p('title')}${CARET}\n\n## ${p('subtitle')}` },
  { id: 'section', cls: 'section', body: (p) => `## ${p('part')}\n\n# ${CARET}${p('chapter')}${CARET}` },
  { id: 'bullets', cls: '',        body: (p) => `## ${CARET}${p('heading')}${CARET}\n\n- ${p('item')} 1\n- ${p('item')} 2\n- ${p('item')} 3` },
  { id: 'split',   cls: 'split',   body: (p) => `## ${CARET}${p('heading')}${CARET}\n\n${p('left')}\n\n+++\n\n${p('right')}` },
  { id: 'image',   cls: '',        body: (p) => `## ${p('heading')}\n\n![](${CARET})`, path: true },
  { id: 'end',     cls: 'lead',    body: (p) => `# ${CARET}${p('thanks')}${CARET}` },
];

// Strip the markers from `text`; return the clean text and the selection
// offsets within it ({anchor, head}, equal for a bare caret; null if unmarked).
export function takeCaret(text) {
  const a = text.indexOf(CARET);
  if (a < 0) return { text, sel: null };
  const rest = text.slice(0, a) + text.slice(a + 1);
  const b = rest.indexOf(CARET);
  if (b < 0) return { text: rest, sel: { anchor: a, head: a } };
  return { text: rest.slice(0, b) + rest.slice(b + 1), sel: { anchor: a, head: b } };
}

// Pure planner: insert template `tpl` (resolved through `p`) as a new slide
// after the one under `pos`. Returns { changes, anchor, head } in post-change
// coordinates. Same placement rules as insertSlideAfter().
export function planSlideTemplate(state, pos, tpl, p) {
  const scan = scanSeparators(state);
  const slide = unitAt(state, pos, scan);
  const at = slide.inFrontMatter ? scan.fmEnd : slide.to;
  let head = '---\n\n';
  if (tpl.cls) head += `<!-- _class: ${tpl.cls} -->\n\n`;
  const { text, sel } = takeCaret(tpl.body(p));
  const { insert, bodyOffset } = padInsert(state, at, head + text);
  const base = at + bodyOffset + head.length;
  const s = sel || { anchor: text.length, head: text.length };
  return { changes: { from: at, insert }, anchor: base + s.anchor, head: base + s.head };
}

export function insertSlideTemplate(view, tpl, p) {
  const plan = planSlideTemplate(view.state, view.state.selection.main.head, tpl, p);
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.single(plan.anchor, plan.head),
    scrollIntoView: true,
    userEvent: 'slide.template',
  });
  view.focus();
}

// Pure planner for the deck template: turn the document into a Marp deck.
//   - no leading front-matter → prepend one (marp / theme / paginate);
//   - front-matter present    → set `marp: true` (rewriting a `marp:` line that
//     says otherwise) and add `theme:` / `paginate:` only where absent — keys
//     the author already wrote are never touched;
//   - empty body              → also fill it with a starter deck
//     (title, bullets, closing slide), selecting the title placeholder.
// A non-empty body is kept as is: it simply becomes the deck's slides.
// `theme` '' omits the theme line. Returns { changes, anchor, head }.
export function planDeckTemplate(state, { theme = '', paginate = true } = {}, p) {
  const text = state.doc.toString();
  const changes = [];
  let bodyStart = 0;   // in original coordinates
  let shift = 0;       // characters inserted before bodyStart
  const want = (has, line) => (has ? '' : line + '\n');

  const fm = FM_RE.exec(text);
  if (fm && fm.index === 0) {
    const openerLen = fm[0].indexOf('\n') + 1;
    const yaml = fm[1];
    const marpLine = /^[ \t]*marp[ \t]*:.*$/m.exec(yaml);
    if (marpLine && !/^\s*marp\s*:\s*true\s*$/.test(marpLine[0])) {
      const from = openerLen + marpLine.index;
      changes.push({ from, to: from + marpLine[0].length, insert: 'marp: true' });
      shift += 'marp: true'.length - marpLine[0].length;
    }
    const add = want(!!marpLine, 'marp: true')
      + (theme ? want(/^[ \t]*theme[ \t]*:/m.test(yaml), `theme: ${theme}`) : '')
      + (paginate ? want(/^[ \t]*paginate[ \t]*:/m.test(yaml), 'paginate: true') : '');
    if (add) {
      // Start of the closing `---` line. FM_RE always has a newline between the
      // YAML group and the closer, even when the group is empty.
      const at = openerLen + yaml.length + 1;
      changes.push({ from: at, insert: add });
      shift += add.length;
    }
    bodyStart = fm[0].length;
  } else {
    const head = '---\nmarp: true\n'
      + (theme ? `theme: ${theme}\n` : '')
      + (paginate ? 'paginate: true\n' : '')
      + '---\n\n';
    changes.push({ from: 0, insert: head });
    shift += head.length;
  }

  if (text.slice(bodyStart).trim() !== '') {
    const at = bodyStart + shift;
    return { changes, anchor: at, head: at };
  }
  // Empty body: replace whatever whitespace is there with the starter deck.
  const deck = [
    `<!-- _class: title -->\n\n# ${CARET}${p('title')}${CARET}\n\n## ${p('subtitle')}`,
    `## ${p('heading')}\n\n- ${p('item')} 1\n- ${p('item')} 2\n- ${p('item')} 3`,
    `<!-- _class: lead -->\n\n# ${p('thanks')}`,
  ].join('\n\n---\n\n');
  const { text: body, sel } = takeCaret(deck);
  let lead = '';
  if (bodyStart > 0) {
    lead = fm[2] ? '\n' : '\n\n';  // closer with / without its own newline
    changes.push({ from: bodyStart, to: text.length, insert: lead + body + '\n' });
  } else {
    // No front-matter: one change for the whole (blank) document, so the
    // prepended header and the deck never meet at the same position.
    const head = changes.pop().insert;
    changes.push({ from: 0, to: text.length, insert: head + body + '\n' });
  }
  const base = bodyStart + shift + lead.length;
  return { changes, anchor: base + sel.anchor, head: base + sel.head };
}

export function insertDeckTemplate(view, opts, p) {
  const plan = planDeckTemplate(view.state, opts, p);
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.single(plan.anchor, plan.head),
    scrollIntoView: true,
    userEvent: 'slide.deck',
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

// Markdown block-structure primitives shared by the editor's Marp-slide and
// Jupyter-style cell features.
//
// Both features answer the same question — "where are the `---` boundaries, and
// which unit does this position belong to?" — so the scanner lives here once
// instead of in the Marp-specific module. marpSlides.js re-exports scanSlides /
// slideAt from here as aliases, so its public surface is unchanged.
//
// ⚠️ SYNC OBLIGATION. There are three implementations of this rule and they must
// agree, or editor cell N stops being preview slide N:
//   1. this file
//   2. assets/index.html — SLIDE_SEP_RE (~4654), __makeMdLineScanner (~4662) and
//      the slideStartLines scan in renderMarp() (~6902)
//   3. marp-core / markdown-it itself, which is the ground truth
// makeLineScanner() below is a direct port of (2)'s __makeMdLineScanner.

const SEP_RE = /^(---|\*\*\*|___)\s*$/;
const FM_DELIM_RE = /^---\s*$/;
// The delimiter lines allow trailing spaces/tabs but the character classes must
// NOT be `\s*`: `\s` matches newlines, so a greedy `\s*` before `(\n|$)` swallows
// the BLANK LINE after the closing `---` and inflates fmEnd by a line. That made
// this scanner's front-matter end disagree with renderMarp()'s (which uses
// `__curStart = i + 2`, i.e. the line right after the closing delimiter), so a
// cell inserted at the top of a deck was absorbed back into the front matter.
// Which documents match is unchanged — only the match LENGTH — because group 1 is
// lazy and bounded by `\n---`, so isMarpDocument() is unaffected.
const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/;
// A fence marker line: ```-or-more / ~~~-or-more, optionally indented. The FIRST
// CHARACTER is the marker kind, so ``` never closes a ~~~ block. (The naive
// `inFence = !inFence` toggle this replaces got that wrong, which desynchronized
// every `---` after a mixed-fence block.)
const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/;

export { SEP_RE, FM_RE, FM_DELIM_RE };

// Stateful single-forward-pass classifier over `lines`. Call step(i) at the
// cursor, in increasing order. Returns 'fm' | 'fm-close' | 'fence' | 'code' | 'body'.
// Port of __makeMdLineScanner in assets/index.html.
export function makeLineScanner(lines) {
  let inFm = lines.length > 0 && FM_DELIM_RE.test(lines[0]);
  let fmClosed = !inFm;
  let inFence = false;
  let fenceMarker = '';
  return {
    step(i) {
      const ln = lines[i];
      if (inFm && !fmClosed) {
        // i > 0: line 0 is the OPENING delimiter, not the close.
        if (i > 0 && FM_DELIM_RE.test(ln)) { fmClosed = true; return 'fm-close'; }
        return 'fm';
      }
      const m = ln.match(FENCE_RE);
      if (m) {
        const marker = m[2][0]; // ` or ~
        if (!inFence) { inFence = true; fenceMarker = marker; }
        else if (marker === fenceMarker) { inFence = false; fenceMarker = ''; }
        return 'fence';
      }
      return inFence ? 'code' : 'body';
    },
  };
}

// Is `text` a plain paragraph line — i.e. can a following `---` be a setext <h2>
// underline rather than a thematic break?
//
// This is the setext guard, and it is the reason cell operations are safe. In
// CommonMark a `---` directly after paragraph text underlines it as an <h2>;
// marp-core/markdown-it therefore does NOT split there. Treating such a line as
// a boundary makes a cut/split edit at a position the renderer never split at
// (silently merging two slides), and on the preview side it inserts a phantom
// entry into slideStartLines that shifts every following slide's data-line.
//
// Only a `-` run can be a setext underline; `***` and `___` never can.
//
// Lines that are NOT paragraph text (so a following `---` IS a thematic break),
// each verified against the CommonMark spec:
//   blank, ATX heading, another thematic break, blockquote marker, list marker,
//   HTML/directive open. A fence marker is excluded by the caller, which only
//   consults this for lines the scanner classified as 'body'.
function isParagraphLine(text) {
  if (!text || !text.trim()) return false;
  if (SEP_RE.test(text)) return false;
  if (/^\s{0,3}#{1,6}(\s|$)/.test(text)) return false;          // ATX heading
  if (/^\s{0,3}>/.test(text)) return false;                     // blockquote
  if (/^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(text)) return false; // list item
  if (/^\s{0,3}</.test(text)) return false;                     // HTML block
  return true;
}

// Does line `i` of `lines` open a new unit? Standalone predicate (rescans from
// the top, so O(i)) — the hot paths use scanSeparators() instead.
export function isSeparatorLine(lines, i) {
  if (i < 0 || i >= lines.length) return false;
  const scan = makeLineScanner(lines);
  let prevWasParagraph = false;
  for (let k = 0; k <= i; k++) {
    const kind = scan.step(k);
    const text = lines[k];
    const isSep = kind === 'body' && SEP_RE.test(text) &&
      !(text[0] === '-' && prevWasParagraph);
    if (k === i) return isSep;
    prevWasParagraph = kind === 'body' && !isSep && isParagraphLine(text);
  }
  return false;
}

// One forward pass: locate front-matter and every unit separator, skipping
// front-matter lines, fenced code, and setext underlines. Returns
//   { fmEnd, fmLastLine, seps: [{line, from, to}], docLen }
// fmEnd is the char offset just past the front-matter block (0 if none).
export function scanSeparators(state) {
  const text = state.doc.toString();
  let fmEnd = 0;
  let fmLastLine = 0;
  const fm = FM_RE.exec(text);
  if (fm && fm.index === 0) {
    fmEnd = fm[0].length;
    fmLastLine = state.doc.lineAt(Math.max(0, fmEnd - 1)).number;
  }
  const lines = text.split('\n');
  const scan = makeLineScanner(lines);
  const seps = [];
  let prevWasParagraph = false;
  for (let i = 0; i < lines.length; i++) {
    const kind = scan.step(i);
    const ln = lines[i];
    const lineNo = i + 1; // doc lines are 1-based
    let isSep = kind === 'body' && SEP_RE.test(ln) &&
      !(ln[0] === '-' && prevWasParagraph);
    // Front-matter (including its own `---` delimiters) is never a boundary.
    if (isSep && lineNo <= fmLastLine) isSep = false;
    if (isSep) {
      const dl = state.doc.line(lineNo);
      seps.push({ line: lineNo, from: dl.from, to: dl.to });
    }
    prevWasParagraph = kind === 'body' && !isSep && isParagraphLine(ln);
  }
  return { fmEnd, fmLastLine, seps, docLen: state.doc.length };
}

// The unit containing `pos`. A unit spans from its leading separator (which
// belongs to the unit it introduces) to the next separator. The first unit has
// no leading separator and starts right after the front-matter.
export function unitAt(state, pos, scan) {
  scan = scan || scanSeparators(state);
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

// The range to delete so that units [first..last] disappear WITHOUT leaving a
// dangling separator. Shared by marpSlides.cutSlide and cells.planDelete — the
// three cases below are the whole reason separator hygiene works, so they live in
// exactly one place. `first` / `last` are unitAt()-shaped ({from, leadSep,
// trailSep}); pass the same object twice for a single unit.
export function unitDeleteRange(first, last, docLen) {
  if (first.leadSep) {
    // Drop these units and their own leading separator; the next unit keeps its.
    return { from: first.leadSep.from, to: last.trailSep ? last.trailSep.from : docLen };
  }
  if (last.trailSep) {
    // First unit (no leading sep): drop through the trailing separator + its
    // newline so the following unit becomes a clean first unit.
    return { from: first.from, to: Math.min(docLen, last.trailSep.to + 1) };
  }
  // Only unit in the document — clear its content, keep any front-matter.
  return { from: first.from, to: docLen };
}

// Count trailing '\n' in the document before `at`.
function trailingNewlines(state, at) {
  let n = 0;
  while (n < at && state.sliceDoc(at - n - 1, at - n) === '\n') n++;
  return n;
}

// Newlines to prepend at `at` so an inserted block starts on a fresh line with
// exactly one blank line above it (nothing when `at` is the start of the doc).
// This is what keeps INV1 — every `---` we write is preceded by a blank line, so
// cell-mode-authored documents can never create the setext ambiguity above.
export function leadPad(state, at) {
  if (at <= 0) return '';
  const n = trailingNewlines(state, at);
  if (n >= 2) return '';
  if (n === 1) return at === 1 ? '' : '\n'; // a lone leading '\n' is already blank space
  return '\n\n';
}

// Newlines to append so what follows `at` is separated by exactly one blank
// line, or a single trailing newline at EOF.
export function tailPad(state, at) {
  const docLen = state.doc.length;
  if (at >= docLen) return '\n';
  return state.sliceDoc(at, at + 1) === '\n' ? '\n' : '\n\n';
}

// Wrap `body` in the padding needed to splice it in at `at`.
// Returns { insert, bodyOffset } where bodyOffset is the offset of body[0]
// within `insert` — add your own intra-body offset to place the cursor.
export function padInsert(state, at, body) {
  const lead = leadPad(state, at);
  const tail = tailPad(state, at);
  return { insert: lead + body + tail, bodyOffset: lead.length };
}

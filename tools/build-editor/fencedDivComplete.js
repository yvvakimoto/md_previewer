// Pandoc-style fenced-div completion for ::: blocks.
//
// Mirrors texEnvComplete.js (\begin{...} → \end{...}): typing `:::` at the
// start of a line offers the recognized fenced-div keywords, and picking one
// inserts the matching closing `:::` (plus `+++` dividers for columns layouts),
// parking the cursor on the first body line. Works in any markdown document.

// Each entry: keyword + how many `+++` column dividers its template carries.
// alignment / message blocks have no dividers; columns templates pre-seed the
// number of dividers implied by the layout (columns/columns-2 → 1, -3 → 2, -4 → 3).
const DIVS = [
  { name: 'center',    detail: 'align center',  dividers: 0 },
  { name: 'right',     detail: 'align right',   dividers: 0 },
  { name: 'left',      detail: 'align left',    dividers: 0 },
  { name: 'message',   detail: 'message box',   dividers: 0 },
  { name: 'vcenter',   detail: 'vertical center', dividers: 0 },
  { name: 'columns',   detail: '2-column',      dividers: 1 },
  { name: 'columns-2', detail: '2-column',      dividers: 1 },
  { name: 'columns-3', detail: '3-column',      dividers: 2 },
  { name: 'columns-4', detail: '4-column',      dividers: 3 },
];

function makeOption({ name, detail, dividers }) {
  return {
    label: name,
    type: 'keyword',
    detail,
    apply: (view, _completion, from, to) => {
      // Keep the leading `:::` the user already typed; replace the partial
      // keyword (from..to) with: <name>\n<blank body>\n[+++ blocks]:::
      // Insert a space before the keyword when the user triggered on a bare
      // `:::` with no separating whitespace, so the result is `::: center`.
      const prev = from > 0 ? view.state.doc.sliceString(from - 1, from) : ' ';
      const lead = /\s/.test(prev) ? '' : ' ';
      let body = '\n';                       // cursor lands on this blank line
      for (let i = 0; i < dividers; i++) body += '\n+++\n';
      const insert = `${lead}${name}${body}\n:::`;
      const cursor = from + lead.length + name.length + 1; // start of blank body line
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: cursor },
      });
    },
  };
}

const OPTIONS = DIVS.map(makeOption);

// Open / close detection for the closing-context guard.
const OPEN_RE = /^:::+[ \t]*(center|centre|right|left|message|vcenter|columns(?:-[234])?)[ \t]*$/i;
const CLOSE_RE = /^:::+[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

// True when `lineNumber` sits inside an unclosed fenced-div opened above it —
// i.e. a bare `:::` typed here is meant as the *closing* fence, so we should
// not pop up the keyword menu (Enter would otherwise accept the first option).
function inOpenFencedDiv(state, lineNumber) {
  let depth = 0;
  let inFence = false;
  for (let i = 1; i < lineNumber; i++) {
    const text = state.doc.line(i).text;
    if (FENCE_RE.test(text)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (OPEN_RE.test(text)) depth++;
    else if (CLOSE_RE.test(text)) depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

export function fencedDivCompletionSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);
  // Line must start with `:::` (no leading whitespace — matches the renderer),
  // optionally followed by a partial keyword.
  const m = /^:::+[ \t]*([a-z0-9-]*)$/i.exec(before);
  if (!m) return null;

  // Bare `:::` with no partial keyword, sitting inside an open block → this is
  // a closing fence; suppress the menu so Enter doesn't insert a keyword.
  if (m[1] === '' && inOpenFencedDiv(context.state, line.number)) return null;

  const from = context.pos - m[1].length; // replace just the partial keyword
  return {
    from,
    to: context.pos,
    options: OPTIONS,
    validFor: /^[a-z0-9-]*$/,
  };
}

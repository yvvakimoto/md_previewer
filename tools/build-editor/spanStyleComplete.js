// Completion for the inline styled-span syntax: [text]{key=value …}
//
// Mirrors fencedDivComplete.js. Fires only when the cursor sits inside an open
// `]{ … }` brace. Two modes:
//   - key mode  (token has no `=`):  offers color= / size= / font= / bg= /
//                                    weight= / valign=
//   - value mode (token is key=…):   offers values for that key (color names,
//                                    size keywords, font shorthands, …)
// Returns null when not inside a styled-span brace, so links / paths / other
// completion sources are unaffected.

// Recognized keys (canonical name + short form) and their UI detail.
const KEYS = [
  { name: 'color',  detail: '文字色' },
  { name: 'size',   detail: '文字サイズ' },
  { name: 'font',   detail: 'フォント' },
  { name: 'bg',     detail: '背景色' },
  { name: 'weight', detail: '文字の太さ' },
  { name: 'valign', detail: '縦位置(ベースライン)' },
];

const KEY_OPTIONS = KEYS.map(k => ({
  label: k.name,
  type: 'property',
  detail: k.detail,
  apply: k.name + '=', // park the cursor right after `=` for value completion
}));

// Short / alias forms → canonical key used to pick the value list.
const CANON = {
  color: 'color', c: 'color',
  size: 'size', s: 'size',
  font: 'font', f: 'font',
  bg: 'bg', background: 'bg',
  weight: 'weight', w: 'weight',
  valign: 'valign', v: 'valign',
};

function values(list, type) {
  return list.map(v => ({ label: v, type: type || 'constant' }));
}

// Representative value menus (the syntax also accepts raw values like #e91e63,
// 1.4em, 120%, or any font-family name — those are just typed directly).
//
// The keyword lists must stay a subset of what buildSpanStyle() accepts —
// SPAN_SIZE_KW / SPAN_WEIGHT_KW / SPAN_FONT_STACK / SPAN_VALIGN_KW in
// assets/index.html. This bundle is a separate esbuild artifact and cannot import
// from there, so: when adding a keyword to buildSpanStyle, add it here too.
// `2xl` is listed alongside its `xxl` synonym because it is the Tailwind-style
// name a user is likely to *try* typing, so prefix-completing it is worth the
// duplicate row.
const VALUE_OPTIONS = {
  color: values(['red', 'crimson', 'orange', 'gold', 'green', 'teal', 'blue',
    'navy', 'purple', 'magenta', 'gray', 'black', 'white']),
  bg: values(['yellow', 'lightyellow', 'lightblue', 'lightgreen', 'pink',
    'lavender', 'gold', 'gray', 'black', 'white']),
  size: values(['xs', 'sm', 'small', 'md', 'normal', 'lg', 'large', 'xl', 'xxl', '2xl'], 'keyword'),
  font: values(['serif', 'sans', 'mono'], 'keyword'),
  weight: values(['thin', 'light', 'normal', 'medium', 'semibold', 'bold', 'black'], 'keyword'),
  valign: values(['middle', 'center', 'bottom', 'top', 'baseline', 'sub', 'super'], 'keyword'),
};

export function spanStyleCompletionSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);

  // Must sit inside the most-recent `]{ … }` that is still open before the cursor.
  const open = before.lastIndexOf(']{');
  if (open < 0) return null;
  const inside = before.slice(open + 2);
  if (inside.indexOf('}') >= 0) return null; // brace already closed before cursor

  // Current token = text after the last whitespace inside the brace.
  const tokMatch = /(?:^|\s)([^\s]*)$/.exec(inside);
  const token = tokMatch ? tokMatch[1] : inside;
  const eq = token.indexOf('=');

  if (eq < 0) {
    // Key mode — complete the attribute name.
    const from = context.pos - token.length;
    return { from, to: context.pos, options: KEY_OPTIONS, validFor: /^[a-z]*$/i };
  }

  // Value mode — complete the value for the typed key.
  const key = CANON[token.slice(0, eq).toLowerCase()];
  const opts = key && VALUE_OPTIONS[key];
  if (!opts) return null;
  const valPartial = token.slice(eq + 1);
  const from = context.pos - valPartial.length;
  return { from, to: context.pos, options: opts, validFor: /^[\w#%.-]*$/ };
}

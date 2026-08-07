// Completion for YAML front-matter keys/values.
//
// Mirrors spanStyleComplete.js (key mode vs value mode) and fencedDivComplete.js
// (return shape). Fires ONLY when the cursor sits inside the leading
// `---\n … \n---` front-matter block (line 1 is the opening `---`, and the
// cursor is above the closing fence). Returns null everywhere else so the
// `:::` / `]{}` / `\begin{}` / path completion sources are unaffected.
//
// Key candidates are split by whether the block already declares `marp: true`:
//   - always:            marp / confidential / watermark / title
//   - Marp docs only:    theme / paginate / header / footer / size / class /
//                        _class / backgroundColor / backgroundImage / color /
//                        style / math
// Value candidates are offered for the enum-like keys (see VALUE_OPTIONS);
// free-text keys (header/footer/title/style/color/class) yield no value menu.

import { startCompletion } from '@codemirror/autocomplete';

// marp-core built-in themes; user themes (assets/marp/*.css @theme names) are
// injected by the Rust host as window.__marpUserThemes at editor spawn time.
const BUILTIN_THEMES = ['default', 'gaia', 'uncover'];

// _class values: the editor picker set (marpSlides.js SLIDE_CLASSES, minus the
// synthetic 'none') plus the split-N layouts supported when typed by hand.
const CLASS_VALUES = ['title', 'section', 'lead', 'invert', 'split', 'split-2', 'split-3', 'split-4'];

// Keys offered in every document.
const COMMON_KEYS = [
  { name: 'marp', detail: 'Marpスライドモード (true)' },
  { name: 'confidential', detail: '機密透かし (true)' },
  { name: 'watermark', detail: '背景透かし文字 (任意文字列, 例: DRAFT)' },
  { name: 'title', detail: 'タイトル (メタ情報・任意)' },
];

// Keys offered only once `marp: true` is present.
const MARP_KEYS = [
  { name: 'theme', detail: 'スライドテーマ' },
  { name: 'paginate', detail: 'ページ番号 (true/false)' },
  { name: 'header', detail: 'ヘッダー (全スライド)' },
  { name: 'footer', detail: 'フッター (全スライド)' },
  { name: 'size', detail: 'スライド比率 (16:9 / 4:3)' },
  { name: 'class', detail: 'スライドクラス' },
  { name: '_class', detail: 'スライドクラス (このスライドのみ)' },
  { name: 'backgroundColor', detail: '背景色 (CSS color)' },
  { name: 'backgroundImage', detail: '背景画像 (url(...))' },
  { name: 'color', detail: '文字色 (CSS color)' },
  { name: 'style', detail: '追加CSS' },
  { name: 'math', detail: '数式エンジン (katex/mathjax)' },
];

// Keys whose value list is worth re-triggering completion for after the `: `.
const ENUM_KEYS = new Set(['marp', 'confidential', 'paginate', 'size', 'math', 'theme', '_class']);

function makeKeyOption({ name, detail }) {
  return {
    label: name,
    type: 'property',
    detail,
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert: name + ': ' },
        selection: { anchor: from + name.length + 2 },
      });
      // Immediately offer the value list for enum-like keys.
      if (ENUM_KEYS.has(name)) setTimeout(() => startCompletion(view), 0);
    },
  };
}

function values(list, type) {
  return list.map(v => ({ label: v, type: type || 'constant' }));
}

// Static value menus per key. `theme` is dynamic (built-ins + user themes) so
// it is built at call time instead.
const VALUE_OPTIONS = {
  marp: values(['true'], 'keyword'),
  confidential: values(['true'], 'keyword'),
  paginate: values(['true', 'false'], 'keyword'),
  size: values(['16:9', '4:3'], 'keyword'),
  math: values(['katex', 'mathjax'], 'keyword'),
  _class: values(CLASS_VALUES, 'keyword'),
};

function themeValues() {
  const user = Array.isArray(window.__marpUserThemes) ? window.__marpUserThemes : [];
  const seen = new Set();
  const merged = [];
  for (const t of [...BUILTIN_THEMES, ...user]) {
    if (typeof t === 'string' && t && !seen.has(t)) { seen.add(t); merged.push(t); }
  }
  return values(merged, 'keyword');
}

// Locate the leading front-matter block. Returns { closeLine } (1-based line
// number of the closing fence, or null if not yet typed) when line 1 opens a
// front-matter block, else null.
function frontMatterBounds(doc) {
  if (!/^---\s*$/.test(doc.line(1).text)) return null;
  for (let i = 2; i <= doc.lines; i++) {
    if (/^(---|\.\.\.)\s*$/.test(doc.line(i).text)) return { closeLine: i };
  }
  return { closeLine: null };
}

export function frontMatterCompletionSource(context) {
  const doc = context.state.doc;
  const bounds = frontMatterBounds(doc);
  if (!bounds) return null;

  const line = doc.lineAt(context.pos);
  // Cursor must be strictly inside the block: below the opening fence (line 1)
  // and above the closing fence (if any).
  if (line.number < 2) return null;
  if (bounds.closeLine !== null && line.number >= bounds.closeLine) return null;

  const before = doc.sliceString(line.from, context.pos);
  const colon = before.indexOf(':');

  if (colon < 0) {
    // Key mode — the text so far must look like the start of a key (optional
    // leading whitespace + word chars), else bail (e.g. a value spilling over).
    const m = /^(\s*)([A-Za-z_][\w-]*)?$/.exec(before);
    if (!m) return null;
    const partial = m[2] || '';

    // Marp gating: offer the Marp-only keys once the block declares marp: true.
    const fmEnd = bounds.closeLine !== null ? doc.line(bounds.closeLine).from : doc.length;
    const fmText = doc.sliceString(doc.line(2).from, fmEnd);
    const isMarp = /^\s*marp\s*:\s*true\s*$/m.test(fmText);

    const keys = isMarp ? [...COMMON_KEYS, ...MARP_KEYS] : COMMON_KEYS;
    return {
      from: context.pos - partial.length,
      to: context.pos,
      options: keys.map(makeKeyOption),
      validFor: /^[\w-]*$/,
    };
  }

  // Value mode — complete the value for the typed key.
  const key = before.slice(0, colon).trim();
  const opts = key === 'theme' ? themeValues() : VALUE_OPTIONS[key];
  if (!opts || !opts.length) return null;

  const valPartial = before.slice(colon + 1).replace(/^\s*/, '');
  return {
    from: context.pos - valPartial.length,
    to: context.pos,
    options: opts,
    validFor: /^[\w:.\/-]*$/,
  };
}

// True when the cursor sits on a *blank* front-matter field — a key line with
// nothing typed yet, or a `key:` line whose value is still empty and has an
// option menu (marp/theme/paginate/size/math/_class/confidential). Used by the
// editor to auto-open the completion popup so the available options are
// presented without the user needing to type anything or know them in advance.
// (`from === to` means the source found options but no partial text to replace,
// i.e. the field is blank; a partial being typed is left to activateOnTyping.)
export function frontMatterBlankFieldAt(state, pos) {
  const res = frontMatterCompletionSource({ state, pos });
  return !!res && res.from === res.to;
}

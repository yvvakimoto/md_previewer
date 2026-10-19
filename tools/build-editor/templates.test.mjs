// Tests for the insert-template features. Plain node, no browser, no bundle:
//   cd tools/build-editor && node templates.test.mjs
//
// Same conventions as cells.test.mjs. Covers the pure halves only:
//   - fenceTemplateContext / fenceInfoAt  (fenceTemplateComplete.js)
//   - pathContextAt                        (pathComplete.js)
//   - planSlideTemplate / planDeckTemplate (marpSlides.js)

import { EditorState } from '@codemirror/state';
import { fenceTemplateContext, fenceInfoAt } from './fenceTemplateComplete.js';
import { pathContextAt } from './pathComplete.js';
import {
  planSlideTemplate, planDeckTemplate, SLIDE_TEMPLATES, isMarpDocument, takeCaret, CARET,
} from './marpSlides.js';

const mk = (doc) => EditorState.create({ doc });
// `|` in a fixture marks the cursor.
const at = (src) => { const pos = src.indexOf('|'); return { st: mk(src.replace('|', '')), pos }; };

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log('ok   ' + label); return true; }
  console.log('FAIL ' + label + '\n       got  ' + g + '\n       want ' + w);
  fail++;
  return false;
}

const apply = (st, plan) => st.update({ changes: plan.changes }).state.doc.toString();
const sel = (st, plan) => apply(st, plan).slice(plan.anchor, plan.head);
const ph = (k) => `<${k}>`;

console.log('── fenceTemplateContext ──');
{
  const langs = (src) => { const { st, pos } = at(src); const c = fenceTemplateContext(st, pos); return c && c.langs; };
  eq('bare ``` offers the plain block first, then every template', langs('```|')[0], '');
  eq('bare ``` lists plotly', langs('```|').includes('plotly'), true);
  eq('```p → plain first, then plotly (prefix only)', langs('```p|'), ['', 'plotly']);
  eq('```m → mermaid / model3d / markwhen (template order)', langs('```m|'), ['', 'mermaid', 'model3d', 'markwhen']);
  eq('exact name goes first, no plain entry', langs('```tikz|'), ['tikz', 'tikzcd']);
  eq('```py → no popup (fuzzy would have offered plotly)', langs('```py|'), null);
  eq('```js → no popup', langs('```js|'), null);
  eq('~~~ also triggers', langs('~~~mer|'), ['', 'mermaid']);
  eq('closing fence of an open block → nothing', langs('```js\nx\n```|'), null);
  eq('inside a closed block body → nothing', langs('```js\n```|\n```'), null);
  eq('opener of an already-closed block → nothing', langs('```|\nx\n```\n'), null);
  eq('new opener above complete blocks → offered', langs('```p|\n\n```js\nx\n```\n') !== null, true);
  eq('cursor not at end of line → nothing', langs('```|p'), null);
  eq('4-space indent is code, not a fence', langs('    ```|'), null);
  {
    const { st, pos } = at('  ````|');
    eq('closing fence keeps indent and length', fenceTemplateContext(st, pos).fence, '  ````');
  }
  eq('front-matter `---` lines do not confuse the scan', langs('---\na: 1\n---\n```|') !== null, true);
}

console.log('\n── fenceInfoAt ──');
{
  const info = (src) => { const { st, pos } = at(src); const f = fenceInfoAt(st, pos); return f && [f.lang, f.openLine]; };
  eq('inside plotly body', info('text\n```plotly\nfile: |\n```'), ['plotly', 2]);
  eq('outside any fence', info('```plotly\nfile: x\n```\n|'), null);
  eq('lang is lower-cased, attributes dropped', info('```Model3D {x}\n|\n```'), ['model3d', 1]);
  eq('a longer closer closes a shorter opener', info('```a\n````\n|'), null);
  eq('a shorter closer does not close', info('````a\n```\n|'), ['a', 1]);
}

console.log('\n── pathContextAt ──');
{
  const ctx = (src) => { const { st, pos } = at(src); return pathContextAt(st, pos); };
  const keeps = (src, name) => { const c = ctx(src); return !!c && c.keep(name); };
  eq('link target still works', ctx('[a](sub/fo|').partial, 'sub/fo');
  eq('image target keeps video, drops .md', [keeps('![a](|', 'x.mp4'), keeps('![a](|', 'x.md')], [true, false]);
  eq('plotly file: → partial', ctx('```plotly\nfile: data/sa|\n```').partial, 'data/sa');
  eq('plotly file: keeps csv/tsv only', [keeps('```plotly\nfile: |\n```', 'a.csv'), keeps('```plotly\nfile: |\n```', 'a.TSV'), keeps('```plotly\nfile: |\n```', 'a.stl')], [true, true, false]);
  eq('plotly other keys → nothing', ctx('```plotly\ntype: li|\n```'), null);
  eq('quoted value skips the quote', ctx('```plotly\nfile: "da|\n```').partial, 'da');
  eq('model3d file: keeps meshes', [keeps('```model3d\nfile: |\n```', 'a.glb'), keeps('```model3d\nfile: |\n```', 'a.csv')], [true, false]);
  eq('model3d mtl: keeps .mtl only', [keeps('```model3d\nfile: a.obj\nmtl: |\n```', 'a.mtl'), keeps('```model3d\nfile: a.obj\nmtl: |\n```', 'a.obj')], [true, false]);
  eq('model3d bare path on the first body line', ctx('```model3d\ndata/br|\n```').partial, 'data/br');
  eq('model3d bare path NOT on a later line', ctx('```model3d\ncolor: red\nda|\n```'), null);
  eq('file: in an unrelated fence → nothing', ctx('```yaml\nfile: |\n```'), null);
  eq('file: outside any fence → nothing', ctx('file: |'), null);
}

console.log('\n── takeCaret ──');
eq('one marker is a caret', takeCaret(`ab${CARET}c`), { text: 'abc', sel: { anchor: 2, head: 2 } });
eq('two markers select', takeCaret(`a${CARET}bc${CARET}d`), { text: 'abcd', sel: { anchor: 1, head: 3 } });

console.log('\n── planSlideTemplate ──');
{
  const tpl = (id) => SLIDE_TEMPLATES.find((x) => x.id === id);
  const doc = '---\nmarp: true\n---\n\n# One\n';
  const st = mk(doc);
  const plan = planSlideTemplate(st, st.doc.length - 2, tpl('title'), ph);
  eq('title template text', apply(st, plan), doc + '\n---\n\n<!-- _class: title -->\n\n# <title>\n\n## <subtitle>\n');
  eq('title placeholder is selected', sel(st, plan), '<title>');
  const p2 = planSlideTemplate(st, 0, tpl('split'), ph);
  eq('from the front-matter, inserts right after it', apply(st, p2).startsWith('---\nmarp: true\n---\n\n---\n\n<!-- _class: split -->\n\n## <heading>\n\n<left>\n\n+++\n\n<right>\n'), true);
  const p3 = planSlideTemplate(st, st.doc.length, tpl('image'), ph);
  const out3 = apply(st, p3);
  eq('image template parks the caret inside ![](…)', [p3.anchor === p3.head, out3.slice(p3.anchor - 4, p3.anchor + 1)], [true, '![]()']);
  eq('bullets has no class directive', apply(st, planSlideTemplate(st, st.doc.length, tpl('bullets'), ph)).includes('_class: \n'), false);
}

console.log('\n── planDeckTemplate ──');
{
  const run = (doc, opts) => { const st = mk(doc); const plan = planDeckTemplate(st, opts, ph); return { st, plan, out: apply(st, plan) }; };

  const a = run('', { theme: 'magenta', paginate: true });
  eq('empty doc → full deck', a.out.startsWith('---\nmarp: true\ntheme: magenta\npaginate: true\n---\n\n<!-- _class: title -->\n\n# <title>'), true);
  eq('empty doc → is a Marp document', isMarpDocument(a.out), true);
  eq('empty doc → title placeholder selected', sel(a.st, a.plan), '<title>');
  eq('empty doc → three slides', a.out.split('\n---\n').length - 1, 3);

  const b = run('# Notes\n\nbody\n', { theme: '', paginate: false });
  eq('body kept, front-matter prepended, no theme line', b.out, '---\nmarp: true\n---\n\n# Notes\n\nbody\n');
  eq('caret at the start of the old body', b.plan.anchor, '---\nmarp: true\n---\n\n'.length);

  const c = run('---\ntitle: x\ntheme: gaia\n---\n\nhello\n', { theme: 'magenta', paginate: true });
  eq('existing front-matter: add marp + paginate, keep author theme', c.out, '---\ntitle: x\ntheme: gaia\nmarp: true\npaginate: true\n---\n\nhello\n');

  const d = run('---\nmarp: false\n---\n', { theme: '', paginate: false });
  eq('marp: false is rewritten, empty body gets the deck', d.out.startsWith('---\nmarp: true\n---\n\n<!-- _class: title -->'), true);
  eq('marp: false → selection still on the title', sel(d.st, d.plan), '<title>');

  const e = run('---\nmarp: true\n---', { theme: 'x', paginate: true });
  eq('closer without newline at EOF', e.out.startsWith('---\nmarp: true\ntheme: x\npaginate: true\n---\n\n<!-- _class: title -->'), true);
  eq('closer without newline → selection on the title', sel(e.st, e.plan), '<title>');

  const f = run('---\n\n---\n', { theme: '', paginate: true });
  eq('empty YAML block gets the keys', f.out.startsWith('---\n\nmarp: true\npaginate: true\n---\n'), true);
}

console.log(fail ? `\n${fail} test(s) failed` : '\nall tests passed');
process.exit(fail ? 1 : 0);

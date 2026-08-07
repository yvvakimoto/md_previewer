// Tests for the table-paste state layer. Plain node, no browser, no bundle:
//   cd tools/build-editor && node tablePaste.test.mjs
//
// Same conventions as mdTable.test.mjs. Everything here is pure or
// EditorState-only; the DOM half (htmlTableToMatrix, the paste event, the
// Prec ordering vs. Vim) needs a real browser and lives in
// tools/preview-harness/pastecheck.py.
//
// The FALSE-POSITIVE cases are the point of this file. Ctrl+V converts
// automatically, so a predicate that is merely "usually right" would silently
// mangle pasted code — every reject case below is a paste that must survive
// untouched.

import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tsvToMatrix, normalizeMatrix, clipboardTableMatrix,
         pasteContextBlocked } from './tablePaste.js';

const mk = (doc) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label + '  got=' + JSON.stringify(got) +
              (ok ? '' : '  want=' + JSON.stringify(want)));
};
const TAB = String.fromCharCode(9), BT = String.fromCharCode(96);

// ---------- tsvToMatrix: accept ----------
eq('tsv 2x2', tsvToMatrix('a' + TAB + 'b\nc' + TAB + 'd'), [['a', 'b'], ['c', 'd']]);
// Excel appends one trailing EOL to a copied range.
eq('tsv trailing crlf', tsvToMatrix('a' + TAB + 'b\r\nc' + TAB + 'd\r\n'), [['a', 'b'], ['c', 'd']]);
eq('tsv empty cells ok', tsvToMatrix('a' + TAB + '\n' + TAB + 'd'), [['a', ''], ['', 'd']]);
eq('tsv 3 cols', tsvToMatrix('1' + TAB + '2' + TAB + '3\n4' + TAB + '5' + TAB + '6')[1], ['4', '5', '6']);

// ---------- tsvToMatrix: reject (these must paste through untouched) ----------
eq('reject no tabs', tsvToMatrix('hello\nworld'), null);
eq('reject single line', tsvToMatrix('a' + TAB + 'b'), null);
// Tab-INDENTED code: guard (3), every line indented.
eq('reject tab-indented code',
   tsvToMatrix(TAB + 'if (x) {\n' + TAB + TAB + 'go();\n' + TAB + '}'), null);
// Uniformly indented code IS rectangular, so guard (5) cannot see it — this is
// the case guard (3) exists for.
eq('reject uniformly tab-indented code',
   tsvToMatrix(TAB + 'a = 1\n' + TAB + 'b = 2'), null);
// A Makefile recipe: the target line is unindented, so guard (3) does not fire
// and guard (5) does the work (2 fields vs 1).
eq('reject makefile recipe', tsvToMatrix('build:\n' + TAB + 'cargo build\n' + TAB + 'echo ok'), null);
// Space-indented block (a Markdown indented code block) with aligned tabs.
eq('reject space-indented block',
   tsvToMatrix('    name' + TAB + 'value\n    foo' + TAB + '1'), null);
// A selected function body with a blank line in it: guard (2).
eq('reject blank line inside',
   tsvToMatrix('a' + TAB + 'b\n\nc' + TAB + 'd'), null);
// Ragged: guard (5).
eq('reject ragged', tsvToMatrix('a' + TAB + 'b\nc' + TAB + 'd' + TAB + 'e'), null);
// One column has no tabs at all, so an Excel 1-col range correctly declines.
eq('reject single column', tsvToMatrix('a\nb\nc'), null);
// Prose that merely happens to contain a tab somewhere.
eq('reject prose with stray tab', tsvToMatrix('see the' + TAB + 'note below\nand then continue'), null);
eq('reject empty', tsvToMatrix(''), null);
eq('reject null', tsvToMatrix(null), null);

// ---------- normalizeMatrix ----------
eq('norm pads short rows', normalizeMatrix([['a', 'b'], ['c']]), [['a', 'b'], ['c', '']]);
eq('norm fills holes', normalizeMatrix([[undefined, 'b']]), [['', 'b']]);
eq('norm drops blank edge rows',
   normalizeMatrix([['', ''], ['a', 'b'], ['', '']]), [['a', 'b']]);
eq('norm keeps interior blank row',
   normalizeMatrix([['a', 'b'], ['', ''], ['c', 'd']]).length, 3);
eq('norm all blank -> null', normalizeMatrix([['', '']]), null);
eq('norm empty -> null', normalizeMatrix([]), null);
eq('norm too wide -> null',
   normalizeMatrix([new Array(65).fill('x')]), null);

// ---------- clipboardTableMatrix flavour fallthrough ----------
// A DataTransfer stub. No DOMParser under node, so the html branch is skipped by
// the typeof guard — which is exactly the "html present but not a table" path.
const dt = (html, text) => ({ getData: (t) => (t === 'text/html' ? html : text) });
eq('clip falls through to tsv',
   clipboardTableMatrix(dt('<pre>a' + TAB + 'b</pre>', 'a' + TAB + 'b\nc' + TAB + 'd')),
   [['a', 'b'], ['c', 'd']]);
eq('clip plain prose declines', clipboardTableMatrix(dt('', 'just prose')), null);
eq('clip null dt', clipboardTableMatrix(null), null);
// getData throwing must not escape (some hosts throw on an unavailable flavour).
eq('clip getData throws', clipboardTableMatrix({ getData: () => { throw new Error('x'); } }), null);

// ---------- pasteContextBlocked ----------
const at = (doc, needle) => pasteContextBlocked(mk(doc), doc.indexOf(needle));
eq('plain paragraph not blocked', at('hello world\n', 'world'), false);
eq('inside fenced code blocked',
   at(BT + BT + BT + '\nMARK\n' + BT + BT + BT + '\n', 'MARK'), true);
eq('inside inline code blocked', at('a ' + BT + 'MARK' + BT + ' b\n', 'MARK'), true);
eq('inside existing table blocked',
   at('| a | b |\n| - | - |\n| MARK | y |\n', 'MARK'), true);
// THE case the syntax tree cannot see: @lezer/markdown parses front matter as
// HorizontalRule + SetextHeading2, so this is guarded by FM_RE, not resolveInner.
// If someone "simplifies" pasteContextBlocked into a pure tree walk, this fails.
eq('inside front matter blocked',
   at('---\ntitle: MARK\n---\n\nbody\n', 'MARK'), true);
eq('body after front matter not blocked',
   at('---\ntitle: x\n---\n\nMARK\n', 'MARK'), false);
eq('no front matter, bare hr not blocked', at('---\n\nMARK\n', 'MARK'), false);

console.log(fail ? '\n' + fail + ' FAILURES' : '\nALL PASS');
process.exit(fail ? 1 : 0);

// Regression tests for the preview's pure GFM pipe-table model layer.
//
//   node tools/preview-harness/table-model.test.cjs      (run from the repo root)
//
// The model functions live inside assets/index.html's inline <script>, so the block
// is extracted textually and eval'd — no browser and no bundle needed. The property
// that matters most is IDEMPOTENCY: emit(parse(x)) === x byte for byte, so saving an
// untouched table never reformats lines the user did not edit.

// assets/index.html and running it in plain node.
const fs = require('fs');
const src = fs.readFileSync('assets/index.html', 'utf8').replace(/\r\n/g, '\n');
const L = src.split('\n');
const s = L.findIndex((l) => l.includes('const TBL_WIDE_RE'));
const e = L.findIndex((l) => l.includes('function tblReplaceLines'));
let end = e, depth = 0, started = false;
for (let i = e; i < L.length; i++) {
  for (const ch of L[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
  if (started && depth === 0) { end = i; break; }
}
const block = L.slice(s, end + 1).join('\n');
const api = eval('(function(){' + block +
  '\nreturn {tblParse,tblEmit,tblSplitRow,tblRowCells,tblIsDelimRow,tblParseAlign,tblEscapeCell,' +
  'tblDisplayWidth,tblInsertRow,tblDeleteRow,tblInsertCol,tblDeleteCol,tblSetAlign,' +
  'tblReadLines,tblReplaceLines};})()');
const { tblParse, tblEmit, tblRowCells, tblIsDelimRow, tblDisplayWidth,
        tblInsertRow, tblDeleteRow, tblInsertCol, tblDeleteCol, tblSetAlign,
        tblReadLines, tblReplaceLines } = api;

const BS = String.fromCharCode(92);   // avoid all shell/JS escaping ambiguity
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL ' + label + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
  else console.log('ok   ' + label);
};
function idem(label, lines) {
  const m = tblParse(lines);
  if (!m) { fail++; console.log('FAIL idempotent: ' + label + '  (parse returned null)'); return; }
  eq('idempotent: ' + label, tblEmit(m), lines);
}

// ---- idempotency: emit(parse(x)) === x, byte for byte
idem('padded',              ['| a   | bb  |', '| --- | --- |', '| 1   | 2   |']);
idem('unpadded 1 dash',     ['|a|bb|', '|-|-|', '|1|2|']);
idem('no outer pipes',      ['a | bb', '--- | ---', '1 | 2']);
idem('hand-aligned widths', ['| Name  | Role     |', '| :---- | -------: |', '| Alice | dev      |']);
idem('indented 3sp',        ['   | a | b |', '   | - | - |', '   | 1 | 2 |']);
idem('CJK columns',         ['| 項目 | 担当   |', '| ---- | ------ |', '| 設計 | Alice  |']);
idem('escaped pipe',        ['| a | b |', '| - | - |', '| p ' + BS + '| q | r |']);
idem('header only',         ['| a | b |', '| - | - |']);
idem('single column',       ['| only |', '| ---- |', '| x    |']);
idem('center align',        ['| a | b |', '| :-: | :-: |', '| 1 | 2 |']);
idem('mismatched padding',  ['| a | b |', '| :- | -: |', '| 1 | 2 |']);
idem('wide delim run',      ['| a | b |', '| ------- | ------- |', '| 1 | 2 |']);
idem('empty cells',         ['|   |   |', '| - | - |', '|   |   |']);
idem('CJK unpadded',        ['|項目|担当|', '|-|-|', '|設計|実装|']);
// Prettier / VS Code style: padding follows the alignment marker, so a `--:` column
// is padded on the LEFT and a `:-:` column is split.
idem('alignment-aware pad', ['| Name  |   Role   | Since |',
                             '| :---- | :------: | ----: |',
                             '| Alice |   dev    |  2021 |',
                             '| Bob   | designer |  2023 |']);
idem('right-aligned only',  ['| n |    v |', '| - | ---: |', '| a |    1 |', '| b | 1000 |']);

// ---- parse details
const m1 = tblParse(['| a | b |', '| :-- | --: |', '| 1 | 2 |']);
eq('align parsed', m1.align, ['left', 'right']);
eq('header parsed', m1.header, ['a', 'b']);
eq('rows parsed', m1.rows, [['1', '2']]);
eq('escaped pipe stays in cell',
   tblParse(['| a | b |', '|-|-|', '| p ' + BS + '| q | r |']).rows[0],
   ['p ' + BS + '| q', 'r']);
eq('rowCells escaped', tblRowCells('| p ' + BS + '| q | r |'), ['p ' + BS + '| q', 'r']);
eq('isDelim yes', tblIsDelimRow('| :-- | --: |'), true);
eq('isDelim no', tblIsDelimRow('| a | b |'), false);
eq('isDelim colon only', tblIsDelimRow('| : | : |'), false);

// ---- ragged rows squared off to the header width
eq('ragged short padded', tblParse(['| a | b | c |', '|-|-|-|', '| 1 |']).rows[0], ['1', '', '']);
eq('ragged long truncated', tblParse(['| a | b |', '|-|-|', '| 1 | 2 | 3 |']).rows[0], ['1', '2']);

// ---- negatives
eq('no delim row -> null', tblParse(['| a | b |', '| 1 | 2 |']), null);
eq('one line -> null', tblParse(['| a | b |']), null);
eq('not a table -> null', tblParse(['plain text', 'more text']), null);
eq('col count mismatch -> null', tblParse(['| a | b | c |', '| - | - |']), null);

// ---- structural ops
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  tblInsertRow(m, 1);
  eq('insertRow appends blank', tblEmit(m), ['| a | b |', '| - | - |', '| 1 | 2 |', '|   |   |']); }
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  tblInsertRow(m, 0);
  eq('insertRow above', tblEmit(m), ['| a | b |', '| - | - |', '|   |   |', '| 1 | 2 |']); }
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |']);
  eq('deleteRow ok', tblDeleteRow(m, 0), true);
  eq('deleteRow result', tblEmit(m), ['| a | b |', '| - | - |', '| 3 | 4 |']); }
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  eq('deleteRow last refused', tblDeleteRow(m, 0), false); }
{ const m = tblParse(['| a | b |', '| :- | -: |', '| 1 | 2 |']);
  tblInsertCol(m, 1);
  eq('insertCol align', m.align, ['left', null, 'right']);
  eq('insertCol result', tblEmit(m), ['| a |  | b |', '| :- | --- | -: |', '| 1 |  | 2 |']); }
{ const m = tblParse(['| a | b | c |', '| - | - | - |', '| 1 | 2 | 3 |']);
  eq('deleteCol ok', tblDeleteCol(m, 1), true);
  eq('deleteCol result', tblEmit(m), ['| a | c |', '| - | - |', '| 1 | 3 |']); }
{ const m = tblParse(['| a |', '| - |', '| 1 |']);
  eq('deleteCol last refused', tblDeleteCol(m, 0), false); }
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  tblSetAlign(m, 1, 'center');
  eq('setAlign col1', tblEmit(m)[1], '| - | :-: |'); }
{ const m = tblParse(['| Name  | Role     |', '| :---- | -------: |', '| Alice | dev      |']);
  m.rows[0][1] = 'designer';
  eq('edit cell keeps alignment padding', tblEmit(m),
     ['| Name  | Role     |', '| :---- | -------: |', '| Alice | designer |']); }

// ---- escaping on the way out
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  m.rows[0][0] = 'pipe | here';
  eq('bare pipe escaped', tblEmit(m)[2], '| pipe ' + BS + '| here | 2 |'); }
{ const m = tblParse(['| a | b |', '| - | - |', '| 1 | 2 |']);
  m.rows[0][0] = 'multi\nline';
  eq('newline folded to space', tblEmit(m)[2], '| multi line | 2 |'); }
{ const m = tblParse(['| a | b |', '| - | - |', '| p ' + BS + '| q | r |']);
  eq('already-escaped not double-escaped', tblEmit(m)[2], '| p ' + BS + '| q | r |'); }

// ---- display width
eq('width ascii', tblDisplayWidth('abc'), 3);
eq('width CJK', tblDisplayWidth('項目'), 4);
eq('width mixed', tblDisplayWidth('a項'), 3);

// ---- splicing must never rewrite EOLs outside the span
const crlf = 'p1\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\ntail\r\n';
eq('read CRLF span', tblReadLines(crlf, 3, 5), ['| a | b |', '| - | - |', '| 1 | 2 |']);
eq('replace keeps CRLF', tblReplaceLines(crlf, 3, 5, ['| a | b |', '| - | - |', '| 9 | 8 |']),
   'p1\r\n\r\n| a | b |\r\n| - | - |\r\n| 9 | 8 |\r\n\r\ntail\r\n');
const lf = 'p1\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntail\n';
eq('replace keeps LF', tblReplaceLines(lf, 3, 5, ['| a | b |', '| - | - |', '| 9 | 8 |']),
   'p1\n\n| a | b |\n| - | - |\n| 9 | 8 |\n\ntail\n');
eq('replace fewer lines', tblReplaceLines(lf, 3, 5, ['| a | b |', '| - | - |']),
   'p1\n\n| a | b |\n| - | - |\n\ntail\n');
eq('replace more lines', tblReplaceLines(lf, 3, 5, ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |']),
   'p1\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\ntail\n');
const noTrail = '| a | b |\n| - | - |\n| 1 | 2 |';
eq('replace at EOF without trailing newline',
   tblReplaceLines(noTrail, 1, 3, ['| a | b |', '| - | - |', '| 9 | 8 |']),
   '| a | b |\n| - | - |\n| 9 | 8 |');
eq('out of range -> null', tblReplaceLines(lf, 3, 99, ['x']), null);
eq('read out of range -> null', tblReadLines(lf, 3, 99), null);

console.log(fail ? '\n' + fail + ' FAILURES' : '\nALL PASS');
process.exit(fail ? 1 : 0);

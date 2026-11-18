// Regression tests for the preview's markwhen edit model (the source rewrites behind
// dragging / the item dialog).
//
//   node tools/preview-harness/markwhen-edit.test.cjs      (run from the repo root)
//
// Needs the bundled parser at assets/libs/markwhen/markwhen.iife.js (install-deps).
// The model lives inside assets/index.html's inline <script>, between the
// `---- markwhen edit model (pure) ----` markers; it is extracted textually together
// with __mwFlatten (whose idx numbering the SVG stamps rely on) and eval'd — no browser.
// Every expectation is checked TWICE: the exact output text, and that the parser reads
// the rewritten text back as the dates / label / tags / colour that were asked for.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('assets/index.html', 'utf8').replace(/\r\n/g, '\n');
const L = html.split('\n');
function fnBlock(startPred) {
  const s = L.findIndex(startPred);
  if (s < 0) throw new Error('block not found');
  let depth = 0, started = false;
  for (let i = s; i < L.length; i++) {
    for (const ch of L[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) return L.slice(s, i + 1).join('\n');
  }
  throw new Error('unterminated block');
}
const ms = L.findIndex((l) => l.includes('---- markwhen edit model (pure) ----'));
const me = L.findIndex((l) => l.includes('---- end markwhen edit model ----'));
if (ms < 0 || me < 0) throw new Error('model markers not found');
const block = fnBlock((l) => l.includes('function __mwFlatten(')) + '\n' + L.slice(ms, me + 1).join('\n');

const lib = fs.readFileSync('assets/libs/markwhen/markwhen.iife.js', 'utf8');
const ctx = { console };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(lib, ctx);
vm.runInContext(block + '\nthis.api = {__mwFlatten,__mwSetDates,__mwSetLabelTags,__mwInsertEvent,' +
  '__mwDeleteEvent,__mwSetTagColor,__mwEventDays,__mwEventLine,__mwParseDate,__mwFmtDate,' +
  '__mwAddDays,__mwCleanTags,__mwAllTags,__mwDatePart};', ctx);
const MW = ctx.Markwhen;
const A = ctx.api;

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL ' + label + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
  else console.log('ok   ' + label);
};
const model = (src) => {
  const mw = MW.parse(src);
  const rows = A.__mwFlatten(MW, mw.events);
  return { mw, rows, events: rows.filter((r) => r.type === 'event'), groups: rows.filter((r) => r.type === 'group') };
};
const D = (s) => A.__mwParseDate(s);
// What the parser reads an event as, in inclusive days.
const readBack = (src, idx) => {
  const r = model(src).events[idx];
  const s = A.__mwEventDays(r);
  return { label: r.label, tags: r.tags, from: A.__mwFmtDate(s.first), to: A.__mwFmtDate(s.last) };
};

const SRC = [
  '---',
  'title: 計画',
  '#dev: green',
  '---',
  '',
  '# 開発',
  '2023-03-01 / 2023-06-30: API 実装 #dev',
  '2023-07-15: テスト',
  '  詳細メモの行',
  '',
  '## QA',
  '2023-08-01 / 2023-08-10: 結合試験 #qa',
  '',
  '# リリース',
  '2023-10-01: 正式リリース',
].join('\n');

// ---- the flatten numbering the SVG stamps use
{
  const m = model(SRC);
  eq('idx is document order over events', m.events.map((r) => [r.idx, r.label]),
     [[0, 'API 実装'], [1, 'テスト'], [2, '結合試験'], [3, '正式リリース']]);
  eq('group rows carry their node', m.groups.map((g) => g.node.title), ['開発', 'QA', 'リリース']);
}

// ---- dates: only the date text changes
{
  const m = model(SRC);
  const out = A.__mwSetDates(SRC, m.events[0].node, D('2023-03-05'), D('2023-07-04'));
  eq('move range: line', out.split('\n')[6], '2023-03-05 / 2023-07-04: API 実装 #dev');
  eq('move range: rest untouched', out.split('\n').filter((_, i) => i !== 6), SRC.split('\n').filter((_, i) => i !== 6));
  eq('move range: reads back', readBack(out, 0), { label: 'API 実装', tags: ['dev'], from: '2023-03-05', to: '2023-07-04' });

  const single = A.__mwSetDates(SRC, m.events[1].node, D('2023-07-20'), D('2023-07-20'));
  eq('single day stays single', single.split('\n')[7], '2023-07-20: テスト');
  eq('single day: description kept', single.split('\n')[8], '  詳細メモの行');
  eq('single day: reads back', readBack(single, 1).from + '..' + readBack(single, 1).to, '2023-07-20..2023-07-20');

  const widen = A.__mwSetDates(SRC, m.events[1].node, D('2023-07-15'), D('2023-07-18'));
  eq('single → range', widen.split('\n')[7], '2023-07-15 / 2023-07-18: テスト');
  eq('single → range reads back inclusive end', readBack(widen, 1).to, '2023-07-18');

  eq('end before start refused', A.__mwSetDates(SRC, m.events[0].node, D('2023-05-01'), D('2023-04-01')), null);
}

// Non-ISO originals are rewritten to ISO days, and keep meaning what was asked.
{
  const src = '1989 / 1990: 平成初期\n2011-03: 三月';
  const m = model(src);
  const out = A.__mwSetDates(src, m.events[1].node, D('2011-03-01'), D('2011-03-31'));
  eq('month granularity rewritten as ISO days', out, '1989 / 1990: 平成初期\n2011-03-01 / 2011-03-31: 三月');
  eq('…covers the same days', readBack(out, 1), readBack(src, 1));
}

// Recurring events: the date text is not a plain range — refuse.
{
  const src = '2024-01-01 every week for 3 weeks: 定例';
  const m = model(src);
  if (m.events.length && m.events[0].node.recurrence) {
    eq('recurring refused', A.__mwSetDates(src, m.events[0].node, D('2024-01-02'), D('2024-01-02')), null);
  } else {
    console.log('skip recurring (parser did not mark the fixture as recurring)');
  }
}

// ---- label / tags
{
  const m = model(SRC);
  const out = A.__mwSetLabelTags(SRC, m.events[0].node, 'API 実装（改）', ['dev', 'core']);
  eq('label+tags line', out.split('\n')[6], '2023-03-01 / 2023-06-30: API 実装（改） #dev #core');
  eq('label+tags reads back', readBack(out, 0), { label: 'API 実装（改）', tags: ['dev', 'core'], from: '2023-03-01', to: '2023-06-30' });
  const noTag = A.__mwSetLabelTags(SRC, m.events[0].node, 'API', []);
  eq('tags removed', noTag.split('\n')[6], '2023-03-01 / 2023-06-30: API');
  // Both edits on one parse: label first, then dates (the dialog's order).
  const both = A.__mwSetDates(A.__mwSetLabelTags(SRC, m.events[1].node, '総合テスト', ['qa']), m.events[1].node, D('2023-07-16'), D('2023-07-17'));
  eq('label then dates compose', both.split('\n').slice(7, 9), ['2023-07-16 / 2023-07-17: 総合テスト #qa', '  詳細メモの行']);
  eq('newline in label flattened', A.__mwSetLabelTags('2024-01-01: a', model('2024-01-01: a').events[0].node, 'x\ny', []), '2024-01-01: x y');
  eq('clean tags', A.__mwCleanTags('#dev, design  dev'), ['dev', 'design']);
}

// ---- insert
{
  const m = model(SRC);
  const line = A.__mwEventLine(D('2023-07-20'), D('2023-07-22'), '追加', ['dev']);
  eq('event line', line, '2023-07-20 / 2023-07-22: 追加 #dev');
  const inDev = A.__mwInsertEvent(MW, SRC, m.groups[0].node, line);
  // After the section's last DIRECT event (テスト + its description), before `## QA`.
  eq('insert into section', inDev.split('\n').slice(7, 11), ['2023-07-15: テスト', '  詳細メモの行', line, '']);
  const mm = model(inDev);
  const added = mm.events.find((r) => r.label === '追加');
  const parentOf = (rows, r) => { for (let i = rows.indexOf(r); i >= 0; i--) if (rows[i].type === 'group' && rows[i].depth < r.depth) return rows[i].label; return null; };
  eq('…parent section is 開発', parentOf(mm.rows, added), '開発');

  const atEnd = A.__mwInsertEvent(MW, SRC, null, line);
  eq('insert at end (no trailing newline)', atEnd.split('\n').slice(-2), ['2023-10-01: 正式リリース', line]);
  eq('insert at end with trailing newline', A.__mwInsertEvent(MW, 'a\n', null, 'x'), 'a\nx');
  const empty = '# 空\n\n# 次\n2024-01-01: z';
  const me = model(empty);
  const ins = A.__mwInsertEvent(MW, empty, me.groups[0].node, '2024-02-01: y');
  eq('insert into an empty section goes under its heading', ins, '# 空\n2024-02-01: y\n\n# 次\n2024-01-01: z');
}

// ---- delete
{
  const m = model(SRC);
  const out = A.__mwDeleteEvent(SRC, m.events[1].node);
  eq('delete takes the description too', out.split('\n').slice(5, 8), ['# 開発', '2023-03-01 / 2023-06-30: API 実装 #dev', '']);
  eq('delete last (no trailing newline)', A.__mwDeleteEvent(SRC, m.events[3].node).split('\n').slice(-1), ['# リリース']);
  eq('…event count', model(out).events.length, 3);
}

// ---- tag colour
{
  const replaced = A.__mwSetTagColor(SRC, 'dev', '#ff0000');
  eq('replace existing entry', replaced.split('\n').slice(0, 4), ['---', 'title: 計画', '#dev: #ff0000', '---']);
  eq('…parser keeps the hex (escaped to `)`)', model(replaced).mw.header[')dev'], ')ff0000');
  const added = A.__mwSetTagColor(SRC, 'qa', '#00aa00');
  eq('add before closing ---', added.split('\n').slice(0, 5), ['---', 'title: 計画', '#dev: green', '#qa: #00aa00', '---']);
  eq('create front matter', A.__mwSetTagColor('2024-01-01: a #x', 'x', '#123456'), '---\n#x: #123456\n---\n2024-01-01: a #x');
  eq('tag prefix is not a match', A.__mwSetTagColor('---\n#devops: red\n---\nz', 'dev', '#111111'), '---\n#devops: red\n#dev: #111111\n---\nz');
  eq('all tags', A.__mwAllTags(model(SRC).rows), ['dev', 'qa']);
}

// ---- date helpers
eq('parse rejects 2023-02-30', Number.isNaN(A.__mwParseDate('2023-02-30')), true);
eq('addDays across month end', A.__mwFmtDate(A.__mwAddDays(D('2024-02-28'), 2)), '2024-03-01');
eq('datePart single', A.__mwDatePart(D('2024-05-01'), D('2024-05-01')), '2024-05-01');

if (fail) { console.log('\n' + fail + ' FAILED'); process.exit(1); }
console.log('\nall passed');

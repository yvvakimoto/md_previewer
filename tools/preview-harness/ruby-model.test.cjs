// Regression tests for the preview's pure ruby (振り仮名) grammar layer.
//
//   node tools/preview-harness/ruby-model.test.cjs      (run from the repo root)
//
// The grammar lives inside assets/index.html's inline <script>, so the block is
// extracted textually and eval'd — no browser and no bundle needed, exactly like
// table-model.test.cjs. What matters here is that ONE grammar (RUBY_ALT_SRC) drives
// three views — marked's start() hook, its tokenizer, and the Marp pre-pass scan —
// so a change to the alternation cannot silently desynchronize them.

const fs = require('fs');
const src = fs.readFileSync('assets/index.html', 'utf8').replace(/\r\n/g, '\n');
const L = src.split('\n');
const s = L.findIndex((l) => l.includes('const RUBY_KANJI_SRC'));
const e = L.findIndex((l) => l.includes('function rubyifyText'));
if (s < 0 || e < 0) { console.log('FAIL: could not locate the ruby block in assets/index.html'); process.exit(1); }
let end = e, depth = 0, started = false;
for (let i = e; i < L.length; i++) {
  for (const ch of L[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
  if (started && depth === 0) { end = i; break; }
}
const block = L.slice(s, end + 1).join('\n');

// buildRubyHtml() calls the preview's escapeHtml(), which lives elsewhere in the
// file; supply an identical one rather than dragging in another block.
const shim = [
  'function escapeHtml(x) {',
  '  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")',
  '                  .replace(/"/g, "&quot;").replace(/\'/g, "&#39;");',
  '}',
].join('\n');

const api = eval('(function(){' + shim + '\n' + block +
  '\nreturn {buildRubyHtml, rubyMatchToHtml, rubyifyMdLine, rubyifyText,' +
  ' RUBY_START_RE, RUBY_TOKEN_RE, RUBY_SCAN_RE};})()');
const { buildRubyHtml, rubyifyMdLine, RUBY_START_RE, RUBY_TOKEN_RE } = api;

const BS = String.fromCharCode(92);   // avoid all shell/JS escaping ambiguity
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL ' + label + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
  else console.log('ok   ' + label);
};

// ---- buildRubyHtml: group vs mono
eq('group ruby', buildRubyHtml('猫', 'ねこ'), '<ruby>猫<rt>ねこ</rt></ruby>');
eq('mono ruby', buildRubyHtml('漢字', 'かん|じ'),
   '<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>');
eq('mono ruby, full-width sep', buildRubyHtml('漢字', 'かん｜じ'),
   '<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>');
// でんでん's rule: a count mismatch is NOT mono ruby — join and emit one annotation.
eq('count mismatch -> group', buildRubyHtml('五月雨', 'さみ|だれ'),
   '<ruby>五月雨<rt>さみだれ</rt></ruby>');
eq('too many segments -> group', buildRubyHtml('雨', 'あ|め|x'),
   '<ruby>雨<rt>あめx</rt></ruby>');
eq('empty reading declines', buildRubyHtml('漢字', ''), '');
eq('all-empty segments decline', buildRubyHtml('漢字', '|'), '');
eq('empty base declines', buildRubyHtml('', 'かな'), '');
// A base written with a surrogate pair must split by CHARACTER, not code unit.
eq('surrogate-pair base', buildRubyHtml('\u{20B9F}文', 'しか|もん'),
   '<ruby>\u{20B9F}<rt>しか</rt>文<rt>もん</rt></ruby>');
eq('html is escaped', buildRubyHtml('<b>', '&"'),
   '<ruby>&lt;b&gt;<rt>&amp;&quot;</rt></ruby>');

// ---- the three forms, through the Marp line rewriter
eq('bar form', rubyifyMdLine('吾輩は｜猫《ねこ》である。'),
   '吾輩は<ruby>猫<rt>ねこ</rt></ruby>である。');
eq('short form', rubyifyMdLine('漢字《かんじ》を読む'),
   '<ruby>漢字<rt>かんじ</rt></ruby>を読む');
eq('brace form', rubyifyMdLine('{吾輩|わがはい}は'),
   '<ruby>吾輩<rt>わがはい</rt></ruby>は');
eq('brace mono', rubyifyMdLine('{漢字|かん|じ}'),
   '<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>');
eq('bar form with mono reading', rubyifyMdLine('｜漢字《かん|じ》'),
   '<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>');
eq('two on one line', rubyifyMdLine('｜猫《ねこ》と｜犬《いぬ》'),
   '<ruby>猫<rt>ねこ</rt></ruby>と<ruby>犬<rt>いぬ</rt></ruby>');
// The bar form takes precedence, so its base is NOT re-read as a kanji run.
eq('bar wins over short', rubyifyMdLine('｜五月雨《さみだれ》'),
   '<ruby>五月雨<rt>さみだれ</rt></ruby>');
// The short form takes only the kanji run — a preceding kana stays outside.
eq('short form stops at kana', rubyifyMdLine('お天気《てんき》'),
   'お<ruby>天気<rt>てんき</rt></ruby>');
// 々 belongs to a kanji run.
eq('short form takes 々', rubyifyMdLine('人々《ひとびと》'),
   '<ruby>人々<rt>ひとびと</rt></ruby>');

// ---- declines: the source must survive verbatim
eq('brace without separator', rubyifyMdLine('{color=red}'), '{color=red}');
eq('styled span untouched', rubyifyMdLine('[赤い字]{color=red}'), '[赤い字]{color=red}');
eq('image sizing untouched', rubyifyMdLine('![alt|300](p.png)'), '![alt|300](p.png)');
eq('table row untouched', rubyifyMdLine('| a | b |'), '| a | b |');
eq('empty reading survives', rubyifyMdLine('{漢字|}'), '{漢字|}');
// 《…》 after kana is a quotation, not a ruby.
eq('quotation after kana', rubyifyMdLine('本は《タイトル》です'), '本は《タイトル》です');

// ---- escapes
eq('escaped bar', rubyifyMdLine(BS + '｜猫《ねこ》'), '｜<ruby>猫<rt>ねこ</rt></ruby>');
eq('escaped open bracket', rubyifyMdLine('作品' + BS + '《タイトル》'), '作品《タイトル》');

// ---- inline code spans are left alone (the Marp pre-pass's whole reason to exist)
eq('code span skipped', rubyifyMdLine('例: `｜漢字《かんじ》` と書く'),
   '例: `｜漢字《かんじ》` と書く');
eq('code span + live', rubyifyMdLine('`{a|b}` だが｜猫《ねこ》は変換'),
   '`{a|b}` だが<ruby>猫<rt>ねこ</rt></ruby>は変換');
eq('double-backtick span', rubyifyMdLine('``｜猫《ねこ》`` はそのまま'),
   '``｜猫《ねこ》`` はそのまま');

// ---- the start() hook must report the offset of the BASE, not of 《.
// marked clips the preceding text run there, so a short form whose start pointed at
// 《 would emit the kanji twice (once as text, once inside the ruby).
eq('start(): bar form', RUBY_START_RE.exec('あい｜猫《ねこ》').index, 2);
eq('start(): short form', RUBY_START_RE.exec('お天気《てんき》').index, 1);
eq('start(): brace form', RUBY_START_RE.exec('xx{a|b}').index, 2);
eq('start(): no match', RUBY_START_RE.exec('ただの文章'), null);
// RUBY_START_RE must not be global: a stateful lastIndex would skip matches on the
// next inline chunk marked hands it.
eq('start() regex is stateless', RUBY_START_RE.global, false);

// ---- the tokenizer regex is anchored, and its groups line up with the scanner's
eq('token: anchored', RUBY_TOKEN_RE.test('あ｜猫《ねこ》'), false);
eq('token: consumes exactly the form',
   RUBY_TOKEN_RE.exec('｜猫《ねこ》である')[0], '｜猫《ねこ》');
eq('token: brace raw', RUBY_TOKEN_RE.exec('{漢字|かん|じ}の')[0], '{漢字|かん|じ}');

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);

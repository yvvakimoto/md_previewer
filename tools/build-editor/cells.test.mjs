// Tests for the cell-mode state layer. Plain node, no browser, no bundle:
//   cd tools/build-editor && node cells.test.mjs
//
// Same conventions as mdTable.test.mjs. The plan/apply split in cells.js is what
// makes this possible — every planner is pure (state -> {changes, cursor}), so a
// change can be applied and asserted with no EditorView.
//
// The centrepiece is separator hygiene: an operation that leaves a dangling or
// setext-ambiguous `---` silently desynchronizes editor cell N from preview
// slide N, and a cut/split at such a position corrupts the document.

import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { scanSeparators, isSeparatorLine, padInsert } from './mdBlocks.js';
import {
  cellList,
  cellIndexAt,
  cellRunLine,
  cellContentLines,
  cellModeField,
  setCellMode,
  setCellPend,
  cellModeOf,
  planInsert,
  planDelete,
  planMove,
  planSplit,
  planMerge,
  planHeading,
} from './cells.js';
import { scanSlides, slideAt } from './marpSlides.js';

const mk = (doc) => EditorState.create({
  doc,
  extensions: [markdown({ base: markdownLanguage })],
});

let fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log('ok   ' + label); return true; }
  console.log('FAIL ' + label + '\n       got  ' + g + '\n       want ' + w);
  fail++;
  return false;
}
function ok(label, cond, detail) {
  if (cond) { console.log('ok   ' + label); return true; }
  console.log('FAIL ' + label + (detail ? '\n       ' + detail : ''));
  fail++;
  return false;
}

// Apply a plan and return the resulting document text.
const applied = (state, plan) => state.update({ changes: plan.changes }).state.doc.toString();
// Apply a plan and return the resulting state (so cursor/cell asserts can run).
const after = (state, plan) => state.update({ changes: plan.changes }).state;

const sepLines = (doc) => scanSeparators(mk(doc)).seps.map((s) => s.line);
const cellCount = (doc) => cellList(mk(doc)).length;

// ── invariant checker ────────────────────────────────────────────────────────
// INV1  every separator line is preceded by a blank line (never a setext <h2>
//       underline). This is the one that keeps the document renderable.
// INV2  no separator line is immediately followed by another separator line.
// INV3  never more than 3 consecutive blank lines (catches runaway padding; an
//       empty cell legitimately produces `---` / blank / blank / `---`).
function invariants(doc) {
  const lines = doc.split('\n');
  const seps = sepLines(doc);
  const bad = [];
  for (const l of seps) {
    if (l > 1 && lines[l - 2].trim() !== '') bad.push('INV1@' + l);
    if (seps.includes(l + 1)) bad.push('INV2@' + l);
  }
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    run = lines[i].trim() === '' ? run + 1 : 0;
    if (run > 3) { bad.push('INV3@' + (i + 1)); break; }
  }
  return bad;
}
function invOk(label, doc) {
  const bad = invariants(doc);
  return ok(label, bad.length === 0, bad.join(' ') + '\n       doc ' + JSON.stringify(doc));
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const FM = '---\nmarp: true\n---\n';
const DECK = FM + '\n# One\n\n---\n\n# Two\n\n---\n\n# Three\n';   // fm + 3 cells
const PLAIN = '# One\n\n---\n\n# Two\n';                            // no fm, 2 cells

console.log('── scanner / setext guard ──');
eq('para then --- is NOT a separator (setext h2)', sepLines('hello\n---\nworld'), []);
eq('blank then --- is a separator', sepLines('hello\n\n---\n\nworld'), [3]);
eq('para then *** is a separator', sepLines('hello\n***\nworld'), [2]);
eq('para then ___ is a separator', sepLines('hello\n___\nworld'), [2]);
eq('ATX heading then --- is a separator', sepLines('# H\n---\nbody'), [2]);
eq('list item then --- is a separator', sepLines('- a\n---\nbody'), [2]);
eq('blockquote then --- is a separator', sepLines('> q\n---\nbody'), [2]);
eq('--- inside a ``` fence is not a separator', sepLines('a\n\n```\n---\n```\n\n---\n'), [7]);
eq('``` inside ~~~ does not close it (marker kind)',
  sepLines('a\n\n~~~\n```\n---\n~~~\n\n---\n'), [8]);
eq("front-matter's own closing --- is never a separator", sepLines(DECK), [7, 11]);
eq('front-matter only: no separators', sepLines(FM), []);
eq('isSeparatorLine agrees with scanSeparators',
  (() => { const l = 'hello\n\n---\n\nx'.split('\n'); return l.map((_, i) => isSeparatorLine(l, i)); })(),
  [false, false, true, false, false]);

console.log('\n── cell model ──');
eq('plain doc, no separators: 1 cell', cellCount('just text\n'), 1);
eq('front-matter only: fm cell + 1 empty body cell', cellCount(FM), 2);
eq('deck: fm + 3 body cells', cellCount(DECK), 4);
eq('plain: 2 body cells, no fm cell', cellCount(PLAIN), 2);
eq('deck cell kinds', cellList(mk(DECK)).map((c) => c.kind),
  ['frontmatter', 'body', 'body', 'body']);
{
  const st = mk(DECK);
  const cells = cellList(st);
  eq('cell 1 has no leading separator', cells[1].leadSep, null);
  eq('cell 2 leadSep is line 7', cells[2].leadSep.line, 7);
  eq('cell 2 bodyFrom is on line 8', st.doc.lineAt(cells[2].bodyFrom).number, 8);
  // boundaries
  eq('pos 0 -> front-matter cell', cellIndexAt(st, 0), 0);
  eq('pos just inside fm -> fm cell', cellIndexAt(st, 5), 0);
  eq('pos at fmEnd -> first body cell', cellIndexAt(st, cells[1].from), 1);
  eq('pos on a separator line -> the cell it introduces',
    cellIndexAt(st, st.doc.line(7).from), 2);
  eq('last char of a cell stays in it', cellIndexAt(st, cells[2].to - 1), 2);
  eq('pos === doc.length -> last cell', cellIndexAt(st, st.doc.length), 3);
  eq('empty body cell of a fm-only doc is reachable', cellIndexAt(mk(FM), mk(FM).doc.length), 1);
}

console.log('\n── cellRunLine (Marp deck must not land one slide early) ──');
{
  const st = mk(DECK);
  const cells = cellList(st);
  // Mirror of renderMarp()'s slideStartLines scan: first slide starts at
  // fmLastLine+1, each later slide at its separator line + 1.
  eq('front-matter cell reports line 1', cellRunLine(st, cells[0]), 1);
  // 4 is exactly renderMarp()'s slideStartLines[0] for this deck (`__curStart =
  // i + 2` at the fm-close on 0-based line 2), so slide 1 is hit precisely.
  eq('first body cell -> the line after the front-matter', cellRunLine(st, cells[1]), 4);
  eq('cell 2 -> separator line + 1 (NOT the separator line)', cellRunLine(st, cells[2]), 8);
  eq('cell 3 -> separator line + 1', cellRunLine(st, cells[3]), 12);
  const st2 = mk(PLAIN);
  const c2 = cellList(st2);
  eq('no front-matter: first cell -> line 1', cellRunLine(st2, c2[0]), 1);
  eq('no front-matter: cell 2 -> separator + 1', cellRunLine(st2, c2[1]), 4);
}

console.log('\n── cellContentLines (what cell-scoped gg / G land on) ──');
{
  // The padding a separator forces (INV1: a blank line before every `---`) is
  // exactly what must NOT be the landing spot: `gg` on a blank line is useless,
  // and a `dG` that ate the trailing blank would turn the next `---` into a
  // setext <h2> underline.
  const st = mk(DECK);
  const cells = cellList(st);
  eq('front-matter cell spans its own delimiters', cellContentLines(st, cells[0]), { first: 1, last: 3 });
  eq('first body cell skips the blank after the front-matter',
    cellContentLines(st, cells[1]), { first: 5, last: 5 });
  eq('cell 2 skips the blank after its separator',
    cellContentLines(st, cells[2]), { first: 9, last: 9 });
  eq('last cell stops at its last content line, not the trailing newline',
    cellContentLines(st, cells[3]), { first: 13, last: 13 });

  const st2 = mk(PLAIN);
  const c2 = cellList(st2);
  eq('no front-matter: first cell starts at line 1',
    cellContentLines(st2, c2[0]), { first: 1, last: 1 });
  eq('no front-matter: cell 2 skips its leading blank',
    cellContentLines(st2, c2[1]), { first: 5, last: 5 });

  //  1 head   2 ''   3 ---   4 ''   5 ''   6 ''
  //  7 ---    8 ''   9 alpha  10 beta  11 ''
  // 12 ---   13 ''  14 only  15 ''
  const st3 = mk('head\n\n---\n\n\n\n---\n\nalpha\nbeta\n\n---\n\nonly\n');
  const c3 = cellList(st3);
  eq('multi-line cell trims padding at both ends',
    cellContentLines(st3, c3[2]), { first: 9, last: 10 });
  eq('an all-blank cell collapses onto its first body line',
    cellContentLines(st3, c3[1]), { first: 4, last: 4 });
  eq('single-line cell reports the same line twice',
    cellContentLines(st3, c3[3]), { first: 14, last: 14 });

  // Why "content line" beats "edge of the cell slot": deleting linewise from the
  // first to the last CONTENT line leaves the separator's blank line intact, so
  // INV1 survives and the emptied cell still exists (cell N stays slide N).
  const emptied = st3.update({
    changes: { from: st3.doc.line(9).from, to: st3.doc.line(11).from, insert: '' },
  }).state.doc.toString();
  invOk('dG over the content lines keeps the separators well-formed', emptied);
  eq('dG over the content lines leaves the cell count unchanged',
    cellList(mk(emptied)).length, c3.length);
}

console.log('\n── planInsert ──');
{
  const st = mk(DECK);
  const p = planInsert(st, 1, 'below');
  const doc = applied(st, p);
  eq('insert below cell 1: cell count +1', cellCount(doc), 5);
  invOk('insert below: invariants', doc);
  eq('insert below: cursor is in the new cell 2',
    cellIndexAt(after(st, p), p.cursor), 2);
  eq('insert below: cursor line is blank',
    after(st, p).doc.lineAt(p.cursor).text, '');
}
{
  const st = mk(DECK);
  const p = planInsert(st, 2, 'above');
  const doc = applied(st, p);
  eq('insert above cell 2: count +1', cellCount(doc), 5);
  invOk('insert above (has leadSep): invariants', doc);
  eq('insert above cell 2: cursor is in cell 2', cellIndexAt(after(st, p), p.cursor), 2);
}
{
  // THE asymmetric case: cell 1 has no leading separator, so the new separator
  // must go AFTER the inserted body, not before it.
  const st = mk(DECK);
  const p = planInsert(st, 1, 'above');
  const doc = applied(st, p);
  eq('insert above cell 1: count +1', cellCount(doc), 5);
  invOk('insert above FIRST cell: invariants', doc);
  ok('insert above cell 1: front-matter untouched', doc.startsWith(FM), JSON.stringify(doc.slice(0, 30)));
  eq('insert above cell 1: cursor is in the new first body cell',
    cellIndexAt(after(st, p), p.cursor), 1);
  ok('insert above cell 1: "# One" is now in cell 2',
    (() => {
      const s2 = after(st, p);
      const cells = cellList(s2);
      return s2.sliceDoc(cells[2].from, cells[2].to).includes('# One');
    })());
}
{
  const st = mk(FM);
  const p = planInsert(st, 0, 'below'); // from inside the front-matter
  const doc = applied(st, p);
  ok('insert from front-matter: fm bytes identical', doc.startsWith(FM), JSON.stringify(doc));
  invOk('insert from front-matter: invariants', doc);
}
{
  // Pasting a cut cell (whose text starts with its own `---`) must not double it.
  const st = mk(DECK);
  const p = planInsert(st, 1, 'below', '---\n\n# Pasted\n');
  const doc = applied(st, p);
  eq('paste of ---prefixed text: count +1 only', cellCount(doc), 5);
  invOk('paste of ---prefixed text: invariants', doc);
  eq('paste of ---prefixed text: no doubled separator',
    /---\s*\n\s*---/.test(doc.replace(FM, '')), false);
  ok('pasted body present', doc.includes('# Pasted'));
}

console.log('\n── planDelete ──');
{
  const st = mk(DECK);
  const doc = applied(st, planDelete(st, 2));  // middle cell (has leadSep)
  eq('delete middle: count -1', cellCount(doc), 3);
  invOk('delete middle: invariants', doc);
  eq('delete middle: "# Two" gone', doc.includes('# Two'), false);
  ok('delete middle: One and Three remain', doc.includes('# One') && doc.includes('# Three'));
}
{
  const st = mk(DECK);
  const doc = applied(st, planDelete(st, 1));  // first body cell (no leadSep)
  eq('delete FIRST body cell: count -1', cellCount(doc), 3);
  invOk('delete first body cell: invariants', doc);
  eq('delete first: "# One" gone', doc.includes('# One'), false);
  ok('delete first: front-matter intact', doc.startsWith(FM), JSON.stringify(doc));
  eq('delete first: remaining cell 1 has no leading separator',
    cellList(mk(doc))[1].leadSep, null);
}
{
  const st = mk(DECK);
  const doc = applied(st, planDelete(st, 3));  // last cell
  eq('delete last: count -1', cellCount(doc), 3);
  invOk('delete last: invariants', doc);
  eq('delete last: no dangling separator', sepLines(doc), [7]);
}
{
  const st = mk(FM + '\nonly\n');
  const doc = applied(st, planDelete(st, 1));  // the only body cell
  ok('delete only body cell: front-matter kept', doc.startsWith(FM), JSON.stringify(doc));
  eq('delete only body cell: still 1 body cell', cellCount(doc), 2);
  invOk('delete only body cell: invariants', doc);
}
eq('delete refuses on the front-matter cell', planDelete(mk(DECK), 0), null);
{
  const st = mk(DECK);
  const doc = applied(st, planDelete(st, 2, 3)); // a range
  eq('delete range 2..3: count -2', cellCount(doc), 2);
  invOk('delete range: invariants', doc);
}

console.log('\n── planMove ──');
{
  const st = mk(DECK);
  const p = planMove(st, 1, 1);
  const doc = applied(st, p);
  eq('move down: count unchanged', cellCount(doc), 4);
  invOk('move down: invariants', doc);
  eq('move down: separators unchanged', sepLines(doc), [7, 11]);
  ok('move down: Two now precedes One',
    doc.indexOf('# Two') < doc.indexOf('# One'), JSON.stringify(doc));
  eq('move down: cursor follows the moved cell', cellIndexAt(after(st, p), p.cursor), 2);
}
{
  const st = mk(DECK);
  const p = planMove(st, 2, -1);
  const doc = applied(st, p);
  invOk('move up: invariants', doc);
  ok('move up: Two now precedes One', doc.indexOf('# Two') < doc.indexOf('# One'));
  eq('move up: cursor follows the moved cell', cellIndexAt(after(st, p), p.cursor), 1);
}
{
  // Round trip must be byte-identical — the strongest single check on planMove.
  const st = mk(DECK);
  const once = after(st, planMove(st, 1, 1));
  const twice = applied(once, planMove(once, 2, -1));
  eq('move down then back up is byte-identical', twice, DECK);
}
eq('move up from the first body cell is refused', planMove(mk(DECK), 1, -1), null);
eq('move down from the last cell is refused', planMove(mk(DECK), 3, 1), null);
eq('move refuses on the front-matter cell', planMove(mk(DECK), 0, 1), null);

console.log('\n── planSplit ──');
{
  const st = mk(DECK);
  const pos = st.doc.line(9).to;   // end of "# Two"
  const p = planSplit(st, pos);
  const doc = applied(st, p);
  eq('split: count +1', cellCount(doc), 5);
  invOk('split: invariants', doc);
  ok('split: Two above, Three below',
    doc.indexOf('# Two') < doc.indexOf('# Three'));
  eq('split: cursor is in the new lower cell', cellIndexAt(after(st, p), p.cursor), 3);
}
{
  const st = mk(DECK);
  const cells = cellList(st);
  const p = planSplit(st, cells[2].bodyFrom);  // at the very start of a cell body
  const doc = applied(st, p);
  eq('split at bodyFrom: count +1 (empty upper cell is allowed)', cellCount(doc), 5);
  invOk('split at bodyFrom: invariants', doc);
}
eq('split refuses inside the front-matter', planSplit(mk(DECK), 4), null);

console.log('\n── planMerge ──');
{
  const st = mk(DECK);
  const p = planMerge(st, 1);
  const doc = applied(st, p);
  eq('merge: count -1', cellCount(doc), 3);
  invOk('merge: invariants', doc);
  ok('merge: both bodies present', doc.includes('# One') && doc.includes('# Two'));
  eq('merge: exactly one blank line between the joined bodies',
    /# One\n\n# Two/.test(doc), true);
  eq('merge: cursor at the start of the merged-in body',
    after(st, p).doc.lineAt(p.cursor).text, '# Two');
}
eq('merge refuses on the last cell', planMerge(mk(DECK), 3), null);
eq('merge refuses on the front-matter cell', planMerge(mk(DECK), 0), null);

console.log('\n── planHeading ──');
{
  const st = mk(FM + '\nplain text\n');
  eq('adds a heading where there is none',
    applied(st, planHeading(st, 1, 2, 0)), FM + '\n## plain text\n');
}
{
  const st = mk(FM + '\n## x\n');
  eq('changes an existing level', applied(st, planHeading(st, 1, 4, 0)), FM + '\n#### x\n');
  eq('level 0 removes the heading', applied(st, planHeading(st, 1, 0, 0)), FM + '\nx\n');
  eq('setting the level it already has is a no-op', planHeading(st, 1, 2, 0), null);
}
{
  const st = mk(FM + '\n<!-- _class: lead -->\n\ntitle\n');
  eq('skips a `<!-- _class: … -->` directive line',
    applied(st, planHeading(st, 1, 1, 0)),
    FM + '\n<!-- _class: lead -->\n\n# title\n');
}
eq('heading refuses on the front-matter cell', planHeading(mk(DECK), 0, 2, 0), null);
{
  const st = mk(FM + '\n\n');   // empty body cell
  const p = planHeading(st, 1, 3, st.doc.length);
  ok('empty cell + level: inserts marks at the caret line', p !== null);
  ok('empty cell heading result', applied(st, p).includes('### '), JSON.stringify(applied(st, p)));
}

console.log('\n── invariant sweep: every op at every index ──');
{
  const corpus = [DECK, PLAIN, FM + '\nsolo\n', 'a\n\n---\n\nb\n\n---\n\nc\n'];
  let swept = 0;
  for (const doc of corpus) {
    const st = mk(doc);
    const cells = cellList(st);
    for (let i = 0; i < cells.length; i++) {
      const plans = [
        ['insert below', planInsert(st, i, 'below')],
        ['insert above', planInsert(st, i, 'above')],
        ['delete', planDelete(st, i)],
        ['move up', planMove(st, i, -1)],
        ['move down', planMove(st, i, 1)],
        ['merge', planMerge(st, i)],
        ['split', planSplit(st, cells[i].bodyFrom)],
        ['heading 2', planHeading(st, i, 2, cells[i].bodyFrom)],
      ];
      for (const [name, p] of plans) {
        if (!p) continue;
        swept++;
        const out = applied(st, p);
        const bad = invariants(out);
        if (bad.length) {
          fail++;
          console.log(`FAIL sweep ${name} @${i} of ${JSON.stringify(doc)}\n       ${bad.join(' ')}\n       -> ${JSON.stringify(out)}`);
        }
        if (p.cursor < 0 || p.cursor > out.length) {
          fail++;
          console.log(`FAIL sweep cursor ${name} @${i}: ${p.cursor} of ${out.length}`);
        }
      }
    }
  }
  ok(`swept ${swept} plans, all invariants hold`, true);
}

console.log('\n── mode field ──');
{
  const st = EditorState.create({ doc: 'x', extensions: [cellModeField] });
  eq('initial mode', cellModeOf(st).mode, 'edit');
  eq('initial pending', cellModeOf(st).pending, '');
  const cmd = st.update({ effects: setCellMode.of('command') }).state;
  eq('setCellMode -> command', cellModeOf(cmd).mode, 'command');
  const pend = cmd.update({ effects: setCellPend.of('d') }).state;
  eq('setCellPend -> d', cellModeOf(pend).pending, 'd');
  eq('a doc change clears pending',
    cellModeOf(pend.update({ changes: { from: 0, insert: 'y' } }).state).pending, '');
  eq('a cursor move clears pending',
    cellModeOf(pend.update({ selection: { anchor: 0 } }).state).pending, '');
  eq('mode survives a cursor move',
    cellModeOf(pend.update({ selection: { anchor: 0 } }).state).mode, 'command');
  eq('cellModeOf without the field returns the off value',
    cellModeOf(EditorState.create({ doc: 'x' })).mode, 'edit');
}

console.log('\n── marpSlides re-exports still honour the old contract ──');
{
  const st = mk(DECK);
  const scan = scanSlides(st);
  eq('scanSlides finds the deck separators', scan.seps.map((s) => s.line), [7, 11]);
  // fmEnd stops right after the closing `---` line and does NOT eat the blank
  // line below it, so it agrees with renderMarp()'s front-matter end. A `\s*`
  // before `(\n|$)` in FM_RE would swallow that blank line and shift fmEnd by one
  // line — see the comment on FM_RE in mdBlocks.js.
  eq('scanSlides fmEnd stops at the closing delimiter', scan.fmEnd, FM.length);
  eq('slideAt inside the front-matter', slideAt(st, 2).inFrontMatter, true);
  eq('slideAt on a separator line returns the slide it introduces',
    st.doc.lineAt(slideAt(st, st.doc.line(7).from).from).number, 7);
}

console.log('\n── padInsert ──');
{
  const st = mk('a\n');
  const { insert } = padInsert(st, st.doc.length, '---\n\n');
  eq('padInsert at EOF ends with exactly one newline', /\n$/.test(insert) && !/\n\n$/.test(insert.slice(0, -2) + 'x'), true);
  ok('padInsert puts a blank line before the separator it writes',
    invariants('a\n' + insert).length === 0, JSON.stringify('a\n' + insert));
}

console.log(fail ? `\n${fail} test(s) failed` : '\nall tests passed');
process.exit(fail ? 1 : 0);

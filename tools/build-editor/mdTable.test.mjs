// Headless regression tests for mdTable.js (no browser, no bundle).
//
//   cd tools/build-editor && node mdTable.test.mjs
//
// The state layer runs under plain node because package.json is "type": "module"
// with node_modules co-located, so @lezer/markdown table parsing can be asserted
// directly. Covers the parser facts mdTable.js depends on: empty cells emit no
// TableCell, an escaped \| stays in one cell, a table in a ```md fence emits no
// Table nodes, and the prose line GFM absorbs after a table is not a real row.

import {EditorState} from '@codemirror/state';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {columnAt, isDelimiterRow, parseAlignments, buildTableTemplate,
        emitTable, escapeTableCell, displayWidth} from './mdTable.js';
const mk = (doc) => EditorState.create({doc, extensions:[markdown({base: markdownLanguage})]});
let fail=0;
const eq=(label,got,want)=>{
  const ok=JSON.stringify(got)===JSON.stringify(want);
  if(!ok) fail++;
  console.log((ok?'ok   ':'FAIL ')+label+'  got='+JSON.stringify(got)+(ok?'':'  want='+JSON.stringify(want)));
};
const col=(doc,marker)=>{const r=columnAt(mk(doc),doc.indexOf(marker));return r?r.index:null;};
const P='|', BS=String.fromCharCode(92), BT=String.fromCharCode(96);
const t1=P+' A '+P+' B '+P+' C '+P+'\n'+P+':--'+P+'--:'+P+':-:'+P+'\n'+P+' 1 '+P+' 2 '+P+' 3 '+P+'\n';
eq('col A',col(t1,'A'),0); eq('col B',col(t1,'B'),1); eq('col C',col(t1,'C'),2);
eq('col 1',col(t1,'1'),0); eq('col 2',col(t1,'2'),1); eq('col 3',col(t1,'3'),2);
eq('colCount',columnAt(mk(t1),t1.indexOf('2')).colCount,3);
eq('delim row col',columnAt(mk(t1),t1.indexOf('--:')).index,1);
const t2=P+'          '+P+'          '+P+'\n'+P+' -------- '+P+' -------- '+P+'\n'+P+'          '+P+'          '+P+'\n';
eq('empty col0',columnAt(mk(t2),3).index,0);
eq('empty col1',columnAt(mk(t2),14).index,1);
eq('empty colCount',columnAt(mk(t2),3).colCount,2);
const t3=P+' A '+P+' B '+P+'\n'+P+'---'+P+'---'+P+'\n'+P+' p '+BS+P+' q '+P+' r '+P+'\n';
eq('esc p',col(t3,'p'),0); eq('esc q',col(t3,'q'),0); eq('esc r',col(t3,'r'),1);
const t4='A '+P+' B\n--- '+P+' ---\n1 '+P+' 2\n';
eq('bare A (pos 0)',col(t4,'A'),0); eq('bare B',col(t4,'B'),1); eq('bare 2',col(t4,'2'),1);
const t5=BT+BT+BT+'md\n'+P+' A '+P+' B '+P+'\n'+P+'---'+P+'---'+P+'\n'+BT+BT+BT+'\n';
eq('in fence null',col(t5,'A'),null);
eq('para above null',col('plain para\n\n'+P+' A '+P+' B '+P+'\n'+P+'-'+P+'-'+P+'\n','plain'),null);
eq('absorbed prose null',col(P+'A'+P+'B'+P+'\n'+P+'-'+P+'-'+P+'\n'+P+'1'+P+'2'+P+'\nZZ prose\n','ZZ'),null);
eq('no table null',col('just text\n','just'),null);
// cursor exactly on a pipe -> cell to its LEFT
const s1=mk(t1); const pipe2=t1.indexOf(P,t1.indexOf('A'));
eq('on pipe after A',columnAt(s1,pipe2).index,0);
// cursor at very end of doc
eq('end of doc',columnAt(mk(t1),t1.length-1)!==null,true);
// single column table
const t8=P+' Only '+P+'\n'+P+'------'+P+'\n'+P+' x '+P+'\n';
eq('single col',col(t8,'Only'),0);
eq('single colCount',columnAt(mk(t8),t8.indexOf('Only')).colCount,1);
// ragged rows
const t9=P+' A '+P+' B '+P+' C '+P+'\n'+P+'-'+P+'-'+P+'-'+P+'\n'+P+' 1 '+P+'\n';
eq('ragged short row col',col(t9,'1'),0);
eq('ragged colCount from header',columnAt(mk(t9),t9.indexOf('1')).colCount,3);
// pure helpers
eq('isDelim yes',isDelimiterRow(P+':--'+P+'--:'+P),true);
eq('isDelim no',isDelimiterRow(P+' A '+P+' B '+P),false);
eq('isDelim :::',isDelimiterRow(':::'),false);
eq('isDelim gfm-ish',isDelimiterRow('--- | ---'),true);
eq('align',parseAlignments(P+':--'+P+'--:'+P+':-:'+P+'---'+P),['left','right','center',null]);
const tpl=buildTableTemplate(3,2,{align:'center'});
eq('tpl lines',tpl.text.split('\n').length,4);
eq('tpl delim',/^\| :-+: \| :-+: \|$/.test(tpl.text.split('\n')[1]),true);
eq('tpl offset',tpl.firstCellOffset,2);
eq('tpl clamp rows0',buildTableTemplate(0,3).text.split('\n').length,2);
eq('tpl clamp cols99',buildTableTemplate(2,99).text.split('\n')[0].split(P).length-2,20);
eq('tpl no align',/^\| -+ \| -+ \|$/.test(buildTableTemplate(2,2).text.split('\n')[1]),true);
const st=mk(tpl.text+'\n');
eq('tpl col0 resolves',columnAt(st,3).index,0);
eq('tpl col1 resolves',columnAt(st,tpl.text.indexOf('Header 2')).index,1);
// Byte pin. buildTableTemplate is now a thin wrapper over emitTable; the regex
// assertions above would happily accept a collapsed blank row, so pin the exact
// output. If this changes, the change was NOT a pure refactor.
eq('tpl bytes',buildTableTemplate(3,2).text,
   [P+' Header 1 '+P+' Header 2 '+P,
    P+' -------- '+P+' -------- '+P,
    P+'          '+P+'          '+P,
    P+'          '+P+'          '+P].join('\n'));

// ---------- emitter ----------
// displayWidth / escapeTableCell are a MIRROR of tblDisplayWidth / tblEscapeCell
// in assets/index.html (~7944 / ~7989). These pins are the regression net for
// that sync obligation on the editor side.
eq('width ascii',displayWidth('abc'),3);
eq('width cjk',displayWidth('日本語'),6);          // CJK ideographs: U+2E80-U+A4CF
eq('width kana',displayWidth('あア'),4);
eq('width mixed',displayWidth('A日'),3);
eq('width fullwidth punct',displayWidth('（）'),4);
eq('escape pipe',escapeTableCell('a'+P+'b'),'a'+BS+P+'b');
eq('escape no double',escapeTableCell('a'+BS+P+'b'),'a'+BS+P+'b');
eq('escape newline',escapeTableCell('a\nb'),'a b');
eq('escape trims',escapeTableCell('  a  '),'a');
// CJK columns must align by DISPLAY width, not code units.
eq('emit cjk aligned',emitTable([['名前','値'],['あ','1']]).text,
   [P+' 名前 '+P+' 値  '+P,
    P+' ---- '+P+' --- '+P,
    P+' あ   '+P+' 1   '+P].join('\n'));
eq('emit escapes cells',emitTable([['a'+P+'b','c']]).text.split('\n')[0],
   P+' a'+BS+P+'b '+P+' c   '+P);
eq('emit ragged pads',emitTable([['a','b'],['c']]).text.split('\n')[2],
   P+' c   '+P+'     '+P);
eq('emit header only',emitTable([['a','b']]).text.split('\n').length,2);
eq('emit aligns per column',emitTable([['a','b','c']],
   {aligns:['left',null,'right']}).text.split('\n')[1],
   P+' :-- '+P+' --- '+P+' --: '+P);
eq('emit empty',emitTable([]).text,'');
console.log(fail? '\n'+fail+' FAILURES':'\nALL PASS');
process.exit(fail?1:0);

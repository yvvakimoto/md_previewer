// KaTeX command completion for math contexts.
//
// Fires only inside $...$ / $$...$$ / \begin{...}\end{...} (gated by
// isInsideMath from mathInputAssist.js) when the user has typed `\` plus
// optional ASCII letters. The popup is filtered live as more letters are
// typed; Enter inserts the command. For commands that take braces (\frac,
// \sqrt, …) the cursor lands inside the first brace. For big operators
// (\sum, \int, …) the inserted form is `\name_{|}^{}`.

import { isInsideMath } from './mathInputAssist.js';

// kind drives the popup `detail` column and the leading icon (`type` field).
const KIND_TYPE = {
  greek: 'variable',
  op: 'function',
  rel: 'function',
  arrow: 'function',
  bigop: 'function',
  fn: 'function',
  decoration: 'function',
  font: 'function',
  delim: 'function',
  spacing: 'text',
  envcmd: 'keyword',
  symbol: 'constant',
};

const KIND_LABEL = {
  greek: 'greek',
  op: 'operator',
  rel: 'relation',
  arrow: 'arrow',
  bigop: 'big-op',
  fn: 'function',
  decoration: 'decoration',
  font: 'font',
  delim: 'delim',
  spacing: 'spacing',
  envcmd: 'env',
  symbol: 'symbol',
};

// shape: how an accepted completion is inserted.
//   'plain'  -> "\name"                                cursor after
//   'arg1'   -> "\name{}"            cursor inside first {}
//   'arg2'   -> "\name{}{}"          cursor inside first {}
//   'bigop'  -> "\name_{}^{}"        cursor inside _{}
//   'env'    -> "\name{}"            same as arg1 (begin / end hand-off to texEnvComplete)
function buildApply(name, shape) {
  return (view, _completion, from, to) => {
    let insert;
    let cursor;
    const base = '\\' + name;
    if (shape === 'plain') {
      insert = base;
      cursor = from + insert.length;
    } else if (shape === 'arg1' || shape === 'env') {
      insert = `${base}{}`;
      cursor = from + base.length + 1;          // inside the first `{`
    } else if (shape === 'arg2') {
      insert = `${base}{}{}`;
      cursor = from + base.length + 1;          // inside the first `{`
    } else if (shape === 'bigop') {
      insert = `${base}_{}^{}`;
      cursor = from + base.length + 2;          // inside `_{`
    } else {
      insert = base;
      cursor = from + insert.length;
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: cursor },
    });
  };
}

function entry(name, kind, shape) {
  return { name, kind, shape };
}

// ------------------------------------------------------------------
// Command catalog. Aims for the KaTeX "Supported Functions" set —
// roughly 200 entries spanning every common math input.
// ------------------------------------------------------------------
const RAW = [
  // ---- Greek lower / upper / variants ----
  ...['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota',
      'kappa','lambda','mu','nu','xi','omicron','pi','rho','sigma','tau',
      'upsilon','phi','chi','psi','omega'].map(n => entry(n, 'greek', 'plain')),
  ...['Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega']
      .map(n => entry(n, 'greek', 'plain')),
  ...['varepsilon','varphi','vartheta','varrho','varsigma','varpi','varkappa']
      .map(n => entry(n, 'greek', 'plain')),

  // ---- Binary operators ----
  ...['pm','mp','times','div','cdot','ast','star','circ','bullet',
      'cap','cup','sqcap','sqcup','vee','wedge','setminus','wr',
      'oplus','otimes','odot','ominus','oslash',
      'amalg','dagger','ddagger','land','lor','bmod'].map(n => entry(n, 'op', 'plain')),

  // ---- Relations ----
  ...['leq','geq','le','ge','neq','ne','equiv','approx','cong','sim','simeq',
      'propto','asymp','doteq','prec','succ','preceq','succeq','ll','gg',
      'subset','supset','subseteq','supseteq','sqsubset','sqsupset','sqsubseteq','sqsupseteq',
      'in','ni','notin','mid','nmid','parallel','perp','vdash','dashv',
      'models','smile','frown','bowtie'].map(n => entry(n, 'rel', 'plain')),

  // ---- Arrows ----
  ...['to','gets','rightarrow','leftarrow','Rightarrow','Leftarrow',
      'leftrightarrow','Leftrightarrow','mapsto','longmapsto',
      'longrightarrow','longleftarrow','Longrightarrow','Longleftarrow',
      'longleftrightarrow','Longleftrightarrow',
      'hookrightarrow','hookleftarrow','rightharpoonup','rightharpoondown',
      'leftharpoonup','leftharpoondown','rightleftharpoons','leftrightharpoons',
      'uparrow','downarrow','updownarrow','Uparrow','Downarrow','Updownarrow',
      'nearrow','searrow','swarrow','nwarrow',
      'iff','implies','impliedby'].map(n => entry(n, 'arrow', 'plain')),

  // ---- Big operators (sub/sup form) ----
  ...['sum','prod','coprod','int','iint','iiint','iiiint','oint','oiint','oiiint',
      'bigcup','bigcap','bigvee','bigwedge','bigsqcup','bigsqcap',
      'bigoplus','bigotimes','bigodot','biguplus',
      'lim','limsup','liminf','varlimsup','varliminf','varinjlim','varprojlim',
      'max','min','sup','inf','argmax','argmin']
      .map(n => entry(n, 'bigop', 'bigop')),

  // ---- Functions / log-like (plain insertion; users type the arg themselves) ----
  ...['sin','cos','tan','cot','sec','csc',
      'arcsin','arccos','arctan','arccot','arcsec','arccsc',
      'sinh','cosh','tanh','coth','operatorname',
      'log','ln','lg','exp','det','dim','arg','gcd','lcm','Pr','ker','hom',
      'deg','mod','pmod','bmod','liminf','limsup'].map(n => entry(n, 'fn', 'plain')),

  // ---- Two-argument commands ----
  ...['frac','dfrac','tfrac','cfrac','binom','dbinom','tbinom',
      'stackrel','overset','underset','sideset']
      .map(n => entry(n, 'fn', 'arg2')),

  // ---- One-argument decorations ----
  ...['sqrt','bar','hat','vec','dot','ddot','dddot','ddddot',
      'tilde','widehat','widetilde','overline','underline',
      'overbrace','underbrace','overleftarrow','overrightarrow','overleftrightarrow',
      'underleftarrow','underrightarrow','underleftrightarrow',
      'boxed','cancel','bcancel','xcancel','sout','phantom','hphantom','vphantom']
      .map(n => entry(n, 'decoration', 'arg1')),

  // ---- Fonts / text ----
  ...['mathbb','mathcal','mathfrak','mathrm','mathbf','mathsf','mathit','mathtt',
      'mathnormal','boldsymbol','bm','text','textbf','textit','textrm',
      'textsf','texttt','textnormal','emph']
      .map(n => entry(n, 'font', 'arg1')),

  // ---- Delimiters and sizing prefixes ----
  ...['left','right','bigl','bigr','Bigl','Bigr','biggl','biggr','Biggl','Biggr',
      'big','Big','bigg','Bigg']
      .map(n => entry(n, 'delim', 'plain')),
  ...['langle','rangle','lceil','rceil','lfloor','rfloor','lvert','rvert',
      'lVert','rVert','vert','Vert','backslash']
      .map(n => entry(n, 'delim', 'plain')),

  // ---- Spacing / line breaks ----
  ...['quad','qquad','thinspace','medspace','thickspace',
      'enspace','nobreakspace','newline','hspace','vspace']
      .map(n => entry(n, 'spacing', 'plain')),

  // ---- Environment hand-off ----
  entry('begin', 'envcmd', 'env'),
  entry('end',   'envcmd', 'env'),

  // ---- Misc special symbols (plain) ----
  ...['infty','partial','nabla','forall','exists','nexists',
      'emptyset','varnothing','aleph','beth','gimel','daleth',
      'hbar','hslash','ell','Re','Im','wp','prime','backprime',
      'ldots','cdots','vdots','ddots','dots','dotsb','dotsc','dotsi','dotsm','dotso',
      'angle','measuredangle','sphericalangle','triangle','triangledown',
      'blacktriangle','square','blacksquare','diamond','blacklozenge','lozenge',
      'star','bigstar','clubsuit','diamondsuit','heartsuit','spadesuit',
      'flat','sharp','natural','top','bot','therefore','because',
      'checkmark','maltese','dag','ddag','S','P','complement',
      'circledR','circledS','copyright','pounds','yen']
      .map(n => entry(n, 'symbol', 'plain')),

  // ---- Modular / number-theoretic ----
  entry('bmod', 'op', 'plain'),
  entry('pmod', 'fn', 'arg1'),
  entry('pod',  'fn', 'arg1'),
];

// Dedupe (some categories repeat names like `bmod`, `limsup`).
const SEEN = new Set();
const COMMANDS = [];
for (const e of RAW) {
  if (SEEN.has(e.name)) continue;
  SEEN.add(e.name);
  COMMANDS.push(e);
}

// Pre-build CompletionResult option objects.
const OPTIONS = COMMANDS.map(({ name, kind, shape }) => ({
  label: '\\' + name,
  displayLabel: '\\' + name,
  type: KIND_TYPE[kind] || 'text',
  detail: KIND_LABEL[kind] || '',
  apply: buildApply(name, shape),
}));

export function katexCommandCompletionSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);

  // Match `\` plus zero-or-more ASCII letters at the end of the typed line.
  const m = /\\([A-Za-z]*)$/.exec(before);
  if (!m) return null;

  const cmdStart = line.from + m.index;

  // Only fire inside math contexts.
  if (!isInsideMath(context.state, cmdStart)) return null;

  return {
    from: cmdStart,
    to: context.pos,
    options: OPTIONS,
    validFor: /^\\[A-Za-z]*$/,
  };
}

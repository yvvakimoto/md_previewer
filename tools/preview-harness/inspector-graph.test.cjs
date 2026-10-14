// Regression tests for the Mermaid inspector's pure graph layer.
//
//   node tools/preview-harness/inspector-graph.test.cjs      (run from the repo root)
//
// assets/inspector/graph.js is UMD-shaped precisely so it can be required here:
// the window (inspector.js) only maps these ids to SVG elements, so every
// highlight set the reader sees is decided by the functions tested below.

const G = require('../../assets/inspector/graph.js');

let fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok   ' + label);
  else { fail++; console.log('FAIL ' + label + '\n     got  ' + g + '\n     want ' + w); }
};
const sorted = (s) => [...s].sort();

// A diamond with a side branch, a cycle, a multi-edge, an id containing `_`
// (the reason the model comes from mermaid's db, not from SVG edge ids), and a
// dangling edge whose end does not exist.
//
//   A_1 → B → D → E          C → C2 → C   (cycle)
//   A_1 → C → D              X (isolated)
//   A_1 → C (twice)
const nodes = ['A_1', 'B', 'C', 'C2', 'D', 'E', 'X'].map((id) => ({ id, label: 'n-' + id }));
const edges = [
  { id: 'e1', start: 'A_1', end: 'B', label: '120 kW' },
  { id: 'e2', start: 'A_1', end: 'C', label: '30 kW' },
  { id: 'e2b', start: 'A_1', end: 'C', label: '10 kW' },
  { id: 'e3', start: 'B', end: 'D', label: '100 kW' },
  { id: 'e4', start: 'C', end: 'D', label: '35 kW' },
  { id: 'e5', start: 'D', end: 'E', label: '130 kW' },
  { id: 'e6', start: 'C', end: 'C2', label: '' },
  { id: 'e7', start: 'C2', end: 'C', label: '2 kWh' },
  { id: 'ghost', start: 'D', end: 'NOPE', label: '' },
];
const g = G.buildGraph(nodes, edges);

eq('dangling edge dropped', g.edges.has('ghost'), false);
eq('multi-edge kept as two edges', g.out.get('A_1').map((e) => e.id), ['e1', 'e2', 'e2b']);

eq('descendants of A_1', sorted(G.descendants(g, 'A_1')), ['B', 'C', 'C2', 'D', 'E']);
eq('ancestors of D', sorted(G.ancestors(g, 'D')), ['A_1', 'B', 'C', 'C2']);
eq('cycle: C reaches itself', G.descendants(g, 'C').has('C'), true);
eq('unknown node reaches nothing', G.descendants(g, 'NOPE').size, 0);

const nb = G.neighborhood(g, 'C');
eq('neighborhood nodes', sorted(nb.nodes), ['A_1', 'C', 'C2', 'D']);
eq('neighborhood edges', sorted(nb.edges), ['e2', 'e2b', 'e4', 'e6', 'e7']);

const up = G.trace(g, 'D', 'in');
eq('upstream trace nodes', sorted(up.nodes), ['A_1', 'B', 'C', 'C2', 'D']);
eq('upstream trace edges', sorted(up.edges), ['e1', 'e2', 'e2b', 'e3', 'e4', 'e6', 'e7']);
const down = G.trace(g, 'B', 'out');
eq('downstream trace', [sorted(down.nodes), sorted(down.edges)], [['B', 'D', 'E'], ['e3', 'e5']]);

// All paths A_1 → E: both diamond arms, the multi-edge, AND the C↔C2 cycle
// (a walk may loop through it), but not the isolated X.
const p = G.pathsBetween(g, 'A_1', 'E');
eq('paths A_1→E found forward', [p.found, p.reversed], [true, false]);
eq('paths A_1→E nodes', sorted(p.nodes), ['A_1', 'B', 'C', 'C2', 'D', 'E']);
eq('paths A_1→E edges', sorted(p.edges), ['e1', 'e2', 'e2b', 'e3', 'e4', 'e5', 'e6', 'e7']);
const pb = G.pathsBetween(g, 'B', 'D');
eq('paths B→D is just the one edge', [sorted(pb.nodes), sorted(pb.edges)], [['B', 'D'], ['e3']]);

const r = G.pathsBetween(g, 'E', 'B');
eq('clicked against the flow → reversed', [r.found, r.reversed, sorted(r.edges)], [true, true, ['e3', 'e5']]);
const none = G.pathsBetween(g, 'B', 'C');
eq('siblings: no path either way', [none.found, sorted(none.nodes), none.edges.size], [false, ['B', 'C'], 0]);
eq('isolated node: no path', G.pathsBetween(g, 'X', 'A_1').found, false);
eq('same node twice: no path', G.pathsBetween(g, 'B', 'B').found, false);

// ---- parseQuantity
const q = (s) => G.parseQuantity(s);
eq('qty 120 kW', q('120 kW'), { value: 120, unit: 'kW' });
eq('qty no space', q('35kW'), { value: 35, unit: 'kW' });
eq('qty thousands', q('1,200 kWh/年'), { value: 1200, unit: 'kWh/年' });
eq('qty decimal + exp', q('1.5e3 W'), { value: 1500, unit: 'W' });
eq('qty negative (minus sign)', q('−20 kW'), { value: -20, unit: 'kW' });
eq('qty percent', q('損失 8%'), { value: 8, unit: '%' });
eq('qty japanese unit', q('熱 40 キロワット'), { value: 40, unit: 'キロワット' });
eq('qty unitless', q('η=0.9'), { value: 0.9, unit: '' });
eq('qty trailing paren', q('12 MW (peak)'), { value: 12, unit: 'MW' });
eq('qty none', q('heat'), null);
eq('qty empty', q(''), null);
eq('qty null', q(null), null);

// ---- balance
const b = G.balance(g, 'C');
eq('balance C rows', b.rows.map((x) => [x.unit, x.in, x.out, x.net]),
   [['kW', 40, 35, 5], ['kWh', 2, 0, 2]]);
eq('balance C unlabeled', b.unlabeled, 1);
const bd = G.balance(g, 'D');
eq('balance D closes', bd.rows.map((x) => x.net), [5]);

// ---- search
eq('search by label', G.search(g, 'N-C'), ['C', 'C2']);
eq('search by id with underscore', G.search(g, 'a_1'), ['A_1']);
eq('search empty', G.search(g, '  '), []);
const gg = G.buildGraph([{ id: 'grp', label: 'Plant', isGroup: true }, { id: 'p', label: 'plant pump' }], []);
eq('search puts groups last', G.search(gg, 'plant'), ['p', 'grp']);

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);

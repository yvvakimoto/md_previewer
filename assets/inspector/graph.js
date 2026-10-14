// Pure graph logic for the Mermaid inspector window (assets/inspector.html).
//
// No DOM here on purpose: everything below is unit-tested under plain node by
// tools/preview-harness/inspector-graph.test.cjs, so the window script
// (inspector.js) only maps ids to SVG elements and back.
//
// The model is built from mermaid's own flowchart db (`db.getData()`), never by
// parsing the SVG: node ids there are the author's ids, which may contain `_`,
// so the SVG edge id `L_A_1_B_0` cannot be split back into its two ends.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.InspectorGraph = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // nodes: [{id, label}], edges: [{id, start, end, label}].
    // Edges whose ends are unknown are dropped rather than invented — a stale
    // db entry must not create a phantom node that the SVG has no element for.
    function buildGraph(nodes, edges) {
        const byId = new Map();
        for (const n of nodes) byId.set(n.id, { id: n.id, label: n.label || '', isGroup: !!n.isGroup });
        const out = new Map(), inc = new Map();
        for (const id of byId.keys()) { out.set(id, []); inc.set(id, []); }
        const edgeById = new Map();
        for (const e of edges) {
            if (!byId.has(e.start) || !byId.has(e.end)) continue;
            const edge = { id: e.id, start: e.start, end: e.end, label: e.label || '' };
            edgeById.set(edge.id, edge);
            out.get(edge.start).push(edge);
            inc.get(edge.end).push(edge);
        }
        return { nodes: byId, edges: edgeById, out, inc };
    }

    // Iterative BFS over one direction. Cycle-safe; the start node is NOT in the
    // result unless a cycle leads back to it (callers add it themselves).
    function reach(g, start, dir) {
        const adj = dir === 'out' ? g.out : g.inc;
        const seen = new Set();
        if (!g.nodes.has(start)) return seen;
        const queue = [start];
        while (queue.length) {
            const v = queue.shift();
            for (const e of adj.get(v) || []) {
                const w = dir === 'out' ? e.end : e.start;
                if (!seen.has(w)) { seen.add(w); queue.push(w); }
            }
        }
        return seen;
    }
    function descendants(g, id) { return reach(g, id, 'out'); }
    function ancestors(g, id) { return reach(g, id, 'in'); }

    // A node plus every edge touching it and every node at the other end.
    function neighborhood(g, id) {
        const nodes = new Set([id]), edges = new Set();
        for (const e of g.out.get(id) || []) { edges.add(e.id); nodes.add(e.end); }
        for (const e of g.inc.get(id) || []) { edges.add(e.id); nodes.add(e.start); }
        return { nodes, edges };
    }

    // Everything upstream (dir 'in') or downstream (dir 'out') of `id`, with the
    // edges that lie inside that closure.
    function trace(g, id, dir) {
        const nodes = reach(g, id, dir);
        nodes.add(id);
        return { nodes, edges: edgesWithin(g, nodes, nodes) };
    }

    // Edges u→v with u ∈ from and v ∈ to.
    function edgesWithin(g, from, to) {
        const edges = new Set();
        for (const e of g.edges.values()) if (from.has(e.start) && to.has(e.end)) edges.add(e.id);
        return edges;
    }

    // Every directed path from a to b: the node set ({a} ∪ desc(a)) ∩ ({b} ∪ anc(b)),
    // and every edge with both ends in it. That is exactly the union of all a→b
    // walks, computed with two BFS passes instead of path enumeration (which is
    // exponential on a diamond-heavy energy diagram). If nothing leads a→b the
    // reverse direction is tried, so the reader need not pick the clicks in
    // flow order. `reversed` says which one answered; `found` false means neither.
    function pathsBetween(g, a, b) {
        const one = between(g, a, b);
        if (one) return { nodes: one.nodes, edges: one.edges, found: true, reversed: false };
        const two = between(g, b, a);
        if (two) return { nodes: two.nodes, edges: two.edges, found: true, reversed: true };
        return { nodes: new Set([a, b]), edges: new Set(), found: false, reversed: false };
    }
    function between(g, a, b) {
        if (!g.nodes.has(a) || !g.nodes.has(b)) return null;
        if (a === b) return null;
        const fwd = descendants(g, a); fwd.add(a);
        if (!fwd.has(b)) return null;
        const back = ancestors(g, b); back.add(b);
        const nodes = new Set();
        for (const v of fwd) if (back.has(v)) nodes.add(v);
        return { nodes, edges: edgesWithin(g, nodes, nodes) };
    }

    // First number in an edge label, with the unit-looking token right after it.
    //   "120 kW" → {value:120, unit:"kW"};  "1,200kWh/年" → {1200, "kWh/年"}
    //   "η=0.9"  → {0.9, ""};  "熱" → null
    // Units are compared as strings and never converted: summing kW with MW
    // would need a unit table this tool has no business owning, so mixed units
    // are simply reported in separate rows.
    const QTY_RE = /([-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([A-Za-zµμΩ°%　-鿿][^\s,;:()（）\[\]]*)?/;
    function parseQuantity(label) {
        if (label == null) return null;
        const m = String(label).match(QTY_RE);
        if (!m) return null;
        const value = parseFloat(m[1].replace(/,/g, '').replace('−', '-'));
        if (!isFinite(value)) return null;
        return { value, unit: (m[2] || '').trim() };
    }

    // In / out totals per unit for one node. Edges without a number are counted
    // in `unlabeled` so the panel can say the balance is incomplete.
    function balance(g, id) {
        const rows = new Map();
        let unlabeled = 0;
        const add = (e, side) => {
            const q = parseQuantity(e.label);
            if (!q) { unlabeled++; return; }
            if (!rows.has(q.unit)) rows.set(q.unit, { unit: q.unit, in: 0, out: 0, nIn: 0, nOut: 0 });
            const r = rows.get(q.unit);
            if (side === 'in') { r.in += q.value; r.nIn++; } else { r.out += q.value; r.nOut++; }
        };
        for (const e of g.inc.get(id) || []) add(e, 'in');
        for (const e of g.out.get(id) || []) add(e, 'out');
        return {
            rows: [...rows.values()].map(r => Object.assign(r, { net: r.in - r.out })),
            unlabeled,
        };
    }

    // Substring search over id and label, case-insensitive. Groups last.
    function search(g, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const hits = [];
        for (const n of g.nodes.values()) {
            if (n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)) hits.push(n.id);
        }
        hits.sort((x, y) => (g.nodes.get(x).isGroup - g.nodes.get(y).isGroup));
        return hits;
    }

    return {
        buildGraph, descendants, ancestors, neighborhood, trace,
        pathsBetween, parseQuantity, balance, search,
    };
});

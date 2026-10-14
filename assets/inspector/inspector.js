// Mermaid inspector window — see .claude/docs/inspector.md.
//
// The host (src/inspector_registry.rs) injects `window.__inspectorInit` before
// this runs and later calls `window.__inspectorLoad(payload)` whenever the
// preview re-renders the followed block. payload = {kind: 'open'|'update', src,
// ordinal, line, file}. The window renders mermaid ITSELF rather than receiving
// the preview's SVG: only a fresh render comes with mermaid's db, and the db is
// the only reliable source for edge endpoints (see graph.js).
(function () {
    'use strict';
    const G = window.InspectorGraph;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const $ = (id) => document.getElementById(id);

    // ---------------------------------------------------------------- i18n
    // Key namespace `insp.*` — disjoint from index.html (everything else) and
    // tools/build-editor/i18n.js (`ed.*`). Key-major like both of those tables.
    const I18N = {
        'insp.fit':          { ja: '全体表示', en: 'Fit' },
        'insp.fitTitle':     { ja: '図全体をウィンドウに収める (F / Ctrl+0)', en: 'Fit the whole diagram (F / Ctrl+0)' },
        'insp.up':           { ja: '上流', en: 'Upstream' },
        'insp.upTitle':      { ja: '選択ノードの上流をすべて強調 (U)', en: 'Highlight everything upstream of the selection (U)' },
        'insp.down':         { ja: '下流', en: 'Downstream' },
        'insp.downTitle':    { ja: '選択ノードの下流をすべて強調 (D)', en: 'Highlight everything downstream of the selection (D)' },
        'insp.clear':        { ja: '解除', en: 'Clear' },
        'insp.clearTitle':   { ja: '選択を解除 (Esc)', en: 'Clear the selection (Esc)' },
        'insp.searchPh':     { ja: 'ノードを検索 (Ctrl+F)', en: 'Search nodes (Ctrl+F)' },
        'insp.minimap':      { ja: 'ミニマップ', en: 'Minimap' },
        'insp.panel':        { ja: 'パネル', en: 'Panel' },
        'insp.hint':         { ja: 'クリック: 選択 / Shift+クリック: 経路 / ドラッグ: 移動 / Ctrl+ホイール: 拡大縮小 / ?: ヘルプ',
                               en: 'Click: select / Shift+click: paths / Drag: pan / Ctrl+wheel: zoom / ?: help' },
        'insp.helpTitle':    { ja: 'インスペクタの操作', en: 'Inspector controls' },
        'insp.help.click':   { ja: 'ノードを選択し、接続するエッジと隣接ノードを強調。結線（線・ラベル）をクリックすると、その結線と両端のノードを強調。同じものをもう一度クリックで解除。サブグラフ名もクリックできる',
                               en: 'Select a node and highlight its edges and neighbours. Click a connection (line or label) to highlight it and its two ends. Click the same thing again to clear. Subgraph titles are clickable too' },
        'insp.help.shiftClick': { ja: '2つ目のノードを選び、2ノード間の向き付き経路をすべて強調（流れに逆らう順でクリックしても可）',
                               en: 'Pick a second node and highlight every directed path between the two (either click order works)' },
        'insp.help.updown':  { ja: '選択ノードの上流 / 下流をすべて強調。もう一度押すと戻る', en: 'Highlight everything upstream / downstream of the selection; press again to go back' },
        'insp.help.esc':     { ja: '選択を解除', en: 'Clear the selection' },
        'insp.help.drag':    { ja: '背景をドラッグして移動（中ボタンでも可）', en: 'Drag the background to pan (middle button too)' },
        'insp.help.wheel':   { ja: '縦 / 横にスクロール（タッチパッドは 2 本指でどの方向にも移動）', en: 'Scroll vertically / horizontally (two fingers on a touchpad pan in any direction)' },
        'insp.help.ctrlWheel': { ja: 'カーソル位置を中心に拡大縮小（タッチパッドは 2 本指のピンチ）', en: 'Zoom around the cursor (two-finger pinch on a touchpad)' },
        'insp.help.ctrlPlus': { ja: '画面中央を中心に拡大 / 縮小', en: 'Zoom in / out around the centre' },
        'insp.help.fit':     { ja: '全体表示', en: 'Fit the whole diagram' },
        'insp.help.arrows':  { ja: '移動（Shift で大きく）', en: 'Pan (Shift for larger steps)' },
        'insp.help.search':  { ja: 'ノード検索。Enter で次、Shift+Enter で前', en: 'Search nodes; Enter for next, Shift+Enter for previous' },
        'insp.help.toggles': { ja: 'ミニマップ / サイドパネルの表示切替', en: 'Toggle the minimap / side panel' },
        'insp.help.close':   { ja: 'インスペクタを閉じる', en: 'Close the inspector' },
        'insp.noLib':        { ja: 'Mermaid ライブラリを読み込めませんでした（assets/libs/mermaid.min.js）。',
                               en: 'Could not load the Mermaid library (assets/libs/mermaid.min.js).' },
        'insp.renderError':  { ja: 'Mermaid の描画に失敗しました:', en: 'Mermaid failed to render:' },
        'insp.staleError':   { ja: 'ソースにエラーがあります（直前の図を表示中）: {msg}', en: 'The source has an error (showing the last good diagram): {msg}' },
        'insp.notFlow':      { ja: 'この図はフローチャートではないため、拡大縮小・移動のみ使えます。ノードの強調・経路・収支は flowchart / graph で使えます。',
                               en: 'This diagram is not a flowchart, so only pan and zoom are available. Highlighting, paths and balances need flowchart / graph.' },
        'insp.nothing':      { ja: 'ノードをクリックすると、接続とエネルギー収支をここに表示します。', en: 'Click a node to see its connections and balance here.' },
        'insp.stats':        { ja: '{nodes} ノード / {edges} エッジ', en: '{nodes} nodes / {edges} edges' },
        'insp.legendIn':     { ja: '流入', en: 'in' },
        'insp.legendOut':    { ja: '流出', en: 'out' },
        'insp.legendPath':   { ja: '経路', en: 'path' },
        'insp.inEdges':      { ja: '流入 ({n})', en: 'Incoming ({n})' },
        'insp.outEdges':     { ja: '流出 ({n})', en: 'Outgoing ({n})' },
        'insp.none':         { ja: 'なし', en: 'none' },
        'insp.balance':      { ja: '収支', en: 'Balance' },
        'insp.unit':         { ja: '単位', en: 'Unit' },
        'insp.sumIn':        { ja: '流入', en: 'In' },
        'insp.sumOut':       { ja: '流出', en: 'Out' },
        'insp.net':          { ja: '差 (入−出)', en: 'Net (in−out)' },
        'insp.noUnit':       { ja: '（単位なし）', en: '(no unit)' },
        'insp.unlabeled':    { ja: '数値ラベルのないエッジが {n} 本あり、収支に含まれていません。', en: '{n} edge(s) carry no numeric label and are not counted.' },
        'insp.noNumbers':    { ja: 'エッジラベルに数値がないため、収支は計算できません。', en: 'No edge label carries a number, so there is no balance.' },
        'insp.mixedUnits':   { ja: '単位は換算せず、単位ごとに集計しています。', en: 'Units are not converted; each unit is totalled separately.' },
        'insp.pathFound':    { ja: '{nodes} ノード / {edges} エッジが経路上にあります。', en: '{nodes} nodes / {edges} edges lie on a path.' },
        'insp.pathReversed': { ja: '流れの向きは {from} → {to} です。', en: 'The flow runs {from} → {to}.' },
        'insp.noPath':       { ja: 'この2ノードをつなぐ向き付きの経路はありません。', en: 'No directed path connects these two nodes.' },
        'insp.upTitleH':     { ja: '{label} の上流', en: 'Upstream of {label}' },
        'insp.downTitleH':   { ja: '{label} の下流', en: 'Downstream of {label}' },
        'insp.traceCount':   { ja: '{nodes} ノード / {edges} エッジ', en: '{nodes} nodes / {edges} edges' },
        'insp.sources':      { ja: '起点（流入のないノード）', en: 'Sources (no incoming edge)' },
        'insp.sinks':        { ja: '終点（流出のないノード）', en: 'Sinks (no outgoing edge)' },
        'insp.edge':         { ja: 'エッジ', en: 'Edge' },
        'insp.group':        { ja: 'サブグラフ', en: 'Subgraph' },
        'insp.searchNone':   { ja: '0 件', en: 'none' },
    };
    window.__inspectorI18n = I18N;   // read by tools/preview-harness/i18ncheck.py

    // Same rules as the preview's __detectUiLang(): the shared, unprefixed
    // `uiLang` key wins; its absence means "follow the OS list".
    function resolveLang() {
        let stored = null;
        try { stored = localStorage.getItem('uiLang'); } catch (e) { /* ignore */ }
        if (stored === 'ja' || stored === 'en') return stored;
        const cands = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
        for (const l of cands) {
            const tag = String(l).toLowerCase();
            if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
            if (tag === 'en' || tag.startsWith('en-')) return 'en';
        }
        return 'en';
    }
    let lang = resolveLang();
    function t(key, params) {
        const m = I18N[key];
        let s = m ? (m[lang] || m.ja) : key;
        if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ''));
        return s;
    }
    function applyI18n() {
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
            for (const pair of el.dataset.i18nAttr.split(';')) {
                const [attr, key] = pair.split(':');
                if (attr && key) el.setAttribute(attr, t(key));
            }
        });
    }

    // --------------------------------------------------------- mermaid setup
    // ⚠ MIRROR of mermaidBaseConfig() in assets/index.html — the inspector must lay
    // the diagram out exactly as the preview did, or the reader is inspecting a
    // different picture. Keep the two in step (CLAUDE.md, mirror table).
    function mermaidConfig(dark) {
        return {
            startOnLoad: false,
            theme: dark ? 'dark' : 'default',
            securityLevel: 'loose',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
            layout: 'dagre',
            look: 'classic',
        };
    }
    // ⚠ MIRROR of parseMermaidScale() in assets/index.html: leading blank lines
    // and `scale:` lines are consumed before mermaid sees the source. The factor
    // itself is meaningless here (the inspector zooms), so only the body is kept.
    function stripScale(src) {
        const lines = String(src || '').split('\n');
        let i = 0;
        while (i < lines.length) {
            const tl = lines[i].trim();
            if (tl === '' || /^scale:\s*([\d.]+)\s*$/.test(tl)) { i++; continue; }
            break;
        }
        return lines.slice(i).join('\n');
    }
    function isDark() {
        try {
            const v = localStorage.getItem('darkMode');
            if (v === 'true' || v === 'false') return v === 'true';
        } catch (e) { /* ignore */ }
        return !!(payload && payload.dark);
    }

    // ------------------------------------------------------------------ state
    const stage = $('stage');
    let payload = null;
    let svg = null, vp = null, svgId = '';
    let world = { x: 0, y: 0, w: 1, h: 1 };
    let graph = null;                 // null for a non-flowchart diagram
    const nodeEl = new Map(), elNode = new Map();   // node id ↔ <g.node> / <g.cluster>
    const edgeEl = new Map(), elEdge = new Map();   // edge id → {path, label}; element → id
    let sel = { mode: 'none', a: null, b: null, edge: null };
    let result = null;                // {nodes:Set, edges:Set, cls:(edge)=>class}
    let matches = [], matchIdx = -1;
    let decorated = new Set();
    let renderSeq = 0, mounts = 0;
    let showMinimap = true, showPanel = true;

    // Viewport: screen = s * world + t. `target` is where input sends it; `view`
    // chases it every frame. Interpolating s and t LINEARLY keeps an anchored
    // point exactly fixed throughout the animation (its screen position is linear
    // in (s, t)), so cursor-anchored zoom never drifts mid-glide.
    const S_MIN = 0.05, S_MAX = 8, TAU_MS = 55, FIT_MAX = 1.5, FIT_PAD = 0.94;
    let view = { s: 1, tx: 0, ty: 0 }, target = { s: 1, tx: 0, ty: 0 };
    let animId = 0, animLast = 0;

    function stageSize() { return { w: stage.clientWidth, h: stage.clientHeight }; }
    function clampS(s) { return Math.min(S_MAX, Math.max(S_MIN, s)); }
    function kick() {
        if (!animId) { animLast = performance.now(); animId = requestAnimationFrame(step); }
    }
    function step(now) {
        const dt = Math.min(64, now - animLast); animLast = now;
        const k = 1 - Math.exp(-dt / TAU_MS);
        view.s += (target.s - view.s) * k;
        view.tx += (target.tx - view.tx) * k;
        view.ty += (target.ty - view.ty) * k;
        const done = Math.abs(target.s - view.s) / target.s < 1e-4
            && Math.abs(target.tx - view.tx) < 0.05 && Math.abs(target.ty - view.ty) < 0.05;
        if (done) view = { ...target };
        applyView();
        animId = done ? 0 : requestAnimationFrame(step);
    }
    function jump() { view = { ...target }; if (animId) { cancelAnimationFrame(animId); animId = 0; } applyView(); }
    function applyView() {
        if (vp) vp.setAttribute('transform', `matrix(${view.s},0,0,${view.s},${view.tx},${view.ty})`);
        $('zoom-label').textContent = Math.round(view.s * 100) + '%';
        updateMinimapRect();
    }
    // Zoom `target` by `factor` keeping stage point (cx, cy) fixed.
    function zoomAt(factor, cx, cy) {
        const s1 = clampS(target.s * factor), f = s1 / target.s;
        target.tx = cx - (cx - target.tx) * f;
        target.ty = cy - (cy - target.ty) * f;
        target.s = s1;
        kick();
    }
    function zoomCenter(factor) { const { w, h } = stageSize(); zoomAt(factor, w / 2, h / 2); }
    function fit(animate) {
        const { w, h } = stageSize();
        if (!w || !h) return;
        const s = clampS(Math.min(FIT_MAX, Math.min(w / world.w, h / world.h) * FIT_PAD));
        target = { s, tx: (w - world.w * s) / 2 - world.x * s, ty: (h - world.h * s) / 2 - world.y * s };
        if (animate) kick(); else jump();
    }
    // Centre a stage-space rect (from getBoundingClientRect), zooming in only if
    // it is too small to read and out only if it does not fit.
    function centerOnEl(el) {
        if (!el) return;
        const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
        const { w, h } = stageSize();
        // Back to world units through the CURRENT view (what the rect was measured in).
        const wx = (r.left - sr.left - view.tx) / view.s, wy = (r.top - sr.top - view.ty) / view.s;
        const ww = r.width / view.s, wh = r.height / view.s;
        let s = target.s;
        if (ww * s > w * 0.8 || wh * s > h * 0.8) s = Math.min(w * 0.8 / ww, h * 0.8 / wh);
        if (s < 0.6) s = Math.min(0.6, Math.min(w * 0.8 / ww, h * 0.8 / wh));
        s = clampS(s);
        target = { s, tx: w / 2 - (wx + ww / 2) * s, ty: h / 2 - (wy + wh / 2) * s };
        kick();
    }

    // -------------------------------------------------------------- rendering
    function showMessage(text, isError) {
        const m = $('message');
        m.textContent = text;
        m.classList.toggle('error', !!isError);
        m.classList.add('show');
    }
    function hideMessage() { $('message').classList.remove('show'); }
    function setHint(text, isError) {
        const h = $('hint');
        if (text == null) { h.textContent = t('insp.hint'); h.style.color = ''; return; }
        h.textContent = text;
        h.style.color = isError ? '#e03131' : '';
    }

    async function render(keepState) {
        const seq = ++renderSeq;
        const dark = isDark();
        document.body.classList.toggle('dark', dark);
        if (window.__mermaidLoadFailed || typeof mermaid === 'undefined') {
            showMessage(t('insp.noLib'), true);
            return;
        }
        mermaid.initialize(mermaidConfig(dark));
        const body = stripScale(payload.src);
        const renderId = 'insp-svg-' + seq;
        let diag = null, data = null, svgText = '';
        try {
            diag = await mermaid.mermaidAPI.getDiagramFromText(body);
            // Read the db BEFORE render(): render parses again into its own diagram,
            // and this snapshot must describe the same source text.
            if (/^flowchart/.test(diag.type) && diag.db && typeof diag.db.getData === 'function') {
                data = diag.db.getData();
            }
            svgText = (await mermaid.render(renderId, body)).svg;
        } catch (e) {
            // mermaid leaves its scratch container behind on a failed render.
            for (const id of [renderId, 'd' + renderId]) { const n = document.getElementById(id); if (n) n.remove(); }
            if (seq !== renderSeq) return;
            const msg = (e && (e.message || e.str)) || String(e);
            // Mid-typing in the editor the source is often briefly invalid: keep the
            // last good diagram (and the reader's place in it) instead of blanking.
            if (svg) setHint(t('insp.staleError', { msg: msg.split('\n')[0] }), true);
            else showMessage(t('insp.renderError') + '\n\n' + msg, true);
            return;
        }
        if (seq !== renderSeq) return;   // a newer payload overtook this render
        hideMessage();
        setHint(null);
        mount(svgText, data, keepState);
    }

    function mount(svgText, data, keepState) {
        const holder = document.createElement('div');
        holder.innerHTML = svgText;
        const next = holder.querySelector('svg');
        if (!next) return;
        const vb = next.viewBox && next.viewBox.baseVal;
        const hadWorld = !!svg;
        if (vb && vb.width > 0 && vb.height > 0) world = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
        svgId = next.id;
        next.removeAttribute('viewBox');
        next.removeAttribute('width');
        next.removeAttribute('height');
        next.style.maxWidth = 'none';
        next.classList.add('insp-diagram');
        // One transform group around everything drawable; <style>/<defs> stay at
        // the root so mermaid's `#svgId …` rules and marker ids keep resolving.
        vp = document.createElementNS(SVGNS, 'g');
        vp.setAttribute('class', 'insp-vp');
        for (const c of [...next.childNodes]) {
            const tag = c.nodeName.toLowerCase();
            if (tag !== 'style' && tag !== 'defs') vp.appendChild(c);
        }
        next.appendChild(vp);
        if (svg) svg.replaceWith(next); else stage.insertBefore(next, stage.firstChild);
        svg = next;
        mounts++;
        decorated = new Set();

        indexGraph(data);
        result = null;   // describes the OLD graph until recompute() below
        if (!keepState || !hadWorld) {
            sel = { mode: 'none', a: null, b: null, edge: null };
            fit(false);
        } else {
            reconcileSelection();
            applyView();
        }
        runSearch($('search').value, false);
        recompute();
        buildMinimap();
    }

    function indexGraph(data) {
        nodeEl.clear(); elNode.clear(); edgeEl.clear(); elEdge.clear();
        graph = null;
        if (!data) return;
        const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
        const nodes = [];
        for (const n of data.nodes) {
            const el = svg.querySelector('#' + CSS.escape(svgId + '-' + (n.domId || n.id)));
            if (el) { nodeEl.set(n.id, el); elNode.set(el, n.id); }
            // The label as DRAWN (markdown / <br> already resolved), falling back
            // to the raw db label.
            const shown = n.isGroup ? textOf(el && el.querySelector('.cluster-label')) : textOf(el);
            nodes.push({ id: n.id, label: shown || String(n.label || n.id), isGroup: !!n.isGroup });
        }
        const paths = new Map(), labels = new Map();
        svg.querySelectorAll('path[data-edge][data-id]').forEach((p) => paths.set(p.getAttribute('data-id'), p));
        svg.querySelectorAll('g.edgeLabel .label[data-id]').forEach((l) => labels.set(l.getAttribute('data-id'), l.closest('g.edgeLabel')));
        const edges = [];
        for (const e of data.edges) {
            const path = paths.get(e.id) || null, label = labels.get(e.id) || null;
            edgeEl.set(e.id, { path, label });
            if (path) {
                elEdge.set(path, e.id);
                // A drawn edge is a ~2px stroke — nearly impossible to hit. Put a
                // transparent, wide twin right behind it to catch the click. It
                // drops data-edge / id / markers, so no selector or lookup that
                // means "the edge" ever matches it.
                const hit = path.cloneNode(false);
                for (const a of ['id', 'data-edge', 'data-id', 'data-et', 'data-points', 'marker-start', 'marker-end', 'style', 'class']) hit.removeAttribute(a);
                hit.setAttribute('class', 'insp-hit');
                path.parentNode.insertBefore(hit, path);
                elEdge.set(hit, e.id);
            }
            if (label) elEdge.set(label, e.id);
            edges.push({ id: e.id, start: e.start, end: e.end, label: textOf(label) || String(e.label || '') });
        }
        graph = G.buildGraph(nodes, edges);
    }

    // After a live update, keep what still exists and drop what does not.
    function reconcileSelection() {
        if (!graph) { sel = { mode: 'none', a: null, b: null, edge: null }; return; }
        if (sel.mode === 'edge') {
            if (!graph.edges.has(sel.edge)) sel = { mode: 'none', a: null, b: null, edge: null };
            return;
        }
        if (sel.a && !graph.nodes.has(sel.a)) sel = { mode: 'none', a: null, b: null, edge: null };
        if (sel.mode === 'path' && !graph.nodes.has(sel.b)) sel = { mode: 'node', a: sel.a, b: null, edge: null };
    }

    // ------------------------------------------------------------ highlighting
    function recompute() {
        result = null;
        if (graph) {
            const g = graph;
            if (sel.mode === 'node') {
                const r = G.neighborhood(g, sel.a);
                const a = sel.a;
                result = { ...r, cls: (e) => (e.start === a ? 'insp-out' : 'insp-in') };
            } else if (sel.mode === 'up' || sel.mode === 'down') {
                const r = G.trace(g, sel.a, sel.mode === 'up' ? 'in' : 'out');
                const c = sel.mode === 'up' ? 'insp-in' : 'insp-out';
                result = { ...r, cls: () => c };
            } else if (sel.mode === 'path') {
                const r = G.pathsBetween(g, sel.a, sel.b);
                result = { nodes: r.nodes, edges: r.edges, found: r.found, reversed: r.reversed, cls: () => 'insp-path' };
            } else if (sel.mode === 'edge') {
                const e = g.edges.get(sel.edge);
                result = { nodes: new Set([e.start, e.end]), edges: new Set([e.id]), cls: () => 'insp-path' };
            }
        }
        decorate();
        renderPanel();
        updateButtons();
        scheduleMinimap();
    }

    const DECOR = ['insp-on', 'insp-in', 'insp-out', 'insp-path', 'insp-sel', 'insp-sel2', 'insp-match'];
    function decorate() {
        for (const el of decorated) el.classList.remove(...DECOR);
        decorated = new Set();
        if (!svg) return;
        const mark = (el, ...c) => { if (el) { el.classList.add(...c); decorated.add(el); } };
        svg.classList.toggle('has-hl', !!result);
        if (result) {
            for (const id of result.nodes) mark(nodeEl.get(id), 'insp-on');
            for (const id of result.edges) {
                const e = graph.edges.get(id), els = edgeEl.get(id);
                if (!e || !els) continue;
                const c = result.cls(e);
                mark(els.path, 'insp-on', c);
                mark(els.label, 'insp-on');
            }
            // A subgraph containing a highlighted node stays legible.
            for (const id of result.nodes) {
                const el = nodeEl.get(id);
                let c = el && el.parentElement && el.parentElement.closest('g.cluster');
                while (c) { mark(c, 'insp-on'); c = c.parentElement && c.parentElement.closest('g.cluster'); }
            }
        }
        if (sel.a) mark(nodeEl.get(sel.a), 'insp-sel');
        if (sel.mode === 'edge' && graph && graph.edges.has(sel.edge)) {
            const e = graph.edges.get(sel.edge);
            mark(nodeEl.get(e.start), 'insp-sel');
            mark(nodeEl.get(e.end), 'insp-sel');
        }
        if (sel.mode === 'path' && sel.b) mark(nodeEl.get(sel.b), 'insp-sel2');
        for (const id of matches) mark(nodeEl.get(id), 'insp-match');
    }

    // opts.toggle (a click on the diagram): clicking the node that is already
    // the selection clears it. Panel rows and search hits never toggle — they
    // are navigation, and landing on the current node must not drop it.
    function select(id, opts) {
        opts = opts || {};
        if (!graph || !graph.nodes.has(id)) return;
        if (opts.toggle && !opts.extend && (sel.a === id || sel.b === id) && sel.mode !== 'edge') {
            clearSel();
            return;
        }
        if (opts.extend && sel.a && sel.a !== id && sel.mode !== 'edge') {
            sel = { mode: 'path', a: sel.a, b: id, edge: null };
        } else {
            sel = { mode: 'node', a: id, b: null, edge: null };
        }
        recompute();
        if (opts.center) centerOnEl(nodeEl.get(id));
    }
    function selectEdge(id) {
        if (!graph || !graph.edges.has(id)) return;
        if (sel.mode === 'edge' && sel.edge === id) { clearSel(); return; }
        sel = { mode: 'edge', a: null, b: null, edge: id };
        recompute();
    }
    function trace(dir) {
        if (!sel.a || sel.mode === 'edge') return;
        sel = { mode: sel.mode === dir ? 'node' : dir, a: sel.a, b: null, edge: null };
        recompute();
    }
    function clearSel() {
        sel = { mode: 'none', a: null, b: null, edge: null };
        recompute();
    }

    // ------------------------------------------------------------------ panel
    function el(tag, attrs, ...kids) {
        const e = document.createElement(tag);
        for (const k in attrs || {}) {
            if (k === 'class') e.className = attrs[k];
            else if (k === 'onclick') e.addEventListener('click', attrs[k]);
            else e.setAttribute(k, attrs[k]);
        }
        for (const c of kids) if (c != null) e.append(c);
        return e;
    }
    function fmt(v) {
        const a = Math.abs(v);
        const d = a === 0 || a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
        return (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: d });
    }
    const nlabel = (id) => (graph.nodes.get(id) || { label: id }).label;
    function nodeItem(id, cls, arrow, val) {
        return el('li', { class: cls, onclick: () => select(id, { center: true }) },
            el('span', { class: 'arrow' }, arrow), el('span', null, nlabel(id)), el('span', { class: 'val' }, val || ''));
    }
    function legend() {
        const sw = (v, k) => el('span', null, el('i', { style: 'background: var(' + v + ')' }), t(k));
        return el('div', { class: 'legend' }, sw('--in', 'insp.legendIn'), sw('--out', 'insp.legendOut'), sw('--accent', 'insp.legendPath'));
    }
    function renderPanel() {
        const p = $('panel');
        p.replaceChildren();
        if (!svg) return;
        if (!graph) { p.append(el('p', { class: 'empty' }, t('insp.notFlow'))); return; }
        const g = graph;
        if (sel.mode === 'none') {
            p.append(el('p', { class: 'empty' }, t('insp.nothing')),
                el('div', { class: 'sub' }, t('insp.stats', { nodes: g.nodes.size, edges: g.edges.size })), legend());
            return;
        }
        if (sel.mode === 'edge') {
            const e = g.edges.get(sel.edge);
            p.append(el('div', { class: 'sub' }, t('insp.edge')),
                el('h2', null, nlabel(e.start) + ' → ' + nlabel(e.end)));
            if (e.label) p.append(el('div', null, e.label));
            p.append(el('ul', null, nodeItem(e.start, 'in', '←', ''), nodeItem(e.end, 'out', '→', '')));
            return;
        }
        if (sel.mode === 'path') {
            p.append(el('h2', null, nlabel(sel.a) + ' ⇄ ' + nlabel(sel.b)));
            if (!result.found) p.append(el('p', { class: 'empty' }, t('insp.noPath')));
            else {
                const [from, to] = result.reversed ? [sel.b, sel.a] : [sel.a, sel.b];
                p.append(el('div', null, t('insp.pathFound', { nodes: result.nodes.size, edges: result.edges.size })),
                    el('div', { class: 'sub' }, t('insp.pathReversed', { from: nlabel(from), to: nlabel(to) })));
            }
            p.append(legend());
            return;
        }
        const n = g.nodes.get(sel.a);
        if (sel.mode === 'up' || sel.mode === 'down') {
            const up = sel.mode === 'up';
            p.append(el('h2', null, t(up ? 'insp.upTitleH' : 'insp.downTitleH', { label: n.label })),
                el('div', { class: 'sub' }, t('insp.traceCount', { nodes: result.nodes.size, edges: result.edges.size })));
            // The ends of the closure: where the energy comes from / ends up.
            // Every ancestor's in-edges lie inside an upstream closure (and every
            // descendant's out-edges inside a downstream one), so "no edge further
            // out, self-loops aside" is all it takes. A pure cycle has no end.
            const ends = [...result.nodes].filter((id) => id !== sel.a
                && (up ? g.inc.get(id) : g.out.get(id)).every((e) => e.start === e.end));
            p.append(el('h3', null, t(up ? 'insp.sources' : 'insp.sinks')),
                ends.length ? el('ul', null, ...ends.map((id) => nodeItem(id, up ? 'in' : 'out', up ? '⇤' : '⇥', ''))) : el('div', { class: 'empty' }, t('insp.none')));
            return;
        }
        // mode === 'node'
        p.append(el('div', { class: 'sub' }, n.isGroup ? t('insp.group') + ' · ' + n.id : n.id), el('h2', null, n.label));
        const ins = g.inc.get(n.id), outs = g.out.get(n.id);
        p.append(el('h3', null, t('insp.inEdges', { n: ins.length })),
            ins.length ? el('ul', null, ...ins.map((e) => nodeItem(e.start, 'in', '←', e.label))) : el('div', { class: 'empty' }, t('insp.none')),
            el('h3', null, t('insp.outEdges', { n: outs.length })),
            outs.length ? el('ul', null, ...outs.map((e) => nodeItem(e.end, 'out', '→', e.label))) : el('div', { class: 'empty' }, t('insp.none')));
        const b = G.balance(g, n.id);
        p.append(el('h3', null, t('insp.balance')));
        if (!b.rows.length) {
            p.append(el('div', { class: 'note' }, t('insp.noNumbers')));
        } else {
            const sign = (v) => (Math.abs(v) < 1e-9 ? 'zero' : v > 0 ? 'pos' : 'neg');
            p.append(el('table', null,
                el('tr', null, el('th', null, t('insp.unit')), el('th', null, t('insp.sumIn')), el('th', null, t('insp.sumOut')), el('th', null, t('insp.net'))),
                ...b.rows.map((r) => el('tr', null,
                    el('td', null, r.unit || t('insp.noUnit')),
                    el('td', null, r.nIn ? fmt(r.in) : '–'),
                    el('td', null, r.nOut ? fmt(r.out) : '–'),
                    el('td', { class: sign(r.net) }, (r.net > 0 ? '+' : '') + fmt(r.net))))));
            if (b.rows.length > 1) p.append(el('div', { class: 'note' }, t('insp.mixedUnits')));
            if (b.unlabeled) p.append(el('div', { class: 'note' }, t('insp.unlabeled', { n: b.unlabeled })));
        }
    }
    function updateButtons() {
        const node = !!sel.a && sel.mode !== 'edge';
        $('btn-up').disabled = !node;
        $('btn-down').disabled = !node;
        $('btn-up').classList.toggle('on', sel.mode === 'up');
        $('btn-down').classList.toggle('on', sel.mode === 'down');
        $('btn-clear').disabled = sel.mode === 'none';
        $('search').disabled = !graph;
    }

    // ----------------------------------------------------------------- search
    function runSearch(q, jumpToFirst) {
        matches = graph ? G.search(graph, q) : [];
        matchIdx = matches.length ? 0 : -1;
        const c = $('search-count');
        c.textContent = !String(q || '').trim() ? '' : matches.length ? '1/' + matches.length : t('insp.searchNone');
        if (jumpToFirst && matches.length) select(matches[0], { center: true });
        else decorate();
    }
    function stepSearch(delta) {
        if (!matches.length) return;
        matchIdx = (matchIdx + delta + matches.length) % matches.length;
        $('search-count').textContent = (matchIdx + 1) + '/' + matches.length;
        select(matches[matchIdx], { center: true });
    }

    // ---------------------------------------------------------------- minimap
    const MM_MAX_W = 220, MM_MAX_H = 150;
    let mmScheduled = false, mmRect = null;
    function scheduleMinimap() {
        if (mmScheduled) return;
        mmScheduled = true;
        requestAnimationFrame(() => { mmScheduled = false; buildMinimap(); });
    }
    function buildMinimap() {
        const mm = $('minimap');
        mm.replaceChildren();
        mmRect = null;
        if (!svg || !showMinimap) { mm.classList.remove('show'); return; }
        const k = Math.min(MM_MAX_W / world.w, MM_MAX_H / world.h);
        mm.style.width = Math.max(40, world.w * k) + 'px';
        mm.style.height = Math.max(30, world.h * k) + 'px';
        const vb = `${world.x} ${world.y} ${world.w} ${world.h}`;
        // A deep clone, not <use>: mermaid scopes its CSS as `#svgId …`, which
        // a <use> shadow tree would not match (everything would draw black).
        const clone = svg.cloneNode(true);
        clone.classList.remove('insp-diagram');
        clone.setAttribute('viewBox', vb);
        const cvp = clone.querySelector('g.insp-vp');
        if (cvp) cvp.removeAttribute('transform');
        const overlay = document.createElementNS(SVGNS, 'svg');
        overlay.setAttribute('viewBox', vb);
        mmRect = document.createElementNS(SVGNS, 'rect');
        mmRect.setAttribute('class', 'mm-view');
        overlay.appendChild(mmRect);
        mm.append(clone, overlay);
        mm.classList.add('show');
        updateMinimapRect();
    }
    function updateMinimapRect() {
        if (!mmRect) return;
        const { w, h } = stageSize();
        const x = -view.tx / view.s, y = -view.ty / view.s, rw = w / view.s, rh = h / view.s;
        mmRect.setAttribute('x', x);
        mmRect.setAttribute('y', y);
        mmRect.setAttribute('width', rw);
        mmRect.setAttribute('height', rh);
        // Everything already on screen: a frame around the whole map says nothing.
        const all = x <= world.x && y <= world.y && x + rw >= world.x + world.w && y + rh >= world.y + world.h;
        mmRect.style.display = all ? 'none' : '';
    }
    function minimapTo(e, animate) {
        const r = $('minimap').getBoundingClientRect();
        const wx = world.x + (e.clientX - r.left) / r.width * world.w;
        const wy = world.y + (e.clientY - r.top) / r.height * world.h;
        const { w, h } = stageSize();
        target.tx = w / 2 - wx * target.s;
        target.ty = h / 2 - wy * target.s;
        if (animate) kick(); else jump();
    }

    // ------------------------------------------------------------------ input
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        if (e.target.closest('#minimap')) {
            e.preventDefault();
            minimapTo(e, true);
            const mm = $('minimap');
            mm.setPointerCapture(e.pointerId);
            const move = (ev) => minimapTo(ev, false);
            const up = () => { mm.removeEventListener('pointermove', move); mm.removeEventListener('pointerup', up); };
            mm.addEventListener('pointermove', move);
            mm.addEventListener('pointerup', up);
            return;
        }
        if (e.button === 1) e.preventDefault();   // no autoscroll cursor
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: target.tx, ty: target.ty,
                 moved: false, target: e.target, button: e.button, extend: e.shiftKey || e.ctrlKey || e.metaKey };
        // A drag that starts mid-glide continues from where the view IS.
        target = { ...view };
        drag.tx = view.tx; drag.ty = view.ty;
        jump();
        stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 3) { drag.moved = true; stage.classList.add('panning'); }
        if (drag.moved) { target.tx = drag.tx + dx; target.ty = drag.ty + dy; jump(); }
    });
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        stage.classList.remove('panning');
        if (!d.moved && d.button === 0 && e.type === 'pointerup') handleClick(d.target, d.extend);
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    function hitTest(node) {
        if (!(node instanceof Element)) return null;
        const n = node.closest('g.node');
        if (n && elNode.has(n)) return { node: elNode.get(n) };
        const lab = node.closest('g.edgeLabel');
        if (lab && elEdge.has(lab)) return { edge: elEdge.get(lab) };
        const p = node.closest('path[data-edge], path.insp-hit');
        if (p && elEdge.has(p)) return { edge: elEdge.get(p) };
        // A subgraph is selectable by its title only — its body is where people
        // start a pan, and grabbing the group there would make panning a lottery.
        if (node.closest('.cluster-label')) {
            const c = node.closest('g.cluster');
            if (c && elNode.has(c)) return { node: elNode.get(c) };
        }
        return null;
    }
    function handleClick(targetNode, extend) {
        if (!graph) return;
        const hit = hitTest(targetNode);
        if (!hit) { if (!extend) clearSel(); return; }
        if (hit.node) select(hit.node, { extend, toggle: true });
        else selectEdge(hit.edge);
    }
    // No dblclick handler: a double click is two clicks, and the second one
    // already means "deselect".

    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        let dx = e.deltaX, dy = e.deltaY;
        if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
        else if (e.deltaMode === 2) { dx *= stage.clientWidth; dy *= stage.clientHeight; }
        const r = stage.getBoundingClientRect();
        const pad = isTouchpadWheel(e);
        if (e.ctrlKey || e.metaKey) {
            // A two-finger pinch arrives as Ctrl+wheel. Chromium encodes it so
            // that exp(-deltaY / 100) IS the pinch's scale, hence 0.01; a mouse
            // notch (100) gets the gentler 0.0025 (~22%) and the glide.
            const f = Math.min(2, Math.max(0.5, Math.exp(-dy * (pad ? 0.01 : 0.0025))));
            zoomAt(f, e.clientX - r.left, e.clientY - r.top);
            if (pad) jump();
            return;
        }
        if (e.shiftKey && !dx) { dx = dy; dy = 0; }
        target.tx -= dx;
        target.ty -= dy;
        if (pad) {
            // Two-finger scroll: the OS already streams smooth, inertial deltas,
            // so follow the fingers 1:1 — a glide on top of that only adds lag.
            // `view` moves by the same delta so a zoom glide still in flight
            // keeps going rather than being snapped.
            view.tx -= dx;
            view.ty -= dy;
            applyView();
        } else {
            kick();
        }
    }, { passive: false });

    // Mouse wheel vs. touchpad. Measured in the real app (WebView2, CDP pinch):
    //   mouse notch     deltaY  100     wheelDeltaY −120
    //   touchpad pinch  deltaY ≈ −3.3   wheelDeltaY  120  (ctrlKey)
    // ⚠ So wheelDeltaY alone CANNOT tell them apart — a pinch reports a whole
    // 120 too. The size of deltaY can: a notch is ≥ 50 px, a pinch or a
    // two-finger scroll step is a few px, usually fractional.
    function isTouchpadWheel(e) {
        if (e.deltaMode !== 0) return false;
        if (e.deltaX !== 0 && !e.shiftKey) return true;
        const big = Math.abs(e.deltaY) >= 50;
        const wd = e.wheelDeltaY;
        if (big && typeof wd === 'number' && wd !== 0 && wd % 120 === 0) return false;
        return !big || !Number.isInteger(e.deltaY);
    }

    window.addEventListener('resize', () => applyView());
    // A pinch (Ctrl+wheel) over the toolbar or the panel must not page-zoom the
    // window now that WebView2's pinch is on (src/inspector_registry.rs). The
    // stage's own listener already cancels it there and zooms the diagram.
    document.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });

    function isTyping(e) {
        const tg = e.target;
        return tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable);
    }
    document.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        const help = $('help');
        if (ctrl && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); post('inspector:close'); return; }
        if (ctrl && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); $('search').focus(); $('search').select(); return; }
        if (help.classList.contains('show')) {
            if (e.key === 'Escape' || e.key === '?' || e.key === 'h' || e.key === 'H') { e.preventDefault(); help.classList.remove('show'); }
            return;
        }
        if (isTyping(e)) return;
        if (ctrl) {
            if (e.key === '0') { e.preventDefault(); fit(true); }
            else if (e.key === '+' || e.key === '=' || e.key === ';') { e.preventDefault(); zoomCenter(1.25); }
            else if (e.key === '-') { e.preventDefault(); zoomCenter(0.8); }
            return;
        }
        if (e.altKey) return;
        const panStep = e.shiftKey ? 240 : 80;
        switch (e.key) {
            case 'Escape': clearSel(); break;
            case 'f': case 'F': fit(true); break;
            case 'u': case 'U': trace('up'); break;
            case 'd': case 'D': trace('down'); break;
            case 'm': case 'M': toggleMinimap(); break;
            case 'p': case 'P': togglePanel(); break;
            case '?': case 'h': case 'H': help.classList.add('show'); break;
            case '/': $('search').focus(); break;
            case 'ArrowLeft': target.tx += panStep; kick(); break;
            case 'ArrowRight': target.tx -= panStep; kick(); break;
            case 'ArrowUp': target.ty += panStep; kick(); break;
            case 'ArrowDown': target.ty -= panStep; kick(); break;
            default: return;
        }
        e.preventDefault();
    });
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').classList.remove('show'); });

    const search = $('search');
    search.addEventListener('input', () => runSearch(search.value, true));
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') {
            e.preventDefault();
            search.value = '';
            runSearch('', false);
            search.blur();
        }
    });

    function toggleMinimap() { showMinimap = !showMinimap; $('btn-minimap').classList.toggle('on', showMinimap); buildMinimap(); }
    function togglePanel() {
        showPanel = !showPanel;
        $('btn-panel').classList.toggle('on', showPanel);
        document.body.classList.toggle('panel-hidden', !showPanel);
        applyView();
    }
    $('btn-fit').addEventListener('click', () => fit(true));
    $('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
    $('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
    $('btn-up').addEventListener('click', () => trace('up'));
    $('btn-down').addEventListener('click', () => trace('down'));
    $('btn-clear').addEventListener('click', clearSel);
    $('btn-minimap').addEventListener('click', toggleMinimap);
    $('btn-panel').addEventListener('click', togglePanel);
    $('btn-help').addEventListener('click', () => $('help').classList.add('show'));

    function post(msg) {
        try { if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(msg); } catch (e) { /* ignore */ }
    }

    // Theme and language follow the preview through the localStorage the two
    // windows share (same app://localhost origin) — no Rust involved. `storage`
    // fires only in OTHER documents, so there is no loop; `focus` is the
    // belt-and-braces re-read, as in the editor.
    function resync() {
        const l = resolveLang();
        if (l !== lang) { lang = l; applyI18n(); setHint(null); recompute(); runSearch(search.value, false); }
        if (svg && isDark() !== document.body.classList.contains('dark')) render(true);
    }
    window.addEventListener('storage', (e) => { if (e.key === 'darkMode' || e.key === 'uiLang' || e.key === null) resync(); });
    window.addEventListener('focus', resync);

    // ------------------------------------------------------------ host entry
    window.__inspectorLoad = function (p) {
        if (!p || typeof p.src !== 'string') return;
        const isOpen = p.kind !== 'update';
        const same = payload && payload.src === p.src;
        payload = p;
        if (same && !isOpen) return;
        if (isOpen && svg) {
            // A different chart (or the same one re-opened): start fresh.
            search.value = '';
            matches = [];
        }
        render(!isOpen);
    };

    // Harness / debugging surface. Not used by the app itself.
    window.__inspector = {
        get state() {
            return {
                mode: sel.mode, a: sel.a, b: sel.b, edge: sel.edge,
                nodes: result ? [...result.nodes].sort() : [],
                edges: result ? [...result.edges].sort() : [],
                found: result ? result.found : undefined,
                matches: matches.slice(), isFlow: !!graph,
            };
        },
        get view() { return { ...view }; },
        get target() { return { ...target }; },
        get settled() { return !animId; },
        nodeEl: (id) => nodeEl.get(id) || null,
        edgeEl: (id) => edgeEl.get(id) || null,
        mounts: () => mounts,
    };

    applyI18n();
    setHint(null);
    updateButtons();
    if (window.__inspectorInit) window.__inspectorLoad(window.__inspectorInit);
})();

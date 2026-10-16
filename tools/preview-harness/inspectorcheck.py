#!/usr/bin/env python3
"""Functional check for the Mermaid inspector window (assets/inspector.html).

``inspector-graph.test.cjs`` owns the graph algorithms. This owns everything a
unit test cannot see: that mermaid's db ids really resolve to the SVG elements
it drew (a mermaid bump can rename them with no error anywhere — the symptom is
clicks that select nothing), that a click / Shift+click / U / D paints exactly
the expected sets, that cursor-anchored Ctrl+wheel zoom keeps the point under
the cursor fixed, that search centres its match, that a live update keeps the
selection, and the preview half: the right-click item and the IPC it posts.

There is no Rust host here, so the inspector is opened directly with an injected
``window.__inspectorInit`` (what src/inspector_registry.rs injects), and the
preview's ``openinspector:`` / ``inspector:update:`` messages are read off a
recording ``ipc`` shim.

Usage::

    python tools/preview-harness/inspectorcheck.py [--channel msedge|chrome]
"""

import argparse
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

# Grid splits into an inverter and a direct feed; both reach the load; a loss
# branch and a separate, unconnected island (X) — enough for neighbourhood,
# all-paths (two arms), reverse-order paths, no-path, and the balance table.
SRC = """flowchart LR
  Grid[系統] -->|120 kW| Inv(インバータ)
  Grid -->|30 kW| Load{負荷}
  Inv -->|100 kW| Load
  Inv -->|20 kW| Loss[損失]
  Load -->|125 kW| Out[出力]
  Load --> Heat[排熱]
  X[孤立] --> Y[孤立2]
"""

INIT = """(() => {
  window.__sentIpc = [];
  window.ipc = { postMessage: (m) => { window.__sentIpc.push(String(m)); } };
  window.__inspectorInit = %s;
  try { localStorage.setItem('uiLang', 'ja'); localStorage.setItem('darkMode', 'false'); } catch (e) {}
})();"""

DOC = """# Inspector fixture

```mermaid
flowchart TD
  A --> B
```

Some prose between the two charts.

```mermaid
%s```
"""


def main():
    ap = argparse.ArgumentParser(description="Mermaid inspector check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8792)
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed\n")
        sys.exit(2)

    failures = []

    def check(name, got, want):
        if got != want:
            msg = "FAIL: %s -> got %r, want %r" % (name, got, want)
            failures.append(msg)
            print(msg)
        else:
            print("ok   %s" % name)

    httpd = shoot.start_harness(args.port, repo_root, assets_dir)
    tmpdir = tempfile.mkdtemp(prefix="inspcheck-")
    doc_path = os.path.join(tmpdir, "fixture.md")
    with open(doc_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(DOC % SRC)
    try:
        with sync_playwright() as p:
            channels = [args.channel] if args.channel else ["msedge", "chrome", None]
            browser = None
            for ch in channels:
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception:  # noqa: BLE001
                    pass
            if browser is None:
                sys.stderr.write("ERROR: no Chromium available\n")
                sys.exit(3)

            ctx = browser.new_context(viewport={"width": 1200, "height": 800}, locale="ja-JP")
            page = ctx.new_page()
            page.set_default_timeout(20000)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e) + " @ " + str(e.stack)[:600]))
            page.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))
            payload = {"kind": "open", "src": SRC, "ordinal": 1, "line": 9, "file": doc_path}
            page.add_init_script(INIT % json.dumps(payload))
            page.goto("http://127.0.0.1:%d/inspector.html" % args.port)
            page.wait_for_function("() => window.__inspector && window.__inspector.mounts() > 0")

            ev = page.evaluate
            settle = lambda: page.wait_for_function("() => window.__inspector.settled")  # noqa: E731
            state = lambda: ev("() => window.__inspector.state")  # noqa: E731

            check("flowchart detected", state()["isFlow"], True)
            # Every db node and edge resolved to a drawn element — the mermaid-bump net.
            ev_ids = ev("""() => {
                const I = window.__inspector;
                const nodes = ['Grid','Inv','Load','Loss','Out','Heat','X','Y'];
                return { nodes: nodes.filter(n => !I.nodeEl(n)),
                         edges: [...document.querySelectorAll('#stage > svg.insp-diagram path[data-edge][data-id]')]
                                .map(p => p.getAttribute('data-id')).filter(id => !I.edgeEl(id) || !I.edgeEl(id).path) };
            }""")
            check("all nodes mapped to SVG", ev_ids["nodes"], [])
            check("all edges mapped to SVG", ev_ids["edges"], [])
            check("no page errors after render", errors, [])

            def click_node(nid, modifiers=None):
                box = ev("""(id) => { const r = window.__inspector.nodeEl(id).getBoundingClientRect();
                         return [r.left + r.width / 2, r.top + r.height / 2]; }""", nid)
                if modifiers:
                    page.keyboard.down(modifiers)
                page.mouse.click(box[0], box[1])
                if modifiers:
                    page.keyboard.up(modifiers)

            settle()
            click_node("Inv")
            s = state()
            check("click: node mode", (s["mode"], s["a"]), ("node", "Inv"))
            check("click: neighbourhood nodes", s["nodes"], ["Grid", "Inv", "Load", "Loss"])
            classes = ev("""() => {
                const I = window.__inspector, g = (id) => I.edgeEl(id).path.getAttribute('class');
                const ids = [...document.querySelectorAll('#stage > svg.insp-diagram path[data-edge][data-id]')].map(p => p.getAttribute('data-id'));
                const by = (c) => ids.filter(id => g(id).includes(c)).length;
                return { on: by('insp-on'), in: by('insp-in'), out: by('insp-out'),
                         dimmed: getComputedStyle(I.nodeEl('X')).opacity,
                         lit: getComputedStyle(I.nodeEl('Grid')).opacity };
            }""")
            check("click: 3 incident edges lit (1 in, 2 out)", (classes["on"], classes["in"], classes["out"]), (3, 1, 2))
            page.wait_for_timeout(250)  # opacity transition
            dim = ev("() => +getComputedStyle(window.__inspector.nodeEl('X')).opacity")
            # Only slightly faded (the rest stays readable as context).
            check("click: unrelated node dimmed only slightly", 0.6 < dim < 0.9, True)
            panel = ev("() => document.getElementById('panel').innerText")
            check("panel: balance row (120 in, 120 out, net 0)", "kW\t120\t120\t0" in panel, True)

            # Edge labels render a step smaller than node text (MERMAID_THEME_CSS),
            # and the label box is measured at that size (text fits, not clipped).
            fs = ev("""() => {
                const I = window.__inspector;
                const t = (el) => { const s = el.querySelector('span, p, div') || el; return s; };
                const lab = t(I.edgeEl('L_Grid_Inv_0').label.querySelector('.label'));
                const node = t(I.nodeEl('Grid').querySelector('.label'));
                const fo = I.edgeEl('L_Grid_Inv_0').label.querySelector('foreignObject');
                const div = fo.firstElementChild;
                return { edge: getComputedStyle(lab).fontSize, node: getComputedStyle(node).fontSize,
                         fits: div.scrollWidth <= +fo.getAttribute('width') + 1 && div.scrollHeight <= +fo.getAttribute('height') + 1 };
            }""")
            check("edge label font is 13px, node text 16px", (fs["edge"], fs["node"]), ("13px", "16px"))
            check("edge label box fits its text", fs["fits"], True)

            # Fade setting: default 28 % transparency = opacity .72; the slider and
            # the number field drive one value, which persists in localStorage.
            check("fade: default 28%", (state()["dim"], ev("() => document.getElementById('dim-num').value")), (28, "28"))
            check("fade: default opacity .72", round(dim, 2), 0.72)
            ev("""() => { const r = document.getElementById('dim-range'); r.value = '60';
                         r.dispatchEvent(new Event('input', {bubbles: true})); }""")
            page.wait_for_timeout(250)
            check("fade: slider sets 60% (number field follows, stored)",
                  (state()["dim"], ev("() => document.getElementById('dim-num').value"), ev("() => localStorage.getItem('inspectorDim')")),
                  (60, "60", "60"))
            check("fade: unrelated node at opacity .4",
                  round(ev("() => +getComputedStyle(window.__inspector.nodeEl('X')).opacity"), 2), 0.4)
            page.fill("#dim-num", "200")
            page.keyboard.press("Enter")
            check("fade: number field clamps to 95", (state()["dim"], ev("() => document.getElementById('dim-range').value")), (95, "95"))
            ev("() => { localStorage.setItem('inspectorDim', '10'); window.dispatchEvent(new StorageEvent('storage', {key: 'inspectorDim'})); }")
            check("fade: follows storage", state()["dim"], 10)
            page.focus("#dim-range")
            page.keyboard.press("ArrowRight")
            check("fade: arrow keys move the focused slider", (state()["dim"], state()["mode"]), (11, "node"))
            page.keyboard.press("u")
            check("fade: U still works with the slider focused", state()["mode"], "up")
            page.keyboard.press("u")
            ev("() => { localStorage.setItem('inspectorDim', '28'); window.dispatchEvent(new StorageEvent('storage', {key: 'inspectorDim'})); document.activeElement.blur(); }")

            click_node("Out", "Shift")
            s = state()
            check("shift+click: path mode", (s["mode"], s["a"], s["b"], s["found"]), ("path", "Inv", "Out", True))
            check("shift+click: path nodes", s["nodes"], ["Inv", "Load", "Out"])

            click_node("Grid")
            click_node("Out", "Shift")
            s = state()
            check("all paths Grid→Out: both arms", s["nodes"], ["Grid", "Inv", "Load", "Out"])
            check("all paths Grid→Out: 4 edges", len(s["edges"]), 4)

            # Out is one end of the current path, so the first click CLEARS;
            # the second then starts a fresh selection from it.
            click_node("Out")
            check("clicking an end of the path clears it", state()["mode"], "none")
            click_node("Out")
            click_node("Grid", "Control")
            s = state()
            check("ctrl+click against the flow still finds it", (s["found"], s["nodes"]), (True, ["Grid", "Inv", "Load", "Out"]))

            click_node("Loss")
            click_node("Heat", "Shift")
            check("siblings: no path", state()["found"], False)

            # Connections are clickable: 5 screen px off a ~2px line still hits it
            # (the wide transparent twin), and so does its label. The probe sits
            # 15% along the path: with the denser MERMAID_LAYOUT the edges are short
            # enough that the old 35% point landed on the edge's own label.
            page.keyboard.press("Escape")
            pt = ev("""() => { const p = window.__inspector.edgeEl('L_Inv_Loss_0').path,
                        L = p.getTotalLength(), q = p.getPointAtLength(L * 0.15),
                        m = p.getScreenCTM(); return [q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f]; }""")
            hit_at = ev("([x, y]) => { const e = document.elementFromPoint(x, y + 5); return e && e.getAttribute('class'); }", pt)
            check("5px beside an edge is still its hit area", hit_at, "insp-hit")
            page.mouse.click(pt[0], pt[1] + 5)
            s = state()
            check("edge click: edge mode with both ends lit", (s["mode"], s["edge"], s["nodes"]), ("edge", "L_Inv_Loss_0", ["Inv", "Loss"]))
            check("edge click: the edge itself is coloured",
                  "insp-path" in ev("() => window.__inspector.edgeEl('L_Inv_Loss_0').path.getAttribute('class')"), True)
            page.mouse.click(pt[0], pt[1] + 5)
            check("second click on the same edge clears", state()["mode"], "none")
            lab = ev("() => { const r = window.__inspector.edgeEl('L_Grid_Load_0').label.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
            page.mouse.click(lab[0], lab[1])
            check("edge label click selects that edge", state()["edge"], "L_Grid_Load_0")
            check("hit twins never count as edges",
                  ev("() => document.querySelectorAll('#stage > svg.insp-diagram path.insp-hit[data-edge], #stage > svg.insp-diagram path.insp-hit[id]').length"), 0)

            # A second click on the selected node clears the highlight.
            page.keyboard.press("Escape")
            click_node("Inv")
            check("second click: selected first", state()["a"], "Inv")
            click_node("Inv")
            s = state()
            check("second click on the same node clears", (s["mode"], s["a"]), ("none", None))
            check("...and the dimming is gone",
                  ev("() => document.querySelector('#stage > svg.insp-diagram').classList.contains('has-hl')"), False)
            click_node("Inv")
            page.keyboard.press("u")
            click_node("Inv")
            check("second click clears from a trace too", state()["mode"], "none")
            # A panel row pointing at the current node navigates, never toggles.
            click_node("Grid")
            ev("() => [...document.querySelectorAll('#panel li')].find(li => li.textContent.includes('インバータ')).click()")
            check("panel row selects its node", state()["a"], "Inv")

            click_node("Load")
            page.keyboard.press("u")
            s = state()
            check("U: upstream trace", (s["mode"], s["nodes"]), ("up", ["Grid", "Inv", "Load"]))
            page.keyboard.press("u")
            check("U again: back to node", state()["mode"], "node")
            page.keyboard.press("d")
            check("D: downstream trace", state()["nodes"], ["Heat", "Load", "Out"])
            page.keyboard.press("Escape")
            check("Esc clears", state()["mode"], "none")

            # Click on empty background clears too; a drag pans instead of clearing.
            click_node("Grid")
            settle()
            v0 = ev("() => window.__inspector.view")
            page.mouse.move(600, 760)
            page.mouse.down()
            page.mouse.move(650, 700, steps=5)
            page.mouse.up()
            v1 = ev("() => window.__inspector.view")
            check("drag pans by the pointer delta", (round(v1["tx"] - v0["tx"]), round(v1["ty"] - v0["ty"])), (50, -60))
            check("drag keeps the selection", state()["mode"], "node")
            page.mouse.click(600, 760)
            check("background click clears", state()["mode"], "none")

            # Cursor-anchored zoom: the world point under the cursor must not move.
            settle()
            cx, cy = 420.0, 380.0
            stage = ev("() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; }")
            before = ev("() => window.__inspector.view")
            wx = (cx - stage[0] - before["tx"]) / before["s"]
            wy = (cy - stage[1] - before["ty"]) / before["s"]
            page.mouse.move(cx, cy)
            page.keyboard.down("Control")
            page.mouse.wheel(0, -300)
            page.keyboard.up("Control")
            settle()
            after = ev("() => window.__inspector.view")
            check("ctrl+wheel zooms in", after["s"] > before["s"] * 1.5, True)
            sx = stage[0] + after["tx"] + wx * after["s"]
            sy = stage[1] + after["ty"] + wy * after["s"]
            check("ctrl+wheel keeps the cursor point fixed", (round(sx), round(sy)), (round(cx), round(cy)))
            # A real mouse notch (wheelDeltaY ±120) keeps the gentle mouse factor —
            # misread as a pinch it would be exp(1) ≈ 2.7×, clamped to 2.
            m0 = ev("() => window.__inspector.target.s")
            page.keyboard.down("Control")
            page.mouse.wheel(0, -100)
            page.keyboard.up("Control")
            settle()
            check("mouse ctrl+wheel notch zooms ~1.28x, not as a pinch",
                  round(ev("() => window.__inspector.view.s") / m0, 3), round(__import__("math").exp(0.25), 3))
            # Touchpad: a two-finger scroll streams small pixel deltas (with a
            # deltaX); it must follow the fingers 1:1 with no glide.
            settle()
            tp0 = ev("() => window.__inspector.view")
            ev("""() => document.getElementById('stage').dispatchEvent(new WheelEvent('wheel',
                   {deltaX: 12.5, deltaY: -7.25, deltaMode: 0, clientX: 400, clientY: 300, bubbles: true, cancelable: true}))""")
            tp1 = ev("() => window.__inspector.view")
            check("two-finger scroll pans 1:1 immediately",
                  (round(tp1["tx"] - tp0["tx"], 2), round(tp1["ty"] - tp0["ty"], 2)), (-12.5, 7.25))
            # Pinch = Ctrl+wheel with small fractional deltas; exp(-deltaY/100) is
            # the pinch's scale, applied at once around the fingers.
            ev("""() => document.getElementById('stage').dispatchEvent(new WheelEvent('wheel',
                   {deltaY: -10.5, deltaMode: 0, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true}))""")
            tp2 = ev("() => window.__inspector.view")
            check("pinch zooms by exp(-deltaY/100) immediately",
                  round(tp2["s"] / tp1["s"], 4), round(__import__("math").exp(0.105), 4))
            # The exact shape WebView2 delivers (measured over CDP in the real app):
            # a small fractional deltaY that still carries wheelDeltaY = 120. Read
            # as a mouse notch, the pinch felt dead (×1.1 for a ×1.5 gesture).
            ev("""() => { const e = new WheelEvent('wheel', {deltaY: -3.3, deltaMode: 0, ctrlKey: true,
                       clientX: 400, clientY: 300, bubbles: true, cancelable: true});
                   Object.defineProperty(e, 'wheelDeltaY', {value: 120});
                   document.getElementById('stage').dispatchEvent(e); }""")
            tp3 = ev("() => window.__inspector.view")
            check("a real WebView2 pinch event (wheelDeltaY 120) still zooms as a pinch",
                  round(tp3["s"] / tp2["s"], 4), round(__import__("math").exp(0.033), 4))
            page.keyboard.press("f")
            settle()
            fitted = ev("""() => { const r = document.querySelector('g.insp-vp').getBoundingClientRect(),
                                    s = document.getElementById('stage').getBoundingClientRect();
                return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; }""")
            check("F fits the whole diagram in the stage", fitted, True)

            # Search: typing selects + centres the first hit; Enter steps.
            page.keyboard.press("Control+f")
            page.keyboard.type("孤立")
            settle()
            s = state()
            check("search: two matches", s["matches"], ["X", "Y"])
            check("search: first hit selected", s["a"], "X")
            centred = ev("""() => { const r = window.__inspector.nodeEl('X').getBoundingClientRect(),
                                     s = document.getElementById('stage').getBoundingClientRect();
                return [Math.round(r.left + r.width / 2 - (s.left + s.width / 2)),
                        Math.round(r.top + r.height / 2 - (s.top + s.height / 2))]; }""")
            check("search: hit centred in the stage", [abs(c) <= 2 for c in centred], [True, True])
            page.keyboard.press("Enter")
            check("search: Enter steps to the next hit", state()["a"], "Y")
            page.keyboard.press("Escape")
            check("search: Esc empties the box", ev("() => document.getElementById('search').value"), "")

            # Live update keeps the selection and the viewport.
            page.keyboard.press("f")
            settle()
            click_node("Inv")
            check("re-select before update", state()["a"], "Inv")
            settle()
            v_before = ev("() => window.__inspector.view")
            mounts = ev("() => window.__inspector.mounts()")
            upd = dict(payload, kind="update", src=SRC + "  Inv -->|5 kW| Aux[補機]\n")
            ev("(p) => window.__inspectorLoad(p)", upd)
            page.wait_for_function("(m) => window.__inspector.mounts() > m", arg=mounts)
            s = state()
            check("update: selection kept", (s["mode"], s["a"]), ("node", "Inv"))
            check("update: new neighbour lit", "Aux" in s["nodes"], True)
            check("update: viewport kept", ev("() => window.__inspector.view") == v_before, True)
            # A broken intermediate source keeps the last good diagram.
            ev("(p) => window.__inspectorLoad(p)", dict(payload, kind="update", src="flowchart LR\n  A -->"))
            page.wait_for_timeout(600)
            check("update: syntax error keeps the diagram", ev("() => !!document.querySelector('svg.insp-diagram')"), True)
            check("update: syntax error reported in the hint", "エラー" in ev("() => document.getElementById('hint').textContent"), True)

            # Non-flowchart: renders, graph features off.
            ev("(p) => window.__inspectorLoad(p)", dict(payload, kind="open", src="sequenceDiagram\n  A->>B: hi\n"))
            page.wait_for_function("() => window.__inspector.state.isFlow === false && document.querySelector('svg.insp-diagram')")
            check("sequence diagram: graph features off", ev("() => document.getElementById('search').disabled"), True)

            # Theme follows the preview through shared localStorage.
            ev("(p) => window.__inspectorLoad(p)", dict(payload, kind="open"))
            page.wait_for_function("() => window.__inspector.state.isFlow")
            m = ev("() => window.__inspector.mounts()")
            ev("() => { localStorage.setItem('darkMode', 'true'); window.dispatchEvent(new StorageEvent('storage', {key: 'darkMode'})); }")
            page.wait_for_function("(m) => window.__inspector.mounts() > m", arg=m)
            check("dark mode follows the preview", ev("() => document.body.classList.contains('dark')"), True)

            check("Ctrl+W asks the host to close", (page.keyboard.press("Control+w"),
                  ev("() => window.__sentIpc.slice(-1)[0]"))[1], "inspector:close")
            check("no page errors", errors, [])

            # ---- the preview half: right-click item + the IPC it posts
            pv = ctx.new_page()
            pv.add_init_script(shoot.ui_lang_init_script("ja"))
            pv.goto("http://127.0.0.1:%d/index.html?file=%s" % (args.port, doc_path), wait_until="domcontentloaded")
            pv.wait_for_function("() => document.querySelectorAll('#preview .mermaid svg').length === 2")
            pv.evaluate("() => { window.__sentIpc = []; window.ipc = { postMessage: (m) => window.__sentIpc.push(String(m)) }; }")
            src_attr = pv.evaluate("() => decodeURIComponent(document.querySelectorAll('#preview .mermaid')[1].getAttribute('data-mermaid-source'))")
            check("preview keeps the mermaid source", src_attr, SRC)
            label = pv.evaluate("() => window.__I18N['menu.openInspector'].ja")
            box = pv.evaluate("() => { const r = document.querySelectorAll('#preview .mermaid svg')[1].getBoundingClientRect(); return [r.left + 20, r.top + 20]; }")
            pv.mouse.click(box[0], box[1], button="right")
            items = pv.evaluate("() => [...document.querySelectorAll('.app-context-menu .app-menu-item')].map(e => e.textContent)")
            check("figure menu offers the inspector first", items[:1], [label])
            pv.click(".app-context-menu .app-menu-item >> nth=0")
            sent = pv.evaluate("() => window.__sentIpc")
            opened = [json.loads(m[len("openinspector:"):]) for m in sent if m.startswith("openinspector:")]
            check("openinspector: posted once", len(opened), 1)
            if opened:
                o = opened[0]
                check("openinspector: payload", (o["kind"], o["ordinal"], o["src"]), ("open", 1, SRC))

            # Live follow: editing the followed block posts an update; editing the
            # OTHER block does not; closing (host → __inspectorTarget(null)) stops it.
            def rerender(text):
                pv.evaluate("(c) => window.loadFileFromRust({filename: 'fixture.md', filepath: %s, content: c, raw: c})"
                            % json.dumps(doc_path), text)
                pv.wait_for_timeout(700)

            def updates():
                return [json.loads(m[len("inspector:update:"):]) for m in pv.evaluate("() => window.__sentIpc")
                        if m.startswith("inspector:update:")]
            rerender((DOC % SRC).replace("A --> B", "A --> B --> C"))
            check("editing another block posts nothing", len(updates()), 0)
            new_src = SRC + "  Out --> Z\n"
            rerender("Inserted line.\n\n" + (DOC % new_src))
            u = updates()
            check("editing the followed block posts one update", len(u), 1)
            if u:
                check("update payload follows the block", (u[0]["kind"], u[0]["ordinal"], u[0]["src"]), ("update", 1, new_src))
            pv.evaluate("() => window.__inspectorTarget(null)")
            rerender(DOC % (new_src + "  Z --> W\n"))
            check("after close no more updates", len(updates()), 1)
            pv.close()

            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("\n%d FAILED" % len(failures))
        sys.exit(1)
    print("\nall passed")


if __name__ == "__main__":
    main()

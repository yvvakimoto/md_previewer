"""End-to-end check of the preview's markwhen item editing in the harness.

Drives real pointer drags, the item dialog and the right-click menu against
samples/markwhen.md and asserts the exact `savefile:` payload -- the only thing that
proves a pixel delta became the right number of DAYS, on the right event, in the
right fence, with nothing else in the document touched. The pure source rewrites have
their own unit test (markwhen-edit.test.cjs); this one owns everything between the
pointer and the payload: the SVG stamps (`data-mw-*`), the screen->time conversion,
the calendar's cell hit test, the locate/cross-check, the pending guard, the refusals
(nested / Marp), EOL preservation, the export strip, and that an item click never
fires the editor's `jumpto:`.

No Rust host here, so a commit never comes back as a re-render: the block stays
`.mw-pending`, which is exactly the in-flight window that guard exists for. Each case
therefore starts from a fresh page. Content assertions are LF-normalized (git
`core.autocrlf` decides the fixture's EOLs); preservation has its own CRLF case.
"""
import json, os, sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
sys.path.insert(0, SCRIPT_DIR)
import shoot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DOC = os.path.join(REPO, "samples", "markwhen.md")
with open(DOC, encoding="utf-8") as _fh:
    SRC = _fh.read()
PORT = 8797
URL = "http://127.0.0.1:%d/index.html?file=%s" % (PORT, DOC.replace("\\", "/"))

TAP = """() => {
  window.__sentIpc = [];
  const prev = window.__ipcOrig || (window.ipc && window.ipc.postMessage);
  window.__ipcOrig = prev;
  window.ipc = window.ipc || {};
  window.ipc.postMessage = (m) => { window.__sentIpc.push(m); if (prev) try { prev(m); } catch (e) {} };
}"""

failures = []
def check(name, got, want):
    if got != want:
        failures.append(name)
        print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
    else:
        print("ok   %s" % name)

def settle(pg):
    pg.wait_for_selector("#preview .markwhen-timeline svg.mw-svg", timeout=20000)
    pg.wait_for_timeout(700)
    pg.evaluate(TAP)

def fresh(pg):
    pg.goto(URL)
    settle(pg)

def load_doc(pg, raw, path="C:/tmp/mw.md"):
    pg.evaluate("""(a) => window.loadFileFromRust({ filename: 'mw.md', filepath: a.path,
        content: a.raw.replace(/\\r\\n/g, '\\n'), raw: a.raw })""", {"raw": raw, "path": path})
    pg.wait_for_timeout(800)
    pg.evaluate(TAP)

def sent(pg, prefix="savefile:"):
    return pg.evaluate("(p) => window.__sentIpc.filter(m => m.indexOf(p) === 0)", prefix)

def raw_content_of(msg):
    return json.loads(msg[len("savefile:"):])["content"]

def content_of(msg):
    return raw_content_of(msg).replace("\r\n", "\n")

def toast(pg):
    return pg.evaluate("() => document.getElementById('toast').textContent")

def diff_lines(before, after):
    """(removed, added) lines, order-preserving, for a small edit."""
    a, b = before.split("\n"), after.split("\n")
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    j = 0
    while j < min(len(a), len(b)) - i and a[len(a) - 1 - j] == b[len(b) - 1 - j]:
        j += 1
    return (a[i:len(a) - j], b[i:len(b) - j])

def only_save(pg, name):
    s = sent(pg)
    if len(s) != 1:
        check("%s: exactly one savefile:" % name, [len(s), toast(pg)], [1, ""])
        return None
    return content_of(s[0])

# Geometry of event `idx` in block `blk` (viewport px) + px per day on a timeline.
GEOM = """(a) => {
  const el = document.querySelectorAll('#preview .markwhen-timeline')[a.blk];
  const svg = el.querySelector('svg.mw-svg');
  const shp = svg.querySelector('rect[data-mw-ev="' + a.idx + '"], circle[data-mw-ev="' + a.idx + '"]');
  const lab = svg.querySelector('text[data-mw-ev="' + a.idx + '"]');
  shp.scrollIntoView({ block: 'center' });
  const r = shp.getBoundingClientRect(), lr = lab ? lab.getBoundingClientRect() : null;
  let pxPerDay = null;
  if (svg.getAttribute('data-mw-view') === 'timeline') {
    const t0 = +svg.getAttribute('data-mw-t0'), t1 = +svg.getAttribute('data-mw-t1'), pw = +svg.getAttribute('data-mw-pw');
    pxPerDay = svg.getScreenCTM().a * pw / (t1 - t0) * 86400000;
  }
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2,
           lx: lr && (lr.left + 4), ly: lr && (lr.top + lr.bottom) / 2, pxPerDay };
}"""
CELL = """(a) => {
  const el = document.querySelectorAll('#preview .markwhen-timeline')[a.blk];
  const c = el.querySelector('rect[data-mw-date="' + a.date + '"]');
  c.scrollIntoView({ block: 'center' });
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.bottom - 6 };
}"""

def drag(pg, x0, y0, x1, y1, steps=8):
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    pg.mouse.move(x1, y1, steps=steps)
    pg.mouse.up()
    pg.wait_for_timeout(150)

def dialog_state(pg):
    return pg.evaluate("""() => {
      const m = document.getElementById('mw-edit-modal');
      const v = (id) => document.getElementById(id).value;
      return { open: m.classList.contains('visible'), title: document.getElementById('mw-edit-title').textContent,
               label: v('mw-f-label'), from: v('mw-f-from'), to: v('mw-f-to'),
               single: document.getElementById('mw-f-single').checked, tags: v('mw-f-tag'),
               color: v('mw-f-color') };
    }""")

SET_FIELD = """(a) => {
  const f = document.getElementById(a.id);
  if (f.type === 'checkbox') f.checked = a.value; else f.value = a.value;
  f.dispatchEvent(new Event(a.ev || 'input', { bubbles: true }));
  f.dispatchEvent(new Event('change', { bubbles: true }));
}"""

def set_field(pg, fid, value, ev="input"):
    pg.evaluate(SET_FIELD, {"id": fid, "value": value, "ev": ev})

L_REQ = "2023-01-01 / 2023-02-15: 要件定義 #design"
L_API = "2023-03-01 / 2023-06-30: API 実装 #dev"

httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 900}, locale="en-US")
        pg.add_init_script(shoot.ui_lang_init_script("en"))
        I18N = None
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ================= inventory =================
        fresh(pg)
        I18N = pg.evaluate("() => { const o = {}; for (const k in window.__I18N) if (k.startsWith('mw.edit.')) o[k] = window.__I18N[k].en; return o; }")
        inv = pg.evaluate("""() => {
          const els = [...document.querySelectorAll('#preview .markwhen-timeline')];
          return { n: els.length, editable: els.filter(e => e.classList.contains('mw-editable')).length,
                   buttons: els.filter(e => e.querySelector(':scope > .mw-btn-bar > .mw-add-button')).length,
                   viewBtn: els.map(e => e.querySelector(':scope > .mw-btn-bar > .mw-view-button').textContent),
                   views: els.map(e => e.querySelector('svg').getAttribute('data-mw-view')),
                   evStamps: els.map(e => new Set([...e.querySelectorAll('[data-mw-ev]')].map(n => n.getAttribute('data-mw-ev'))).size) };
        }""")
        check("every top-level block is editable", [inv["editable"], inv["buttons"]], [inv["n"], inv["n"]])
        check("views stamped", inv["views"], ["timeline", "timeline", "calendar", "timeline"])
        check("view toggle names the other view", inv["viewBtn"],
              [I18N["mw.edit.toCalendar"], I18N["mw.edit.toCalendar"], I18N["mw.edit.toTimeline"], I18N["mw.edit.toCalendar"]])
        check("every event stamped (6 / 6 / 4 / 3)", inv["evStamps"], [6, 6, 4, 3])
        # The parser escapes a header value's leading `#` to `)`; without the fix this
        # colour fell back to the palette.
        fill = pg.evaluate("""() => document.querySelectorAll('#preview .markwhen-timeline')[3]
            .querySelector('rect[data-mw-ev="0"]').getAttribute('fill')""")
        check("hex tag colour from the header is honoured", fill, "#8250df")

        # ================= timeline: move a bar by whole days =================
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 0})
        drag(pg, g["cx"], g["cy"], g["cx"] + 10.3 * g["pxPerDay"], g["cy"])
        c = only_save(pg, "timeline move")
        if c:
            check("timeline move: one line, dates shifted 10 days", diff_lines(SRC, c),
                  ([L_REQ], ["2023-01-11 / 2023-02-25: 要件定義 #design"]))
        check("timeline move: no jumpto:", len(sent(pg, "jumpto:")), 0)
        check("timeline move: block pending", pg.evaluate(
            "() => document.querySelectorAll('#preview .markwhen-timeline')[0].classList.contains('mw-pending')"), True)
        # Pending: a second edit before the round trip lands is refused, never spliced
        # against the stale text.
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 2})
        drag(pg, g["cx"], g["cy"], g["cx"] + 5 * g["pxPerDay"], g["cy"])
        check("second edit while pending: refused", [len(sent(pg)), toast(pg)], [1, I18N["mw.edit.errPending"]])

        # ================= timeline: resize either end =================
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 2})
        drag(pg, g["r"] - 2, g["cy"], g["r"] - 2 + 5.2 * g["pxPerDay"], g["cy"])
        c = only_save(pg, "resize end")
        if c:
            check("resize end: +5 days", diff_lines(SRC, c), ([L_API], ["2023-03-01 / 2023-07-05: API 実装 #dev"]))
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 2})
        drag(pg, g["l"] + 2, g["cy"], g["l"] + 2 - 3.1 * g["pxPerDay"], g["cy"])
        c = only_save(pg, "resize start")
        if c:
            check("resize start: -3 days", diff_lines(SRC, c), ([L_API], ["2023-02-26 / 2023-06-30: API 実装 #dev"]))
        # A tiny wobble is a click, not a drag: the dialog opens and nothing is written.
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 2})
        drag(pg, g["cx"], g["cy"], g["cx"] + 1, g["cy"], steps=1)
        st = dialog_state(pg)
        check("click on a bar opens the dialog", [st["open"], st["title"], st["label"], st["from"], st["to"], st["single"], st["tags"]],
              [True, I18N["mw.edit.titleEdit"], "API 実装", "2023-03-01", "2023-06-30", False, "dev"])
        check("click writes nothing", len(sent(pg)), 0)
        # `#dev: green` in the header: the picker must start on that colour, as hex.
        check("named header colour shown in the picker", st["color"], "#008000")

        # ================= dialog: label + tags + colour in one write =================
        set_field(pg, "mw-f-label", "API 実装（第2期）")
        set_field(pg, "mw-f-tag", "dev core")
        set_field(pg, "mw-f-to", "2023-07-31", "change")
        set_field(pg, "mw-f-color", "#ff0000")
        pg.click("#mw-f-save")
        pg.wait_for_timeout(150)
        c = only_save(pg, "dialog save")
        if c:
            # Two lines, in one write: the event, and the tag's existing header entry.
            check("dialog save: event line + tag colour replaced in the header", c,
                  SRC.replace("#dev: green", "#dev: #ff0000", 1)
                     .replace(L_API, "2023-03-01 / 2023-07-31: API 実装（第2期） #dev #core", 1))
        check("dialog closes on save", dialog_state(pg)["open"], False)

        # Esc closes without writing; an empty label is refused.
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 1})
        pg.mouse.click(g["lx"], g["ly"])
        pg.wait_for_timeout(100)
        check("label click opens the dialog on a single day", [dialog_state(pg)["label"], dialog_state(pg)["single"]], ["キックオフ", True])
        set_field(pg, "mw-f-label", "  ")
        pg.click("#mw-f-save")
        check("empty label refused", [len(sent(pg)), toast(pg), dialog_state(pg)["open"]], [0, I18N["mw.edit.errLabel"], True])
        pg.keyboard.press("Escape")
        check("Esc closes the dialog", [dialog_state(pg)["open"], len(sent(pg))], [False, 0])

        # ================= calendar: drag a bar to another day =================
        fresh(pg)
        a = pg.evaluate(CELL, {"blk": 2, "date": "2024-05-15"})
        bar = pg.evaluate("""() => { const r = document.querySelectorAll('#preview .markwhen-timeline')[2]
            .querySelector('rect[data-mw-ev="2"]').getBoundingClientRect(); return { x: r.left + 6, y: (r.top + r.bottom) / 2 }; }""")
        tgt = pg.evaluate(CELL, {"blk": 2, "date": "2024-05-17"})
        drag(pg, bar["x"], bar["y"], tgt["x"] + (bar["x"] - a["x"]), tgt["y"] - (a["y"] - bar["y"]))
        c = only_save(pg, "calendar move")
        if c:
            check("calendar move: +2 days", diff_lines(SRC, c),
                  (["2024-05-15: 定例レビュー #event"], ["2024-05-17: 定例レビュー #event"]))

        # ================= calendar: drag across days -> add =================
        fresh(pg)
        a = pg.evaluate(CELL, {"blk": 2, "date": "2024-05-20"})
        z = pg.evaluate(CELL, {"blk": 2, "date": "2024-05-22"})
        drag(pg, a["x"], a["y"], z["x"], z["y"])
        st = dialog_state(pg)
        check("day-range drag opens the add dialog", [st["open"], st["title"], st["from"], st["to"], st["single"]],
              [True, I18N["mw.edit.titleAdd"], "2024-05-20", "2024-05-22", False])
        set_field(pg, "mw-f-label", "検証")
        set_field(pg, "mw-f-tag", "#dev")
        pg.focus("#mw-f-label")
        pg.keyboard.press("Enter")   # Enter in a field saves
        pg.wait_for_timeout(150)
        c = only_save(pg, "calendar add")
        if c:
            check("calendar add: one line after the section's last item", diff_lines(SRC, c),
                  ([], ["2024-05-20 / 2024-05-22: 検証 #dev"]))
            i = c.split("\n").index("2024-05-20 / 2024-05-22: 検証 #dev")
            check("…right after リリース判定", c.split("\n")[i - 1], "2024-05-29: リリース判定 #event")

        # ================= context menu: delete =================
        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 1, "idx": 3})
        pg.mouse.click(g["cx"], g["cy"], button="right")
        pg.wait_for_timeout(150)
        items = pg.evaluate("() => [...document.querySelectorAll('.app-context-menu')].filter(m => m.style.display !== 'none').flatMap(m => [...m.querySelectorAll('.app-menu-item')].map(i => i.textContent))")
        check("menu leads with the item operations", items[:3], ["Edit item…", "Delete item", "Add item…"])
        pg.evaluate("() => [...document.querySelectorAll('.app-menu-item')].find(i => i.textContent === 'Delete item').click()")
        c = only_save(pg, "menu delete")
        if c:
            check("menu delete: the one line", diff_lines(SRC, c), (["2011-03-11: 震災"], []))

        # ================= + item button =================
        fresh(pg)
        pg.evaluate("() => document.querySelectorAll('#preview .markwhen-timeline')[3].querySelector('.mw-add-button').click()")
        st = dialog_state(pg)
        check("+ button opens an empty add dialog", [st["open"], st["label"], st["tags"]], [True, "", ""])
        set_field(pg, "mw-f-label", "振り返り")
        set_field(pg, "mw-f-from", "2024-06-28", "change")
        set_field(pg, "mw-f-single", True, "change")
        pg.click("#mw-f-save")
        pg.wait_for_timeout(150)
        c = only_save(pg, "+ button add")
        if c:
            check("+ button add: appended to the block", diff_lines(SRC, c), ([], ["2024-06-28: 振り返り"]))
            lines = c.split("\n")
            check("…inside its fence", lines[lines.index("2024-06-28: 振り返り") + 1], "```")

        # ================= view toggle =================
        fresh(pg)
        pg.evaluate("() => document.querySelectorAll('#preview .markwhen-timeline')[2].querySelector('.mw-view-button').click()")
        c = only_save(pg, "toggle to timeline")
        if c:
            check("calendar → timeline: only the display line goes", diff_lines(SRC, c), (["display: calendar"], []))
        check("toggle: no jumpto:", len(sent(pg, "jumpto:")), 0)
        check("toggle: block pending", pg.evaluate(
            "() => document.querySelectorAll('#preview .markwhen-timeline')[2].classList.contains('mw-pending')"), True)

        fresh(pg)
        pg.evaluate("() => document.querySelectorAll('#preview .markwhen-timeline')[0].querySelector('.mw-view-button').click()")
        c = only_save(pg, "toggle to calendar")
        if c:
            rm, add = diff_lines(SRC, c)
            check("timeline → calendar: display: calendar added, nothing removed",
                  [rm, "display: calendar" in add], [[], True])
            # And the saved text renders as a calendar.
            load_doc(pg, c)
            check("…re-render shows a calendar", pg.evaluate(
                "() => document.querySelectorAll('#preview .markwhen-timeline')[0].querySelector('svg').getAttribute('data-mw-view')"),
                "calendar")

        fresh(pg)
        g = pg.evaluate(GEOM, {"blk": 2, "idx": 1})
        pg.mouse.click(g["cx"], g["cy"], button="right")
        pg.wait_for_timeout(150)
        items = pg.evaluate("() => [...document.querySelectorAll('.app-context-menu')].filter(m => m.style.display !== 'none').flatMap(m => [...m.querySelectorAll('.app-menu-item')].map(i => i.textContent))")
        want = pg.evaluate("() => window.__I18N['menu.mwToTimeline'].en")
        check("menu offers the view switch", want in items, True)
        pg.evaluate("(w) => [...document.querySelectorAll('.app-menu-item')].find(i => i.textContent === w).click()", want)
        c = only_save(pg, "menu toggle")
        if c:
            check("menu toggle: same rewrite as the button", diff_lines(SRC, c), (["display: calendar"], []))

        # ================= colour legend =================
        fresh(pg)
        leg = pg.evaluate("""() => [...document.querySelectorAll('#preview .markwhen-timeline')].map(e => {
            const m = __mwModel(__diagSource(e, 'data-markwhen-source'));
            const first = new Set(m.events.filter(r => r.tags.length).map(r => r.tags[0]));
            const g = e.querySelector('svg .mw-legend');
            const svgH = e.querySelector('svg').viewBox.baseVal.height;
            let inside = true;
            if (g) for (const n of g.querySelectorAll('rect, text')) {
                const y = +n.getAttribute('y'); if (!(y > 0 && y <= svgH)) inside = false;
            }
            return { want: first.size, got: g ? g.querySelectorAll('rect').length : 0, inside };
        })""")
        check("every view draws one legend entry per colouring tag", [[l["got"], l["inside"]] for l in leg],
              [[l["want"], True] for l in leg])
        check("the timeline blocks have a legend too", leg[0]["got"] > 0, True)

        g = pg.evaluate(GEOM, {"blk": 0, "idx": 0})
        pg.mouse.click(g["cx"], g["cy"], button="right")
        pg.wait_for_timeout(150)
        hide = pg.evaluate("() => window.__I18N['menu.mwHideLegend'].en")
        items = pg.evaluate("() => [...document.querySelectorAll('.app-context-menu')].filter(m => m.style.display !== 'none').flatMap(m => [...m.querySelectorAll('.app-menu-item')].map(i => i.textContent))")
        check("menu offers hiding the legend", hide in items, True)
        pg.evaluate("(w) => [...document.querySelectorAll('.app-menu-item')].find(i => i.textContent === w).click()", hide)
        c = only_save(pg, "legend hide")
        if c:
            rm, add = diff_lines(SRC, c)
            check("legend hide: legend: false added, nothing removed", [rm, "legend: false" in add], [[], True])
            load_doc(pg, c)
            check("…re-render has no legend on that block, others keep theirs", pg.evaluate(
                "() => [...document.querySelectorAll('#preview .markwhen-timeline')].map(e => !!e.querySelector('svg .mw-legend'))"),
                [False] + [l["got"] > 0 for l in leg[1:]])

        fresh(pg)
        load_doc(pg, "```markwhen\n2024-01-01 / 2024-01-05: a\n```\n")
        check("no tags → no legend and no legend menu item", pg.evaluate("""() => [
            !!document.querySelector('#preview svg .mw-legend'),
            __mwHostLegend(document.querySelector('#preview .markwhen-timeline'))]"""), [False, None])

        # ================= EOLs: a CRLF document stays CRLF =================
        fresh(pg)
        crlf = "# t\r\n\r\n```markwhen\r\n2024-01-01 / 2024-01-05: a\r\n2024-01-10: b\r\n```\r\n"
        load_doc(pg, crlf)
        g = pg.evaluate(GEOM, {"blk": 0, "idx": 1})
        drag(pg, g["cx"], g["cy"], g["cx"] + 2.2 * g["pxPerDay"], g["cy"])
        s = sent(pg)
        check("CRLF: one savefile:", len(s), 1)
        if s:
            check("CRLF document keeps its CRLFs", raw_content_of(s[0]),
                  crlf.replace("2024-01-10: b", "2024-01-12: b"))

        # ================= refusals =================
        fresh(pg)
        load_doc(pg, "> ```markwhen\n> 2024-01-01: a\n> ```\n\n- x\n\n  ```markwhen\n  2024-01-01: b\n  ```\n")
        check("nested blocks are not editable", pg.evaluate(
            "() => [document.querySelectorAll('#preview .markwhen-timeline').length, document.querySelectorAll('.mw-editable, .mw-add-button').length]"),
            [2, 0])
        load_doc(pg, "---\nmarp: true\n---\n\n```markwhen\n2024-01-01: a\n```\n")
        check("Marp blocks are not editable", pg.evaluate(
            "() => [document.body.classList.contains('marp'), document.querySelectorAll('.markwhen-timeline').length > 0, document.querySelectorAll('.mw-editable').length]"),
            [True, True, 0])

        # ================= export strips the editing chrome =================
        fresh(pg)
        art = pg.evaluate("""async () => {
            const a = await window.buildExportArtifact({});
            // The inlined stylesheet legitimately names these selectors; look at markup.
            const h = (a.html || a).replace(/<style[\\s\\S]*?<\\/style>/g, '');
            return { svg: (h.match(/class="mw-svg/g) || []).length, stamps: /data-mw-/.test(h),
                     button: /mw-add-button|mw-view-button|mw-btn-bar/.test(h), cls: /mw-editable/.test(h) };
        }""")
        check("HTML export: figures kept, editing chrome gone", art, {"svg": 4, "stamps": False, "button": False, "cls": False})

        check("no uncaught page errors", errors, [])
        b.close()
finally:
    httpd.shutdown()

print()
print("%d FAILURES: %s" % (len(failures), ", ".join(failures)) if failures else "ALL PASS")
sys.exit(1 if failures else 0)

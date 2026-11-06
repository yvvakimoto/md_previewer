"""End-to-end check of ```linkcard in the harness (no Rust host).

The host half (`linkcard:` IPC -> `src/linkcard.rs` -> `window.__linkCardDone`) is
replaced by a fake `window.ipc` that answers each request asynchronously, so what is
verified here is the whole preview half:

- the spec grammar (bare URL / `url:` / overrides / `fetch: false`), and which cards
  ask the host at all (https only, once per URL, never for `fetch: false`);
- a pending card is patched in place when the answer arrives, keeping the
  `data-line` that editor <-> preview sync needs, and the render is held until then
  (so exports and `--export-png` see finished cards);
- a re-render (every keystroke rebuilds #preview) renders a known URL finished,
  synchronously, with no new request -- which also exercises the `/linkcard-img/`
  guard in toUserfileUrl() (the html-string image pass must not re-route it);
- a host that never answers costs the bounded wait, not the document, and a late
  answer still patches the card;
- the fetch toggle OFF sends `cacheOnly: true`;
- the Marp pipeline renders and resolves the same card;
- the HTML export inlines a `/linkcard-img/` thumbnail as a data: URI.

Rust's own half is covered by `cargo test` (src/linkcard.rs).
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

DOC = os.path.join(REPO, "samples", "linkcard.md")
with open(DOC, encoding="utf-8") as _fh:
    SRC = _fh.read()
PORT = 8797
URL = "http://127.0.0.1:%d/index.html?file=%s" % (PORT, DOC.replace("\\", "/"))
PNG = os.path.join(REPO, "samples", "images", "test.png")
FAKE_KEY = "0123456789abcdef"

# Installed before the harness bootstrap runs: the bootstrap assigns its own logging
# `window.ipc`, so pin ours with a no-op setter. Requests are recorded; `linkcard:`
# ones are answered after 150 ms unless the URL is listed in window.__lcSilent.
FAKE_IPC = """
(() => {
  window.__sentIpc = [];
  window.__lcSilent = new Set();
  const fake = {
    postMessage(m) {
      window.__sentIpc.push(m);
      if (m.indexOf('linkcard:') !== 0) return;
      const req = JSON.parse(m.slice('linkcard:'.length));
      if (window.__lcSilent.has(req.url)) return;
      setTimeout(() => window.__linkCardDone(req.url, {
        ok: true, title: 'T:' + req.url, desc: 'fetched desc', site: 'Fetched Site',
        img: '/linkcard-img/%s',
      }), 150);
    },
  };
  Object.defineProperty(window, 'ipc', { get: () => fake, set: () => {}, configurable: true });
})();
""" % FAKE_KEY

failures = []
def check(name, got, want):
    if got != want:
        failures.append(name)
        print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
    else:
        print("ok   %s" % name)

CARDS = """() => [...document.querySelectorAll('#preview a.md-linkcard, #preview .linkcard-error')].map(a => ({
  cls: a.className,
  url: a.getAttribute('data-linkcard-url'),
  line: a.getAttribute('data-line'),
  pending: a.hasAttribute('data-linkcard-pending'),
  title: (a.querySelector('.md-linkcard-title') || {}).textContent || null,
  desc: (a.querySelector('.md-linkcard-desc') || {}).textContent || null,
  site: (a.querySelector('.md-linkcard-site') || {}).textContent || null,
  img: (a.querySelector('.md-linkcard-thumb img') || { getAttribute: () => null }).getAttribute('src'),
}))"""

def requests(pg):
    return pg.evaluate("""() => window.__sentIpc.filter(m => m.indexOf('linkcard:') === 0)
                                 .map(m => JSON.parse(m.slice(9)))""")

def opener_lines(src):
    return [str(i + 1) for i, l in enumerate(src.split("\n")) if l.strip() == "```linkcard"]

def load_text(pg, text, name="t.md"):
    pg.evaluate("""async (a) => { await window.loadFileFromRust({
        filename: a.name, filepath: a.path, content: a.text, raw: a.text }); }""",
                {"name": name, "path": os.path.join(REPO, "samples", name), "text": text})

httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
        ctx.add_init_script(shoot.ui_lang_init_script("en"))
        ctx.add_init_script(FAKE_IPC)
        with open(PNG, "rb") as fh:
            png = fh.read()
        ctx.route("**/linkcard-img/**", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ================= first render =================
        pg.goto(URL)
        pg.wait_for_selector("#preview a.md-linkcard", timeout=20000)
        pg.wait_for_function("() => !document.querySelector('#preview a.md-linkcard[data-linkcard-pending]')",
                             timeout=15000)
        cards = pg.evaluate(CARDS)
        check("four cards, no error box", [c["cls"].split()[0] for c in cards], ["md-linkcard"] * 4)
        check("data-line = the fence opener", [c["line"] for c in cards], opener_lines(SRC.replace("\r\n", "\n")))
        check("nothing left pending", [c["pending"] for c in cards], [False] * 4)

        gh, mg, wiki, http = cards
        check("fetched title", gh["title"], "T:https://github.com/")
        check("fetched desc", gh["desc"], "fetched desc")
        check("fetched site", gh["site"], "Fetched Site")
        check("fetched thumbnail is the cache route", gh["img"], "/linkcard-img/" + FAKE_KEY)
        check("override title", mg["title"], "Markdown Guide（手書きのタイトル）")
        check("override desc", mg["desc"], "取得した説明文の代わりにこの文が出ます。")
        check("fetched site kept under overrides", mg["site"], "Fetched Site")
        check("local image goes through /userfile/", mg["img"], "/userfile/images/test.png")
        check("fetch:false card", (wiki["title"], wiki["site"], wiki["img"]),
              ("社内 Wiki のトップ", "社内 Wiki", None))
        check("http card falls back to URL + host", (http["title"], http["site"], http["desc"]),
              ("http://example.com/", "example.com", None))
        reqs = requests(pg)
        check("only the https fetchable cards asked, once each",
              sorted(r["url"] for r in reqs), ["https://github.com/", "https://www.markdownguide.org/"])
        check("fetch toggle defaults ON", [r.get("cacheOnly") for r in reqs], [False, False])

        # ================= re-render: known URLs are synchronous =================
        sync = pg.evaluate("""async () => {
            window.__sentIpc.length = 0;
            const done = renderMarkdown(currentMarkdown);
            // Before the first await settles: the html-string pass already ran.
            await Promise.resolve();
            const pend = document.querySelectorAll('#preview a.md-linkcard[data-linkcard-pending]').length;
            await done;
            const img = document.querySelector('#preview a.md-linkcard .md-linkcard-thumb img').getAttribute('src');
            const sent = window.__sentIpc.filter(m => m.indexOf('linkcard:') === 0).length;
            return { pend, sent, img };
        }""")
        check("re-render: no pending card, no new request", (sync["pend"], sync["sent"]), (0, 0))
        check("re-render keeps /linkcard-img/ un-rerouted", sync["img"], "/linkcard-img/" + FAKE_KEY)

        # ================= HTML export inlines the thumbnail =================
        html = pg.evaluate("async () => (await buildExportArtifact({})).html")
        check("export: card thumbnail inlined as data:",
              ("/linkcard-img/" not in html, "md-linkcard" in html, "data:image/png;base64," in html),
              (True, True, True))

        # ================= a silent host: bounded wait, late patch =================
        silent = "https://silent.example/"
        pg.evaluate("(u) => window.__lcSilent.add(u)", silent)
        t0 = pg.evaluate("() => performance.now()")
        load_text(pg, "# s\n\n```linkcard\n%s\n```\n" % silent)
        t1 = pg.evaluate("() => performance.now()")
        c = pg.evaluate(CARDS)[0]
        check("silent host: render returned after the bounded wait", 5500 < (t1 - t0) < 9000, True)
        check("silent host: fallback card, not pending", (c["title"], c["pending"]), (silent, False))
        pg.evaluate("""(u) => window.__linkCardDone(u, {ok: true, title: 'late', desc: '', site: '', img: ''})""", silent)
        check("late answer patches the card in place", pg.evaluate(CARDS)[0]["title"], "late")

        # ================= toggle OFF -> cacheOnly =================
        pg.evaluate("() => { localStorage.setItem('linkCardFetch', 'off'); window.__sentIpc.length = 0; }")
        load_text(pg, "```linkcard\nhttps://off.example/\n```\n")
        check("toggle OFF asks cache-only",
              [r.get("cacheOnly") for r in requests(pg)], [True])
        box = pg.evaluate("() => { const b = document.getElementById('linkcard-fetch'); return b && b.checked; }")
        check("S-modal checkbox exists (reflects stored ON at load)", box, True)
        pg.evaluate("() => localStorage.removeItem('linkCardFetch')")

        # ================= Marp =================
        load_text(pg, "---\nmarp: true\n---\n\n# slide\n\n```linkcard\nhttps://marp.example/\n```\n", "m.md")
        pg.wait_for_function("() => document.querySelector('#preview section a.md-linkcard')", timeout=15000)
        mc = pg.evaluate("""() => { const a = document.querySelector('#preview section a.md-linkcard');
            return { title: a.querySelector('.md-linkcard-title').textContent,
                     pending: a.hasAttribute('data-linkcard-pending') }; }""")
        check("marp: card resolved inside the slide", mc, {"title": "T:https://marp.example/", "pending": False})

        # ================= grammar edge: no URL =================
        load_text(pg, "```linkcard\ntitle: only a title\n```\n")
        check("no URL -> error box", pg.evaluate(CARDS)[0]["cls"], "linkcard-error")

        check("no page errors", errors, [])
        b.close()
finally:
    httpd.shutdown()

print()
if failures:
    print("%d FAILED: %s" % (len(failures), ", ".join(failures)))
    sys.exit(1)
print("all linkcard checks passed")

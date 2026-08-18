#!/usr/bin/env python3
"""End-to-end check for the `X` → PDF export path (preview-harness + Playwright).

The PDF is produced by printing the LIVE DOM through CDP `Page.printToPDF`, so
the only thing that decides whether a Marp deck comes out as "one page per slide,
no margins" is the state ``__beforePdfPrint()`` leaves the document in — plus the
paper size the host derives from the ``pdfprintready:`` ack. Both are reachable
from a headless browser, so the whole contract is testable with no Rust host and
no native Save dialog:

    real assets/index.html  →  __beforePdfPrint()  →  ack payload
                            →  Page.printToPDF(params)  →  pymupdf assertions

What it pins:
  * a deck prints one page per slide **from every view mode** — deck mode used to
    yield a single page (inactive slides are display:none), list mode a grid
  * the page is the slide box (16:9 → 960×540pt, 4:3 → 720×540pt), not A4
  * zero margins: a full-bleed slide background reaches all four page corners
  * a non-Marp document still prints A4 portrait with its 0.4in margins
  * __afterPdfPrint() restores the view (classes, inline sizing, injected @page)
  * a vertical-writing theme prints A4 LANDSCAPE, multi-page, losing no text --
    bunko.css at 2 pages per sheet with a nombre under each, tategaki.css with
    its line length taken from the paper. Both are the case a naive
    `break-after: page` silently truncates, so the text-completeness assertion
    is the load-bearing one here.

MIRROR: ``print_params`` below reproduces ``print_params()`` in src/pdf_win.rs.
Keep the two in sync — this file is what proves the params actually produce the
intended geometry.

Usage:
    python tools/preview-harness/pdfcheck.py [--channel msedge|chrome] [--keep]

Requires: playwright (module) + a system Chromium (Edge/Chrome) + pymupdf.
"""

import argparse
import base64
import json
import os
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402

# Labels and asserted document text are Japanese; a Windows console defaults to
# cp932 and would raise on the first em dash.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

CSS_PX_PER_IN = 96.0
PT_PER_IN = 72.0

FAILURES = []
CHECKS = 0


def check(label, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s %s" % (label, detail))
        FAILURES.append(label)


def approx(a, b, tol=1.0):
    return abs(a - b) <= tol


def print_params(page_px):
    """MIRROR of print_params() in src/pdf_win.rs."""
    if page_px:
        w_in, h_in, margin = page_px[0] / CSS_PX_PER_IN, page_px[1] / CSS_PX_PER_IN, 0.0
    else:
        w_in, h_in, margin = 8.27, 11.69, 0.4
    return {
        "landscape": False,
        "printBackground": True,
        "generateDocumentOutline": True,
        "preferCSSPageSize": True,
        "scale": 1,
        "marginTop": margin,
        "marginBottom": margin,
        "marginLeft": margin,
        "marginRight": margin,
        "paperWidth": w_in,
        "paperHeight": h_in,
    }


# A deck with a full-bleed background colour: any print margin shows up as white
# at the page corners, which a rasterized corner sample detects directly.
DECK_MD = """---
marp: true
theme: default
backgroundColor: #123456
color: #ffffff
---

# スライド 1

一枚目の本文。

---

# スライド 2

二枚目の本文。

---

# スライド 3

三枚目の本文。
"""

DECK_43_MD = DECK_MD.replace("theme: default", "theme: default\nsize: 4:3")

# Long enough to need several 文庫 pages: the whole point is multi-page output.
VERTICAL_MD = "# 縦組みの文書\n\n" + "".join(
    "## 第%d節\n\n%s\n\n" % (i + 1, ("この文書は縦組みテーマの印刷経路を確かめるためのものである。"
                                       "行は右から左へ進み、紙は横に置かれる。") * 6)
    for i in range(6))

PLAIN_MD = """# 通常のドキュメント

これは Marp ではないので A4 縦のままであるべき。

## 見出し 2

本文本文本文。
"""

# Record every IPC message the page posts, so the ack payload is inspectable.
RECORD_IPC_JS = """() => {
  window.__ipcLog = [];
  const prev = window.ipc && window.ipc.postMessage;
  window.ipc = window.ipc || {};
  window.ipc.postMessage = (m) => { window.__ipcLog.push(m); if (prev) { try { prev(m); } catch (e) {} } };
}"""


def start_harness(port, repo_root, assets_dir):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.Handler)
    httpd.repo_root = repo_root
    httpd.assets_dir = assets_dir
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def open_styled(browser, style):
    """A fresh context whose localStorage picks a user style, as startup would.

    A style cannot be switched mid-page here: the S-key modal is the only UI for
    it, and add_init_script only runs on navigation. A per-style context is also
    what keeps each case's localStorage from leaking into the next.
    """
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.add_init_script(
        "(() => { try { localStorage.setItem('styleName', %s); } catch (e) {} })()" % json.dumps(style))
    return ctx, page, ctx.new_cdp_session(page)


def load_vertical(page, url):
    """Load a doc under a vertical theme and wait for the split to settle."""
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }")
    page.wait_for_function(
        "() => /^vertical/.test(getComputedStyle(document.getElementById('preview')).writingMode)")
    page.wait_for_timeout(400)
    page.evaluate(RECORD_IPC_JS)


def flat_text(doc):
    return ["".join(doc[i].get_text().split()) for i in range(doc.page_count)]


def load(page, url, marp):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }"
    )
    if marp:
        page.wait_for_function(
            "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length > 0"
        )
    page.wait_for_timeout(250)
    page.evaluate(RECORD_IPC_JS)


def run_export(page, client, out_path):
    """Drive the real handshake and write the PDF. Returns the ack payload dict."""
    page.evaluate("() => window.__beforePdfPrint()")
    acks = [m for m in page.evaluate("() => window.__ipcLog || []")
            if m.startswith("pdfprintready:")]
    if not acks:
        raise AssertionError("no pdfprintready: ack was posted")
    payload = json.loads(acks[-1][len("pdfprintready:"):] or "{}")
    page_px = None
    if isinstance(payload.get("pageW"), (int, float)) and isinstance(payload.get("pageH"), (int, float)):
        if payload["pageW"] > 0 and payload["pageH"] > 0:
            page_px = (float(payload["pageW"]), float(payload["pageH"]))
    res = client.send("Page.printToPDF", print_params(page_px))
    with open(out_path, "wb") as fh:
        fh.write(base64.b64decode(res["data"]))
    return payload


def corners(pix):
    """The four corner pixels as (r,g,b), inset by 2px to dodge AA at the edge."""
    def at(x, y):
        return tuple(pix.pixel(x, y)[:3])
    w, h = pix.width - 1, pix.height - 1
    return [at(2, 2), at(w - 2, 2), at(2, h - 2), at(w - 2, h - 2)]


def near(rgb, want, tol=12):
    return all(abs(a - b) <= tol for a, b in zip(rgb, want))


def main():
    ap = argparse.ArgumentParser(description="PDF export check (preview-harness)")
    ap.add_argument("--channel", default=None, help="browser channel: msedge | chrome")
    ap.add_argument("--port", type=int, default=8773)
    ap.add_argument("--keep", action="store_true", help="keep the generated PDFs")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)
    try:
        import fitz
    except ImportError:
        sys.stderr.write("ERROR: pymupdf is not installed (pip install pymupdf)\n")
        sys.exit(2)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")

    tmp = tempfile.mkdtemp(prefix="mdp-pdfcheck-")
    deck = os.path.join(tmp, "deck.md")
    deck43 = os.path.join(tmp, "deck43.md")
    plain = os.path.join(tmp, "plain.md")
    vertical = os.path.join(tmp, "vertical.md")
    for path, body in ((deck, DECK_MD), (deck43, DECK_43_MD), (plain, PLAIN_MD),
                       (vertical, VERTICAL_MD)):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)

    httpd = start_harness(args.port, repo_root, assets_dir)
    base = "http://127.0.0.1:%d/index.html?file=" % args.port

    try:
        with sync_playwright() as p:
            channels = [args.channel] if args.channel else ["msedge", "chrome", None]
            browser = last_err = None
            for ch in channels:
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
            if browser is None:
                sys.stderr.write("ERROR: could not launch a Chromium browser: %s\n" % last_err)
                sys.exit(3)

            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.set_default_timeout(20000)
            client = ctx.new_cdp_session(page)

            # ---- Marp deck, from each of the three view modes ------------------
            for mode in ("scroll", "deck", "list"):
                print("\n[Marp 16:9 — %s モード]" % mode)
                load(page, base + deck, marp=True)
                page.evaluate("(m) => window.setMarpView && setMarpView(m)", mode)
                page.wait_for_timeout(200)
                n = page.evaluate(
                    "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length")
                out = os.path.join(tmp, "deck-%s.pdf" % mode)
                payload = run_export(page, client, out)

                check("ack reports the slide box",
                      payload.get("pageW") == 1280 and payload.get("pageH") == 720, payload)

                doc = fitz.open(out)
                check("1 page per slide (%d slides)" % n, doc.page_count == n,
                      "got %d pages" % doc.page_count)
                r = doc[0].rect
                check("page is 960x540pt (13.333x7.5in)",
                      approx(r.width, 960) and approx(r.height, 540),
                      "got %.1fx%.1f" % (r.width, r.height))
                pix = doc[0].get_pixmap(dpi=48)
                cs = corners(pix)
                check("no margin: slide bleeds to all 4 corners",
                      all(near(c, (0x12, 0x34, 0x56)) for c in cs), cs)
                check("text is still selectable", "スライド" in doc[0].get_text(),
                      repr(doc[0].get_text()[:40]))
                doc.close()

                # Restore must put the view back exactly as it was.
                page.evaluate("() => window.__afterPdfPrint()")
                page.wait_for_timeout(150)
                state = page.evaluate("""() => {
                  const b = document.body, s = document.querySelector('div.marpit > svg[data-marpit-svg]');
                  return {
                    pdfPrint: b.classList.contains('pdf-print'),
                    deck: b.classList.contains('deck-mode'),
                    list: b.classList.contains('list-mode'),
                    pageStyle: !!document.getElementById('pdf-page-style'),
                    inlineW: s ? s.style.width : 'n/a',
                  };
                }""")
                check("restore: .pdf-print dropped", state["pdfPrint"] is False, state)
                check("restore: @page style removed", state["pageStyle"] is False, state)
                check("restore: inline slide sizing cleared", state["inlineW"] == "", state)
                check("restore: view mode is back to %s" % mode,
                      state["deck"] == (mode == "deck") and state["list"] == (mode == "list"), state)

            # ---- 4:3 deck ------------------------------------------------------
            print("\n[Marp 4:3]")
            load(page, base + deck43, marp=True)
            out = os.path.join(tmp, "deck43.pdf")
            payload = run_export(page, client, out)
            check("ack reports the 4:3 slide box",
                  payload.get("pageW") == 960 and payload.get("pageH") == 720, payload)
            doc = fitz.open(out)
            r = doc[0].rect
            check("page is 720x540pt (10x7.5in)",
                  approx(r.width, 720) and approx(r.height, 540),
                  "got %.1fx%.1f" % (r.width, r.height))
            cs = corners(doc[0].get_pixmap(dpi=48))
            check("no margin on a 4:3 deck", all(near(c, (0x12, 0x34, 0x56)) for c in cs), cs)
            doc.close()

            ctx.close()

            # ---- vertical-writing themes: A4 landscape ------------------------
            for style, per, label in (("bunko.css", 2, "bunko"), ("tategaki.css", 1, "tategaki")):
                print("\n[%s — A4 横]" % label)
                vctx, vpage, vclient = open_styled(browser, style)
                load_vertical(vpage, base + vertical)
                body_chars = vpage.evaluate(
                    "() => document.getElementById('preview').innerText.replace(/\\s+/g,'').length")
                out = os.path.join(tmp, "%s.pdf" % label)
                payload = run_export(vpage, vclient, out)
                sheets = vpage.evaluate(
                    "() => document.querySelectorAll('#preview .md-sheet-end').length + 1")
                npages = vpage.evaluate(
                    "() => document.querySelectorAll('#preview > .md-page').length")

                check("ack reports A4 landscape in CSS px",
                      payload.get("pageW") == 1122 and payload.get("pageH") == 793, payload)
                doc = fitz.open(out)
                r = doc[0].rect
                check("page is A4 landscape (841.5x594.75pt)",
                      approx(r.width, 841.5) and approx(r.height, 594.75),
                      "got %.1fx%.1f" % (r.width, r.height))
                check("more than one page", doc.page_count > 1, doc.page_count)

                texts = flat_text(doc)
                total = sum(len(t) for t in texts)
                # The orthogonal-flow failure this whole path exists to avoid loses
                # most of the body silently, so completeness is the real assertion.
                check("no text is lost (%d chars over %d pages)" % (total, doc.page_count),
                      total >= body_chars, "pdf=%d preview=%d" % (total, body_chars))
                check("every page carries text", all(len(t) > 0 for t in texts),
                      [len(t) for t in texts])
                check("page 1 starts at the top of the document",
                      texts[0].startswith("縦組みの文書"), texts[0][:20])

                area = fitz.Rect(28.5, 28.5, r.width - 28.5, r.height - 28.5)
                worst = None
                for i in range(doc.page_count):
                    for b in doc[i].get_text("blocks"):
                        bb = fitz.Rect(b[:4])
                        if not (bb.x0 >= area.x0 - 2 and bb.x1 <= area.x1 + 2
                                and bb.y0 >= area.y0 - 2 and bb.y1 <= area.y1 + 2):
                            worst = (i + 1, tuple(round(v, 1) for v in b[:4]))
                check("nothing spills outside the printable area", worst is None, worst)

                if style == "bunko.css":
                    check("the deck is packed %d pages to a sheet" % per,
                          doc.page_count == sheets and sheets <= -(-npages // per) + 1,
                          "pages=%d sheets=%d 文庫pages=%d" % (doc.page_count, sheets, npages))
                    nombres = [[int(w) for w in doc[i].get_text().split()
                                if w.isdigit() and 1 <= int(w) <= npages] for i in range(doc.page_count)]
                    seen = [n for page_ns in nombres for n in page_ns]
                    check("every 文庫 page's nombre appears exactly once",
                          all(seen.count(k) >= 1 for k in range(1, npages + 1)), seen)
                doc.close()

                vpage.evaluate("() => window.__afterPdfPrint()")
                vpage.wait_for_timeout(150)
                state = vpage.evaluate("""() => ({
                  pdfPrint: document.body.classList.contains('pdf-print'),
                  vertical: document.body.classList.contains('pdf-vertical'),
                  src: document.getElementById('preview').classList.contains('pdf-vertical-src'),
                  pageStyle: !!document.getElementById('pdf-page-style'),
                  preStyle: !!document.getElementById('pdf-vertical-style'),
                  marks: document.querySelectorAll('#preview .md-sheet-end').length,
                })""")
                check("restore: every print-only class and style is gone",
                      not any(state[k] for k in ("pdfPrint", "vertical", "src", "pageStyle", "preStyle"))
                      and state["marks"] == 0, state)
                vctx.close()

            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.set_default_timeout(20000)
            client = ctx.new_cdp_session(page)

            # ---- non-Marp regression ------------------------------------------
            print("\n[非 Marp — 現状維持]")
            load(page, base + plain, marp=False)
            out = os.path.join(tmp, "plain.pdf")
            payload = run_export(page, client, out)
            check("ack carries no page size", payload == {}, payload)
            doc = fitz.open(out)
            r = doc[0].rect
            check("page is A4 portrait (595x842pt)",
                  approx(r.width, 595, 2) and approx(r.height, 842, 2),
                  "got %.1fx%.1f" % (r.width, r.height))
            cs = corners(doc[0].get_pixmap(dpi=48))
            check("margins are still white", all(near(c, (255, 255, 255)) for c in cs), cs)
            check("bookmarks still generated", len(doc.get_toc()) >= 2, doc.get_toc())
            doc.close()

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print("\n%d checks, %d failed" % (CHECKS, len(FAILURES)))
    if args.keep:
        print("artifacts: %s" % tmp)
    if FAILURES:
        for f in FAILURES:
            print("  - %s" % f)
        sys.exit(1)


if __name__ == "__main__":
    main()

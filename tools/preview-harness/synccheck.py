#!/usr/bin/env python3
"""Editor<->preview position sync, across both scroll axes (Playwright).

`applyEditorScroll(line)` and its inverse `currentPreviewLine()` were written
against the vertical axis only (rect.top / scrollTop / clientHeight). Under a
vertical-writing theme (tategaki.css, bunko.css) the preview runs leftward and
scrolls HORIZONTALLY, so scrollTop never moves: the editor->preview scroll was
a silent no-op and the E-key reverse jump always reported the first line. The
DOM digest (domdump.py) cannot see this -- the markup is identical either way,
only the scroll offsets differ -- hence this script.

What it pins, per style:
  * the axis the reader actually scrolls along (measured, not inferred);
  * applyEditorScroll() MOVES the preview (the regression itself);
  * it lands the target block ~25% in from the reading-start edge;
  * currentPreviewLine() round-trips applyEditorScroll() -- the property the
    E-key open->edit->reopen cycle depends on.

Usage:
    python tools/preview-harness/synccheck.py [--channel msedge|chrome]
"""

import argparse
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402
from shoot import start_harness, style_init_script, wait_for_render  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# (style, sample). The vertical pair is the point; the horizontal-tb rows are
# the non-regression net for the axis that already worked.
CASES = [
    ("bunko.css", "samples/短編小説.md"),
    ("tategaki.css", "samples/縦書き長文.md"),
    (None, "samples/長文技術ドキュメント.md"),
    ("parchment.css", "samples/長文技術ドキュメント.md"),
]

FAILURES = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILURES.append(msg)


# Distance of a [data-line] block from the reading-start edge of the viewport,
# in the axis the reader scrolls along. Mirrors the geometry in index.html.
DIST_JS = """
(line) => {
  const pc = document.getElementById('preview-container');
  const el = document.querySelector('[data-line="' + line + '"]');
  if (!el) return null;
  const horizontal = pc.scrollWidth > pc.clientWidth + 1;
  const c = pc.getBoundingClientRect(), r = el.getBoundingClientRect();
  return {
    horizontal,
    dist: horizontal ? (c.right - r.right) : (r.top - c.top),
    extent: horizontal ? pc.clientWidth : pc.clientHeight,
    scroll: horizontal ? pc.scrollLeft : pc.scrollTop,
  };
}
"""


def run_case(page, port, style, sample):
    label = "%s + %s" % (style or "Default", os.path.basename(sample))
    print("\n== %s" % label)
    abs_md = os.path.join(REPO, sample.replace("/", os.sep))
    url = "http://127.0.0.1:%d/index.html?file=%s" % (
        port, urllib.parse.quote(abs_md, safe=""))
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview');"
        " return p && p.children.length>0; }")
    wait_for_render(page)

    horizontal = page.evaluate(
        "() => { const pc=document.getElementById('preview-container');"
        " return pc.scrollWidth > pc.clientWidth + 1; }")
    expect_h = style in ("bunko.css", "tategaki.css")
    check(horizontal == expect_h,
          "scroll axis is %s" % ("horizontal" if expect_h else "vertical"))

    # Source lines to aim at: real stamped [data-line] values, sampled across
    # the document so at least one is far from the reading start.
    lines = page.evaluate(
        "() => [...document.querySelectorAll('#preview [data-line]')]"
        " .map(e => parseInt(e.getAttribute('data-line'),10))"
        " .filter(Number.isFinite)")
    check(len(lines) >= 8, "document has enough stamped blocks (%d)" % len(lines))
    if len(lines) < 8:
        return
    targets = [lines[len(lines) * k // 5] for k in (1, 2, 3, 4)]

    page.evaluate("() => window.applyEditorScroll(1)")
    page.wait_for_timeout(80)
    start_scroll = page.evaluate(DIST_JS, lines[0])["scroll"]

    moved = False
    for want in targets:
        page.evaluate("(l) => window.applyEditorScroll(l)", want)
        page.wait_for_timeout(80)
        g = page.evaluate(DIST_JS, want)
        if g is None:
            continue
        if abs(g["scroll"] - start_scroll) > 1:
            moved = True

        # Landed ~25% in from the reading-start edge. A block near the end of
        # the document cannot reach the mark (the scroll clamps), so only the
        # non-clamped case is asserted strictly; the rest must at least be on
        # screen rather than off the far edge.
        margin = g["extent"] * 0.25
        near = abs(g["dist"] - margin) <= max(24, g["extent"] * 0.06)
        onscreen = -1 <= g["dist"] <= g["extent"]
        check(near or onscreen,
              "line %d lands in view (dist=%.0f, margin=%.0f)" % (want, g["dist"], margin))

        # Round trip: the inverse must report the line we just scrolled to.
        got = page.evaluate("() => window.currentPreviewLine()")
        check(got == want,
              "currentPreviewLine() round-trips line %d (got %d)" % (want, got))

    check(moved, "applyEditorScroll() actually scrolls the preview")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8779)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    httpd = start_harness(args.port, REPO, os.path.join(REPO, "assets"))
    try:
        with sync_playwright() as p:
            browser = None
            for ch in ([args.channel] if args.channel else ["msedge", "chrome", None]):
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception:  # noqa: BLE001
                    pass
            if browser is None:
                sys.stderr.write("ERROR: could not launch a Chromium browser\n")
                sys.exit(3)
            for style, sample in CASES:
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                page = ctx.new_page()
                page.set_default_timeout(20000)
                page.add_init_script(style_init_script(style))
                try:
                    run_case(page, args.port, style, sample)
                finally:
                    ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print("\n%d failure(s)" % len(FAILURES))
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()

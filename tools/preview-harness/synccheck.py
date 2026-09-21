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

    # Stepping the cursor line by line (j / down-arrow) must move the preview
    # MONOTONICALLY. The sub-block interpolation advances fractionally into the
    # current block on the lines between two stamped blocks -- typically the
    # blank line separating two paragraphs -- and if its sign is wrong for the
    # axis, every such step scrolls BACKWARD and the next real line snaps
    # forward again: the preview visibly oscillates as the cursor is stepped.
    # Monotonicity is the property; the absolute direction differs per axis
    # (a right-to-left flow advances by DECREASING scrollLeft), so it is
    # derived from the overall trend rather than assumed.
    seq = page.evaluate("""(maxLine) => {
      const pc = document.getElementById('preview-container');
      const horizontal = pc.scrollWidth > pc.clientWidth + 1;
      const out = [];
      for (let L = 1; L <= maxLine; L++) {
        window.applyEditorScroll(L);
        out.push([L, +(horizontal ? pc.scrollLeft : pc.scrollTop).toFixed(1)]);
      }
      return out;
    }""", min(160, max(lines)))
    sign = 1 if (seq[-1][1] - seq[0][1]) >= 0 else -1
    backward = [(seq[i - 1], seq[i]) for i in range(1, len(seq))
                if (seq[i][1] - seq[i - 1][1]) * sign < -0.6]
    check(not backward,
          "stepping the cursor line by line never scrolls backward (%d reversal(s))"
          % len(backward))
    for (a, b) in backward[:5]:
        print("       line %d -> %d : pos %.1f -> %.1f" % (a[0], b[0], a[1], b[1]))

    check_cursor_block(page, targets[1])


# Count of tinted blocks, plus the data-line of the (single) one. The COUNT is
# the assertion that matters: under a paginating theme (bunko.css) a class
# stamped before paginatePreview() is carried onto BOTH halves of a split
# paragraph by __splitBlockAt's shallow cloneNode, and two tinted blocks is the
# only visible symptom. Nothing else in the suite can see it -- the DOM digest
# never stamps the class at all (no editor host), and the markup is otherwise
# identical.
TINT_JS = """
() => {
  const els = [...document.querySelectorAll('#preview .md-cursor-line')];
  return { n: els.length, line: els.length ? els[0].getAttribute('data-line') : null };
}
"""


def check_cursor_block(page, line):
    # The pref is shared, unprefixed, and 'on'/'off' -- not 'true'/'false'.
    # Read fresh on every apply, so no reload is needed here.
    page.evaluate("() => localStorage.setItem('cursorBlock', 'on')")
    page.evaluate("(l) => window.applyEditorCursor(l)", line)
    page.wait_for_timeout(60)
    t = page.evaluate(TINT_JS)
    check(t["n"] == 1, "cursor block tints exactly one block (got %d)" % t["n"])

    want = page.evaluate(
        "(l) => { const r = window.__blockForLine(l);"
        " return r.target ? r.target.getAttribute('data-line') : null; }", line)
    check(t["line"] == want,
          "the tinted block is the one applyEditorScroll targets (%s vs %s)"
          % (t["line"], want))

    # Survives a wholesale #preview rebuild that the editor did not cause.
    # The M key re-renders from scratch, so the class is gone unless the render
    # tail re-stamps it.
    page.keyboard.press("m")
    wait_for_render(page)
    page.wait_for_timeout(120)
    t = page.evaluate(TINT_JS)
    check(t["n"] == 1, "cursor block survives a dark-mode re-render (got %d)" % t["n"])
    page.keyboard.press("m")
    wait_for_render(page)

    # Turning the pref off clears it, with no re-render and no IPC -- the same
    # path the editor's storage event takes.
    page.evaluate("() => localStorage.setItem('cursorBlock', 'off')")
    page.evaluate("() => window.__applyCursorLineHighlight()")
    check(page.evaluate(TINT_JS)["n"] == 0, "pref off clears the tint")

    # applyEditorScroll is NOT an editor-cursor entry point: the preview's own
    # Back/Forward restore calls it with a stored view line. Tinting there would
    # light a block up on Alt+<- with no editor open at all.
    page.evaluate("() => localStorage.setItem('cursorBlock', 'on')")
    page.evaluate("() => window.applyEditorCursor(0)")
    page.evaluate("(l) => window.applyEditorScroll(l)", line)
    page.wait_for_timeout(60)
    check(page.evaluate(TINT_JS)["n"] == 0,
          "applyEditorScroll() alone never tints (the history-restore caller)")

    # applyEditorCursor(0) is the "no editor cursor" contract the three
    # editor-close arms in src/main.rs use.
    page.evaluate("(l) => window.applyEditorCursor(l)", line)
    page.wait_for_timeout(60)
    page.evaluate("() => window.applyEditorCursor(0)")
    check(page.evaluate(TINT_JS)["n"] == 0, "applyEditorCursor(0) clears the tint")

    # The LIVE-EDIT sequence, and the reason this case exists: on every
    # keystroke Rust emits ONE script -- loadFileFromRust(...) then
    # applyEditorCursor(line) -- so the cursor call lands while the render is
    # still in flight and __loadingFile is set. Every re-apply site runs INSIDE
    # loadFileFromRust, so an `if (__loadingFile) return` guard in the
    # highlighter silently drops the tint on every keystroke and never restores
    # it (the drain that follows calls applyEditorScroll, which does not stamp).
    # Calling applyEditorCursor on a settled page -- what every case above does
    # -- cannot see that at all; it was found by driving the real app.
    page.evaluate("() => localStorage.setItem('cursorBlock', 'on')")
    page.evaluate("""(l) => {
      window.loadFileFromRust({
        filename: 'x.md', filepath: currentFilePath,
        content: currentMarkdown, raw: currentMarkdownRaw,
      });
      window.applyEditorCursor(l);
    }""", line)
    wait_for_render(page)
    page.wait_for_timeout(300)
    t = page.evaluate(TINT_JS)
    check(t["n"] == 1, "the tint survives a live-edit re-render (got %d)" % t["n"])

    page.evaluate("() => window.applyEditorCursor(0)")
    page.evaluate("() => localStorage.removeItem('cursorBlock')")


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

#!/usr/bin/env python3
"""Generate every screenshot used by the GitHub Pages landing page (docs/).

One command regenerates the whole image set, so the page never drifts from the
product:

    python tools/preview-harness/shoot-docs.py

This builds on ``shoot.py`` (same in-process preview-harness, same headless
system Chromium) but differs from it in two ways that matter for marketing
shots rather than regression baselines:

1. **Viewport capture, not full-page.** ``shoot.py`` neutralizes every
   overflow-clipping ancestor so the whole document lands in one tall PNG. That
   is right for a pixel baseline and wrong here twice over: the result no longer
   looks like the app (no sidebar framing, absurd aspect ratio), and under a
   *vertical-writing* theme ``height:auto`` on ``#preview`` collapses the line
   length and the capture comes out **completely blank** (measured on
   ``bunko.css``: a 22378x1800 all-white PNG). Capturing the 1440x900 viewport
   as the app actually paints it fixes both -- and ``resetPreviewScrollToStart()``
   has already parked a ``vertical-rl`` document at its reading start (the right
   edge), so the first bunko pages are what lands in frame.

2. **The editor window is in scope.** ``shoot.py`` only ever opens
   ``index.html``; two of the five landing-page personas are about the companion
   editor. Those shots boot ``editor.html`` with the same ``__initialFile`` +
   ``ipc`` shim ``cellcheck.py`` uses to stand in for the Rust host.

Output is **WebP**, not PNG. These are screenshots of text, which PNG stores
losslessly and expensively: the raw set came to 2.9 MB, and at the size a
landing page actually displays them (~800 CSS px, i.e. 1600 device px on a 2x
display) WebP q88 reproduces the same pixels for roughly a fifth of that. Pillow
is already a repo dependency (``tools/make-icon/make_icon.py``).

Requires: playwright (module) + a system Chromium (Edge or Chrome), exactly like
``shoot.py`` -- no ``playwright install`` needed -- plus Pillow.
"""

import argparse
import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_ROOT = os.path.join(REPO_ROOT, "docs", "assets", "img")

VIEWPORT = {"width": 1440, "height": 900}

# The editor shots are read at roughly half the width of a preview shot on the
# page, so a 1440px capture downscales its code to illegible. Capturing a
# smaller viewport puts the same content on fewer CSS px, i.e. bigger type in
# the delivered image -- cropping afterwards cannot buy that back.
EDITOR_VIEWPORT = {"width": 1040, "height": 660}

# Web delivery: longest edge in device px, and the WebP quality used for it.
MAX_EDGE = 1600
WEBP_QUALITY = 88

# Stands in for the Rust host when booting editor.html. Must be an IIFE:
# add_init_script evaluates the string as a script *body*, so a bare function
# expression would be evaluated and discarded (see cellcheck.py).
EDITOR_INIT = """(() => {
  window.__initialFile = %(file)s;
  window.__marpUserThemes = [];
  window.ipc = { postMessage: () => {} };
  try {
    localStorage.setItem('editor:vim', %(vim)s);
    localStorage.setItem('editor:cellMode', %(cells)s);
    localStorage.setItem('editor:livePreview', 'off');
    localStorage.setItem('uiLang', 'ja');
  } catch (e) {}
})();"""


# --- preview-window shots -------------------------------------------------

PREVIEW_SHOTS = [
    # name          markdown                          style        slides
    ("read",       "samples/長文技術ドキュメント.md",  None,        None),
    ("math",       "samples/math.md",                  None,        None),
    ("tikzcd",     "samples/tikzcd.md",                None,        None),
    ("bunko",      "samples/短編小説.md",              "bunko.css", None),
    # Marp: 12 = a two-column slide pairing KaTeX + bullets with a Plotly 3D
    # surface -- the front card of the deck fan, so it is the one that has to
    # show what the tool can do. 08 = mermaid in a slide, 02 = gradient section
    # divider (colour, in the back of the fan). Picked off a contact sheet of all 32.
    # These indices are positional: inserting a slide into samples/marp.md ahead of
    # one of them renumbers it, so re-check after editing that file.
    ("marp",       "samples/marp.md",                  None,        [2, 8, 12]),
]

# Documents whose interesting content is not at the very top; scroll the
# preview container down by this many CSS px before capturing.
SCROLL_Y = {"tikzcd": 520}


def shoot_preview(pw, port, name, md_rel, style, slides):
    md = os.path.join(REPO_ROOT, md_rel)
    out_dir = os.path.join(OUT_ROOT, name)
    os.makedirs(out_dir, exist_ok=True)
    written = []

    ctx = pw.new_context(viewport=VIEWPORT, device_scale_factor=2, locale="ja-JP")
    page = ctx.new_page()
    page.set_default_timeout(30000)
    page.add_init_script(shoot.style_init_script(style))
    page.add_init_script(shoot.ui_lang_init_script("ja"))
    page.goto("http://127.0.0.1:%d/index.html?file=%s" % (port, md),
              wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }")
    shoot.wait_for_render(page)
    page.wait_for_timeout(600)

    if slides:
        # Marp: screenshot the slide <svg> itself -> an exact 16:9 crop.
        page.wait_for_function(
            "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length > 0")
        page.evaluate("() => { try { if (window.fitMarpSlides) fitMarpSlides(); } catch(e){} }")
        page.wait_for_timeout(200)
        report = page.evaluate("() => window.__marpFitReport || []")
        svgs = page.locator("div.marpit > svg[data-marpit-svg]")
        for n in slides:
            idx = n - 1
            m = report[idx] if idx < len(report) else {}
            if m.get("flooredAtMin"):
                sys.stderr.write(
                    "WARN: slide %d is floored at the autofit minimum -- "
                    "it overflows even shrunk; not a slide to advertise.\n" % n)
            dest = os.path.join(out_dir, "slide-%02d.png" % n)
            svgs.nth(idx).screenshot(path=dest)
            written.append(dest)
    else:
        dy = SCROLL_Y.get(name, 0)
        if dy:
            page.evaluate(
                "(y) => { document.getElementById('preview-container').scrollTop = y; }", dy)
            page.wait_for_timeout(250)
        dest = os.path.join(out_dir, "app.png")
        page.screenshot(path=dest)
        written.append(dest)

    ctx.close()
    return written


# --- editor-window shots --------------------------------------------------

EDITOR_SHOTS = [
    # name,         markdown fixture,       vim,   cells, keys to type
    ("editor-math", "samples/math.md",      "off", "off", ["\\begin{"]),
    # ":set dvorak" left un-submitted so the Vim ex prompt is visible in frame:
    # that one line says "this is really Vim" better than a block caret can.
    ("editor-vim",  "samples/短編小説.md",   "on",  "off", [":", "set dvorak"]),
]


def shoot_editor(pw, port, name, md_rel, vim, cells, keys):
    md = os.path.join(REPO_ROOT, md_rel)
    with open(md, encoding="utf-8") as fh:
        content = fh.read()
    out_dir = os.path.join(OUT_ROOT, name)
    os.makedirs(out_dir, exist_ok=True)

    ctx = pw.new_context(viewport=EDITOR_VIEWPORT, device_scale_factor=2, locale="ja-JP")
    page = ctx.new_page()
    page.set_default_timeout(30000)
    page.add_init_script(EDITOR_INIT % {
        "file": json.dumps({"path": md, "content": content, "line": 1}),
        "vim": json.dumps(vim),
        "cells": json.dumps(cells),
    })
    page.goto("http://127.0.0.1:%d/editor.html" % port, wait_until="domcontentloaded")
    page.wait_for_selector(".cm-content")
    page.wait_for_timeout(700)
    page.click(".cm-content")

    for k in keys:
        page.keyboard.type(k, delay=60)
        page.wait_for_timeout(500)

    # Pin the status bar open so the shot shows it (it auto-hides otherwise).
    page.evaluate("() => document.body.classList.add('status-pinned')")
    page.wait_for_timeout(300)

    dest = os.path.join(out_dir, "app.png")
    page.screenshot(path=dest)
    ctx.close()
    return [dest]


# --- gallery: one rendered figure per notation ----------------------------
#
# These snippets are the SINGLE SOURCE OF TRUTH for the landing page's gallery:
# each is rendered by the real pipeline and screenshotted, and the same text is
# shown verbatim in a <pre> beside the picture in index.html.
# check_gallery_sources() asserts the page still carries them, so a snippet and
# the picture of it cannot drift apart silently.
#
# Raw strings throughout -- the snippets are full of TeX backslashes.
#
# The fixture is written into samples/ rather than a temp dir because a snippet
# may reference a sibling resource the way a real document would (the plotly
# block reads data/sales.csv); it is removed in a finally.
GALLERY = [
    ("ruby", "#preview p", r"""｜吾輩《わがはい》は{猫|ねこ}である。"""),

    ("csv", ".csv-table", r"""```csv
項目,Q1,Q2,Q3
売上,120,150,170
利益,30,42,55
```"""),

    # Deliberately NOT just the `::: columns` region: the point of the fenced
    # div is that a document drops into columns and comes back out, so the shot
    # is of #preview -- one column of prose, two columns, one column again.
    # (`trim_to_ink` crops the surrounding paper away.)
    ("columns", "#preview", r"""ウェルギリウス『アエネーイス』の一節を、原文と訳で並べます。

::: columns
### Aeneis I, 462
sunt lacrimae rerum et mentem mortalia tangunt.
+++
### アエネーイス 第 1 歌 462
ものにも涙があり、人の世のはかなさが心を打つ。
:::

`:::` で 1 カラムに戻るので、この段落はまた幅いっぱいに流れます。"""),

    ("abc", ".abc-notation", r"""```abc
X:1
T:きらきら星
M:4/4
L:1/4
K:C
C C G G | A A G2 | F F E E | D D C2 |
```"""),

    ("markwhen", ".markwhen-timeline", r"""```markwhen
---
title: プロジェクト計画
#design: blue
#dev: green
---

# 企画
2023-01-01 / 2023-02-15: 要件定義 #design
2023-02-01: キックオフ

# 開発
2023-03-01 / 2023-06-30: API 実装 #dev
```"""),

    # Same notation as the timeline above plus one header line. `country: JP`
    # pulls public holidays, which is online-only by design -- the capture just
    # renders without them when there is no network, and never fails.
    ("markwhen-cal", ".markwhen-timeline", r"""```markwhen
---
title: 4月の予定
display: calendar
country: JP
#plan: blue
#trip: green
---

2024-04-03: 企画会議 #plan
2024-04-08 / 2024-04-12: 出張 #trip
2024-04-22: 締め切り
```"""),

    ("mermaid", ".mermaid", r"""```mermaid
flowchart LR
  A[編集] --> B{保存}
  B -->|marp: true| C[スライド]
  B -->|通常| D[プレビュー]
```"""),

    ("plotly", ".plotly-block", r"""```plotly
file: data/sales.csv
type: line
x: month
y: revenue
```"""),

    ("math", ".katex-display .katex", r"""$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$"""),

    ("tikzcd", ".tikzcd-diagram", r"""```tikzcd
A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
C \arrow[r, "k"']                & D
```"""),

    ("kataskeve", ".kataskeve", r"""```kataskeve
viewport: -1 -1 5 4
A = point(0, 0); B = point(4, 0); C = point(4, 3)
triangle(A, B, C)
A; B; C
label A "A" pos=SW
label C "C" pos=NE
mark right_angle(A, B, C)
mark angle(B, A, C) arcs=1 radius=0.8
```"""),

    # The 3D engine rasterizes to a <canvas>, so this one is a bitmap rather
    # than SVG. `penrose_triangle` walks its ancestors for the first opaque
    # background to use as "paper" and defaults to white -- the preview column
    # is white, which is also what the gallery panel expects.
    ("kataskeve3d", ".kataskeve3d", r"""```kataskeve3d
view: tilt=18 yaw=0
unit: 150
shading: on
light: az=150 el=35
penrose_triangle(point(0,0,0), 3)
```"""),

    ("feynman", ".feynman-block", r"""```feynman
diagram tree {
  in  e1: $e^-$,  e2: $e^+$
  out m1: $\mu^-$, m2: $\mu^+$
  e1 -- [fermion] a -- [fermion] e2
  a  -- [photon, momentum=$q$] b
  m2 -- [fermion] b -- [fermion] m1
}
```"""),
]


def trim_to_ink(png_path, pad=24):
    """Crop a gallery shot down to its drawn content, plus `pad` device px.

    The captured element is a block, so it spans the full text column however
    small the figure inside it is: display math and a commutative diagram both
    came out as a 1360px-wide strip of mostly empty paper. Trimming makes the
    delivered aspect ratio match the figure, which is what lets the gallery
    grid place them sensibly. A figure that really does fill its box (a table,
    a chart) is unaffected.
    """
    from PIL import Image, ImageChops
    im = Image.open(png_path).convert("RGB")
    bg = Image.new("RGB", im.size, im.getpixel((0, 0)))
    box = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box:
        return                      # uniformly blank: leave it alone, and let it show
    l, t, r, b = box
    im.crop((max(0, l - pad), max(0, t - pad),
             min(im.width, r + pad), min(im.height, b + pad))).save(png_path)


def shoot_gallery(pw, port, wanted):
    """Render each GALLERY snippet on its own page and shoot the one figure."""
    out_dir = os.path.join(OUT_ROOT, "gallery")
    os.makedirs(out_dir, exist_ok=True)
    fixture = os.path.join(REPO_ROOT, "samples", "_gallery_fixture.md")
    written = []

    ctx = pw.new_context(viewport={"width": 1000, "height": 900},
                         device_scale_factor=2, locale="ja-JP")
    page = ctx.new_page()
    page.set_default_timeout(45000)
    page.add_init_script(shoot.style_init_script(None))
    page.add_init_script(shoot.ui_lang_init_script("ja"))
    try:
        for key, sel, snippet in GALLERY:
            if wanted and "gallery" not in wanted and ("gallery:" + key) not in wanted:
                continue
            with open(fixture, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(snippet + "\n")
            page.goto("http://127.0.0.1:%d/index.html?file=%s" % (port, fixture),
                      wait_until="domcontentloaded")
            page.wait_for_function(
                "() => { const p=document.getElementById('preview');"
                " return p && p.children.length>0; }")
            shoot.wait_for_render(page)
            page.wait_for_timeout(500)
            loc = page.locator(sel).first
            try:
                loc.wait_for(state="visible", timeout=35000)
            except Exception:  # noqa: BLE001
                sys.stderr.write("WARN: gallery %s: %r never appeared\n" % (key, sel))
                continue
            dest = os.path.join(out_dir, "%s.png" % key)
            loc.screenshot(path=dest)
            trim_to_ink(dest)
            written.append(dest)
    finally:
        if os.path.exists(fixture):
            os.remove(fixture)
        ctx.close()
    return written


def check_gallery_sources():
    """Warn loudly if index.html no longer shows exactly these snippets."""
    page = os.path.join(REPO_ROOT, "docs", "index.html")
    if not os.path.exists(page):
        return
    with open(page, encoding="utf-8") as fh:
        html = fh.read()

    def esc(t):
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    missing = [k for k, _sel, snip in GALLERY if esc(snip) not in html]
    if missing:
        sys.stderr.write(
            "WARN: docs/index.html does not carry the gallery source for: %s\n"
            "      The <pre> beside each picture must match GALLERY verbatim.\n"
            % ", ".join(missing))


def shoot_og(pw, _port):
    """Render docs/assets/og.html to the 1200x630 social card.

    Rendered rather than hand-drawn so the card uses the page's own typeface
    and palette and cannot drift from it. PNG, not WebP: some link-preview
    scrapers still do not decode WebP.

    Loaded over file:// rather than through the harness -- the harness serves
    the app's own ``assets/`` at the root and knows nothing about ``docs/``.
    Google Fonts still loads, so the type is the page's own.
    """
    src = os.path.join(REPO_ROOT, "docs", "assets", "og.html")
    dest = os.path.join(REPO_ROOT, "docs", "assets", "og.png")
    ctx = pw.new_context(viewport={"width": 1200, "height": 630},
                         device_scale_factor=1, locale="ja-JP")
    page = ctx.new_page()
    page.goto(pathlib.Path(src).as_uri(), wait_until="networkidle")
    page.wait_for_timeout(900)
    page.screenshot(path=dest)
    ctx.close()
    return dest


def to_webp(png_path):
    """Downscale to MAX_EDGE and re-encode as WebP, replacing the PNG."""
    from PIL import Image
    im = Image.open(png_path).convert("RGB")
    if max(im.size) > MAX_EDGE:
        f = MAX_EDGE / float(max(im.size))
        im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
    dest = os.path.splitext(png_path)[0] + ".webp"
    im.save(dest, quality=WEBP_QUALITY, method=6)
    os.remove(png_path)
    return dest


def main():
    ap = argparse.ArgumentParser(description="capture every docs/ landing-page image")
    ap.add_argument("--channel", default=None, help="msedge | chrome (auto-detect)")
    ap.add_argument("--port", type=int, default=8772)
    ap.add_argument("--only", default=None,
                    help="comma-separated shot names to regenerate (default: all)")
    args = ap.parse_args()

    wanted = set(s.strip() for s in args.only.split(",")) if args.only else None

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)

    httpd = shoot.start_harness(args.port, REPO_ROOT, os.path.join(REPO_ROOT, "assets"))
    written = []
    og = None
    try:
        with sync_playwright() as p:
            browser = None
            last_err = None
            for ch in ([args.channel] if args.channel else ["msedge", "chrome", None]):
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
            if browser is None:
                sys.stderr.write("ERROR: could not launch a Chromium browser: %s\n" % last_err)
                sys.exit(3)

            for name, md, style, slides in PREVIEW_SHOTS:
                if wanted and name not in wanted:
                    continue
                written += shoot_preview(browser, args.port, name, md, style, slides)
            for name, md, vim, cells, keys in EDITOR_SHOTS:
                if wanted and name not in wanted:
                    continue
                written += shoot_editor(browser, args.port, name, md, vim, cells, keys)

            if not wanted or any(w == "gallery" or w.startswith("gallery:")
                                 for w in wanted):
                written += shoot_gallery(browser, args.port, wanted)

            og = None
            if not wanted or "og" in wanted:
                og = shoot_og(browser, args.port)

            browser.close()
    finally:
        httpd.shutdown()

    written = [to_webp(w) for w in written]
    if og:
        written.append(og)          # the OG card stays PNG
    for w in written:
        print("%s  %.0f KB" % (os.path.relpath(w, REPO_ROOT),
                               os.path.getsize(w) / 1024))
    check_gallery_sources()

    # The page's other drift check, so whoever regenerates the images hears
    # about both. warn_only because THIS script's exit code means "did the
    # images get written" -- the hard gate is the standalone entry point.
    import docskeycheck
    docskeycheck.report(warn_only=True)


if __name__ == "__main__":
    main()

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
    # Marp: 02 = gradient section divider, 08 = mermaid in a slide,
    # 12 = Plotly 3D surface. Picked off a contact sheet of all 30.
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


if __name__ == "__main__":
    main()

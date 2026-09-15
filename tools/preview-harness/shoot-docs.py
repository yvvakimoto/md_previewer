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
import io
import json
import math
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

# --- the two figures the page shows being dragged with a mouse -------------
#
# model3d and the Plotly 3D surface on Marp slide 12 are both genuinely
# mouse-driven in the app, and both looked like dead stills on the landing
# page. They ship as looping *animated* WebP instead, with a drawn cursor
# sweeping in step with the motion, and `<picture>` hands a reduced-motion
# reader the ordinary still.
#
# The sweep is an OSCILLATION, theta = theta0 + A*sin(2*pi*k/N), not a full
# revolution: it loops seamlessly with no repeated closing frame, it keeps the
# union ink box (and therefore --g-cap) close to what the still already needed
# -- a full turn swings model3d's GridHelper far enough to grow the box by a
# third -- and a hand on a mouse moves back and forth, which is the whole point.
SPIN_FRAMES = 20                # frames per loop; the last phase is NOT emitted
SPIN_DURATION_MS = 90           # per frame => SPIN_FRAMES * this is the period
SPIN_AMPLITUDE_DEG = 50.0       # half the total swing
SPIN_QUALITY = 72
# ⚠ The animation is EXACTLY half the still's pixel size -- 1x CSS px against
# the 2x capture. Not "about half": the two files are swapped by <picture>
# behind one pair of width/height attributes, so any disagreement in aspect
# ratio is a layout shift. Halving is also the biggest byte lever there is, and
# motion hides the softness that would be obvious in a still.
# ⚠ The one encoder flag that actually moves the needle. libwebp's frame-rect
# optimization already reduces each frame to the region that changed, but by
# default it still inserts a full keyframe every kmax frames -- measured on the
# 1600x900 slide, that alone was 282 KB vs 182 KB. kmin=0/kmax=0 turns keyframe
# insertion off, which is what makes animating the WHOLE slide cost barely more
# than animating the plot rectangle alone (~50 KB, one keyframe) and let this
# skip a hand-measured overlay entirely.
SPIN_ENCODE = dict(kmin=0, kmax=0, minimize_size=True, allow_mixed=True,
                   method=6, loop=0)
# ⚠ Do NOT gate on PIL.features.check('webp_anim'): on Pillow 12 it returns
# False with "Unknown feature" (the flag went away when libwebpmux became
# mandatory), so the guard would abort on a perfectly capable install.

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
    # Marp: 08 = mermaid in a slide, 02 = gradient section divider (colour, in
    # the back of the fan). Picked off a contact sheet of all 32.
    # ⚠ Slide 12 -- the two-column KaTeX + Plotly 3D surface that is the FRONT
    # card of the deck fan -- is deliberately absent: it ships as an animation
    # and `shoot_spin_marp` owns both it and its still, so that the two cannot
    # end up with different crops. Regenerate it with `--only spin`.
    # These indices are positional: inserting a slide into samples/marp.md ahead of
    # one of them renumbers it, so re-check after editing that file.
    ("marp",       "samples/marp.md",                  None,        [2, 8]),
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

    # Like kataskeve3d this is a <canvas> bitmap, not SVG. The fixture is written
    # into samples/, so the relative `data/` path resolves to samples/data/.
    ("model3d", ".model3d", r"""```model3d
file: data/bracket.stl
width: 480
height: 320
edges: true
grid: true
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


# Figures whose chrome is hover-revealed, so the shot has to hover them or the
# gallery would advertise an empty gap. ABC's playback bar is opacity:0 until the
# pointer is over the staff (the .copy-button idiom).
_GALLERY_HOVER = {"abc"}


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
            # model3d's picture is an animation, and `shoot_spin_model3d` emits
            # its still from the SAME union box. Re-shooting it here would run
            # the per-frame trim_to_ink() and hand the still a tighter crop
            # than the animation, so the <picture> swap would jump and
            # --g-cap / width / height would go stale. Opt in by name to
            # override.
            if key == "model3d" and ("gallery:model3d" not in (wanted or ())):
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
            if key in _GALLERY_HOVER:
                loc.hover()
                page.wait_for_timeout(400)  # outlast the 0.2s opacity transition
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


# --- spin: the looping "a mouse is doing this" animations -----------------
#
# Both figures are captured the same way the stills are -- the real preview,
# rendering the real engine -- and each pass emits BOTH its still and its
# animation from the same capture, so the two can never disagree about size.
# That co-ownership is load-bearing: `--only gallery` re-running the per-frame
# trim_to_ink() on model3d would hand the still a tighter crop than the
# animation, and the <picture> swap would jump.

SPIN_SLIDE = 12                 # samples/marp.md's Plotly 3D surface slide

# Hotspot at (32,32) so the caller positions the pointer TIP, not a corner.
# The ring is the "button is held" tell; it is on for every frame because the
# capture really does hold the button down for the whole loop.
_SPIN_CURSOR_JS = r"""
(host, a) => {
  const old = host.querySelector(':scope > .__spin-cursor');
  if (a.hide) { if (old) old.remove(); return; }
  let ov = old;
  if (!ov) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    ov = document.createElement('div');
    ov.className = '__spin-cursor';
    ov.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;' +
                       'z-index:9999;pointer-events:none;';
    ov.innerHTML =
      '<svg width="' + a.size + '" height="' + a.size + '" viewBox="0 0 64 64" ' +
          'style="position:absolute;left:0;top:0;overflow:visible;' +
          'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
        '<circle cx="32" cy="32" r="15" fill="rgba(40,110,245,.20)" ' +
            'stroke="rgba(40,110,245,.60)" stroke-width="2.5"/>' +
        '<path d="M32 32 L32 55.1 L37.9 49.8 L41.7 58.2 L45.9 56.2 L42.1 48 ' +
            'L50.2 47.5 Z" fill="#fff" stroke="#111" stroke-width="2.2" ' +
            'stroke-linejoin="round"/>' +
      '</svg>';
    host.appendChild(ov);
  }
  ov.firstChild.style.transform =
    'translate(' + (a.x - a.size / 2) + 'px,' + (a.y - a.size / 2) + 'px)';
}
"""


def _spin_cursor(loc, x=0, y=0, size=64, hide=False):
    loc.evaluate(_SPIN_CURSOR_JS, {"x": x, "y": y, "size": size, "hide": hide})


def _spin_phase(k):
    """sin() of the k-th frame's phase. k == SPIN_FRAMES would repeat k == 0."""
    return math.sin(2.0 * math.pi * k / SPIN_FRAMES)


def _image(png_bytes):
    from PIL import Image
    return Image.open(io.BytesIO(png_bytes)).convert("RGB")


def _even(n):
    return n - (n % 2)


def _to_even(im):
    """Crop a trailing row/column so halving the image is exact.

    The still and the animation must share an aspect ratio to the pixel, or
    the <picture> swap shifts the layout; the animation is emitted at exactly
    half the still, so both extents have to be even.
    """
    w, h = _even(im.width), _even(im.height)
    return im if (w, h) == im.size else im.crop((0, 0, w, h))


def _fit_max_edge(im):
    from PIL import Image
    if max(im.size) > MAX_EDGE:
        f = MAX_EDGE / float(max(im.size))
        im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
    return _to_even(im)


def union_ink_box(frames, pad=24):
    """trim_to_ink()'s multi-frame sibling: ONE box that fits every frame.

    Cropping each frame to its own ink makes the figure jitter inside the
    animation, so the box is the union and every frame gets the same one. The
    extent is forced even for the exact-half rule in _to_even().
    """
    from PIL import Image, ImageChops
    boxes = []
    for im in frames:
        bg = Image.new("RGB", im.size, im.getpixel((0, 0)))
        box = ImageChops.difference(im, bg).convert("L").point(
            lambda v: 255 if v > 8 else 0).getbbox()
        if box:
            boxes.append(box)
    if not boxes:
        return None
    w, h = frames[0].size
    l = max(0, min(b[0] for b in boxes) - pad)
    t = max(0, min(b[1] for b in boxes) - pad)
    r = min(w, max(b[2] for b in boxes) + pad)
    b = min(h, max(b[3] for b in boxes) + pad)
    return (l, t, l + _even(r - l), t + _even(b - t))


def encode_spin(frames, dest):
    """Write the frame list as one looping animated WebP.

    Tries lossy and lossless and keeps whichever is smaller -- flat-shaded
    geometry on white is exactly the content where lossless can win, and a
    photographic-ish Plotly surface is exactly where it cannot.
    """
    if len({f.tobytes() for f in frames}) < 2:
        raise RuntimeError(
            "every spin frame is identical -- the figure never moved. "
            "A headless browser with no WebGL2 renders model3d as an error "
            "box (see shoot.py's warning); check that first.")
    best, best_kind = None, None
    for lossless in (False, True):
        kw = dict(SPIN_ENCODE)
        if lossless:
            kw.pop("allow_mixed", None)     # allow_mixed requires lossless=False
        buf = io.BytesIO()
        frames[0].save(buf, format="WEBP", save_all=True,
                       append_images=frames[1:], duration=SPIN_DURATION_MS,
                       lossless=lossless,
                       quality=(80 if lossless else SPIN_QUALITY), **kw)
        blob = buf.getvalue()
        sys.stderr.write("      %-8s %6.0f KB\n"
                         % ("lossless" if lossless else "lossy", len(blob) / 1024))
        if best is None or len(blob) < len(best):
            best, best_kind = blob, ("lossless" if lossless else "lossy")
    with open(dest, "wb") as fh:
        fh.write(best)
    sys.stderr.write("      -> %s (%s)\n" % (os.path.basename(dest), best_kind))
    return dest


def _gallery_snippet(key):
    """The canonical GALLERY source for `key`, never a second copy of it."""
    for k, _sel, snip in GALLERY:
        if k == key:
            return snip
    raise KeyError(key)


def shoot_spin_model3d(browser, port):
    """Drag the real model3d canvas with the real mouse, frame by frame.

    OrbitControls is attached whenever ``interactive`` is true, which it is
    outside --export-png, so this is a genuine drag rather than a re-render at
    a scripted camera angle: the cursor drawn into the frame is at the exact
    coordinate the pointer was at. three's rotateLeft is
    ``2*pi * dx / domElement.clientHeight`` at rotateSpeed 1, so a horizontal
    drag of ``clientHeight * deg/360`` CSS px is exactly ``deg`` of yaw.
    """
    out_dir = os.path.join(OUT_ROOT, "gallery")
    os.makedirs(out_dir, exist_ok=True)
    fixture = os.path.join(REPO_ROOT, "samples", "_spin_fixture.md")
    ctx = browser.new_context(viewport={"width": 1000, "height": 900},
                              device_scale_factor=2, locale="ja-JP")
    page = ctx.new_page()
    page.set_default_timeout(45000)
    page.add_init_script(shoot.style_init_script(None))
    page.add_init_script(shoot.ui_lang_init_script("ja"))
    try:
        with open(fixture, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(_gallery_snippet("model3d") + "\n")
        page.goto("http://127.0.0.1:%d/index.html?file=%s" % (port, fixture),
                  wait_until="domcontentloaded")
        page.wait_for_function(
            "() => { const p=document.getElementById('preview');"
            " return p && p.children.length>0; }")
        shoot.wait_for_render(page)
        page.wait_for_timeout(500)

        block = page.locator(".model3d").first
        canvas = page.locator(".model3d canvas").first
        canvas.wait_for(state="visible", timeout=35000)
        still = _image(block.screenshot())

        geo = canvas.evaluate(
            "(c) => { const r = c.getBoundingClientRect();"
            " const b = c.closest('.model3d').getBoundingClientRect();"
            " return {x:r.x, y:r.y, w:r.width, h:r.height, bx:b.x, by:b.y}; }")
        span = geo["h"] * SPIN_AMPLITUDE_DEG / 360.0
        cx = geo["x"] + geo["w"] / 2.0
        # Low in the canvas on purpose: OrbitControls rotates from anywhere, and
        # down here the pointer rides the pale floor grid instead of vanishing
        # into the model's own mid-grey.
        cy = geo["y"] + geo["h"] * 0.76

        frames = []
        page.mouse.move(cx, cy)
        page.mouse.down()
        try:
            for k in range(SPIN_FRAMES):
                dx = span * _spin_phase(k)
                page.mouse.move(cx + dx, cy)
                _spin_cursor(block, x=(cx + dx) - geo["bx"], y=cy - geo["by"],
                             size=72)
                # enableDamping is false, so the pose is final once the
                # 'change' listener's scheduleRender() has run (rAF, or its
                # 50 ms timeout fallback).
                page.wait_for_timeout(120)
                frames.append(_image(block.screenshot()))
        finally:
            page.mouse.up()
    finally:
        if os.path.exists(fixture):
            os.remove(fixture)
        ctx.close()

    box = union_ink_box(frames)
    if box:
        frames = [f.crop(box) for f in frames]
        still = still.crop(box)
    still, frames = _to_even(still), [_to_even(f) for f in frames]

    still_path = os.path.join(out_dir, "model3d.webp")
    still.save(still_path, quality=WEBP_QUALITY, method=6)
    half = (still.width // 2, still.height // 2)
    from PIL import Image
    spin_path = encode_spin([f.resize(half, Image.LANCZOS) for f in frames],
                            os.path.join(out_dir, "model3d-spin.webp"))
    return [still_path, spin_path]


def shoot_spin_marp(browser, port):
    """Orbit slide 12's Plotly camera, shooting the whole slide each frame.

    The camera is driven with Plotly.relayout rather than a synthetic drag:
    the angle is then exact, which is what makes the loop close seamlessly.
    ⚠ fitMarpSlides() ends in __resizePlotlyBlocks() -> Plotly.Plots.resize, so
    it is called ONCE, before the orbit -- never inside the loop.
    """
    md = os.path.join(REPO_ROOT, "samples", "marp.md")
    out_dir = os.path.join(OUT_ROOT, "marp")
    os.makedirs(out_dir, exist_ok=True)
    ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=2,
                              locale="ja-JP")
    page = ctx.new_page()
    page.set_default_timeout(45000)
    page.add_init_script(shoot.style_init_script(None))
    page.add_init_script(shoot.ui_lang_init_script("ja"))
    try:
        page.goto("http://127.0.0.1:%d/index.html?file=%s" % (port, md),
                  wait_until="domcontentloaded")
        page.wait_for_function(
            "() => { const p=document.getElementById('preview');"
            " return p && p.children.length>0; }")
        shoot.wait_for_render(page)
        page.wait_for_timeout(600)
        page.wait_for_function(
            "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length > 0")
        page.evaluate("() => { try { if (window.fitMarpSlides) fitMarpSlides(); } catch(e){} }")
        page.wait_for_timeout(300)

        svg = page.locator("div.marpit > svg[data-marpit-svg]").nth(SPIN_SLIDE - 1)
        # samples/marp.md has a second plotly block (the P&L line chart a few
        # slides earlier), so the graph div is looked up INSIDE this slide.
        gd = svg.locator(".plotly-block.js-plotly-plot").first
        gd.wait_for(state="visible", timeout=35000)
        still = _image(svg.screenshot())

        size = gd.evaluate("(g) => ({w: g.offsetWidth, h: g.offsetHeight})")
        # Keep the radius the sample authored (eye 1.5,1.5,0.75) and swing the
        # azimuth around it; `up` and `center` are left alone.
        r = math.hypot(1.5, 1.5)
        frames = []
        for k in range(SPIN_FRAMES):
            th = math.radians(45.0 + SPIN_AMPLITUDE_DEG * _spin_phase(k))
            gd.evaluate(
                "async (g, e) => { await window.Plotly.relayout("
                "g, {'scene.camera.eye': {x: e.x, y: e.y, z: e.z}}); }",
                {"x": r * math.cos(th), "y": r * math.sin(th), "z": 0.75})
            _spin_cursor(gd, x=size["w"] * (0.5 + 0.20 * _spin_phase(k)),
                         y=size["h"] * 0.55, size=84)
            # relayout resolves before the gl3d scene is composited.
            page.wait_for_timeout(140)
            frames.append(_image(svg.screenshot()))
    finally:
        ctx.close()

    still = _fit_max_edge(still)
    frames = [_fit_max_edge(f) for f in frames]
    still_path = os.path.join(out_dir, "slide-%02d.webp" % SPIN_SLIDE)
    still.save(still_path, quality=WEBP_QUALITY, method=6)
    half = (still.width // 2, still.height // 2)
    from PIL import Image
    spin_path = encode_spin([f.resize(half, Image.LANCZOS) for f in frames],
                            os.path.join(out_dir, "slide-%02d-spin.webp" % SPIN_SLIDE))
    return [still_path, spin_path]


def main():
    ap = argparse.ArgumentParser(description="capture every docs/ landing-page image")
    ap.add_argument("--channel", default=None, help="msedge | chrome (auto-detect)")
    ap.add_argument("--port", type=int, default=8772)
    ap.add_argument("--only", default=None,
                    help="comma-separated shot names to regenerate (default: all "
                         "EXCEPT spin; ask for spin | spin:model3d | spin:marp "
                         "by name)")
    args = ap.parse_args()

    wanted = set(s.strip() for s in args.only.split(",")) if args.only else None

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)

    httpd = shoot.start_harness(args.port, REPO_ROOT, os.path.join(REPO_ROOT, "assets"))
    written = []
    spun = []                   # already WebP; must not go through to_webp()
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

            # ⚠ Opt-in ONLY, unlike every other pass. An animated WebP is
            # re-encoded byte-differently on every run, so folding it into the
            # default sweep would add its full size to the repository each time
            # anyone regenerates a screenshot, for no visible change.
            if wanted:
                if "spin" in wanted or "spin:model3d" in wanted:
                    spun += shoot_spin_model3d(browser, args.port)
                if "spin" in wanted or "spin:marp" in wanted:
                    spun += shoot_spin_marp(browser, args.port)

            browser.close()
    finally:
        httpd.shutdown()

    written = [to_webp(w) for w in written] + spun
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

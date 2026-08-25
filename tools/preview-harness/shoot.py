#!/usr/bin/env python3
"""Pixel capture for the preview-harness (Playwright headless browser).

Renders a `.md` in the *real* ``assets/index.html`` (served by the in-process
preview-harness) inside a headless system browser (Edge/Chrome), then writes
PNG file(s) that an AI agent can ``Read``. Unlike the in-app Browser pane's
``computer{screenshot}`` (which can time out) and unlike in-page SVG->canvas
rasterization (which cannot load external images/fonts), a real headless
browser paints normally — fonts, ``/userfile/`` images, KaTeX, mermaid, Marp
autofit all render exactly as in the app.

  Marp deck  -> slide-NN.png per (selected) slide + layout.json (overflow/fit)
  normal doc -> page.png (full scrollable page)

Usage:
    python tools/preview-harness/shoot.py <file.md> [--out DIR] [--slides 1,3,5-7]
                                          [--scale 2] [--channel msedge|chrome]
                                          [--full] [--port 8771]

Requires: playwright (module) + a system Chromium browser (Edge or Chrome).
No `playwright install` needed — we launch the installed browser via --channel.
Stdlib + playwright only.
"""

import argparse
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

# Import the harness server (same directory) so we can serve index.html in-process.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402


def parse_slides_spec(spec, count):
    """1-based '1,3,5-7' -> deduped, order-preserving 0-based indices.
    None/empty -> all. Mirrors parse_slides_spec in src/main.rs."""
    if not spec:
        return list(range(count))
    out, seen = [], set()
    for tok in spec.split(","):
        tok = tok.strip()
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-", 1)
            try:
                a, b = int(a), int(b)
            except ValueError:
                continue
            if b < a:
                a, b = b, a
            rng = range(a, b + 1)
        else:
            try:
                rng = [int(tok)]
            except ValueError:
                continue
        for n in rng:
            idx = n - 1
            if 0 <= idx < count and idx not in seen:
                seen.add(idx)
                out.append(idx)
    return out


# JS predicate: every async figure (mermaid / markwhen / abc / plotly / tikz)
# has either produced its output or an error block. networkidle only means the
# *scripts* loaded — the renderers run afterwards, so we must wait on the DOM
# result.
#
# The tikz arm mirrors `__tikzAwait`'s `done()` in assets/index.html rather than
# testing for a bare <svg>: while a block is compiling, tikzjax parks an
# `<svg class="tikzjax-loader">` spinner inside a `.tikzjax-wrapper.tikzjax-loading`,
# so `querySelector('svg')` is satisfied by the UNFINISHED state. Keying off the
# wrapper losing `tikzjax-loading` also resolves a FAILED compile immediately
# (tikzjax swaps in a broken-image placeholder, no svg) instead of waiting out
# index.html's 30s render timeout.
_FIGURES_READY_JS = """() => {
  const done = (sel, ok) => [...document.querySelectorAll(sel)].every(ok);
  const mer = done('.mermaid', m => m.querySelector('svg') || m.querySelector('.mermaid-error'));
  const mw  = done('.markwhen-timeline', m => m.querySelector('svg') || m.querySelector('.markwhen-error'));
  const abc = done('.abc-notation', m => m.querySelector('svg') || m.querySelector('.abc-error'));
  const pl  = done('.plotly-block', m => m.querySelector('.plotly') || m.querySelector('.plotly-error'));
  const tkz = done('.tikzcd-diagram, .tikz-diagram', m => {
    if (m.querySelector('.tikz-error')) return true;
    const w = m.querySelector('.tikzjax-wrapper');
    if (w) return !w.classList.contains('tikzjax-loading');
    return !!m.querySelector('svg:not(.tikzjax-loader)');
  });
  return mer && mw && abc && pl && tkz;
}"""

_TIKZ_SELECTOR_JS = "() => !!document.querySelector('.tikzcd-diagram, .tikz-diagram')"

# A tikz block compiles TeX in a WASM Web Worker and is deliberately
# fire-and-forget (see CLAUDE.md), so it takes seconds — and a block that never
# settles only resolves once index.html's own 30s __TIKZ_RENDER_TIMEOUT_MS swaps
# in a .tikz-error. The page default (20s) cannot see that resolution, so a page
# carrying tikz blocks gets its own budget.
_TIKZ_WAIT_MS = 45000


STYLE_INIT_JS = """(() => { try { %s } catch (e) {} })()"""


def style_init_script(style):
    """Pick the user style the way the S-key picker does: localStorage.styleName.

    The harness has no Rust host and no S-key modal, so this is the only way a
    capture can target bunko.css / tategaki.css -- and those are exactly the
    themes whose layout is worth a pixel baseline.
    """
    if not style or style.lower() in ("default", "none", ""):
        return STYLE_INIT_JS % "localStorage.removeItem('styleName');"
    return STYLE_INIT_JS % ("localStorage.setItem('styleName', %s);" % json.dumps(style))


def wait_for_render(page):
    """Wait for async figures to finish, then for layout height to stabilize."""
    try:
        has_tikz = page.evaluate(_TIKZ_SELECTOR_JS)
    except Exception:  # noqa: BLE001
        has_tikz = False
    try:
        page.wait_for_function(_FIGURES_READY_JS,
                               timeout=_TIKZ_WAIT_MS if has_tikz else None)
    except Exception:  # noqa: BLE001
        pass  # best effort; a figure that never resolves shouldn't block capture
    # Stabilize: poll #preview extent until two reads match (fonts/figures settled).
    # BOTH axes, because a vertical-writing theme grows horizontally -- and because
    # paginatePreview() widens the flow by one gutter per page once the user
    # stylesheet has landed, which a height-only probe cannot see.
    prev = None
    for _ in range(20):
        wh = page.evaluate(
            "() => { const p=document.getElementById('preview');"
            " return p ? [p.scrollWidth, p.scrollHeight] : [0, 0]; }")
        if wh == prev:
            break
        prev = wh
        page.wait_for_timeout(150)


def start_harness(port, repo_root, assets_dir):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.Handler)
    httpd.repo_root = repo_root
    httpd.assets_dir = assets_dir
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def main():
    ap = argparse.ArgumentParser(description="preview-harness pixel capture (Playwright)")
    ap.add_argument("file", help="path to the .md to render")
    ap.add_argument("--out", default=None, help="output dir (default: <cwd>/_shots)")
    ap.add_argument("--slides", default=None, help="1-based slide spec, Marp only (e.g. 1,3,5-7)")
    ap.add_argument("--scale", type=float, default=2.0, help="device scale factor (default 2)")
    ap.add_argument("--channel", default=None, help="browser channel: msedge | chrome (auto-detect)")
    ap.add_argument("--full", action="store_true", help="non-Marp: capture full page incl. sidebar")
    ap.add_argument("--style", default=None,
                    help="user style to apply, e.g. bunko.css (default: the built-in style)")
    ap.add_argument("--port", type=int, default=8771, help="in-process harness port (default 8771)")
    ap.add_argument("--timeout", type=int, default=20000, help="per-step timeout ms (default 20000)")
    args = ap.parse_args()

    md_path = os.path.abspath(args.file)
    if not os.path.isfile(md_path):
        sys.stderr.write("ERROR: file not found: %s\n" % md_path)
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")
    out_dir = os.path.abspath(args.out) if args.out else os.path.join(os.getcwd(), "_shots")
    os.makedirs(out_dir, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)

    httpd = start_harness(args.port, repo_root, assets_dir)
    url = "http://127.0.0.1:%d/index.html?file=%s" % (args.port, md_path)

    written = []
    try:
        with sync_playwright() as p:
            channels = [args.channel] if args.channel else ["msedge", "chrome", None]
            browser = None
            last_err = None
            for ch in channels:
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
            if browser is None:
                sys.stderr.write("ERROR: could not launch a Chromium browser: %s\n" % last_err)
                sys.exit(3)

            ctx = browser.new_context(
                viewport={"width": 1440, "height": 900},
                device_scale_factor=args.scale,
            )
            page = ctx.new_page()
            page.set_default_timeout(args.timeout)
            page.add_init_script(style_init_script(args.style))
            # domcontentloaded, not networkidle: decks with video / YouTube embeds
            # keep the network busy forever, so networkidle never fires.
            page.goto(url, wait_until="domcontentloaded")
            # The bootstrap loads the doc after DOMContentLoaded; wait for content.
            page.wait_for_function(
                "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }"
            )

            is_marp = page.evaluate("() => document.body.classList.contains('marp')")

            if is_marp:
                page.wait_for_function(
                    "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length > 0"
                )
                # Let async figures (mermaid/plotly/markwhen/KaTeX) settle, then re-fit.
                wait_for_render(page)
                page.evaluate("() => { try { if (window.fitMarpSlides) fitMarpSlides(); } catch(e){} }")
                page.wait_for_timeout(150)

                count = page.evaluate(
                    "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length"
                )
                report = page.evaluate("() => window.__marpFitReport || []")
                indices = parse_slides_spec(args.slides, count)
                if not indices:
                    sys.stderr.write("ERROR: --slides selected no valid slides (deck has %d)\n" % count)
                    sys.exit(4)

                svgs = page.locator("div.marpit > svg[data-marpit-svg]")
                layouts = []
                for idx in indices:
                    name = "slide-%02d.png" % (idx + 1)
                    dest = os.path.join(out_dir, name)
                    svgs.nth(idx).screenshot(path=dest)
                    written.append(dest)
                    m = report[idx] if idx < len(report) else {}
                    layouts.append({
                        "index": idx + 1,
                        "file": name,
                        "overflow": bool(m.get("overflow", False)),
                        "scale": m.get("scale", 1),
                        "flooredAtMin": bool(m.get("flooredAtMin", False)),
                        "contentH": m.get("contentH", 0),
                        "avail": m.get("avail", 0),
                    })
                layout_path = os.path.join(out_dir, "layout.json")
                with open(layout_path, "w", encoding="utf-8") as fh:
                    json.dump({"marp": True, "slides": layouts}, fh, indent=2, ensure_ascii=False)
                written.append(layout_path)
            else:
                # Non-Marp: let async figures settle, then capture.
                wait_for_render(page)
                # The app shell scrolls an inner container (#preview-container,
                # overflow:auto, viewport height); #preview is taller and gets
                # visually CLIPPED. Neutralize every overflow-clipping ancestor so
                # the page body grows to full content height and nothing is blank.
                # (This is the same clip that causes the real --export-png blank tail.)
                page.evaluate("""() => {
                  let n = document.getElementById('preview');
                  while (n && n !== document.body) {
                    n.style.overflow = 'visible';
                    n.style.overflowY = 'visible';
                    n.style.height = 'auto';
                    n.style.maxHeight = 'none';
                    n = n.parentElement;
                  }
                  document.documentElement.style.height = 'auto';
                  document.body.style.height = 'auto';
                }""")
                page.wait_for_timeout(120)
                dest = os.path.join(out_dir, "page.png")
                if args.full:
                    page.screenshot(path=dest, full_page=True)
                else:
                    page.locator("#preview").screenshot(path=dest)
                written.append(dest)
                layout_path = os.path.join(out_dir, "layout.json")
                with open(layout_path, "w", encoding="utf-8") as fh:
                    json.dump({"marp": False, "slides": []}, fh, indent=2)
                written.append(layout_path)

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    for w in written:
        print(w)


if __name__ == "__main__":
    main()

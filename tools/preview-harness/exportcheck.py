#!/usr/bin/env python3
"""End-to-end check for the `X` → standalone HTML export (preview-harness).

The artifact is built by ``buildExportArtifact()`` in the page, so the whole
contract is reachable from a headless browser with no Rust host and no native
Save dialog: build the HTML in the live page, then LOAD IT BACK and compare what
it renders against what the preview renders.

Loading it back is the point. Everything this catches is a case where the HTML
is produced without error and merely renders differently — the export inlines
the theme's text into a <style>, so a stylesheet that relies on anything
resolved relative to its own URL quietly stops working:

  * bunko.css is `@import url("tategaki.css")` plus overrides. In the artifact
    that relative import resolved against the ARTIFACT's location, 404'd, and
    the entire vertical-writing base was lost — the export came out horizontal
    while every bunko-owned property (字数, 行数, ノンブル) still looked right,
    which is exactly why it went unnoticed.

The artifact is served back through Playwright's request interception, so
nothing is written to disk.

Usage:
    python tools/preview-harness/exportcheck.py [--channel msedge|chrome]

Requires: playwright (module) + a system Chromium (Edge/Chrome).
"""

import argparse
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402
import shoot  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

FAILURES = []
CHECKS = 0

ARTIFACT_PATH = "/__artifact.html"


def check(label, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s %s" % (label, detail))
        FAILURES.append(label)


# Properties that must survive the round trip. Deliberately a mix of what the
# theme itself owns and what it inherits from a theme it imports.
PROBE = """() => {
  const p = document.getElementById('preview');
  if (!p) return null;
  const cs = getComputedStyle(p);
  const first = p.querySelector(':scope > .md-page');
  return {
    writingMode: cs.writingMode,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    height: cs.height,
    textOrientation: cs.textOrientation,
    pageLines: (cs.getPropertyValue('--md-page-lines') || '').trim(),
    pages: p.querySelectorAll(':scope > .md-page').length,
    breaks: p.querySelectorAll(':scope > .md-page-break').length,
    nombre: first ? getComputedStyle(first, '::after').display : null,
    // Ruby: the annotation must survive as real markup AND keep its computed size --
    // the #preview rt rules live in the document's first <style>, which is what the
    // artifact inlines, so a change to how that block is snapshotted shows up here.
    rubyCount: p.querySelectorAll('ruby').length,
    rtCount: p.querySelectorAll('rt').length,
    rtFontSize: (() => { const rt = p.querySelector('rt');
                         return rt ? getComputedStyle(rt).fontSize : null; })(),
    rtPosition: (() => { const r = p.querySelector('ruby');
                         return r ? getComputedStyle(r).rubyPosition : null; })(),
    // bunko cancels the annotation's line-box reservation here; if that margin is lost
    // in the artifact, the 行取り grid silently drifts and `pages` above moves with it.
    rtMarginBlockStart: (() => { const rt = p.querySelector('rt');
                                 return rt ? getComputedStyle(rt).marginBlockStart : null; })(),
  };
}"""

# The ruby run is load-bearing, not decoration: <ruby> is the one inline element whose
# annotation reserves space outside the line box, so it is the thing most likely to make
# an exported bunko artifact paginate differently from the preview it was built from.
VERTICAL_MD = "# 縦組みの書き出し\n\n" + "".join(
    "## 第%d節\n\n%s\n\n%s\n\n" % (
        i + 1,
        "この文書は書き出したあとも縦組みのままでなければならない。" * 8,
        "｜雪国《ゆきぐに》の冬は朝が遅く、｜炉端《ろばた》では湯が沸いている。" * 4)
    for i in range(4))

PLAIN_MD = "# 横組みの文書\n\n本文本文本文。\n\n## 見出し\n\nもう少し本文。\n"


def start_harness(port, repo_root, assets_dir):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.Handler)
    httpd.repo_root = repo_root
    httpd.assets_dir = assets_dir
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def run_style(browser, base_url, doc, style, vertical):
    """Build the artifact under `style`, load it back, and diff the two."""
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.set_default_timeout(20000)
    page.add_init_script(shoot.style_init_script(style))
    page.goto(base_url + doc, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }")
    if vertical:
        page.wait_for_function(
            "() => /^vertical/.test(getComputedStyle(document.getElementById('preview')).writingMode)")
    page.wait_for_timeout(400)

    live = page.evaluate(PROBE)
    html = page.evaluate("async () => (await buildExportArtifact({})).html")

    # Serve the artifact back without touching the filesystem.
    failed = []
    page2 = ctx.new_page()
    page2.set_default_timeout(20000)
    page2.route("**" + ARTIFACT_PATH,
                lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))
    page2.on("requestfailed", lambda r: failed.append(r.url))
    page2.goto(base_url.split("/index.html")[0] + ARTIFACT_PATH, wait_until="load")
    page2.wait_for_timeout(400)
    art = page2.evaluate(PROBE)

    label = style or "既定"
    print("\n[%s]" % label)
    check("the artifact renders a #preview", art is not None, art)
    if art is None:
        ctx.close()
        return
    for key in ("writingMode", "textOrientation", "fontFamily", "fontSize",
                "lineHeight", "height", "pageLines", "pages", "breaks", "nombre",
                "rubyCount", "rtCount", "rtFontSize", "rtPosition", "rtMarginBlockStart"):
        check("%s survives the export (%s)" % (key, json.dumps(live[key], ensure_ascii=False)),
              art[key] == live[key], "artifact=%s" % json.dumps(art[key], ensure_ascii=False))
    # An unresolved relative @import is the failure this file exists for: it
    # produces no error, just a stylesheet that does half its job.
    check("no unresolved relative @import is left in the artifact",
          "@import" not in html or "url(\"tategaki.css\")" not in html,
          "found a bare relative @import")
    check("the artifact requests nothing that fails", not failed, failed[:3])
    ctx.close()


def main():
    ap = argparse.ArgumentParser(description="HTML export fidelity check (preview-harness)")
    ap.add_argument("--channel", default=None, help="browser channel: msedge | chrome")
    ap.add_argument("--port", type=int, default=8774)
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")

    import tempfile
    tmp = tempfile.mkdtemp(prefix="mdp-exportcheck-")
    vertical = os.path.join(tmp, "vertical.md")
    plain = os.path.join(tmp, "plain.md")
    for path, body in ((vertical, VERTICAL_MD), (plain, PLAIN_MD)):
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

            # bunko.css is the regression case: it imports tategaki.css.
            run_style(browser, base, vertical, "bunko.css", True)
            run_style(browser, base, vertical, "tategaki.css", True)
            run_style(browser, base, plain, "parchment.css", False)
            run_style(browser, base, plain, None, False)

            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print("\n%d checks, %d failed" % (CHECKS, len(FAILURES)))
    if FAILURES:
        for f in FAILURES:
            print("  - %s" % f)
        sys.exit(1)


if __name__ == "__main__":
    main()

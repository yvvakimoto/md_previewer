#!/usr/bin/env python3
"""Structural DOM digest for the preview-harness — a regression net for refactors.

``shoot.py`` gives pixels; this gives *structure*. A behavior-preserving refactor
of the render pipeline in ``assets/index.html`` must not change the shape of the
rendered ``#preview`` tree, so: dump a normalized digest before the change, dump
it again after, and ``git diff --no-index`` the two directories. An empty diff is
the pass condition.

Each element becomes one line::

    <indent><tag>[.class.class][ attr=value ...]  |text

Normalizations (all required for run-to-run stability):
  * ``<svg>`` / ``<canvas>`` subtrees collapse to a single node — mermaid, KaTeX
    MathML, abcjs, markwhen and plotly embed randomized ids and float coords.
    Marp's ``svg[data-marpit-svg]`` is NOT collapsed: it is a layout container,
    and every slide's content lives under it via ``<foreignObject><section>``.
  * ids matching ``^(mermaid|plotly|abc|markwhen)-`` are elided (render counters).
  * whitespace is collapsed; empty text nodes are dropped.
  * numbers inside ``style`` are rounded (see ``--round``) so sub-pixel layout
    jitter does not mask a real change. ``style`` is otherwise kept VERBATIM —
    the inline styled-span pass and the Marp autofit both write into it.
  * long attribute values and long text (source payloads, the injected marp-core
    stylesheet) are replaced by ``#<len>:<sha1-8>``.

Usage::

    python tools/preview-harness/domdump.py <file.md> [more.md ...] --out DIR
                     [--modes scroll,deck,list] [--dark] [--channel msedge|chrome]

Requires: playwright (module) + a system Chromium browser (Edge or Chrome).
No `playwright install` needed — we launch the installed browser via --channel.
Stdlib + playwright only.
"""

import argparse
import hashlib
import os
import re
import sys
import threading
from http.server import ThreadingHTTPServer

# Import the harness server + the shared render-wait helpers (same directory).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402
import shoot  # noqa: E402

# Attribute values / text longer than these are hashed rather than inlined.
_ATTR_INLINE_MAX = 64
_TEXT_INLINE_MAX = 200

# Number inside a `style` value, e.g. `704.328` in `max-width:704.328px`.
_STYLE_NUM_RE = re.compile(r"\d+\.\d+")

# Emitted by the browser; kept here so the whole walk happens in one round-trip.
_DIGEST_JS = r"""(opts) => {
  // Generated-graphics roots are opaque (randomized ids, float coords). Marp's
  // own svg[data-marpit-svg] is a LAYOUT container — descend into it, or every
  // slide's content would be discarded.
  const isOpaque = (el, tag) =>
    (tag === 'svg' && !el.hasAttribute('data-marpit-svg')) || tag === 'canvas';
  // Render-counter ids (mermaid-3, plotly-1, ...) change with render order;
  // Plotly's modebar-<hex> is freshly randomized on every single render.
  const VOLATILE_ID = /^(mermaid|plotly|abc|markwhen|modebar)-/;
  // Recorded in this order so the digest column layout is stable.
  const ATTRS = ['id', 'data-line', 'data-fn-id', 'data-marp-slide', 'data-target',
                 'data-footnote-id', 'data-marpit-svg', 'data-abc', 'colspan',
                 'rowspan', 'type', 'href', 'src', 'alt', 'style'];
  const out = [];

  const basename = (v) => {
    try { return v.split(/[\\/]/).pop() || v; } catch (e) { return v; }
  };

  const attrVal = (el, name) => {
    if (!el.hasAttribute(name)) return null;
    let v = el.getAttribute(name);
    if (name === 'id' && VOLATILE_ID.test(v)) return null;
    // A url keeps only its last segment: absolute paths differ per machine.
    if (name === 'href' || name === 'src') {
      if (/^(data|blob):/.test(v)) return v.slice(0, 24) + '...';
      v = basename(v);
    }
    return v;
  };

  const walk = (node, depth) => {
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    const cls = [...node.classList].sort().join('.');
    const parts = [];
    for (const a of ATTRS) {
      const v = attrVal(node, a);
      if (v !== null) parts.push(a + '=' + v);
    }
    // Direct text children only — descendants contribute their own lines.
    let text = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) text += c.nodeValue;
    }
    text = text.replace(/\s+/g, ' ').trim();

    out.push({ d: depth, tag: tag, cls: cls, attrs: parts, text: text });

    if (isOpaque(node, tag)) return;   // do not descend
    for (const c of node.children) walk(c, depth + 1);
  };

  const root = document.getElementById('preview');
  if (root) for (const c of root.children) walk(c, 0);

  // Body classes drive theme / layout / marp mode, so they are part of the state.
  const body = [...document.body.classList].sort().join(' ');
  let sidebar = '';
  if (opts && opts.sidebar) {
    const sb = document.getElementById('toc-sidebar');
    sidebar = sb ? sb.innerText.replace(/\s+/g, ' ').trim() : '';
  }
  return { nodes: out, body: body, sidebar: sidebar };
}"""


def _round_numbers(value, places):
    """Round every decimal number in `value` so sub-pixel jitter is not a diff."""
    return _STYLE_NUM_RE.sub(lambda m: ("%.*f" % (places, float(m.group(0)))), value)


def _shorten(value, limit):
    """Replace an over-long value with a length+hash stand-in: still change-detecting."""
    if len(value) <= limit:
        return value
    return "#%d:%s" % (len(value), hashlib.sha1(value.encode("utf-8")).hexdigest()[:8])


def _fmt_attr(part, places):
    name, _, value = part.partition("=")
    if name == "style":
        value = _round_numbers(value, places)
    return "%s=%s" % (name, _shorten(value, _ATTR_INLINE_MAX))


def render_digest(payload, places):
    """Turn the browser payload into the stable, diffable text form."""
    lines = ["@body %s" % payload.get("body", "")]
    if payload.get("sidebar"):
        lines.append("@sidebar %s" % payload["sidebar"])
    for n in payload["nodes"]:
        head = n["tag"]
        if n["cls"]:
            head += "." + n["cls"]
        attrs = " ".join(_fmt_attr(a, places) for a in n["attrs"])
        line = "%s%s" % ("  " * n["d"], head)
        if attrs:
            line += " " + attrs
        if n["text"]:
            line += "  |" + _shorten(n["text"], _TEXT_INLINE_MAX)
        lines.append(line)
    return "\n".join(lines) + "\n"


def slug_for(repo_root, md_path, mode, dark, style=None):
    """Stable output filename derived from the doc's repo-relative path."""
    try:
        rel = os.path.relpath(md_path, repo_root)
    except ValueError:
        rel = os.path.basename(md_path)
    rel = rel.replace("\\", "/").lstrip("./")
    rel = re.sub(r"[^0-9A-Za-z._　-鿿＀-￯/-]", "_", rel).replace("/", "__")
    suffix = "." + mode if mode else ""
    if dark:
        suffix += ".dark"
    if style and style.lower() not in ("default", "none"):
        suffix += "." + re.sub(r"[^0-9A-Za-z._-]", "_", style)
    return rel + suffix + ".txt"


def capture_one(page, url, modes, dark, places, timeout, sidebar):
    """Load `url` and return {mode_key: digest_text} for every requested view."""
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_function(
        "() => { const p=document.getElementById('preview'); return p && p.children.length>0; }"
    )
    shoot.wait_for_render(page)

    is_marp = page.evaluate("() => document.body.classList.contains('marp')")
    # View modes only exist for Marp; a normal doc has exactly one rendering.
    view_modes = [m for m in modes if m] if is_marp else [""]
    if is_marp:
        page.wait_for_function(
            "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length > 0"
        )

    results = {}
    for want_dark in ([False, True] if dark else [False]):
        page.evaluate("(on) => { try { applyDarkMode(on); } catch (e) {} }", want_dark)
        page.wait_for_timeout(80)
        if want_dark:
            shoot.wait_for_render(page)  # dark re-renders mermaid/markwhen
        for mode in view_modes:
            if mode:
                page.evaluate("(m) => { try { setMarpView(m); } catch (e) {} }", mode)
                page.wait_for_timeout(120)
                page.evaluate("() => { try { fitMarpSlides(); } catch (e) {} }")
                page.wait_for_timeout(80)
            payload = page.evaluate(_DIGEST_JS, {"sidebar": sidebar})
            results[(mode, want_dark)] = render_digest(payload, places)
    return results


def main():
    ap = argparse.ArgumentParser(description="preview-harness structural DOM digest")
    ap.add_argument("files", nargs="+", help="paths to .md / .mdx documents")
    ap.add_argument("--out", default=None, help="output dir (default: <cwd>/_dom)")
    ap.add_argument("--modes", default="scroll",
                    help="Marp view modes to dump, comma-separated (scroll,deck,list)")
    ap.add_argument("--dark", action="store_true", help="also dump each doc in dark mode")
    ap.add_argument("--sidebar", action="store_true", help="include the TOC sidebar text")
    ap.add_argument("--style", default=None,
                    help="user style to apply, e.g. bunko.css (default: the built-in style)")
    ap.add_argument("--round", type=int, default=2, dest="places",
                    help="decimal places to round numbers inside style= (default 2)")
    ap.add_argument("--channel", default=None, help="browser channel: msedge | chrome (auto)")
    ap.add_argument("--port", type=int, default=8772, help="in-process harness port")
    ap.add_argument("--timeout", type=int, default=20000, help="per-step timeout ms")
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")
    out_dir = os.path.abspath(args.out) if args.out else os.path.join(os.getcwd(), "_dom")
    os.makedirs(out_dir, exist_ok=True)

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]

    paths = []
    for f in args.files:
        p = os.path.abspath(f)
        if not os.path.isfile(p):
            sys.stderr.write("WARN: skipping missing file: %s\n" % p)
            continue
        paths.append(p)
    if not paths:
        sys.stderr.write("ERROR: no input files\n")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed (pip install playwright)\n")
        sys.exit(2)

    httpd = shoot.start_harness(args.port, repo_root, assets_dir)
    written = []
    try:
        with sync_playwright() as p:
            channels = [args.channel] if args.channel else ["msedge", "chrome", None]
            browser, last_err = None, None
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
            page.set_default_timeout(args.timeout)
            page.add_init_script(shoot.style_init_script(args.style))

            for md_path in paths:
                url = "http://127.0.0.1:%d/index.html?file=%s" % (args.port, md_path)
                try:
                    results = capture_one(page, url, modes, args.dark,
                                          args.places, args.timeout, args.sidebar)
                except Exception as e:  # noqa: BLE001
                    sys.stderr.write("WARN: %s failed: %s\n" % (md_path, str(e)[:200]))
                    continue
                for (mode, is_dark), text in results.items():
                    dest = os.path.join(out_dir, slug_for(repo_root, md_path, mode, is_dark, args.style))
                    with open(dest, "w", encoding="utf-8", newline="\n") as fh:
                        fh.write(text)
                    written.append(dest)

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    for w in written:
        print(w)
    print("%d digest file(s) -> %s" % (len(written), out_dir), file=sys.stderr)


if __name__ == "__main__":
    main()

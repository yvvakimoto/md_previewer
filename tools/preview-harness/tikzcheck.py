#!/usr/bin/env python3
"""Functional check for the tikz / tikzcd fences.

tikz is otherwise invisible to the harness: ``domdump.py`` collapses an ``<svg>``
subtree to a single node, ``shoot.py`` only gives pixels, and its settle predicate
counts a ``.tikz-error`` as *settled* (it must — that is how the in-page 30 s timeout
resolves), so a block that stopped compiling passes every other check in silence.
This drives the real engine in the harness and asserts what the DOM digest cannot see:

* every Japanese glyph takes the SAME colour as the Latin glyph beside it in the
  same label — the invariant behind ``__tikzAdoptJpFill()``. TeX cannot be asked for
  that colour (pgf writes its own ``color push`` special and never touches
  ``\\current@color``), so it is adopted from the 1sp marker rect ``\\mdp@box`` emits;
* the marker rects are all consumed, and the Japanese ``font-size`` stays unitless;
* nothing in the fixture fails to compile, and ``samples/tikzcd.md`` still produces
  exactly the one intentional ``.tikz-error`` at its end;
* all of the above survive a dark-mode re-render, which is also the ``__tikzCache``
  path (the cache is NOT theme-salted: the restored innerHTML must already carry the
  colours, because ``__tikzFillJpText`` ran before ``__diagCacheSet``).

Usage::

    python tools/preview-harness/tikzcheck.py [--channel msedge|chrome]

Takes a couple of minutes: every fixture block is a real WASM TeX compile, and the
dark-mode pass renders the document a second time.

Exits non-zero and prints ``FAIL`` lines if any expectation is unmet.
"""

import argparse
import os
import sys
import tempfile

# The fixture and every failure message are Japanese; the console is cp932 on Windows.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older Python / non-reconfigurable stream
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
sys.path.insert(0, SCRIPT_DIR)
import shoot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PORT = 8797
SAMPLE = os.path.join(REPO, "samples", "tikzcd.md")

# Every label is ONE distinctive kanji followed by ONE ASCII letter. That is what makes
# the pairing exact with no geometry and no font-table knowledge: the engine writes the
# label's glyph runs in stream order, so once __tikzAdoptJpFill() has consumed the
# marker rect, a Japanese <text>'s nextElementSibling IS its Latin partner.
FIXTURE = r"""# tikz colour fixture

```tikz
\definecolor{mycol}{HTML}{1B9E77}
\begin{tikzpicture}[font=\small]
  \node at (0,0)            {一A};
  \node[red] at (3,0)       {赤B};
  \node[text=blue] at (6,0) {青C};
  \draw[green!60!black] (0,-1) node {緑D};
  \node at (3,-1)           {\textcolor{red}{紅E}};
  \node at (6,-1)           {\color{blue!50!black}紺F};
  \begin{scope}[orange]
    \node at (0,-2)         {橙G};
  \end{scope}
  \node[mycol] at (3,-2)    {翠H};
  \node[cyan] at (6,-2)     {空I};
  \node at (0,-3)           {\color[cmyk]{0,1,1,0}桃J};
  \node[white,fill=black] at (3,-3) {白K};
  \node[red] at (6,-3)      {黒L \textcolor{blue}{藍M} 朱N};
  \node[red] at (0,-4)      {$数O$};
  \node[red] at (3,-4)      {$X_{添P}$};
  \begin{scope}[rotate=30,red]
    \node at (6,-4)         {回Q};
  \end{scope}
\end{tikzpicture}
```

```tikzcd
A \arrow[r, red, "写R"] \arrow[d, "印S"'] & B \\
C                                          & D
```

A fence with no CJK at all gets no `data-add-to-preamble`, so it must be untouched.

```tikz
\begin{tikzpicture}
  \node[red] at (0,0) {ABC};
\end{tikzpicture}
```
"""

# hex codepoint -> (what the author wrote, expected computed fill).
# "INK" means the theme's own ink, i.e. the glyph resolved currentColor: black in light
# mode, #d0d0d0 in dark. Hard-coded rather than derived — a derived table would
# reimplement the thing under test.
INK = "INK"
CASES = [
    ("4E00", "default",                     INK),
    ("8D64", "\\node[red]",                 "rgb(255, 0, 0)"),
    ("9752", "\\node[text=blue]",           "rgb(0, 0, 255)"),
    ("7DD1", "\\draw[green!60!black] node", "rgb(0, 153, 0)"),
    ("7D05", "\\textcolor{red}",            "rgb(255, 0, 0)"),
    ("7D3A", "\\color{blue!50!black}",      "rgb(0, 0, 128)"),
    ("6A59", "scope[orange]",               "rgb(255, 128, 0)"),
    ("7FE0", "\\definecolor HTML",          "rgb(27, 158, 119)"),
    # xcolor defines cyan/magenta/yellow in the CMYK model, and run-tex.js's dvips-spec
    # parser maps every non-rgb/gray spec to black — so the Latin glyph is theme ink
    # too. Matching it is the point: half a coloured label is worse than none of it.
    ("7A7A", "\\node[cyan] (cmyk)",         INK),
    ("6843", "\\color[cmyk]",               INK),
    ("767D", "\\node[white] (gray 1)",      INK),
    ("9ED2", "mid-label: before",           "rgb(255, 0, 0)"),
    ("85CD", "mid-label: \\textcolor",      "rgb(0, 0, 255)"),
    ("6731", "mid-label: after",            "rgb(255, 0, 0)"),
    ("6570", "in $...$ (\\mathchoice)",     "rgb(255, 0, 0)"),
    ("6DFB", "in a subscript",              "rgb(255, 0, 0)"),
    ("56DE", "scope[rotate=30,red]",        "rgb(255, 0, 0)"),
    ("5199", "tikzcd \\arrow[r, red]",      "rgb(255, 0, 0)"),
    ("5370", "tikzcd label, default",       INK),
]

LIGHT_INK = "rgb(0, 0, 0)"
# body.dark-mode .tikz-diagram .tikzjax-wrapper { color: #d0d0d0 !important }
DARK_INK = "rgb(208, 208, 208)"

# One evaluate for the whole document: each Japanese <text>'s own computed fill, the
# computed fill of the Latin <text> next to it, its font-size, and the leftovers.
DUMP = """() => {
  const boxes = [...document.querySelectorAll('.tikz-diagram, .tikzcd-diagram')];
  const jp = {};
  boxes.forEach(box => box.querySelectorAll('text[data-mdp-jp]').forEach(t => {
    const sib = t.nextElementSibling;
    const rec = {
      fill: getComputedStyle(t).fill,
      fontSize: t.getAttribute('font-size'),
      sibTag: sib ? sib.tagName.toLowerCase() : null,
      sibFill: sib && sib.tagName.toLowerCase() === 'text' ? getComputedStyle(sib).fill : null,
    };
    const hex = t.getAttribute('data-mdp-jp');
    (jp[hex] = jp[hex] || []).push(rec);
  }));
  let markers = 0;
  boxes.forEach(box => box.querySelectorAll('rect').forEach(r => {
    const w = parseFloat(r.getAttribute('width'));
    if (w >= 0 && w < 0.001) markers++;
  }));
  const last = boxes[boxes.length - 1];
  return {
    jp: jp,
    errors: document.querySelectorAll('.tikz-error').length,
    markers: markers,
    blocks: boxes.length,
    control: last ? [...last.querySelectorAll('text')].map(t => getComputedStyle(t).fill) : null,
  };
}"""


def main():
    ap = argparse.ArgumentParser(description="tikz / tikzcd functional check")
    ap.add_argument("--channel", default="msedge", choices=["msedge", "chrome"])
    args = ap.parse_args()

    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(name)
            print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
        else:
            print("ok   %s" % name)

    tmp = tempfile.mkdtemp(prefix="tikzcheck-")
    doc = os.path.join(tmp, "jpcolor.md")
    with open(doc, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(FIXTURE)

    def url(path):
        return "http://127.0.0.1:%d/index.html?file=%s" % (PORT, path.replace("\\", "/"))

    def assert_all(data, ink, label):
        check("%s: no compile error" % label, data["errors"], 0)
        check("%s: every block rendered" % label, data["blocks"], 3)
        # The marker rect is an implementation detail of the colour adoption and must
        # never reach the cache, the HTML export or a right-click figure save.
        check("%s: marker rects consumed" % label, data["markers"], 0)
        for hex_cp, what, want in CASES:
            recs = data["jp"].get(hex_cp)
            if not recs:
                check("%s: %s (U+%s) rendered" % (label, what, hex_cp), None, "a <text>")
                continue
            want_fill = ink if want is INK else want
            got = sorted({r["fill"] for r in recs})
            check("%s: %s (U+%s)" % (label, what, hex_cp), got, [want_fill])
            # The expectations above pin the values; this pins the RELATION, which is
            # the actual bug statement and survives anyone re-colouring the fixture.
            sib = sorted({r["sibFill"] for r in recs})
            check("%s: %s matches its Latin neighbour" % (label, what), sib, [want_fill])
            # __tikzFillJpText strips the `pt`: an SVG font-size with a unit resolves
            # through CSS at 4/3 the user units TeX reserved.
            check("%s: %s font-size is unitless" % (label, what),
                  [r["fontSize"] for r in recs if "pt" in str(r["fontSize"])], [])
        check("%s: the CJK-free control fence is untouched" % label,
              data["control"], ["rgb(255, 0, 0)"])

    httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel=args.channel, headless=True)
            page = b.new_page(viewport={"width": 1400, "height": 1000})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            page.goto(url(doc))
            shoot.wait_for_render(page)
            assert_all(page.evaluate(DUMP), LIGHT_INK, "light")

            # `M` re-renders the whole document, so every block comes back through
            # __diagCacheHit rather than the engine: the memoized innerHTML has to carry
            # the adopted colours already.
            page.keyboard.press("m")
            shoot.wait_for_render(page)
            check("dark mode is on",
                  page.evaluate("() => document.body.classList.contains('dark-mode')"), True)
            assert_all(page.evaluate(DUMP), DARK_INK, "dark (cache)")

            # Both exports clone the live DOM, so the adopted colour rides along as an
            # attribute + an inline style — but "renders in the preview, missing from an
            # export" is this repo's most common silent bug, so pin it. Cheap: the
            # artifact is built in the page that is already loaded.
            art = page.evaluate("async () => (await buildExportArtifact({})).html")
            for hex_cp, what, want in CASES:
                if want is INK:
                    continue
                i = art.find('data-mdp-jp="%s"' % hex_cp)
                tag = art[i:art.find(">", i)] if i >= 0 else ""
                check("HTML export carries the colour of %s" % what,
                      bool(tag) and "fill" in tag and "currentColor" not in tag, True)

            # The one intentional bad-TeX block at the end of the sample. A preamble
            # that stopped compiling shows up here as every block erroring at once.
            page.goto(url(SAMPLE))
            shoot.wait_for_render(page)
            check("samples/tikzcd.md: exactly the one intentional error",
                  page.evaluate("() => document.querySelectorAll('.tikz-error').length"), 1)

            check("no uncaught page errors", errors, [])
            b.close()
    finally:
        httpd.shutdown()

    print()
    print("%d FAILURES: %s" % (len(failures), ", ".join(failures)) if failures else "ALL PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

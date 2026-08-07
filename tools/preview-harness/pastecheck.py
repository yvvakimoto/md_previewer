#!/usr/bin/env python3
"""Functional check for the companion editor's "paste an Office table" feature.

``tablePaste.test.mjs`` covers the pure layer (the TSV predicate, matrix
normalisation, the paste-context guard) under plain node. Three things cannot be
tested there, and all three fail silently:

1. **HTML parsing.** ``htmlTableToMatrix`` needs a real DOM. Excel and Word emit
   markup nothing else produces — ``&nbsp;`` litter, ``<p>``-wrapped cells,
   rowspan/colspan, spacer rows — so the fixtures below are the only place that
   shape is exercised.
2. **Handler ordering.** The conversion sits at ``Prec.highest`` so it precedes
   ``@codemirror/lang-markdown``'s ``pasteURLAsLink``, while the built-in
   ``handlers.paste`` is appended after every plugin by ``computeHandlers()``.
   Both facts live inside installed packages and a dependency bump can invert
   them with no compile error. The "URL over a selection still makes a link" and
   "plain prose still pastes" cases are the gate for that.
3. **Vim.** Ctrl+V must still produce a DOM paste event in INSERT mode (it
   depends on ``commandMatches``' insert-context filter inside
   @replit/codemirror-vim) and must NOT in NORMAL mode, where ``<C-v>`` is
   visual-block.

Usage::

    python tools/preview-harness/pastecheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

DOC = "# Title\n\nintro paragraph\n"

INIT_TMPL = """(() => {
  window.__initialFile = %(file)s;
  window.__marpUserThemes = [];
  window.__sentIpc = [];
  window.ipc = { postMessage: (m) => { window.__sentIpc.push(String(m)); } };
  try {
    localStorage.setItem('editor:cellMode', 'off');
    localStorage.setItem('editor:vim', %(vim)s);
    localStorage.setItem('editor:livePreview', 'on');
    localStorage.setItem('editor:tablePaste', %(tp)s);
  } catch (e) {}
})();"""

# Dispatch a synthetic paste at the cursor. Notes that matter:
#  - dispatch on .cm-content (the contentDOM): eventBelongsToEditor walks
#    event.target up to contentDOM, so targeting it directly always passes.
#  - an untrusted event never triggers Chromium's own paste, so anything that
#    appears in the doc came from a CodeMirror handler, ours or the built-in.
#
# `event.defaultPrevented` is NOT a usable probe for "our handler claimed it":
# @codemirror/view's built-in handlers.paste ALSO calls preventDefault() when it
# performs an ordinary paste, so the flag is true either way. The observable that
# actually distinguishes the two is the document, so every assertion below is on
# the resulting text (see classify()).
PASTE_JS = """([html, text]) => {
  const dt = new DataTransfer();
  if (html) dt.setData('text/html', html);
  if (text) dt.setData('text/plain', text);
  const ev = new ClipboardEvent('paste',
    { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('.cm-content').dispatchEvent(ev);
  return ev.defaultPrevented;
}"""

TAB = "\t"

# --- fixtures -------------------------------------------------------------
# Excel's clipboard HTML: flat <td> in one <tbody>, no <thead>, &nbsp; padding.
EXCEL_HTML = (
    '<table border=0 cellpadding=0 cellspacing=0><tr height=17>'
    '<td>\u540d\u524d</td><td>\u5024</td></tr>'
    '<tr height=17><td>\u3042</td><td>1</td></tr>'
    '<tr height=17><td>b&nbsp;</td><td>2</td></tr></table>'
)
# Word: <p>-wrapped cell contents and a <br> inside a cell.
WORD_HTML = (
    '<table><tr><td><p>A</p><p>B</p></td><td><p>C<br>D</p></td></tr>'
    '<tr><td><p>x</p></td><td><p>y</p></td></tr></table>'
)
SPAN_HTML = (
    '<table><tr><th colspan="2">Both</th></tr>'
    '<tr><td rowspan="2">L</td><td>r1</td></tr>'
    '<tr><td>r2</td></tr></table>'
)
FRAGMENT_HTML = '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>'
# A Word selection containing a table PLUS prose: converting would silently drop
# the prose, so this must decline.
PROSE_PLUS_TABLE_HTML = (
    '<p>Some prose before.</p><table><tr><td>a</td><td>b</td></tr></table>'
)


def main():
    ap = argparse.ArgumentParser(description="companion editor table-paste check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8777)
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.join(repo_root, "assets")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write("ERROR: playwright is not installed\n")
        sys.exit(2)

    failures = []

    def check(name, got, want):
        if got != want:
            msg = "FAIL: %s -> got %r, want %r" % (name, got, want)
            failures.append(msg)
            print(msg)
        else:
            print("ok   %s" % name)

    httpd = shoot.start_harness(args.port, repo_root, assets_dir)
    try:
        with sync_playwright() as p:
            channels = [args.channel] if args.channel else ["msedge", "chrome", None]
            browser = None
            for ch in channels:
                try:
                    browser = p.chromium.launch(channel=ch) if ch else p.chromium.launch()
                    break
                except Exception:  # noqa: BLE001
                    pass
            if browser is None:
                sys.stderr.write("ERROR: no Chromium available\n")
                sys.exit(3)

            ctx = browser.new_context(viewport={"width": 1100, "height": 800})
            page = ctx.new_page()
            page.set_default_timeout(20000)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            # CodeMirror swallows ViewPlugin exceptions into console.error while
            # deactivating the plugin, so watch the console too.
            def on_console(m):
                if m.type == "error" and "favicon" not in m.text.lower():
                    errors.append("console.%s: %s" % (m.type, m.text))

            page.on("console", on_console)
            page.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))

            def load(doc=DOC, vim="off", tp="on"):
                payload = {"path": "C:/tmp/doc.md", "content": doc, "line": 0}
                page.add_init_script(INIT_TMPL % {
                    "file": json.dumps(payload),
                    "vim": json.dumps(vim),
                    "tp": json.dumps(tp),
                })
                page.goto("http://127.0.0.1:%d/editor.html" % args.port,
                          wait_until="domcontentloaded")
                page.wait_for_function("() => !!window.__editorView")
                page.wait_for_timeout(250)
                page.evaluate("() => window.__editorView.focus()")
                page.wait_for_timeout(80)

            def doc_text():
                return page.evaluate("() => window.__editorView.state.doc.toString()")

            def cursor_to_end():
                page.evaluate(
                    "() => { const v = window.__editorView;"
                    " v.dispatch({selection: {anchor: v.state.doc.length}}); v.focus(); }"
                )

            def table_lines():
                return [l for l in doc_text().split("\n") if l.startswith("|")]

            def paste(html="", text=""):
                """Dispatch a paste and classify what the document did.

                'table' — we converted; 'plain' — we declined and the built-in
                pasted the raw text; 'none' — nothing was inserted (a decline
                with no text/plain to fall back to).
                """
                before, before_rows = doc_text(), len(table_lines())
                # runHandlers is synchronous only when updateState == Idle; give
                # it a beat either way before asserting.
                page.evaluate(PASTE_JS, [html, text])
                page.wait_for_timeout(60)
                after = doc_text()
                if len(table_lines()) > before_rows:
                    return "table"
                return "plain" if after != before else "none"

            # ---------- HTML conversion ----------
            load()
            cursor_to_end()
            check("excel html converts", paste(html=EXCEL_HTML), "table")
            check("excel html -> pipe table", table_lines(), [
                "| \u540d\u524d | \u5024  |",
                "| ---- | --- |",
                "| \u3042   | 1   |",
                "| b    | 2   |",
            ])

            load()
            cursor_to_end()
            paste(html=WORD_HTML)
            check("word <p> cells do not run together", table_lines()[0], "| A B | C D |")

            load()
            cursor_to_end()
            paste(html=SPAN_HTML)
            check("colspan/rowspan expand to a dense grid", table_lines(), [
                "| Both | Both |",
                "| ---- | ---- |",
                "| L    | r1   |",
                "| L    | r2   |",
            ])

            load()
            cursor_to_end()
            # The HTML parser drops <tr> outside a table context, so this only
            # works because parseHtmlFragment re-parses wrapped in <table>.
            check("<tr> fragment converts", paste(html=FRAGMENT_HTML), "table")
            check("<tr> fragment -> 2x2", len(table_lines()), 3)

            # ---------- declines ----------
            load()
            cursor_to_end()
            check("prose+table declines (no data loss)",
                  paste(html=PROSE_PLUS_TABLE_HTML, text="Some prose before.\na\tb"),
                  "plain")

            load()
            cursor_to_end()
            check("plain prose declines", paste(text="just some prose"), "plain")
            check("tab-indented code declines",
                  paste(text=TAB + "a = 1\n" + TAB + "b = 2"), "plain")

            # TSV fallback when the html flavour carries no table.
            load()
            cursor_to_end()
            check("tsv fallback converts",
                  paste(html="<pre>x</pre>", text="a" + TAB + "b\nc" + TAB + "d"), "table")

            # ---------- context guard ----------
            load(doc="```\ncode here\n```\n")
            page.evaluate(
                "() => { const v = window.__editorView;"
                " v.dispatch({selection: {anchor: v.state.doc.toString().indexOf('code')}});"
                " v.focus(); }"
            )
            check("inside a fence declines", paste(html=EXCEL_HTML), "none")

            load(doc="---\ntitle: x\n---\n\nbody\n")
            page.evaluate(
                "() => { const v = window.__editorView;"
                " v.dispatch({selection: {anchor: v.state.doc.toString().indexOf('x')}});"
                " v.focus(); }"
            )
            check("inside front matter declines", paste(html=EXCEL_HTML), "none")

            # ---------- undo is a single step ----------
            load()
            cursor_to_end()
            before = doc_text()
            check("table inserted", paste(html=EXCEL_HTML), "table")
            page.keyboard.press("Control+z")
            page.wait_for_timeout(140)
            check("one Ctrl+Z undoes the whole paste", doc_text(), before)

            # ---------- escape hatch ----------
            load()
            cursor_to_end()
            page.keyboard.press("Control+Shift+V")
            page.wait_for_timeout(40)
            check("Mod-Shift-V arms plain paste",
                  paste(html=EXCEL_HTML, text="a" + TAB + "b\nc" + TAB + "d"), "plain")
            # And the arming is one-shot: the next paste converts again.
            check("plain-paste flag is one-shot", paste(html=EXCEL_HTML), "table")

            # ---------- the preference ----------
            load(tp="off")
            cursor_to_end()
            check(":set notablepaste disables conversion",
                  paste(html=EXCEL_HTML, text="a" + TAB + "b\nc" + TAB + "d"), "plain")

            # ---------- no regression in the handlers we must not shadow ----------
            load()
            page.evaluate(
                "() => { const v = window.__editorView;"
                " const i = v.state.doc.toString().indexOf('intro');"
                " v.dispatch({selection: {anchor: i, head: i + 5}}); v.focus(); }"
            )
            paste(text="https://example.com")
            check("pasteURLAsLink still wraps a selection",
                  "[intro](https://example.com)" in doc_text(), True)

            # ---------- Vim ----------
            load(vim="on")
            cursor_to_end()
            page.keyboard.press("i")          # NORMAL -> INSERT
            page.wait_for_timeout(60)
            check("Vim INSERT: paste still converts", paste(html=EXCEL_HTML), "table")

            load(vim="on")
            cursor_to_end()
            page.keyboard.press("Escape")     # ensure NORMAL
            page.wait_for_timeout(60)
            before = doc_text()
            page.keyboard.press("Control+v")  # visual-block, not a paste
            page.wait_for_timeout(80)
            check("Vim NORMAL: Ctrl+V does not paste", doc_text(), before)

            # ---------- the real clipboard, the real Ctrl+V ----------
            # Everything above uses a synthetic ClipboardEvent, which proves the
            # handler but not that a genuine paste carries the html flavour at
            # all. This case puts a real ClipboardItem on the real clipboard and
            # presses a real Ctrl+V, so the text/html flavour comes out of
            # Chromium's own clipboard code — the same code WebView2 runs when it
            # converts Win32 CF_HTML. (clipboardSync.js shims only readText /
            # writeText, so navigator.clipboard.write is untouched here, and
            # 127.0.0.1 is a secure context.)
            try:
                ctx.grant_permissions(["clipboard-read", "clipboard-write"])
                load()
                cursor_to_end()
                page.evaluate(
                    """(html) => navigator.clipboard.write([new ClipboardItem({
                         'text/html': new Blob([html], {type: 'text/html'}),
                         'text/plain': new Blob(['x'], {type: 'text/plain'}),
                       })])""",
                    EXCEL_HTML,
                )
                before_rows = len(table_lines())
                page.keyboard.press("Control+v")
                page.wait_for_timeout(200)
                check("real clipboard + real Ctrl+V converts",
                      len(table_lines()) > before_rows, True)
            except Exception as exc:  # noqa: BLE001
                # Not all environments allow the async clipboard API headlessly.
                # Report rather than fail: the synthetic cases above already pin
                # the handler, and this one is corroboration.
                print("skip real-clipboard case (%s)" % type(exc).__name__)

            check("no page/console errors", errors, [])
            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("\n%d FAILURES" % len(failures))
        sys.exit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    main()

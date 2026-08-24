#!/usr/bin/env python3
"""Functional check for the Vim command-mode keyboard-layout translation.

``keyLayout.test.mjs`` covers the pure layer under plain node: the table is a
bijection, the shifted half mirrors the unshifted one, and — the assertion that
matters most — the built langmap string survives a round trip through a mirror
of upstream's ``parseLangmap``. None of that proves the translation actually
reaches Vim, and the interesting properties are precisely the ones that only
exist once the real ``@replit/codemirror-vim`` is running:

* ``langmap`` is applied during key-NAME generation (``dist/index.js:1244``),
  before the key buffer exists. That is the whole reason multi-key sequences
  (``gg``, this repo's ``[[``), operator-pending motions (``dd``) and counts
  keep working. A ``Vim.map``-per-letter implementation passes every unit test
  and fails those three cases — they are the regression net for someone
  "simplifying" the mechanism later.
* ``expectLiteralNext`` (``dist/index.js:1610``) must keep the ARGUMENT of
  ``f``/``t``/``r``/``m`` untranslated: the character ``f`` searches for is the
  one actually typed.
* Insert mode, the ex line and the search prompt must stay in Dvorak.

``page.keyboard.press('h')`` emits a real keydown with ``key='h'``, which is
exactly what a Dvorak emulator produces — and ``langmap`` reads only ``e.key``,
so this is a faithful simulation rather than an approximation.

Usage::

    python tools/preview-harness/dvorakcheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

# Five distinct lines so a vertical motion is unambiguous, plus a line carrying
# both an `h` and a `j` for the `f`-argument case.
DOC = "alpha\nbravo\ncharlie\ndelta\necho\nzz hj kk\n"

# A deck for the cell-mode case.
DECK = "---\nmarp: true\n---\n\n# One\n\nalpha\n\n---\n\n# Two\n\nbeta\n"

# Stands in for the Rust host. Must be an IIFE — add_init_script executes the
# string as a script body, so a bare `() => {...}` is evaluated and discarded,
# silently booting the editor with an empty document.
INIT_TMPL = """(() => {
  window.__initialFile = %(file)s;
  window.__marpUserThemes = [];
  window.__sentIpc = [];
  window.ipc = { postMessage: (m) => { window.__sentIpc.push(String(m)); } };
  try {
    localStorage.setItem('editor:vim', %(vim)s);
    localStorage.setItem('editor:cellMode', %(cells)s);
    localStorage.setItem('editor:livePreview', 'off');
    localStorage.setItem('editor:theme', 'light');
    localStorage.setItem('editor:lineNumbers', 'absolute');
    %(layout)s
  } catch (e) {}
})();"""


def main():
    ap = argparse.ArgumentParser(description="Vim Dvorak->QWERTY layout check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8779)
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

            # CodeMirror catches ViewPlugin exceptions and only logException()s
            # them, silently deactivating the plugin — no pageerror is raised.
            def on_console(m):
                if m.type == "error" and "favicon" not in m.text.lower():
                    errors.append("console.%s: %s" % (m.type, m.text))

            page.on("console", on_console)
            page.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))

            def seed(layout="dvorak", vim="on", cells="off", doc=DOC):
                payload = {"path": "C:/tmp/doc.md", "content": doc, "line": 0}
                ls = ("localStorage.setItem('editor:keyLayout', %s);" % json.dumps(layout)
                      if layout else "localStorage.removeItem('editor:keyLayout');")
                page.add_init_script(INIT_TMPL % {
                    "file": json.dumps(payload),
                    "vim": json.dumps(vim),
                    "cells": json.dumps(cells),
                    "layout": ls,
                })

            def load(layout="dvorak", vim="on", cells="off", doc=DOC, target=None):
                seed(layout, vim, cells, doc)
                pg = target or page
                pg.goto("http://127.0.0.1:%d/editor.html" % args.port,
                        wait_until="domcontentloaded")
                pg.wait_for_function("() => !!window.__editorView")
                pg.wait_for_timeout(250)
                pg.evaluate("() => window.__editorView.focus()")
                pg.wait_for_timeout(80)

            def press(key, times=1):
                for _ in range(times):
                    page.keyboard.press(key)
                    page.wait_for_timeout(70)

            def goto_line(n):
                """Park the cursor at the start of line n without using motions."""
                page.evaluate(
                    "(n) => { const v = window.__editorView;"
                    " v.dispatch({selection: {anchor: v.state.doc.line(n).from}});"
                    " v.focus(); }", n)
                page.wait_for_timeout(60)

            def cur_line():
                return page.evaluate(
                    "() => window.__editorView.state.doc"
                    ".lineAt(window.__editorView.state.selection.main.head).number")

            def cur_col():
                return page.evaluate(
                    "() => { const s = window.__editorView.state;"
                    " const h = s.selection.main.head;"
                    " return h - s.doc.lineAt(h).from; }")

            def doc_text():
                return page.evaluate("() => window.__editorView.state.doc.toString()")

            def vim_mode():
                return page.evaluate(
                    "() => { const v = window.__editorView;"
                    " const cm = v && v.cm; const st = cm && cm.state && cm.state.vim;"
                    " if (!st) return 'none';"
                    " return st.insertMode ? 'insert' : (st.visualMode ? 'visual' : 'normal'); }")

            def ex_open():
                return page.evaluate(
                    "() => !!document.querySelector('.cm-vim-panel, .cm-panel-vim')")

            def ls(key):
                return page.evaluate("(k) => localStorage.getItem(k)", key)

            # ---------------- default layout is a no-op ----------------
            load(layout=None)
            check("editor boots with no error", errors, [])
            check("no pref stored means qwerty", ls("editor:keyLayout"), None)
            goto_line(3)
            press("h")
            check("qwerty: h still moves LEFT (h)", (cur_line(), cur_col()), (3, 0))
            press("j")
            check("qwerty: j still moves DOWN", cur_line(), 4)

            # ---------------- dvorak: hjkl land at QWERTY positions ----------------
            load(layout="dvorak")
            check("dvorak boots with no error", errors, [])
            check("pref is persisted/read as dvorak", ls("editor:keyLayout"), "dvorak")

            goto_line(2)
            press("h")            # Dvorak h sits at QWERTY j
            check("dvorak: h -> j (down)", cur_line(), 3)
            press("t")            # Dvorak t sits at QWERTY k
            check("dvorak: t -> k (up)", cur_line(), 2)
            press("n")            # Dvorak n sits at QWERTY l
            check("dvorak: n -> l (right)", cur_col(), 1)
            press("d")            # Dvorak d sits at QWERTY h
            check("dvorak: d -> h (left)", cur_col(), 0)

            # ---------------- multi-key sequences ----------------
            # These are the cases a Vim.map-per-letter implementation cannot do:
            # matchCommand compares the JOINED key buffer, so the second key of a
            # sequence would never be translated.
            goto_line(4)
            press("i")            # Dvorak i sits at QWERTY g
            press("i")            # -> gg
            check("dvorak: i i -> gg (first line)", cur_line(), 1)

            # `[[` / `]]` are this repo's own Vim.mapCommand heading motions.
            load(layout="dvorak", doc="# A\n\ntext\n\n# B\n\nmore\n")
            goto_line(7)
            press("/")            # Dvorak / sits at QWERTY [
            press("/")            # -> [[  (previous heading)
            check("dvorak: / / -> [[ (previous heading)", cur_line(), 5)

            # ---------------- operator-pending ----------------
            # commandMatches rewrites the context to 'operatorPending' once an
            # operator is pending, so a 'normal'-context mapping would be filtered
            # out here. langmap runs earlier and is unaffected.
            load(layout="dvorak")
            goto_line(2)
            press("e")            # Dvorak e sits at QWERTY d
            press("e")            # -> dd
            check("dvorak: e e -> dd (deletes the line)",
                  doc_text(), "alpha\ncharlie\ndelta\necho\nzz hj kk\n")

            # An operator + a translated motion (dw).
            load(layout="dvorak", doc="one two three\n")
            goto_line(1)
            press("e")            # -> d
            press(",")            # Dvorak , sits at QWERTY w  -> dw
            check("dvorak: e , -> dw (deletes a word)", doc_text(), "two three\n")

            # ---------------- counts ----------------
            load(layout="dvorak")
            goto_line(1)
            press("3")            # digits are identity
            press("h")            # -> 3j
            check("dvorak: 3 h -> 3j", cur_line(), 4)

            # ---------------- f's argument stays literal ----------------
            # expectLiteralNext must suppress the translation for the character
            # after f, or `f` would hunt for the wrong glyph.
            load(layout="dvorak")
            goto_line(6)          # "zz hj kk"
            press("u")            # Dvorak u sits at QWERTY f
            press("h")            # the ARGUMENT: must stay the literal 'h'
            check("dvorak: f's argument is not translated", cur_col(), 3)

            # ---------------- insert mode stays Dvorak ----------------
            load(layout="dvorak", doc="\n")
            goto_line(1)
            press("c")            # Dvorak c sits at QWERTY i -> enter insert
            check("dvorak: c -> i (insert mode)", vim_mode(), "insert")
            page.keyboard.type("hjkl")
            page.wait_for_timeout(120)
            check("insert mode types the literal Dvorak characters",
                  doc_text(), "hjkl\n")
            press("Escape")
            check("Escape returns to normal", vim_mode(), "normal")

            # ---------------- ex line ----------------
            # Getting INTO the ex line is a command, so it moves to the QWERTY `;`
            # position (Dvorak emits `:` there under Shift). What is typed after it
            # is text, and must NOT be translated.
            load(layout="dvorak")
            goto_line(1)
            page.keyboard.press("Shift+S")   # Dvorak S -> ':'
            page.wait_for_timeout(150)
            check("dvorak: Shift+S opens the ex line", ex_open(), True)
            page.keyboard.type("hjkl")
            page.wait_for_timeout(120)
            check("ex line text is not translated",
                  page.evaluate("() => { const i = document.querySelector("
                                "'.cm-vim-panel input, .cm-panel-vim input');"
                                " return i ? i.value : null; }"), "hjkl")
            press("Escape")

            # ---------------- ex-command entry points ----------------
            # entry.js replaces the package's built-in `set`, so a new option is
            # reachable only by having a case in that switch. `:keylayout` is the
            # dedicated form. Driven through the real ex line, which also proves
            # the round trip: the command is typed literally in either layout.
            load(layout=None, doc=DOC)
            page.keyboard.press("Shift+Semicolon")   # qwerty: ':'
            page.wait_for_timeout(150)
            page.keyboard.type("set dvorak")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":set dvorak switches the layout", ls("editor:keyLayout"), "dvorak")
            goto_line(2)
            press("h")
            check(":set dvorak takes effect immediately", cur_line(), 3)

            page.keyboard.press("Shift+S")           # dvorak: ':'
            page.wait_for_timeout(150)
            page.keyboard.type("keylayout qwerty")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":keylayout qwerty switches back", ls("editor:keyLayout"), "qwerty")
            goto_line(2)
            press("h")
            check(":keylayout qwerty takes effect immediately", cur_col(), 0)

            page.keyboard.press("Shift+Semicolon")
            page.wait_for_timeout(150)
            page.keyboard.type("set dvorak")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            page.keyboard.press("Shift+S")
            page.wait_for_timeout(150)
            page.keyboard.type("set nodvorak")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":set nodvorak turns it off", ls("editor:keyLayout"), "qwerty")

            # ---------------- cell mode Command mode ----------------
            load(layout="dvorak", vim="off", cells="on", doc=DECK)
            page.wait_for_timeout(150)
            press("Escape")       # into cell Command mode
            page.wait_for_timeout(120)
            check("cell mode is in command mode",
                  page.evaluate("() => document.body.classList"
                                ".contains('cellmode-command')"), True)
            before = cur_line()
            press("h")            # -> j : next cell
            check("cell mode: h -> j (next cell)", cur_line() > before, True)

            # ---------------- persistence across a fresh boot ----------------
            # add_init_script calls ACCUMULATE and all of them re-run on every
            # navigation, so a page.reload() here would replay the seeds above.
            # A second page in the same context shares localStorage but carries
            # only its own init script.
            page2 = ctx.new_page()
            page2.set_default_timeout(20000)
            payload = {"path": "C:/tmp/doc.md", "content": DOC, "line": 0}
            page2.add_init_script(
                "(() => { window.__initialFile = %s;"
                " window.__marpUserThemes = [];"
                " window.ipc = { postMessage: () => {} }; })();" % json.dumps(payload))
            page2.goto("http://127.0.0.1:%d/editor.html" % args.port,
                       wait_until="domcontentloaded")
            page2.wait_for_function("() => !!window.__editorView")
            page2.wait_for_timeout(250)
            check("layout survives a fresh boot",
                  page2.evaluate("() => localStorage.getItem('editor:keyLayout')"),
                  "dvorak")
            check("settings modal reflects the stored layout",
                  page2.evaluate("() => { const s = document.querySelector("
                                 "'[data-el=\\\"key-layout\\\"]');"
                                 " return s ? s.value : null; }"), "dvorak")
            page2.close()

            check("no page errors overall", errors, [])
            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("\n%d FAILURE(S)" % len(failures))
        sys.exit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    main()

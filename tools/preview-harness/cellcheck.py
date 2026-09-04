#!/usr/bin/env python3
"""Functional check for the companion editor's Jupyter-style cell mode.

``cells.test.mjs`` covers the pure state layer under plain node, but the part that
cannot be tested there is the one most likely to break silently: whether the
Prec.highest DOM keydown gate really runs BEFORE @replit/codemirror-vim.

That ordering rests on two facts inside installed packages — @codemirror/view
registers the whole keymap facet through a single ``Prec.default`` keydown handler,
and ``vim()`` returns an un-Prec-wrapped ViewPlugin — so a dependency bump can
invert it with no compile error and no test failure anywhere else. The symptom
would be that with Vim ON, cell Command mode loses every single-letter key to Vim
(``j``/``k`` move by line, ``a`` enters INSERT, ``dd`` deletes a line). The
"Vim ON: Esc then j moves by CELL" case below is the gate for exactly that.

This drives the real editor.html + editor.iife.js in a headless Chromium, standing
in for the Rust host with an ``__initialFile`` global and an ``ipc`` shim (the same
approach serve.py takes for the preview).

Usage::

    python tools/preview-harness/cellcheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

# A deck with front matter (cell 1 = the protected front-matter pseudo-cell) and
# three body cells, so the indices in the status bar are unambiguous.
DECK = (
    "---\nmarp: true\n---\n"
    "\n# One\n\nalpha\n\n---\n\n# Two\n\nbeta\n\n---\n\n# Three\n\ngamma\n"
)

# Stands in for the Rust host: __initialFile + a recording ipc shim, plus the
# localStorage prefs under test. Runs before any page script.
#
# NOTE this must be an IIFE, not a bare `() => {...}`: add_init_script executes the
# string as a script body, so a lone function expression is evaluated and thrown
# away (page.evaluate is the one that *calls* a passed function).
INIT_TMPL = """(() => {
  window.__initialFile = %(file)s;
  window.__marpUserThemes = [];
  window.__sentIpc = [];
  window.ipc = { postMessage: (m) => { window.__sentIpc.push(String(m)); } };
  try {
    localStorage.setItem('editor:cellMode', %(cells)s);
    localStorage.setItem('editor:vim', %(vim)s);
    localStorage.setItem('editor:livePreview', 'on');
  } catch (e) {}
})();"""


def main():
    ap = argparse.ArgumentParser(description="companion editor cell-mode check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8776)
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
            # CodeMirror catches ViewPlugin exceptions and only logException()s them
            # (console.error) while silently deactivating the plugin — so a plugin
            # that never runs produces no pageerror at all. Watch the console too.
            def on_console(m):
                # The harness serves no favicon; that 404 is not the editor's doing.
                if m.type == "error" and "favicon" not in m.text.lower():
                    errors.append("console.%s: %s" % (m.type, m.text))

            page.on("console", on_console)
            page.on("requestfailed", lambda r: None)
            page.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))

            def load(cells="on", vim="off", doc=DECK):
                payload = {"path": "C:/tmp/deck.md", "content": doc, "line": 0}
                page.add_init_script(INIT_TMPL % {
                    "file": json.dumps(payload),
                    "cells": json.dumps(cells),
                    "vim": json.dumps(vim),
                })
                page.goto("http://127.0.0.1:%d/editor.html" % args.port,
                          wait_until="domcontentloaded")
                page.wait_for_function("() => !!window.__editorView")
                page.wait_for_timeout(250)
                page.evaluate("() => window.__editorView.focus()")
                page.wait_for_timeout(80)

            def press(key, times=1):
                for _ in range(times):
                    page.keyboard.press(key)
                    page.wait_for_timeout(90)

            def doc_text():
                return page.evaluate("() => window.__editorView.state.doc.toString()")

            def bad_separators(text):
                lines = text.replace("\r\n", "\n").split("\n")
                bad = []
                for i, ln in enumerate(lines):
                    if ln.strip() in ("---", "***", "___") and i >= 3 \
                            and lines[i - 1].strip() != "":
                        bad.append(i + 1)
                return bad

            def sep_count():
                # Cell count - 1 for a front-mattered deck; a stable structural probe.
                return len([ln for ln in doc_text().split("\n") if ln.strip() == "---"]) - 2

            def status():
                return page.evaluate(
                    "() => { const e=document.querySelector('.status-info');"
                    " return e ? e.textContent : ''; }")

            def cell_no():
                """The `CELL n` index the status bar reports (0 when absent)."""
                txt = status()
                for part in txt.split("·"):
                    part = part.strip()
                    if part.startswith("CELL "):
                        return int(part.split()[1])
                return 0

            def cursor_line():
                return page.evaluate(
                    "() => window.__editorView.state.doc"
                    ".lineAt(window.__editorView.state.selection.main.head).number")

            def goto_line(n):
                page.evaluate("(n) => { const v = window.__editorView;"
                              " v.dispatch({ selection: { anchor: v.state.doc.line(n).from } }); }", n)
                page.wait_for_timeout(90)

            def body_has(cls):
                return page.evaluate("(c) => document.body.classList.contains(c)", cls)

            # ---------- boot + visuals ----------
            load(cells="on", vim="off")
            check("editor boots with no page error", errors, [])
            check("cell mode is on at boot from localStorage", body_has("cell-mode"), True)
            check("starts in Edit mode", body_has("cellmode-edit"), True)
            check("not in Command mode at boot", body_has("cellmode-command"), False)
            check("cell line decorations are present",
                  page.evaluate("() => document.querySelectorAll('.cm-cell').length > 0"), True)
            check("separator lines are decorated as the gap",
                  page.evaluate("() => document.querySelectorAll('.cm-cell-gap').length"), 2)
            check("cell boxes have a first and last line",
                  page.evaluate("() => document.querySelectorAll('.cm-cell-first').length > 0"
                                " && document.querySelectorAll('.cm-cell-last').length > 0"), True)
            check("the cell-number gutter exists",
                  page.evaluate("() => !!document.querySelector('.cm-cellNumbers')"), True)
            check("the front-matter pseudo-cell is marked protected",
                  page.evaluate("() => document.querySelectorAll('.cm-cell-fm').length > 0"), True)
            check("gutter shows a [1] cell number",
                  page.evaluate(
                      "() => [...document.querySelectorAll('.cm-cellNumbers .cm-gutterElement')]"
                      ".some(e => e.textContent.trim() === '[1]')"), True)

            # ---------- mode switching (Vim OFF) ----------
            press("Escape")
            check("Esc enters Command mode", body_has("cellmode-command"), True)
            check("status bar reports the cell mode", "CELL" in status(), True)
            # CodeMirror shows the caret from its base theme with a 5-class
            # generated selector, so the hiding rule needs !important. Without it
            # the caret stayed visible in Command mode — assert the computed value,
            # not the stylesheet.
            check("Command mode hides the caret",
                  page.evaluate(
                      "() => { const c=document.querySelector('.cm-cursor');"
                      " return c ? getComputedStyle(c).display : 'absent'; }"), "none")
            press("Enter")
            check("Edit mode shows the caret again",
                  page.evaluate(
                      "() => { const c=document.querySelector('.cm-cursor');"
                      " return c ? getComputedStyle(c).display : 'absent'; }"), "block")
            press("Escape")
            press("Enter")
            check("Enter returns to Edit mode", body_has("cellmode-edit"), True)
            check("Enter leaves Command mode", body_has("cellmode-command"), False)
            before = doc_text()
            press("Escape")
            press("j")
            check("Command-mode j does not type into the document", doc_text(), before)

            # ---------- cell navigation (Vim OFF) ----------
            load(cells="on", vim="off")
            check("caret starts in the front-matter cell", cell_no(), 1)
            press("Escape")
            press("j")
            check("j moves to the next cell", cell_no(), 2)
            press("j")
            check("j again moves on", cell_no(), 3)
            press("k")
            check("k moves back", cell_no(), 2)
            press("End")
            check("End jumps to the last cell", cell_no(), 4)
            press("Home")
            # 2, not 1: cell navigation stays in the body, so Home lands on the
            # first BODY cell. The front matter (display index 1) is a protected
            # pseudo-cell — the caret can start or be clicked there, but j/k/Home
            # never select it, which is what stops an op ever targeting it.
            check("Home jumps to the first body cell, skipping the front matter",
                  cell_no(), 2)

            # ---------- THE ordering gate: Vim ON ----------
            # With Vim ON, NORMAL mode swallows every single-character key, so if the
            # gate were a keymap layer (any Prec) instead of a Prec.highest
            # domEventHandlers, `j` would move ONE LINE inside the same cell and
            # `a` would enter INSERT. Both are asserted here.
            load(cells="on", vim="on")
            # Vim used to be reported by a `Vim: ON` status-bar button; that and the
            # other five preference buttons now live in the settings modal, so read
            # its checkbox instead. The control is in the DOM whether or not the
            # modal is displayed, so this stays side-effect free.
            check("Vim is on", page.evaluate(
                "() => document.querySelector('[data-el=\"vim\"]').checked"), True)
            press("Escape")
            check("Vim ON: Esc still enters cell Command mode",
                  body_has("cellmode-command"), True)
            start_cell, start_line = cell_no(), cursor_line()
            press("j")
            check("Vim ON: Esc then j moves by CELL, not by line (the gate beats Vim)",
                  cell_no(), start_cell + 1)
            check("Vim ON: j moved more than one line", cursor_line() > start_line + 1, True)
            before = doc_text()
            press("a")
            press("Escape")
            check("Vim ON: `a` inserted a cell rather than entering Vim INSERT",
                  doc_text() != before, True)

            # Esc must still reach Vim for its own INSERT exit.
            load(cells="on", vim="on")
            page.keyboard.press("i")          # Vim NORMAL -> INSERT
            page.wait_for_timeout(120)
            press("Escape")
            check("Vim ON: Esc from INSERT goes to NORMAL, not Command mode",
                  body_has("cellmode-command"), False)
            press("Escape")
            check("Vim ON: a second Esc (now in NORMAL) enters Command mode",
                  body_has("cellmode-command"), True)

            # ---------- cell-scoped `gg` / `G` (and with them `dG`) ----------
            # installCellMotions() replaces ONE upstream motion,
            # moveToLineOrEdgeOfDocument, which upstream maps to BOTH `gg` and `G`
            # and resolves dynamically per keystroke — so the operator-pending forms
            # come along for free. That is exactly why it needs real-Vim coverage:
            # cells.test.mjs can only assert cellContentLines(), not that Vim ever
            # calls it.
            #
            # DECK line map:  1 --- / 2 marp: true / 3 --- / 4 '' / 5 # One / 6 '' /
            # 7 alpha / 8 '' / 9 --- / 10 '' / 11 # Two / 12 '' / 13 beta / 14 '' /
            # 15 --- / 16 '' / 17 # Three / 18 '' / 19 gamma / 20 ''
            load(cells="on", vim="on")
            goto_line(13)                      # `beta`, inside body cell 2
            press("g")
            press("g")
            check("Vim ON + cells: gg stays in the cell, on its first CONTENT line",
                  cursor_line(), 11)
            press("G")
            check("Vim ON + cells: G stops at the cell's last content line",
                  cursor_line(), 13)

            # The count is deliberately NOT scoped: the line-number gutter shows
            # absolute numbers, so `5G` must keep meaning "go to line 5".
            press("5")
            press("G")
            check("Vim ON + cells: an explicit count is still an absolute line",
                  cursor_line(), 5)

            # The payoff. `dG` used to delete through the end of the DOCUMENT, i.e.
            # every following slide. Now it clears this cell's content and — because
            # `G` stops at the last content line rather than the slot edge — leaves
            # the blank line the next `---` needs (INV1).
            load(cells="on", vim="on")
            base = sep_count()
            goto_line(11)                      # `# Two`, first content line of cell 2
            press("d")
            press("G")
            after = doc_text()
            check("Vim ON + cells: dG leaves every separator in place",
                  sep_count(), base)
            check("Vim ON + cells: dG did not eat the following cells",
                  ("# Three" in after) and ("gamma" in after), True)
            check("Vim ON + cells: dG cleared this cell's content",
                  ("# Two" in after) or ("beta" in after), False)
            check("Vim ON + cells: dG kept the separators well-formed (INV1)",
                  bad_separators(after), [])
            page.keyboard.press("u")           # Vim undo
            page.wait_for_timeout(160)
            check("Vim ON + cells: dG is one undo step", doc_text(), DECK)

            # Non-regression: with cell mode OFF the override must be inert, since
            # its only gate is the presence of cellsField.
            load(cells="off", vim="on")
            goto_line(13)
            press("g")
            press("g")
            check("cells OFF: gg is document-wide again", cursor_line(), 1)
            press("G")
            check("cells OFF: G reaches the last line of the document",
                  cursor_line(), 20)

            # The escape hatch out of a cell needs no new binding: Vim only swallows
            # single-character keys, so Ctrl+Home / Ctrl+End reach the keymap facet
            # and defaultKeymap's cursorDocStart / cursorDocEnd still work.
            load(cells="on", vim="on")
            goto_line(13)
            page.keyboard.press("Control+End")
            page.wait_for_timeout(120)
            check("Vim ON + cells: Ctrl+End still reaches the document end",
                  cursor_line(), 20)
            page.keyboard.press("Control+Home")
            page.wait_for_timeout(120)
            check("Vim ON + cells: Ctrl+Home still reaches the document start",
                  cursor_line(), 1)

            # ---------- structural operations + single-step undo ----------
            load(cells="on", vim="off")
            base = sep_count()
            press("Escape")
            press("j")            # into body cell 2
            press("b")            # insert below
            check("`b` inserts a cell below", sep_count(), base + 1)
            page.keyboard.press("Control+z")
            page.wait_for_timeout(140)
            check("one Mod-z undoes the whole insert", sep_count(), base)

            press("Escape")
            press("a")            # insert above
            check("`a` inserts a cell above", sep_count(), base + 1)
            page.keyboard.press("Control+z")
            page.wait_for_timeout(140)
            check("one Mod-z undoes the insert-above", sep_count(), base)

            press("Escape")
            press("d")
            check("a lone `d` is a pending latch, not a delete", sep_count(), base)
            press("d")
            check("`dd` deletes the cell", sep_count(), base - 1)
            page.keyboard.press("Control+z")
            page.wait_for_timeout(140)
            check("one Mod-z undoes the whole delete", sep_count(), base)

            press("Escape")
            press("x")            # cut
            check("`x` cuts the cell", sep_count(), base - 1)
            press("v")            # paste below
            check("`v` pastes it back", sep_count(), base)

            press("Escape")
            press("M")            # merge with the cell below
            check("`Shift+M` merges with the next cell", sep_count(), base - 1)
            page.keyboard.press("Control+z")
            page.wait_for_timeout(140)
            check("one Mod-z undoes the merge", sep_count(), base)

            # Heading level.
            load(cells="on", vim="off")
            press("Escape")
            press("j")
            press("3")
            check("`3` sets the cell heading to level 3", "### One" in doc_text(), True)
            press("0")
            check("`0` removes the heading", "\nOne\n" in doc_text(), True)

            # ---------- run keys ----------
            load(cells="on", vim="off")
            press("Escape")
            press("j")
            page.evaluate("() => { window.__sentIpc.length = 0; }")
            page.keyboard.press("Shift+Enter")
            page.wait_for_timeout(200)
            sent = page.evaluate("() => window.__sentIpc.slice()")
            check("Shift+Enter syncs the preview (cursor or change IPC)",
                  any(m.startswith("editor:cursor:") or m.startswith("editor:change:")
                      for m in sent), True)
            check("Shift+Enter advances to the next cell", cell_no(), 3)
            check("Shift+Enter leaves the editor in Command mode",
                  body_has("cellmode-command"), True)
            before = doc_text()
            page.keyboard.press("Alt+Enter")
            page.wait_for_timeout(200)
            check("Alt+Enter inserts a cell below", doc_text() != before, True)
            check("Alt+Enter lands in Edit mode", body_has("cellmode-edit"), True)

            # ---------- OFF is a complete no-op ----------
            load(cells="off", vim="off")
            check("cell mode off: no body class", body_has("cell-mode"), False)
            check("cell mode off: no decorations",
                  page.evaluate("() => document.querySelectorAll('.cm-cell').length"), 0)
            check("cell mode off: no cell gutter",
                  page.evaluate("() => !!document.querySelector('.cm-cellNumbers')"), False)
            check("cell mode off: no CELL in the status bar", "CELL" in status(), False)
            before = doc_text()
            press("Escape")
            press("j")
            check("cell mode off: Esc then j does not enter Command mode",
                  body_has("cellmode-command"), False)
            # The whole point of the Compartment: with cell mode off the gate is not
            # registered, so `j` is an ordinary character and reaches the document.
            # The caret sits at offset 0 (nothing has moved it), so it lands there.
            check("cell mode off: `j` is typed into the document, not swallowed",
                  doc_text(), "j" + before)

            # Toggling on at runtime brings the chrome up. This was a `⌗ Cells`
            # status-bar button; it is now the settings modal's checkbox, which
            # calls the same setCells(). Clicking a checkbox fires `change` even
            # while the modal is hidden, so no open/close dance is needed.
            def toggle_cells():
                page.evaluate("() => document.querySelector('[data-el=\"cells\"]').click()")
                page.wait_for_timeout(200)

            toggle_cells()
            check("the settings toggle turns cell mode on", body_has("cell-mode"), True)
            check("turning it on adds the decorations",
                  page.evaluate("() => document.querySelectorAll('.cm-cell').length > 0"), True)
            toggle_cells()
            check("toggling it off drops every decoration in one transaction",
                  page.evaluate("() => document.querySelectorAll('.cm-cell').length"), 0)

            # ---------- marpSlides regression (it now shares mdBlocks.js) ----------
            # insertSlideAfter / cutSlide were rewritten onto padInsert and
            # unitDeleteRange, and scanSlides / slideAt are now re-exports. That path
            # had no automated coverage, so assert the deck stays well-formed:
            # Ctrl+Alt+N inserts one slide, Ctrl+Alt+X removes one, and neither leaves
            # a `---` that is not preceded by a blank line (which would silently
            # become a setext <h2> and merge two slides).
            load(cells="off", vim="off")       # the Marp helpers are independent of cell mode
            base = sep_count()
            page.evaluate("() => { const v=window.__editorView;"
                          " const p=v.state.doc.line(6).from;"
                          " v.dispatch({selection:{anchor:p}}); }")
            page.wait_for_timeout(100)
            page.keyboard.press("Control+Alt+n")
            page.wait_for_timeout(250)
            # The class picker modal opens; take the "(no class)" option.
            page.evaluate("() => document.querySelector('.slide-class-btn').click()")
            page.wait_for_timeout(250)
            check("+ Slide inserts exactly one slide", sep_count(), base + 1)
            check("+ Slide leaves no setext-ambiguous separator",
                  bad_separators(doc_text()), [])
            page.keyboard.press("Control+Alt+x")
            page.wait_for_timeout(300)
            check("Cut slide removes exactly one slide", sep_count(), base)
            check("Cut slide leaves no setext-ambiguous separator",
                  bad_separators(doc_text()), [])

            # ---------- cell N == preview slide N ----------
            # The core promise of the feature, and the one that fails silently: if
            # `run` sent the separator's own line instead of separator+1, every slide
            # would land one early. Rather than reimplementing cellRunLine here, this
            # drives the real gesture and reads the line out of the IPC the editor
            # actually posts, then compares it to the data-line the preview stamped on
            # the corresponding slide <svg>. Both sides are the shipping code.
            sample = os.path.join(repo_root, "samples", "cells.md").replace("\\", "/")
            with open(sample, "r", encoding="utf-8") as fh:
                sample_src = fh.read().replace("\r\n", "\n")

            pv = ctx.new_page()
            pv.goto("http://127.0.0.1:%d/index.html?file=%s" % (args.port, sample),
                    wait_until="domcontentloaded")
            pv.wait_for_function(
                "() => { const p=document.getElementById('preview');"
                " return p && p.children.length>0; }")
            shoot.wait_for_render(pv)
            slide_lines = pv.evaluate(
                "() => [...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')]"
                ".map(s => parseInt(s.getAttribute('data-line'), 10))")
            pv.close()
            check("the sample renders as a Marp deck with slides", len(slide_lines) > 1, True)

            load(cells="on", vim="off", doc=sample_src)
            run_lines = []
            press("Escape")
            press("Home")                      # first body cell == slide 1
            for _ in range(len(slide_lines)):
                page.evaluate("() => { window.__sentIpc.length = 0; }")
                page.keyboard.press("Control+Enter")   # run, stay
                page.wait_for_timeout(140)
                sent = page.evaluate("() => window.__sentIpc.slice()")
                line = None
                for m in sent:
                    if m.startswith("editor:cursor:"):
                        line = int(m.split(":")[2])
                    elif m.startswith("editor:change:"):
                        line = json.loads(m[len("editor:change:"):])["line"]
                run_lines.append(line)
                press("Escape")
                press("j")
            check("every cell's run line equals its slide's data-line "
                  "(cell N == slide N, no off-by-one-slide)", run_lines, slide_lines)

            check("no page errors over the whole run", errors, [])
            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print()
        for f in failures:
            print(f)
        print("\n%d check(s) failed" % len(failures))
        sys.exit(1)
    print("\nall cell-mode checks passed")


if __name__ == "__main__":
    main()

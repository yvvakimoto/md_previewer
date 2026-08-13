#!/usr/bin/env python3
"""Functional check for the companion editor's font zoom and settings modal.

``editorPrefs.test.mjs`` covers the pure layer (clamping, argument parsing, and
that ``Mod-Shift--`` stays unbound) under plain node. What it cannot see is
whether the bindings actually reach the editor, and that is where the real risk
sits:

* ``@replit/codemirror-vim`` swallows every key whose name is a single character
  while in a non-insert mode (``dist/index.js``: ``key.length === 1``). ``<C-=>``
  is longer, so a plain keymap layer suffices and none of the ``Prec.highest``
  DOM-gate machinery cells.js needs is required here. A dependency bump could
  widen that condition with no compile error anywhere — "Vim ON" below is the
  gate for exactly that.
* ``cells.js`` owns ``Mod-Shift--`` for "split cell". Zoom-out is the shift-less
  ``Mod--``, one modifier away. The split case below pins that they coexist.

Also covers what the settings-modal consolidation replaced: the six preference
buttons are gone from the status bar, and every pref must still be reachable.

Usage::

    python tools/preview-harness/prefscheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

# A deck, so the cell-split non-regression case has cells to work with.
DECK = (
    "---\nmarp: true\n---\n"
    "\n# One\n\nalpha\n\n---\n\n# Two\n\nbeta\n"
)

# Stands in for the Rust host. Must be an IIFE — add_init_script executes the
# string as a script body, so a bare `() => {...}` is evaluated and discarded,
# silently booting the editor with an empty document.
#
# add_init_script ACCUMULATES across calls and every one of them re-runs on each
# navigation, in the order added — so the most recently added wins. That is why
# %(font)s is a parameter rather than a blanket localStorage.clear(): the reload
# case needs one final script that leaves the font keys alone, and a clear() in
# any earlier script would wipe them on the way back in.
INIT_TMPL = """(() => {
  window.__initialFile = %(file)s;
  window.__marpUserThemes = [];
  window.__sentIpc = [];
  window.ipc = { postMessage: (m) => { window.__sentIpc.push(String(m)); } };
  try {
    localStorage.setItem('editor:cellMode', %(cells)s);
    localStorage.setItem('editor:vim', %(vim)s);
    localStorage.setItem('editor:livePreview', 'on');
    localStorage.setItem('editor:theme', 'light');
    localStorage.setItem('editor:lineNumbers', 'absolute');
    localStorage.setItem('editor:tableColHighlight', 'on');
    localStorage.setItem('editor:tablePaste', 'on');
    %(font)s
  } catch (e) {}
})();"""

# Default: start each load at the built-in font defaults.
FONT_RESET = ("localStorage.removeItem('editor:fontSize');"
              " localStorage.removeItem('editor:fontFamily');")

DEFAULT_PX = 15


def main():
    ap = argparse.ArgumentParser(description="companion editor font zoom / settings check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8778)
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

            def seed(cells="off", vim="off", doc=DECK, font=FONT_RESET):
                """Add an init script; the most recent one wins on the next load."""
                payload = {"path": "C:/tmp/deck.md", "content": doc, "line": 0}
                page.add_init_script(INIT_TMPL % {
                    "file": json.dumps(payload),
                    "cells": json.dumps(cells),
                    "vim": json.dumps(vim),
                    "font": font,
                })

            def load(cells="off", vim="off", doc=DECK, font=FONT_RESET):
                seed(cells, vim, doc, font)
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

            def content_px():
                """Computed font-size of the editing surface, in px (float)."""
                return page.evaluate(
                    "() => parseFloat(getComputedStyle("
                    "document.querySelector('.cm-content')).fontSize)")

            def gutter_px():
                return page.evaluate(
                    "() => { const g = document.querySelector("
                    "'.cm-lineNumbers .cm-gutterElement');"
                    " return g ? parseFloat(getComputedStyle(g).fontSize) : 0; }")

            def chrome_px():
                return page.evaluate(
                    "() => parseFloat(getComputedStyle("
                    "document.querySelector('.status-bar')).fontSize)")

            def ls(key):
                return page.evaluate("(k) => localStorage.getItem(k)", key)

            def doc_text():
                return page.evaluate("() => window.__editorView.state.doc.toString()")

            def modal_open():
                return page.evaluate(
                    "() => { const m = [...document.querySelectorAll('.cc-modal')]"
                    ".find(e => e.querySelector('h2') &&"
                    " e.querySelector('h2').textContent.includes('設定'));"
                    " return !!m && m.style.display === 'flex'; }")

            # ---------- boot ----------
            load()
            check("editor boots with no error", errors, [])
            check("default size is the historical 15px", content_px(), DEFAULT_PX)
            base_chrome = chrome_px()

            # ---------- keyboard zoom ----------
            press("Control+Equal")
            check("Ctrl+= grows the text", content_px(), DEFAULT_PX + 1)
            press("Control+Equal", 3)
            check("Ctrl+= is repeatable", content_px(), DEFAULT_PX + 4)
            press("Control+Minus", 2)
            check("Ctrl+- shrinks the text", content_px(), DEFAULT_PX + 2)
            press("Control+Digit0")
            check("Ctrl+0 resets", content_px(), DEFAULT_PX)
            # JP keyboards produce `=` only with Shift held.
            press("Control+Shift+Equal")
            check("Ctrl+Shift+= also grows (JP layout)", content_px(), DEFAULT_PX + 1)
            press("Control+Digit0")

            # The gutter is part of the editing surface and must track the text;
            # the status bar is chrome and must not.
            press("Control+Equal", 5)
            check("line-number gutter scales with the text", gutter_px(), DEFAULT_PX + 5)
            check("status bar does NOT scale", chrome_px(), base_chrome)
            check("clamps at the maximum", (press("Control+Equal", 20), content_px())[1], 32)
            press("Control+Minus", 40)
            check("clamps at the minimum", content_px(), 9)
            press("Control+Digit0")

            # ---------- persistence ----------
            press("Control+Equal", 3)
            check("size is persisted", ls("editor:fontSize"), str(DEFAULT_PX + 3))

            # Read the value back on a genuinely fresh boot. It has to be a SECOND
            # PAGE, not page.reload(): reloading replays every init script added so
            # far, and each of those clears the font keys, so the value under test
            # would be wiped on the way in. A new page in the same context shares
            # the origin's localStorage but carries only the script added to it.
            page2 = ctx.new_page()
            page2.set_default_timeout(20000)
            page2.on("pageerror", lambda e: errors.append("page2: " + str(e)))
            page2.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))

            def boot2(font=""):
                page2.add_init_script(INIT_TMPL % {
                    "file": json.dumps({"path": "C:/tmp/deck.md", "content": DECK, "line": 0}),
                    "cells": json.dumps("off"),
                    "vim": json.dumps("off"),
                    "font": font,
                })
                page2.goto("http://127.0.0.1:%d/editor.html" % args.port,
                           wait_until="domcontentloaded")
                page2.wait_for_function("() => !!window.__editorView")
                page2.wait_for_timeout(250)
                return page2.evaluate(
                    "() => parseFloat(getComputedStyle("
                    "document.querySelector('.cm-content')).fontSize)")

            check("size survives a fresh boot", boot2(), DEFAULT_PX + 3)
            check("no error on the fresh boot", errors, [])
            # A hand-edited / corrupt stored value must not break the boot.
            page2.evaluate("() => localStorage.setItem('editor:fontSize', 'garbage')")
            check("a corrupt stored size falls back to the default", boot2(), DEFAULT_PX)
            page2.evaluate("() => localStorage.removeItem('editor:fontSize')")
            page2.close()

            # ---------- Ctrl+wheel ----------
            load()
            page.mouse.move(500, 400)
            page.mouse.wheel(0, -120)
            page.wait_for_timeout(120)
            check("Ctrl+wheel is inert without Ctrl", content_px(), DEFAULT_PX)
            page.keyboard.down("Control")
            page.mouse.wheel(0, -120)
            page.wait_for_timeout(120)
            up = content_px()
            # One notch = one step, regardless of deltaY magnitude, so two
            # separate events are needed to move two steps.
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(120)
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(120)
            down = content_px()
            page.keyboard.up("Control")
            check("Ctrl+wheel up grows", up, DEFAULT_PX + 1)
            check("Ctrl+wheel down shrinks", down, DEFAULT_PX - 1)

            # ---------- Vim ON: the ordering fact ----------
            # If a dependency bump widens vim's key-swallowing condition beyond
            # `key.length === 1`, this is what catches it.
            load(vim="on")
            check("Vim boots with no error", errors, [])
            press("Escape")  # ensure NORMAL, the mode that swallows keys
            press("Control+Equal", 2)
            check("Ctrl+= works in Vim NORMAL", content_px(), DEFAULT_PX + 2)
            press("Control+Minus")
            check("Ctrl+- works in Vim NORMAL", content_px(), DEFAULT_PX + 1)
            press("Control+Digit0")
            check("Ctrl+0 works in Vim NORMAL", content_px(), DEFAULT_PX)
            press("i")  # INSERT
            press("Control+Equal")
            check("Ctrl+= works in Vim INSERT", content_px(), DEFAULT_PX + 1)
            press("Escape")
            press("Control+Digit0")

            # ---------- Ctrl+Shift+- must still split a cell ----------
            load(cells="on")
            before = doc_text().count("\n---\n")
            page.evaluate(
                "() => { const v = window.__editorView;"
                " const p = v.state.doc.line(6).from + 2;"   # inside "alpha"
                " v.dispatch({selection: {anchor: p}}); v.focus(); }")
            page.wait_for_timeout(80)
            px_before = content_px()
            press("Control+Shift+Minus")
            check("Ctrl+Shift+- still splits a cell", doc_text().count("\n---\n"), before + 1)
            check("Ctrl+Shift+- does NOT change the font size", content_px(), px_before)

            # ---------- settings modal ----------
            load()
            check("modal is closed at boot", modal_open(), False)
            check("status bar has the settings button",
                  page.evaluate(
                      "() => [...document.querySelectorAll('.status-btn')]"
                      ".some(b => b.textContent.includes('設定'))"), True)
            # The consolidation removed these six; if any survives, the bar and the
            # modal are both owning the same pref.
            check("old preference buttons are gone",
                  page.evaluate(
                      "() => [...document.querySelectorAll('.status-btn')]"
                      ".map(b => b.textContent).filter(t =>"
                      " /^(Vim:|Theme:|Live:|Col:|# |⌗ )/.test(t))"), [])
            page.evaluate(
                "() => [...document.querySelectorAll('.status-btn')]"
                ".find(b => b.textContent.includes('設定')).click()")
            page.wait_for_timeout(120)
            check("settings button opens the modal", modal_open(), True)
            check("modal shows the current size",
                  page.evaluate(
                      "() => document.querySelector('[data-el=\"font-value\"]').textContent"),
                  "15px")
            # A REAL mouse click, not an element.click(): Chromium does not move
            # focus on a programmatic click, which would make the focus assertion
            # below vacuous.
            page.click('[data-act="font-plus"]')
            page.wait_for_timeout(150)
            check("modal + button grows the text", content_px(), DEFAULT_PX + 1)
            check("modal readout follows",
                  page.evaluate(
                      "() => document.querySelector('[data-el=\"font-value\"]').textContent"),
                  "16px")
            # The setters normally hand focus back to the editor; refocusEditor()
            # must suppress that while the modal is up, or the next keystroke goes
            # into the document behind the backdrop.
            check("focus is not yanked into the editor",
                  page.evaluate(
                      "() => !!document.activeElement.closest('.cm-editor')"), False)
            check("focus stays in the modal",
                  page.evaluate(
                      "() => !!document.activeElement.closest('.cc-modal')"), True)
            page.evaluate("() => document.querySelector('[data-act=\"font-reset\"]').click()")
            page.wait_for_timeout(120)
            check("modal reset restores the default", content_px(), DEFAULT_PX)

            # Font family switch.
            fam_before = page.evaluate(
                "() => getComputedStyle(document.querySelector('.cm-scroller')).fontFamily")
            page.select_option('[data-el="font-family"]', "consolas")
            page.wait_for_timeout(120)
            fam_after = page.evaluate(
                "() => getComputedStyle(document.querySelector('.cm-scroller')).fontFamily")
            check("font family changes", fam_after != fam_before, True)
            check("font family is persisted", ls("editor:fontFamily"), "consolas")

            # A pref the status bar never exposed before the consolidation.
            page.evaluate("() => document.querySelector('[data-el=\"table-paste\"]').click()")
            page.wait_for_timeout(120)
            check("table paste is now reachable from the UI",
                  ls("editor:tablePaste"), "off")

            # Toggles round-trip through the same setters Vim's `:set` uses.
            page.evaluate("() => document.querySelector('[data-el=\"cells\"]').click()")
            page.wait_for_timeout(150)
            check("cell mode toggles from the modal", ls("editor:cellMode"), "on")
            page.evaluate(
                "() => document.querySelector('[data-seg=\"theme\"] [data-val=\"dark\"]').click()")
            page.wait_for_timeout(150)
            check("theme toggles from the modal", ls("editor:theme"), "dark")
            check("theme applies to the chrome",
                  page.evaluate("() => document.body.classList.contains('theme-dark')"), True)

            press("Escape")
            check("Esc closes the settings modal", modal_open(), False)
            check("Esc chain leaves no error", errors, [])

            # ---------- Vim :fontsize / :pref ----------
            load(vim="on")
            press("Escape")
            page.keyboard.type(":fontsize 22")
            press("Enter")
            check(":fontsize sets an absolute size", content_px(), 22)
            page.keyboard.type(":fontsize +3")
            press("Enter")
            check(":fontsize +N is relative", content_px(), 25)
            page.keyboard.type(":fontsize")
            press("Enter")
            check(":fontsize with no argument resets", content_px(), DEFAULT_PX)
            page.keyboard.type(":pref")
            press("Enter")
            check(":pref opens the settings modal", modal_open(), True)
            press("Escape")
            # `:set` must still resolve to the options switch, not to a new command.
            page.keyboard.type(":set nonumber")
            press("Enter")
            check(":set is still unambiguous", ls("editor:lineNumbers"), "off")
            check("no error from the Vim path", errors, [])

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("\n%d FAILED" % len(failures))
        sys.exit(1)
    print("\nall passed")


if __name__ == "__main__":
    main()

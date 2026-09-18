#!/usr/bin/env python3
"""Functional check for the editor's "save before closing?" confirm.

The interesting half of this feature is a handshake that spans two processes:
Rust stops a close gesture, calls ``window.__confirmClose(quitApp)`` and destroys
nothing until the answer arrives as
``editor:closeconfirm:<save|discard|cancel>:<editor|app>``. ``cargo test`` covers
the Rust parser (``editor_registry::parse_close_confirm``); what it cannot see is
whether the editor actually asks, actually answers, and answers with the right
scope. That is this file.

Three things here have already been a bug in a neighbouring modal and are pinned
deliberately:

* the confirm must sit **first** in the hard-coded newest-first Esc chain, and Esc
  there means *cancel the close* — not "dismiss and let the close proceed";
* "Save & Close" must emit ``editor:save:`` **before** the answer. Rust writes the
  file synchronously inside the save arm, so the ordering on this one channel is
  the whole reason a fire-and-forget ``doSave()`` is safe here;
* ``__confirmClose`` must re-check the JS ``dirty`` flag. Rust's mirror flips true
  on every ``editor:change:`` and is only corrected on transitions, so it can ask
  about a buffer that is actually clean.

Usage::

    python tools/preview-harness/quitcheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

DOC = "# Title\n\nalpha\n"
DOC_PATH = "C:/tmp/quit.md"

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
    localStorage.setItem('editor:cellMode', 'off');
    localStorage.setItem('editor:livePreview', 'on');
    localStorage.setItem('editor:theme', 'light');
  } catch (e) {}
})();"""


def main():
    ap = argparse.ArgumentParser(description="editor close-confirm check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8781)
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

            # The button labels asserted below are read out of window.__editorI18n, so
            # the language only has to be pinned, not matched to a machine.
            ctx = browser.new_context(viewport={"width": 1100, "height": 800},
                                      locale="ja-JP")
            ctx.add_init_script(shoot.ui_lang_init_script("ja"))
            page = ctx.new_page()
            page.set_default_timeout(20000)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            def on_console(m):
                if m.type == "error" and "favicon" not in m.text.lower():
                    errors.append("console.%s: %s" % (m.type, m.text))

            page.on("console", on_console)
            page.route("**/favicon.ico", lambda route: route.fulfill(status=200, body=""))

            def load(vim="off"):
                page.add_init_script(INIT_TMPL % {
                    "file": json.dumps({"path": DOC_PATH, "content": DOC, "line": 0}),
                    "vim": json.dumps(vim),
                })
                page.goto("http://127.0.0.1:%d/editor.html" % args.port,
                          wait_until="domcontentloaded")
                page.wait_for_function("() => !!window.__editorView")
                page.wait_for_timeout(250)
                page.evaluate("() => window.__editorView.focus()")
                page.wait_for_timeout(80)

            def ipc():
                return page.evaluate("() => window.__sentIpc.slice()")

            def clear_ipc():
                page.evaluate("() => { window.__sentIpc.length = 0; }")

            def confirms():
                """Only the answers, so the live-push noise stays out of the way."""
                return [m for m in ipc() if m.startswith("editor:closeconfirm:")]

            def quit_modal_open():
                return page.evaluate(
                    "() => { const b = document.querySelector('.quit-save');"
                    " const m = b && b.closest('.cc-modal');"
                    " return !!m && m.style.display === 'flex'; }")

            def pinned():
                return page.evaluate(
                    "() => document.body.classList.contains('status-pinned')")

            def make_dirty(vim=False, text="beta"):
                page.evaluate("() => window.__editorView.focus()")
                # Vim boots in NORMAL, where "beta" is four motions and the
                # document never changes — the buffer would stay clean and every
                # assertion below would pass vacuously.
                if vim:
                    page.keyboard.press("i")
                page.keyboard.type(text)
                if vim:
                    page.keyboard.press("Escape")
                # Past the 150ms live-push debounce, so the ordering assertions
                # below see a settled channel.
                page.wait_for_timeout(300)

            def is_dirty():
                return page.evaluate("() => document.title.startsWith('\\u2022 ')")

            # ---------- boot ----------
            load()
            check("editor boots with no error", errors, [])
            check("no confirm modal at boot", quit_modal_open(), False)
            check("buffer starts clean", is_dirty(), False)

            # ---------- clean buffer: never asks ----------
            # Rust asks on its own (possibly stale) dirty flag; the JS re-check is
            # what keeps a clean buffer from putting a pointless dialog on screen.
            clear_ipc()
            page.evaluate("() => window.__confirmClose(false)")
            page.wait_for_timeout(150)
            check("clean buffer shows no dialog", quit_modal_open(), False)
            check("clean buffer answers immediately",
                  confirms(), ["editor:closeconfirm:discard:editor"])
            check("clean buffer corrects Rust's dirty mirror first",
                  ipc()[0], "editor:dirty:false")

            # ---------- dirty buffer: asks ----------
            load()
            make_dirty()
            check("typing marks the buffer dirty", is_dirty(), True)
            clear_ipc()
            page.evaluate("() => window.__confirmClose(false)")
            page.wait_for_timeout(150)
            check("dirty buffer opens the dialog", quit_modal_open(), True)
            check("dialog answers nothing on its own", confirms(), [])
            check("status bar is pinned while the dialog is up", pinned(), True)
            check("dialog names the file",
                  page.evaluate("() => document.querySelector('.quit-file').textContent"),
                  "quit.md")
            # Wiring, not wording: the labels come from the same table the app
            # renders from, so this survives a copy edit but not a broken key.
            check("buttons are labelled from the i18n table",
                  page.evaluate(
                      "() => ['save', 'discard', 'cancel'].map(k =>"
                      " document.querySelector('.quit-' + k).textContent ==="
                      " window.__editorI18n['ed.quit.' + k].ja)"),
                  [True, True, True])

            # ---------- Save & Close ----------
            page.click(".quit-save")
            page.wait_for_timeout(200)
            check("save closes the dialog", quit_modal_open(), False)
            check("save unpins the status bar", pinned(), False)
            check("save answers with the save action",
                  confirms(), ["editor:closeconfirm:save:editor"])
            sent = ipc()
            saves = [i for i, m in enumerate(sent) if m.startswith("editor:save:")]
            answer = [i for i, m in enumerate(sent) if m.startswith("editor:closeconfirm:")]
            check("the file is written before the answer is sent",
                  bool(saves) and saves[-1] < answer[0], True)
            check("saving clears the dirty marker", is_dirty(), False)

            # ---------- Don't Save, app scope ----------
            load()
            make_dirty()
            clear_ipc()
            page.evaluate("() => window.__confirmClose(true)")
            page.wait_for_timeout(150)
            check("app-scope close opens the same dialog", quit_modal_open(), True)
            page.click(".quit-discard")
            page.wait_for_timeout(200)
            check("discard carries the app scope back",
                  confirms(), ["editor:closeconfirm:discard:app"])
            check("discard writes nothing",
                  [m for m in ipc() if m.startswith("editor:save:")], [])
            check("discard leaves the buffer dirty", is_dirty(), True)

            # ---------- Cancel ----------
            load()
            make_dirty()
            clear_ipc()
            page.evaluate("() => window.__confirmClose(false)")
            page.wait_for_timeout(150)
            page.click(".quit-cancel")
            page.wait_for_timeout(200)
            check("cancel closes the dialog", quit_modal_open(), False)
            check("cancel answers cancel",
                  confirms(), ["editor:closeconfirm:cancel:editor"])
            check("cancel writes nothing",
                  [m for m in ipc() if m.startswith("editor:save:")], [])

            # ---------- Esc is cancel, and it is first in the chain ----------
            clear_ipc()
            page.evaluate("() => window.__confirmClose(true)")
            page.wait_for_timeout(150)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            check("Esc closes the dialog", quit_modal_open(), False)
            check("Esc means cancel, with the scope kept",
                  confirms(), ["editor:closeconfirm:cancel:app"])
            check("Esc unpins the status bar", pinned(), False)

            # The settings modal is the one directly below it in the chain: with
            # both up, Esc must take the confirm and leave settings alone.
            clear_ipc()
            page.evaluate("() => window.__editorView.focus()")
            page.evaluate(
                "() => [...document.querySelectorAll('.status-btn')]"
                ".find(b => b.textContent.includes(window.__editorI18n['ed.status.settings'].ja))"
                ".click()")
            page.wait_for_timeout(120)
            page.evaluate("() => window.__confirmClose(false)")
            page.wait_for_timeout(150)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            check("Esc takes the confirm, not the settings modal below it",
                  (quit_modal_open(), confirms()),
                  (False, ["editor:closeconfirm:cancel:editor"]))
            check("the settings modal is still open",
                  page.evaluate(
                      "() => [...document.querySelectorAll('.cc-modal')]"
                      ".some(m => m.style.display === 'flex' &&"
                      " m.querySelector('[data-el=\"font-value\"]'))"), True)
            # This confirm is the only stackable modal here, so closing it must
            # not unpin the status bar out from under the one still on screen.
            check("the status bar stays pinned for the modal below", pinned(), True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(120)

            # ---------- Vim :q / :q! ----------
            load(vim="on")
            make_dirty(vim=True)
            check("the Vim buffer is really dirty", is_dirty(), True)
            clear_ipc()
            page.keyboard.press("Escape")  # NORMAL
            page.keyboard.type(":q")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":q on a dirty buffer asks instead of closing",
                  quit_modal_open(), True)
            check(":q sends no close while it is asking",
                  [m for m in ipc() if m.startswith("editor:close")], [])
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            clear_ipc()
            page.keyboard.press("Escape")
            page.keyboard.type(":q!")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":q! still closes unconditionally",
                  [m for m in ipc() if m.startswith("editor:close")],
                  ["editor:close:"])
            check(":q! puts up no dialog", quit_modal_open(), False)

            # A clean buffer must not be made to ask by the new branch.
            load(vim="on")
            clear_ipc()
            page.keyboard.press("Escape")
            page.keyboard.type(":q")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":q on a clean buffer closes straight away",
                  [m for m in ipc() if m.startswith("editor:close")],
                  ["editor:close:"])

            # `:wq` predates this feature and must be untouched: save, then close,
            # with no dialog in between.
            load(vim="on")
            make_dirty(vim=True)
            clear_ipc()
            page.keyboard.press("Escape")
            page.keyboard.type(":wq")
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            check(":wq saves and closes with no dialog",
                  (quit_modal_open(),
                   [m.split(":")[1] for m in ipc()
                    if m.startswith("editor:save:") or m.startswith("editor:close")]),
                  (False, ["save", "close"]))

            check("no error anywhere in the run", errors, [])

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

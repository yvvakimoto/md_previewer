#!/usr/bin/env python3
"""Functional check for the preview's keyboard shortcuts.

The DOM digest (``domdump.py``) proves the *render* is unchanged, but it cannot
see keyboard behavior — so a refactor of the shortcut plumbing needs its own
gate. This drives real keydown events in the harness and asserts the observable
effect of each shortcut, including the negative cases that the modifier and
text-entry guards exist for.

Usage::

    python tools/preview-harness/keycheck.py [--channel msedge|chrome]

Exits non-zero and prints ``FAIL:`` lines if any expectation is unmet.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402

# Collects the IPC messages the harness bootstrap would otherwise only console.debug.
_TAP_IPC = """() => {
  window.__sentIpc = [];
  const prev = window.ipc && window.ipc.postMessage;
  window.ipc = window.ipc || {};
  window.ipc.postMessage = (m) => { window.__sentIpc.push(m); if (prev) try { prev(m); } catch (e) {} };
}"""


def press(page, key, **mods):
    """Dispatch a trusted-enough keydown through the CDP input domain."""
    modifiers = []
    if mods.get("ctrl"):
        modifiers.append("Control")
    if mods.get("shift"):
        modifiers.append("Shift")
    if mods.get("alt"):
        modifiers.append("Alt")
    combo = "+".join(modifiers + [key]) if modifiers else key
    page.keyboard.press(combo)
    page.wait_for_timeout(120)


def body_has(page, cls):
    return page.evaluate("(c) => document.body.classList.contains(c)", cls)


def main():
    ap = argparse.ArgumentParser(description="preview-harness keyboard shortcut check")
    ap.add_argument("--channel", default=None)
    ap.add_argument("--port", type=int, default=8773)
    ap.add_argument("--doc", default="samples/sample.md")
    ap.add_argument("--marp-doc", default="samples/marp.md")
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
            failures.append("FAIL: %s -> got %r, want %r" % (name, got, want))
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

            ctx = browser.new_context(viewport={"width": 1440, "height": 900},
                                      locale="ja-JP")
            page = ctx.new_page()
            page.add_init_script(shoot.ui_lang_init_script("ja"))
            page.set_default_timeout(20000)

            def load(doc):
                url = "http://127.0.0.1:%d/index.html?file=%s" % (
                    args.port, os.path.join(repo_root, doc).replace("\\", "/"))
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => { const p=document.getElementById('preview');"
                    " return p && p.children.length>0; }")
                shoot.wait_for_render(page)
                page.evaluate(_TAP_IPC)
                page.evaluate("() => document.body.focus()")

            # ---------- plain body-class toggles (L / W / N) ----------
            load(args.doc)
            for key, cls, store in [("l", "show-line-numbers", "showLineNumbers"),
                                    ("w", "wide", "wide"),
                                    ("n", "numbered", "numbered")]:
                before = body_has(page, cls)
                press(page, key)
                check("%s toggles body.%s" % (key.upper(), cls), body_has(page, cls), not before)
                check("%s persists localStorage.%s" % (key.upper(), store),
                      page.evaluate("(k) => localStorage.getItem(k)", store),
                      "true" if not before else "false")
                press(page, key)  # restore
                check("%s toggles back" % key.upper(), body_has(page, cls), before)

            # ---------- uppercase / caps must work too ----------
            press(page, "W")
            check("Shift+W still toggles (case-insensitive)", body_has(page, "wide"), True)
            press(page, "W")

            # ---------- dark mode (M) ----------
            before_dark = body_has(page, "dark-mode")
            press(page, "m")
            page.wait_for_timeout(400)  # M re-renders
            check("M toggles body.dark-mode", body_has(page, "dark-mode"), not before_dark)
            press(page, "m")
            page.wait_for_timeout(400)

            # ---------- autofit (A) ----------
            before_fit = page.evaluate("() => localStorage.getItem('marpAutofit')")
            press(page, "a")
            after_fit = page.evaluate("() => localStorage.getItem('marpAutofit')")
            check("A flips localStorage.marpAutofit", after_fit != before_fit, True)
            press(page, "a")

            # ---------- modals (S / H / Escape) ----------
            press(page, "s")
            check("S opens the style modal",
                  page.evaluate("() => !!document.querySelector('#style-modal.visible')"), True)
            # The ⚙ button is added asynchronously (the @user-vars spec comes
            # from fetching the CSS), so wait for it rather than sampling.
            page.wait_for_function(
                "() => document.querySelectorAll('#style-modal .style-gear').length > 0")
            gears = page.evaluate(
                "() => [...document.querySelectorAll('#style-modal tr.style-row')]"
                ".filter(tr => tr.querySelector('.style-gear'))"
                ".map(tr => tr.dataset.style).sort()")
            check("only styles declaring @user-vars get a gear",
                  gears, ["bunko.css", "tategaki.css"])

            page.evaluate(
                "() => document.querySelector"
                "('tr.style-row[data-style=\"bunko.css\"] .style-gear').click()")
            page.wait_for_function("() => !document.getElementById('style-vars-pane').hidden")
            check("the gear opens the settings pane for that style",
                  page.evaluate("() => document.getElementById('style-modal-title').textContent"),
                  "bunko.css の設定")
            check("...and hides the style list",
                  page.evaluate("() => document.querySelector('#style-modal table').hidden"), True)
            check("...with one control per declared variable",
                  page.evaluate(
                      "() => document.querySelectorAll('#style-vars-pane .sv-row').length"), 10)
            # The nombre is a select whose value IS the CSS `display`, so the
            # pane's own control is what turns the page numbers on and off.
            check("every page carries a nombre by default",
                  page.evaluate(
                      "() => [...document.querySelectorAll('#preview > .md-page')]"
                      ".every(p => getComputedStyle(p, '::after').display === 'block')"), True)
            page.evaluate(
                "() => { const sels=[...document.querySelectorAll('#style-vars-pane select')];"
                " const el=sels[sels.length-1]; el.value='none';"
                " el.dispatchEvent(new Event('change', {bubbles:true})); }")
            page.wait_for_timeout(200)
            check("turning the nombre off hides every page number",
                  page.evaluate(
                      "() => [...document.querySelectorAll('#preview > .md-page')]"
                      ".every(p => getComputedStyle(p, '::after').display === 'none')"), True)
            check("...without re-splitting the document",
                  page.evaluate("() => document.querySelectorAll('#preview > .md-page').length > 1"), True)
            # Live-apply: the 版面 is driven purely by the CSS custom properties,
            # so moving a slider must resize #preview with no re-render.
            page.evaluate(
                "() => { const el = document.querySelector('#style-vars-pane input[type=range]');"
                " el.value = '30';"
                " el.dispatchEvent(new Event('input', {bubbles:true}));"
                " el.dispatchEvent(new Event('change', {bubbles:true})); }")
            page.wait_for_timeout(200)
            check("a slider retunes the live layout",
                  page.evaluate("() => getComputedStyle(preview).height"), "510px")  # 30 chars x 17px
            check("...and persists per style",
                  page.evaluate("() => JSON.parse(localStorage.getItem('styleVars:bunko.css'))"
                                "['--bunko-chars']"), "30")
            page.evaluate("() => document.querySelector('#style-vars-pane .sv-reset').click()")
            page.wait_for_timeout(200)
            check("the reset button clears the override",
                  page.evaluate("() => localStorage.getItem('styleVars:bunko.css')"), None)
            check("...and restores the CSS default",
                  page.evaluate("() => getComputedStyle(preview).height"), "663px")  # 39 chars
            press(page, "Escape")
            check("Escape closes the style modal",
                  page.evaluate("() => !!document.querySelector('#style-modal.visible')"), False)
            # Reopening must land on the list, never mid-form.
            press(page, "s")
            check("reopening starts on the style list",
                  page.evaluate("() => document.getElementById('style-vars-pane').hidden"), True)
            press(page, "Escape")
            # Leave the document on the baseline style for the checks that follow.
            page.evaluate("() => applyUserStyle(null)")
            shoot.wait_for_render(page)

            press(page, "h")
            check("H opens the help modal",
                  page.evaluate("() => !!document.querySelector('#help-modal.visible')"), True)
            press(page, "Escape")
            check("Escape closes the help modal",
                  page.evaluate("() => !!document.querySelector('#help-modal.visible')"), False)

            # ---------- IPC-posting shortcuts (E / X / Ctrl+N / Ctrl+D) ----------
            page.evaluate("() => { window.__sentIpc.length = 0; }")
            press(page, "e")
            sent = page.evaluate("() => window.__sentIpc.slice()")
            check("E posts openeditor:", any(m.startswith("openeditor:") for m in sent), True)

            page.evaluate("() => { window.__sentIpc.length = 0; }")
            press(page, "n", ctrl=True)
            sent = page.evaluate("() => window.__sentIpc.slice()")
            check("Ctrl+N posts newfile:", "newfile:" in sent, True)

            page.evaluate("() => { window.__sentIpc.length = 0; }")
            press(page, "d", ctrl=True)
            sent = page.evaluate("() => window.__sentIpc.slice()")
            check("Ctrl+D posts openinstalldir:", "openinstalldir:" in sent, True)

            # ---------- negative: modifiers must suppress plain keys ----------
            page.evaluate("() => { window.__sentIpc.length = 0; }")
            before = body_has(page, "wide")
            press(page, "w", ctrl=True)
            check("Ctrl+W does NOT toggle wide", body_has(page, "wide"), before)
            press(page, "w", alt=True)
            check("Alt+W does NOT toggle wide", body_has(page, "wide"), before)

            # Shift is excluded from the Ctrl-combos on purpose.
            page.evaluate("() => { window.__sentIpc.length = 0; }")
            press(page, "n", ctrl=True, shift=True)
            sent = page.evaluate("() => window.__sentIpc.slice()")
            check("Ctrl+Shift+N posts nothing", sent, [])

            # ---------- negative: text-entry focus must suppress shortcuts ----------
            page.evaluate("""() => {
              const d = document.createElement('div');
              d.id = 'kc-edit'; d.contentEditable = 'true'; d.textContent = 'x';
              document.body.appendChild(d); d.focus();
            }""")
            before = body_has(page, "wide")
            press(page, "w")
            check("W in a contenteditable does NOT toggle wide", body_has(page, "wide"), before)
            page.evaluate("() => { window.__sentIpc.length = 0; }")
            press(page, "n", ctrl=True)
            check("Ctrl+N in a contenteditable posts nothing",
                  page.evaluate("() => window.__sentIpc.slice()"), [])
            page.evaluate("() => { const d=document.getElementById('kc-edit'); d && d.remove(); }")

            # ---------- Marp deck navigation (P / arrows) ----------
            load(args.marp_doc)
            press(page, "p")
            mode1 = page.evaluate(
                "() => document.body.classList.contains('deck-mode') ? 'deck'"
                " : document.body.classList.contains('list-mode') ? 'list' : 'scroll'")
            check("P changes the Marp view mode", mode1 != "scroll", True)
            # Get into deck mode regardless of where the cycle started.
            for _ in range(3):
                if page.evaluate("() => document.body.classList.contains('deck-mode')"):
                    break
                press(page, "p")
            check("P reaches deck mode",
                  page.evaluate("() => document.body.classList.contains('deck-mode')"), True)
            ACTIVE_IDX = ("() => { const all = [...document.querySelectorAll("
                          "'div.marpit > svg[data-marpit-svg]')];"
                          " return all.findIndex(s => s.classList.contains('active')); }")
            idx0 = page.evaluate(ACTIVE_IDX)
            press(page, "ArrowRight")
            check("ArrowRight advances the deck",
                  page.evaluate(ACTIVE_IDX), idx0 + 1)
            press(page, "ArrowLeft")
            check("ArrowLeft goes back",
                  page.evaluate(ACTIVE_IDX), idx0)
            press(page, "End")
            last = page.evaluate(
                "() => document.querySelectorAll('div.marpit > svg[data-marpit-svg]').length - 1")
            check("End jumps to the last slide",
                  page.evaluate(ACTIVE_IDX), last)
            press(page, "Home")
            check("Home jumps to the first slide",
                  page.evaluate(ACTIVE_IDX), 0)

            # ---------- autofit leaves no residual scrollbar (A) ----------
            # fitMarpSlides() sizes the .marp-fit-body scroll region from its own
            # measurement of the body's content height, so if the two disagree the
            # slide keeps a scrollbar on content the fit report calls fitted. The DOM
            # digest cannot see this (it records the inline px, not whether they hold
            # the content), and it is exactly how the marp.md 定義リスト slide broke:
            # the measurement ran with overflow:visible, which collapses the body's
            # trailing margin OUT of scrollHeight, while the applied overflow-y:auto
            # makes the wrapper a BFC and contains it -- 16px of overflow.
            FIT_STATE = """() => [...document.querySelectorAll(
              'div.marpit > svg[data-marpit-svg] > foreignObject > section')]
              .map((s, i) => {
                const b = s.querySelector(':scope > .marp-fit-body');
                if (!b) return null;
                const m = /scale\(([\d.]+)\)/.exec(b.style.transform || '');
                return { i: i + 1, fitted: !!b.style.height,
                         scale: m ? parseFloat(m[1]) : 1,
                         scrolls: b.scrollHeight > b.clientHeight + 0.5 };
              }).filter(Boolean)"""

            def fit_state():
                """Measure every slide in scroll layout (a display:none deck slide
                reports 0 and is skipped by the fit pass)."""
                page.evaluate("() => { document.body.classList.remove('deck-mode','list-mode');"
                              " fitMarpSlides(); }")
                page.wait_for_timeout(200)
                page.evaluate("() => fitMarpSlides()")
                return page.evaluate(FIT_STATE)

            def want_autofit(on):
                for _ in range(2):
                    cur = page.evaluate("() => localStorage.getItem('marpAutofit')") != "false"
                    if cur == on:
                        return
                    press(page, "a")

            want_autofit(True)
            st = fit_state()
            check("autofit shrinks at least one slide", any(s["fitted"] for s in st), True)
            check("no shrunk-to-fit slide keeps a scrollbar",
                  [s["i"] for s in st if s["scale"] > 0.5001 and s["scrolls"]], [])
            check("a slide floored at the 0.5 minimum stays scrollable",
                  any(s["scale"] <= 0.5001 and s["scrolls"] for s in st), True)
            want_autofit(False)
            check("with autofit off an overflowing body scrolls instead of clipping",
                  any(s["fitted"] and s["scrolls"] and s["scale"] == 1 for s in fit_state()), True)
            want_autofit(True)

            # ---------- context menus (__createContextMenu) ----------
            load("samples/math.md")
            MENU = "() => document.querySelectorAll('.app-context-menu .app-menu-item').length"
            VISIBLE = ("() => { const m = document.querySelector('.app-context-menu');"
                       " return !!m && m.style.display !== 'none'; }")

            def right_click_center(selector):
                """Right-click an element's center via raw mouse coords.

                Playwright's actionability check rejects `.katex` (its own inner
                spans "intercept" pointer events), but the app resolves the target
                with closest('.katex'), so hitting a descendant is equivalent.
                """
                box = page.evaluate("""(sel) => {
                  const el = document.querySelector(sel);
                  if (!el) return null;
                  el.scrollIntoView({ block: 'center' });
                  const r = el.getBoundingClientRect();
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }""", selector)
                assert box, "selector not found: %s" % selector
                page.mouse.click(box["x"], box["y"], button="right")
                page.wait_for_timeout(150)

            # Right-clicking rendered math opens the copy menu...
            right_click_center("#preview .katex")
            check("right-click on KaTeX opens the menu", page.evaluate(VISIBLE), True)
            check("...with two copy items", page.evaluate(MENU), 2)
            labels = page.evaluate(
                "() => [...document.querySelectorAll('.app-context-menu .app-menu-item')]"
                ".map(i => i.textContent)")
            check("...labelled Copy MathML / Copy LaTeX", labels, ["Copy MathML", "Copy LaTeX"])
            check("...and neither is disabled",
                  page.evaluate("() => [...document.querySelectorAll("
                                "'.app-context-menu .app-menu-item.disabled')].length"), 0)

            # Escape dismisses it.
            press(page, "Escape")
            check("Escape dismisses the context menu", page.evaluate(VISIBLE), False)

            # ...but right-clicking plain prose must fall through to the native menu.
            right_click_center("#preview p:not(:has(.katex))")
            check("right-click on prose shows no in-app menu", page.evaluate(VISIBLE), False)

            # Clamped inside the viewport even when opened at the far corner.
            box = page.evaluate("() => { const k = document.querySelector('#preview .katex');"
                                " k.scrollIntoView(); const r = k.getBoundingClientRect();"
                                " return {x: r.left + 2, y: r.top + 2}; }")
            page.mouse.move(box["x"], box["y"])
            page.mouse.click(box["x"], box["y"], button="right")
            page.wait_for_timeout(150)
            fits = page.evaluate("""() => {
              const m = document.querySelector('.app-context-menu');
              if (!m || m.style.display === 'none') return null;
              const r = m.getBoundingClientRect();
              return r.right <= window.innerWidth && r.bottom <= window.innerHeight
                  && r.left >= 0 && r.top >= 0;
            }""")
            check("the menu is clamped inside the viewport", fits, True)
            press(page, "Escape")

            # ---------- diagram memoization (__diagCacheHit / __diagSource) ----------
            # The DOM digest only proves the FIRST render. These caches are keyed by
            # (theme-salt + source), so a dark→light round trip must miss on the dark
            # key and then HIT the original light key, landing back on identical DOM.
            for doc, sel in [("samples/sample.md", ".mermaid"),
                             ("samples/abcjs.md", ".abc-notation"),
                             ("samples/markwhen.md", ".markwhen-timeline")]:
                load(doc)
                snap = ("(s) => [...document.querySelectorAll(s)]"
                        ".map(e => e.innerHTML).join('\\u0000')")
                before = page.evaluate(snap, sel)
                check("%s renders content" % sel, len(before) > 100, True)
                press(page, "m")          # -> dark: fresh key, cache miss
                page.wait_for_timeout(500)
                shoot.wait_for_render(page)
                dark = page.evaluate(snap, sel)
                press(page, "m")          # -> light: must HIT the original key
                page.wait_for_timeout(500)
                shoot.wait_for_render(page)
                after = page.evaluate(snap, sel)
                check("%s is byte-identical after a dark/light round trip" % sel,
                      after, before)
                if sel == ".abc-notation":
                    # abc's key is deliberately un-salted (its SVG is recoloured by
                    # CSS only), so the dark render must be the SAME cached bytes.
                    check("abc cache is theme-independent", dark, before)
                elif sel == ".mermaid":
                    # mermaid re-renders per theme, so dark must actually differ.
                    check("mermaid cache is theme-salted", dark != before, True)

            errors = page.evaluate("() => (window.__kcErrors || [])")
            check("no uncaught page errors recorded", errors, [])

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    if failures:
        print()
        for f in failures:
            print(f)
        print("\n%d check(s) FAILED" % len(failures))
        sys.exit(1)
    print("\nall keyboard checks passed")


if __name__ == "__main__":
    main()

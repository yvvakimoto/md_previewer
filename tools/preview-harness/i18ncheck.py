#!/usr/bin/env python
"""Integrity checks for the two UI-language string tables.

    python tools/preview-harness/i18ncheck.py [--channel msedge|chrome]

There are ~250 messages across two tables — assets/index.html's inline `I18N`
and tools/build-editor/i18n.js — and the one thing a human reviewing that many
strings will not do reliably is notice a missing `en`, a placeholder that exists
in one variant but not the other, or a `common.*` entry that has drifted apart
between the two windows. That is what this checks.

Both tables are read out of the LIVE pages (window.__I18N / window.__editorI18n)
rather than parsed from source, so this also proves the editor bundle that ships
actually contains what the source says it does.

The two key spaces are disjoint by construction — i18n.js owns `ed.*`,
index.html owns everything else — so `common.*` is the only overlap, and it must
be byte-identical.
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shoot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LANGS = ("ja", "en")
PLACEHOLDER = re.compile(r"\{(\w+)\}")

fail = 0


def check(label, got, want=True):
    global fail
    ok = got == want
    if not ok:
        fail += 1
    print(("ok   " if ok else "FAIL ") + label
          + ("" if ok else "  got=%r want=%r" % (got, want)))


def audit(name, table):
    """Every message must carry both languages and agree on placeholders."""
    missing = []
    empty = []
    mismatched = []
    for key, msg in sorted(table.items()):
        if not isinstance(msg, dict):
            missing.append(key)
            continue
        for lang in LANGS:
            if lang not in msg:
                missing.append("%s[%s]" % (key, lang))
            elif not isinstance(msg[lang], str) or not msg[lang].strip():
                empty.append("%s[%s]" % (key, lang))
        if all(isinstance(msg.get(l), str) for l in LANGS):
            # A few messages legitimately use different placeholders per language
            # (the calendar month title reads "{year}年 {month}月" but
            # "{monthName} {year}"), so they declare `params` and are checked
            # as a subset of that rather than for strict parity.
            declared = msg.get("params")
            ja = set(PLACEHOLDER.findall(msg["ja"]))
            en = set(PLACEHOLDER.findall(msg["en"]))
            if declared:
                allowed = set(declared)
                if not (ja <= allowed and en <= allowed):
                    mismatched.append("%s (ja=%s en=%s declared=%s)"
                                      % (key, sorted(ja), sorted(en), sorted(allowed)))
            elif ja != en:
                mismatched.append("%s (ja=%s en=%s)" % (key, sorted(ja), sorted(en)))

    check("%s: every message has ja and en" % name, missing, [])
    check("%s: no empty translation" % name, empty, [])
    check("%s: placeholders agree across languages" % name, mismatched, [])
    return len(table)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", default=None, help="browser channel: msedge | chrome (auto)")
    ap.add_argument("--port", type=int, default=8778)
    a = ap.parse_args()

    assets_dir = os.path.join(REPO_ROOT, "assets")
    httpd = shoot.start_harness(a.port, REPO_ROOT, assets_dir)
    try:
        with sync_playwright() as p:
            channels = [a.channel] if a.channel else ["msedge", "chrome", None]
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

            ctx = browser.new_context(locale="ja-JP")
            page = ctx.new_page()
            page.set_default_timeout(20000)

            # --- preview table ---
            page.goto("http://127.0.0.1:%d/index.html" % a.port, wait_until="domcontentloaded")
            page.wait_for_function("() => !!window.__I18N")
            preview = page.evaluate("() => window.__I18N")

            # --- editor table (same origin, so the shared uiLang key is the same one) ---
            page.add_init_script(
                "(() => { window.__initialFile = { path: 'C:/tmp/a.md', content: '', line: 0 };"
                "  window.__marpUserThemes = [];"
                "  window.ipc = { postMessage: () => {} }; })()")
            page.goto("http://127.0.0.1:%d/editor.html" % a.port, wait_until="domcontentloaded")
            page.wait_for_function("() => !!window.__editorI18n")
            editor = page.evaluate("() => window.__editorI18n")

            print("preview: %d messages / editor: %d messages"
                  % (len(preview), len(editor)))

            audit("preview", preview)
            audit("editor", editor)

            # The tables are separate files that cannot import each other (the
            # preview is a monolith with one inline <script>), so the shared
            # subset is the only place they can drift.
            pc = {k: v for k, v in preview.items() if k.startswith("common.")}
            ec = {k: v for k, v in editor.items() if k.startswith("common.")}
            check("common.* present in both", bool(pc) and bool(ec))
            check("common.* has the same keys", sorted(pc), sorted(ec))
            same = [k for k in sorted(set(pc) & set(ec))
                    if all(pc[k].get(l) == ec[k].get(l) for l in LANGS)]
            check("common.* is byte-identical across the two tables",
                  sorted(set(pc) & set(ec)), same)

            # Outside common.*, an overlapping key means someone put a message in
            # the wrong table — the namespaces are supposed to be disjoint.
            overlap = sorted((set(preview) & set(editor)) - set(pc))
            check("no key collision outside common.*", overlap, [])
            check("the editor owns only ed.* and common.*",
                  sorted(k for k in editor if not k.startswith(("ed.", "common."))), [])
            check("the preview owns no ed.* key",
                  sorted(k for k in preview if k.startswith("ed.")), [])

            browser.close()
    finally:
        httpd.shutdown()

    print("\n%d FAILED" % fail if fail else "\nall i18n table checks passed")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()

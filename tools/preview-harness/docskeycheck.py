#!/usr/bin/env python
"""Keep the landing page's shortcut list honest against the app's help modal.

    python tools/preview-harness/docskeycheck.py [--strict]

`docs/index.html`'s `#keys` section republishes the app's own keyboard-shortcut
list. Two hand-written lists of the same 21 facts in two files go stale, and the
stale one here is the PUBLIC one — so this pairs them and fails when the keys
themselves disagree.

The source of truth is the `<table>` inside `#help-modal` in `assets/index.html`.

STDLIB ONLY -- no Playwright, no Chromium, well under a second. Every other
`*check.py` here drives a real browser because it is checking behaviour; this
one checks two literal HTML tables plus two literal JS string tables, all four
of which sit on disk. Keeping it dependency-free is the point: it is cheap
enough for a pre-commit hook, and someone with no browser installed can still
run it. `serve.py`'s stdlib-only discipline is the precedent.

Distinct from `keycheck.py`, which drives real keydown events at the app and
asserts their observable effects. This one executes nothing.

WHAT IS COMPARED, and why it is paired by i18n-key suffix rather than by row
order: the page regroups the modal's 21 rows into three editorial groups (the
window / open+export / Marp), so its document order legitimately differs from
the modal's. A positional compare would fail on day one for a reason that is a
feature. Both sides are therefore reduced to {suffix: (caps, ja, en)} and
compared per suffix, `keys.h` against `help.key.h`.

  key caps differ, or a suffix exists on one side only  -> FAIL
  a description differs (and the suffix is not ADAPTED) -> WARN

Caps are the hard gate because a key printed on a public page that the app does
not implement (or vice versa) is simply wrong. Descriptions are the soft gate
because the app's wording can be legitimately edited by a commit that has no
business touching `docs/`.

The editor group has no counterpart in the modal and is excluded by its
`data-sc-scope="editor"`. A `.sc-group` carrying NO `data-sc-scope` is an
error, so the exclusion is fail-closed: a fifth group can neither drag editor
rows into the comparison nor quietly dodge it.
"""

import argparse
import difflib
import html as htmllib
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

APP_HTML = os.path.join(REPO_ROOT, "assets", "index.html")
DOCS_HTML = os.path.join(REPO_ROOT, "docs", "index.html")
DOCS_JS = os.path.join(REPO_ROOT, "docs", "assets", "site.js")

LANGS = ("ja", "en")

# The two rows the page deliberately rewords, because the app's wording names
# the modal it lives in and that is meaningless on a web page:
#
#   h    app: このヘルプの表示 / 非表示   page: アプリ内のショートカット一覧の表示 / 非表示
#   esc  app: このダイアログを閉じる       page: 開いているモーダルを閉じる（新しいものから順に）
#
# Their key caps are still compared; only the description compare is waived.
# If the APP's string for one of these changes, that is warned about too — the
# rewording may need revisiting.
ADAPTED = {
    "h": {
        "ja": "このヘルプの表示 / 非表示",
        "en": "Show / hide this help",
    },
    "esc": {
        "ja": "このダイアログを閉じる",
        "en": "Close this dialog",
    },
}

fail = 0
warnings = []


def check(label, got, want=True):
    global fail
    ok = got == want
    if not ok:
        fail += 1
    print(("ok   " if ok else "FAIL ") + label
          + ("" if ok else "  got=%r want=%r" % (got, want)))


def warn(msg):
    warnings.append(msg)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# ---------------------------------------------------------------- normalisation

TAG_RE = re.compile(r"<[^>]+>")


def norm_caps(markup):
    """Reduce a key cell's markup to a comparable string.

    Both sides use the same markup shape -- one nowrap span per combination with
    the " /" separator INSIDE it -- so stripping tags yields the same text on
    each, e.g. 'Ctrl++ / Ctrl+- / Ctrl+0'. No per-side special-casing, which is
    the whole reason the page hand-writes its caps in the modal's shape.
    """
    text = htmllib.unescape(TAG_RE.sub("", markup))
    text = re.sub(r"\s+", " ", text).strip()
    return text.rstrip("/").strip()


def norm_desc(text):
    return re.sub(r"\s+", " ", htmllib.unescape(TAG_RE.sub("", text))).strip()


# ------------------------------------------------------------- JS string tables

def js_table(src, key_re):
    """Pull {key: {ja, en}} out of a literal JS object of single-quoted strings.

    Both tables are plain object literals with no computed values, so one regex
    per entry is enough and no JS engine is needed. Values use literal
    typographic apostrophes (style's), not escapes, so unescaping \\' and \\\\
    covers everything that occurs.
    """
    pat = re.compile(
        r"'(" + key_re + r")'\s*:\s*\{\s*"
        r"ja\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*"
        r"en\s*:\s*'((?:[^'\\]|\\.)*)'",
        re.S)
    out = {}
    for m in pat.finditer(src):
        out[m.group(1)] = {
            "ja": m.group(2).replace("\\'", "'").replace("\\\\", "\\"),
            "en": m.group(3).replace("\\'", "'").replace("\\\\", "\\"),
        }
    return out


# ------------------------------------------------------------------- app side

def app_rows():
    """{suffix: (caps, ja, en)} from the <table> inside #help-modal."""
    src = read(APP_HTML)
    i18n = js_table(src, r"help\.(?:key|cell)\.[\w.]+")

    start = src.find('id="help-modal"')
    if start < 0:
        check("app: #help-modal found", False)
        return {}, i18n
    tstart = src.find("<table", start)
    tend = src.find("</table>", tstart)
    if tstart < 0 or tend < 0:
        check("app: help-modal <table> found", False)
        return {}, i18n
    table = src[tstart:tend]

    rows = {}
    for tr in re.finditer(r"<tr>(.*?)</tr>", table, re.S):
        row = tr.group(1)
        km = re.search(r'<td class="keys"(.*?)>(.*?)</td>', row, re.S)
        dm = re.search(r'data-i18n="help\.key\.([\w.]+)"', row)
        if not km or not dm:
            continue
        suffix = dm.group(1)
        attrs, inner = km.group(1), km.group(2)
        cell_key = re.search(r'data-i18n(?:-html)?="(help\.cell\.[\w.]+)"', attrs)
        if cell_key:
            entry = i18n.get(cell_key.group(1))
            if entry is None:
                check("app: %s resolves in __I18N" % cell_key.group(1), False)
                continue
            inner = entry["ja"]
        desc = i18n.get("help.key." + suffix)
        rows[suffix] = (
            norm_caps(inner),
            norm_desc(desc["ja"]) if desc else None,
            norm_desc(desc["en"]) if desc else None,
        )
    return rows, i18n


# ------------------------------------------------------------------ docs side

def docs_section(src):
    """Slice #keys by COUNTING <section> depth.

    The group cards are nested <section>s, so searching for the first
    '</section>' ends after group 1 -- and a checker that then compares eight
    rows against twenty would report drift for the wrong reason, or (if the app
    side were also mis-sliced) pass while comparing almost nothing. This is the
    one extraction detail worth spelling out.
    """
    start = src.find('<section id="keys"')
    if start < 0:
        return None
    depth = 0
    for m in re.finditer(r"<section\b|</section>", src[start:]):
        depth += 1 if m.group(0).startswith("<section") else -1
        if depth == 0:
            return src[start:start + m.end()]
    return None


def docs_rows():
    """({suffix: (caps, ja, en)}, referenced_keys) for data-sc-scope=preview."""
    src = read(DOCS_HTML)
    table = js_table(read(DOCS_JS), r"keys\.[\w.]+")

    sec = docs_section(src)
    check("docs: #keys section found and balanced", sec is not None)
    if sec is None:
        return {}, set(), table

    referenced = set(re.findall(r'data-i18n(?:-html)?="(keys\.[\w.]+)"', sec))

    # Every group must declare its scope. A missing attribute is an error rather
    # than a default so the editor exclusion cannot be widened by accident.
    groups = re.findall(r'<section class="sc-group"([^>]*)>', sec)
    unscoped = [g for g in groups if "data-sc-scope=" not in g]
    check("docs: every .sc-group declares data-sc-scope", unscoped, [])

    rows = {}
    nested = []
    for gm in re.finditer(
            r'<section class="sc-group" data-sc-scope="preview">(.*?)</section>',
            sec, re.S):
        for rm in re.finditer(r'<div class="sc-row">(.*?)</div>', gm.group(1), re.S):
            row = rm.group(1)
            # Proves the non-greedy </div> above is still safe. If someone nests
            # a <div> in a row, say so rather than silently reading half a row.
            if "<div" in row:
                nested.append(row[:60])
            km = re.search(r'<dt class="sc-keys"(.*?)>(.*?)</dt>', row, re.S)
            dm = re.search(r'<dd class="sc-desc" data-i18n="keys\.([\w.]+)"', row)
            if not km or not dm:
                continue
            suffix = dm.group(1)
            attrs, inner = km.group(1), km.group(2)
            cell_key = re.search(r'data-i18n(?:-html)?="(keys\.cell\.[\w.]+)"', attrs)
            if cell_key:
                entry = table.get(cell_key.group(1))
                if entry is None:
                    check("docs: %s resolves in I18N" % cell_key.group(1), False)
                    continue
                inner = entry["ja"]
            desc = table.get("keys." + suffix)
            rows[suffix] = (
                norm_caps(inner),
                norm_desc(desc["ja"]) if desc else None,
                norm_desc(desc["en"]) if desc else None,
            )
    check("docs: no .sc-row contains a nested <div>", nested, [])
    return rows, referenced, table


# ---------------------------------------------------------------------- compare

def compare():
    app, _app_i18n = app_rows()
    page, referenced, table = docs_rows()

    # A regex that matched nothing must never read as "no drift".
    check("app: help modal yielded >= 21 rows", len(app) >= 21, True)
    check("docs: preview groups yielded >= 21 rows", len(page) >= 21, True)

    check("docs: no shortcut is missing from the page",
          sorted(set(app) - set(page)), [])
    check("docs: the page invents no shortcut",
          sorted(set(page) - set(app)), [])

    shared = sorted(set(app) & set(page))
    bad_caps = [s for s in shared if app[s][0] != page[s][0]]
    check("key caps agree with the app's help modal", bad_caps, [])
    for s in bad_caps:
        warn("caps %-10s app=%r page=%r" % (s, app[s][0], page[s][0]))

    for s in shared:
        for i, lang in enumerate(LANGS, start=1):
            a, p = app[s][i], page[s][i]
            if a is None or p is None or a == p:
                continue
            if s in ADAPTED:
                continue
            warn("desc %s (%s):\n%s" % (s, lang, "".join(
                difflib.unified_diff([a + "\n"], [p + "\n"],
                                     fromfile="app", tofile="page"))))

    # An ADAPTED rewording is justified against a specific app string. If that
    # string moved on, the rewording may no longer say the right thing.
    for s, expected in ADAPTED.items():
        if s not in app:
            continue
        for lang in LANGS:
            if app[s][LANGS.index(lang) + 1] != norm_desc(expected[lang]):
                warn("ADAPTED %r (%s): the app string changed to %r -- revisit "
                     "the page's rewording" % (s, lang, app[s][LANGS.index(lang) + 1]))

    # The page has no other guard that a data-i18n key exists: a typo renders
    # the key itself as visible text. Scoped to keys.* to keep this checker's
    # remit honest -- generalising it to the whole table is an obvious follow-up.
    check("docs: every keys.* referenced in the HTML exists in I18N",
          sorted(referenced - set(table)), [])
    check("docs: every keys.* in I18N is referenced by the HTML",
          sorted(set(table) - referenced), [])
    check("docs: every keys.* carries a non-empty en",
          sorted(k for k, v in table.items() if not v.get("en", "").strip()), [])

    src = read(DOCS_HTML)
    check('docs: nav.site-nav links #keys', 'href="#keys"' in src)
    check('docs: #keys anchor exists', 'id="keys"' in src)


def report(warn_only=False):
    """Run the comparison. Returns the failure count.

    `warn_only` is for shoot-docs.py, whose exit code means "did the images get
    written" -- the same reason check_gallery_sources() only warns there. The
    standalone entry point below fails instead, because ITS exit code means
    exactly "do the two lists agree".
    """
    global fail
    fail = 0
    del warnings[:]
    compare()
    for w in warnings:
        sys.stderr.write("WARN: %s\n" % w)
    if warn_only and fail:
        sys.stderr.write("WARN: %d docs shortcut check(s) failed -- run "
                         "tools/preview-harness/docskeycheck.py\n" % fail)
        return 0
    return fail


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--strict", action="store_true",
                    help="treat description warnings as failures too")
    args = ap.parse_args()

    n = report()
    if args.strict and warnings:
        n += len(warnings)
    print("\n%d FAILED" % n if n else "\nall docs shortcut checks passed")
    sys.exit(1 if n else 0)


if __name__ == "__main__":
    main()

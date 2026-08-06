"""End-to-end check of the preview's table edit mode in the harness.

Drives real clicks and asserts the exact `savefile:` payload, so the whole round trip
(locate -> parse -> edit -> emit -> splice) is verified with no Rust host.

Note: the harness has no Rust host, so a commit never comes back as a re-render and
`currentMarkdownRaw` keeps its original value. Each committing scenario therefore
reloads the page first — and the fact that a SECOND commit on a stale grid is refused
is itself asserted below (that is the refuse-first guard doing its job).

Line endings: the table editor is deliberately EOL-preserving (`tblReplaceLines`
splices by offset precisely so a CRLF file stays CRLF), and git `core.autocrlf=true`
checks `samples/table.md` out with CRLF on Windows. So a payload's line endings are a
property of the CHECKOUT, not of the behaviour under test. Every assertion here goes
through `content_of()`, which normalizes to LF — and the preservation itself is
asserted separately against the file's actual bytes, so the fixture's EOL style is
covered rather than merely tolerated. (No `.gitattributes` pin: forcing `samples/*.md`
to LF would rewrite every sample in the working copy, and a CRLF fixture is worth
having since it exercises the offset-splice path.)
"""
import json, os, sys

# Japanese fixtures and the ⊞ in a failure message are unprintable in the console's
# default cp932 on a Japanese Windows, which turned a plain assertion failure into a
# UnicodeEncodeError traceback that hid the real diff.
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

DOC = os.path.join(REPO, "samples", "table.md")
# Text mode applies universal newlines, so SRC is LF regardless of the checkout.
with open(DOC, encoding="utf-8") as _fh:
    SRC = _fh.read()
# The raw bytes tell us what the editor is expected to write back.
with open(DOC, "rb") as _fh:
    SRC_IS_CRLF = b"\r\n" in _fh.read()
PORT = 8794
URL = "http://127.0.0.1:%d/index.html?file=%s" % (PORT, DOC.replace("\\", "/"))

TAP = """() => {
  window.__sentIpc = [];
  const prev = window.__ipcOrig || (window.ipc && window.ipc.postMessage);
  window.__ipcOrig = prev;
  window.ipc = window.ipc || {};
  window.ipc.postMessage = (m) => { window.__sentIpc.push(m); if (prev) try { prev(m); } catch (e) {} };
}"""

ENTER_FIRST = """() => {
  const t = document.querySelector('#preview table[data-line]');
  t.closest('.table-block-wrapper').querySelector('.table-edit-button').click();
  return !!document.querySelector('.table-editing');
}"""

failures = []
def check(name, got, want):
    if got != want:
        failures.append(name)
        print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
    else:
        print("ok   %s" % name)

def fresh(pg):
    pg.goto(URL)
    pg.wait_for_selector("#preview table", timeout=20000)
    pg.wait_for_timeout(700)
    pg.evaluate(TAP)

def sent(pg, prefix="savefile:"):
    return pg.evaluate("(p) => window.__sentIpc.filter(m => m.indexOf(p) === 0)", prefix)

def raw_content_of(msg):
    """The `content` field of a `savefile:` payload, verbatim."""
    return json.loads(msg[len("savefile:"):])["content"]

def content_of(msg):
    """`content` with line endings normalized to LF — see the module docstring.

    Every content assertion below uses this so the suite passes on a CRLF checkout
    and an LF one alike; EOL preservation gets its own assertion instead.
    """
    return raw_content_of(msg).replace("\r\n", "\n")

httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ================= inventory =================
        fresh(pg)
        inv = pg.evaluate("""() => [...document.querySelectorAll('#preview .table-block-wrapper')].map(w => ({
            csv: w.classList.contains('csv-table'),
            nested: !!w.closest('blockquote'),
            hasEdit: !!w.querySelector('.table-edit-button'),
        }))""")
        print("tables found: %d" % len(inv))
        check("csv table gets no edit button", [t["hasEdit"] for t in inv if t["csv"]], [False])
        check("every non-csv table gets an edit button",
              sorted(set(t["hasEdit"] for t in inv if not t["csv"])), [True])

        # ================= nested table refuses =================
        msg = pg.evaluate("""() => {
            const t = document.querySelector('#preview blockquote table');
            if (!t) return 'NO NESTED TABLE IN FIXTURE';
            t.closest('.table-block-wrapper').querySelector('.table-edit-button').click();
            return document.getElementById('toast').textContent;
        }""")
        check("nested table refused", msg, "This table can't be edited (nested tables are unsupported)")
        check("nested table did not enter edit mode",
              pg.evaluate("() => !!document.querySelector('.table-editing')"), False)

        # ================= enter edit mode =================
        check("entered edit mode", pg.evaluate(ENTER_FIRST), True)
        st = pg.evaluate("""() => {
            const w = document.querySelector('.table-editing');
            return {
              header: [...w.querySelectorAll('thead th')].map(e => e.textContent),
              row0:   [...w.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map(e => e.textContent),
              editable: [...w.querySelectorAll('th,td')].every(e => e.getAttribute('contenteditable') === 'plaintext-only'),
              commitShown: w.querySelector('.table-commit-button').style.display !== 'none',
              copyHidden: w.querySelector('.table-copy-button').style.display === 'none',
            };
        }""")
        check("header shows source", st["header"], ["項目", "担当", "状態"])
        check("row shows source", st["row0"], ["設計", "Alice", "完了"])
        check("cells editable", st["editable"], True)
        check("commit shown / copy hidden", [st["commitShown"], st["copyHidden"]], [True, True])

        # ================= context menu =================
        items = pg.evaluate("""() => {
            const w = document.querySelector('.table-editing');
            w.querySelectorAll('tbody tr')[0].querySelectorAll('td')[0]
             .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
            return [...document.querySelectorAll('.app-context-menu .app-menu-item')].map(e => ({
                label: e.textContent, disabled: e.classList.contains('disabled') }));
        }""")
        check("menu labels", [i["label"] for i in items], [
            "Insert row above", "Insert row below", "Delete row",
            "Insert column left", "Insert column right", "Delete column",
            "Align column left", "Align column center", "Align column right"])
        check("nothing disabled at 3x3", [i["label"] for i in items if i["disabled"]], [])
        hdr = pg.evaluate("""() => {
            document.querySelector('.table-editing thead th')
              .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
            return [...document.querySelectorAll('.app-context-menu .app-menu-item')]
              .filter(e => e.classList.contains('disabled')).map(e => e.textContent);
        }""")
        check("header disables row ops", hdr, ["Insert row above", "Insert row below", "Delete row"])

        # ================= edit a cell -> commit =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("""() => { document.querySelector('.table-editing tbody tr:nth-child(2) td:nth-child(3)')
                                 .textContent = 'レビュー中'; }""")
        pg.evaluate("() => document.querySelector('.table-editing .table-commit-button').click()")
        s = sent(pg)
        check("one savefile: for a cell edit", len(s), 1)
        check("cell edit payload", content_of(s[0]),
              SRC.replace("| 実装 | Bob | 進行中 |", "| 実装 | Bob | レビュー中 |"))
        # The documented guarantee: the splice is offset-based, so the file's own EOLs
        # survive untouched. Derived from the fixture's bytes, so this asserts real
        # behaviour on either kind of checkout instead of hard-coding one.
        check("payload keeps the file's line endings",
              "\r\n" in raw_content_of(s[0]), SRC_IS_CRLF)
        check("exited edit mode", pg.evaluate("() => !!document.querySelector('.table-editing')"), False)
        check("cells no longer editable after commit",
              pg.evaluate("() => !!document.querySelector('#preview [contenteditable]')"), False)

        # Re-entering must read from the SOURCE, not from the stale on-screen grid.
        # (No Rust host here, so the source still says 進行中 even though the grid shows
        # レビュー中 — the source is the single truth.)
        pg.evaluate(TAP)
        again = pg.evaluate("""() => {
            const t = document.querySelector('#preview table[data-line]');
            t.closest('.table-block-wrapper').querySelector('.table-edit-button').click();
            const w = document.querySelector('.table-editing');
            return { editing: !!w,
                     cell: w ? w.querySelector('tbody tr:nth-child(2) td:nth-child(3)').textContent : null };
        }""")
        check("re-entering edit mode re-reads the source", again["editing"], True)
        check("re-read shows the source value, not the stale grid", again["cell"], "進行中")
        pg.evaluate("() => document.querySelector('.table-editing .table-cancel-button').click()")

        # ================= insert a row -> commit =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("""() => {
            document.querySelector('.table-editing tbody tr td')
              .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
            [...document.querySelectorAll('.app-context-menu .app-menu-item')]
              .find(e => e.textContent === 'Insert row below').click();
        }""")
        check("grid gained a row", pg.evaluate("() => document.querySelectorAll('.table-editing tbody tr').length"), 4)
        pg.evaluate("() => document.querySelector('.table-editing .table-commit-button').click()")
        s2 = sent(pg)
        check("one savefile: for the row insert", len(s2), 1)
        lines = content_of(s2[0]).split("\n")
        i = lines.index("| 設計 | Alice | 完了 |")
        check("blank row inserted after 設計", lines[i + 1], "|  |  |  |")
        check("following row intact", lines[i + 2], "| 実装 | Bob | 進行中 |")

        # Now the on-screen grid has 4 rows but the source still has 3 (no Rust host),
        # so the shape cross-check must refuse rather than splice the wrong span.
        pg.evaluate(TAP)
        stale = pg.evaluate("""() => {
            const t = document.querySelector('#preview table[data-line]');
            t.closest('.table-block-wrapper').querySelector('.table-edit-button').click();
            return { editing: !!document.querySelector('.table-editing'),
                     toast: document.getElementById('toast').textContent };
        }""")
        check("shape mismatch refuses to edit", stale["editing"], False)
        check("shape mismatch toast", stale["toast"], "Table source and rendering don't match")

        # ================= delete a column -> commit =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("""() => {
            document.querySelector('.table-editing tbody tr td')
              .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
            [...document.querySelectorAll('.app-context-menu .app-menu-item')]
              .find(e => e.textContent === 'Delete column').click();
        }""")
        pg.evaluate("() => document.querySelector('.table-editing .table-commit-button').click()")
        s3 = sent(pg)
        check("one savefile: for the column delete", len(s3), 1)
        l3 = content_of(s3[0]).split("\n")
        check("column removed from header", l3[l3.index("| 担当 | 状態 |")], "| 担当 | 状態 |")
        check("column removed from a row", "| Alice | 完了 |" in l3, True)

        # ================= alignment change =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("""() => {
            document.querySelector('.table-editing tbody tr td')
              .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
            [...document.querySelectorAll('.app-context-menu .app-menu-item')]
              .find(e => e.textContent === 'Align column center').click();
        }""")
        pg.evaluate("() => document.querySelector('.table-editing .table-commit-button').click()")
        s4 = sent(pg)
        l4 = content_of(s4[0]).split("\n")
        check("delimiter row got the centre marker", l4[l4.index("| :-: | --- | --- |")], "| :-: | --- | --- |")

        # ================= hand-aligned table keeps its padding =================
        fresh(pg)
        pg.evaluate("""() => {
            const t = [...document.querySelectorAll('#preview table[data-line]')]
              .find(x => x.tHead && x.tHead.rows[0].cells[0].textContent === 'Name');
            t.closest('.table-block-wrapper').querySelector('.table-edit-button').click();
            document.querySelector('.table-editing tbody tr td:nth-child(2)').textContent = 'lead';
        }""")
        pg.evaluate("() => document.querySelector('.table-editing .table-commit-button').click()")
        s5 = sent(pg)
        check("one savefile: for the aligned table", len(s5), 1)
        check("hand-aligned padding preserved",
              "| Alice |   lead   |  2021 |" in content_of(s5[0]), True)

        # ================= cancel writes nothing =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("""() => {
            const w = document.querySelector('.table-editing');
            w.querySelector('tbody td').textContent = 'CHANGED';
            w.querySelector('.table-cancel-button').click();
        }""")
        pg.wait_for_timeout(400)
        check("cancel posts no savefile:", len(sent(pg)), 0)
        check("cancel left edit mode", pg.evaluate("() => !!document.querySelector('.table-editing')"), False)
        check("cancel restored the rendered cell",
              pg.evaluate("() => document.querySelector('#preview table[data-line] tbody td').textContent"), "設計")

        # ================= a cell click must not emit jumpto: =================
        fresh(pg)
        pg.evaluate(ENTER_FIRST)
        pg.evaluate("() => document.querySelector('.table-editing tbody td').click()")
        check("cell click emits no jumpto:", len(sent(pg, "jumpto:")), 0)

        # ================= inbound render aborts the session =================
        pg.evaluate("""() => window.loadFileFromRust({ filename: 'other.md', filepath: 'C:/tmp/other.md',
            content: '# other\\n\\nno tables here\\n', raw: '# other\\n\\nno tables here\\n' })""")
        pg.wait_for_timeout(600)
        check("inbound render aborted the edit",
              pg.evaluate("() => !!document.querySelector('.table-editing')"), False)
        check("abort toast", pg.evaluate("() => document.getElementById('toast').textContent"),
              "Table editing cancelled")

        check("no uncaught page errors", errors, [])
        b.close()
finally:
    httpd.shutdown()

print()
print("%d FAILURES: %s" % (len(failures), ", ".join(failures)) if failures else "ALL PASS")
sys.exit(1 if failures else 0)

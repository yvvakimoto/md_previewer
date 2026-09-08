"""End-to-end check of the preview's task-list checkbox toggle in the harness.

Clicks real checkboxes and asserts the exact `savefile:` payload, so the whole round
trip (locate -> scan -> cross-check -> one-line splice) is verified with no Rust host.

What only an end-to-end check can see: that the k-th checkbox on screen resolves to the
k-th `- [ ]` line of ITS OWN block and not of the document, for the six shapes the
fixture carries (top level, nested, ordered, loose, inside a blockquote, mixed with
plain bullets); that a `- [ ]` inside a fence is invisible to the scan rather than
shifting the mapping by one; that consecutive clicks compose through `__taskPendingRaw`
instead of the second one dropping the first; and that the Marp pipeline -- where the
checkbox is synthesized by applyTaskLists() from literal text and the `[data-line]`
ancestor is the slide's <svg> -- resolves to the same lines.

No Rust host here, so a toggle never comes back as a re-render: `currentMarkdownRaw`
keeps its original value and `__taskPendingRaw` is what carries a click forward. That is
exactly the in-flight window the pending text exists for, so testing it here is testing
the real thing.

Line endings: the splice is offset-based precisely so a CRLF file stays CRLF, and git
`core.autocrlf=true` makes a checkout's EOLs a property of the machine rather than of
the behaviour. Content assertions therefore go through `content_of()` (LF-normalized),
and EOL preservation gets its own assertion driven by a synthetic CRLF document pushed
through `loadFileFromRust` -- which pins it regardless of how the fixture was checked
out.
"""
import json, os, sys

# Japanese fixtures are unprintable in the console's default cp932 on a Japanese
# Windows, which turns a plain assertion failure into a UnicodeEncodeError traceback
# that hides the real diff.
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

DOC = os.path.join(REPO, "samples", "tasklist.md")
MARP_DOC = os.path.join(REPO, "samples", "marp.md")
# Text mode applies universal newlines, so these are LF regardless of the checkout.
with open(DOC, encoding="utf-8") as _fh:
    SRC = _fh.read()
with open(MARP_DOC, encoding="utf-8") as _fh:
    MARP_SRC = _fh.read()
PORT = 8796
URL = "http://127.0.0.1:%d/index.html?file=%s" % (PORT, DOC.replace("\\", "/"))
MARP_URL = "http://127.0.0.1:%d/index.html?file=%s" % (PORT, MARP_DOC.replace("\\", "/"))

# Same selector pair the app uses (applyTaskLists' tight <li> / loose <li> > <p> hosts).
BOX_SEL = ("#preview li.task-list-item > input[type=checkbox],"
           " #preview li.task-list-item > p:first-child > input[type=checkbox]")

TAP = """() => {
  window.__sentIpc = [];
  const prev = window.__ipcOrig || (window.ipc && window.ipc.postMessage);
  window.__ipcOrig = prev;
  window.ipc = window.ipc || {};
  window.ipc.postMessage = (m) => { window.__sentIpc.push(m); if (prev) try { prev(m); } catch (e) {} };
}"""

CLICK_NTH = """(a) => {
  const boxes = [...document.querySelectorAll(a.sel)];
  if (!boxes[a.n]) return 'NO SUCH CHECKBOX: ' + a.n + ' of ' + boxes.length;
  boxes[a.n].click();
  return boxes.length;
}"""

failures = []
def check(name, got, want):
    if got != want:
        failures.append(name)
        print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
    else:
        print("ok   %s" % name)

def fresh(pg, url=URL):
    pg.goto(url)
    pg.wait_for_selector("#preview li.task-list-item input[type=checkbox]", timeout=20000)
    pg.wait_for_timeout(700)
    pg.evaluate(TAP)

def sent(pg, prefix="savefile:"):
    return pg.evaluate("(p) => window.__sentIpc.filter(m => m.indexOf(p) === 0)", prefix)

def raw_content_of(msg):
    """The `content` field of a `savefile:` payload, verbatim."""
    return json.loads(msg[len("savefile:"):])["content"]

def content_of(msg):
    """`content` with line endings normalized to LF - see the module docstring."""
    return raw_content_of(msg).replace("\r\n", "\n")

def click(pg, n, sel=BOX_SEL):
    return pg.evaluate(CLICK_NTH, {"sel": sel, "n": n})

def one_line_diff(before, after):
    """(1-based line, old, new) for a change that touched exactly one line."""
    a, b = before.split("\n"), after.split("\n")
    if len(a) != len(b):
        return ("LINE COUNT CHANGED", len(a), len(b))
    diff = [(i + 1, a[i], b[i]) for i in range(len(a)) if a[i] != b[i]]
    if len(diff) != 1:
        return ("NOT EXACTLY ONE CHANGED LINE", diff, None)
    return diff[0]

# Every checkbox in samples/tasklist.md, in document order, with the source line it must
# resolve to. Hard-coded on purpose: derived expectations would reimplement the mapping
# under test, and the whole point is to pin the six shapes against the real fixture.
CASES = [
    ("top level 1",     0,  "- [x] 企画・要件定義",              "- [ ] 企画・要件定義"),
    ("top level 2",     1,  "- [ ] 設計",                        "- [x] 設計"),
    ("top level 3",     2,  "- [ ] 実装",                        "- [x] 実装"),
    ("nested parent",   3,  "- [ ] リリース準備",                "- [x] リリース準備"),
    ("nested child 1",  4,  "  - [x] リリースノートを書く",      "  - [ ] リリースノートを書く"),
    ("nested child 2",  5,  "  - [ ] インストーラをビルドする",  "  - [x] インストーラをビルドする"),
    ("nested child 3",  6,  "  - [ ] タグを打つ",                "  - [x] タグを打つ"),
    ("after the nest",  7,  "- [ ] 公開",                        "- [x] 公開"),
    ("ordered 1",       8,  "1. [x] 見積もりを出す",             "1. [ ] 見積もりを出す"),
    ("ordered 2",       9,  "2. [ ] 発注する",                   "2. [x] 発注する"),
    ("ordered 3",       10, "3. [ ] 検収する",                   "3. [x] 検収する"),
    ("loose 1",         11, "- [x] 一次レビュー",                "- [ ] 一次レビュー"),
    ("loose 2",         12, "- [ ] 二次レビュー",                "- [x] 二次レビュー"),
    ("loose 3",         13, "- [ ] 最終確認",                    "- [x] 最終確認"),
    ("blockquote 1",    14, "> - [x] 命名を直す",                "> - [ ] 命名を直す"),
    ("blockquote 2",    15, "> - [ ] テストを足す",              "> - [x] テストを足す"),
    ("mixed list 1",    16, "- [ ] 混在した項目",                "- [x] 混在した項目"),
    ("mixed list 2",    17, "- [x] 混在した項目",                "- [ ] 混在した項目"),
]

CRLF_DOC = "- [ ] one\r\n- [ ] two\r\n"

httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        # The refusal assertions below are written against the English toast text, so
        # pin the UI language rather than inheriting OS auto-detect (which would pass in
        # Japan and fail elsewhere). The payload assertions are language-neutral.
        pg.add_init_script(shoot.ui_lang_init_script("en"))
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ================= inventory =================
        fresh(pg)
        inv = pg.evaluate("""(sel) => {
            const boxes = [...document.querySelectorAll(sel)];
            return {
                count: boxes.length,
                enabled: boxes.every(b => !b.disabled),
                pointer: boxes.every(b => getComputedStyle(b).cursor === 'pointer'),
                state: boxes.map(b => b.checked ? 'x' : ' ').join(''),
                tagged: boxes.every(b => !!b.closest('li.task-list-item')),
            };
        }""", BOX_SEL)
        check("every task line rendered a checkbox", inv["count"], len(CASES))
        check("checkboxes are interactive", inv["enabled"], True)
        check("checkboxes show a pointer cursor", inv["pointer"], True)
        check("checkboxes carry .task-list-item", inv["tagged"], True)
        check("initial states match the fixture",
              inv["state"], "".join("x" if "[x]" in c[2] else " " for c in CASES))

        # ================= every shape resolves to its own line =================
        # A fresh page per case: with no Rust host the round trip never lands, so a
        # second click in the same page would be a compose case, tested separately.
        for name, n, before, after in CASES:
            fresh(pg)
            click(pg, n)
            s = sent(pg)
            if len(s) != 1:
                check("%s: one savefile:" % name, [len(s), pg.evaluate(
                    "() => document.getElementById('toast').textContent")], [1, ""])
                continue
            check("%s: exactly one line, flipped in place" % name,
                  one_line_diff(SRC, content_of(s[0]))[1:], (before, after))

        # The fence in section 6 is what would break the mapping if the scan saw it, so
        # assert directly that its lines are never the ones spliced.
        fresh(pg)
        click(pg, 16)
        check("a fence's `- [ ]` is never spliced",
              [ln for ln in content_of(sent(pg)[0]).split("\n")
               if "これは記法の説明" in ln],
              ["- [ ] これは記法の説明なのでチェックボックスにならない"])

        # ================= consecutive clicks compose =================
        fresh(pg)
        click(pg, 1)
        click(pg, 2)
        s = sent(pg)
        check("two clicks post two savefile:", len(s), 2)
        check("the second payload keeps the first toggle", content_of(s[1]),
              SRC.replace("- [ ] 設計", "- [x] 設計").replace("- [ ] 実装", "- [x] 実装"))

        # ================= a checkbox click emits no jumpto: =================
        fresh(pg)
        click(pg, 0)
        check("checkbox click emits no jumpto:", len(sent(pg, "jumpto:")), 0)

        # ================= inbound content is authoritative =================
        # loadFileFromRust must clear the pending text, or a toggle made before the
        # navigation would be spliced into the NEW document.
        fresh(pg)
        click(pg, 1)
        pg.evaluate("""() => window.loadFileFromRust({ filename: 'other.md',
            filepath: 'C:/tmp/other.md',
            content: '# other\\n\\n- [ ] alpha\\n', raw: '# other\\n\\n- [ ] alpha\\n' })""")
        pg.wait_for_timeout(600)
        pg.evaluate(TAP)
        click(pg, 0)
        s = sent(pg)
        check("pending text dropped on an inbound render", len(s), 1)
        check("splice is against the new document", content_of(s[0]),
              "# other\n\n- [x] alpha\n")

        # ================= EOLs are preserved =================
        fresh(pg)
        pg.evaluate("""(raw) => window.loadFileFromRust({ filename: 'crlf.md',
            filepath: 'C:/tmp/crlf.md', content: raw.replace(/\\r\\n/g, '\\n'), raw })""", CRLF_DOC)
        pg.wait_for_timeout(600)
        pg.evaluate(TAP)
        click(pg, 1)
        s = sent(pg)
        check("CRLF document: one savefile:", len(s), 1)
        check("CRLF document keeps its CRLFs", raw_content_of(s[0]),
              "- [ ] one\r\n- [x] two\r\n")

        # ================= no file open -> refused =================
        fresh(pg)
        pg.evaluate("() => { window.currentFilePathBackup = null; }")
        refused = pg.evaluate("""(a) => {
            // Same document, no path: the drop-zone / harness-less case.
            window.loadFileFromRust({ filename: 'x.md', filepath: '',
                content: '- [ ] a\\n', raw: '- [ ] a\\n' });
            return new Promise(r => setTimeout(() => {
                const box = document.querySelector(a.sel);
                box.click();
                r({ toast: document.getElementById('toast').textContent, checked: box.checked });
            }, 600));
        }""", {"sel": BOX_SEL})
        check("no open file refuses", refused["toast"], "No file is currently open")
        check("a refused toggle reverts the checkbox", refused["checked"], False)

        # ================= export / print stay inert =================
        fresh(pg)
        art = pg.evaluate("""async () => {
            const a = await window.buildExportArtifact({});
            const m = (a.html || a).match(/<input[^>]*type="?checkbox"?[^>]*>/gi) || [];
            return { n: m.length, allDisabled: m.every(s => /disabled/.test(s)) };
        }""")
        check("HTML export has the checkboxes", art["n"], len(CASES))
        check("HTML export re-disables them", art["allDisabled"], True)
        prt = pg.evaluate("""async () => {
            const sel = '#preview li.task-list-item input[type=checkbox]';
            const boxes = [...document.querySelectorAll(sel)];
            await window.__beforePdfPrint();
            const during = boxes.every(b => b.disabled);
            window.__afterPdfPrint();
            return { during, after: boxes.every(b => !b.disabled) };
        }""")
        check("PDF print disables them", prt["during"], True)
        check("PDF print restores them", prt["after"], True)

        # ================= Marp: the same mapping through the slide <svg> =================
        fresh(pg, MARP_URL)
        check("Marp mode", pg.evaluate("() => document.body.classList.contains('marp')"), True)
        marp_cases = [
            (0, "- [x] 企画・要件定義", "- [ ] 企画・要件定義"),
            (2, "- [ ] 実装",           "- [x] 実装"),
            (4, "- [ ] リリース",       "- [x] リリース"),
        ]
        for n, before, after in marp_cases:
            fresh(pg, MARP_URL)
            click(pg, n)
            s = sent(pg)
            if len(s) != 1:
                check("marp box %d: one savefile:" % n, [len(s), pg.evaluate(
                    "() => document.getElementById('toast').textContent")], [1, ""])
                continue
            check("marp box %d: exactly one line, flipped in place" % n,
                  one_line_diff(MARP_SRC, content_of(s[0]))[1:], (before, after))

        check("no uncaught page errors", errors, [])
        b.close()
finally:
    httpd.shutdown()

print()
print("%d FAILURES: %s" % (len(failures), ", ".join(failures)) if failures else "ALL PASS")
sys.exit(1 if failures else 0)

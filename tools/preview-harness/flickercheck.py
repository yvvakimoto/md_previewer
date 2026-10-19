"""Frame-by-frame check that a Marp re-render never paints a half-built deck.

`renderMarp()` rebuilds #preview wholesale on every live-edit keystroke, save and
checkbox click, then awaits figure engines, `__nextPaint()` and plotly's CSV fetch.
Each of those lets the compositor paint the DOM as it stands. This script samples
every animation frame (an rAF callback runs right before that frame paints) while a
re-render of the same file is in flight, and asserts what the reader would see:

  deck   -- exactly one `.active` slide in EVERY frame. Before the fix the slides sat
            `display:none` over the #000 backdrop until the very end of the render:
            the "blackout".
  scroll -- scrollTop never moves, and the rendered plotly graphs never disappear
            (they are carried across the rebuild by __plotlyHoldRendered).

It also pins the task-checkbox echo: a `savefile:` round trip whose content is exactly
what the toggle wrote keeps the DOM instead of rebuilding it (taskcheck.py covers the
splice itself).

No Rust host: the round trip is simulated by calling `loadFileFromRust` directly with
the file's own path, which is exactly what `EditorSavedContent` does.
"""
import os, sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
sys.path.insert(0, SCRIPT_DIR)
import shoot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

MARP_DOC = os.path.join(REPO, "samples", "marp.md")
TASK_DOC = os.path.join(REPO, "samples", "tasklist.md")
PORT = 8797
def url_of(path):
    return "http://127.0.0.1:%d/index.html?file=%s" % (PORT, path.replace("\\", "/"))

failures = []
def check(name, got, want):
    if got != want:
        failures.append(name)
        print("FAIL %s\n       got  %r\n       want %r" % (name, got, want))
    else:
        print("ok   %s" % name)

# Re-render the open file with `edit(raw)` applied, sampling every frame meanwhile.
# Returns the frames plus how many slides / graphs the settled DOM has.
RERENDER_SAMPLED = """async (a) => {
  const frames = [];
  let on = true;
  const tick = () => {
    if (!on) return;
    const slides = [...document.querySelectorAll('#preview div.marpit > svg[data-marpit-svg]')];
    frames.push({
      active: slides.filter(s => s.classList.contains('active')).length,
      top: Math.round(previewContainer.scrollTop),
      plots: document.querySelectorAll('#preview .plotly-block .main-svg').length,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const raw = currentMarkdownRaw.replace(a.from, a.to);
  await window.loadFileFromRust({ filename: 'marp.md', filepath: currentFilePath,
                                  content: raw.replace(/\\r\\n/g, '\\n'), raw });
  await new Promise(r => setTimeout(r, a.settleMs));
  on = false;
  return frames;
}"""

def wait_settled(pg):
    pg.wait_for_selector("#preview svg[data-marpit-svg]", state="attached", timeout=20000)
    pg.wait_for_function("() => appContainer.style.display === 'flex'", timeout=30000)
    # plotly fetches its CSV and draws asynchronously; wait for every graph.
    pg.wait_for_function("""() => {
      const blocks = document.querySelectorAll('#preview .plotly-block');
      return blocks.length > 0 && [...blocks].every(b => b.querySelector('.main-svg'));
    }""", timeout=30000)
    pg.wait_for_timeout(800)

httpd = shoot.start_harness(PORT, REPO, os.path.join(REPO, "assets"))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        pg.add_init_script(shoot.ui_lang_init_script("en"))
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        # Each live edit replaces one heading's text, so the source really changes.
        edit = {"from": "## ", "to": "## ​", "settleMs": 2500}

        # ================= deck: one active slide in every frame =================
        pg.add_init_script("try { localStorage.setItem('marpView', 'deck'); } catch (e) {}")
        pg.goto(url_of(MARP_DOC))
        wait_settled(pg)
        check("deck mode", pg.evaluate("() => document.body.classList.contains('deck-mode')"), True)
        # Park on a plotly slide, so the slowest async figure is the one on screen.
        idx = pg.evaluate("""() => {
          const s = [...document.querySelectorAll('#preview div.marpit > svg[data-marpit-svg]')];
          const i = s.findIndex(x => x.querySelector('.plotly-block'));
          __marpDeckIndex = i; __marpUpdateDeck(); return i;
        }""")
        frames = pg.evaluate(RERENDER_SAMPLED, edit)
        check("deck: frames were sampled", len(frames) > 5, True)
        check("deck: no frame without exactly one active slide",
              [f for f in frames if f["active"] != 1][:3], [])
        check("deck: still on the same slide", pg.evaluate(
            "() => __marpDeckIndex"), idx)

        # ================= scroll: no jump, plots never vanish =================
        pg.evaluate("() => { setMarpView('scroll'); __marpUpdateDeck(); }")
        pg.wait_for_timeout(600)
        top = pg.evaluate("""() => {
          const el = document.querySelector('#preview .plotly-block');
          el.scrollIntoView({ block: 'center' });
          return Math.round(previewContainer.scrollTop);
        }""")
        pg.wait_for_timeout(300)
        plots = pg.evaluate("() => document.querySelectorAll('#preview .plotly-block .main-svg').length")
        frames = pg.evaluate(RERENDER_SAMPLED, edit)
        check("scroll: parked mid-document", top > 0, True)
        check("scroll: scrollTop never moves", sorted({f["top"] for f in frames}), [top])
        check("scroll: plotly graphs never disappear",
              [f["plots"] for f in frames if f["plots"] < plots][:3], [])
        check("scroll: hold released after the render",
              pg.evaluate("() => preview.style.minHeight"), "")

        # ================= checkbox echo keeps the DOM =================
        for label, doc in (("normal", TASK_DOC), ("marp", MARP_DOC)):
            pg.goto(url_of(doc))
            pg.wait_for_selector("#preview li.task-list-item input[type=checkbox]", state="attached", timeout=20000)
            # The first load must have FINISHED (a Marp deck awaits its figures before
            # loadFileFromRust reveals #app-container); an echo racing it is not a reload.
            pg.wait_for_function("() => appContainer.style.display === 'flex'", timeout=30000)
            pg.wait_for_timeout(800)
            r = pg.evaluate("""async () => {
              const sent = [];
              window.ipc = window.ipc || {};
              window.ipc.postMessage = (m) => { if (m.indexOf('savefile:') === 0) sent.push(m); };
              const echo = (i) => {
                const raw = JSON.parse(sent[i].slice('savefile:'.length)).content;
                return window.loadFileFromRust({ filename: 'x.md', filepath: currentFilePath,
                                                 content: raw.replace(/\\r\\n/g, '\\n'), raw });
              };
              const boxes = () => [...document.querySelectorAll('#preview li.task-list-item input[type=checkbox]')];
              const first = preview.querySelector('[data-line]');
              first.__probe = 1;
              const b0 = boxes()[1].checked, b1 = boxes()[2].checked;
              boxes()[1].click(); boxes()[2].click();
              // An EARLIER click's echo while a later one is in flight: no rebuild,
              // and the later box must not bounce back.
              await echo(0);
              const afterEarlier = { kept: first.isConnected && first.__probe === 1,
                                     b1: boxes()[2].checked === !b1 };
              await echo(1);
              const kept = first.isConnected && preview.querySelector('[data-line]') === first;
              // Adopted text is the new base: a third click composes on both toggles.
              boxes()[3].click();
              const third = JSON.parse(sent[2].slice('savefile:'.length)).content;
              const art = await window.buildExportArtifact({});
              const html = art.html || art;
              const tags = html.match(/<input[^>]*type="?checkbox"?[^>]*>/gi) || [];
              return { afterEarlier, kept, toggled: [boxes()[1].checked === !b0, boxes()[2].checked === !b1],
                       composes: third === JSON.parse(sent[1].slice('savefile:'.length)).content ? 'same' : 'differs',
                       exportChecked: tags.filter(t => /\\bchecked\\b/.test(t)).length,
                       liveChecked: boxes().filter(x => x.checked).length };
            }""")
            check("%s: earlier echo keeps the DOM" % label, r["afterEarlier"]["kept"], True)
            check("%s: earlier echo does not bounce the later box" % label,
                  r["afterEarlier"]["b1"], True)
            check("%s: own echo keeps the DOM" % label, r["kept"], True)
            check("%s: both toggles still shown" % label, r["toggled"], [True, True])
            check("%s: a later click builds on the adopted text" % label, r["composes"], "differs")
            check("%s: export carries the live checked state" % label,
                  r["exportChecked"], r["liveChecked"])

            # An inbound text that is NOT our echo still rebuilds.
            rebuilt = pg.evaluate("""async () => {
              const first = preview.querySelector('[data-line]');
              const raw = currentMarkdownRaw + '\\n';
              await window.loadFileFromRust({ filename: 'x.md', filepath: currentFilePath,
                                              content: raw.replace(/\\r\\n/g, '\\n'), raw });
              return !first.isConnected;
            }""")
            check("%s: a foreign reload still re-renders" % label, rebuilt, True)

        check("no uncaught page errors", errors, [])
        b.close()
finally:
    httpd.shutdown()

print()
print("%d FAILURES: %s" % (len(failures), ", ".join(failures)) if failures else "ALL PASS")
sys.exit(1 if failures else 0)

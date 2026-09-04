# preview-harness

A tiny stdlib-only Python server that serves the **real** `assets/index.html` over plain HTTP so the
whole md_previewer UI can be opened and inspected in a browser — **without a `cargo build`**. It is
built for AI-assisted iteration: Claude Code can open the harness in its in-app Browser pane and both
*see* the rendering (screenshot) and *inspect* it (DOM / console / network).

It reproduces, at serve time, the three things the Rust+WebView2 host normally does so `index.html`
boots unchanged:

1. injects the host globals (`__appVersion`, `__userStyles`, `__marpThemes`, `__styleExporters`) via a
   bootstrap `<script>` inserted after `<head>` (the on-disk file is never modified);
2. auto-loads a document from a `?file=<abs>` query param by calling `window.loadFileFromRust(...)`;
3. serves local images / CSV / video through the `/userfile/` route (relative to the current
   document's directory, with HTTP `Range` support).

## Usage

```powershell
python tools/preview-harness/serve.py            # http://127.0.0.1:8770
python tools/preview-harness/serve.py --port 9000
```

Then open, in any browser (or Claude Code's Browser pane):

```
http://localhost:8770/index.html?file=<ABSOLUTE path to a .md>
```

e.g. `http://localhost:8770/index.html?file=C:/Users/you/works/md_previewer/samples/marp.md`.

To view a different document, navigate to a new `?file=` URL (this re-points the `/userfile/` base).
There is also a launch config named **`preview-harness`** in `.claude/launch.json`.

## Pixel capture — `shoot.py`

When you need actual PNG pixels (e.g. the Browser pane's `computer{screenshot}` is
unavailable), `shoot.py` renders a doc in this harness inside a **real headless browser**
(Playwright driving system Edge/Chrome) and writes PNG file(s) you can `Read`:

```powershell
python tools/preview-harness/shoot.py samples/marp.md --out _shots --slides 1,3,5-7 --scale 2
python tools/preview-harness/shoot.py samples/sample.md --out _shots      # normal doc -> page.png
```

- Marp deck → `slide-NN.png` per selected slide **+ `layout.json`** (per-slide overflow / autofit
  scale — the same metrics `--export-png` writes).
- Normal doc → `page.png` (the overflow clip is neutralized first, so nothing is cut off).

It launches the system browser via `--channel msedge|chrome`, so **no `playwright install` is
needed** — only the `playwright` Python module plus an installed Edge or Chrome. Because a real
browser paints normally, fonts / `/userfile/` images / KaTeX / mermaid / Marp autofit all render
exactly as in the app.

## Structural regression net — `domdump.py`

`shoot.py` gives pixels; `domdump.py` gives **structure**. It renders each document the same way
and writes a normalized, diffable digest of the `#preview` tree — one line per element
(`tag.class attr=value |text`). Use it to prove a refactor of the render pipeline changed nothing:

```powershell
# before the change
python tools/preview-harness/domdump.py samples/*.md --out _dom/base --modes scroll,deck,list --dark
# ... refactor ...
python tools/preview-harness/domdump.py samples/*.md --out _dom/after --modes scroll,deck,list --dark
git diff --no-index _dom/base _dom/after      # empty == behavior preserved
```

The digest is byte-stable across runs because it normalizes the things that legitimately vary:
generated-graphics subtrees (`<svg>` / `<canvas>` from mermaid / KaTeX / abcjs / markwhen / plotly)
collapse to one opaque node, render-counter and Plotly `modebar-` ids are elided, whitespace is
collapsed, numbers inside `style=` are rounded (`--round`, default 2 dp) so sub-pixel layout jitter
is not a diff, and over-long attribute values / text are replaced by a length+hash stand-in.

Marp's own `svg[data-marpit-svg]` is deliberately **not** collapsed — it is a layout container, and
every slide's content lives under it. `--modes` dumps each Marp view (`scroll` / `deck` / `list`);
`--dark` additionally dumps each document in dark mode. Output goes to `_dom/` (git-ignored).

## Table edit mode — `tablecheck.py` and `table-model.test.cjs`

The preview's "表を編集" mode writes back to the source `.md` through the `savefile:` IPC, and the
harness's IPC shim makes that **fully testable without a Rust host** — the payload never reaches disk,
it just lands in an array the test can assert against:

```powershell
node tools/preview-harness/table-model.test.cjs     # pure model layer, no browser
python tools/preview-harness/tablecheck.py          # end-to-end, Playwright
```

`ruby-model.test.cjs` is the same idea for the ruby (振り仮名) grammar:

```powershell
node tools/preview-harness/ruby-model.test.cjs      # pure grammar layer, no browser
```

It extracts `RUBY_ALT_SRC` / `buildRubyHtml` / `rubyifyMdLine` out of `assets/index.html` and pins the
three views built from that one alternation — notably that `start()` reports the offset of the **base**
rather than of `《` (an offset pointing at `《` makes marked emit the base twice), that a segment-count
mismatch falls back to group ruby, and that the Marp line rewriter skips inline code spans.

`table-model.test.cjs` extracts the `tbl*` functions out of `assets/index.html` and runs them under
plain `node`. Its centrepiece is **idempotency** — `tblEmit(tblParse(lines)) === lines` byte for byte —
which is what guarantees that saving a table never reformats lines the user did not touch.

`tablecheck.py` enters edit mode, drives the right-click row/column menu, and asserts the **exact**
`savefile:` payload for a cell edit, a row insert, a column delete and an alignment change, plus the
refuse-first cases (nested table, shape mismatch), that cancel writes nothing, and that an inbound
render abandons the session. Because there is no Rust host, a commit never comes back as a re-render,
so each committing scenario reloads the page first.

## Landing-page shortcut drift — `docskeycheck.py`

`docs/index.html`'s `#keys` section republishes the app's own keyboard-shortcut list, and the stale copy
of two hand-written lists is the **public** one. This pairs them and fails when the keys disagree:

```powershell
python tools/preview-harness/docskeycheck.py            # no browser needed
python tools/preview-harness/docskeycheck.py --strict   # description warnings fail too
```

**The only `docs/`-facing check that needs neither Playwright nor a browser** — it is stdlib-only and
runs in well under a second, because both sides are literal HTML plus literal JS string tables sitting
on disk. That is the point: it is cheap enough for a pre-commit hook, and someone with no browser
installed can still run it. (Not to be confused with `keycheck.py`, which drives real keydown events at
the *app*; this one executes nothing.)

The source of truth is the `<table>` inside `#help-modal` in `assets/index.html`. The two lists are
paired **by i18n-key suffix, not by row order** — the page regroups the modal's 21 rows into three
editorial groups, so its document order legitimately differs. A **key-cap** mismatch, or a shortcut
present on one side only, **fails**; a **description** mismatch only **warns** (the app's wording can be
edited by a commit that has no business touching `docs/`). The two rows the page deliberately rewords
are named in the module's `ADAPTED` set. The editor group has no counterpart in the modal and is
excluded by its `data-sc-scope="editor"`; a group carrying **no** `data-sc-scope` is an error, so the
exclusion is fail-closed. `shoot-docs.py` also calls it warn-only beside `check_gallery_sources()`.

## Fidelity & intentional no-ops

The Browser pane is Chromium and WebView2 is Edge/Chromium on the same machine (same system fonts), so
markdown / CSS / SVG / Marp rendering is essentially identical. The following are **intentional no-ops**
under the harness (each just logs an `[ipc]` line): the companion editor (`E`), save, HTML/PDF export
(`X`), headless PNG capture, and cross-file navigation (`openmd:` and the Ctrl+click
`openmdnew:`, which in the real host spawns a second previewer process) — to open another file, use a new
`?file=` URL. One document is tracked at a time (a single `/userfile/` base).

For the highest-fidelity check of the actual shipping binary — especially Marp deck layout — use the
real WebView2 headless capture instead: `md-previewer.exe <file> --export-png <dir>` (see *Headless PNG
capture for agents* in `CLAUDE.md`).

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

## Fidelity & intentional no-ops

The Browser pane is Chromium and WebView2 is Edge/Chromium on the same machine (same system fonts), so
markdown / CSS / SVG / Marp rendering is essentially identical. The following are **intentional no-ops**
under the harness (each just logs an `[ipc]` line): the companion editor (`E`), save, HTML/PDF export
(`X`), headless PNG capture, and cross-file `openmd:` navigation — to open another file, use a new
`?file=` URL. One document is tracked at a time (a single `/userfile/` base).

For the highest-fidelity check of the actual shipping binary — especially Marp deck layout — use the
real WebView2 headless capture instead: `md-previewer.exe <file> --export-png <dir>` (see *Headless PNG
capture for agents* in `CLAUDE.md`).

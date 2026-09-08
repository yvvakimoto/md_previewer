# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**This file holds only what is true everywhere.** Per-area detail — the non-obvious
invariants that reading the code does *not* reveal — lives in one owning file under
`.claude/docs/`. User-facing documentation (what the app does, how to use it) lives in
`README.md`; never restate it here.

**Notation.** A rule marked ⚠ has a recorded failure behind it: the simpler-looking
alternative has already been tried and did not work. Do not "simplify" it without a new
measurement. `[m]` marks a number obtained by measuring real hardware — reproduce before
changing it.

---

## Read before you edit

**Before your first edit to a file in the left column, read the doc in the middle column.**
Not afterwards, and not "if something looks odd". Every one of these areas has already been
broken by an edit that looked locally correct. A grep hit and a nearby function are not a
substitute.

⚠ **STOP — these six have cost real breakage when edited unread:** `assets/index.html`,
`tools/build-editor/entry.js` + `assets/editor.css`, `assets/marp/*.css`, `src/main.rs`,
`tools/release-on-main.ps1`, `docs/index.html`.

| About to edit / debug | Read first | Answers, among others |
|---|---|---|
| `assets/index.html` — render loop, `__*` shared helpers, diagram caches, `data-line` | `.claude/docs/preview-core.md` | Why is my DOM node gone after a keystroke? Which helper already does this? Why did my diagram stop re-rendering? |
| `assets/index.html` — a ` ```lang ` fence; `assets/libs/<engine>` | `.claude/docs/preview-blocks.md` | How do I add an engine? Why must it go through `awaitLib`? Why is the SVG cached without a theme salt? |
| `assets/index.html` — a `marked` extension, a DOM post-pass, new Markdown syntax | `.claude/docs/preview-markdown-ext.md` | Where are the other implementations? When do I need a sentinel pre-pass? |
| `assets/index.html` — Copy table / Edit table, anything splicing source by `data-line` | `.claude/docs/preview-tables.md` | Why does edit mode refuse this table? Why is the emitter formatting-preserving? |
| `assets/index.html` — `/userfile/` URLs, images, video, cross-file links, history, drag & drop | `.claude/docs/preview-files-media.md` | Why is my Japanese-path image 404ing? Why is `..` resolved to an absolute path? |
| `assets/marp/*.css`; `renderMarp()` | `.claude/docs/marp.md` | Why did my theme's `pre` never render? Why is a slide clipped instead of scrolling? |
| `assets/*.css` (not `editor.css`); `@user-vars`; pagination; watermark | `.claude/docs/styles-theming.md` | Why is my 版面 off by one line? How does a theme expose its own settings? |
| `assets/editor.*`; `tools/build-editor/entry.js`; status bar; settings modal; IME | `.claude/docs/editor-core.md` | Why did focus jump out of the modal? Why is the live channel not `editor:change:`? |
| `tools/build-editor/` — any key binding | `.claude/docs/editor-keymaps.md` | Why does Vim swallow my key? Why is Dvorak done with `langmap` and not `Vim.map`? |
| `tools/build-editor/cells.js`, `mdBlocks.js` | `.claude/docs/editor-cells.md` | Why is the gate a DOM handler and not a keymap? Why did my op become two undos? |
| `tools/build-editor/mdTable.js`, `tablePaste.js` | `.claude/docs/editor-tables.md` | Why is the column resolver tree-based? Why does paste decline this clipboard? |
| `tools/build-editor/*Complete.js` | `.claude/docs/editor-autocomplete.md` | Why is `completionKeymap` its own `Prec.highest` layer? |
| ANY user-visible string; the help modal; settings labels | `.claude/docs/i18n.md` | Which table owns this key? Why did the labels go stale until restart? |
| `buildExportArtifact()`, `__beforePdfPrint()`, `src/pdf_win.rs`, `src/png_win.rs` | `.claude/docs/export.md` | Why is my figure missing from the export? Why does a vertical theme print landscape? |
| `src/main.rs`, `src/mdx.rs`, `src/editor_registry.rs`, `src/*_win.rs` | `.claude/docs/rust-host.md` | What does the `/userfile/` route do with `..`? How does `.mdx` repack? |
| `src/updater.rs`, `src/http_win.rs`, `assets/update.json`, `#update-banner` | `.claude/docs/auto-update.md` | Why is the check released by `renderdone:`? Why is the banner stashed? Why is `as_ready()` an `Option`? |
| `tools/preview-harness/**`, `*.test.mjs`, `*.test.cjs` | `.claude/docs/harness-testing.md` | How do I see what I changed without a `cargo build`? |
| `docs/**` (the PUBLISHED site), `tools/preview-harness/shoot-docs.py` | `.claude/docs/docs-site.md` | Why is the gallery snippet machine-checked? Why WebP at `--g-cap`? |
| `tools/fetch-libs.ps1`, `tools/build-*/`, `installer/`, `build.rs`, `assets/libs/` | `.claude/docs/build-and-deps.md` | What are the five places a new library must be registered? |
| `tools/release-on-main.ps1`, `tools/hooks/`, `HISTORY.md` | `.claude/docs/release.md` | Why does `-Finalize` refuse? Why is the notes hash LF-normalized? |
| `.claude/skills/md-previewer-author/**` — the shipped authoring skill | `.claude/docs/authoring-skill.md` | Why are there two `samples/` copies? Why must the installer task stay unchecked? |

`assets/index.html` is one 670KB file behind six of these rows — pick by **what you are
changing**, not by the filename. Each doc opens with `Owns:` / `Read before:` / `Related:`,
so `grep -l "Owns:.*<path>" .claude/docs/` is a working reverse lookup.

---

## Project Overview

A standalone desktop Markdown previewer in Rust, **Windows only**, **offline for viewing**
(every rendering dependency bundled; no CDN at runtime). ⚠ **The offline guarantee covers
*viewing*, not updating** — the update check contacts GitHub Releases by default
(`auto-update.md`), so never write "never touches the internet" in user-facing text.
Two optional components — the TikZ engine and the ABC playback sound bank — are fetched by the
**installer**, not at runtime; once installed, viewing and playback are fully offline.
One line per feature, for routing only — user-facing descriptions live in
README.md 「対応している記法・機能」.

| Feature | Detail |
|---|---|
| GFM preview, auto-reload on external change, sidebar TOC | `preview-core.md` |
| Diagram / figure fences: `mermaid`, `plotly`, `abc` (+ playback), `markwhen`, `tikz`/`tikzcd`, `kataskeve`/`kataskeve3d`, `feynman`, `csv`/`tsv`, KaTeX math, highlight.js (+ in-house Modelica grammar) | `preview-blocks.md` |
| Footnotes, `::: center/right/left/message/vcenter/columns` fenced divs, `[text]{color=…}` inline spans, definition lists, ruby (`｜猫《ねこ》`), task lists, CJK soft-break join | `preview-markdown-ext.md` |
| Copy table for PowerPoint (rich-HTML clipboard); Edit table (writes back to the `.md`) | `preview-tables.md` |
| Clickable task-list checkboxes — a click rewrites that one `- [ ]` line in the `.md` (both pipelines; inert in every export) | `preview-markdown-ext.md` |
| Images via the `/userfile/` route with `\|WxH` sizing and `../` paths; video + YouTube embeds; cross-file `.md` links with back/forward history; `Ctrl`+click opens a new window; drag & drop; `Ctrl+N` new file; `Ctrl+D` install dir | `preview-files-media.md` |
| Marp slides (`marp: true`), 3 views (`P`), autofit (`A`), laser pointer (`Z`), 8-colour theme family, selection highlighter | `marp.md` |
| Dark/light (`M`), style picker (`S`) with a per-style ⚙ `@user-vars` pane, `bunko.css` 文庫本 / `tategaki.css` 縦書き, section numbering (`N`), wide layout (`W`), `confidential:` / `watermark:` overlay | `styles-theming.md` |
| Companion editor (`E`): CodeMirror 6, Vim, live preview, cell mode, Office-table paste, autocomplete, font zoom, ⚙ settings | `editor-*.md` |
| UI language toggle (ja / en), one shared `uiLang` key across both windows | `i18n.md` |
| Export to standalone HTML or PDF (`X`); headless `--export-png` for agents | `export.md` |
| Workspace (directory) mode with file tree and `_toc.md`; `.mdx` ZIP bundles | `rust-host.md` |
| Auto-update: GitHub Releases by default (ON, via the shipped `assets/update.json`), or an intranet file share with `provider: "share"` | `auto-update.md` |
| Help modal (`H`), zoom (`Ctrl` `+`/`-`/`0`) | `preview-core.md` |
| Claude Code authoring skill, shipped by the installer as an opt-in task (OFF by default) | `authoring-skill.md` |

---

## Architecture map

`file → responsibility → owning doc`. **Adding a source file obliges you to add a row here.**
A file with no owning doc is an anomaly.

| File / directory | Responsibility | Doc |
|---|---|---|
| `src/main.rs` | window + event loop (`tao`), WebView2 host (`wry`), `pulldown-cmark` initial render, `notify` watcher, `app://` protocol and the `/userfile/` route, workspace state | `rust-host.md` |
| `src/editor_registry.rs` | the one paired editor `WebView`; preview↔editor IPC routing | `editor-core.md` |
| `src/mdx.rs` | `.mdx` ZIP extract-to-temp and repack | `rust-host.md` |
| `src/updater.rs` | auto-update: provider dispatch (`github` / `share`), detect + fetch + silent install | `auto-update.md` |
| `src/http_win.rs` | blocking HTTPS GET over WinHTTP — the GitHub provider's only transport | `auto-update.md` |
| `src/cdp_win.rs` | shared WebView2 DevTools-Protocol plumbing | `export.md` |
| `src/pdf_win.rs` / `src/png_win.rs` | PDF via `Page.printToPDF` / PNG via `Page.captureScreenshot` | `export.md` |
| `src/clipboard_win.rs` | Win32 clipboard behind the editor's `unnamedplus` yank/paste | `editor-keymaps.md` |
| `src/ime_win.rs` | IMM32 bridge (auto half-width on Vim NORMAL, caret tint) | `editor-core.md` |
| `assets/index.html` | the preview UI. ~11k lines, ONE inline `<script>` | `preview-*.md`, `marp.md`, `styles-theming.md`, `i18n.md`, `export.md` |
| `assets/editor.html`, `assets/editor.css` | editor window shell and chrome | `editor-core.md` |
| `assets/*.css` | user styles (`parchment`, `classical`, `hakuro-modern`, `tategaki`, `bunko`) | `styles-theming.md` |
| `assets/marp/*.css` | the 8-theme Marp colour family (`magenta` is the base) | `marp.md` |
| `assets/libs/**` | bundled third-party JS/CSS (+ the ABC sound bank's MP3s) — **git-ignored, fetched/built** | `build-and-deps.md` |
| `assets/libs/hljs-modelica.js` | in-house highlight.js grammar — **tracked, hand-written** | `preview-blocks.md` |
| `assets/THIRD_PARTY_LICENSES.txt` | generated, git-ignored | `build-and-deps.md` |
| `tools/build-editor/` | CodeMirror 6 + Vim bundle and its modules | `editor-*.md` |
| `tools/build-marp/`, `tools/build-markwhen/` | esbuild IIFE bundles | `build-and-deps.md` |
| `tools/fetch-libs.ps1`, `install-deps.ps1`, `collect-licenses.ps1`, `make-icon/` | dependency and asset toolchain | `build-and-deps.md` |
| `tools/preview-harness/` | build-free browser harness + every verification script | `harness-testing.md` |
| `tools/release-on-main.ps1`, `tools/hooks/` | release automation | `release.md` |
| `installer/`, `build.rs`, `app.rc` | Inno Setup installer, icon embedding | `build-and-deps.md` |
| `build.ps1`, `build-installer.ps1` | one-shot build wrappers | `build-and-deps.md`, `release.md` |
| `docs/` | **the published GitHub Pages site** | `docs-site.md` |
| `samples/` | one focused file per feature area — part of the feature | all |
| `.claude/skills/md-previewer-author/` | the Claude authoring skill — **shipped** by the installer as an opt-in task | `authoring-skill.md` |
| `README.md`, `HISTORY.md` | user guide, release notes (both shipped by the installer) | `release.md` |

---

## Cross-cutting invariants

Rules you can violate while working in *any* area. The most expensive ones are here rather
than in a detail doc, so that a missed pointer is not fatal.

### Structure

1. **`assets/index.html` is an ~11k-line monolith with one inline `<script>`.** No `import`,
   no modules, everything global. The editor is a separate esbuild bundle in a separate
   window. ⚠ The mirrored implementations below are the deliberate cost of that shape, not an
   oversight — "just import it" does not apply here.
2. **Use the shared helpers; do not write a sixth copy.** In `assets/index.html`:
   `__makeMdLineScanner` / `__rewriteMdLines` (front-matter- and fence-aware line walking —
   previously hand-rolled five times), `__isSentinelP` / `__unwrapSentinelRegions`,
   `buildSpanStyle`, `scanDefList`, `buildRubyHtml`, `__isTypingTarget` / `onPlainKey` /
   `onCtrlKey` / `onShortcutKey` / `bindBodyClassToggle` (the text-entry guard was retyped 12
   times), `__createContextMenu`, `__diagKey` / `__diagCacheSet` / `__diagCacheHit`,
   `copyTextViaTextarea`, `toUserfileUrl` / `encodePathForUserfile`. In Rust:
   `write_suppressed` / `suppress_watcher`, `js_call` / `eval_js_fn`, `build_load_file_script`.
   Fenced-div keywords go in `ALIGN_KW_SRC` **only**.

### Rendering

3. ⚠ **A content feature is done when it works in BOTH pipelines and BOTH exports.**
   Implement it for `marked` (normal) *and* marp-core (usually a sentinel pre-pass + DOM
   post-pass), then check it survives `buildExportArtifact()` (HTML) and `__beforePdfPrint()`
   (PDF). **Rendering in the preview but not in an export is this repo's most common silent
   bug** — an unresolved `@import` shipped a horizontal `bunko` export for months.
4. **`#preview` is rebuilt wholesale by `innerHTML` on every render**, including every
   ~150 ms live-edit keystroke. Anything holding a node reference, an in-DOM editing session,
   or an expensive un-memoized render must re-establish or abandon itself.
5. ⚠ **Every preprocessing pass in `renderMarkdown()` must preserve the line count** — replace
   consumed lines with blank lines, never delete them. `data-line` is a faithful 1-based index
   into the LF-normalized source and is the precondition for editor↔preview scroll sync, the
   `jumpto:` reverse jump, cell-run sync, and every `data-line`-keyed source splice. Drift is
   silent. Net: `domdump.py`. Two corollaries: a page-split tail **drops** its `data-line`, and
   **never stamp `data-line` on a wrapper** (`__tableLocate()`'s `lineEl.contains(tableEl)`
   would then match every table and refuse to edit any of them).

### Adding a figure engine — the three-part checklist

6. ⚠ **Never bare-`await` an `ensureX()` / `loadLib()` promise in a figure branch — use
   `awaitLib()`.** `loadLib()` rejects on a 404, which rejects `renderMarkdown()`, so
   `loadFileFromRust()` never reveals `#app-container` and the app sits on the 「読み込み中…」
   splash **forever** — with nothing on screen and nothing in the console, because release
   builds have no devtools. A missing optional engine must cost that engine's blocks, never
   the document.
7. ⚠ **Never bare-`await` a `requestAnimationFrame` — use `__nextPaint()`.** rAF does not fire
   in the hidden window `--export-png` renders into, nor in a backgrounded tab: the same
   eternal splash by a second route.
8. ⚠ **Register a new async figure kind in `shoot.py`'s `_FIGURES_READY_JS`**, or its output is
   silently missing from every screenshot and every DOM digest.

### Editor

9. **`Prec.highest(EditorView.domEventHandlers)` beats Vim; `Prec.highest(keymap.of(...))`
   does not.** The whole `keymap` facet is served by one `Prec.default` DOM handler, so `Prec`
   inside it only reorders bindings among themselves.
10. ⚠ **A multi-step dispatch must carry a `userEvent` that does NOT match
    `/^(input\.type|delete)($|\.)/`** (`@codemirror/commands`' `joinableUserEvent`) — use
    `cell.*`, `table.paste`, `slide.cut`. A matching name lets two nearby ops collapse into one
    undo step, invisible until a user presses undo twice. Related trap: `@replit/codemirror-vim`
    dispatches **every** Vim edit, deletions included, as `input.type.compose`.
11. **Every disk write costs a 1.5 s watcher-suppression entry plus a full re-render.**
    Per-keystroke saving is never an option; batch to one write per commit.
12. **A new modal must register in three places, and omitting any one is a bug:**
    `isModalOpen()` (so cell mode's key gate stands down), the hard-coded newest-first Esc
    chain in `entry.js`, and `body.status-pinned` on open/close.
13. **A new toggle needs** a `localStorage` key, a settings-modal row stating its
    shortcut/ex-command, and an i18n pair.

### Strings and i18n

14. **Every user-visible string** goes in the owning table — `tools/build-editor/i18n.js` owns
    `ed.*`, `assets/index.html` owns the rest; the namespaces are disjoint by construction and
    only the six `common.*` keys must be byte-identical. Add a `data-i18n` attribute for static
    markup. `applyI18n` rewrites text and attributes, **never structure**, so cached DOM
    references and `<select>` values must survive a language switch.
15. **⚠️ DO NOT TRANSLATE:** regex character classes (`RUBY_KANJI_SRC`, `allow_re`), real font
    names (`stack` in `editorPrefs.js`), `--confidential-label` (document content), identifiers
    used as data (`SLIDE_CLASSES`, `TABLE_ALIGNS`), localStorage values (`marpView` =
    `scroll|deck|list`), CSS class names, `dataset.style`, and the editor's `data-el` /
    `data-val` / `data-seg`. **Generative rule: never key a lookup — least of all a reverse
    lookup — off a label.** `t('marp.view.' + v)` is the safe pattern.

### Paths, export, threads

16. ⚠ **`encodeURI()` is not idempotent — never re-encode a path that came from `marked`.**
    `%E6` becomes `%25E6` and Rust's single `urlencoding::decode()` cannot recover it. Every
    `/userfile/` URL goes through `encodePathForUserfile()`.
17. **Only the IPC handler holds the `&Window`.** Off-thread work (`spawn_new_previewer`,
    `openinstalldir:`, the export dialogs) receives already-computed values, never a handle.
18. ⚠ **CSS delivered by `<link>` vanishes from every HTML export.** `buildExportArtifact()`
    inlines only the document's **first** `<style>`. A new library's container/error chrome must
    be replicated into that block — which is why neither kataskeve package's `.css` is fetched.
19. **Export survives only `cloneNode`-safe DOM.** A `<canvas>` loses its bitmap (rasterize it),
    `@import` must be spliced not shipped, and a style with an `_export.js` takes over entirely.

### Platform, dependencies, docs

20. **Windows only.** WebView2, `*_win.rs`, no console subsystem on release builds. Do not write
    portable-looking abstractions for a second platform.
21. **Assets are read at runtime, not embedded** — they must sit next to the exe. `assets/libs/`
    is git-ignored, so a fresh clone needs `install-deps.ps1` before anything runs.
22. ⚠ **Adding or bumping a bundled library is a five-place change:** the pin in
    `fetch-libs.ps1` → `$libsSentinels` in `build.ps1` (**one entry per library, never a
    representative sample** — a missing entry means `install-deps.ps1` is never re-run for it on
    an existing checkout, and the built tree 404s) → `.gitignore` (generated artifacts are
    enumerated **explicitly**, so hand-written in-house source under `assets/libs/` stays tracked
    by default) → re-run `collect-licenses.ps1` → for tikzjax, the independent version + SHA-256
    pin in `installer/md-previewer.iss`.
23. **`docs/` is the published GitHub Pages root** (served from `main`). Never put development
    notes there — they go in `.claude/docs/`. `.claude/worktrees/` is a live git worktree; do not
    edit inside it.
24. **The keyboard-shortcut list has three surfaces in this authority order:** the app's help
    modal in `assets/index.html` (source of truth) → `README.md` → `docs/index.html` (machine-
    checked against the first by `docskeycheck.py`). Add a shortcut to all three.
25. **A baseline must never out-specify a theme** — the `:where()` heading-margin wrap and
    `body.dark-mode { --md-dl-accent }` are the precedents.
26. **A harness that asserts UI text must pin the language** — `shoot.ui_lang_init_script(lang)`
    plus `locale=` on the context, or it passes in Japan and fails on an en-US machine. Prefer
    reading expected copy out of `window.__I18N` so the check asserts wiring, not wording.
27. **`samples/` is part of the feature.** A change that leaves its sample stale is incomplete.

### Working in this repo

28. **Start on a dedicated branch, never the default branch** — before editing, not after.
    Merging into `main` is what fires the `post-merge` release hook.
29. **Match commit-message syntax to the shell actually running it.** Bash tool → heredoc
    (`git commit -F - <<'EOF'`). PowerShell tool → `@'…'@`. Mixing them leaks a stray `@` onto
    the subject line.
30. **The release is two-phase and `-Finalize` refuses an unreviewed draft**, so raw commit
    subjects can never reach a user. Any task ending in a merge to `main` inherits this.

---

## Mirror implementations — change both sides

Eighteen pairs. **The ten with no machine check are the real invariant surface**; the eight
that are checked (or partly checked) can rely on the harness remembering.

| A | B | Checked by |
|---|---|---|
| `isParagraphLine()` — `tools/build-editor/mdBlocks.js` | `__isMdParagraphLine()` — `assets/index.html` | indirect (`cells.test.mjs`) |
| task-list marker rule — upstream `marked` (`/^\[[ xX]\] /` after the marker is stripped, plus `h > 4 ? 1 : h` on the post-marker indent) | `MD_TASK_LINE_RE` + `applyTaskLists`'s `markerRe` — `assets/index.html`. ⚠ `markerRe` used `\s+`, which matched a NEWLINE, so Marp rendered a checkbox where marked renders literal text | ✅ `taskcheck.py` (a disagreement shows up as a refused toggle) |
| `emitTable` / `escapeTableCell` / `displayWidth` — `mdTable.js` | `tblEmitRow` / `tblEscapeCell` / `tblPadCell` / `tblDisplayWidth` — `assets/index.html` | per-side only |
| `__editorI18n` (`ed.*`) — `tools/build-editor/i18n.js` | `__I18N` — `assets/index.html`; six `common.*` byte-identical | ✅ `i18ncheck.py` |
| `slugify()` — `src/main.rs` | `generateHeadingId()` — `assets/index.html` | ❌ **already diverged**: `# Café` → `café` (Rust `\w` is Unicode-aware) vs `caf` (JS `\w` is ASCII). Pinned as-is by a test; fixing it needs its own change window |
| `Get-NotesHash` — `build-installer.ps1` (writes the stamp) | `Get-NotesHash` — `tools/release-on-main.ps1` (checks it); hashed over **LF-normalized** content because `core.autocrlf=true` | ❌ misfired on v0.30.0 |
| `print_params()` — `src/pdf_win.rs` | its mirror inside `tools/preview-harness/pdfcheck.py` | ❌ the check validates against its own copy |
| Vim absolute-motion branch — `tools/build-editor/cells.js` | upstream `@replit/codemirror-vim` `dist/index.js` (5 lines copied; `Vim` exposes no `motions` getter) | partial (`cellcheck.py`) |
| `parseLangmap` mirror — `keyLayout.test.mjs` | upstream `parseLangmap` | ✅ round-trip. ⚠ upstream builds a *different* keymap on a bad escape rather than erroring |
| `section.invert` — `assets/marp/magenta.css` | `:root` — `assets/marp/dark.css` (byte-identical) | ❌ |
| `$TikzjaxVersion` — `tools/fetch-libs.ps1` | `#define TikzjaxVersion` / `TikzjaxSha256` — `installer/md-previewer.iss` (the `.iss` cannot read the script) | ❌ |
| tikzjax tarball extraction — `installer/md-previewer.iss` `[Code]` | `tools/fetch-libs.ps1` | ❌ |
| `$AbcSoundfontNotes` + base URL — `tools/fetch-libs.ps1` | `AbcSfNotes()` + `AbcSfBaseUrl` — `installer/md-previewer.iss` (88 note names; flats only, `C8` last) | ❌ |
| `#keys` list — `docs/index.html` | the `<table>` in `#help-modal` — `assets/index.html`, paired by i18n-key **suffix, not position** | ✅ `docskeycheck.py` |
| `GALLERY` — `tools/preview-harness/shoot-docs.py` | gallery snippet literals — `docs/index.html` | ⚠ warn-only |
| kataskeve / kataskeve3d container + error CSS | hand-carried into `assets/index.html`'s first `<style>` | ❌ |
| `_FIGURES_READY_JS` — `tools/preview-harness/shoot.py` | the set of async figure kinds — `assets/index.html` | ❌ silent |
| `CELL_HELP` — `tools/build-editor/cells.js` | the newest-first Esc chain — `entry.js` | ❌ |
| `$libsSentinels` — `build.ps1` | the library set fetched by `tools/fetch-libs.ps1` | ❌ |
| `samples/` | the skill's committed snapshot — `.claude/skills/md-previewer-author/samples/` (the installer sources the repo's copy directly, so only the snapshot can drift) | ✅ `skillcheck.py` |

---

## What to run after you touch X

| Touched | Run |
|---|---|
| the render pipeline, any preprocessing pass | `python tools/preview-harness/domdump.py` (+ `gate.sh <label> <files…>` to diff against `_dom/base`) |
| shortcuts, context menus, Marp autofit, `@user-vars` | `python tools/preview-harness/keycheck.py` |
| preview table edit mode | `python tools/preview-harness/tablecheck.py` + `node tools/preview-harness/table-model.test.cjs` |
| task-list checkboxes, `applyTaskLists()`, `__isTypingTarget()` | `python tools/preview-harness/taskcheck.py` (+ `keycheck.py` for the focus case) |
| cell mode | `python tools/preview-harness/cellcheck.py` + `cd tools/build-editor && node cells.test.mjs` |
| editor↔preview scroll sync (either axis) | `python tools/preview-harness/synccheck.py` |
| Office-table paste | `python tools/preview-harness/pastecheck.py` + `cd tools/build-editor && node tablePaste.test.mjs` |
| HTML export / PDF export | `python tools/preview-harness/exportcheck.py` / `pdfcheck.py` |
| either i18n table | `python tools/preview-harness/i18ncheck.py` |
| Vim key layout | `python tools/preview-harness/dvorakcheck.py` + `cd tools/build-editor && node keyLayout.test.mjs` |
| editor font zoom, settings modal | `python tools/preview-harness/prefscheck.py` |
| `docs/` landing page, or the help modal | `python tools/preview-harness/docskeycheck.py` (stdlib only, sub-second) |
| the ruby grammar | `node tools/preview-harness/ruby-model.test.cjs` |
| `samples/`, the authoring skill, or the installer's skill task | `python tools/preview-harness/skillcheck.py` (stdlib only, sub-second) |
| Rust pure helpers | `cargo test` |
| markdown table model | `cd tools/build-editor && node mdTable.test.mjs` |
| editor prefs model | `cd tools/build-editor && node editorPrefs.test.mjs` |
| anything visual, for actual pixels | `python tools/preview-harness/shoot.py <file.md>` (or `--export-png` for byte-exact WebView2) |

Details of how the harness works, and its intentional no-ops: `.claude/docs/harness-testing.md`.

---

## Tuned constants

Measured or chosen values that a future edit will want to find. All in `assets/index.html`
unless noted.

| Constant | Value | Why |
|---|---|---|
| live-edit debounce | 150 ms | every keystroke rebuilds `#preview` |
| `SAVE_SUPPRESS_MS` (`src/main.rs`) | 1500 | watcher-suppression window after a self-write |
| `UPDATE_WATCHDOG_MS` (`src/main.rs`) | 5000 | floor for the update check when `renderdone:` never arrives |
| `minCheckIntervalMinutes` default (`src/updater.rs`) | 360 | ⚠ GitHub allows 60 unauthenticated req/h **per IP**; a NATted office would burn it and go silently un-notified |
| `timeoutMs` default (`src/updater.rs`) | 4000 share / 8000 github | HTTPS pays DNS + TLS before the first byte |
| `NOTES_MAX_CHARS` / `MANIFEST_MAX_BYTES` / `INSTALLER_MAX_BYTES` (`src/updater.rs`) | 160 / 2 MB / 200 MB | banner card width; caps on anything read off the network |
| `__DIAGRAM_CACHE_MAX` | 200 | FIFO cap bounding diagram memory across long sessions |
| `__TIKZ_SCALE` / `__TIKZ_RENDER_TIMEOUT_MS` | 1.6 / 30000 | tikz renders small; a bad diagram must not wait forever |
| `_TIKZ_WAIT_MS` (`shoot.py`) | 45000 | must exceed the 30 s in-page timeout so a failure resolves |
| `__MARP_FIT_MIN` | 0.5 | autofit shrink floor; below it the body scrolls instead |
| `__MARP_ZOOM_MIN` / `MAX` | 1 / 8 | deck-mode `Ctrl`+wheel zoom range |
| `__MARKER_LIFE_MS` / `FADE_MS` / `ALPHA` | 2000 / 500 / 0.55 | Marp selection highlighter |
| `__LASER_TRAIL_MS` / `HEAD_R` | 260 / 7 | laser pointer comet trail |
| `__ABC_RESUME_TIMEOUT_MS` | 1500 | ⚠ `AudioContext.resume()` settles only once the autoplay policy is satisfied — an unbounded await hangs the play button on 「音源を読み込み中」 forever |
| `__MW_HOLIDAY_TIMEOUT_MS` / `__MW_CAL_MAX_MONTHS` | 4000 / 36 | markwhen calendar: online holidays are best-effort; wide spans fall back to the timeline |
| `__PDF_IMG_MAX_EDGE` / `TARGET_SCALE` / `SLACK` / `JPEG_QUALITY` | 1600 / 2 / 1.25 / 0.82 | PDF image downscale — Chromium embeds the live decoded bitmap verbatim |
| `__PDF_V_PAPER_W` / `_H` / `_MARGIN` / `_MIN_SCALE` | 1122 / 793 / 76 / 0.5 | vertical-writing PDF: A4 landscape floored to whole CSS px (⚠ a fraction taller emits a blank page per sheet) |
| `__PAGE_MAX_ITER` / `__CSS_IMPORT_MAX_DEPTH` | 4000 / 4 | pagination loop guard; `@import` splice depth cap |
| `CASCADE_STEP` / `CASCADE_CYCLE` (`src/main.rs`) | 36.0 / 6 | `Ctrl`+click window cascade, in logical px `[m]` |

---

## Build & Run Commands

Full prose walkthrough — prerequisites, the manual step-by-step, ISCC resolution — is in
README.md 「ソースからビルドする場合（開発者向け）」. Toolchain internals are in
`.claude/docs/build-and-deps.md`; the release flow is in `.claude/docs/release.md`.

⚠ **A fresh clone must run `install-deps.ps1` first** — `assets/libs/` is git-ignored.

```powershell
.\build.ps1                     # release build from a fresh clone (deps + icon + cargo + asset copy)
.\build.ps1 -DebugBuild         # -> target\debug\
.\build.ps1 -Clean              # cargo clean + wipe assets\libs\ first
.\build.ps1 -ForceDeps          # force install-deps.ps1 -Force
.\build.ps1 -SkipAssetCopy      # cargo build only

pwsh -File tools\install-deps.ps1            # populate assets/libs/ (-Force, -SkipNode, -Licenses)
pwsh -File tools\collect-licenses.ps1        # regenerate assets/THIRD_PARTY_LICENSES.txt
```

```bash
cargo build --release
cp -Force .\assets\* .\target\release\assets\   # assets are read at runtime, not embedded
cargo run --release path/to/file.md
cargo test                                       # pure helpers in main.rs / mdx.rs / updater.rs
```

```powershell
.\build-installer.ps1                        # build + licenses + iscc -> dist\MdPreviewer-Setup-<ver>.exe
.\build-installer.ps1 -SkipBuild -SkipLicenses

pwsh -NoProfile -File tools\release-on-main.ps1 -DryRun    # -Bump / -Finalize / -Verify / -Publish
```

---

## User-facing documentation lives in README.md

CLAUDE.md explains *how it is built*; README.md is the authority on *what it does*. Do not
restate these here — link to them.

| README heading | Owns |
|---|---|
| 他の Markdown ビューアとの違い / 動作環境 / 配布物の中身 / インストールと起動 | positioning, requirements, install |
| 対応している記法・機能 | the user-facing feature and syntax list |
| キーボードショートカット（共通 / Marp スライドモード） | the full shortcut tables |
| ワークスペース（フォルダ）モード, `_toc.md` の書式 | workspace usage and `_toc.md` syntax |
| `.mdx` バンドル形式 / 自動更新 / 表示言語 | bundle format, update UX, language toggle |
| テーマのカスタマイズ / 通常プレビュー / Marp スライドのテーマ / 機密表示（Confidential） | theme usage and the watermark front-matter |
| エディタウィンドウ（`E` キー） | editor features from a user's view |
| HTML / PDF エクスポート（`X`）, PNG 出力（`--export-png`） | export usage and CLI flags |
| `samples/` フォルダの見方 / トラブルシューティング / 既知の制限 | sample guide, troubleshooting, limits |
| ライセンス・サードパーティ表記 / ソースからビルドする場合 | licensing, full build walkthrough |

---

## Git commit conventions

- **Start work on a dedicated branch, not `main`.** If the current branch is the default,
  create/switch first (e.g. `git switch -c work`). This keeps `main` clean for the release
  flow — merging into `main` is what fires the `post-merge` hook (`.claude/docs/release.md`).
  Do this at the *start* of the task, before editing files.
- **Messages are Japanese**, following the existing history: a concise `<type>: <要約>` subject
  (`feat:` / `fix:`, or a plain Japanese summary such as `リリース v0.14.0`), a blank line,
  then Japanese bullet points.
- **Multi-line messages via the Bash tool must use a Bash heredoc** — `git commit -F - <<'EOF'
  … EOF`, or repeated `-m`. ⚠ **Do NOT use PowerShell here-string syntax (`@'…'@`) there**:
  in Bash those are literal characters, so a stray `@` lands on the subject line and pushes the
  real subject to line 2. Fix with `git commit --amend -F - <<'EOF' … EOF`. From the PowerShell
  tool the `@'…'@` form *is* correct — match the syntax to the shell actually running.
- End every message with `Co-Authored-By: <model> <noreply@anthropic.com>`, naming **the model
  actually authoring the commit** (from the current environment), not one copied off the
  previous commit.
- Commit or push only when the user asks.

---

## Documentation maintenance

⚠ **Default to updating the owning `.claude/docs/*.md`, not this file.** Appending here out of
habit is exactly how CLAUDE.md reached 369KB.

Touch CLAUDE.md **only** when: a cross-cutting invariant changed, a source file was added /
removed / repurposed (architecture map), a new doc needs a routing row, a constant moved, or a
mirror pair appeared.

- **Single owner.** Never describe the same mechanism twice. The doc owning the file where the
  mechanism *lives* holds the text; every other doc gets a one-line link. (`serve.py` was once
  documented twice at 8KB apiece — that is what this rule prevents.)
- **Size guard: if CLAUDE.md exceeds ~60KB, detail has leaked back in.** Move it out.
- A new `.claude/docs/*.md` needs an `Owns:` / `Read before:` / `Related:` header and a routing
  row here.

## Maintenance reminder

At the end of every task, review whether the **owning `.claude/docs/*.md`**, this file, and
`README.md` still match reality (features, build steps, architecture). If anything has drifted,
update it as part of the same task before declaring the task complete.

Also review `samples/`: when a feature is added, changed, or removed, update the relevant sample
so it keeps demonstrating current behaviour. Keep samples concise — one focused file per feature
area, no duplicated content.

Cutting a release is **automated** by the `main`-branch `post-merge` hook: merging into `main`
auto-bumps the version in all three places and prepends a draft `## v<X.Y.Z>` section to
`HISTORY.md`; the installer build, commit and tag happen afterwards via `-Finalize` (no
auto-push). The merge writes only a draft, and `-Finalize` refuses while it is unreviewed — so
raw commit subjects cannot reach a user. Full flow: `.claude/docs/release.md`.

After updating any bundled third-party library, rerun `pwsh -File tools/collect-licenses.ps1`
to regenerate `assets/THIRD_PARTY_LICENSES.txt` before building the installer. The file is
git-ignored, so there is no commit step.

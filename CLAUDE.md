# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A standalone desktop markdown previewer built with Rust for **Windows only**. Features at a glance — see the dedicated sections below for details:

- Real-time GitHub-flavored markdown preview with **auto-reload on external file changes**
- **Fully offline capable** — all dependencies bundled locally (no CDN required at runtime)
- Mermaid diagrams, KaTeX math, syntax-highlighted code blocks with copy button, SmartArt (fishbone, mandala chart, BMC, flow, cycle), CSV/TSV codeblocks → tables, Markdown footnotes — see *Preview Pipeline*
- Image base64 embedding, Obsidian-style `|WxH` sizing, relative-path resolution — see *Preview Pipeline*
- Drag & drop file/folder support, `.md` file association, cross-file `.md` link navigation with back/forward history — see *Preview Pipeline*
- **Companion editor window** (`E` key, CodeMirror 6 + Vim, live preview, autocomplete) — see *Companion Editor Window*
- **Dark / Light toggle** (`M` key), **user-defined styles** picker (`S` key, table modal over `assets/*.css`), **auto section numbering** (`N` key), **per-style HTML exporters** — see *Styles & Theming*
- **Marp presentation slides** (`marp: true` YAML front-matter, 3 view modes via `P` key) — see *Marp Mode*
- **Workspace (directory) mode** with file tree, `_toc.md` support, recursive watcher — see *Workspace Mode*
- **Export to standalone HTML** (`X` key, single file or full workspace) — see *Export*
- **Help modal** (`H` key), **Zoom shortcuts** (`Ctrl++`, `Ctrl+-`, `Ctrl+0`), sidebar navigation

## Platform Requirements

This application assumes a **Windows environment only**:
- Uses WebView2 (Windows-specific WebView runtime)
- Build target is Windows executable (.exe)
- Window subsystem disabled for Windows release builds (no console window)

## Preview Pipeline

Markdown is rendered server-side to HTML via Rust's `pulldown-cmark` for the initial load and re-rendered client-side via `marked` for live updates. Both pipelines feed into `#preview` in `assets/index.html`.

- **Mermaid / SmartArt** — ` ```mermaid ` and ` ```smartart ` fenced blocks are intercepted post-`marked.parse()` and substituted with rendered SVG. SmartArt supports fishbone, mandala chart, BMC (Business Model Canvas), flow, and cycle diagrams via the bundled `smartart.js`. All SmartArt types accept an optional `scale: <factor>` directive alongside `title:` (e.g., `scale: 0.7` shrinks to 70%, `scale: 1.5` enlarges to 150%); applied by `applyScale()` in `assets/libs/smartart.js`, which post-processes the root `<svg>`'s `width`/`height` attributes and strips `max-width:100%` from the inline style when the factor exceeds 1 so the diagram can overflow the container.
- **CSV / TSV codeblocks** — fenced ` ```csv ` / ` ```tsv ` render as HTML `<table>` (first row → `<thead>`). CSV parsing follows RFC 4180 (quoted fields may contain commas, newlines, and `""` for a literal quote); TSV splits each line on `\t` with no quoting. Fully-empty rows (blank lines anywhere in the source — leading, between header and body, or trailing) are dropped before the first row is assigned to `<thead>`, so authors can add visual whitespace inside the fence without producing a stray empty `<tr>`. Output wraps the table in `<div class="csv-table">` and inherits each theme's existing table styling. Carries through to HTML export since the live `<table>` DOM is serialized.
- **KaTeX math** — `$...$` and `$$...$$` are extracted via `extractMathInto` placeholder pass *before* `marked.parse` and rendered as pre-rendered spans afterward. Same placeholder pass runs on footnote bodies so footnote math, tooltips, and exported artifacts all share the same KaTeX output.
- **Syntax highlighting** — `highlight.js` colors code blocks; every block gets a copy button.
- **Footnotes** — standard Markdown footnote syntax (`[^id]` references and `[^id]: body` definitions, including multi-paragraph indented bodies). References render as sequentially-numbered superscript links; a `Footnotes` section is appended at the bottom with back-links, and hovering a reference shows the footnote content in a Wikipedia-style tooltip. Implemented as an inline `marked` extension in `assets/index.html` (no Rust changes); carries into HTML exports automatically since the export serializes the live `#preview` DOM.
- **Base64 image embedding** — images are inlined as data URIs at load time (works around WebView2 limitations with dynamic local images).
- **Image sizing** — Obsidian-style pipe syntax inside the alt text: `![alt|300](p)` (width px), `![alt|300x200](p)` (width × height), `![alt|x200](p)` (height-only), `![alt|@0.5](p)` (scale × intrinsic size). Implemented as a webview-side pass (`applyImageSizing()` in `assets/index.html`) that runs after both `marked.parse()` and `renderMarp()`. Pixel dimensions become `width`/`height` attributes; scale resolves to a concrete `width` once the (already-base64) image reports its `naturalWidth`. The sizing suffix is stripped from the displayed `alt`. Carries through to HTML export.
- **Relative image paths** are resolved against the directory of the open markdown file (current-directory tracked in `src/main.rs` via `Arc<Mutex<…>>`).
- **Cross-file `.md` link navigation** — clicking a link to another `.md` / `.markdown` file re-opens it in the current viewer (WebView2 blocks `file://` navigation, so the click is routed back to the Rust host via `openmd:` IPC).
- **Back / Forward history** — each cross-file navigation pushes a `history.pushState` entry, so WebView2's native context-menu「戻る」/「進む」, `Alt+←` / `Alt+→`, and mouse side buttons traverse previously opened files. `popstate` routes the stored filepath back to Rust via the same `openmd:` IPC.
- **Zoom shortcuts**: `Ctrl++`, `Ctrl+-`, `Ctrl+0`.
- **Help modal** (`H` key) — toggles a modal listing every keyboard shortcut. Closed by `H` again, `Esc`, the × button, or clicking the backdrop. Pure webview-side feature in `assets/index.html`; no Rust changes. The modal also has a **Third-party licenses** link that fetches and shows `assets/THIRD_PARTY_LICENSES.txt` in a `<pre>` pane.

## Companion Editor Window

Opened by pressing `E` in the preview. Paired editor window (`assets/editor.html`) loading CodeMirror 6 bundled at `assets/libs/editor/editor.iife.js`.

### Spawning & pairing

1:1 paired with the preview window via `EditorRegistry` in `src/editor_registry.rs` — no broadcast, no WebSocket, so multiple preview/editor pairs cannot cross-talk. `spawn_editor_window` is called once on the first `E` keypress; the editor window registers `editor:save:` / `editor:cursor:` / `editor:change:` / `editor:close:` / `editor:listdir:` IPC handlers that dispatch `CustomEvent`s back to the main event loop. Strict path filter on `editor:cursor:` and `push_jump_to_editor` so messages can only flow between the matched pair. The editor follows the preview: switching files in the preview reloads the editor (with a confirm dialog if the buffer is dirty). `editor.css` is excluded from the preview's `M`-key style cycle by name.

### Save channel (`editor:save:`)

`Ctrl+S` (or Vim `:w` / `:wq`) saves. Rust's `editor:save:` handler writes to disk, adds the path to `suppressed_saves` for 1.5s so the `notify` watcher doesn't loop, and pushes the saved content back to the preview in-memory (`CustomEvent::EditorSavedContent`) for flicker-free re-render. The editor's `dirty` flag flips back to `false` on save (and on file-switch via `push_file_to_editor`).

### Live preview channel (`editor:change:`)

Every `docChanged` update fires a debounced (~150 ms) `editor:change:` IPC carrying `{path, content, line}`. Rust routes it as `CustomEvent::EditorLiveContent`, which re-renders the preview from memory (no disk write, no `suppressed_saves`, no title change) and immediately calls `window.applyEditorScroll(line)` so the DOM rebuild stays anchored on the cursor. `dirty` / `savedDoc` are untouched by the live channel, so the title-bar dirty-dot and the file-switch dirty-confirm dialog still gate on actual saves. `doSave()` cancels any pending live debounce so a save is the canonical post-save render. `applyEditorScroll` in `assets/index.html` lands the cursor's `[data-line]` block ~1/4 from the top of the preview viewport (clamped to scroll-top 0) so the reader keeps upstream context above the active line.

### Dirty close handling

When the editor window is closed while the buffer is dirty (Vim `:q!`, the window X button, etc.), the preview reverts to the on-disk version. Rust tracks a `dirty: bool` on the editor registry state — flipped to `true` in the `editor:change:` IPC branch and back to `false` on save / file-switch. Both close paths (`EditorCloseRequested` for Vim `:q`, `WindowEvent::CloseRequested` for the X button) call `EditorRegistry::close_take_dirty_path()`, which `take()`s the state and returns the paired path only when dirty; the main loop then calls `load_and_render` to re-render the preview from disk. Clean closes return `None` and skip the re-render to avoid flicker.

The editor JS also pushes every dirty-flag transition over the `editor:dirty:<true|false>` IPC; the Rust handler calls `window().set_title("• <name> — Editor")` (or without the bullet when clean) so the OS window title bar and taskbar entry advertise the unsaved state — the auto-hiding status bar would otherwise be the only indicator while the cursor is in the editing area.

### Vim & default keybindings

The Vim extension (`@replit/codemirror-vim`) is swapped in/out of a CodeMirror `Compartment` by the status-bar toggle (default **OFF** — pure CodeMirror 6 keybindings). When ON, NORMAL mode begins immediately and the `:w` / `:wq` / `:q` / `]]` / `[[` / `za` / `zA` / `C` mappings activate.

**Tab / Shift+Tab** インデント／アンインデントは `@codemirror/commands` の `indentWithTab` を `mathInputAssistKeymap()` の直後（`searchKeymap`/`defaultKeymap` より前）に挿入することで実現している。これにより数式コンテキスト（`$`+Tab / `\begin{}`+Tab 等）は引き続き YaTeX 風展開が先勝ちし、未マッチ時のみ通常インデントへフォールスルーする。これが無いと WebView2 が未捕捉 Tab をフォーカス遷移として扱い、ステータスバーのトグル等へフォーカスが飛んでしまう。

**数字付きリスト対応インデント** — `mathInputAssistKeymap()` と `indentWithTab` の間に `numberedListIndentKeymap()`（`tools/build-editor/numberedListIndent.js`）を挟み込み、カーソル上方に `^(\s*)(\d+)\.\s` の数字付きリスト祖先が存在するときは Tab / Shift+Tab のインデント単位をマーカーのテキスト幅（`<digits>.` + 半角スペース、例: `1. ` → 3 / `10. ` → 4）に切り替える。CommonMark / GFM が要求する「子要素はマーカー直後のカラムに揃える」規約に合わせるためで、これが無いとデフォルト `indentUnit = 2` のせいで `1. item1` 配下に `- subitem` を書いても `marked` / `pulldown-cmark` 双方で別段落扱いになりリストがネストしない。空白のみの行頭ではマーカー幅倍数のタブストップにスナップし、行頭が `^\s*(?:[-*+]|\d+\.)\s` でカーソルがマーカー内/直後にある場合は行全体を 1 段下げてサブリスト化する（`Enter` で生成された `2. ` を即 `Tab` でデモートする典型シナリオ）。祖先が見つからない通常段落や、行頭以外の位置の `Tab` は `false` を返して `indentWithTab` にフォールスルーするので従来挙動は維持される。フェンス内 (``` / ~~~) は数字付きマーカー探索の対象外。

**日本語ワード境界対応** — `w` / `b` / `e` / `W` / `B` / `E` / `ge` / `gE` および INSERT モードの `<C-w>`、加えて `dw` / `cw` / `yw` / `daw` / `diw` / `vw` などのオペレータ保留形を、漢字 (CJK) / ひらがな / カタカナ / ASCII 単語 / 記号 の文字クラス境界で停止させる。`tools/build-editor/jpWordMotion.js` が upstream `@replit/codemirror-vim` の `findWord` / `moveToWord` を移植して `Vim.defineMotion('moveByWords', ...)` で丸ごと差し替える形で実装。`W` / `B` / `E` の big word は ASCII 単語と ASCII 記号を 1 クラスに潰しつつ日本語 3 クラスは独立、というハイブリッド。長音符 `ー` (U+30FC) はカタカナ固定（`ラーメン` は 1 単語）。Vim OFF 時の CodeMirror 標準 word motion には影響しない。

### Math input assist (YaTeX 風)

- `$`+Tab → `$|$`
- `$$`+Tab → fenced display block
- `\begin{env}`+Tab → matching `\end{env}`
- in-math command stubs: `\frac` / `\sqrt` / `\sum` / …
- `a.` / `b.` / `g.` → `\alpha` / `\beta` / `\gamma` greek shortcuts inside inline math
- **`\left<delim>` 自動ペア挿入** — 数式コンテキスト内で `\left` の直後に区切り文字 (`(` `[` `\{` `\|` `|` `<` `/` `.` `\langle` `\lfloor` `\lceil` `\lgroup` `\lmoustache` `\backslash`) を入力すると、即座に対応する `\right<closer>` がカーソル後ろに自動挿入される（例: `\left(` → `\left(|\right)`、`\left\langle` → `\left\langle|\right\rangle`、`\left.` → `\left.|\right.`）。カーソルは開き直後にとどまる。Tab は不要。`mathInputAssist.js` の `leftRightAutoPair()`（`EditorState.transactionFilter`）で実装、`isUserEvent('input.type')` ガードで undo / paste / プログラム的編集ではトリガしない。直後に既に `\right` が続いている場合は二重挿入を抑止。コードフェンスや通常文中では発火しない（`isInsideMath` で判定）。

### Heading nav & section folding

ATX-heading code folding via a custom `foldService` on `#` / `##` / `###…` lines.

In Vim NORMAL:
- `]]` / `[[` — move to the next / previous ATX heading line
- `za` — toggle the fold on the section enclosing the cursor
- `zA` — toggle all heading folds (if any fold is active, all are unfolded; otherwise every ATX section's *body* is folded — each fold stops at the next heading regardless of level, so every heading line stays visible)

Implemented in `tools/build-editor/entry.js` via `Vim.defineAction` + `Vim.mapCommand` (`context: 'normal'`) and `@codemirror/language`'s `foldEffect` / `unfoldEffect` / `foldedRanges` / `unfoldAll`, sharing the `computeHeadingFoldRange` helper with the existing `foldService`.

### Character count modal (`C` in Vim NORMAL)

Opens a modal showing total chars, body-only chars (excluding YAML/code/math), words, lines, paragraphs, plus selection sub-stats. While the modal is open `body.status-pinned` keeps the status bar visible.

### Autocomplete

Provided by `@codemirror/autocomplete` via three custom sources in `tools/build-editor/`:

- `texEnvComplete.js` — triggers right after `\begin{` and lists KaTeX environments (`equation`, `align`, `matrix`, `cases`, …). Accepting an option inserts `name}\n  \n\end{name}` and parks the cursor on the indented body line; envs needing a column-spec (like `array` / `alignat`) land the cursor inside `{}` after the name instead.
- `katexCommandComplete.js` — triggers on `\` followed by zero-or-more ASCII letters when the cursor is inside a math context (`isInsideMath` from `mathInputAssist.js` — covers `$…$`, `$$…$$`, and `\begin{}…\end{}`). Lists ~200 KaTeX-supported commands grouped by `detail` category (greek / operator / relation / arrow / big-op / function / decoration / font / delim / spacing / env / symbol). Apply behavior: plain symbols (`\alpha`, `\to`, `\infty`) insert as-is; one-arg decorations and fonts (`\sqrt`, `\hat`, `\mathbb`, `\text`) insert `\name{}` with the cursor inside the braces; two-arg commands (`\frac`, `\binom`, `\dfrac`) insert `\name{}{}` with the cursor in the first brace; big operators (`\sum`, `\int`, `\lim`) insert `\name_{}^{}` with the cursor inside `_{}`; `\begin` / `\end` insert `\name{}` so `texEnvComplete` can pick up the env-name completion. Never fires outside math (code fences and inline code are excluded by `isInsideMath`).
- `pathComplete.js` — triggers inside the URL portion of markdown links / images (`[label](…` or `![alt](…`) and lists sibling files & folders relative to the currently-edited file's directory. Filtered to `.md` / `.markdown` and image extensions (image-only when `!` is present); selecting a directory appends `/` and re-queries so the user can drill down. Backed by an editor↔Rust IPC channel: JS posts `editor:listdir:` + `{id, base, sub}`, Rust validates that `base` equals the parent directory of the paired file (rejects `..` segments), reads the directory, and pushes results back via `window.__listDirResult(id, entries)`.

`completionKeymap` is added to the editor's `keymap.of([...])` — Tab is *not* claimed by the completion popup, so math-input-assist's Tab handler continues to win when the popup is closed; Enter accepts the highlighted suggestion.

### Status bar

Sits as an `absolute` overlay at the top of `#root` (so the editing area fills the whole window) and **auto-hides**: slides in only when the mouse enters the top 8 px hot-zone (`.status-hotzone`), when the bar itself is hovered, while a Vim ex/search panel is open (`body.vim-panel-open`, set by a `MutationObserver` watching for `.cm-vim-panel`), or while the character-count modal is open (`body.status-pinned`).

Three right-aligned toggle buttons:
- **`Vim: ON / Vim: OFF`** — swaps the `vim()` extension in/out of a `Compartment`. Default OFF.
- **`# Abs / # Rel / # Off`** — cycles the line-number gutter through absolute / relative / off via a second `Compartment`. In relative mode the gutter is forced to redraw on cursor-line change by a deferred `lineNoComp.reconfigure(...)` from the `EditorView.updateListener`, since CodeMirror doesn't re-invoke `formatNumber` on selection-only updates. The same modes are driven by Vim ex commands: `:set number` / `:set nu` → absolute, `:set nonumber` / `:set nonu` → off, `:set relativenumber` / `:set rnu` → relative, `:set norelativenumber` / `:set nornu` → absolute.
- **`Theme: Light / Theme: Dark`** — toggles the editor's color scheme. When Dark, `@codemirror/theme-one-dark` is swapped in via a third `Compartment` (`themeComp`) and `document.body` gets a `theme-dark` class so `assets/editor.css`'s CSS-variable chrome (status bar, panels, char-count modal, vim ex-prompt) follows. Default is Light regardless of OS `prefers-color-scheme` (the previous OS-driven media query was replaced by the explicit toggle so the user choice always wins).

All three prefs persist via `localStorage` keys `editor:vim` (`on` / `off`), `editor:lineNumbers` (`absolute` / `relative` / `off`), and `editor:theme` (`light` / `dark`).

### IME (Windows) integration

WebView2 exposes no JS API to read or set the OS IME open-status, so the editor uses a Rust-side bridge in `src/ime_win.rs` that wraps Win32 IMM32 (plus `SendInput` as a last-resort fallback):

- **Auto half-width on Vim NORMAL** — we subscribe to the CM5 adapter's `vim-mode-change` event via `getCM(view).on('vim-mode-change', ...)` (the global `Vim.onChangeMode` from earlier `@replit/codemirror-vim` releases does **not** exist in the bundled version — only the per-cm5 event works). On any transition out of INSERT (Esc, `<C-[>`, `:stopinsert`, visual entry, …) the editor JS posts `editor:ime:off` IPC; the Rust handler in `editor_registry.rs` then calls `ime_win::set_ime_open(hwnd, false)`. The CM5 adapter is created/destroyed by the `vimComp` Compartment, so the listener is (re)attached from `setVim(true)` and once at boot — `__vimSubAttached` dedupes.
- **`set_ime_open` strategy** — `set_ime_open` casts a wide net because Chromium's TSF backend often ignores IMM messages aimed at the tao top-level HWND:
  1. Gather candidate HWNDs: focused descendant (`GetGUIThreadInfo`) → every child of the tao window (`EnumChildWindows`) → the tao window itself.
  2. For each candidate: `ImmGetContext` + `ImmSetOpenStatus` (direct API) **and** `SendMessageW(ImmGetDefaultIMEWnd, WM_IME_CONTROL, IMC_SETOPENSTATUS)` (control-message API).
  3. Re-read open-status; if any candidate still reports the opposite state, `SendInput` a synthetic `VK_KANJI` (0x19, 半角/全角) keystroke — the only path that reliably reaches WebView2's TSF-backed IME on most setups.
  Bails immediately if no descendant of the editor's GUI thread has keyboard focus, so the SendInput fallback never yanks IME state away from another foreground app.
- **Full-width cursor tint** — alongside the editor a 200 ms polling thread reads `ImmGetOpenStatus` (with the same multi-HWND candidate sweep) and sends transitions to the main loop as `CustomEvent::EditorImeStatus(bool)`; the main loop pushes the bool to JS via `window.__setImeOpen`, which toggles `body.ime-open`. `assets/editor.css` colors `.cm-cursor` / `.cm-cursor-primary` (INSERT thin caret) and `.cm-fat-cursor` (NORMAL block caret) amber when the class is on, with brighter equivalents under `body.theme-dark`. The poller exits cleanly when `IsWindow(hwnd)` reports the editor window is destroyed; it also no-ops when the editor isn't the focused window.
- **Forensic log bridge** — the editor webview also has an `editor:log:<msg>` IPC handler that writes to `md-previewer.log`, mirroring the preview's `app://__log/…` GET channel. Useful for diagnosing future IME / Vim-mode issues without an attached debugger.

## Styles & Theming

- **`M`-key dark/light toggle** — flips `body.dark-mode` and re-initializes mermaid with the matching theme (`dark` vs `default`). Persisted in `localStorage.darkMode` (`'true'` / `'false'`). Orthogonal to the user-style selection: e.g. `parchment.css` + dark mode compose freely.
- **`S`-key style picker** — opens a modal table listing every `.css` in `assets/` (excluding `editor.css`) plus a `Default` row. Clicking a row applies it and persists the selection in `localStorage.styleName` (`Default` clears the key). User CSS files are loaded as `<link id="user-style">`; styles compose with dark mode (e.g. `tategaki.css`'s vertical layout stays put when `M` flips colors). The Rust host scans `assets/*.css` once at startup and exposes the filename list as `window.__userStyles`.
- **Legacy localStorage migration** — the previous single-axis `styleName` schema (`'light'` / `'dark'` / `<filename>`) is migrated on startup: `'dark'` → `darkMode='true'` + clear `styleName`, `'light'` → `darkMode='false'` + clear `styleName`, filename → kept as-is.
- **Bundled starter themes**:
  - `parchment.css` — warm cream / antique-paper theme.
  - `tategaki.css` — Japanese vertical-writing theme (`writing-mode: vertical-rl`, mincho fonts, kinsoku 禁則 / tate-chu-yoko 縦中横 / palt 約物詰め, with `pre` / `table` / `img` / math / mermaid / smartart kept as horizontal islands; intentionally color-agnostic so it composes with both Light and Dark).
  - `classical.css` — 格調高い書籍風テーマ。本文セリフ (Palatino Nova → Palatino Linotype → Iwata Mincho Old → 游明朝)、見出しサンセリフ (Optima → Candara → Iwata Gothic Old → 游ゴシック)、強調語 (`strong` / `b` / `em` / `i` / `mark`) はサンセリフで「ゴチ起こし」風に。淡いアイボリー × 深ワインレッドのアクセント。`body.dark-mode` 下のダーク用パレットも CSS 変数で持つので M キーと直交合成。
- **Auto section numbering** (`N` key) — toggles `body.numbered`, persisted in `localStorage.numbered`. Baseline counter rules (CSS counters `num-h2 / num-h3 / num-h4` rendering as `1.`, `1.1`, `1.1.1` prefixes on h2/h3/h4) live in the inline `<style>` block in `assets/index.html` so numbering works on every theme by default. Themes can override the `::before` content/styling for a custom presentation. `body.numbered` is also propagated into the exported HTML artifact when active.
- **Per-style HTML exporters** — any user style `assets/<base>.css` can ship a sibling `assets/<base>_export.js` ES module that exports `async function exportStyle({ currentMarkdown, currentFilePath, preview })`. At startup the Rust host probes every discovered `.css` for the matching `_export.js` and emits the resulting map as `window.__styleExporters` (same injection point as `__userStyles` / `__marpThemes` in `src/main.rs`). When `X` is pressed, `exportHtml()` looks up the active style in this map and, if present, dynamically `import()`s the module and delegates to its `exportStyle`; otherwise it falls through to the general `buildExportArtifact()` pipeline. Any import or invocation error logs a warning and also falls through, so missing / broken exporters can never block the standard export.

## Marp Mode

When a markdown document begins with a YAML front-matter block containing `marp: true`, the previewer switches to a slide-rendering pipeline backed by `@marp-team/marp-core` (bundled as a single IIFE at `assets/libs/marp/marp.iife.js`).

- **Themes** — slides render as 16:9 sections using Marp's built-in themes (`default` / `gaia` / `uncover`, selected via the `theme:` directive). Additional user-defined themes can be dropped into `assets/marp/*.css` (each file must begin with a `/* @theme <name> */` header) and selected by name via the same `theme:` directive — the Rust host scans `assets/marp/` at startup and exposes the file list as `window.__marpThemes`, which `renderMarp()` fetches once and registers via `marp.themeSet.add()` before rendering. A `magenta.css` (magenta accent + teal rule, inheriting `default`) is bundled as a starter.
- **Extension inheritance inside slides**:
  - `[^id]` footnotes — extracted before passing markdown to marp-core and restored as `<sup>` tags afterward, with the footnote body appended as a final `<section class="footnotes-slide">`.
  - ` ```mermaid `, ` ```smartart `, and ` ```csv ` / ` ```tsv ` code blocks — post-render DOM substitution, reusing the same renderers as the regular pipeline.
  - `highlight.js` for syntax-coloring.
  - KaTeX math and Marp directives like `paginate` work out of the box.
- **Three view modes** (cycled by `P`: scroll → deck → list → scroll):
  - **Scroll mode** (default) — stacks every slide vertically.
  - **Deck mode** (`body.deck-mode`) — one slide at a time, navigated by `←` / `→` / `PgUp` / `PgDn` / `Space` / `Home` / `End`, with a counter overlay in the bottom-right and `F` to toggle fullscreen.
  - **List mode** (`body.list-mode`) — every slide as a clickable 16:9 thumbnail in a responsive CSS grid; clicking a thumbnail jumps into deck mode focused on that slide.
- **Persistence** — the active mode is persisted to `localStorage.marpView` (`'scroll' | 'deck' | 'list'`); the legacy `localStorage.deckMode` boolean is read once for back-compat.
- **Constraints** — in Marp mode the TOC sidebar is hidden, section numbering and the `M`-key dark toggle and `S`-key style picker are no-ops (Marp themes win — a toast explains), and editor-sync scroll is disabled because marp-core output carries no `data-line` attributes. The user-style `<link id="user-style">` is also stripped from `<head>` on entering Marp mode (so generic `body` / `#preview` / heading rules from `parchment.css` / `tategaki.css` etc. don't cascade into slide `<foreignObject>` text); `localStorage.styleName` is preserved, and the link is re-injected automatically when the next non-Marp document is rendered.

## Workspace (Directory) Mode

Entered by passing a directory as the CLI arg, dropping a folder onto the window, or right-clicking a folder in Explorer (when the installer has registered the folder context-menu entry under `HKCU\Software\Classes\Directory`).

- **Workspace payload** — `build_workspace` in `src/main.rs` builds a `Workspace { root, tree, fromToc, firstFile }` payload and pushes it to the webview via `window.loadDirectoryFromRust(workspace)`.
- **`_toc.md` parsing** — if `<root>/_toc.md` exists it is parsed (via `pulldown-cmark`) as a nested markdown bullet list of `[Title](relative/path.md)` links — sub-lists become folder groups; files present on disk but absent from `_toc.md` are appended under a synthetic `Other` group. Otherwise the tree is built by recursive walk (dirs first then files, alphabetical; skips dot-prefixed names plus `node_modules` / `target` / `dist` / `build`).
- **Heading extraction** — during tree construction each file is also parsed for its heading list. `extract_headings_from_md` walks the `pulldown-cmark` event stream; the first `h1` becomes the file's `title`, every heading gets a `slug` produced by `slugify`, a Rust port of the `generateHeadingId` algorithm in `assets/index.html` — **keep the two in sync**.
- **File-tree UI** — rendered into a `#file-tree` section that replaces the per-document `#toc-nav` in workspace mode (the legacy heading ToC is hidden by `body.workspace #toc-content { display: none }`). Each file appears as a foldable `<details>` whose `<summary>` is the document's `h1` title (filename if none), with `h2`–`h6` headings as child links indented by level. Folder groups (from `_toc.md` nesting or directory layout) wrap their members in an outer `<details>`. Open state is persisted per node in `localStorage.ft:<root>:<relPath>` for groups and `ft:<root>:<relPath>#` for files. Clicking a file title posts the existing `openmd:` IPC; clicking a sub-heading sets `pendingHeadingSlug` then posts `openmd:` so the post-load handler scrolls the target heading into view by id after rendering. The first file (depth-first) auto-loads on open; the active file gets `.ft-item.active` highlighting via `window.__setActiveFile`.
- **Watcher** — the `notify` watcher switches to `RecursiveMode::Recursive` for the root. Edits to the active file fire `FileChanged` → auto-reload as before, while create / rename / delete events fire `DirectoryChanged` → `build_workspace` rerun + `window.refreshFileTree`.
- **Sample workspace** at `samples/workspace/`.

## Export to standalone HTML (`X` key)

Opens a native Save-As dialog (via the `rfd` crate) and writes a self-contained `.html` artifact suitable for hosting on any static HTTP server.

- **Single file mode** — webview posts `exporthtml:<json>` IPC, Rust handler runs the dialog on a worker thread and writes the bytes. Artifact contains: the rendered `#preview` DOM (mermaid / SmartArt as inline SVG, KaTeX as pre-rendered spans, base64 images), the active style baked inline, and the `#toc-sidebar` with an inline script wiring up collapse-toggle, scrollspy (active TOC item highlights as the body scrolls, click-to-smooth-scroll), and Wikipedia-style footnote hover/tap popups. The artifact loads CSS for KaTeX and highlight.js from `cdn.jsdelivr.net` only when those features are actually used by the document.
- **Workspace mode** — in workspace mode `X` calls `exportWorkspace()` instead: it fetches each `.md` via the existing `app://localhost/userfile/...` route, renders it through the live pipeline, snapshots the artifact via `buildExportArtifact({pageRelPath})` (file-tree anchors are rewritten to `.html` paths relative to the page being exported), and posts `exportdir:` to Rust which `rfd::pick_folder()`s an output folder and writes one `.html` per source file (preserving directory layout) plus a root `index.html` that meta-redirects to the first page. Cross-file `.md` link rewriting carries over: links to sibling `.md` files become `.html` siblings.
- **Marp mode** — the live DOM (including marp-core's CSS injected as `<style id="marp-style">`) is serialized into the artifact.
- **Per-style exporter delegation** — when an active style ships an `_export.js`, `exportHtml()` dynamically `import()`s it and delegates (see *Styles & Theming → Per-style HTML exporters*).

## Architecture

### Build / installer / icon

- `build.rs` + `app.rc` + `assets/icon.ico` — Windows icon embedding. `build.rs` invokes the `embed-resource` build-dep to compile `app.rc` (a one-line Win32 resource script: `IDI_ICON1 ICON "assets/icon.ico"`), which embeds the multi-resolution `.ico` into the release exe so Explorer / taskbar / window chrome / `.md` file thumbnails (via the registry `DefaultIcon` pointing at `md-previewer.exe,0`) all use it. Only compiles on Windows targets.
- `tools/make-icon/make_icon.py` — Pillow-only generator for `assets/icon.ico`. Draws each size (16/32/48/64/128/256) programmatically: rounded-square navy→blue gradient + bold white "M" + a small down-arrow on sizes ≥ 48. No SVG renderer dependency. Rerun (`python tools/make-icon/make_icon.py`) when changing the design; commit the regenerated `.ico`.
- `installer/md-previewer.iss` (+ `installer/README.md`) — Inno Setup 6 script for the per-user Windows installer. Installs to `%LOCALAPPDATA%\Programs\MdPreviewer\` (no admin needed), bundles `target/release/md-previewer.exe` + the entire `assets/` tree + the `samples/` tree (demo Markdown files surfaced via a Start-menu "Sample Documents" shortcut that opens `{app}\samples` in Explorer), creates Start-menu (and optional desktop) shortcuts, and writes opt-in `HKCU` registry entries (ProgID `MdPreviewer.md`, `.md`/`.markdown` association, folder & file context menus) under user-toggleable wizard tasks (`assoc_md`, `ctx_folder`, `ctx_file`, `desktopicon`). AppId GUID is fixed (`892BC24C-95B0-43BB-8480-087C91AC6316`) so successive versions upgrade in place. `AppVersion` must be bumped in lockstep with `Cargo.toml`'s `version =`. Build: `iscc installer\md-previewer.iss` → `dist\MdPreviewer-Setup-<ver>.exe`. Caveat: if Windows' "Default apps" Settings has an explicit user choice for `.md`, that overrides the HKCU default written by the installer.

### Rust source

- `src/main.rs` — Rust app entry. Handles: window / event loop (`tao`), WebView2 host (`wry`), markdown → HTML (`pulldown-cmark`), file watcher (`notify`, swappable between single-file `NonRecursive` and workspace-root `Recursive`), custom protocol handler for serving assets and user files, base64 image embedding, current-directory tracking via `Arc<Mutex<…>>` for relative-path resolution, and workspace (directory) state via `Arc<Mutex<Option<Workspace>>>`.
- `src/editor_registry.rs` — owns the (at most one) paired editor `WebView` and routes preview↔editor IPC.

### Assets (loaded at runtime)

- `assets/index.html` — preview UI template.
- `assets/editor.html` + `assets/editor.css` — editor window UI template. Loads `assets/libs/editor/editor.iife.js` and calls `window.MdEditor.create(root)`.
- `assets/libs/` — bundled JS/CSS: `marked`, `mermaid`, `katex/`, `highlight.js/`, `smartart.js`, `marp/` (Marp Core IIFE), `editor/` (CodeMirror 6 + Vim IIFE).
- `assets/THIRD_PARTY_LICENSES.txt` — aggregated OSS license texts for every bundled library (direct + transitive npm deps of the `marp/` and `editor/` IIFE bundles). **Git-ignored — generated locally** by `tools/collect-licenses.ps1` (run via `pwsh -File tools/install-deps.ps1 -Licenses` or directly) and required on disk before `iscc` builds the installer. Must be regenerated whenever `tools/build-marp/` or `tools/build-editor/` dependencies change. The file ships through the existing `..\assets\*` recurse in `installer/md-previewer.iss` — no installer change needed. The MIME map in `src/main.rs` (`get_mime_type`) routes `.txt` as `text/plain; charset=utf-8` so WebView2 fetches it inline instead of prompting a download.

Assets are **read at runtime**, not embedded in the binary, so they must be present next to the executable (see *Build & Run Commands* below).

### Tools

- `tools/install-deps.ps1` — top-level installer. Orchestrates `fetch-libs.ps1` + both `build-*` projects + (optionally) `collect-licenses.ps1`. Run once after `git clone`. See *Build & Run Commands* for flags.
- `tools/fetch-libs.ps1` — downloads pinned versions of marked, mermaid, KaTeX (JS + CSS + 22 woff2 fonts), and highlight.js (JS + github theme CSS) from cdnjs / jsdelivr into `assets/libs/`. Idempotent (skips existing files unless `-Force`). When bumping a pinned version inside this script, also re-run `collect-licenses.ps1` so `assets/THIRD_PARTY_LICENSES.txt` stays in sync.
- `tools/build-marp/` — esbuild project that bundles `@marp-team/marp-core` (which ships only CJS) into the single IIFE at `assets/libs/marp/marp.iife.js`. Run `npm install && npm run build` after bumping the marp-core version. **Output is git-ignored** — regenerate locally via `install-deps.ps1`, do not commit.
- `tools/build-editor/` — esbuild project that bundles CodeMirror 6 + `@replit/codemirror-vim` + the in-tree `mathInputAssist.js` / `charCount.js` / `texEnvComplete.js` / `pathComplete.js` modules into the single IIFE at `assets/libs/editor/editor.iife.js`. Run `npm install && npm run build` to regenerate. Output is git-ignored.
- `tools/collect-licenses.ps1` + `tools/license-texts/*.LICENSE` — generator and per-library fallback license bodies. The script prefers each npm package's own `LICENSE`/`COPYING` file under `node_modules/`; for directly bundled libs that have no `node_modules` entry it reads `tools/license-texts/{marked,highlight.js,katex,katex-fonts,mermaid,smartart}.LICENSE`. A generic `tools/license-texts/Apache-2.0.LICENSE` is used as a last-resort fallback when an npm dep's `package.json` declares `Apache-2.0` but ships no LICENSE file in the tarball (currently triggered by `mj-context-menu`). The script uses `npm ls --omit=dev --all --parseable` to filter the dep tree down to runtime-only packages, so the bundler (esbuild + its `@esbuild/*` platform subpackages) is excluded — they don't end up in the IIFE artifact.

### Samples & logs

- `samples/` — example markdown files for manual testing.
- `md-previewer.log` (next to the exe, truncated each launch) — forensic log capturing exe path, resolved assets dir, discovered `__userStyles` / `__marpThemes`, any 404 on `.css` / `/marp/*` protocol requests, and JS-side events posted via `fetch('/__log/...')`. Used to diagnose "works in target/release, broken when copied" reports — release builds run under `windows_subsystem = "windows"`, so `eprintln!` is otherwise silently discarded.

## Build & Run Commands

**One-shot build (recommended):** `build.ps1` at the repo root wraps every step below — populate `assets/libs/`, generate the icon, run `cargo build --release`, and sync `assets\` into `target\release\assets\`. Idempotent (skips finished steps on re-run):

```powershell
.\build.ps1                 # release build from a fresh clone
.\build.ps1 -DebugBuild     # debug build (-> target\debug\)
.\build.ps1 -Clean          # cargo clean + wipe assets\libs\ first
.\build.ps1 -ForceDeps      # force install-deps.ps1 -Force
.\build.ps1 -SkipAssetCopy  # cargo build only, no asset sync
```

`build.ps1` detects whether deps are already installed by probing for `assets\libs\editor\editor.iife.js`, `marp\marp.iife.js`, `katex\katex.min.js`, and `marked.min.js`; if any are missing it calls `tools\install-deps.ps1`. Icon generation runs only when `assets\icon.ico` is absent. The script does **not** build the Inno Setup installer — see *Building the installer* below.

**Manual steps (equivalent to what `build.ps1` runs):**

1. Populate `assets/libs/` — none of the third-party JS/CSS/fonts nor the two esbuild IIFE bundles are tracked in git:

   ```powershell
   pwsh -File tools\install-deps.ps1
   ```

   This calls `tools/fetch-libs.ps1` (pinned CDN downloads of marked / mermaid / KaTeX + fonts / highlight.js), then `npm install && npm run build` in `tools/build-marp/` and `tools/build-editor/`. Flags: `-Force` re-downloads static libs, `-SkipNode` runs only the CDN step (no Node required), `-Licenses` also regenerates `assets/THIRD_PARTY_LICENSES.txt`.

2. Build the exe and copy assets next to it:

   ```bash
   # Build release version
   cargo build --release

   # Copy asset data (create target/release/assets/ first if it doesn't exist)
   cp -Force .\assets\* .\target\release\assets\

   # Run the application
   cargo run --release

   # Run with a specific file
   cargo run --release path/to/file.md

   # Build executable location
   target/release/md-previewer.exe
   ```

### Building the installer

For redistributable per-user installs, `build-installer.ps1` at the repo root wraps the full chain — runs `build.ps1` (which itself runs `install-deps.ps1` if needed, generates the icon, and `cargo build --release`s), regenerates `assets/THIRD_PARTY_LICENSES.txt`, then invokes `iscc`:

```powershell
.\build-installer.ps1                       # one-shot: build + licenses + iscc
.\build-installer.ps1 -SkipBuild            # skip build.ps1 (target\release is up to date)
.\build-installer.ps1 -SkipLicenses         # reuse the existing THIRD_PARTY_LICENSES.txt
.\build-installer.ps1 -Iscc 'C:\...\ISCC.exe'  # override ISCC location
```

`build-installer.ps1` finds `ISCC.exe` via PATH, falling back to standard install locations — per-user (`%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`) is checked first, then machine-wide `Program Files (x86)\Inno Setup 6\ISCC.exe`. Output: `dist\MdPreviewer-Setup-<AppVersion>.exe` (AppVersion is read from `installer\md-previewer.iss`).

**Manual equivalent:**

```powershell
# one-time / when icon changes
python tools\make-icon\make_icon.py

# build the exe (build.rs embeds assets/icon.ico via app.rc)
cargo build --release

# regenerate license file (git-ignored)
pwsh -File tools\collect-licenses.ps1

# compile the Inno Setup 6 installer
iscc installer\md-previewer.iss
# -> dist\MdPreviewer-Setup-<version>.exe
```

The installer bundles `target/release/md-previewer.exe` + the full `assets/` tree into a single `.exe` that installs to `%LOCALAPPDATA%\Programs\MdPreviewer\` without admin rights. See `installer/README.md` for prerequisites and versioning rules.

## Maintenance reminder

At the end of every task, review whether this `CLAUDE.md` and `README.md` still matches reality (features, build steps, architecture). If anything has drifted, update it as part of the same task before declaring the task complete.

Also review the `samples/` directory: when a feature is added, changed, or removed, update the relevant sample so it continues to demonstrate the current behavior. Keep samples concise — one focused file per feature area, no duplicated content.

After updating any bundled third-party library — adding/removing/upgrading a dep in `tools/build-marp/` or `tools/build-editor/`, or replacing one of the directly bundled files under `assets/libs/` — rerun `pwsh -File tools/collect-licenses.ps1` to regenerate `assets/THIRD_PARTY_LICENSES.txt` locally before building the installer. The file is git-ignored so there is no commit step.

# Companion editor / core

**Owns:** `assets/editor.html`, `assets/editor.css`, `tools/build-editor/entry.js` infrastructure, `src/editor_registry.rs`
**Read before:** changing editor spawn/pairing, the save or live channel, the status bar, the settings modal, or IME.
**Related:** editor-keymaps.md (key dispatch order), editor-cells.md, editor-tables.md, editor-autocomplete.md

> Relocated verbatim from `CLAUDE.md`. Invariants that apply everywhere stay in
> `CLAUDE.md`; this file holds the detail for the files listed above.

---

## Companion Editor Window

Opened by pressing `E` in the preview. Paired editor window (`assets/editor.html`) loading CodeMirror 6 bundled at `assets/libs/editor/editor.iife.js`.

### Spawning & pairing

1:1 paired with the preview window via `EditorRegistry` in `src/editor_registry.rs` — no broadcast, no WebSocket, so multiple preview/editor pairs cannot cross-talk. `spawn_editor_window` is called once on the first `E` keypress; the editor window registers `editor:save:` / `editor:cursor:` / `editor:change:` / `editor:close:` / `editor:listdir:` IPC handlers that dispatch `CustomEvent`s back to the main event loop. Strict path filter on `editor:cursor:` and `push_jump_to_editor` so messages can only flow between the matched pair. The editor follows the preview: switching files in the preview reloads the editor (with a confirm dialog if the buffer is dirty). `editor.css` is excluded from the preview's `M`-key style cycle by name.

**Cursor lands where the preview is looking** — the `E` keypress carries the source line currently shown at the top of the preview viewport: `window.currentPreviewLine()` (the inverse of `applyEditorScroll`, in `assets/index.html`) returns the `data-line` of the block ~25% in from the viewport's reading-start edge (the top, or the **right** edge under a vertical-writing theme — see *Live preview channel* below) — or, in Marp deck/list mode, the boundary line of the active slide (`__marpDeckIndex`); Marp scroll mode falls through to the generic nearest-block scan over the slide SVGs' `data-line`. The preview posts `openeditor:<line>`; `CustomEvent::OpenEditorWindow { line }` carries it to `spawn_editor_window(..., initial_line)`, which injects it into the `__initialFile` payload (`{path, content, line}`). The editor (`tools/build-editor/entry.js`) calls `window.__previewScrolledTo(line)` on next frame after the initial `loadFile`, reusing the same cursor-jump path as a preview click. When `E` is pressed while the editor is **already open**, the handler additionally calls `push_jump_to_editor(&path, line)` so the open editor re-syncs its cursor instead of only focusing.

### Save channel (`editor:save:`)

`Ctrl+S` (or Vim `:w` / `:wq`) saves. Rust's `editor:save:` handler writes to disk, adds the path to `suppressed_saves` for 1.5s so the `notify` watcher doesn't loop, and pushes the saved content back to the preview in-memory (`CustomEvent::EditorSavedContent`) for flicker-free re-render. The editor's `dirty` flag flips back to `false` on save (and on file-switch via `push_file_to_editor`).

### Live preview channel (`editor:change:`)

Every `docChanged` update fires a debounced (~150 ms) `editor:change:` IPC carrying `{path, content, line}`. Rust routes it as `CustomEvent::EditorLiveContent`, which re-renders the preview from memory (no disk write, no `suppressed_saves`, no title change) and immediately calls `window.applyEditorScroll(line)` so the DOM rebuild stays anchored on the cursor. `dirty` / `savedDoc` are untouched by the live channel, so the title-bar dirty-dot and the file-switch dirty-confirm dialog still gate on actual saves. `doSave()` cancels any pending live debounce so a save is the canonical post-save render. `applyEditorScroll` in `assets/index.html` lands the cursor's `[data-line]` block ~1/4 in from the reading-start edge of the preview viewport so the reader keeps upstream context before the active line.

**Both directions are axis-aware, and the axis is measured rather than inferred.** `applyEditorScroll` and its inverse `currentPreviewLine` branch on `__previewScrollsHorizontally()` — the same helper `capturePreviewAnchor` / `restorePreviewAnchor` use — because under a vertical-writing theme (`tategaki.css`, `bunko.css`) the preview runs leftward: the reader's "top of the viewport" is the container's **right** edge, the scroll axis is `scrollLeft`, and `scrollTop` never moves. Written against `rect.top` / `scrollTop` / `clientHeight` alone, editor→preview scrolling was a **silent no-op** under those themes and the `E`-key reverse jump always reported the same stale line. Two details:
- **The horizontal branch adjusts `scrollLeft` relatively** (`scrollLeft += (targetRect.right - containerRect.right) + margin`), exactly as `restorePreviewAnchor` does, rather than computing an absolute target. WebView2 leaves `scrollLeft` unnormalized for a right-to-left flow (0 is the visual *left*, i.e. the **end** of the content), so an absolute value would need a sign assumption; solving for the delta needs none and the engine clamps it. The relation it solves is `newRight = oldRight - delta`, which also fixes the sign of the **sub-block interpolation**: advancing into a block means moving *leftward*, so the `frac * width` term is **subtracted** (`delta = (targetRect.right - frac*width) - containerRect.right + margin`). Adding it instead is not a small offset error — it makes every cursor step onto a line between two stamped blocks (typically the blank line between paragraphs) scroll **backward**, with the next real line snapping forward again, so the preview visibly oscillates as the cursor is stepped line by line.
- **`currentPreviewLine`'s scan needs a 1px tolerance** (`dist <= threshold + 1`). `applyEditorScroll` lands the block's start edge at *exactly* `threshold`, but the engine snaps the resulting scroll offset to device pixels, so it settles a fraction past it (measured: 290.5 against a 290 threshold) — an exact comparison then breaks the scan at the very block just scrolled to and reports the one **before** it. This was wrong on the vertical axis too, i.e. the open→edit→reopen round-trip the function exists to keep stable was off by one block on both axes. Regression net: `tools/preview-harness/synccheck.py`.

The live channel can be disabled via the **ライブプレビュー** toggle in the settings modal (persisted in `localStorage.editor:livePreview`, default ON) — useful for large documents where mermaid / KaTeX re-renders on every keystroke are too costly. When OFF, `schedulePushLive()` is a no-op and any pending debounce is cancelled, so the preview only refreshes on explicit save (`Ctrl+S` / `:w` / `:wq`). Flipping back to ON immediately flushes the current buffer once via `pushLiveNow()` so the preview re-syncs without waiting for the next edit.

### Dirty close handling

When the editor window is closed while the buffer is dirty (Vim `:q!`, the window X button, etc.), the preview reverts to the on-disk version. Rust tracks a `dirty: bool` on the editor registry state — flipped to `true` in the `editor:change:` IPC branch and back to `false` on save / file-switch. Both close paths (`EditorCloseRequested` for Vim `:q`, `WindowEvent::CloseRequested` for the X button) call `EditorRegistry::close_take_dirty_path()`, which `take()`s the state and returns the paired path only when dirty; the main loop then calls `load_and_render` to re-render the preview from disk. Clean closes return `None` and skip the re-render to avoid flicker.

The editor JS also pushes every dirty-flag transition over the `editor:dirty:<true|false>` IPC; the Rust handler calls `window().set_title("• <name> — Editor")` (or without the bullet when clean) so the OS window title bar and taskbar entry advertise the unsaved state — the auto-hiding status bar would otherwise be the only indicator while the cursor is in the editing area.

### Character count modal (status-bar click)

Opened by clicking the character count in the status bar — there is **no keybinding**, because `C` (the obvious mnemonic) is Vim's change-to-EOL operator. Shows total chars, body-only chars (excluding YAML/code/math), words, lines, paragraphs, plus selection sub-stats. While the modal is open `body.status-pinned` keeps the status bar visible.

### Marp slide helpers

`tools/build-editor/marpSlides.js` adds slide-unit aware editing for Marp documents (mirrors the previewer's `renderMarp()` boundary logic: front-matter `marp: true`, slides separated by `---` / `***` / `___`, separators inside fenced code blocks and the front-matter block itself ignored). `scanSlides()` returns `{fmEnd, fmLastLine, seps, docLen}` in one pass; `slideAt(state, pos, scan)` resolves the slide unit containing the cursor (the leading `---` belongs to the slide it introduces; the first slide has none; the front-matter is reported as `inFrontMatter` and protected).

- **Insert slide** — opens a small **class-picker modal** (reuses the `cc-modal` shell + `.slide-class-grid` / `.slide-class-btn` styles in `assets/editor.css`) listing `none / title / section / lead / invert / split` (split-3/4 omitted — edit the `_class` line by hand for those). Picking one calls `insertSlideAfter(view, class)`, which inserts a new slide **after the slide under the cursor** (`\n---\n\n<!-- _class: NAME -->\n\n`, or no comment line for `none`) and parks the cursor on the new empty body line.
- **Copy / Cut slide** — `copySlide(view)` / `cutSlide(view)` write the current slide (leading `---` included) to the system clipboard (`navigator.clipboard.writeText` → synchronous hidden-textarea `execCommand('copy')` fallback for WebView2's custom scheme). Cut additionally removes the slide together with **one** separator so the deck is never left with a dangling `---` (handles first / last / only-slide cases); both no-op when the cursor is in the front-matter so `marp: true` is never destroyed. Edits go through `view.dispatch`, so the existing live-preview channel reflects them — no IPC.
- **Triggers** (chosen to avoid any Vim conflict): three status-bar buttons (`+ Slide` / `⧉ Slide` / `✂ Slide`) shown **only for Marp documents** (`updateMarpButtons()` re-checks via `isMarpDocument()` on file load, debounced on edit, and once at boot); Vim ex-commands `:slide` / `:slideyank` / `:slidecut`; Vim NORMAL-mode `gs` leader `gsi` (insert) / `gsy` (yank) / `gsd` (cut) — `gs*` is unused by `@replit/codemirror-vim`'s default keymap and by the existing `]] [[ za zA`, and isn't bracket-prefixed so it can't hit the `]<char>` / `[<char>` catch-all motions; and non-Vim `Ctrl+Alt+N` / `Ctrl+Alt+C` / `Ctrl+Alt+X` (added before `defaultKeymap`).

### 文字サイズ / フォント (font zoom)

`Ctrl` + `=` / `-` / `0` and **`Ctrl`+ホイール** scale the **editing text only** — the CodeMirror content and its gutters. The status bar, the modals and the Vim ex prompt are chrome and stay at their fixed sizes (VS Code's model, and the reason `.cm-panels .cm-vim-panel`'s `font-size: 16px` in `editor.css` is deliberately left alone). Size is clamped to **9–32 px**, default **15**; font family is picked from a fixed list. Both persist (`editor:fontSize` — the file's only numeric pref — and `editor:fontFamily`). Pure logic lives in `tools/build-editor/editorPrefs.js`; the modal / status bar / localStorage stay in `entry.js`, the same split as `mdTable.js`.

Four facts, each of which was verified rather than assumed and each of which a future edit can silently break:

- **CSS custom properties, NOT a Compartment.** `:root` carries `--editor-font-size` / `--editor-font-family`; `entry.js`'s `EditorView.theme` reads them via `var()` on `&` and `.cm-scroller`, and `setFontSize` / `setFontFamily` just write the variables. Font size holds no state and renders no decorations, so there is nothing to go stale — the rule `setTablePaste` already follows. A Compartment would cost a transaction and a ViewPlugin teardown per keystroke for one variable write. Corollary: **only** those two selectors reference the variables, which is exactly what confines the zoom to the editing surface.
- **`view.requestMeasure()` after every change is mandatory.** CodeMirror caches character width and line height in its `heightOracle`, and `EditorView.lineWrapping` is on, so skipping it leaves the wrap points and the caret drifting away from the rendered glyphs. `setFontFamily` needs it too — a different family means a different advance width.
- **A plain `keymap.of([...])` layer suffices even with Vim on.** `@replit/codemirror-vim` swallows a key in non-insert mode only when its name is a **single character** (`dist/index.js`: `key.length === 1 || (CM.isMac && /<A-.>/.test(key))`); `<C-=>` / `<C-->` / `<C-0>` are longer. `cells.js`'s pre-Vim gate independently returns `false` for any ctrl/meta/alt combo except `Ctrl+r`, and the document-level Esc chain bails on modifiers. So **none** of the `Prec.highest(EditorView.domEventHandlers)` machinery cell mode needed applies here. `prefscheck.py`'s "works in Vim NORMAL" case is the regression net if a dependency bump widens that condition.
- **`Mod-Shift--` must never be bound here.** `cells.js` owns it for "split cell at cursor". Zoom-out is the **shift-less `Mod--`** only — one modifier away, so this is asserted twice: `editorPrefs.test.mjs` checks the binding is absent, and `prefscheck.py` drives the real gesture and checks a cell still splits without the font changing. Zoom-in binds three aliases (`Mod-=` / `Mod-Shift-=` / `Mod-+`) because on a Japanese keyboard `=` is reached only with Shift.

`Ctrl`+ホイール is an `EditorView.domEventHandlers({wheel})` that `preventDefault`s (one notch = one step, regardless of `deltaY`). There is no WebView2 browser zoom to fight: the editor's `WebViewBuilder` has no `.with_hotkeys_zoom()`, and wry defaults `zoom_hotkeys_enabled` to `false` → `SetIsZoomControlEnabled(false)`. The `preventDefault` is only to stop the scroll.

The **cell-number gutter** (`.cm-cellNumbers .cm-gutterElement`) uses `font-size: 0.733em` (≈ the historical 11 px at 15 px) rather than a fixed px, so it tracks the text like the line numbers, which carry no `font-size` and already inherit it. Vim: `:fontsize 17` / `:fontsize +2` / `:fontsize -2` / `:fontsize` (reset).

### Status bar

Sits as an `absolute` overlay at the top of `#root` (so the editing area fills the whole window) and **auto-hides**: slides in only when the mouse enters the top 8 px hot-zone (`.status-hotzone`), when the bar itself is hovered, while a Vim ex/search panel is open (`body.vim-panel-open`, set by a `MutationObserver` watching for `.cm-vim-panel`), or while any modal is open (`body.status-pinned` — settings, char count, the Marp slide-class picker, the table size picker, the cell key list).

**The bar carries ACTIONS only; every preference lives in the settings modal.** It had grown to seven controls, which is what previously forced `editor:tablePaste` to be reachable through `:set notablepaste` alone with no UI at all. Right-aligned: **`⚙ 設定`** (opens the modal, also `:pref`), **`⊞ Table`** (insert a table — an action, visible in every document), then the three Marp-only slide buttons (`+ Slide` / `⧉ Slide` / `✂ Slide`, shown by `updateMarpButtons()`).

### Settings modal

Reuses the `.cc-modal` / `.cc-panel` shell, in three sections:

- **表示** — 文字サイズ (`−` / 値 / `+` / 戻す), フォント (select), テーマ, 行番号
- **編集** — Vim キーバインド, セルモード, 表の列ハイライト, 表の貼り付け変換
- **連携** — ライブプレビュー

**It only ever calls the existing setters** (`setVim` / `setLineNo` / `setTheme` / `setLive` / `setTableCol` / `setTablePaste` / `setCells` / `setFontSize` / `setFontFamily`), so the Vim `:set` / `gtc` / `gmc` paths keep working untouched and each pref still has exactly one owner. `updateToolbar()` became **`updateSettingsUI()`**: every setter calls it, so a pref changed from anywhere — an ex-command, a mapping, a `Ctrl+=` — is reflected the next time the modal opens.

Three things a new modal must register, and **omitting any one is a bug**: `isModalOpen()` (so cell mode's key gate stands down), the hard-coded newest-first Esc chain (the settings modal goes **first**), and `body.status-pinned` on open/close.

Two non-obvious details:

- **`refocusEditor()`.** Setters normally `view.focus()` so a click doesn't strand the caret. That is wrong while the modal is up — it would pull focus out from under the control just clicked and send the next keystroke into the document behind the backdrop — so the setters route their focus restore through a helper that no-ops while the modal is displayed. Asserted in `prefscheck.py` with a **real** `page.click()`; a programmatic `element.click()` does not move focus in Chromium and would make the assertion vacuous.
- **Each row states its shortcut / ex-command.** Before the consolidation the status-bar buttons' `title=` tooltips were the only documentation surface for `Ctrl+Alt+T` and friends, so these hints are load-bearing, not decoration.

Every color is an existing `var(--…)` token, so `body.theme-dark` is inherited with no dark-specific rules — same approach as `.table-size-form`.

All prefs persist via `localStorage` keys `editor:vim` (`on` / `off`), `editor:lineNumbers` (`absolute` / `relative` / `off`), `editor:theme` (`light` / `dark`), `editor:livePreview` (`on` / `off`), `editor:tableColHighlight` (`on` / `off`), `editor:tablePaste` (`on` / `off`), `editor:cellMode` (`on` / `off`), `editor:keyLayout` (`qwerty` / `dvorak`), `editor:fontSize` (a number — validated by `clampFontSize`, not the enum-only `readPref`) and `editor:fontFamily` (a key from `FONT_FAMILIES`, so the enum validator still applies and no arbitrary CSS string can ever be stored).

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

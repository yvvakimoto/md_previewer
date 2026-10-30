# Mermaid inspector window

**Owns:** `assets/inspector.html`, `assets/inspector/graph.js`, `assets/inspector/inspector.js`, `src/inspector_registry.rs`, and the preview's `__inspector*` / `__openMermaidInspector` / `__mermaidBlockInfo` helpers in `assets/index.html`
**Read before:** changing the inspector window, its IPC (`openinspector:` / `inspector:update:` / `inspector:close`), or how `renderMermaidCached()` keeps the source.
**Related:** preview-blocks.md (the mermaid engine and the figure context menu), rust-host.md, editor-core.md (the window-registry pattern this copies), i18n.md

User-facing description: README 「Mermaid インスペクタ（右クリック）」.

---

## Shape

A third window, read-only, at most one. The preview's figure menu posts a mermaid block's
**source**. Rust validates it, then spawns the window or pushes into the open one. The window
renders the source **itself**.

```
preview  --"openinspector:{json}"-->      Rust: parse_inspector_payload → CustomEvent::OpenInspectorWindow
                                          → spawn_inspector_window(…)   (or push(json, focus=true))
preview  --"inspector:update:{json}"-->   Rust IPC thread → InspectorRegistry::push(json, focus=false)
inspector --"inspector:close"-->          CustomEvent::InspectorCloseRequested
Rust (on any close)  --> preview  __inspectorTarget(null)
```

payload = `{kind: 'open'|'update', src, ordinal, line, file, dark}`, built by
`__inspectorPayload()`.

- **⚠ Why the window renders the source instead of being sent the preview's SVG.** The
  highlight needs edge endpoints. Only mermaid's flowchart db has them reliably
  (`diagram.db.getData()` → `{nodes:[{id, domId, label, isGroup}], edges:[{id, start, end, label}]}`).
  The SVG edge id `L_<start>_<end>_<n>` cannot be split, because author ids may contain `_`
  (`A_1`). The db exists only on a fresh parse, so the window parses
  (`mermaid.mermaidAPI.getDiagramFromText`) and renders itself.
  - Read the db **before** `mermaid.render()`.
  - Measured on mermaid 12.0.0:
    - a node's `<g>` id is `<svgId>-<domId>`, or `<svgId>-<id>` for a subgraph cluster
    - each edge `<path>` carries `data-edge` and `data-id="<edge.id>"`
    - each edge label is `g.edgeLabel .label[data-id]`
  - **A mermaid bump can rename any of these with no error.** The symptom is clicks that
    select nothing. `inspectorcheck.py`'s "all nodes / edges mapped to SVG" cases are the net.
- `diagram.type` is `flowchart-v2` for both `flowchart` and `graph`.
  - Any other type renders with pan/zoom and the minimap only. `graph` is then `null`, and
    every graph feature is guarded on it.
- **Mirrors:** `mermaidConfig()` mirrors `mermaidBaseConfig()` and `stripScale()` mirrors
  `parseMermaidScale()`. Both pairs are in CLAUDE.md's mirror table. The inspector must lay
  out the diagram exactly as the preview did.
  - What is mirrored is what moves a box: `MERMAID_FONT_STACK`, `MERMAID_LAYOUT` and
    `MERMAID_THEME_CSS` (the smaller edge-label font; copied verbatim). The style palette (`--md-mermaid-*`) is deliberately **not** — the highlight
    colours here were designed against the stock `default` / `dark`, colour never changes the
    layout, and the window follows only `darkMode` (via `storage`), not the style.

## Live follow (preview side)

The preview owns "which block". The host only relays.

- `__inspTarget = {src, ordinal, count, line}` is set **optimistically** by the menu click.
  The host clears it with `__inspectorTarget(null)` when the window closes, or when spawning
  failed.
- `__inspectorSync()` runs at the end of every `renderMermaidCached()`, i.e. both pipelines,
  on every render including the 150 ms live-edit ones. It re-locates the block in two steps:
  1. **Same block count** → same ordinal. This is the common case: typing inside the block.
  2. **Different count** → the block nearest the old `data-line`, with ordinal distance as
     the tie-break. Several blocks inside one list or fenced div share their ancestor's
     `data-line`, since `data-line` is stamped on top-level blocks only.
- It posts `inspector:update:` **only when the source changed**. Editing a different block,
  or toggling the theme, posts nothing.
- `data-mermaid-source` is written by `renderMermaidCached()` itself. Once present it is the
  source of truth, because the render overwrites `textContent`. A re-run on an
  already-rendered host must not read SVG text back as source.
- The attribute is **not** in `domdump.py`'s `ATTRS`, so DOM digests are unaffected. It rides
  into HTML exports harmlessly.

## The window (`inspector.js`)

- **Host entry:** `window.__inspectorInit`, set by the init script, then `window.__inspectorLoad(p)`.
  - `kind: 'open'` resets the selection and search and fits the view.
  - `kind: 'update'` keeps the selection (reconciled by node id: vanished ids are dropped)
    **and the viewport**.
  - An identical `src` on update is a no-op.
- **A failed render keeps the last good diagram.** The error goes in the hint chip. This
  matters because mid-typing sources are often briefly invalid. mermaid leaves its scratch
  `#d<id>` container behind on failure, so the window removes it.
- **Pan/zoom:**
  - One `<g class="insp-vp">` wraps everything but `<style>` / `<defs>`, which stay at the
    root so mermaid's `#svgId …` CSS and marker ids keep resolving.
  - It carries `matrix(s,0,0,s,tx,ty)`. Vectors stay crisp at any zoom; there is no bitmap
    scaling.
  - `target` is set by input and `view` chases it with a critically damped
    `1 − exp(−dt/55ms)` step.
  - ⚠ Interpolate s and t **linearly**, never s in log space. An anchored point's screen
    position `s·p + t` is linear in (s, t), so a linear glide keeps the point under the cursor
    exactly fixed *throughout* the animation. A log-space s makes it drift mid-glide and only
    land at the end.
  - **Mouse vs. touchpad** (`isTouchpadWheel()`). Measured values:

    | Input | Source | `deltaY` | `wheelDeltaY` |
    |---|---|---|---|
    | mouse notch | Playwright real wheel | 100 | −120 |
    | touchpad pinch (`ctrlKey`) | real app, CDP `Input.synthesizePinchGesture` | ≈ −1.3 … −3.3, fractional | **120** |
    | two-finger scroll | real app, CDP `synthesizeScrollGesture` | 3, 4 … (small) | — |

    ⚠ **`wheelDeltaY % 120` alone cannot tell them apart**, because a pinch reports a whole
    120 too. The first version classified every pinch as a mouse notch, so a ×1.5 gesture
    zoomed ×1.1 and the pinch "did not work". The size of `deltaY` is what separates them: a
    notch is ≥ 50 px. A large `deltaY` with a multiple-of-120 `wheelDeltaY` is a mouse;
    anything small or fractional is a touchpad.
    - Ctrl+wheel is continuous, clamped to [0.5, 2] per event, with no rungs. A **mouse** uses
      `exp(−deltaY·0.0025)` (~22% per notch) and glides. A **pinch** (the touchpad's
      Ctrl+wheel) uses `exp(−deltaY/100)` — Chromium's own encoding, so that value *is* the
      pinch scale — and applies immediately.
    - ⚠ Do not use one factor for both. 0.0025 made a pinch feel four times too sluggish,
      and 0.01 on a mouse notch is e≈2.7× (clamped to 2).
    - A **two-finger scroll** moves `target` and `view` by the same delta and repaints at
      once. The OS already supplies smooth, inertial deltas, so a glide on top only adds lag.
      Moving `view` too, rather than snapping it, lets a zoom glide still in flight finish.
  - A drag sets `target` and `view` together (no lag under the hand). A press that starts
    mid-glide first snaps `target` to `view`.
  - A press that moves less than 3 px is a click.
  - `with_hotkeys_zoom(false)`, as in the preview, so WebView2 page zoom never takes Ctrl ± / 0.
  - ⚠ **…but then `enable_touchpad_pinch()` (in `src/main.rs`, shared with the preview) turns `IsPinchZoomEnabled` back ON.** wry 0.24
    maps that one flag onto both settings. With pinch off, WebView2 drops a touchpad pinch
    before the page sees it: zero wheel events, measured over CDP. With pinch on, Chromium
    delivers it as a **cancelable** Ctrl+wheel.
    - The stage's listener turns it into the diagram zoom.
    - A document-level listener `preventDefault`s every Ctrl+wheel, so a pinch over the
      toolbar or panel cannot page-scale the window. Measured: `visualViewport.scale` stays 1
      and the diagram does not move.
    - A ×1.5 synthesized pinch zooms exactly ×1.50.
    - A touch*screen* pinch (`gestureSourceType: touch`) produces no wheel events.
      `html { touch-action: pan-x pan-y }` keeps it from page-scaling the toolbar and panel.
    - `isTouchpadWheel()` is mirrored as `__isTouchpadWheel()` in `assets/index.html`.
- **Hit testing:**
  - `g.node` → `g.edgeLabel` → `path[data-edge]` / `path.insp-hit`.
  - **Edges get a hit twin.** A drawn edge is a ~2 px stroke and was effectively unclickable.
    `indexGraph()` inserts a transparent clone right behind each edge path, with
    `stroke-width: 14px` and **`vector-effect: non-scaling-stroke`**, so it stays 14 *screen*
    px at any zoom. Scaled with the diagram, it would shrink to a hairline exactly when the
    reader has zoomed out to see the whole flow.
    - The twin drops `id` / `data-edge` / `data-id` / markers, so no selector or lookup that
      means "the edge" ever matches it.
    - Hovering it thickens the real edge (`.insp-hit:hover + path[data-edge]`).
  - An edge selection lights the edge in the path colour and outlines **both ends**.
  - A subgraph is selectable by its **title only** (`.cluster-label`). Its body is where
    people start a pan.
- **Selection toggles.** A diagram click on the node that is already the selection — `a`, or
  either end `b` of a path, in any mode including a trace — clears it. The same applies to a
  second click on a selected edge. Panel rows and search hits pass no `toggle`: they are
  navigation and must never drop the node they land on. There is deliberately **no dblclick
  handler**, because a double click is two clicks and the second already means "deselect".
- **Highlighting** is CSS classes only. `svg.has-hl` fades everything not `.insp-on` to
  opacity `--dim`. The default is only a **slight** fade (0.72 — lowered twice on request from
  0.14), so the rest of the diagram stays readable as context; the lit set stands out by colour
  and stroke weight, not by contrast.
  - After two hard-coded retunings `--dim` became **the reader's setting**: the toolbar's
    「非強調の透過率」 slider + number field, as *transparency* in % (opacity = 1 − v/100,
    0–95, default 28). `setDim()` writes `--dim` on `:root`, re-clones the minimap and stores
    `inspectorDim` in the shared localStorage (followed via `storage`, like `darkMode`).
    95 is the cap so a faded node never vanishes outright.
  - Clusters derive theirs: `calc(1 - (1 - var(--dim)) * .43)` — the old 0.88 at the default.
  - `isTyping()` gives a focused range input only Arrow / Home / End / Page keys, so U / D /
    M / P / Esc still work after the slider was dragged with the mouse. Edges
  get `insp-in` / `insp-out` / `insp-path`. Ancestor clusters of a lit node stay lit.
  - The `!important`s are needed to beat mermaid's scoped rules and `linkStyle` inline styles.
- **Minimap:** a **deep clone** of the live SVG, re-cloned (rAF-debounced) on every highlight
  change so it mirrors the colours.
  - ⚠ Not `<use>`. mermaid scopes its CSS as `#svgId …`, which a `<use>` shadow tree does not
    match, so everything would draw black.
  - The duplicate ids are deliberate: CSS id selectors match both copies, and marker
    `url(#…)` resolves to the original.
- **Theme and language** follow the preview through the localStorage the three windows share
  (same `app://localhost` origin): `darkMode`, `uiLang`, the `storage` event, plus a `focus`
  re-read. No IPC is involved.
  - A theme change re-renders, because mermaid bakes its theme into the SVG.
- **i18n:** `insp.*` in `inspector.js`, exposed as `window.__inspectorI18n`. `i18ncheck.py`
  audits it as the third table and asserts the namespace stays disjoint.
- **Stylesheet inline in `inspector.html`.** A top-level `assets/*.css` would join the
  preview's M-key style cycle, which skips only `editor.css`.

## Embedded in an HTML export

The `X` → HTML artifact carries the inspector too, **without mermaid** (5.5MB). The one thing
the exported SVG cannot give back is edge endpoints (see *Shape*), so the db is snapshotted
at export time instead of re-parsed at view time.

- **Export side (`buildExportArtifact()`).** Only when the clone has a rendered
  `.mermaid[data-mermaid-source]` and mermaid is loaded. Per figure: `parseMermaidScale()` →
  `mermaid.mermaidAPI.getDiagramFromText(body)` → for a flowchart, `db.getData()` trimmed to
  `{nodes:[{id,domId,label,isGroup}], edges:[{id,start,end,label}]}` and stored as
  `data-mermaid-graph` (percent-encoded JSON) on the clone. A failure leaves the attribute
  off, which only costs that figure its graph features.
- `__embeddedInspectorDoc()` fetches `inspector.html` + `graph.js` + `inspector.js`, inlines the
  two scripts, drops the mermaid `<script>`, and memoizes the string (workspace export calls
  once per page). It refuses a result that still has a `<script src=`: a new external script
  in `inspector.html` must be inlined here too. Any failure returns `''` = no button.
- **Artifact side (`inspectorScript`).** A second inline `<script>` with the page as a JSON
  string (`<` escaped). It adds a hover button (`.copy-button.mdp-insp-btn`) to each figure,
  and opens a full-window overlay with a **`srcdoc` iframe**. All messaging is `postMessage`:
  a `file://` artifact makes frames opaque origins, so a direct `contentWindow` call fails.
  - inspector → parent `{type:'mdp-inspector', msg:'inspector:ready'}` once its listener is up;
    the parent answers `{type:'mdp-inspector-load', payload}` with
    `payload = {kind:'open', src, svg, graph, dark, lang}`.
  - inspector → parent `{type:'mdp-inspector', msg:'inspector:close'}` from `×` or Esc.
  - Nothing is added to the clone, so PDF / `--export-png` are untouched; `@media print`
    also hides the button.
- **Inspector side.** A payload with `svg` skips `render()` and calls
  `mount(payload.svg, payload.graph)` directly, sets `body.embedded` (shows `#btn-close` and
  the Esc help row, hides the Ctrl+W row), takes `lang` as an override of `uiLang`, and
  `isDark()` returns `payload.dark` — the theme is baked into the SVG, so the `storage`
  resync never re-renders. Esc with nothing selected closes (there is no window to Ctrl+W).
- **Colours are the preview's**, `--md-mermaid-*` palette included, since it is the preview's
  SVG. The window version re-renders with stock colours; here the highlight colours sit on
  the style palette instead.
- Net: `exportcheck.py`'s `[mermaid inspector]` block — artifact loaded from **file://**,
  no external `<script src>`, no network request, node mapping (an `_` id and a subgraph),
  a real click highlighting neighbours, Esc twice, the `×` button, the sequence-diagram case,
  print hiding, and no embedding without mermaid.

## `graph.js`

Pure, UMD-shaped, no DOM. `require`d by `inspector-graph.test.cjs`.

- **`pathsBetween(a, b)`** — all directed paths, computed as
  `({a} ∪ desc(a)) ∩ ({b} ∪ anc(b))` plus every edge with both ends in that set.
  - Two BFS passes, never path enumeration, which is exponential on a diamond-heavy diagram.
  - The result is exactly the union of all a→b walks. It includes cycles reachable on the
    way, which is intended.
  - If nothing leads a→b, b→a is tried. `reversed` says which direction answered.
- **`parseQuantity(label)`** — the first number plus the unit-looking token right after it
  (handles `1,200`, `−`, `e3`, CJK units).
  - ⚠ Units are compared as strings and **never converted**. kW and MW are separate balance
    rows on purpose; a unit table is out of scope.
- **`balance()`** counts edges with no number in `unlabeled`, so the panel can say the
  balance is incomplete.

## Rust (`src/inspector_registry.rs`)

- Same shape as `EditorRegistry`, minus everything about files: no pairing, no dirty state,
  no close confirmation.
- `parse_inspector_payload()` re-serializes the JSON. What reaches `eval_js_fn(…,
  "__inspectorLoad", …)` is therefore JSON this side produced, and anything without a string
  `src` is refused.
- ⚠ **The `CloseRequested` arm tests `is_inspector_window` FIRST.** The editor/preview split
  below it treats every other window as the preview and exits the app.
- `push(…, focus)`: an explicit open focuses the window, while live updates must not steal
  focus from the editor being typed in.
- The window's `app` protocol serves assets only (no `/userfile/`).
- Closing the preview exits the process, which takes the inspector with it.

## Tests

- `node tools/preview-harness/inspector-graph.test.cjs` — the algorithms.
- `python tools/preview-harness/inspectorcheck.py` — opens `inspector.html` with an injected
  `__inspectorInit` (no host) and checks:
  - the id mapping
  - click / Shift+click / Ctrl+click against the flow / U / D / Esc
  - drag versus click
  - the cursor-anchored zoom invariant
  - search centring
  - a live update keeping the selection and viewport
  - a syntax error keeping the diagram
  - a sequence diagram turning the graph features off
  - the theme following `storage`
  - edge labels at 13px vs. 16px node text, with the label box fitting its text
  - the fade setting: default 28 % / opacity .72, slider ↔ number field, clamp, `storage`,
    and U still working with the slider focused
  - Ctrl+W → `inspector:close`

  Then, on the preview: `data-mermaid-source`, the menu item and its `openinspector:`
  payload, and live follow (another block's edit posts nothing; the followed block's edit
  posts one update; after `__inspectorTarget(null)` nothing more is posted).
- **The Rust half is invisible to both:** the spawn, the close routing and the title.
  Verify it against the real app.

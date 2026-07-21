# Marp slide-deck authoring

Canonical example: `samples/marp.md` (bundled with this skill; path relative to the skill
directory). A Marp deck is a single `.md` whose **first block** is
a YAML front-matter containing `marp: true`. All normal-pipeline extensions in
`references/features.md` also work inside slides (mermaid, csv/tsv, plotly, abc, KaTeX,
footnotes, inline spans, fenced divs, video/YouTube).

## Front-matter

```markdown
---
marp: true
theme: default
paginate: true
---
```

- `theme:` — built-ins `default` / `gaia` / `uncover`, or any user theme in `assets/marp/*.css`
  (a starter `magenta` is bundled). At runtime the user can switch themes with `S`.
- `paginate: true` shows page numbers.

## Slide separators

Slides are separated by a line of `---` (or `***` / `___`) at the top level. A `---` inside a
fenced code block or the front-matter is ignored.

```markdown
---
marp: true
---

# Slide 1

First slide body.

---

# Slide 2

Second slide body.
```

Keep one idea per slide; favor short bullet lists and a single figure over dense prose.

## Per-slide layout via `_class`

Set a slide's class with an HTML comment at the top of the slide:

```markdown
<!-- _class: title -->
# Deck Title
## Subtitle
```

Common classes: `title`, `section`, `lead`, `invert`, and the column layouts
`split` / `split-2` / `split-3` / `split-4`.

## Columns

**Whole-slide columns** — `_class: split` (2), `split-3`, `split-4`; separate columns with a
`+++` line. A leading `# / ##` becomes a full-width header row across the columns.

```markdown
<!-- _class: split -->
## Two columns

Left content.
+++
Right content.
```

**Partial / inline columns** — switch to columns partway through a slide and back with the
fenced-div form (nesting allowed in Marp, unlike the normal pipeline):

```markdown
## Intro line stays full width

::: columns
### Left
Point A
+++
### Right
Point B
:::

Back to full width.
```

Use `::: columns-3` / `columns-4` to force a count. Keep the order **text → columns** (and
**text → figure**) on a slide; a figure-centering pass pulls everything after the first
figure into a centered stage.

## Figures center automatically

On a non-split slide, a `mermaid` / table / `csv`-table / image-only paragraph / `video` /
YouTube iframe (and anything after it) is auto-wrapped into a vertically-centered stage, with
leading heading + text kept at the top. So the natural layout is: heading, a line of context,
then the diagram/chart/image.

## Per-slide footnotes

Footnote bodies render at the bottom of the slide they're referenced on (compact style),
numbered continuously across the deck. Same `[^id]` … `[^id]: body` syntax as documents.

## Inline styling on slides — `samples/marp.md`

Inline styled spans work on slides (Marp runs with `html: true`):

```markdown
Metric: [前年比 +28%]{color=#e91e63 size=large weight=bold}
Note: [補足はグレー小文字]{color=gray size=small}
```

## Emphasized message slide

```markdown
::: message
たった一つの重要メッセージ
:::
```

Themes can rebrand its accent/background/font via CSS variables.

## View modes (runtime, not authored)

The reader cycles modes with `P`: **scroll** (stacked) → **deck** (one slide; ← → / Space /
Home / End; `F` fullscreen; `Ctrl+Wheel` zoom; `Z` laser pointer) → **list** (thumbnail grid).
You don't encode these — just write slides that read well one-at-a-time in deck mode.

## Authoring checklist

- Front-matter with `marp: true` is the very first block (no blank line before it).
- Each `---` separator sits on its own line with blank lines around it.
- `+++` appears only inside a `split*` slide or a `::: columns` region.
- One topic per slide; short bullets; a single centered figure where helpful.
- Don't override theme colors with raw HTML; use the bundled themes + inline spans.
- After writing, verify the rendered layout with the headless PNG capture and fix any
  overflowing slide — see **SKILL.md → Step 3** (`--export-png` → read `layout.json` for
  `flooredAtMin`/low `scale`, then the flagged PNGs, then split/trim and re-run).

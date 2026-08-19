---
name: md-previewer-author
description: Author a Markdown document or a slide deck for this repo's md_previewer (a feature-rich Windows Markdown previewer). Use when the user wants to write/draft/generate a `.md` document, notes, a report, a technical doc, or slides/a deck/a presentation (プレゼン/スライド/資料) — especially in this md_previewer project. The skill first decides whether to lean on the previewer's rich extensions (Marp slides, fenced-div columns/alignment, inline styled spans, footnotes, mermaid, csv/tsv, plotly, abc music, KaTeX math, image sizing, video/YouTube embeds, vertical-writing) or stay within portable standard Markdown, then writes the file. Do NOT use for editing the previewer's source code or for non-Markdown deliverables (.docx/.pptx/.pdf/.xlsx).
---

# md_previewer authoring

Write a Markdown document or slide deck that renders well in **this repo's md_previewer**.
The previewer supports CommonMark + GFM plus many extensions; this skill helps you decide
how much of that to use, then produces a clean `.md` file.

## Step 1 — Decide the mode, state it, proceed

Before writing, pick **target mode** and **format**, state your choice in one line with a
short rationale, then write. Switch if the user asks.

**Target mode — full features vs standard Markdown:**

- **Standard / portable Markdown** when the output is for GitHub, a PR, a README, another
  Markdown renderer, or the user explicitly asks for plain/portable/普通の Markdown. Stay
  within CommonMark + GFM only: headings, lists, tables, fenced code, links, images,
  blockquotes, task lists. No `:::` divs, no `[x]{...}` spans, no Marp, no custom blocks.
- **Full previewer features** when the user is clearly writing *for this previewer*: they
  mention slides/Marp, ask for diagrams, charts, math, columns, styling, vertical writing,
  reference the previewer/this project, or the content obviously benefits — tabular data →
  `csv`/`tsv` or `plotly`, a process/architecture → `mermaid`, formulas → KaTeX, a
  presentation → Marp.
- When genuinely ambiguous, default to **standard Markdown** (portable, degrades cleanly)
  and mention the richer features are available on request.

**Format — slides vs document (only relevant in full-feature mode):**

- **Marp deck** (`marp: true` front-matter) when the user says slides / deck / presentation
  / プレゼン / スライド / 発表資料, or the content is inherently presentation-shaped (short
  punchy points, one idea per screen). See `references/marp-slides.md`.
- **Flowing document** otherwise. See `references/features.md`.

Example opening line to the user:
> *Writing a Marp slide deck using full previewer features (you asked for slides on this previewer). Say the word if you'd rather have a plain document or portable Markdown.*

## Step 2 — Write the content

- Read the relevant reference for exact syntax:
  - `references/features.md` — all normal-pipeline extensions (fenced divs, inline spans,
    footnotes, ruby/振り仮名, mermaid, csv/tsv, plotly, abc, KaTeX, image sizing, video/YouTube,
    blockquote attribution, soft-break rules, cross-file links, workspace `_toc.md`).
  - `references/marp-slides.md` — Marp deck authoring (front-matter, separators, `_class`
    layouts, columns, per-slide footnotes, themes, view modes).
- Canonical worked examples are **bundled with this skill** under `samples/` (e.g.
  `samples/marp.md`, `samples/alignment.md`, `samples/inline-style.md`, `samples/ruby.md`,
  `samples/plotly.md`,
  `samples/footnotes.md`, `samples/math.md`, plus `samples/workspace/` and the
  `samples/data/` CSVs the plotly example reads). Paths are relative to this skill
  directory, so they resolve even when the skill is used outside the md_previewer repo.
  Read them when unsure how a feature reads in practice; don't blindly copy — produce
  content for the user's actual topic.
- Use a feature because it *fits the content*, not to show it off. A clean standard-Markdown
  doc is better than one stuffed with unused extensions.

## Conventions (always)

- **Match the language of the request and surrounding document.** Write Japanese content
  for a Japanese request (and when the existing doc/workspace is in Japanese); write English
  for an English request. When the request and the existing content disagree, follow the
  request.
- **CJK soft-breaks.** A single newline inside a paragraph is a *soft break*: between CJK
  characters it joins with no space, at a CJK↔Latin boundary it keeps one space, and
  between Latin words it joins with a space (the previewer uses `breaks: false`). Separate
  paragraphs with a blank line; use two trailing spaces or a trailing `\` only when you
  truly want a hard line break.
- **Save to a `.md` file.** Use the filename the user gives; otherwise derive a short
  descriptive name and tell them the path. Skip the file only if the user clearly wants the
  content inline in chat.
- **External assets must exist.** `plotly` blocks reference an external `.csv`/`.tsv` by
  `file:` (path relative to the `.md`); images/videos resolve relative to the `.md` too. If
  you reference data/media that doesn't exist yet, create a small placeholder file or tell
  the user what to drop in alongside the `.md`.
- **Stay within documented features.** Do not invent syntax. If unsure a construct is
  supported, fall back to standard Markdown rather than guessing.
- **Don't fight the previewer.** Avoid raw HTML except where the references say it's needed;
  the previewer's extensions cover most styling needs without it.

## Step 3 — Verify

After writing, re-read the file and confirm it is structurally sound: Marp front-matter (if
any) is the very first block; fenced divs are balanced (`:::` opens and closes); `+++` only
appears inside a `columns`/`split` context; code fences are closed; KaTeX `$`/`$$` are
balanced; referenced images/data/media paths exist relative to the `.md`.

### Marp decks — check the rendered layout and self-correct (do this)

A Marp slide is a fixed 1280×720 box, so **overflow is the main failure mode**: too many
bullets / too much text / an oversized figure makes the body spill past the slide. The
previewer auto-shrinks an overflowing body down to a 0.5 floor, but past that the content is
clipped/scrolled — which looks broken in an exported deck. The previewer has a **headless
PNG-capture mode** built exactly so you can *see* your own slides and fix them without a human
in the loop. **After authoring a Marp deck, run it** (needs a built `assets/` tree — see the
repo's `build.ps1`; use `cargo run --release --` in the repo, or the installed
`md-previewer.exe`):

```powershell
md-previewer.exe <deck.md> --export-png <outdir>
# in the repo without a built exe: cargo run --release -- <deck.md> --export-png <outdir>
```

**Faster, build-free alternative (when working in the md_previewer repo):**

```powershell
python tools/preview-harness/shoot.py <deck.md> --out <outdir> [--slides 3,5-7] [--scale 1]
```

It renders the deck in a **real headless browser** (Playwright + system Edge/Chrome — no
`cargo build`, no `playwright install`) and writes the **same** `slide-NN.png` + `layout.json`.
Prefer it for quick iteration; `--export-png` is the byte-exact actual-WebView2 path.

Either command writes one `slide-NN.png` per slide plus a `layout.json`, then exits. Then:

1. **Read `<outdir>/layout.json` first** (cheap, deterministic). Each slide entry has
   `overflow` (body exceeded the box), `scale` (applied autofit factor; `<1` = it had to
   shrink), and **`flooredAtMin: true`** = even at the 0.5 floor it still overflows — the
   definite "this slide is broken, fix it" signal. Also treat a low `scale` (e.g. `< 0.7`) as
   "cramped, probably worth splitting."
2. **Read the PNGs for the flagged slides** (and spot-check a couple of others) to judge what
   metrics can't: awkward wrapping, an undersized diagram, poor balance, text collisions.
3. **Fix the Markdown** — split a dense slide into two, cut words, shorten bullets, resize a
   figure (`![alt|600](img.png)`), or move detail into speaker content — then re-run
   `--export-png` and repeat until no slide is `flooredAtMin` (and ideally none is badly
   cramped).

Useful flags: `--slides 3,5-7` to re-capture only the slides you just changed; and for image
size, `--png-scale 1` (`--export-png`) / `--scale 1` (`shoot.py`) — default 2× is crisper for
reading fine text.

For a **flowing (non-Marp) document**, both commands write a single `page.png` capturing the
full `#preview` column (the earlier blank-tail on tall docs — an overflow clip, not mermaid —
is fixed). `shoot.py` is the reliable choice for plain docs in the repo; otherwise the
structural re-read above or the GUI below also works.

### Confirm it renders in the GUI (optional, heavier)

Launches a real window (also needs the built `assets/` tree):

```powershell
cargo run --release -- <path-to-file.md>
```

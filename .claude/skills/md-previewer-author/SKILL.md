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
    footnotes, mermaid, csv/tsv, plotly, abc, KaTeX, image sizing, video/YouTube,
    blockquote attribution, soft-break rules, cross-file links, workspace `_toc.md`).
  - `references/marp-slides.md` — Marp deck authoring (front-matter, separators, `_class`
    layouts, columns, per-slide footnotes, themes, view modes).
- Canonical worked examples are **bundled with this skill** under `samples/` (e.g.
  `samples/marp.md`, `samples/alignment.md`, `samples/inline-style.md`, `samples/plotly.md`,
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

To additionally confirm it *renders* in the GUI (heavier — launches a window, needs a built
`assets/` tree per the repo's `build.ps1`):

```powershell
cargo run --release -- <path-to-file.md>
```

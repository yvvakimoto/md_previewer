# Cross-file Markdown Links

Clicking a link to another `.md` file re-opens that file in this previewer.
**Ctrl-click** (Cmd-click) the same link and it opens in a *new previewer
window* instead, leaving this one where it is.

## Try it

- [Go to the companion page](./links-other.md)
- [Back to the main sample](./sample.md)
- [Math sample](./math.md)

Ctrl-click one of those to get a second window, offset down-right of this one
so both stay visible (keep Ctrl-clicking and the windows cascade). The original
window keeps its document and its back/forward history untouched.

External links (https) and non-`.md` `file://` links still follow their
default behaviour — this re-open flow only activates when the target path
ends in `.md` or `.markdown`.

## In-page heading anchors

GitHub-style auto-slugs work for in-page jumps, including non-ASCII headings
and slugs containing consecutive hyphens (which GitHub preserves):

- [Jump to Try it](#try-it)
- [日本語見出しへジャンプ](#サンプル--日本語見出し)

### サンプル — 日本語見出し

このセクションへ上のリンクから飛べます。

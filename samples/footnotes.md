# Footnotes

Standard Markdown footnote syntax is supported. References render as superscript links, and a numbered footnotes section is appended at the bottom of the document. Hover a reference to see the footnote content in a Wikipedia-style tooltip.

## Basic usage

Here is a simple footnote.[^1] And here is a second one[^second] that comes a bit later in the text.

A footnote can also be referenced more than once.[^second] When that happens, the footnote shows multiple back-links.

## Multi-paragraph footnote with code

This sentence has a longer footnote attached.[^bignote]

## Inline formatting inside footnotes

Inline formatting works too[^fmt] — links, code spans, emphasis.

## Non-ASCII identifiers

Footnote IDs may contain non-ASCII characters[^日本語] or punctuation[^note.dot]; the rendered superscript and the popup tooltip both work in the live preview and in exported HTML.

## Math inside footnotes

KaTeX math renders inside footnote bodies, both inline[^einstein] and as a display block[^integral]. Math also coexists with other inline markdown[^mixed].

## Unknown reference

A reference with no matching definition[^missing] renders literally as plain text instead of being silently swallowed.

[^1]: This is the first footnote.

[^日本語]: 日本語の脚注 — non-ASCII identifier round-trips through the popup lookup.

[^note.dot]: Identifier with a `.` character — exercises the sanitizer in the export path.

[^second]: A footnote referenced from two places in the document.

[^bignote]: Here's a footnote with multiple paragraphs and code.

    Indent paragraphs with four spaces to keep them inside the footnote.

    `{ my code }`

    Add as many paragraphs as you like.

[^fmt]: Footnote bodies accept *emphasis*, `code`, and [links](https://example.com/).

[^einstein]: Energy-mass equivalence: $E = mc^2$.

[^integral]: A definite integral on its own line:

    $$\int_0^1 x^2 \, dx = \tfrac{1}{3}$$

    Followed by a closing paragraph after the display block.

[^mixed]: Math like $a^2 + b^2 = c^2$ alongside *emphasis*, `code`, and [a link](https://example.com/) — none of these should interfere with each other.

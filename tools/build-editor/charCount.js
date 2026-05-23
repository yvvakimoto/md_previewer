// Lightweight character-count statistics for the editor.
//
// All counts are JS string length based (UTF-16 code units). For CJK manuscripts
// that's effectively "characters" since most CJK code points fit in one unit.
// Surrogate-paired emoji will count as 2 — acceptable for our use case.

export function charCount(text) {
  const charsAll = text.length;
  const charsNoSpace = text.replace(/\s/g, '').length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const lines = text === '' ? 0 : text.split('\n').length;
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length;

  // Body characters: strip YAML front-matter, fenced code blocks, math.
  let body = text;
  // YAML front-matter at top
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // Fenced code blocks
  body = body.replace(/```[\s\S]*?```/g, '');
  // Inline code
  body = body.replace(/`[^`\n]*`/g, '');
  // Display math
  body = body.replace(/\$\$[\s\S]*?\$\$/g, '');
  // Inline math (avoid swallowing escaped \$)
  body = body.replace(/(^|[^\\])\$[^$\n]*\$/g, '$1');
  const bodyChars = body.replace(/\s/g, '').length;

  return { charsAll, charsNoSpace, bodyChars, words, lines, paragraphs };
}

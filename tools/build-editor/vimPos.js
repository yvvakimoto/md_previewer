// Cursor-position helper shared by the Vim-adapter motion overrides
// (jpWordMotion.js, cells.js installCellMotions).
//
// @replit/codemirror-vim's cursors are instances of its own `Pos` class
// (dist/index.js:7110 — a bare `{line, ch}` holder), which is NOT exported. A
// motion must return something the downstream copyCursor / clipCursorToContent
// path is happy with, so instead of guessing the constructor we borrow the
// prototype of the `head` we were handed and fall back to a plain object.
export function makePos(template, line, ch) {
  const proto = template && Object.getPrototypeOf(template);
  if (proto && proto !== Object.prototype) {
    const p = Object.create(proto);
    p.line = line;
    p.ch = ch;
    return p;
  }
  return { line, ch };
}

// Upstream's findFirstNonWhiteSpaceCharacter (dist/index.js, next to the motion
// table): the column a linewise jump lands on. Mirror implementation — keep in
// sync if upstream ever changes it.
export function firstNonWhitespaceCol(text) {
  if (!text) return 0;
  const i = text.search(/\S/);
  return i === -1 ? text.length : i;
}

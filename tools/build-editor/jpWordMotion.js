// Japanese-aware word motion for the Vim adapter.
//
// Replaces @replit/codemirror-vim's built-in `moveByWords` so w/b/e/W/B/E
// (and operator-pending forms dw/cw/yw/daw/...) stop at boundaries between
// hiragana / katakana / han / ASCII-word / ASCII-punctuation classes.
//
// The algorithm mirrors upstream's findWord / moveToWord (dist/index.js
// 4305-4420 in @replit/codemirror-vim 6.2.x); only the per-character class
// test is replaced.

const CLS_NONE  = 0; // whitespace — never a word
const CLS_WORD  = 1; // ASCII / fullwidth alphanumeric + underscore
const CLS_PUNCT = 2; // other non-whitespace ASCII / fullwidth punctuation / misc
const CLS_HIRA  = 3;
const CLS_KATA  = 4; // includes the chōonpu (U+30FC)
const CLS_HAN   = 5;

function isAsciiWord(c) {
  return (c >= 0x30 && c <= 0x39) ||
         (c >= 0x41 && c <= 0x5A) ||
         (c >= 0x61 && c <= 0x7A) ||
         c === 0x5F ||
         (c >= 0xFF10 && c <= 0xFF19) ||
         (c >= 0xFF21 && c <= 0xFF3A) ||
         (c >= 0xFF41 && c <= 0xFF5A);
}
function isHiragana(c) {
  return (c >= 0x3041 && c <= 0x3096) ||
         (c >= 0x309D && c <= 0x309F);
}
function isKatakana(c) {
  return (c >= 0x30A1 && c <= 0x30FA) ||
         (c >= 0x30FC && c <= 0x30FF) ||
         (c >= 0x31F0 && c <= 0x31FF) ||
         (c >= 0xFF65 && c <= 0xFF9F);
}
function isHan(c) {
  return (c >= 0x3400 && c <= 0x4DBF) ||
         (c >= 0x4E00 && c <= 0x9FFF) ||
         (c >= 0xF900 && c <= 0xFAFF) ||
         c === 0x3005 || c === 0x3006;
}

function classify(ch, bigWord) {
  if (!ch) return CLS_NONE;
  const c = ch.charCodeAt(0);
  // /\s/ equivalent
  if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0B ||
      c === 0x0C || c === 0x0D || c === 0xA0 || c === 0x3000 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
      c === 0xFEFF) {
    return CLS_NONE;
  }
  if (isHan(c))      return CLS_HAN;
  if (isHiragana(c)) return CLS_HIRA;
  if (isKatakana(c)) return CLS_KATA;
  if (bigWord)       return CLS_WORD; // ASCII word + punct collapsed
  if (isAsciiWord(c)) return CLS_WORD;
  return CLS_PUNCT;
}

function isLine(cm, lineNum) {
  return lineNum >= cm.firstLine() && lineNum <= cm.lastLine();
}
function lineLength(cm, lineNum) {
  return cm.getLine(lineNum).length;
}

function makePos(template, line, ch) {
  const proto = template && Object.getPrototypeOf(template);
  if (proto && proto !== Object.prototype) {
    const p = Object.create(proto);
    p.line = line;
    p.ch = ch;
    return p;
  }
  return { line, ch };
}

function findWord(cm, cur, forward, bigWord, emptyLineIsWord) {
  let lineNum = cur.line;
  let pos = cur.ch;
  let line = cm.getLine(lineNum);
  const dir = forward ? 1 : -1;

  if (emptyLineIsWord && line === '') {
    lineNum += dir;
    if (!isLine(cm, lineNum)) return null;
    line = cm.getLine(lineNum);
    pos = forward ? 0 : line.length;
  }

  while (true) {
    if (emptyLineIsWord && line === '') {
      return { from: 0, to: 0, line: lineNum };
    }
    const stop = dir > 0 ? line.length : -1;
    let wordStart = stop, wordEnd = stop;
    while (pos !== stop) {
      const cls = classify(line.charAt(pos), bigWord);
      if (cls !== CLS_NONE) {
        wordStart = pos;
        while (pos !== stop && classify(line.charAt(pos), bigWord) === cls) {
          pos += dir;
        }
        wordEnd = pos;
        if (wordStart !== wordEnd) {
          if (wordStart === cur.ch && lineNum === cur.line && wordEnd === wordStart + dir) {
            continue;
          }
          return {
            from: Math.min(wordStart, wordEnd + 1),
            to:   Math.max(wordStart, wordEnd),
            line: lineNum,
          };
        }
      }
      pos += dir;
    }
    lineNum += dir;
    if (!isLine(cm, lineNum)) return null;
    line = cm.getLine(lineNum);
    pos = dir > 0 ? 0 : line.length;
  }
}

function moveToWord(cm, head, repeat, forward, wordEnd, bigWord) {
  const curStart = { line: head.line, ch: head.ch };
  let cur = curStart;
  const words = [];
  let r = repeat;
  if ((forward && !wordEnd) || (!forward && wordEnd)) r++;
  const emptyLineIsWord = !(forward && wordEnd);
  for (let i = 0; i < r; i++) {
    const word = findWord(cm, cur, forward, bigWord, emptyLineIsWord);
    if (!word) {
      const eodCh = lineLength(cm, cm.lastLine());
      words.push(forward
        ? { line: cm.lastLine(),  from: eodCh, to: eodCh }
        : { line: cm.firstLine(), from: 0,     to: 0 });
      break;
    }
    words.push(word);
    cur = { line: word.line, ch: forward ? (word.to - 1) : word.from };
  }
  const shortCircuit = words.length !== r;
  const firstWord = words[0];
  let lastWord = words.pop();
  if (forward && !wordEnd) {
    if (!shortCircuit && firstWord &&
        (firstWord.from !== curStart.ch || firstWord.line !== curStart.line)) {
      lastWord = words.pop();
    }
    return lastWord && makePos(head, lastWord.line, lastWord.from);
  } else if (forward && wordEnd) {
    return lastWord && makePos(head, lastWord.line, lastWord.to - 1);
  } else if (!forward && wordEnd) {
    if (!shortCircuit && firstWord &&
        (firstWord.to !== curStart.ch || firstWord.line !== curStart.line)) {
      lastWord = words.pop();
    }
    return lastWord && makePos(head, lastWord.line, lastWord.to);
  } else {
    return lastWord && makePos(head, lastWord.line, lastWord.from);
  }
}

export function installJpWordMotion(Vim) {
  if (!Vim || typeof Vim.defineMotion !== 'function') return;
  Vim.defineMotion('moveByWords', function (cm, head, motionArgs) {
    const repeat = motionArgs && motionArgs.repeat ? motionArgs.repeat : 1;
    return moveToWord(
      cm, head, repeat,
      !!(motionArgs && motionArgs.forward),
      !!(motionArgs && motionArgs.wordEnd),
      !!(motionArgs && motionArgs.bigWord),
    );
  });
}

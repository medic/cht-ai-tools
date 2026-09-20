'use strict';
// Brief only: a bullet is at most two lines of at most 120 characters and carries no URL; an item the body layout
// marks as a sub-bullet of its programme takes a single line (FR-015, FR-069).
const { URL_PATTERN } = require('../patterns');

const NAME = 'bullet_length';
const MAX_LINES = 2;
const MAX_LINE_CHARS = 120;

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const reasons = [];
  const oneLine = new Set((ctx.layout && ctx.layout.one_line) || []);
  (ctx.draft.bullets || []).forEach((bullet, i) => {
    const lines = String(bullet.text || '').split('\n');
    if (oneLine.has(bullet.item_id) && lines.length > 1) {
      reasons.push(`bullets[${i}] is a sub-bullet of its programme and must be one line, it has ${lines.length}`);
    } else if (lines.length > MAX_LINES) {
      reasons.push(`bullets[${i}] has ${lines.length} lines, at most ${MAX_LINES} allowed`);
    }
    lines.forEach((line, j) => {
      if (line.length > MAX_LINE_CHARS) {
        reasons.push(`bullets[${i}] line ${j + 1} has ${line.length} characters, at most ${MAX_LINE_CHARS} allowed`);
      }
    });
    if (URL_PATTERN.test(bullet.text || '')) {
      reasons.push(`bullets[${i}] contains a URL; links belong in the footer and thread replies`);
    }
    URL_PATTERN.lastIndex = 0;
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, MAX_LINES, MAX_LINE_CHARS };

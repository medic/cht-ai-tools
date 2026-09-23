'use strict';
// Brief only (FR-015, FR-069, revision 28): the headline and every entry's text are at most two lines of at most 120
// characters and carry no URL; code writes the project in front of each entry's line, so its first line's budget is
// 120 minus that prefix.
const { URL_PATTERN } = require('../patterns');
const { childPrefixes } = require('../../rollup/layout');

const NAME = 'bullet_length';
const MAX_LINES = 2;
const MAX_LINE_CHARS = 120;

const lineReasons = (label, text, prefix = '') => {
  const reasons = [];
  const lines = String(text || '').split('\n');
  if (lines.length > MAX_LINES) {
    reasons.push(`${label} has ${lines.length} lines, at most ${MAX_LINES} allowed`);
  }
  lines.forEach((line, j) => {
    const budget = j === 0 ? MAX_LINE_CHARS - prefix.length : MAX_LINE_CHARS;
    if (line.length > budget) {
      const after = prefix && j === 0 ? ` after the code-written project "${prefix}"` : '';
      reasons.push(`${label} line ${j + 1} has ${line.length} characters, at most ${budget} allowed${after}`);
    }
  });
  return reasons;
};

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const reasons = [];
  // The headline is shown whole in a bold section (FR-019, revision 28), so its length is held here, not by Slack.
  reasons.push(...lineReasons('headline', ctx.draft.headline));
  const prefixes = childPrefixes(ctx.layout);
  (ctx.draft.bullets || []).forEach((bullet, i) => {
    reasons.push(...lineReasons(`bullets[${i}]`, bullet.text, prefixes.get(bullet.item_id) || ''));
    if (URL_PATTERN.test(bullet.text || '')) {
      reasons.push(`bullets[${i}] contains a URL; links belong in the footer and thread replies`);
    }
    URL_PATTERN.lastIndex = 0;
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, MAX_LINES, MAX_LINE_CHARS };

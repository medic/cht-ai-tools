'use strict';
// Brief only: a bullet is at most two lines of at most 120 characters and carries no URL; an item the body layout
// marks as a sub-bullet of its programme takes a single line (FR-015, FR-069). Code writes the project in front of
// each body line (revision 26), so the first line's budget is 120 minus that prefix.
const { URL_PATTERN } = require('../patterns');
const { childPrefixes } = require('../../rollup/layout');

const NAME = 'bullet_length';
const MAX_LINES = 2;
const MAX_LINE_CHARS = 120;

const hostOf = (projectUrl) => {
  try {
    return new URL(projectUrl).host;
  } catch {
    return String(projectUrl || '');
  }
};

/** The prefix code will write in front of each body item's line, by item id, when the layout and items are known. */
const prefixesFor = (ctx) => {
  if (!ctx.layout || !Array.isArray(ctx.items)) {
    return new Map();
  }
  const hosts = new Map(ctx.items.map((item) => [item.item_id, hostOf(item.project_url)]));
  return childPrefixes(ctx.layout, (id) => hosts.get(id) || '');
};

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const reasons = [];
  const oneLine = new Set((ctx.layout && ctx.layout.one_line) || []);
  const prefixes = prefixesFor(ctx);
  (ctx.draft.bullets || []).forEach((bullet, i) => {
    const lines = String(bullet.text || '').split('\n');
    const prefix = prefixes.get(bullet.item_id) || '';
    if (oneLine.has(bullet.item_id) && lines.length > 1) {
      reasons.push(`bullets[${i}] is a sub-bullet of its programme and must be one line, it has ${lines.length}`);
    } else if (lines.length > MAX_LINES) {
      reasons.push(`bullets[${i}] has ${lines.length} lines, at most ${MAX_LINES} allowed`);
    }
    lines.forEach((line, j) => {
      const budget = j === 0 ? MAX_LINE_CHARS - prefix.length : MAX_LINE_CHARS;
      if (line.length > budget) {
        const after = prefix && j === 0 ? ` after the code-written project "${prefix}"` : '';
        reasons.push(`bullets[${i}] line ${j + 1} has ${line.length} characters, at most ${budget} allowed${after}`);
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

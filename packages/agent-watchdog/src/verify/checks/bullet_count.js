'use strict';
// Brief only (FR-010, FR-015, revision 28): at most two programme slots of at most three project lines, and exactly
// one text per entry of the layout, body slots then thread replies. Without a layout, each draft bullet is a top-level
// bullet and at most two are allowed.
const { BODY_SLOTS, MAX_PROJECTS } = require('../../rollup/layout');

const NAME = 'bullet_count';
const MAX_BULLETS = BODY_SLOTS;
// The project lines of a slot or reply the model writes: three; the "more projects" line is code's fourth child.
const MAX_PROJECT_LINES = MAX_PROJECTS;

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const reasons = [];
  const count = (ctx.draft.bullets || []).length;
  if (ctx.layout) {
    const slots = ctx.layout.slots || [];
    if (slots.length > MAX_BULLETS) {
      reasons.push(`${slots.length} slots in the layout, at most ${MAX_BULLETS} allowed`);
    }
    for (const container of [...slots, ...(ctx.layout.replies || [])]) {
      const lines = (container.entries || container.item_ids || []).length;
      if (lines > MAX_PROJECT_LINES) {
        reasons.push(
          `${container.kind} ${container.group} has ${lines} project lines, at most ${MAX_PROJECT_LINES} allowed`,
        );
      }
    }
    const body = (ctx.layout.body_items || []).length;
    const reply = (ctx.layout.reply_items || []).length;
    if (count !== body + reply) {
      reasons.push(`${count} bullets, the layout has ${body + reply} entries (${body} in the body, ${reply} in the `
        + 'thread); write exactly one text per entry');
    }
  } else if (count > MAX_BULLETS) {
    reasons.push(`${count} bullets, at most ${MAX_BULLETS} allowed`);
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, MAX_BULLETS, MAX_PROJECT_LINES };

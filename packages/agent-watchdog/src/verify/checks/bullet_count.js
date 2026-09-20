'use strict';
// Brief only: at most five top-level bullets, at most eight sub-bullets each (FR-010, FR-015). With a body layout
// (User Story 9) the draft carries one bullet per body item, so the limits are checked on the layout's slots and the
// draft must match its body item count; without one, each draft bullet is a top-level bullet.
const NAME = 'bullet_count';
const MAX_BULLETS = 5;
const MAX_CHILDREN = 8;

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
    for (const slot of slots) {
      const children = (slot.item_ids || []).length;
      if (children > MAX_CHILDREN) {
        reasons.push(`slot ${slot.slot} (${slot.group}) has ${children} sub-bullets, at most ${MAX_CHILDREN} allowed`);
      }
    }
    const body = (ctx.layout.body_items || []).length;
    if (count !== body) {
      reasons.push(`${count} bullets, the layout has ${body} body items; write exactly one bullet per body item`);
    }
  } else if (count > MAX_BULLETS) {
    reasons.push(`${count} bullets, at most ${MAX_BULLETS} allowed`);
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, MAX_BULLETS, MAX_CHILDREN };

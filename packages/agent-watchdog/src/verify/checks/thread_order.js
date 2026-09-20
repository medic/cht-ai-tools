'use strict';
// Brief only: thread_order lists every accepted item once, bullets first in order; with a body layout (User Story 9)
// the bullets must be exactly the layout's body items.
const NAME = 'thread_order';

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const reasons = [];
  const order = ctx.draft.thread_order || [];
  const ids = (ctx.items || []).map((item) => item.item_id);
  if (new Set(order).size !== order.length) {
    reasons.push('thread_order repeats an item id');
  }
  const missing = ids.filter((id) => !order.includes(id));
  const extra = order.filter((id) => !ids.includes(id));
  if (missing.length) {
    reasons.push(`thread_order omits accepted items ${missing.join(', ')}`);
  }
  if (extra.length) {
    reasons.push(`thread_order lists unknown items ${extra.join(', ')}`);
  }
  const bulletIds = (ctx.draft.bullets || []).map((b) => b.item_id);
  if (bulletIds.some((id, i) => order[i] !== id)) {
    reasons.push('the first entries of thread_order must equal the bullets in order');
  }
  if (ctx.layout) {
    const body = ctx.layout.body_items || [];
    const missingBody = body.filter((id) => !bulletIds.includes(id));
    const extraBody = bulletIds.filter((id) => !body.includes(id));
    if (missingBody.length || extraBody.length) {
      reasons.push('bullets do not match the body layout: '
        + `missing ${missingBody.join(', ') || 'none'}; unexpected ${extraBody.join(', ') || 'none'}`);
    }
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

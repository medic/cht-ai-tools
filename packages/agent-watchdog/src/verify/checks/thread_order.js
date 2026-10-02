'use strict';
// Brief only: thread_order lists every accepted item once, the bullets' lead items first in order; with a layout
// (User Story 9, revision 28) the bullets must be exactly the layout's entries, body slots then thread replies.
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
    const expected = [...(ctx.layout.body_items || []), ...(ctx.layout.reply_items || [])];
    const missingLeads = expected.filter((id) => !bulletIds.includes(id));
    const extraLeads = bulletIds.filter((id) => !expected.includes(id));
    if (missingLeads.length || extraLeads.length) {
      reasons.push('bullets do not match the layout\'s entries: '
        + `missing ${missingLeads.join(', ') || 'none'}; unexpected ${extraLeads.join(', ') || 'none'}`);
    } else if (expected.some((id, i) => bulletIds[i] !== id)) {
      reasons.push('bullets must follow the layout\'s order: body slots first, then the thread replies');
    }
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

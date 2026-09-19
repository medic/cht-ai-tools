'use strict';
const NAME = 'pattern_cards_known';

const check = (ctx) => {
  const reasons = [];
  const known = new Set(ctx.knownCards || []);
  (ctx.items || []).forEach((item, i) => {
    if (item.pattern_card !== null && item.pattern_card !== undefined && !known.has(item.pattern_card)) {
      reasons.push(`items[${i}] names pattern card ${item.pattern_card}, which is not in the merged index`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

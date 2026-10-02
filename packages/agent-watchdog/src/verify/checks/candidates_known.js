'use strict';
const NAME = 'candidates_known';

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode !== 'brief') {
    const known = new Set((ctx.candidates || []).map((c) => c.candidate_id));
    (ctx.items || []).forEach((item, i) => {
      if (!item.candidate_ids || item.candidate_ids.length === 0) {
        reasons.push(`items[${i}] references no candidate`);
        return;
      }
      for (const id of item.candidate_ids) {
        if (!known.has(id)) {
          reasons.push(`items[${i}] references unknown candidate ${id}`);
        }
      }
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

'use strict';
const NAME = 'bullet_count';
const MAX_BULLETS = 3;

const check = (ctx) => {
  if (ctx.mode !== 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to findings'] };
  }
  const count = (ctx.draft.bullets || []).length;
  const reasons = count > MAX_BULLETS ? [`${count} bullets, at most ${MAX_BULLETS} allowed`] : [];
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, MAX_BULLETS };

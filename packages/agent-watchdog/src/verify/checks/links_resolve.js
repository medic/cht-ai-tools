'use strict';
const NAME = 'links_resolve';

const check = (ctx) => {
  if (!ctx.linkResults) {
    return { name: NAME, status: 'pass', reasons: ['not resolved (offline)'] };
  }
  const reasons = [];
  for (const [url, result] of ctx.linkResults) {
    if (!result || !result.ok) {
      reasons.push(`${url}: ${(result && result.reason) || 'did not resolve'}`);
    }
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

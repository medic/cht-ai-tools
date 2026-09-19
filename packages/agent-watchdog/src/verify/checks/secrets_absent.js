'use strict';
const { SECRET_PATTERNS } = require('../patterns');
const { walkStrings } = require('../walk');

const NAME = 'secrets_absent';

const check = (ctx) => {
  const reasons = [];
  const document = ctx.mode === 'brief' ? ctx.draft : ctx.findings;
  walkStrings(document, (text, path) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        reasons.push(`secret pattern ${name} at ${path}`);
      }
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

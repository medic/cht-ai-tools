'use strict';
const { findingsSchema, briefSchema } = require('../../agent/output-schema');
const { schemas } = require('../../model/schemas');

const NAME = 'schema';

const issues = (error, prefix = '') => error.issues
  .map((i) => `${prefix}${i.path.join('.') || '(root)'}: ${i.message}`);

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode === 'brief') {
    const parsed = briefSchema.safeParse(ctx.draft);
    if (!parsed.success) {
      reasons.push(...issues(parsed.error, 'draft.'));
    }
  } else {
    const parsed = findingsSchema.safeParse(ctx.findings);
    if (!parsed.success) {
      reasons.push(...issues(parsed.error, 'findings.'));
    }
    (ctx.items || []).forEach((item, index) => {
      const result = schemas.Item.safeParse(item);
      if (!result.success) {
        reasons.push(...issues(result.error, `items[${index}].`));
      }
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

'use strict';
const { EMAIL_PATTERN, PHONE_PATTERN, PHONE_MIN_DIGITS, countDigits } = require('../patterns');
const { walkStrings } = require('../walk');

const NAME = 'personal_data_absent';

// Identifier fields hold hashes and ids the code derived; an all-digit hex id is not a phone number.
const ID_FIELD = /\.(candidate_ids?|item_id|thread_order|dashboard_uid|session_id|pattern_card)(\[\d+\])?$/;
const HEX_ID = /^[0-9a-f]{12,64}$/;

const check = (ctx) => {
  const reasons = [];
  const exempt = new Set((ctx.discovery && ctx.discovery.projects || []).map((p) => p.host));
  const document = ctx.mode === 'brief' ? ctx.draft : ctx.findings;
  walkStrings(document, (text, path) => {
    if (exempt.has(text) || ID_FIELD.test(path) || HEX_ID.test(text)) {
      return;
    }
    if (EMAIL_PATTERN.test(text)) {
      reasons.push(`e-mail address at ${path}`);
    }
    for (const match of text.matchAll(PHONE_PATTERN)) {
      if (countDigits(match[0]) >= PHONE_MIN_DIGITS) {
        reasons.push(`phone number at ${path}`);
        break;
      }
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

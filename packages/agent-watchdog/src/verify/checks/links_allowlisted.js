'use strict';
const { isAllowed } = require('../../links/allowlist');
const { URL_PATTERN } = require('../patterns');

const NAME = 'links_allowlisted';

const seen = (set, url) => (set instanceof Set ? set.has(url) : Array.isArray(set) && set.includes(url));

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode === 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to a brief'] };
  }
  (ctx.items || []).forEach((item, i) => {
    for (const url of item.reference_urls || []) {
      if (!seen(ctx.toolResultUrls, url)) {
        reasons.push(`items[${i}] cites ${url}, which did not appear in a tool result this run`);
      }
      if (!isAllowed(url, ctx.allowlist || [])) {
        reasons.push(`items[${i}] cites ${url}, whose host is not on the allow-list`);
      }
    }
    for (const [field, text] of [['why_now', item.why_now], ['suggested_check', item.suggested_check]]) {
      if (URL_PATTERN.test(text || '')) {
        reasons.push(`items[${i}].${field} contains a URL; links are built by code, not written by the model`);
      }
      URL_PATTERN.lastIndex = 0;
    }
  });
  if (URL_PATTERN.test((ctx.findings && ctx.findings.notes) || '')) {
    reasons.push('notes contain a URL; links are built by code, not written by the model');
  }
  URL_PATTERN.lastIndex = 0;
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

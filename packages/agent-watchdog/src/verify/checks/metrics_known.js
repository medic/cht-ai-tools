'use strict';
const { baseMetricName, stripInstanceMatcher, keyForms } = require('../metric-key');

const NAME = 'metrics_known';

const knownForms = (ctx) => {
  const forms = new Set();
  for (const key of ctx.discovery.metrics || []) {
    for (const form of keyForms(key)) {
      forms.add(form);
    }
  }
  return forms;
};

const isKnown = (metric, forms) => forms.has(metric)
  || forms.has(stripInstanceMatcher(metric))
  || (baseMetricName(metric) !== null && forms.has(baseMetricName(metric)));

/**
 * One item per identity (revision 34): two items on one metric and card would share an item id, collapse in the
 * pass diff and count twice in the layout, so the second is refused and the model told to merge them.
 */
const duplicateReasons = (items) => {
  const seen = new Map();
  const reasons = [];
  items.forEach((item, i) => {
    const card = item.pattern_card === undefined || item.pattern_card === null ? 'none' : item.pattern_card;
    const key = `${item.metric}\n${card}`;
    if (seen.has(key)) {
      reasons.push(`items[${i}] repeats the identity of items[${seen.get(key)}] (metric ${item.metric}, card ${card}); `
        + 'merge them into one item citing both candidate ids');
    } else {
      seen.set(key, i);
    }
  });
  return reasons;
};

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode !== 'brief') {
    const forms = knownForms(ctx);
    (ctx.items || []).forEach((item, i) => {
      if (!isKnown(item.metric, forms)) {
        reasons.push(`items[${i}] metric ${item.metric} was not collected this run`);
      }
    });
    reasons.push(...duplicateReasons(ctx.items || []));
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, baseMetricName };

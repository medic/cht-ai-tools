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

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode !== 'brief') {
    const forms = knownForms(ctx);
    (ctx.items || []).forEach((item, i) => {
      if (!isKnown(item.metric, forms)) {
        reasons.push(`items[${i}] metric ${item.metric} was not collected this run`);
      }
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, baseMetricName };

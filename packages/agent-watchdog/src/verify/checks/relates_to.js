'use strict';
// FR-009 (revision 20): an item may say it relates to another item of the same findings, naming that item by its
// metric because code derives item identities and the analysis cannot know them. This check is the guard: the
// metric must belong to another item of the same findings, and the relation must be one of the four the schema
// allows. A relation to the item's own metric explains nothing and is dropped by the gate's normalisation instead of
// costing a retry (revision 24).
const { sameMetric } = require('../metric-key');

const NAME = 'relates_to';

/** `level_of` and `rate_of` are the two views of one quantity; the other two are causal claims. */
const RELATIONS = Object.freeze(['level_of', 'rate_of', 'same_cause', 'consequence_of']);

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode === 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to a brief'] };
  }
  const findings = (ctx.findings && ctx.findings.items) || [];
  const metrics = findings.map((item) => (item.item_key || {}).metric);
  findings.forEach((item, i) => {
    const relation = item.relates_to;
    if (!relation) {
      return;
    }
    const own = (item.item_key || {}).metric;
    const other = metrics.some((metric, j) => j !== i && sameMetric(metric, relation.metric));
    if (!sameMetric(own, relation.metric) && !other) {
      reasons.push(`items[${i}].relates_to names ${relation.metric}, which is not another item of these findings`);
    }
    if (!RELATIONS.includes(relation.relation)) {
      reasons.push(`items[${i}].relates_to relation ${relation.relation} is not one of ${RELATIONS.join(', ')}`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, RELATIONS };

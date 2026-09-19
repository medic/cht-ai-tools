'use strict';
// `high` is reserved for the FR-014 rules; the gate never downgrades, it rejects with a reason.
const NAME = 'severity_rules';
const RANK = { low: 0, medium: 1, high: 2 };

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode !== 'brief') {
    const byId = new Map((ctx.candidates || []).map((c) => [c.candidate_id, c]));
    (ctx.items || []).forEach((item, i) => {
      const floors = (item.candidate_ids || []).map((id) => byId.get(id)).filter(Boolean).map((c) => c.severity_floor);
      const hasHigh = floors.includes('high');
      if (item.severity === 'high' && !hasHigh) {
        reasons.push(`items[${i}] is high without a candidate that qualifies for high severity (FR-014)`);
      }
      const maxFloor = floors.reduce((acc, f) => (RANK[f] > RANK[acc] ? f : acc), 'low');
      if (RANK[item.severity] < RANK[maxFloor]) {
        reasons.push(`items[${i}] is ${item.severity} but a referenced candidate sets a floor of ${maxFloor}`);
      }
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

'use strict';
const { sameMetric } = require('../metric-key');

const NAME = 'dates_match';

const ms = (t) => Date.parse(t);

const within = (start, end, span) => ms(start) >= ms(span.start) && ms(end) <= ms(span.end) && ms(start) < ms(end);

const check = (ctx) => {
  const reasons = [];
  if (ctx.mode === 'brief') {
    return { name: NAME, status: 'pass', reasons: ['not applicable to a brief'] };
  }
  (ctx.items || []).forEach((item, i) => {
    const windows = (ctx.windows || [])
      .filter((w) => w.project_url === item.project_url && sameMetric(w.metric, item.metric));
    if (windows.length === 0) {
      reasons.push(`items[${i}] metric ${item.metric} has no collected windows`);
      return;
    }
    const span = {
      start: new Date(Math.min(...windows.map((w) => ms(w.start)))).toISOString(),
      end: new Date(Math.max(...windows.map((w) => ms(w.end)))).toISOString(),
    };
    (item.evidence || []).forEach((evidence, j) => {
      if (!evidence.start && !evidence.end) {
        return;
      }
      const named = windows.find((w) => w.window === evidence.window);
      const bounds = named || span;
      if (!evidence.start || !evidence.end || !within(evidence.start, evidence.end, bounds)) {
        const range = `${evidence.start} to ${evidence.end}`;
        reasons.push(`items[${i}].evidence[${j}] window ${range} is outside the run's windows`);
      }
    });
    const ref = item.dashboard_ref || {};
    if (!ref.from || !ref.to || !within(ref.from, ref.to, span)) {
      reasons.push(`items[${i}].dashboard_ref ${ref.from} to ${ref.to} is outside the run's windows`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

'use strict';
const { TIMESTAMP_PATTERN } = require('../patterns');
const { flatPanels } = require('../metric-key');

const NAME = 'links_built';

const check = (ctx) => {
  const reasons = [];
  const dashboards = new Map((ctx.discovery.dashboards || []).map((d) => [d.uid, d]));
  (ctx.items || []).forEach((item, i) => {
    const ref = item.dashboard_ref || {};
    const dashboard = dashboards.get(ref.dashboard_uid);
    if (!dashboard) {
      reasons.push(`items[${i}] dashboard ${ref.dashboard_uid} is not in the priority list`);
    } else if (!flatPanels(dashboard).some((p) => (p.panel_id === undefined ? p.id : p.panel_id) === ref.panel_id)) {
      reasons.push(`items[${i}] panel ${ref.panel_id} does not exist on dashboard ${ref.dashboard_uid}`);
    }
    if (!TIMESTAMP_PATTERN.test(ref.from || '') || !TIMESTAMP_PATTERN.test(ref.to || '')) {
      reasons.push(`items[${i}] dashboard_ref from/to must be ISO-8601 UTC timestamps`);
    } else if (Date.parse(ref.from) >= Date.parse(ref.to)) {
      reasons.push(`items[${i}] dashboard_ref from must be before to`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

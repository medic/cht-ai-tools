'use strict';
// Dashboard deep links are built by code from structured references (FR-009, FR-016; research.md R-5).
const { hostOf } = require('./allowlist');

const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * `/d/<uid>/<slug>?orgId=1&from=<ms>&to=<ms>&timezone=utc&var-cht_instance=<host>` plus `&viewPanel=panel-<id>`
 * only when the panel id is unique on the dashboard.
 */
const buildDashboardLink = ({ grafanaUrl, dashboard, panelId = null, host, from, to }) => {
  const base = String(grafanaUrl).replace(/\/+$/, '');
  const slug = dashboard.slug || 'dashboard';
  const params = new URLSearchParams({
    orgId: '1',
    from: String(toMs(from)),
    to: String(toMs(to)),
    timezone: 'utc',
    'var-cht_instance': host,
  });
  const duplicates = dashboard.duplicate_panel_ids || [];
  let url = `${base}/d/${dashboard.uid}/${slug}?${params.toString()}`;
  if (panelId !== null && panelId !== undefined && !duplicates.includes(panelId)) {
    url += `&viewPanel=panel-${panelId}`;
  }
  return url;
};

/** One link per item, or null when the dashboard is unknown. */
const buildItemLinks = (items, discovery, grafanaUrl) => {
  const dashboards = new Map((discovery.dashboards || []).map((d) => [d.uid, d]));
  const hosts = new Map((discovery.projects || []).map((p) => [p.url, p.host]));
  const links = new Map();
  for (const item of items || []) {
    const ref = item.dashboard_ref || {};
    const dashboard = dashboards.get(ref.dashboard_uid);
    const host = hosts.get(item.project_url) || hostOf(item.project_url);
    if (!dashboard || !host) {
      links.set(item.item_id, null);
      continue;
    }
    const link = buildDashboardLink({ grafanaUrl, dashboard, panelId: ref.panel_id, host, from: ref.from, to: ref.to });
    links.set(item.item_id, link);
  }
  return links;
};

module.exports = { buildDashboardLink, buildItemLinks };

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

const ALERT_LIST_PATH = '/alerting/list';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Search terms for the alert rule list (research.md R-14): the CHT folder, firing rules, an optional rule title and
 * an instance matcher over the group's hosts.
 */
const alertTerms = ({ hosts = [], title = null }) => {
  const terms = ['namespace:CHT', 'state:firing'];
  if (title) {
    terms.push(`rule:"${title}"`);
  }
  if (hosts.length) {
    terms.push(`label:instance=~"^(${hosts.map(escapeRegExp).join('|')})$"`);
  }
  return terms;
};

/** `<grafana>/alerting/list?search=<terms>`; the gate resolves it against the collected rules and instances. */
const buildAlertListLink = ({ grafanaUrl, terms }) => {
  const base = String(grafanaUrl).replace(/\/+$/, '');
  return `${base}${ALERT_LIST_PATH}?search=${encodeURIComponent(terms.join(' '))}`;
};

/**
 * One link for the whole Alert Group and one per rule title in it (FR-066, FR-070), plus `short` links without the
 * host filter for a reply the filtered ones would not fit in (revision 17).
 */
const buildAlertGroupLinks = ({ grafanaUrl, group }) => {
  const hosts = group.hosts || [];
  const groupLink = buildAlertListLink({ grafanaUrl, terms: alertTerms({ hosts }) });
  const titles = group.titles || [];
  const rules = titles.map((title) => ({
    title, url: buildAlertListLink({ grafanaUrl, terms: alertTerms({ hosts, title }) }),
  }));
  const short = {
    group: buildAlertListLink({ grafanaUrl, terms: alertTerms({}) }),
    rules: titles.map((title) => ({ title, url: buildAlertListLink({ grafanaUrl, terms: alertTerms({ title }) }) })),
  };
  return {
    group: groupLink,
    rules,
    short,
    all: [groupLink, ...rules.map((r) => r.url), short.group, ...short.rules.map((r) => r.url)],
  };
};

/**
 * The links of the alerts reply (FR-066, revision 28): per programme the alert list filtered to the hosts of its
 * groups, and one list of every firing alert.
 */
const buildAlertsLinks = ({ grafanaUrl, alertGroups = [] }) => {
  const hostsByGroup = new Map();
  for (const group of alertGroups) {
    const label = group.group || 'Other';
    const hosts = hostsByGroup.get(label) || new Set();
    for (const host of group.hosts || []) {
      hosts.add(host);
    }
    hostsByGroup.set(label, hosts);
  }
  const byGroup = new Map([...hostsByGroup.entries()].map(([label, hosts]) => [
    label, buildAlertListLink({ grafanaUrl, terms: alertTerms({ hosts: [...hosts].sort() }) }),
  ]));
  return { byGroup, all: buildAlertListLink({ grafanaUrl, terms: alertTerms({}) }) };
};

module.exports = {
  buildDashboardLink, buildItemLinks, alertTerms, buildAlertListLink, buildAlertGroupLinks, buildAlertsLinks,
  ALERT_LIST_PATH,
};

'use strict';
// The dashboard reference of an Item, built by code (FR-009, revision 18). Collection records, for every metric of
// every project, the panel it came from and the exact bounds of each window; the model is never asked to restate
// them. It says which window matters by citing it in the item's leading evidence, and code turns that into the
// reference src/links/build.js makes a URL from.
const { sameMetric, stripInstanceMatcher, flatPanels } = require('../verify/metric-key');

const DEFAULT_WINDOW = 'current';

const ms = (t) => Date.parse(t);

// `sameMetric` also matches on the base metric name, so a whole family (`cht_couchdb_doc_total{db=...}` and the
// growth rate built from it) answers to one key. The item's own key decides which panel it came from; the family
// is only a fallback for a metric the run did not collect under that exact key.
const sameKey = (a, b) => a === b || stripInstanceMatcher(a) === stripInstanceMatcher(b);

/**
 * The panel to link, checked against the priority dashboards. Some metrics are collected under a panel no
 * dashboard holds: scrape-target health carries a pseudo reference. Linking an unrelated panel to satisfy the
 * gate would mislead the reader, so the first priority dashboard is linked with no panel instead, which
 * src/links/build.js renders as a dashboard-level link scoped to the project and window (revision 18).
 */
const realPanel = (recorded, discovery) => {
  const dashboards = (discovery && discovery.dashboards) || null;
  if (!dashboards) {
    return recorded;
  }
  const dashboard = dashboards.find((d) => d.uid === recorded.dashboard_uid);
  const idOf = (p) => (p.panel_id === undefined ? p.id : p.panel_id);
  if (dashboard && flatPanels(dashboard).some((p) => idOf(p) === recorded.panel_id)) {
    return recorded;
  }
  return dashboards.length ? { dashboard_uid: dashboards[0].uid, panel_id: null } : null;
};

/**
 * @param {object} options
 * @param {object[]} options.windows the run's collected windows (`<project>/inputs/windows.json.gz`)
 * @param {object} [options.discovery] the run's discovery, to check the panel against the priority dashboards
 * @param {string} options.projectUrl
 * @param {string} options.metric the item's metric key
 * @param {object[]} [options.evidence] the item's evidence, oldest cited window first
 * @returns {{ dashboard_uid: string, panel_id: number|null, project_url: string, from: string, to: string }|null}
 *   null when the metric has no collected window, no window records the panel it came from, or the panel is not
 *   a real one and there is no priority dashboard to fall back to
 */
const dashboardRefFor = ({ windows = [], discovery = null, projectUrl, metric, evidence = [] }) => {
  const ours = (windows || []).filter((w) => w.project_url === projectUrl);
  const mine = ours.filter((w) => sameKey(w.metric, metric)).length
    ? ours.filter((w) => sameKey(w.metric, metric))
    : ours.filter((w) => sameMetric(w.metric, metric));
  if (!mine.length) {
    return null;
  }
  const recorded = (mine.find((w) => w.panel_ref) || {}).panel_ref;
  if (!recorded) {
    return null;
  }
  const panel = realPanel(recorded, discovery);
  if (!panel) {
    return null;
  }
  // The window the model pointed at, else the current one, else everything the run collected for this metric.
  const wanted = ((evidence || [])[0] || {}).window || DEFAULT_WINDOW;
  const named = mine.find((w) => w.window === wanted) || mine.find((w) => w.window === DEFAULT_WINDOW);
  const from = named ? named.start : new Date(Math.min(...mine.map((w) => ms(w.start)))).toISOString();
  const to = named ? named.end : new Date(Math.max(...mine.map((w) => ms(w.end)))).toISOString();
  return {
    dashboard_uid: panel.dashboard_uid,
    panel_id: panel.panel_id,
    project_url: projectUrl,
    from,
    to,
  };
};

module.exports = { dashboardRefFor, DEFAULT_WINDOW };

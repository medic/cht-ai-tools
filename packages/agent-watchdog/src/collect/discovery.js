'use strict';
// Discover projects, dashboards and metrics from the hosted watchdog on every run (FR-001, FR-003, FR-005).
const { normaliseHost } = require('../config/policy');
const { projectSlug, projectUrlFor } = require('../model/identity');
const { schemas } = require('../model/schemas');
const { scrapeTargetsFor, targetsSummary } = require('./targets');
const { withInstance, trailingQuery, windowBounds } = require('./windows');

const noop = { debug() {}, info() {}, warn() {}, error() {} };

/** The metric key: the panel expression without its instance matcher (data-model.md, Metric Window). */
const metricKey = (expr) => String(expr)
  .replace(/,\s*instance\s*=~?\s*"[^"]*"/g, '')
  .replace(/instance\s*=~?\s*"[^"]*"\s*,\s*/g, '')
  .replace(/instance\s*=~?\s*"[^"]*"/g, '')
  .replace(/\{\s*\}/g, '')
  .trim();

const hasTargets = (panel) => Array.isArray(panel.targets) && panel.targets.some((t) => t && t.expr);

/** Every panel with a query, including panels nested inside `row` panels. */
const flattenPanels = (dashboard) => {
  const out = [];
  const visit = (panels) => {
    for (const panel of panels || []) {
      if (hasTargets(panel)) {
        out.push(panel);
      }
      if (Array.isArray(panel.panels)) {
        visit(panel.panels);
      }
    }
  };
  visit(dashboard && dashboard.panels);
  return out;
};

const unitOf = (panel) => {
  const unit = panel.fieldConfig && panel.fieldConfig.defaults && panel.fieldConfig.defaults.unit;
  return !unit || unit === 'short' || unit === 'none' ? 'count' : unit;
};

/** One record per panel target, restricted to the priority list's panel ids when the list is non-empty. */
const panelRecords = (doc, allowedIds = []) => flattenPanels(doc.dashboard)
  .filter((panel) => !allowedIds.length || allowedIds.includes(panel.id))
  .flatMap((panel) => panel.targets.filter((t) => t && t.expr).map((target) => ({
    panel_id: panel.id,
    title: panel.title || '',
    ref_id: target.refId || 'A',
    expr: target.expr,
    unit: unitOf(panel),
    metric: metricKey(target.expr),
    per_project: target.expr.includes('$cht_instance'),
  })));

const duplicatePanelIds = (doc, allowedIds = []) => {
  const counts = new Map();
  for (const panel of flattenPanels(doc.dashboard)) {
    if (!allowedIds.length || allowedIds.includes(panel.id)) {
      counts.set(panel.id, (counts.get(panel.id) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort((a, b) => a - b);
};

const hostsFromVector = (vector) => [...new Set(vector
  .map((series) => series.metric && series.metric.instance)
  .filter(Boolean)
  .map(normaliseHost))].sort();

const hostsFromTargets = (targets) => [...new Set(targets
  .filter((t) => t.labels && t.labels.job === 'cht' && t.labels.instance)
  .map((t) => normaliseHost(t.labels.instance)))].sort();

/**
 * @param {object} options
 * @param {object} options.grafana client from createGrafanaClient
 * @param {object} options.policy loaded policy
 * @param {object} options.config configuration (unused fields tolerated)
 * @param {Date} options.runStart
 * @param {object} [options.logger]
 * @param {object[]} [options.docs] prefetched dashboard documents aligned with the priority list
 */
const discover = async ({ grafana, policy, runStart, logger = noop, docs = null }) => {
  const priority = policy.dashboards.dashboards;
  const dashboards = [];
  for (let i = 0; i < priority.length; i += 1) {
    const entry = priority[i];
    const doc = docs && docs[i] ? docs[i] : await grafana.dashboard(entry.uid);
    const panels = panelRecords(doc, entry.panels || []);
    dashboards.push({
      uid: entry.uid,
      title: doc.dashboard.title,
      slug: doc.meta.slug,
      url: doc.meta.url,
      panels,
      duplicate_panel_ids: duplicatePanelIds(doc, entry.panels || []),
    });
    logger.debug('discovery.dashboard', { uid: entry.uid, panels: panels.length });
  }

  const scrapeTargetMetric = policy.thresholds.metric_roles.scrape_target;
  const time = Math.floor(runStart.getTime() / 1000);
  const activeTargets = await grafana.targets();
  const upVector = await grafana.queryInstant({ query: scrapeTargetMetric, time });
  let hosts = hostsFromVector(upVector);
  if (!hosts.length) {
    hosts = hostsFromTargets(activeTargets);
  }

  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];
  const trailing = windowBounds(runStart).find((b) => b.window === 'trailing_14d');
  const projects = [];
  for (const host of hosts) {
    const annotation = policy.projects.projects[host] || null;
    const versionVector = await grafana.queryInstant({ query: withInstance('cht_version', host), time });
    const versionLabels = versionVector.length ? versionVector[0].metric : {};
    const daily = await grafana.queryRange({
      query: trailingQuery(withInstance(scrapeTargetMetric, host)),
      start: Math.floor(trailing.start.getTime() / 1000),
      end: Math.floor(trailing.end.getTime() / 1000),
      step: trailing.step_s,
    });
    const historyDays = daily.length ? daily[0].values.length : 0;
    const projectWindows = ((annotation && annotation.expected_load_windows) || []).map((w) => ({ ...w, scope: host }));
    const project = schemas.Project.parse({
      host,
      url: projectUrlFor(host),
      slug: projectSlug(host),
      configured: Boolean(annotation),
      owner: annotation && annotation.owner ? annotation.owner : null,
      notes: annotation && annotation.notes ? annotation.notes : null,
      thresholds: annotation && annotation.thresholds ? { ...annotation.thresholds } : null,
      expected_load_windows: [...projectWindows, ...defaults.map((w) => ({ ...w, scope: 'all' }))],
      cht_version: versionLabels.app || null,
      history_days: historyDays,
      scrape_targets: scrapeTargetsFor(activeTargets, host),
    });
    projects.push(project);
    logger.info('discovery.project', {
      project: host, configured: project.configured, cht_version: project.cht_version, history_days: historyDays,
    });
  }

  const perProject = dashboards.flatMap((d) => d.panels.filter((p) => p.per_project).map((p) => p.metric));
  const metrics = [...new Set([...perProject, scrapeTargetMetric])].sort();

  return {
    run_start: runStart.toISOString(),
    datasource_uid: grafana.datasourceUid,
    projects,
    dashboards,
    metrics,
    targets_summary: targetsSummary(activeTargets),
    scrape_target_metric: scrapeTargetMetric,
  };
};

module.exports = { discover, metricKey, flattenPanels, panelRecords, duplicatePanelIds, unitOf };

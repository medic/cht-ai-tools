'use strict';
// Discover projects, dashboards and metrics from the hosted watchdog on every run (FR-001, FR-003, FR-005).
const { normaliseHost, matchesGlob } = require('../config/policy');
const { projectSlug, projectUrlFor } = require('../model/identity');
const { schemas } = require('../model/schemas');
const { scrapeTargetsFor, targetsSummary } = require('./targets');
const { withInstance, trailingQuery, windowBounds } = require('./windows');
const { dashboardVariables, variablesIn, isBuiltin } = require('./variables');

const noop = { debug() {}, info() {}, warn() {}, error() {} };
const UNGROUPED = 'Other';

/** The ignore pattern a host matches, or null (FR-068). */
const ignoredBy = (host, patterns = []) => patterns.find((pattern) => matchesGlob(host, pattern)) || null;

/** The first Project Group whose pattern matches the host, in file order; "Other" when none does (FR-068). */
const groupFor = (host, groups = []) => {
  const group = groups.find((g) => (g.host_patterns || []).some((pattern) => matchesGlob(host, pattern)));
  return group ? group.label : UNGROUPED;
};

/** The metric key: the panel expression without its instance matcher (data-model.md, Metric Window). */
const metricKey = (expr) => String(expr)
  .replace(/,\s*instance\s*=~?\s*"[^"]*"/g, '')
  .replace(/instance\s*=~?\s*"[^"]*"\s*,\s*/g, '')
  .replace(/instance\s*=~?\s*"[^"]*"/g, '')
  .replace(/\{\s*\}/g, '')
  .trim();

const hasTargets = (panel) => Array.isArray(panel.targets) && panel.targets.some((t) => t && t.expr);

const GROUPING = /\b(by|without)\s*\(([^)]*)\)/g;
const RANKING = /\b(topk|bottomk)\s*\(/;

/**
 * A panel whose expression yields one series per label value (`by`/`without` on anything but the histogram bucket)
 * or a ranked set (`topk`, `bottomk`) is a breakdown, not one per-project series (FR-075). Returns
 * `{ kind, labels }` or null for a single series.
 */
const breakdownOf = (expr) => {
  const labels = [];
  let without = false;
  for (const match of String(expr).matchAll(GROUPING)) {
    if (match[1] === 'without') {
      without = true;
    }
    for (const label of match[2].split(',').map((l) => l.trim()).filter(Boolean)) {
      if (label !== 'le' && !labels.includes(label)) {
        labels.push(label);
      }
    }
  }
  if (without) {
    return { kind: 'without', labels };
  }
  if (labels.length) {
    return { kind: 'by', labels };
  }
  const ranked = RANKING.exec(String(expr));
  return ranked ? { kind: ranked[1], labels: [] } : null;
};

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

/**
 * One record per panel target, restricted to the priority list's panel ids when the list is non-empty. `variables`
 * names the dashboard variables the expression uses; `unresolved` those the dashboard gives no single value (FR-071).
 */
const panelRecords = (doc, allowedIds = []) => {
  const variables = dashboardVariables(doc);
  return flattenPanels(doc.dashboard)
    .filter((panel) => !allowedIds.length || allowedIds.includes(panel.id))
    .flatMap((panel) => panel.targets.filter((t) => t && t.expr).map((target) => {
      const used = variablesIn(target.expr);
      return {
        panel_id: panel.id,
        title: panel.title || '',
        ref_id: target.refId || 'A',
        expr: target.expr,
        unit: unitOf(panel),
        metric: metricKey(target.expr),
        per_project: target.expr.includes('$cht_instance'),
        variables: used,
        unresolved: used.filter((name) => !isBuiltin(name) && (variables[name] ?? null) === null),
        breakdown: breakdownOf(target.expr),
      };
    }));
};

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
    const variables = dashboardVariables(doc);
    dashboards.push({
      uid: entry.uid,
      title: doc.dashboard.title,
      slug: doc.meta.slug,
      url: doc.meta.url,
      panels,
      variables,
      duplicate_panel_ids: duplicatePanelIds(doc, entry.panels || []),
    });
    const breakdowns = panels.filter((p) => p.per_project && p.breakdown);
    if (breakdowns.length) {
      // One series per route, code or database is not a per-project metric: shown on the dashboard, not analysed.
      logger.info('discovery.breakdown_panels', {
        uid: entry.uid,
        panels: breakdowns.map((p) => ({
          panel_id: p.panel_id, title: p.title, kind: p.breakdown.kind, labels: p.breakdown.labels,
        })),
      });
    }
    const unresolved = panels.filter((p) => p.unresolved.length);
    if (unresolved.length) {
      logger.warn('discovery.unresolved_variables', {
        uid: entry.uid, panels: unresolved.map((p) => ({ panel_id: p.panel_id, variables: p.unresolved })),
      });
    }
    logger.debug('discovery.dashboard', { uid: entry.uid, panels: panels.length, variables });
  }

  const scrapeTargetMetric = policy.thresholds.metric_roles.scrape_target;
  const time = Math.floor(runStart.getTime() / 1000);
  const activeTargets = await grafana.targets();
  const upVector = await grafana.queryInstant({ query: scrapeTargetMetric, time });
  let hosts = hostsFromVector(upVector);
  if (!hosts.length) {
    hosts = hostsFromTargets(activeTargets);
  }

  // Ignored hosts (development instances) are recorded with the pattern that matched and never queried, analysed
  // or named; the rest are assigned their programme group (FR-068).
  const groupPolicy = policy.projects.groups || [];
  const ignored = [];
  const analysable = [];
  for (const host of hosts) {
    const pattern = ignoredBy(host, policy.projects.ignore || []);
    if (pattern) {
      ignored.push({ host, pattern });
    } else {
      analysable.push(host);
    }
  }
  if (ignored.length) {
    logger.info('discovery.ignored', { ignored });
  }

  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];
  const trailing = windowBounds(runStart).find((b) => b.window === 'trailing_14d');
  const projects = [];
  for (const host of analysable) {
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
      group: groupFor(host, groupPolicy),
    });
    projects.push(project);
    logger.info('discovery.project', {
      project: host, configured: project.configured, cht_version: project.cht_version, history_days: historyDays,
      group: project.group,
    });
  }
  const groups = [...groupPolicy.map((g) => g.label), UNGROUPED]
    .map((label) => ({ label, hosts: projects.filter((p) => p.group === label).map((p) => p.host) }));

  const isAnalysable = (p) => p.per_project && !p.breakdown;
  const perProject = dashboards.flatMap((d) => d.panels.filter(isAnalysable).map((p) => p.metric));
  const metrics = [...new Set([...perProject, scrapeTargetMetric])].sort();

  return {
    run_start: runStart.toISOString(),
    datasource_uid: grafana.datasourceUid,
    projects,
    groups,
    ignored,
    dashboards,
    metrics,
    targets_summary: targetsSummary(activeTargets),
    scrape_target_metric: scrapeTargetMetric,
  };
};

module.exports = {
  discover, metricKey, flattenPanels, panelRecords, duplicatePanelIds, unitOf, groupFor, ignoredBy, dashboardVariables,
  breakdownOf,
};

'use strict';
// Stage `analyze`: computed changes and candidates per project, before any model involvement (FR-006, FR-014).
const { requireInputs } = require('./index');
const { activeWindow } = require('../../analyze/calendar');
const { computeChanges } = require('../../analyze/changes');
const { effectiveThresholds } = require('../../analyze/thresholds');
const { computeCandidates, suppressByHorizon } = require('../../analyze/candidates');
const { normaliseHost } = require('../../config/policy');
const { roleMatches } = require('../../analyze/thresholds');
const { runStartOf } = require('./collect');
const { classifyAlerts } = require('../../alerts/classify');
const { previousRunIds } = require('../../rollup/history');
const { RunDir } = require('../../store/run-dir');

const name = 'analyze';
const inputs = ['discovery.json'];

const thresholdsAreDeployed = (policy, config) => {
  const source = policy.sources && policy.sources.thresholds;
  const configDir = config.storage && config.storage.configDir;
  return Boolean(source && configDir && source.startsWith(configDir));
};

/** The most recent earlier run's classified alerts, for newness and start dates (FR-065). */
const previousClassified = async (dataDir, runId) => {
  for (const id of await previousRunIds(dataDir, runId)) {
    const run = RunDir.open(dataDir, id);
    if (run.exists('alerts.classified.json')) {
      return run.readJson('alerts.classified.json');
    }
  }
  return null;
};

const run = async (ctx) => {
  const { config, policy, logger, runDir } = ctx;
  const flags = ctx.flags || {};
  requireInputs(runDir, inputs);
  const discovery = await runDir.readJson('discovery.json');
  const runStart = runStartOf(ctx);
  const wanted = (flags.project || []).map(normaliseHost);
  const projects = wanted.length ? discovery.projects.filter((p) => wanted.includes(p.host)) : discovery.projects;
  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];
  const globalSource = thresholdsAreDeployed(policy, config);
  const horizons = runDir.exists('feedback.ingested.json')
    ? ((await runDir.readJson('feedback.ingested.json')).horizons || [])
    : [];
  let total = 0;
  const changesByProject = new Map();
  const deadHosts = new Set();
  const scrapeTarget = policy.thresholds.metric_roles && policy.thresholds.metric_roles.scrape_target;

  for (const project of projects) {
    const started = process.hrtime.bigint();
    const rel = `${project.slug}/inputs/windows.json.gz`;
    requireInputs(runDir, [rel]);
    const stored = await runDir.readGz(rel);
    const active = activeWindow(defaults, project, runStart);
    const changes = computeChanges({
      windows: stored.windows, project, activeWindow: active, kinds: policy.thresholds.metric_kinds || {},
    });
    const thresholds = effectiveThresholds(policy.thresholds, project.thresholds, { globalSource });
    const raw = computeCandidates({ changes, project, thresholds, policy, date: ctx.date, windows: stored.windows });
    const { kept: candidates, suppressed } = suppressByHorizon(raw, horizons, { date: ctx.date });
    await runDir.writeJson(`${project.slug}/changes.json`, changes);
    changesByProject.set(project.url, changes);
    const target = changes.find((c) => scrapeTarget && roleMatches(scrapeTarget, c.metric));
    if (target && target.current_value === 0) {
      deadHosts.add(project.host);
    }
    await runDir.writeJson(`${project.slug}/candidates.json`, candidates);
    await runDir.writeJson(`${project.slug}/suppressed.json`, suppressed);
    if (suppressed.length) {
      logger.info('analyze.suppressed', { project: project.host, suppressed });
    }
    total += candidates.length;
    logger.info('analyze.project', {
      project: project.host,
      metrics: changes.length,
      candidates: candidates.length,
      high: candidates.filter((c) => c.severity_floor === 'high').length,
      active_window: active ? active.id : null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
    });
  }

  // Alerts (FR-065): category, importance, staleness and newness by code, grouped per programme and category.
  const collected = runDir.exists('alerts.json')
    ? await runDir.readJson('alerts.json')
    : { available: false, reason: 'alerts.json was not collected' };
  const dataDir = (config.storage && config.storage.dataDir) || runDir.dataDir;
  const classified = classifyAlerts({
    collected,
    alertsPolicy: policy.alerts || { stale_after_days: 14, rules: {}, categories: {} },
    projectGroups: policy.projects.groups || [],
    previous: await previousClassified(dataDir, ctx.runId || runDir.runId),
    runStart,
    changesByProject,
    categories: (policy.alerts && policy.alerts.categories) || {},
    deadHosts,
    groupSizes: Object.fromEntries((discovery.groups || []).map((g) => [g.label, (g.hosts || []).length])),
  });
  await runDir.writeJson('alerts.classified.json', classified);
  logger.info('analyze.alerts', {
    available: classified.available, reason: classified.reason, counts: classified.counts,
    groups: classified.groups.length,
  });

  return { projects: projects.length, candidates: total, alert_groups: classified.groups.length };
};

module.exports = { name, inputs, run };

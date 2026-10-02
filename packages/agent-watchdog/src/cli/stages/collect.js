'use strict';
// Stage `collect`: discovery, scrape-target health and metric windows (FR-001 to FR-005).
const { createGrafanaClient, verifyDatasourceUid } = require('../../collect/grafana');
const { discover } = require('../../collect/discovery');
const { collectAlerts } = require('../../collect/alerts');
const { collectWindows } = require('../../collect/windows');
const { createHistory } = require('../../collect/history');
const { mapWithConcurrency } = require('../../collect/concurrency');
const { activeWindow } = require('../../analyze/calendar');
const { selectProjects } = require('../../config/filter');

const name = 'collect';
const inputs = [];

const runStartOf = (ctx) => (ctx.runStart ? new Date(ctx.runStart) : new Date(`${ctx.date}T06:00:00Z`));

const run = async (ctx) => {
  const { config, policy, logger, runDir } = ctx;
  const flags = ctx.flags || {};
  const deps = ctx.deps || {};
  const runStart = runStartOf(ctx);
  const grafana = deps.grafana || createGrafanaClient({
    baseUrl: config.endpoints.grafanaUrl,
    token: config.secrets.grafanaToken,
    datasourceUid: config.endpoints.prometheusDatasourceUid,
    timeoutMs: config.bounds.httpTimeoutMs,
    queryTimeoutMs: config.bounds.queryTimeoutMs,
    fetch: deps.fetch || globalThis.fetch,
    logger,
  });

  const docs = [];
  for (const entry of policy.dashboards.dashboards) {
    docs.push(await grafana.dashboard(entry.uid));
  }
  verifyDatasourceUid(grafana, docs);

  const discovery = await discover({ grafana, policy, config, runStart, logger, docs });
  await runDir.writeJson('discovery.json', discovery);
  logger.info('collect.discovery', {
    projects: discovery.projects.length, ignored: (discovery.ignored || []).length,
    groups: (discovery.groups || []).map((g) => `${g.label}: ${g.hosts.length}`),
    dashboards: discovery.dashboards.length, metrics: discovery.metrics.length, targets: discovery.targets_summary,
  });

  // Grafana-managed alerts (FR-064): recorded as collected; unavailable is a fact in the file, not a failure. The
  // snapshot is stamped with the clock, not the analysed date: a forced re-run reads today's alert state.
  const alerts = await collectAlerts({ grafana, policy, logger, now: ctx.now ? new Date(ctx.now) : runStart });
  await runDir.writeJson('alerts.json', alerts);
  logger.info('collect.alerts', {
    available: alerts.available, source: alerts.source, reason: alerts.reason, rules: alerts.rules.length,
    firing: alerts.instances.filter((i) => i.state === 'firing').length, ignored: alerts.ignored.length,
  });

  const projects = selectProjects(discovery.projects, flags);
  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];

  // Projects run through a bounded pool (FR-074); each reuses what the data volume holds (FR-072) and extends
  // its Daily Maxima Ledger, so a warm volume costs one query per metric.
  const dataDir = (config.storage && config.storage.dataDir) || runDir.dataDir;
  const runId = ctx.runId || runDir.runId;
  const concurrency = Math.max(1, (config.bounds && config.bounds.projectConcurrency) || 1);
  const totals = { fetched: 0, reused: 0, queries: 0, failed: 0, windows: 0 };
  const collectStarted = process.hrtime.bigint();
  await mapWithConcurrency(projects, concurrency, async (project) => {
    const started = process.hrtime.bigint();
    const active = activeWindow(defaults, project, runStart);
    const history = deps.history === false
      ? null
      : await createHistory({ dataDir, runId, date: ctx.date, runStart, project }).load();
    const { windows, stats } = await collectWindows({
      grafana, project, discovery, runStart, activeWindow: active, logger, history,
    });
    await runDir.writeGz(`${project.slug}/inputs/windows.json.gz`, {
      project_url: project.url,
      host: project.host,
      run_start: runStart.toISOString(),
      active_window_id: active ? active.id : null,
      windows,
    });
    if (history) {
      await history.save();
    }
    for (const key of Object.keys(stats)) {
      totals[key] += stats[key];
    }
    totals.windows += windows.length;
    logger.info('collect.project', {
      project: project.host,
      windows: windows.length,
      unavailable: windows.filter((w) => !w.available).length,
      fetched: stats.fetched,
      reused: stats.reused,
      queries: stats.queries,
      active_window: active ? active.id : null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
    });
  });
  logger.info('collect.done', {
    projects: projects.length, concurrency, ...totals,
    duration_ms: Number(process.hrtime.bigint() - collectStarted) / 1e6,
  });
  // What the collection managed, for the roll-up's notice when most windows failed their query (FR-073, revision 36).
  await runDir.writeJson('collect.summary.json', {
    projects: projects.length, metrics: discovery.metrics.length, ...totals,
  });

  return {
    projects: projects.length, metrics: discovery.metrics.length, ...totals,
    alerts: alerts.available ? alerts.instances.filter((i) => i.state === 'firing').length : null,
  };
};

module.exports = { name, inputs, run, runStartOf };

'use strict';
// Stage `collect`: discovery, scrape-target health and metric windows (FR-001 to FR-005).
const { createGrafanaClient, verifyDatasourceUid } = require('../../collect/grafana');
const { discover } = require('../../collect/discovery');
const { collectWindows } = require('../../collect/windows');
const { activeWindow } = require('../../analyze/calendar');
const { normaliseHost } = require('../../config/policy');

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

  const wanted = (flags.project || []).map(normaliseHost);
  const projects = wanted.length ? discovery.projects.filter((p) => wanted.includes(p.host)) : discovery.projects;
  const defaults = (policy.projects.defaults && policy.projects.defaults.expected_load_windows) || [];

  for (const project of projects) {
    const started = process.hrtime.bigint();
    const active = activeWindow(defaults, project, runStart);
    const { windows } = await collectWindows({ grafana, project, discovery, runStart, activeWindow: active, logger });
    await runDir.writeGz(`${project.slug}/inputs/windows.json.gz`, {
      project_url: project.url,
      host: project.host,
      run_start: runStart.toISOString(),
      active_window_id: active ? active.id : null,
      windows,
    });
    logger.info('collect.project', {
      project: project.host,
      windows: windows.length,
      unavailable: windows.filter((w) => !w.available).length,
      active_window: active ? active.id : null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
    });
  }

  return { projects: projects.length, metrics: discovery.metrics.length };
};

module.exports = { name, inputs, run, runStartOf };

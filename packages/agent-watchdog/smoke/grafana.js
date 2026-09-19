#!/usr/bin/env node
'use strict';
// Smoke test S-6 and S-7 (research.md): a Viewer service-account token against the hosted watchdog.
// Needs AGENT_WATCHDOG_GRAFANA_URL, AGENT_WATCHDOG_GRAFANA_TOKEN and AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID.
// Usage: node --env-file=.env smoke/grafana.js [--project <host>]
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log/logger');
const { createGrafanaClient, verifyDatasourceUid } = require('../src/collect/grafana');
const { discover } = require('../src/collect/discovery');
const { collectWindows } = require('../src/collect/windows');
const { buildDashboardLink } = require('../src/links/build');

const main = async () => {
  const { config, policy } = loadConfig({ command: 'run', flags: { 'dry-run': true } });
  const logger = createLogger({ level: 'info', format: 'pretty' });
  const grafana = createGrafanaClient({
    baseUrl: config.endpoints.grafanaUrl,
    token: config.secrets.grafanaToken,
    datasourceUid: config.endpoints.prometheusDatasourceUid,
    timeoutMs: config.bounds.httpTimeoutMs,
    logger,
  });
  const runStart = new Date();
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };

  const search = await grafana.search();
  record('search dashboards', Array.isArray(search) && search.length > 0, `${search.length} dashboards`);

  const dashboards = [];
  for (const entry of policy.dashboards.dashboards) {
    const dashboard = await grafana.dashboard(entry.uid);
    dashboards.push(dashboard);
    record(`dashboard ${entry.uid}`, Boolean(dashboard && dashboard.dashboard), dashboard && dashboard.dashboard.title);
  }
  try {
    await verifyDatasourceUid(grafana, dashboards);
    record('datasource uid matches dashboard targets', true, config.endpoints.prometheusDatasourceUid);
  } catch (error) {
    record('datasource uid matches dashboard targets', false, error.message);
  }

  const targets = await grafana.targets();
  record('scrape targets through the proxy', Array.isArray(targets), `${targets.length} active targets`);

  const discovery = await discover({ grafana, policy, config, runStart, logger });
  record('discover projects', discovery.projects.length > 0, discovery.projects.map((p) => p.host).join(', '));

  const project = discovery.projects.find((p) => p.host === process.argv[process.argv.indexOf('--project') + 1])
    || discovery.projects[0];
  const windows = await collectWindows({ grafana, project, discovery, runStart, activeWindow: null, logger });
  const available = windows.windows.filter((w) => w.available).length;
  record('metric windows for one project', available > 0, `${available}/${windows.windows.length} windows available`);

  const annotations = await grafana.annotations({ from: runStart.getTime() - 86400000, to: runStart.getTime() });
  record('annotations', Array.isArray(annotations), `${annotations.length} annotations`);

  const dashboard = discovery.dashboards[0];
  const link = buildDashboardLink({
    grafanaUrl: config.endpoints.grafanaUrl,
    dashboard,
    panelId: dashboard.panels[0] && dashboard.panels[0].panel_id,
    host: project.host,
    from: new Date(runStart.getTime() - 86400000).toISOString(),
    to: runStart.toISOString(),
  });
  console.log(`open this link in a browser to confirm the panel view (S-7): ${link}`);

  const failed = checks.filter((c) => !c.ok);
  process.exitCode = failed.length ? 1 : 0;
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';
// Smoke test S-6 and S-7 (research.md): a Viewer service-account token against the hosted watchdog.
// Needs AGENT_WATCHDOG_GRAFANA_URL, AGENT_WATCHDOG_GRAFANA_TOKEN and AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID.
// Usage: node --env-file=.env smoke/grafana.js [--project <host>] [--hosts] [--alerts]
// --hosts prints every discovered host with its programme group and the ignored hosts with the pattern that matched
// (FR-068), then stops; this is how the placeholder groups in projects.yaml get their real patterns.
// --alerts (S-14, S-15; research.md R-14) reads the Grafana-managed alert rules and instances with the Viewer token,
// prints the states and paging as returned, and the alert-list links to open in a browser, then stops.
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log/logger');
const { createGrafanaClient, verifyDatasourceUid } = require('../src/collect/grafana');
const { discover } = require('../src/collect/discovery');
const { collectWindows } = require('../src/collect/windows');
const { buildDashboardLink, buildAlertGroupLinks } = require('../src/links/build');
const { collectAlerts } = require('../src/collect/alerts');
const { classifyAlerts } = require('../src/alerts/classify');

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

  if (process.argv.includes('--alerts')) {
    const alerts = await collectAlerts({ grafana, policy, logger, now: runStart });
    const firing = alerts.instances.filter((i) => i.state === 'firing').length;
    const rawStates = [...new Set(alerts.raw.flatMap((page) => ((page.data && page.data.groups) || [])
      .flatMap((g) => (g.rules || []).flatMap((r) => (r.alerts || []).map((a) => a.state)))))];
    const summary = `${alerts.source}, ${alerts.pages} page(s), ${alerts.rules.length} rules, ${firing} firing; `
      + `raw states: ${rawStates.join(', ') || 'none'}`;
    const detail = alerts.available ? summary : alerts.reason;
    record('alerting endpoints readable with the Viewer token (S-14)', alerts.available, detail);
    for (const rule of alerts.rules) {
      const where = `group ${rule.rule_group} for ${rule.pending_for}`;
      console.log(`${rule.state.padEnd(8)} ${rule.title} (${rule.rule_uid}) ${where}`);
    }
    const classified = classifyAlerts({
      collected: alerts, alertsPolicy: policy.alerts, projectGroups: policy.projects.groups, previous: null, runStart,
    });
    for (const group of classified.groups) {
      const links = buildAlertGroupLinks({ grafanaUrl: config.endpoints.grafanaUrl, group });
      console.log(`${group.alert_key}: ${group.firing} firing (${group.importance}) ${links.group}`);
    }
    console.log('open the links above in a browser to confirm the filtered alert list (S-15)');
    process.exitCode = checks.some((c) => !c.ok) ? 1 : 0;
    return;
  }

  if (process.argv.includes('--hosts')) {
    console.log('\nhost\tgroup');
    for (const project of discovery.projects) {
      console.log(`${project.host}\t${project.group}`);
    }
    for (const entry of discovery.ignored || []) {
      console.log(`${entry.host}\tignored (${entry.pattern})`);
    }
    const groups = (discovery.groups || []).map((g) => `${g.label} (${g.hosts.length})`).join(', ');
    const ignoredCount = (discovery.ignored || []).length;
    console.log(`\n${discovery.projects.length} analysed, ${ignoredCount} ignored; groups: ${groups}`);
    process.exitCode = checks.some((c) => !c.ok) ? 1 : 0;
    return;
  }

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

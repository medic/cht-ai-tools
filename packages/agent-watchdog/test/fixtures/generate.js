#!/usr/bin/env node
'use strict';
// Deterministic fixture generator: writes test/fixtures/runs/{quiet-day,seeded-anomaly}/grafana/*.
// Re-run `node test/fixtures/generate.js` after changing this file; the output is committed.
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'runs');
const RUN_START = '2026-09-18T06:00:00Z';
const HOSTS = ['alpha.example.org', 'beta.example.org', 'gamma.example.org'];

const instanceVar = {
  name: 'cht_instance',
  type: 'query',
  label: 'CHT Instance',
  query: 'query_result(up{job=~"cht"})',
  regex: '/.*instance="([^"]+).*/',
  multi: false,
  includeAll: false,
  current: { text: HOSTS[0], value: HOSTS[0] },
};
const ds = { type: 'prometheus', uid: 'PBFA97CFB590B2093' };
const EXPR = {
  feedbackRate: 'increase(cht_feedback_total{instance=~"$cht_instance"}[1d])',
  serverTime: 'abs(cht_date_current_millis{instance=~"$cht_instance"} - time() * 1000)',
  dbGrowth: 'increase(cht_couchdb_doc_total{instance=~"$cht_instance", db="medic"}[1d])',
  delivered: 'cht_messaging_outgoing_total{instance=~"$cht_instance", status="delivered"}',
  usersMetaDocs: 'cht_couchdb_doc_total{instance=~"$cht_instance", db="medic-users-meta"}',
  requestRate: 'sum(rate(cht_api_http_request_total{instance=~"$cht_instance"}[5m]))',
  p95: 'histogram_quantile(0.95, '
    + 'sum(rate(cht_api_http_request_duration_seconds_bucket{instance=~"$cht_instance"}[5m])) by (le))',
  getIds: 'sum(rate(cht_api_http_request_duration_seconds_bucket'
    + '{instance=~"$cht_instance", route=~".*/get-ids", le="0.5"}[5m]))',
};
const panel = (id, title, expr, extra = {}) => ({
  id,
  title,
  type: 'timeseries',
  gridPos: { h: 8, w: 12, x: 0, y: 0 },
  datasource: ds,
  targets: [{ refId: 'A', expr, datasource: ds }],
  fieldConfig: { defaults: { unit: extra.unit || 'short' } },
  ...extra.panel,
});

const overview = {
  meta: { slug: 'cht-admin-overview', url: '/d/oa2OfL-Vk/cht-admin-overview', folderTitle: 'CHT' },
  dashboard: {
    uid: 'oa2OfL-Vk', title: 'CHT Admin Overview', timezone: 'utc', time: { from: 'now-24h', to: 'now' },
    templating: { list: [instanceVar] },
    panels: [
      panel(12, 'CHT Version Info', 'cht_version{instance=~"$cht_instance"}', { panel: { type: 'table' } }),
      panel(2, 'Outbound Push Backlog', 'cht_outbound_push_backlog_count{instance=~"$cht_instance"}'),
      panel(3, 'Sentinel Backlog', 'cht_sentinel_backlog_count{instance=~"$cht_instance"}'),
      panel(21, 'Users Over Replication Limit', 'cht_replication_limit_count{instance=~"$cht_instance"}'),
      panel(7, 'DB Conflicts Rate', 'cht_conflict_count{instance=~"$cht_instance"}', { unit: 'docs/day' }),
      panel(14, 'Client Feedback/Error Rate', EXPR.feedbackRate, { unit: 'docs/day' }),
      panel(16, 'CHT Uptime', 'cht_date_uptime_seconds{instance=~"$cht_instance"}', { unit: 's' }),
      panel(19, 'Server Time Accurate', EXPR.serverTime, { unit: 'ms' }),
      panel(13, 'DB Fragmentation', 'cht_couchdb_fragmentation{instance=~"$cht_instance", db="medic"}'),
      panel(8, 'DB Growth Rate', EXPR.dbGrowth, { unit: 'docs/day' }),
      panel(23, 'Monthly Active Users', 'cht_connected_users_count{instance=~"$cht_instance"}'),
      panel(27, 'Message Delivery Rate [24h]', EXPR.delivered),
      panel(50, 'CHT Sync Backlog', 'couch2pg_progress_pending{target="$cht_instance"}'),
      {
        id: 31,
        title: 'Monitoring Stack',
        type: 'row',
        collapsed: true,
        gridPos: { h: 1, w: 24, x: 0, y: 40 },
        panels: [
          panel(34, 'Prometheus Up', 'up{job="prometheus"}'),
          panel(35, 'JSON Exporter Up', 'up{job="json_exporter"}'),
        ] },
    ],
  },
};

const details = {
  meta: { slug: 'cht-admin-details', url: '/d/hkQUbyfVk/cht-admin-details', folderTitle: 'CHT' },
  dashboard: {
    uid: 'hkQUbyfVk', title: 'CHT Admin Details', timezone: 'utc',
    templating: {
      list: [
        instanceVar,
        {
          name: 'db_name', type: 'custom', hide: 2, multi: true, query: 'medic,sentinel', current: { value: ['medic'] },
        },
      ],
    },
    panels: [
      panel(2, 'Doc Count [medic]', 'cht_couchdb_doc_total{instance=~"$cht_instance", db="medic"}'),
      panel(2, 'Doc Count [sentinel]', 'cht_couchdb_doc_total{instance=~"$cht_instance", db="sentinel"}'),
      panel(2, 'Doc Count [medic-users-meta]', EXPR.usersMetaDocs),
      panel(2, 'Doc Count [_users]', 'cht_couchdb_doc_total{instance=~"$cht_instance", db="_users"}'),
      panel(9, 'Conflicts', 'cht_conflict_count{instance=~"$cht_instance"}'),
      panel(69, 'Sentinel Backlog', 'cht_sentinel_backlog_count{instance=~"$cht_instance"}'),
      panel(66, 'Outbound Push Backlog', 'cht_outbound_push_backlog_count{instance=~"$cht_instance"}'),
    ],
  },
};

const api = {
  meta: { slug: 'cht-api-server', url: '/d/3J_78b6Zz/cht-api-server', folderTitle: 'CHT' },
  dashboard: {
    uid: '3J_78b6Zz', title: 'CHT API Server', tags: ['CHT 4.3+'], templating: { list: [instanceVar] },
    panels: [
      panel(1, 'Requests per second', EXPR.requestRate, { unit: 'reqps' }),
      panel(2, 'p95 latency', EXPR.p95, { unit: 's' }),
    ],
  },
};

const replication = {
  meta: { slug: 'cht-replication', url: '/d/d4f05050-804e-4ea4-9642-4d088cc39a1b/cht-replication', folderTitle: 'CHT' },
  dashboard: {
    uid: 'd4f05050-804e-4ea4-9642-4d088cc39a1b',
    title: 'CHT Replication',
    tags: ['CHT 4.3+'],
    templating: { list: [instanceVar] },
    panels: [
      panel(1, 'get-ids Apdex', EXPR.getIds),
    ],
  },
};

const search = [overview, details, api, replication].map((d) => ({
  id: 1,
  uid: d.dashboard.uid,
  title: d.dashboard.title,
  uri: `db/${d.meta.slug}`,
  url: d.meta.url,
  type: 'dash-db',
  tags: d.dashboard.tags || [],
  folderUid: 'cht',
  folderTitle: 'CHT',
}));

const levels = (base, noise = 0.02) => Object.fromEntries(HOSTS.map((h) => [h, { base, noise }]));

const baseMetrics = () => ({
  cht_outbound_push_backlog_count: { unit: 'count', levels: levels(0, 0) },
  cht_sentinel_backlog_count: {
    unit: 'count',
    levels: {
      'alpha.example.org': { base: 300, noise: 0.03 },
      'beta.example.org': { base: 120, noise: 0.03 },
      'gamma.example.org': { base: 40, noise: 0.03 },
    },
  },
  cht_replication_limit_count: { unit: 'count', levels: levels(5, 0.05) },
  cht_conflict_count: { unit: 'count', levels: levels(15, 0.04) },
  cht_feedback_total: { unit: 'count', levels: levels(4, 0.05) },
  cht_date_uptime_seconds: { unit: 's', levels: levels(2592000, 0.001) },
  cht_date_current_millis: { unit: 'ms', levels: levels(120, 0.02) },
  cht_couchdb_fragmentation: { unit: 'ratio', levels: levels(2.3, 0.01) },
  // A counter: the level is the per-day increase (docs created a day), accumulated by the fake (FR-076).
  cht_couchdb_doc_total: { unit: 'count', kind: 'counter', levels: levels(1200, 0.02) },
  cht_connected_users_count: { unit: 'count', levels: levels(1085, 0.02) },
  cht_messaging_outgoing_total: { unit: 'count', levels: levels(950, 0.03) },
  cht_api_http_request_total: { unit: 'reqps', levels: levels(12, 0.05) },
  cht_api_http_request_duration_seconds_bucket: { unit: 's', levels: levels(0.31, 0.04) },
});

const APP_VERSIONS = ['4.11.0', '4.5.2', '3.17.0'];
const COUCH_VERSIONS = ['3.3.3', '3.3.3', '2.3.1'];
const versions = Object.fromEntries(HOSTS.map((h, i) => [
  h,
  { app: APP_VERSIONS[i], node: 'v20.11.1', couchdb: COUCH_VERSIONS[i] },
]));

const write = (caseName, seriesDoc, expected, alertsDoc = null) => {
  const dir = path.join(OUT, caseName, 'grafana');
  fs.mkdirSync(path.join(dir, 'dashboards'), { recursive: true });
  if (alertsDoc) {
    fs.writeFileSync(path.join(dir, 'alerts.json'), `${JSON.stringify(alertsDoc, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, 'search.json'), `${JSON.stringify(search, null, 2)}\n`);
  for (const d of [overview, details, api, replication]) {
    fs.writeFileSync(path.join(dir, 'dashboards', `${d.dashboard.uid}.json`), `${JSON.stringify(d, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, 'annotations.json'), '[]\n');
  fs.writeFileSync(path.join(dir, 'series.json'), `${JSON.stringify(seriesDoc, null, 2)}\n`);
  // Recorded model findings (test/fixtures/record-findings.js) add gate and item expectations; keep them.
  const expectedFile = path.join(OUT, caseName, 'expected.json');
  const recorded = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : {};
  const merged = {
    ...expected,
    ...(recorded.gate ? { gate: recorded.gate } : {}),
    ...(recorded.items ? { items: recorded.items } : {}),
  };
  fs.writeFileSync(expectedFile, `${JSON.stringify(merged, null, 2)}\n`);
};

write('quiet-day', { run_start: RUN_START, hosts: HOSTS, down: [], versions, metrics: baseMetrics() }, {
  description: 'No project differs notably from its baseline and every scrape target is up.',
  quiet: true,
  candidates: [],
});

const anomalyMetrics = baseMetrics();
anomalyMetrics.cht_sentinel_backlog_count.anomaly = {
  host: 'alpha.example.org', kind: 'monotonic_rise', hours: 7, to: 912,
};
const anomalySeries = {
  run_start: RUN_START, hosts: HOSTS, down: ['gamma.example.org'], versions, metrics: anomalyMetrics,
};
write('seeded-anomaly', anomalySeries, {
  description: "alpha's sentinel backlog climbs steadily for seven hours to three times yesterday's level; "
    + "gamma's scrape target is down.",
  quiet: false,
  candidates: [
    {
      host: 'alpha.example.org',
      metric_contains: 'cht_sentinel_backlog_count',
      rules: ['pct_change', 'deviation', 'monotonic'],
      severity_floor: 'high',
    },
    { host: 'gamma.example.org', metric_contains: 'up', rules: ['deviation', 'target_down'], severity_floor: 'high' },
  ],
});

// alerts-day: the seeded-anomaly series plus Grafana-managed alerts as the hosted watchdog raises them (User Story 8):
// the nine provisioned rules, one unknown rule, one rule without an instance label, fifteen firing instances across
// two programmes (three firing for more than fourteen days), one on a development host, one pending, and one that
// clears on the second day while another appears. Hosts other than the series' own are aliased in the tests.
const alertRule = (uid, title, forDuration, panelId, instances, extra = {}) => ({
  uid, title, for: forDuration, dashboard_uid: panelId === null ? null : 'oa2OfL-Vk', panel_id: panelId,
  query: extra.query || 'vector(1)', instances,
});
const firing = (host, activeAt, extra = {}) => ({
  host, labels: {}, state: 'Alerting', active_at: activeAt, value: '1200', ...extra,
});
const alertsDay = {
  folder: 'CHT',
  folder_uid: 'cht',
  page_size: 2,
  groups: [
    {
      name: '10m',
      interval: 600,
      rules: [
        alertRule('ot6lYCYVz', 'DB Fragmentation', '1h', 13, [
          firing('nepal-a.example.org', '2026-09-16T00:00:00Z', { labels: { db: 'medic' }, value: '9.2' }),
          firing('nepal-b.example.org', '2026-08-01T00:00:00Z', { labels: { db: 'medic' }, value: '11.4' }),
          firing('nepal-c.example.org', '2026-09-17T00:00:00Z', { labels: { db: 'sentinel' }, value: '8.7' }),
        ]),
        alertRule('KgP8PjY4k', 'Outbound Push Backlog', '1h', 2, [
          firing('nepal-a.example.org', '2026-09-17T22:00:00Z', { value: '48' }),
          firing('nepal-b.example.org', '2026-08-25T00:00:00Z', { value: '310' }),
        ]),
        alertRule('FzCrECYVk', 'Sentinel Backlog', '1h', 3, [
          firing('nepal-a.example.org', '2026-09-17T20:00:00Z'),
          firing('nepal-b.example.org', '2026-08-20T00:00:00Z', { value: '4400' }),
          firing('nepal-c.example.org', '2026-09-18T03:00:00Z', { until: '2026-09-19T00:00:00Z', value: '900' }),
          firing('cht-dev.example.org', '2026-09-17T10:00:00Z', { value: '700' }),
        ]),
        alertRule('hURoyjYVk', 'Server Time Accurate', '1h', 19, []),
        alertRule('ttAeECYVz', 'Users Over Replication Limit', '1h', 21, [
          firing('echis-b.example.org', '2026-09-17T09:00:00Z', { value: '12' }),
          { host: 'echis-a.example.org', labels: {}, state: 'Pending', active_at: '2026-09-18T05:50:00Z', value: '3' },
        ]),
        alertRule('diskUsage1', 'Disk Usage High', '1h', null, [
          firing('nepal-a.example.org', '2026-09-17T12:00:00Z', { value: '91' }),
        ], { query: 'node_filesystem_avail_bytes' }),
      ],
    },
    {
      name: '1m',
      interval: 60,
      rules: [
        alertRule('Q1A-BjL4k', 'API Server Down', '30m', 16, [
          firing('nepal-b.example.org', '2026-09-18T05:00:00Z', { value: '0' }),
        ]),
        alertRule('nBTZsCY4k', 'Client Feedback/Error Rate', '1m', 14, [
          firing('echis-a.example.org', '2026-09-18T01:00:00Z', { value: '140' }),
          firing('echis-b.example.org', '2026-09-19T02:00:00Z', { since: '2026-09-19T02:00:00Z', value: '95' }),
        ]),
        alertRule('gli1YjL4k', 'DB Conflicts Rate', '1m', 7, [
          firing('nepal-c.example.org', '2026-09-18T04:00:00Z', { value: '61' }),
        ]),
        alertRule('0R-OsCYVz', 'Message Delivery Rate', '1m', 27, [
          firing('echis-a.example.org', '2026-09-17T18:00:00Z', { value: '0.71' }),
          firing('echis-b.example.org', '2026-09-17T18:00:00Z', { value: '0.64' }),
        ]),
      ],
    },
    {
      name: 'watchdog',
      interval: 60,
      rules: [
        alertRule('wdScrape01', 'Watchdog Scrape Failures', '5m', null, [
          {
            host: null, labels: { job: 'prometheus' }, state: 'Alerting', active_at: '2026-09-17T23:00:00Z', value: '3',
          },
        ], { query: 'up{job="prometheus"}' }),
      ],
    },
  ],
};
write('alerts-day', anomalySeries, {
  description: "The seeded-anomaly day with Grafana-managed alerts firing across two programmes; alpha's sentinel "
    + "backlog climbs and gamma's scrape target is down as before.",
  quiet: false,
  candidates: [
    {
      host: 'alpha.example.org',
      metric_contains: 'cht_sentinel_backlog_count',
      rules: ['pct_change', 'deviation', 'monotonic'],
      severity_floor: 'high',
    },
    { host: 'gamma.example.org', metric_contains: 'up', rules: ['deviation', 'target_down'], severity_floor: 'high' },
  ],
}, alertsDay);

console.log(`wrote fixtures under ${OUT}`);

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
  cht_couchdb_doc_total: { unit: 'count', levels: levels(1200, 0.02) },
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

const write = (caseName, seriesDoc, expected) => {
  const dir = path.join(OUT, caseName, 'grafana');
  fs.mkdirSync(path.join(dir, 'dashboards'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'search.json'), `${JSON.stringify(search, null, 2)}\n`);
  for (const d of [overview, details, api, replication]) {
    fs.writeFileSync(path.join(dir, 'dashboards', `${d.dashboard.uid}.json`), `${JSON.stringify(d, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, 'annotations.json'), '[]\n');
  fs.writeFileSync(path.join(dir, 'series.json'), `${JSON.stringify(seriesDoc, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, caseName, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
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
    { host: 'gamma.example.org', metric_contains: 'up', rules: ['target_down'], severity_floor: 'high' },
  ],
});

console.log(`wrote fixtures under ${OUT}`);

'use strict';
// Alert fixtures for unit tests (User Story 8): rules as the hosted watchdog provisions them, instances as Grafana
// reports them, and the classified and grouped forms the stages write. Shapes follow data-model.md.
const crypto = require('node:crypto');

const RUN_START = '2026-09-18T06:00:00Z';
const DASHBOARD = 'oa2OfL-Vk';

const hash12 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

const RULES = {
  sentinel: { rule_uid: 'FzCrECYVk', title: 'Sentinel Backlog', rule_group: '10m', pending_for: '1h', panel_id: 3 },
  outbound: {
    rule_uid: 'KgP8PjY4k', title: 'Outbound Push Backlog', rule_group: '10m', pending_for: '1h', panel_id: 2,
  },
  apiDown: { rule_uid: 'Q1A-BjL4k', title: 'API Server Down', rule_group: '1m', pending_for: '30m', panel_id: 16 },
  fragmentation: {
    rule_uid: 'ot6lYCYVz', title: 'DB Fragmentation', rule_group: '10m', pending_for: '1h', panel_id: 13,
  },
  delivery: {
    rule_uid: '0R-OsCYVz', title: 'Message Delivery Rate', rule_group: '1m', pending_for: '1m', panel_id: 27,
  },
  unknown: { rule_uid: 'diskUsage1', title: 'Disk Usage High', rule_group: '10m', pending_for: '1h', panel_id: null },
  watchdog: {
    rule_uid: 'wdScrape01', title: 'Watchdog Scrape Failures', rule_group: '1m', pending_for: '5m', panel_id: null,
  },
};

/** A collected rule as src/collect/alerts.js records it. */
const rule = (key, overrides = {}) => ({
  folder: 'CHT',
  dashboard_uid: RULES[key].panel_id === null ? null : DASHBOARD,
  health: 'ok',
  state: 'firing',
  ...RULES[key],
  ...overrides,
});

/** A collected firing instance: host normalised, labels and annotations kept verbatim. */
const instance = (key, host, overrides = {}) => {
  const base = RULES[key];
  const labels = {
    alertname: base.title, grafana_folder: 'CHT', ...(host ? { instance: host } : {}), ...(overrides.labels || {}),
  };
  const { labels: ignored, ...rest } = overrides;
  void ignored;
  const labelText = Object.entries(labels).filter(([k]) => k !== 'alertname').sort()
    .map(([k, v]) => `${k}=${v}`).join(',');
  return {
    instance_id: hash12(`${base.rule_uid}|${labelText}`),
    rule_uid: base.rule_uid,
    title: base.title,
    host: host || null,
    project_url: host ? `https://${host}` : null,
    labels,
    annotations: {
      __dashboardUid__: base.panel_id === null ? undefined : DASHBOARD,
      __panelId__: base.panel_id === null ? undefined : String(base.panel_id),
      description: `CHT Server [${host || 'watchdog'}] alert`,
    },
    state: 'firing',
    active_at: '2026-09-17T20:00:00Z',
    value: '1200',
    dashboard_uid: base.panel_id === null ? null : DASHBOARD,
    panel_id: base.panel_id,
    ...rest,
  };
};

const IMPORTANCE = {
  sentinel: ['backlog', 'high'], outbound: ['backlog', 'high'], apiDown: ['availability', 'critical'],
  fragmentation: ['database', 'low'], delivery: ['messaging', 'high'],
};

const groupLabelFor = (host) => {
  if (!host) {
    return 'Watchdog';
  }
  if (/north/.test(host)) {
    return 'North Programme';
  }
  return /south/.test(host) ? 'South Programme' : 'Other';
};

/** A classified instance (src/alerts/classify.js output). */
const classified = (key, host, overrides = {}) => {
  const [category, importance] = IMPORTANCE[key] || ['uncategorised', 'medium'];
  const base = instance(key, host, overrides.collected || {});
  const startedAt = overrides.started_at || base.active_at;
  const daysFiring = Math.floor((Date.parse(RUN_START) - Date.parse(startedAt)) / 86400000);
  const { collected: ignored, ...rest } = overrides;
  void ignored;
  return {
    ...base,
    group: groupLabelFor(host),
    category,
    importance,
    known: Boolean(IMPORTANCE[key]),
    started_at: startedAt,
    days_firing: daysFiring,
    stale: daysFiring >= 14,
    new: false,
    ...rest,
  };
};

/** An Alert Group (src/alerts/group.js output) built from classified instances of one group and category. */
const groupOf = (instances, overrides = {}) => {
  const [first] = instances;
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const importance = instances.map((i) => i.importance).sort((a, b) => order[a] - order[b])[0];
  return {
    alert_key: `${first.group}/${first.category}`,
    group: first.group,
    category: first.category,
    importance,
    firing: instances.length,
    new: instances.filter((i) => i.new).length,
    stale: instances.filter((i) => i.stale).length,
    oldest_started_at: [...instances.map((i) => i.started_at)].sort()[0],
    rule_uids: [...new Set(instances.map((i) => i.rule_uid))].sort(),
    titles: [...new Set(instances.map((i) => i.title))].sort(),
    instance_ids: instances.map((i) => i.instance_id),
    hosts: [...new Set(instances.map((i) => i.host).filter(Boolean))].sort(),
    instances: instances.map((i) => ({
      instance_id: i.instance_id, title: i.title, host: i.host, started_at: i.started_at, days_firing: i.days_firing,
      stale: i.stale, new: i.new,
    })),
    ...overrides,
  };
};

/** The alerts.yaml policy as the package default declares it (FR-065). */
const alertsPolicy = () => ({
  stale_after_days: 14,
  rules: {
    'API Server Down': { category: 'availability', importance: 'critical' },
    'Sentinel Backlog': { category: 'backlog', importance: 'high' },
    'Outbound Push Backlog': { category: 'backlog', importance: 'high' },
    'Message Delivery Rate': { category: 'messaging', importance: 'high' },
    'DB Conflicts Rate': { category: 'database', importance: 'medium' },
    'Client Feedback/Error Rate': { category: 'client_errors', importance: 'medium' },
    'Users Over Replication Limit': { category: 'replication', importance: 'medium' },
    'DB Fragmentation': { category: 'database', importance: 'low' },
    'Server Time Accurate': { category: 'host', importance: 'low' },
  },
  categories: {
    availability: ['up{job="cht"}'],
    backlog: ['cht_sentinel_backlog_count', 'cht_outbound_push_backlog_count'],
    messaging: ['cht_messaging_outgoing_total'],
    database: ['cht_conflict_count', 'cht_couchdb_fragmentation'],
    client_errors: ['cht_feedback_total'],
    replication: ['cht_replication_limit_count'],
    host: ['cht_date_current_millis'],
  },
});

const PROJECT_GROUPS = [
  { label: 'North Programme', host_patterns: ['*north*'] },
  { label: 'South Programme', host_patterns: ['*south*'] },
];

module.exports = {
  RUN_START, DASHBOARD, RULES, rule, instance, classified, groupOf, alertsPolicy, PROJECT_GROUPS, hash12,
};

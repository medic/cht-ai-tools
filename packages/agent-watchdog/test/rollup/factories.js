'use strict';
// Factories for valid entities used by the rollup, render and publish tests.
const { itemId } = require('../../src/model/identity');

const HOST = 'alpha.example.org';
const URL = `https://${HOST}`;
const RUN_START = '2026-09-18T06:00:00Z';
const DAY_BEFORE = '2026-09-17T06:00:00Z';

const makeItem = (overrides = {}) => {
  const metric = overrides.metric || 'cht_sentinel_backlog_count';
  const projectUrl = overrides.project_url || URL;
  return {
    item_id: itemId(projectUrl, metric, overrides.pattern_card || null),
    project_url: projectUrl,
    metric,
    severity: 'high',
    evidence: [
      { window: 'current', value: 912, unit: 'count', start: DAY_BEFORE, end: RUN_START },
      { window: 'previous_day', value: 300, unit: 'count' },
    ],
    why_now: 'Sentinel backlog has climbed steadily for seven hours to three times yesterday.',
    suggested_check: 'Check sentinel logs for a stuck transition.',
    dashboard_ref: {
      dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: projectUrl, from: DAY_BEFORE, to: RUN_START,
    },
    confidence: 0.85,
    persisting_days: 1,
    pattern_card: null,
    candidate_ids: ['0123456789ab'],
    reference_urls: [],
    rank: null,
    placement: null,
    pass_history: [],
    ...overrides,
  };
};

const makeCandidate = (overrides = {}) => ({
  candidate_id: '0123456789ab',
  project_url: URL,
  metric: 'cht_sentinel_backlog_count',
  panel_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' },
  rule: 'pct_change',
  threshold: { source: 'default', value: 50 },
  observed: 204,
  severity_floor: 'high',
  evidence: [
    { window: 'current', value: 912, unit: 'count' },
    { window: 'previous_day', value: 300, unit: 'count' },
  ],
  expected_load_window_id: null,
  ...overrides,
});

const makeProject = (host = HOST, overrides = {}) => ({
  host,
  url: `https://${host}`,
  slug: host.replace(/[^a-z0-9]+/g, '-'),
  configured: false,
  owner: null,
  notes: null,
  thresholds: null,
  expected_load_windows: [],
  cht_version: '4.11.0',
  history_days: 21,
  scrape_targets: [{ job: 'cht', scrape_url: `https://${host}`, health: 'up', last_error: null }],
  ...overrides,
});

const makeDiscovery = (overrides = {}) => ({
  run_start: RUN_START,
  projects: [makeProject('alpha.example.org'), makeProject('beta.example.org'), makeProject('gamma.example.org')],
  dashboards: [
    {
      uid: 'oa2OfL-Vk',
      title: 'CHT Admin Overview',
      slug: 'cht-admin-overview',
      url: '/d/oa2OfL-Vk/cht-admin-overview',
      panels: [
        {
          panel_id: 2,
          title: 'Outbound Push Backlog',
          expr: 'cht_outbound_push_backlog_count{instance=~"$cht_instance"}',
          unit: 'count',
          metric: 'cht_outbound_push_backlog_count',
        },
        {
          panel_id: 3,
          title: 'Sentinel Backlog',
          expr: 'cht_sentinel_backlog_count{instance=~"$cht_instance"}',
          unit: 'count',
          metric: 'cht_sentinel_backlog_count',
        },
      ],
      duplicate_panel_ids: [],
    },
    {
      uid: 'hkQUbyfVk',
      title: 'CHT Admin Details',
      slug: 'cht-admin-details',
      url: '/d/hkQUbyfVk/cht-admin-details',
      panels: [{
        panel_id: 9,
        title: 'Conflicts',
        expr: 'cht_conflict_count{instance=~"$cht_instance"}',
        unit: 'count',
        metric: 'cht_conflict_count',
      }],
      duplicate_panel_ids: [2],
    },
  ],
  metrics: ['cht_outbound_push_backlog_count', 'cht_sentinel_backlog_count', 'cht_conflict_count', 'up'],
  targets_summary: { up: 3, down: 0 },
  ...overrides,
});

const footer = () => ({
  specs_url: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop',
  config_url: 'https://github.com/medic/medic-infrastructure',
  trace_url: 'https://langfuse.example.org/trace/t1',
  cost_usd: 0.1234,
});

const makeBrief = (overrides = {}) => ({
  run_id: '2026-09-18',
  kind: 'brief',
  headline: 'Sentinel backlog tripled on alpha',
  bullets: [{ item_id: makeItem().item_id, text: 'alpha sentinel backlog 912 vs 300 yesterday, rising for 7 hours' }],
  expected_load_notice: null,
  checked: { projects: 3, panels: 3, candidates: 2 },
  degradation_notice: null,
  image: null,
  footer: footer(),
  publication: null,
  ...overrides,
});

const makeConfig = (overrides = {}) => ({
  model: { name: 'claude-fable-5-1', effort: 'max', engine: 'sdk' },
  bounds: {
    maxTurns: 20, maxBudgetUsdProject: 2, maxBudgetUsdRun: 25, modelTimeoutMs: 900000, verifyMaxRetries: 2, passes: 2,
  },
  endpoints: {
    specsUrl: footer().specs_url,
    configUrl: footer().config_url,
    grafanaUrl: 'https://watchdog.example.org',
    slackChannelId: 'C123',
  },
  secrets: { slackBotToken: 'xoxb-test' },
  runtime: { claudePath: null },
  paths: {},
  ...overrides,
});

const quietLogger = () => {
  const log = { events: [] };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
    log[level] = (event, fields) => log.events.push({ level, event, ...(fields || {}) });
  }
  log.child = () => log;
  return log;
};

module.exports = {
  HOST, URL, RUN_START, DAY_BEFORE, makeItem, makeCandidate, makeProject, makeDiscovery, footer, makeBrief, makeConfig,
  quietLogger,
};

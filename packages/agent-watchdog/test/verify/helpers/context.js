'use strict';
// A consistent gate context matching test/fixtures/findings/pass1.valid.json.
const fs = require('node:fs');
const path = require('node:path');
const { buildAllowlist } = require('../../../src/links/allowlist');

const HOST = 'cht.example.org';
const URL = 'https://cht.example.org';
const METRIC = 'cht_sentinel_backlog_count';
const PANEL_REF = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };
const T0 = '2026-09-17T06:00:00Z';
const T1 = '2026-09-18T06:00:00Z';

const config = {
  endpoints: {
    grafanaUrl: 'https://watchdog.example.org',
    langfuseBaseUrl: 'https://langfuse.example.org',
    promptsUrl: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
    configUrl: 'https://github.com/medic/medic-infrastructure',
    docsMcpUrl: 'https://docs-mcp.example.org/mcp',
  },
};

const loadFindings = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'findings', 'pass1.valid.json'), 'utf8',
));

const candidate = (id, rule, floor, observed, threshold) => ({
  candidate_id: id,
  project_url: URL,
  metric: METRIC,
  panel_ref: PANEL_REF,
  rule,
  threshold: { source: 'default', value: threshold },
  observed,
  severity_floor: floor,
  evidence: [],
  expected_load_window_id: null,
});

const window = (name, start, end, stepS = 300) => ({
  project_url: URL,
  metric: METRIC,
  panel_ref: PANEL_REF,
  window: name,
  start,
  end,
  step_s: stepS,
  unit: 'count',
  values: [],
  available: true,
  unavailable_reason: null,
});

const baseContext = () => {
  const findings = loadFindings();
  const discovery = {
    projects: [{ host: HOST, url: URL, slug: 'cht-example-org' }],
    metrics: [METRIC, 'cht_outbound_push_backlog_count', 'up{job="cht"}'],
    dashboards: [{
      uid: 'oa2OfL-Vk',
      title: 'CHT Admin Overview',
      slug: 'cht-admin-overview',
      duplicate_panel_ids: [],
      panels: [
        {
          id: 3,
          title: 'Sentinel Backlog',
          expr: 'cht_sentinel_backlog_count{instance=~"$cht_instance"}',
          metric: METRIC,
        },
        {
          id: 2,
          title: 'Outbound Push Backlog',
          expr: 'cht_outbound_push_backlog_count{instance=~"$cht_instance"}',
          metric: 'cht_outbound_push_backlog_count',
        },
      ],
    }],
  };
  const candidates = [
    candidate('0123456789ab', 'pct_change', 'low', 204, 50),
    candidate('ba9876543210', 'backlog_absolute', 'high', 912, 3),
    candidate('cafebabecafe', 'deviation', 'low', 67, 2.5),
  ];
  const changes = [{
    project_url: URL,
    metric: METRIC,
    panel_ref: PANEL_REF,
    current_value: 912,
    previous_day_value: 300,
    previous_week_value: 310,
    previous_cycle_value: null,
    pct_change_vs_previous_day: 204,
    trailing_mean: 302,
    trailing_stddev: 9.1,
    deviation_sigma: 67,
    monotonic_rise_hours: 7,
    baseline: 'previous_day',
    expected_load_window_id: null,
  }];
  const windows = [
    window('current', T0, T1),
    window('previous_day', '2026-09-16T06:00:00Z', T0),
    window('trailing_14d', '2026-09-04T06:00:00Z', T1, 86400),
  ];
  const items = findings.items.map((item) => ({
    item_id: 'a1b2c3d4e5f6',
    project_url: URL,
    metric: item.item_key.metric,
    severity: item.severity,
    evidence: item.evidence,
    why_now: item.why_now,
    suggested_check: item.suggested_check,
    dashboard_ref: { ...item.dashboard_ref, project_url: URL },
    confidence: item.confidence,
    persisting_days: 1,
    pattern_card: item.item_key.pattern_card,
    candidate_ids: item.candidate_ids,
    reference_urls: item.reference_urls,
    rank: null,
    placement: null,
    pass_history: [],
  }));
  return {
    mode: 'findings',
    findings,
    items,
    draft: null,
    project: discovery.projects[0],
    discovery,
    candidates,
    changes,
    windows,
    toolResultUrls: new Set(['https://docs.communityhealthtoolkit.org/hosting/monitoring/']),
    knownCards: ['sentinel-stall'],
    allowlist: buildAllowlist(config),
    linkResults: null,
    builtLinks: null,
  };
};

const briefContext = () => {
  const ctx = baseContext();
  ctx.mode = 'brief';
  ctx.draft = {
    headline: 'One project needs a look',
    bullets: [{ item_id: 'a1b2c3d4e5f6', text: 'cht.example.org sentinel backlog 912 vs 300 yesterday (204.0%)' }],
    thread_order: ['a1b2c3d4e5f6'],
    expected_load_notice: null,
    memory_update: { replace_with: null },
    proposals: [],
  };
  return ctx;
};

module.exports = { baseContext, briefContext, config, HOST, URL, METRIC, PANEL_REF, T0, T1 };

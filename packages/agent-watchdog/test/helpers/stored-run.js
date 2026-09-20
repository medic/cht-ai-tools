'use strict';
// Writes a minimal, schema-consistent stored run (contracts/run-directory.md) for replay tests: discovery, per
// project changes, candidates, windows, an accepted pass with its verification report, tool-call recordings for
// both MCP servers, and the run record.
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { itemId, candidateId } = require('../../src/model/identity');
const { makeItem, makeCandidate, makeProject, makeDiscovery } = require('../rollup/factories');

const METRIC = 'cht_sentinel_backlog_count';
const PANEL_REF = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };
const HEX64 = (ch) => ch.repeat(64);

const computedChange = (url) => ({
  project_url: url,
  metric: METRIC,
  panel_ref: PANEL_REF,
  current_value: 912,
  previous_day_value: 300,
  previous_week_value: 310,
  previous_cycle_value: null,
  pct_change_vs_previous_day: 204,
  trailing_mean: 305,
  trailing_stddev: 10,
  deviation_sigma: 60.7,
  monotonic_rise_hours: 7,
  baseline: 'previous_day',
  expected_load_window_id: null,
});

const windowsFor = (url, host, date) => {
  const runStart = `${date}T06:00:00Z`;
  const dayBefore = new Date(Date.parse(runStart) - 86400000).toISOString();
  const twoBefore = new Date(Date.parse(runStart) - 2 * 86400000).toISOString();
  const window = (name, start, end, values, step = 300) => ({
    project_url: url, metric: METRIC, panel_ref: PANEL_REF, window: name, start, end, step_s: step, unit: 'count',
    values, available: true, unavailable_reason: null,
  });
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  const trailingValues = (end) => Array.from({ length: 14 }, (_, i) => [end - i * 86400, 305]);
  return {
    project_url: url,
    host,
    run_start: runStart,
    active_window_id: null,
    windows: [
      window('current', dayBefore, runStart, [[at(dayBefore), 300], [at(runStart), 912]]),
      window('previous_day', twoBefore, dayBefore, [[at(twoBefore), 298], [at(dayBefore), 300]]),
      window('trailing_14d', twoBefore, runStart, trailingValues(at(runStart)), 86400),
    ],
  };
};

const recordings = (date) => [
  {
    pass: 1, attempt: 1, ts: `${date}T06:01:00Z`, tool_name: 'mcp__watchdog__get_windows',
    tool_input: { metric: METRIC },
    tool_response: JSON.stringify({
      windows: [{ window: 'current', values: [[1, 912]] }], change: { current_value: 912 },
    }),
  },
  {
    pass: 1, attempt: 1, ts: `${date}T06:01:02Z`, tool_name: 'mcp__cht-docs__search_docs',
    tool_input: { query: 'sentinel backlog' },
    tool_response: '**Sentinel|Backlog**\nSource: https://docs.communityhealthtoolkit.org/sentinel\n---',
  },
];

const acceptedReport = (slug) => ({
  subject: 'pass', subject_ref: `${slug}/pass1`, attempt: 1, outcome: 'accepted',
  checks: [{ name: 'schema', status: 'pass', reasons: [] }],
});

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.runId] `YYYY-MM-DD` or `YYYY-MM-DD-f<n>`
 * @param {string[]} [options.hosts] projects, all with candidates and an accepted item
 * @param {boolean} [options.withWindows] write inputs/windows.json.gz (false simulates purged raw inputs)
 * @param {boolean} [options.withDiscovery] false writes a broken run without discovery.json
 * @param {Function} [options.toolCalls] (date) => recorded tool-calls.jsonl lines
 */
const buildStoredRun = async ({
  dataDir, runId = '2026-09-18', hosts = ['alpha.example.org', 'gamma.example.org'], withWindows = true,
  withDiscovery = true, toolCalls = recordings,
}) => {
  await ensureDataLayout(dataDir);
  const runDir = await RunDir.create(dataDir, runId);
  const date = runId.slice(0, 10);
  const projects = hosts.map((host) => makeProject(host));
  const discovery = makeDiscovery({ run_start: `${date}T06:00:00Z`, projects });
  if (withDiscovery) {
    await runDir.writeJson('discovery.json', discovery);
  }
  await runDir.writeJson('config.effective.json', { secrets: {}, endpoints: {} });
  const built = [];
  for (const project of projects) {
    const { url, host, slug } = project;
    const candidate = makeCandidate({ candidate_id: candidateId(url, METRIC, 'pct_change', date), project_url: url });
    const changes = [computedChange(url)];
    const item = makeItem({ project_url: url, candidate_ids: [candidate.candidate_id] });
    await runDir.writeJson(`${slug}/changes.json`, changes);
    await runDir.writeJson(`${slug}/candidates.json`, [candidate]);
    await runDir.writeJson(`${slug}/suppressed.json`, []);
    if (withWindows) {
      await runDir.writeGz(`${slug}/inputs/windows.json.gz`, windowsFor(url, host, date));
    }
    const pass = {
      pass: 1, session_id: 'sess-source', items: [item], not_selected: [], changes: [], converged: false,
      gate: acceptedReport(slug),
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      cost_usd: 0.01, num_turns: 2, duration_ms: 100, tool_calls_path: `${slug}/tool-calls.jsonl`,
    };
    await runDir.writeJson(`${slug}/findings.pass1.json`, pass);
    await runDir.writeJson(`${slug}/verification.pass1.json`, acceptedReport(slug));
    for (const line of toolCalls(date)) {
      await runDir.appendJsonl(`${slug}/tool-calls.jsonl`, line);
    }
    await runDir.writeJson(`${slug}/passes.json`, {
      passes: [pass], diffs: [], converged: false, bounds_hit: [], reference_sources_unavailable: false,
    });
    await runDir.writeJson(`${slug}/session.json`, {
      session_id: 'sess-source', model: 'claude-fable-5-1', engine: 'sdk', calls: [],
      reference_sources_unavailable: false,
    });
    built.push({ host, url, slug, candidate, item, changes, item_id: itemId(url, METRIC, null) });
  }
  await runDir.updateRun({
    run_id: runId,
    date,
    mode: 'scheduled',
    status: 'published',
    started_at: `${date}T06:00:00Z`,
    finished_at: `${date}T06:20:00Z`,
    duration_ms: 1200000,
    versions: {
      package: '0.0.0-development', git_sha: 'source1', prompts_hash: HEX64('a'), skill_hash: HEX64('b'),
      schema_hash: HEX64('c'), config_hash: HEX64('d'),
    },
    config_effective_path: 'config.effective.json',
    stages: [],
    projects: projects.map((p) => p.url),
    usage: null,
    cost_usd: 0.02,
    publications: [],
    trace_id: 'trace-source',
    trace_url: null,
    supersedes: null,
    superseded_by: null,
    bounds_hit: [],
  });
  return { runDir, runId, date, discovery, projects: built };
};

module.exports = { buildStoredRun, METRIC, PANEL_REF, computedChange, windowsFor, recordings };

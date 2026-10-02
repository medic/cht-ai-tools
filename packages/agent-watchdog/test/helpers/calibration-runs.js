'use strict';
// Thirty (or more) days of stored runs and feedback outcomes for one project and one noisy metric, laid out as
// the pipeline stores them (contracts/run-directory.md), so the calibration report can be checked against
// numbers a test can compute. The daily pattern repeats every five days, oldest day first:
//   i % 5 === 0  confirmed day:  pct 120, 130 or 140, a candidate, an item, a thumbs-up outcome
//   i % 5 === 2  dismissed day:  pct 55, 60, 65, 70 or 75 (cycling per occurrence), an item, a thumbs-down outcome
//   i % 5 === 4  unreviewed day: pct 90, an item, no outcome
//   otherwise    quiet day:      pct 30 or 20, no candidate, no item
// Every flagged day runs two passes; every third confirmed day (i % 10 === 0) records a changed second pass.
// Outcomes are dated the day after the posting, which is when the feedback stage of the next run records them.
const fs = require('node:fs');
const path = require('node:path');
const { RunDir, ensureDataLayout, dataPaths } = require('../../src/store/run-dir');
const { itemId, candidateId, projectSlug } = require('../../src/model/identity');
const atomic = require('../../src/store/atomic');
const { makeDiscovery, makeProject } = require('../rollup/factories');

const DAY_MS = 86400000;
const PANEL_REF = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };

const PATTERN = Object.freeze({
  currentThreshold: 50,
  deviationThreshold: 2.5,
  confirmed: [120, 130, 140],
  dismissed: [55, 60, 65, 70, 75],
  unreviewed: 90,
  quiet: [30, 20],
  deviationPerPct: 1 / 25,
  expectedSuggestion: 80,
});

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The day plan for index i (0 = oldest): { kind, pct, outcome, changedPass }. */
const dayPlan = (i) => {
  const cycle = i % 5;
  if (cycle === 0) {
    return { kind: 'confirmed', pct: PATTERN.confirmed[i % 3], outcome: 'confirmed', changedPass: i % 10 === 0 };
  }
  if (cycle === 2) {
    const value = PATTERN.dismissed[Math.floor(i / 5) % PATTERN.dismissed.length];
    return { kind: 'dismissed', pct: value, outcome: 'dismissed', changedPass: false };
  }
  if (cycle === 4) {
    return { kind: 'unreviewed', pct: PATTERN.unreviewed, outcome: null, changedPass: false };
  }
  return { kind: 'quiet', pct: PATTERN.quiet[cycle === 1 ? 0 : 1], outcome: null, changedPass: false };
};

/** What a report over `days` days of this history should contain. */
const expectedFor = (days) => {
  const plans = Array.from({ length: days }, (_, i) => dayPlan(i));
  const flagged = plans.filter((p) => p.kind !== 'quiet');
  const count = (kind) => plans.filter((p) => p.kind === kind).length;
  return {
    plans,
    pctValues: plans.map((p) => p.pct),
    devValues: plans.map((p) => p.pct * PATTERN.deviationPerPct),
    confirmed: count('confirmed'),
    dismissed: count('dismissed'),
    unreviewed: count('unreviewed'),
    sessions: flagged.length,
    changedSessions: flagged.filter((p) => p.changedPass).length,
    itemsKeptAt: (threshold) => flagged.filter((p) => p.pct >= threshold).length,
    confirmedKeptAt: (threshold) => plans.filter((p) => p.kind === 'confirmed' && p.pct >= threshold).length,
  };
};

const changeFor = ({ url, metric, pct, dev }) => ({
  project_url: url,
  metric,
  panel_ref: PANEL_REF,
  current_value: Math.round(300 * (1 + pct / 100)),
  previous_day_value: 300,
  previous_week_value: 305,
  previous_cycle_value: null,
  pct_change_vs_previous_day: pct,
  trailing_mean: 300,
  trailing_stddev: 12,
  deviation_sigma: dev,
  monotonic_rise_hours: 0,
  baseline: 'previous_day',
  expected_load_window_id: null,
});

const candidateFor = ({ url, metric, date, rule, observed, threshold }) => ({
  candidate_id: candidateId(url, metric, rule, date),
  project_url: url,
  metric,
  panel_ref: PANEL_REF,
  rule,
  threshold: { source: 'default', value: threshold },
  observed,
  severity_floor: 'low',
  evidence: [{ window: 'current', value: Math.round(300 * (1 + observed / 100)), unit: 'count' }],
  expected_load_window_id: null,
});

const itemFor = ({ url, metric, candidates, date }) => ({
  item_id: itemId(url, metric, null),
  project_url: url,
  metric,
  severity: 'medium',
  evidence: [{ window: 'current', value: candidates[0].evidence[0].value, unit: 'count' }],
  why_now: 'The backlog moved well outside its usual day-to-day range.',
  suggested_check: 'Open the panel and confirm the trend.',
  dashboard_ref: {
    dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: url,
    from: `${isoDate(Date.parse(`${date}T06:00:00Z`) - DAY_MS)}T06:00:00Z`, to: `${date}T06:00:00Z`,
  },
  confidence: 0.8,
  persisting_days: 1,
  pattern_card: null,
  candidate_ids: candidates.map((c) => c.candidate_id),
  reference_urls: [],
  rank: null,
  placement: null,
  pass_history: [],
});

const passRecord = (n, items, slug, changedIds = []) => ({
  pass: n,
  session_id: 'sess-history',
  items,
  not_selected: [],
  changes: changedIds.map(() => ({ pass: n, change: 'changed', reason: 'tightened the wording' })),
  converged: n === 2 && !changedIds.length,
  gate: { subject: 'pass', subject_ref: `${slug}/pass${n}`, attempt: 1, checks: [], outcome: 'accepted' },
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
  cost_usd: 0.01,
  num_turns: 2,
  duration_ms: 100,
  tool_calls_path: `${slug}/tool-calls.jsonl`,
});

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.host]
 * @param {number} [options.days] number of consecutive daily runs ending on endDate
 * @param {string} [options.endDate]
 * @param {string} [options.metric]
 * @returns {Promise<{ host, url, slug, metric, dates: string[], plans, expected }>}
 */
const buildCalibrationHistory = async ({
  dataDir, host = 'alpha.example.org', days = 30, endDate = '2026-09-18', metric = 'cht_sentinel_backlog_count',
}) => {
  await ensureDataLayout(dataDir);
  const url = `https://${host}`;
  const slug = projectSlug(host);
  const project = makeProject(host);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) => isoDate(endMs - (days - 1 - i) * DAY_MS));
  const plans = [];
  for (let i = 0; i < days; i += 1) {
    const date = dates[i];
    const plan = dayPlan(i);
    const outcomeDate = isoDate(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
    plans.push({ ...plan, date, outcomeDate });
    const runDir = await RunDir.create(dataDir, date);
    const discovery = makeDiscovery({ run_start: `${date}T06:00:00Z`, projects: [project] });
    await runDir.writeJson('discovery.json', discovery);
    const dev = plan.pct * PATTERN.deviationPerPct;
    await runDir.writeJson(`${slug}/changes.json`, [changeFor({ url, metric, pct: plan.pct, dev })]);
    const candidates = [];
    if (plan.pct >= PATTERN.currentThreshold) {
      candidates.push(candidateFor({
        url, metric, date, rule: 'pct_change', observed: plan.pct, threshold: PATTERN.currentThreshold,
      }));
    }
    if (dev >= PATTERN.deviationThreshold) {
      candidates.push(candidateFor({
        url, metric, date, rule: 'deviation', observed: dev, threshold: PATTERN.deviationThreshold,
      }));
    }
    await runDir.writeJson(`${slug}/candidates.json`, candidates);
    await runDir.writeJson(`${slug}/suppressed.json`, []);
    let items = [];
    if (plan.kind !== 'quiet') {
      const item = itemFor({ url, metric, candidates, date });
      items = [item];
      const first = passRecord(1, items, slug);
      const second = passRecord(2, items, slug, plan.changedPass ? [item.item_id] : []);
      await runDir.writeJson(`${slug}/findings.pass1.json`, first);
      await runDir.writeJson(`${slug}/findings.pass2.json`, second);
      await runDir.writeJson(`${slug}/passes.json`, {
        passes: [first, second],
        diffs: [{ from: 1, to: 2, added: [], removed: [], changed: plan.changedPass ? [item.item_id] : [] }],
        converged: !plan.changedPass,
        bounds_hit: [],
        reference_sources_unavailable: false,
      });
      await runDir.writeJson('rollup/items.ranked.json', items.map((it, index) => ({
        ...it, rank: index + 1, placement: 'body',
      })));
      if (plan.outcome) {
        await atomic.appendJsonl(path.join(dataPaths(dataDir).corpusOutcomes, `${outcomeDate}.jsonl`), {
          date: outcomeDate,
          run_id: outcomeDate,
          item_id: item.item_id,
          project_url: url,
          metric,
          pattern_card: null,
          outcome: plan.outcome,
          up: plan.outcome === 'confirmed' ? 1 : 0,
          down: plan.outcome === 'dismissed' ? 1 : 0,
          notes: [],
        });
      }
    } else {
      await runDir.writeJson('rollup/items.ranked.json', []);
    }
    await runDir.updateRun({
      run_id: date, date, mode: 'scheduled', status: items.length ? 'published' : 'heartbeat',
      started_at: `${date}T06:00:00Z`, finished_at: `${date}T06:10:00Z`, duration_ms: 600000,
      versions: {
        package: '0.0.0-development', git_sha: 'hist', prompts_hash: null, skill_hash: null, schema_hash: null,
        config_hash: null,
      },
      config_effective_path: 'config.effective.json', stages: [], projects: [url], usage: null, cost_usd: 0.02,
      publications: [], trace_id: null, trace_url: null, supersedes: null, superseded_by: null, bounds_hit: [],
    });
  }
  return { host, url, slug, metric, dates, plans, expected: expectedFor(days) };
};

/** Recursive SHA-independent listing helper for guard tests: every file with its size and mtime. */
const snapshot = (dir) => {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(next);
      } else {
        const stat = fs.statSync(path.join(dir, next));
        out.push(`${next}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  visit('');
  return out.sort();
};

module.exports = { buildCalibrationHistory, dayPlan, expectedFor, PATTERN, PANEL_REF, snapshot };

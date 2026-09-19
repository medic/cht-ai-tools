const path = require('node:path');
const { computeCandidates, suppressByHorizon } = require('../../src/analyze/candidates');
const { effectiveThresholds } = require('../../src/analyze/thresholds');
const { loadPolicy } = require('../../src/config/policy');
const { schemas } = require('../../src/model/schemas');
const identity = require('../../src/model/identity');
const { tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const DATE = '2026-09-18';
const project = { url: 'https://alpha.example.org', host: 'alpha.example.org' };
const panelRef = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };

const change = (metric, overrides) => ({
  project_url: project.url,
  metric,
  panel_ref: panelRef,
  current_value: 10,
  previous_day_value: 10,
  previous_week_value: null,
  previous_cycle_value: null,
  pct_change_vs_previous_day: 0,
  trailing_mean: 10,
  trailing_stddev: 1,
  deviation_sigma: 0,
  monotonic_rise_hours: 0,
  baseline: 'previous_day',
  expected_load_window_id: null,
  ...overrides,
});

const unitOf = () => 'count';

describe('analyze/candidates', () => {
  let policy;
  let thresholds;
  before(() => {
    const dir = tempDir();
    policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    removeDir(dir);
    thresholds = effectiveThresholds(policy.thresholds, null);
  });

  it('raises pct, deviation and monotonic candidates with a high floor for a sentinel backlog over 3x baseline', () => {
    const changes = [change('cht_sentinel_backlog_count', {
      current_value: 912,
      previous_day_value: 300,
      pct_change_vs_previous_day: 204,
      trailing_mean: 300,
      trailing_stddev: 5,
      deviation_sigma: 122.4, monotonic_rise_hours: 7,
    })];
    const candidates = computeCandidates({ changes, project, thresholds, policy, date: DATE, unitOf });
    expect(candidates.map((c) => c.rule).sort()).to.deep.equal(['deviation', 'monotonic', 'pct_change']);
    expect(candidates.every((c) => c.severity_floor === 'high')).to.equal(true);
    const pct = candidates.find((c) => c.rule === 'pct_change');
    const expectedId = identity.candidateId(project.url, 'cht_sentinel_backlog_count', 'pct_change', DATE);
    expect(pct.candidate_id).to.equal(expectedId);
    expect(pct.threshold).to.deep.equal({ source: 'default', value: 50 });
    expect(pct.observed).to.equal(204);
    expect(pct.evidence.map((e) => e.window)).to.deep.equal(['current', 'previous_day']);
    expect(pct.evidence[0]).to.include({ value: 912, unit: 'count' });
    const deviation = candidates.find((c) => c.rule === 'deviation');
    expect(deviation.threshold.value).to.equal(2.5);
    expect(deviation.evidence.map((e) => e.window)).to.include('trailing_14d');
    const monotonic = candidates.find((c) => c.rule === 'monotonic');
    expect(monotonic.threshold.value).to.equal(6);
    expect(monotonic.observed).to.equal(7);
    for (const candidate of candidates) {
      expect(() => schemas.Candidate.parse(candidate)).to.not.throw();
    }
  });

  it('raises target_down with a high floor when the scrape target metric is zero', () => {
    const changes = [
      change('up{job="cht"}', { current_value: 0, previous_day_value: 1, pct_change_vs_previous_day: -100 }),
    ];
    const candidates = computeCandidates({ changes, project, thresholds, policy, date: DATE, unitOf });
    const down = candidates.find((c) => c.rule === 'target_down');
    expect(down).to.exist;
    expect(down.severity_floor).to.equal('high');
    expect(down.threshold.value).to.equal(0);
    expect(down.observed).to.equal(0);
  });

  it('raises backlog_absolute with a high floor for any outbound push backlog', () => {
    const changes = [
      change('cht_outbound_push_backlog_count', {
        current_value: 3, previous_day_value: 0, pct_change_vs_previous_day: null,
      }),
    ];
    const candidates = computeCandidates({ changes, project, thresholds, policy, date: DATE, unitOf });
    expect(candidates.map((c) => c.rule)).to.deep.equal(['backlog_absolute']);
    expect(candidates[0].severity_floor).to.equal('high');
  });

  it('gives medium to a metric with two rules and low to a metric with one', () => {
    const two = change('cht_conflict_count', { pct_change_vs_previous_day: 60, monotonic_rise_hours: 8 });
    const one = change('cht_replication_limit_count', { pct_change_vs_previous_day: -55 });
    const candidates = computeCandidates({ changes: [two, one], project, thresholds, policy, date: DATE, unitOf });
    const conflicts = candidates.filter((c) => c.metric === 'cht_conflict_count');
    expect(conflicts.map((c) => c.severity_floor)).to.deep.equal(['medium', 'medium']);
    expect(candidates.find((c) => c.metric === 'cht_replication_limit_count').severity_floor).to.equal('low');
  });

  it('raises nothing below the thresholds or on null measures', () => {
    const changes = [
      change('cht_conflict_count', {
        pct_change_vs_previous_day: 49.9, deviation_sigma: 2.4, monotonic_rise_hours: 5.9,
      }),
      change('cht_feedback_total', { pct_change_vs_previous_day: null, deviation_sigma: null, current_value: null }),
      change('cht_outbound_push_backlog_count', { current_value: 0 }),
      change('up{job="cht"}', { current_value: 1 }),
    ];
    expect(computeCandidates({ changes, project, thresholds, policy, date: DATE, unitOf })).to.deep.equal([]);
  });

  it('honours a per-project threshold and records its source', () => {
    const projectThresholds = effectiveThresholds(policy.thresholds, { pct_change_vs_previous_day: 80 });
    const changes = [change('cht_conflict_count', { pct_change_vs_previous_day: 60 })];
    const below = computeCandidates({ changes, project, thresholds: projectThresholds, policy, date: DATE, unitOf });
    expect(below).to.deep.equal([]);
    const fired = computeCandidates({
      changes: [change('cht_conflict_count', { pct_change_vs_previous_day: 90 })],
      project, thresholds: projectThresholds, policy, date: DATE, unitOf,
    });
    expect(fired[0].threshold).to.deep.equal({ source: 'project', value: 80 });
  });

  it('exposes the horizon suppression hook as a pass-through until feedback exists', () => {
    const candidates = [{ candidate_id: 'a' }];
    expect(suppressByHorizon(candidates, [])).to.equal(candidates);
  });
});

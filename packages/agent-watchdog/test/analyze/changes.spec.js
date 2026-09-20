const { computeChanges } = require('../../src/analyze/changes');
const { schemas } = require('../../src/model/schemas');

const RUN_START = 1789711200;
const panelRef = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };
const project = { url: 'https://alpha.example.org', host: 'alpha.example.org' };

const window = (name, values, extra = {}) => ({
  project_url: project.url,
  metric: 'cht_sentinel_backlog_count',
  panel_ref: panelRef,
  window: name,
  start: '2026-09-17T06:00:00Z',
  end: '2026-09-18T06:00:00Z',
  step_s: name === 'trailing_14d' ? 86400 : 300,
  unit: 'count',
  values,
  available: true,
  unavailable_reason: null,
  ...extra,
});

const rising = Array.from({ length: 85 }, (_, i) => [RUN_START - (84 - i) * 300, 300 + i * 7.2]);
const trailingDaily = Array.from({ length: 21 }, (_, i) => [
  RUN_START - (20 - i) * 86400,
  i === 20 ? 912 : 300 + (i % 3) * 3,
]);

describe('analyze/changes', () => {
  it('computes values, percentage change, trailing statistics excluding the current day, deviation and rise', () => {
    const windows = [
      window('current', rising),
      window('previous_day', [[RUN_START - 86400, 300]]),
      window('previous_week', [[RUN_START - 7 * 86400, 280]]),
      window('trailing_14d', trailingDaily),
    ];
    const [change] = computeChanges({ windows, project, activeWindow: null });
    expect(change.current_value).to.be.closeTo(904.8, 1e-9);
    expect(change.previous_day_value).to.equal(300);
    expect(change.previous_week_value).to.equal(280);
    expect(change.previous_cycle_value).to.equal(null);
    expect(change.pct_change_vs_previous_day).to.be.closeTo(201.6, 1e-9);
    expect(change.baseline).to.equal('previous_day');
    const expectedMean = trailingDaily.slice(0, 20).reduce((a, [, v]) => a + v, 0) / 20;
    expect(change.trailing_mean).to.be.closeTo(expectedMean, 1e-9);
    expect(change.trailing_stddev).to.be.greaterThan(0);
    expect(change.deviation_sigma).to.be.greaterThan(50);
    expect(change.monotonic_rise_hours).to.equal(7);
    expect(change.expected_load_window_id).to.equal(null);
    expect(() => schemas.ComputedChange.parse(change)).to.not.throw();
  });

  it('uses the previous cycle as the baseline when an expected-load window is active and available', () => {
    const windows = [
      window('current', [[RUN_START, 600]]),
      window('previous_day', [[RUN_START - 86400, 300]]),
      window('previous_cycle', [[RUN_START - 30 * 86400, 550]]),
    ];
    const [change] = computeChanges({ windows, project, activeWindow: { id: 'month-end', cycle_days: 30 } });
    expect(change.baseline).to.equal('previous_cycle');
    expect(change.previous_cycle_value).to.equal(550);
    expect(change.pct_change_vs_previous_day).to.be.closeTo((600 - 550) / 550 * 100, 1e-9);
    expect(change.expected_load_window_id).to.equal('month-end');
  });

  it('falls back to the previous day when the previous cycle is unavailable', () => {
    const windows = [
      window('current', [[RUN_START, 600]]),
      window('previous_day', [[RUN_START - 86400, 300]]),
      window('previous_cycle', [], { available: false, unavailable_reason: 'no data' }),
    ];
    const [change] = computeChanges({ windows, project, activeWindow: { id: 'month-end', cycle_days: 30 } });
    expect(change.baseline).to.equal('previous_day');
    expect(change.pct_change_vs_previous_day).to.equal(100);
  });

  it('returns nulls for unavailable or zero baselines and a zero rise when the last step fell', () => {
    const windows = [
      window('current', [[RUN_START - 300, 5], [RUN_START, 4]]),
      window('previous_day', [[RUN_START - 86400, 0]]),
      window('trailing_14d', [], { available: false, unavailable_reason: 'insufficient history: 5 days' }),
    ];
    const [change] = computeChanges({ windows, project, activeWindow: null });
    expect(change.pct_change_vs_previous_day).to.equal(null);
    expect(change.trailing_mean).to.equal(null);
    expect(change.deviation_sigma).to.equal(null);
    expect(change.monotonic_rise_hours).to.equal(0);
  });

  it('emits a change with null values for a metric whose current window is unavailable', () => {
    const windows = [window('current', [], { available: false, unavailable_reason: 'no data' })];
    const [change] = computeChanges({ windows, project, activeWindow: null });
    expect(change.current_value).to.equal(null);
    expect(change.monotonic_rise_hours).to.equal(0);
    expect(() => schemas.ComputedChange.parse(change)).to.not.throw();
  });

  describe('metric kinds (FR-076)', () => {
    const KINDS = {
      counter: ['cht_couchdb_doc_total'], uptime: ['cht_date_uptime_seconds'], clock: ['cht_date_current_millis'],
    };
    const counterWindow = (name, start, perStep, extra = {}) => window(name, Array.from({ length: 5 }, (_, i) => [
      RUN_START - (4 - i) * 300, start + i * perStep,
    ]), { metric: 'cht_couchdb_doc_total{db="medic"}', ...extra });

    it('analyses a counter as the increase over each window and its trailing daily increases', () => {
      const trailing = window('trailing_14d', Array.from({ length: 21 }, (_, i) => [
        RUN_START - (20 - i) * 86400, 100000 + i * 1000 + (i === 20 ? 4000 : 0),
      ]), { metric: 'cht_couchdb_doc_total{db="medic"}' });
      const [change] = computeChanges({
        windows: [counterWindow('current', 120000, 50), counterWindow('previous_day', 115000, 25), trailing],
        project, kinds: KINDS,
      });
      expect(change).to.include({
        kind: 'counter', aggregate: 'increase', current_value: 200, previous_day_value: 100,
      });
      expect(change.pct_change_vs_previous_day).to.equal(100);
      expect(change.monotonic_rise_hours).to.equal(0);
      // Daily increases of the trailing maxima, excluding today: nineteen days of exactly 1000.
      expect(change.trailing_mean).to.equal(1000);
      expect(change.trailing_stddev).to.equal(0);
      expect(change.deviation_sigma).to.equal(null);
      expect(change.restarts_24h).to.equal(null);
    });

    it('counts a counter reset as an increase from zero', () => {
      const values = [[RUN_START - 1200, 500], [RUN_START - 900, 520], [RUN_START - 600, 10], [RUN_START - 300, 30]];
      const [change] = computeChanges({
        windows: [window('current', values, { metric: 'cht_couchdb_doc_total' })], project, kinds: KINDS,
      });
      // +20, then a reset to 10 counted as +10, then +20.
      expect(change.current_value).to.equal(50);
    });

    it('analyses an uptime as restarts and a clock as excluded, with no level rules for either', () => {
      const uptime = window('current', [
        [RUN_START - 1200, 100000], [RUN_START - 900, 100300], [RUN_START - 600, 50], [RUN_START - 300, 350],
      ], { metric: 'cht_date_uptime_seconds' });
      const clock = window('current', [[RUN_START - 300, 1.7e12], [RUN_START, 1.7e12 + 300000]], {
        metric: 'cht_date_current_millis',
      });
      const changes = computeChanges({ windows: [uptime, clock], project, kinds: KINDS });
      const byMetric = Object.fromEntries(changes.map((c) => [c.metric, c]));
      expect(byMetric.cht_date_uptime_seconds).to.include({
        kind: 'uptime', aggregate: 'restarts', restarts_24h: 1, current_value: 350, pct_change_vs_previous_day: null,
        deviation_sigma: null, monotonic_rise_hours: 0,
      });
      expect(byMetric.cht_date_current_millis).to.include({ kind: 'clock', aggregate: 'excluded', restarts_24h: null });
    });

    it('keeps gauges as levels, and treats a derived expression as a gauge even when it names a counter', () => {
      const derived = window('current', [[RUN_START - 300, 40], [RUN_START, 42]], {
        metric: 'increase(cht_couchdb_doc_total[1d])',
      });
      const changes = computeChanges({ windows: [window('current', rising), derived], project, kinds: KINDS });
      expect(changes.every((c) => c.kind === 'gauge' && c.aggregate === 'level')).to.equal(true);
    });
  });

  it('handles several metrics independently', () => {
    const windows = [
      window('current', [[RUN_START, 1]]),
      { ...window('current', [[RUN_START, 0]]), metric: 'up{job="cht"}' },
    ];
    const changes = computeChanges({ windows, project, activeWindow: null });
    expect(changes.map((c) => c.metric)).to.deep.equal(['cht_sentinel_backlog_count', 'up{job="cht"}']);
  });
});

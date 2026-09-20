const path = require('node:path');
const { buildCalibrationReport, collectObservations, reportWindow } = require('../../src/calibration/report');
const { percentile } = require('../../src/calibration/suggest');
const { loadPolicy } = require('../../src/config/policy');
const { schemas } = require('../../src/model/schemas');
const { buildCalibrationHistory, PATTERN } = require('../helpers/calibration-runs');
const { tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const NOW = new Date('2026-09-18T12:00:00Z');
const WEEK = '2026-W38';
const configFor = (dataDir) => ({
  storage: { dataDir, configDir: DEFAULTS_DIR },
  model: { name: 'claude-fable-5-1', calibration: 'claude-fable-5-1', effort: 'max' },
  bounds: { maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000 },
});
const policyWithOverride = (policy, host, thresholds) => ({
  ...policy,
  projects: { ...policy.projects, projects: { ...policy.projects.projects, [host]: { thresholds } } },
});

describe('calibration/report', function () {
  this.timeout(30000);

  describe('reportWindow', () => {
    it('covers the thirty days ending on the week\'s last day, or today when that is earlier', () => {
      expect(reportWindow({ week: WEEK, now: NOW })).to.deep.equal({ from: '2026-08-20', to: '2026-09-18' });
      expect(reportWindow({ week: '2026-W37', now: NOW })).to.deep.equal({ from: '2026-08-15', to: '2026-09-13' });
      const short = reportWindow({ week: WEEK, now: NOW, windowDays: 7 });
      expect(short).to.deep.equal({ from: '2026-09-12', to: '2026-09-18' });
    });
  });

  describe('over thirty days of stored runs', () => {
    let dataDir;
    let history;
    let policy;
    let report;
    before(async () => {
      dataDir = tempDir();
      history = await buildCalibrationHistory({ dataDir, days: 30 });
      policy = loadPolicy({ configDir: DEFAULTS_DIR, defaultsDir: DEFAULTS_DIR });
      report = await buildCalibrationReport({ dataDir, week: WEEK, policy, config: configFor(dataDir), now: NOW });
    });
    after(() => removeDir(dataDir));

    it('has one entry per project and metric with percentiles of daily change and deviation', () => {
      expect(report.entries).to.have.length(1);
      const [entry] = report.entries;
      expect(entry.project_url).to.equal(history.url);
      expect(entry.metric).to.equal(history.metric);
      const { pctValues, devValues } = history.expected;
      expect(entry.distribution.days).to.equal(30);
      expect(entry.distribution.pct_p50).to.equal(percentile(pctValues, 50));
      expect(entry.distribution.pct_p90).to.equal(percentile(pctValues, 90));
      expect(entry.distribution.pct_p95).to.equal(percentile(pctValues, 95));
      expect(entry.distribution.pct_max).to.equal(Math.max(...pctValues));
      expect(entry.distribution.dev_p50).to.be.closeTo(percentile(devValues, 50), 1e-9);
      expect(entry.distribution.dev_p95).to.be.closeTo(percentile(devValues, 95), 1e-9);
      expect(entry.distribution.dev_max).to.be.closeTo(Math.max(...devValues), 1e-9);
      for (const value of Object.values(entry.distribution)) {
        expect(value).to.be.a('number');
      }
    });

    it('counts confirmed, dismissed and unreviewed items from the corpus outcomes', () => {
      const { confirmed, dismissed, unreviewed } = history.expected;
      expect(report.entries[0].outcomes).to.deep.equal({ confirmed, dismissed, unreviewed });
    });

    it('takes the current threshold from the policy and suggests the value that keeps every confirmed item', () => {
      const [entry] = report.entries;
      expect(entry.current_threshold).to.equal(PATTERN.currentThreshold);
      expect(entry.suggested_threshold).to.equal(PATTERN.expectedSuggestion);
      const { expected } = history;
      expect(entry.effect_last_30d).to.deep.equal({
        items_kept: expected.itemsKeptAt(PATTERN.expectedSuggestion),
        items_dropped: expected.sessions - expected.itemsKeptAt(PATTERN.expectedSuggestion),
        confirmed_kept: expected.confirmed,
      });
      expect(entry.effect_last_30d.confirmed_kept).to.equal(expected.confirmed);
    });

    it('honours a project threshold override and withholds a suggestion within tolerance', async () => {
      const overridden = policyWithOverride(policy, history.host, { pct_change_vs_previous_day: 80 });
      const again = await buildCalibrationReport({
        dataDir, week: WEEK, policy: overridden, config: configFor(dataDir), now: NOW,
      });
      const [entry] = again.entries;
      expect(entry.current_threshold).to.equal(80);
      expect(entry.suggested_threshold).to.equal(null);
      expect(entry.effect_last_30d).to.deep.equal({
        items_kept: history.expected.itemsKeptAt(80),
        items_dropped: history.expected.sessions - history.expected.itemsKeptAt(80),
        confirmed_kept: history.expected.confirmed,
      });
    });

    it('reports the share of sessions where a later pass changed the outcome', () => {
      const { changedSessions, sessions } = history.expected;
      expect(report.pass_change_rate).to.be.closeTo(changedSessions / sessions, 1e-9);
    });

    it('names the week, carries no proposals yet and validates against the entity schema', () => {
      expect(report.week).to.equal(WEEK);
      expect(report.proposals).to.deep.equal([]);
      expect(() => schemas.CalibrationReport.parse(report)).to.not.throw();
    });

    it('filters projects by host or url', async () => {
      const none = await buildCalibrationReport({
        dataDir, week: WEEK, policy, config: configFor(dataDir), now: NOW, projects: ['beta.example.org'],
      });
      expect(none.entries).to.deep.equal([]);
      expect(none.pass_change_rate).to.equal(0);
      const some = await buildCalibrationReport({
        dataDir, week: WEEK, policy, config: configFor(dataDir), now: NOW, projects: ['https://alpha.example.org/'],
      });
      expect(some.entries).to.have.length(1);
    });

    it('collects per-run observations, forced runs included, and skips runs without discovery', async () => {
      const observations = await collectObservations({ dataDir, from: '2026-08-20', to: '2026-09-18' });
      expect(observations.runs).to.have.length(30);
      const [series] = [...observations.series.values()];
      expect(series.pct).to.have.length(30);
      expect(series.items).to.have.length(history.expected.sessions);
      expect(series.candidates.filter((c) => c.rule === 'pct_change')).to.have.length(history.expected.sessions);
      const narrow = await collectObservations({ dataDir, from: '2026-09-18', to: '2026-09-18' });
      expect(narrow.runs).to.have.length(1);
    });
  });

  describe('feedback rate over sixty days', () => {
    let dataDir;
    let history;
    let report;
    before(async () => {
      dataDir = tempDir();
      history = await buildCalibrationHistory({ dataDir, days: 60 });
      const policy = loadPolicy({ configDir: DEFAULTS_DIR, defaultsDir: DEFAULTS_DIR });
      report = await buildCalibrationReport({ dataDir, week: WEEK, policy, config: configFor(dataDir), now: NOW });
    });
    after(() => removeDir(dataDir));

    it('keeps the distribution to the thirty-day window but measures feedback over sixty days by month', () => {
      expect(report.entries[0].distribution.days).to.equal(30);
      // Records are dated the day after the posting; the window ends on 2026-09-18, so the last day's is outside.
      const reviewed = history.plans.filter((p) => p.outcome && p.outcomeDate <= '2026-09-18');
      const down = reviewed.filter((p) => p.outcome === 'dismissed');
      expect(report.feedback_rate.window_days).to.equal(60);
      expect(report.feedback_rate.overall).to.be.closeTo(down.length / reviewed.length, 1e-9);
      const months = [...new Set(reviewed.map((p) => p.outcomeDate.slice(0, 7)))].sort();
      expect(report.feedback_rate.by_month.map((m) => m.month)).to.deep.equal(months);
      for (const month of report.feedback_rate.by_month) {
        const inMonth = reviewed.filter((p) => p.outcomeDate.startsWith(month.month));
        expect(month.items).to.equal(inMonth.length);
        const downInMonth = inMonth.filter((p) => p.outcome === 'dismissed').length;
        expect(month.rate).to.be.closeTo(downInMonth / inMonth.length, 1e-9);
      }
      expect(() => schemas.CalibrationReport.parse(report)).to.not.throw();
    });
  });

  describe('with no stored runs', () => {
    it('produces an empty report with a null feedback rate', async () => {
      const dataDir = tempDir();
      try {
        const policy = loadPolicy({ configDir: DEFAULTS_DIR, defaultsDir: DEFAULTS_DIR });
        const empty = await buildCalibrationReport({
          dataDir, week: WEEK, policy, config: configFor(dataDir), now: NOW,
        });
        expect(empty.entries).to.deep.equal([]);
        expect(empty.pass_change_rate).to.equal(0);
        expect(empty.feedback_rate).to.deep.equal({ window_days: 60, overall: null, by_month: [] });
      } finally {
        removeDir(dataDir);
      }
    });
  });
});

describe('calibration/report: open proposals (FR-063)', () => {
  const { openProposalsFor } = require('../../src/calibration/report');
  const { writeProposals } = require('../../src/rollup/proposals');
  const { ensureDataLayout } = require('../../src/store/run-dir');
  const { tempDir, removeDir } = require('../helpers/fixtures');
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
  });
  afterEach(() => removeDir(dataDir));

  it('lists every proposal still awaiting review with its age in days, oldest first', async () => {
    await writeProposals({
      dataDir, runId: '2026-09-01', date: '2026-09-01', now: () => new Date('2026-09-01T06:30:00Z'),
      proposals: [{ type: 'skill', title: 'Older lesson', body: 'pattern-level' }],
    });
    await writeProposals({
      dataDir, runId: '2026-09-15', date: '2026-09-15', now: () => new Date('2026-09-15T06:30:00Z'),
      proposals: [{ type: 'threshold', title: 'Newer suggestion', body: 'pattern-level' }],
    });
    // A later proposal with the same type and slug supersedes the older one, which then no longer counts as open.
    await writeProposals({
      dataDir, runId: '2026-09-18', date: '2026-09-18', now: () => new Date('2026-09-18T06:30:00Z'),
      proposals: [{ type: 'skill', title: 'Older lesson', body: 'pattern-level, revised' }],
    });
    const open = await openProposalsFor(dataDir, new Date('2026-09-19T00:00:00Z'));
    expect(open).to.deep.equal([
      { proposal_id: '2026-09-15-threshold-newer-suggestion', type: 'threshold', age_days: 3 },
      { proposal_id: '2026-09-18-skill-older-lesson', type: 'skill', age_days: 0 },
    ]);
    expect(await openProposalsFor(tempDir(), new Date())).to.deep.equal([]);
  });
});

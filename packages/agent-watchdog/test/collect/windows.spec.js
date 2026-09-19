const path = require('node:path');
const { windowBounds, collectWindows, withInstance, trailingQuery } = require('../../src/collect/windows');
const { discover } = require('../../src/collect/discovery');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { loadPolicy } = require('../../src/config/policy');
const { schemas } = require('../../src/model/schemas');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const RUN_START = new Date('2026-09-18T06:00:00Z');
const DAY = 86400;
const quiet = createLogger({ level: 'error', stream: { write() {} } });
const seconds = (date) => Math.floor(date.getTime() / 1000);

describe('collect/windows', () => {
  describe('windowBounds', () => {
    it('defines four windows without an active expected-load window', () => {
      const bounds = windowBounds(RUN_START);
      expect(bounds.map((b) => b.window)).to.deep.equal(['current', 'previous_day', 'previous_week', 'trailing_14d']);
      const current = bounds[0];
      expect(seconds(current.end)).to.equal(seconds(RUN_START));
      expect(seconds(current.start)).to.equal(seconds(RUN_START) - DAY);
      expect(current.step_s).to.equal(300);
      const previousDay = bounds[1];
      expect(seconds(previousDay.end)).to.equal(seconds(RUN_START) - DAY);
      expect(seconds(previousDay.start)).to.equal(seconds(RUN_START) - 2 * DAY);
      const previousWeek = bounds[2];
      expect(seconds(previousWeek.end)).to.equal(seconds(RUN_START) - 7 * DAY);
      const trailing = bounds[3];
      expect(trailing.step_s).to.equal(DAY);
      expect(trailing.daily).to.equal(true);
      expect(seconds(trailing.start)).to.equal(seconds(RUN_START) - 20 * DAY);
      expect(seconds(trailing.end)).to.equal(seconds(RUN_START));
    });

    it('adds the previous cycle when an expected-load window is active', () => {
      const bounds = windowBounds(RUN_START, { activeWindow: { id: 'month-end', cycle_days: 30 } });
      const cycle = bounds.find((b) => b.window === 'previous_cycle');
      expect(seconds(cycle.end)).to.equal(seconds(RUN_START) - 30 * DAY);
      expect(seconds(cycle.start)).to.equal(seconds(RUN_START) - 31 * DAY);
    });
  });

  describe('expression helpers', () => {
    it('rewrites the instance variable to a literal host and wraps the trailing query', () => {
      expect(withInstance('cht_x{instance=~"$cht_instance"}', 'a.org')).to.equal('cht_x{instance="a.org"}');
      expect(withInstance('cht_x{instance=~"$cht_instance", db="medic"}', 'a.org'))
        .to.equal('cht_x{instance="a.org", db="medic"}');
      expect(withInstance('couch2pg_progress_pending{target="$cht_instance"}', 'a.org'))
        .to.equal('couch2pg_progress_pending{target="a.org"}');
      expect(withInstance('up{job="cht"}', 'a.org')).to.equal('up{job="cht", instance="a.org"}');
      expect(withInstance('cht_plain', 'a.org')).to.equal('cht_plain{instance="a.org"}');
      expect(trailingQuery('cht_x{instance="a.org"}')).to.equal('max_over_time(cht_x{instance="a.org"}[1d])');
    });
  });

  describe('collectWindows against the fake watchdog', () => {
    let fake;
    let grafana;
    let discovery;
    beforeEach(async () => {
      fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
      grafana = createGrafanaClient({
        baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
      });
      const dir = tempDir();
      const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
      removeDir(dir);
      discovery = await discover({ grafana, policy, config: {}, runStart: RUN_START, logger: quiet });
      fake.calls.length = 0;
    });

    const collectFor = (project, extra = {}) => collectWindows({
      grafana, project, discovery, runStart: RUN_START, activeWindow: null, logger: quiet, ...extra,
    });

    it('collects every window for every per-project metric with numeric samples and units', async () => {
      const result = await collectFor(discovery.projects[0]);
      expect(result.project_url).to.equal('https://alpha.example.org');
      const sentinel = result.windows.filter((w) => w.metric === 'cht_sentinel_backlog_count');
      expect(sentinel.map((w) => w.window)).to.deep.equal(['current', 'previous_day', 'previous_week', 'trailing_14d']);
      const current = sentinel.find((w) => w.window === 'current');
      expect(current.values).to.have.length(289);
      expect(current.values[288]).to.deep.equal([seconds(RUN_START), 912]);
      expect(current.unit).to.equal('count');
      expect(current.available).to.equal(true);
      expect(current.panel_ref).to.include({
        dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A',
      });
      const trailing = sentinel.find((w) => w.window === 'trailing_14d');
      expect(trailing.values).to.have.length(21);
      expect(trailing.step_s).to.equal(DAY);
      const feedback = result.windows
        .find((w) => w.metric === 'increase(cht_feedback_total[1d])' && w.window === 'current');
      expect(feedback.unit).to.equal('docs/day');
      for (const window of result.windows) {
        expect(() => schemas.MetricWindow.parse(window), window.metric).to.not.throw();
      }
    });

    it('queries each metric once per window with the host substituted and the trailing wrapper', async () => {
      await collectFor(discovery.projects[0]);
      const queries = fake.calls.map((c) => new URL(c.url).searchParams.get('query')).filter(Boolean);
      expect(queries).to.include('cht_sentinel_backlog_count{instance="alpha.example.org"}');
      expect(queries).to.include('max_over_time(cht_sentinel_backlog_count{instance="alpha.example.org"}[1d])');
      expect(queries.filter((q) => q === 'cht_sentinel_backlog_count{instance="alpha.example.org"}')).to.have.length(3);
      expect(queries.some((q) => q.includes('$cht_instance'))).to.equal(false);
    });

    it('collects the scrape-target metric for the project', async () => {
      const result = await collectFor(discovery.projects[2]);
      const up = result.windows.find((w) => w.metric === 'up{job="cht"}' && w.window === 'current');
      expect(up).to.exist;
      expect(up.values.every(([, v]) => v === 0)).to.equal(true);
      expect(up.panel_ref.dashboard_uid).to.equal('targets');
    });

    it('marks a metric with no series as unavailable rather than failing', async () => {
      const result = await collectFor(discovery.projects[0]);
      const sync = result.windows.filter((w) => w.metric === 'couch2pg_progress_pending{target="$cht_instance"}');
      expect(sync).to.have.length(4);
      expect(sync.every((w) => w.available === false)).to.equal(true);
      expect(sync[0].unavailable_reason).to.equal('no data');
      expect(sync[0].values).to.deep.equal([]);
    });

    it('marks trailing history unavailable below fourteen daily points', async () => {
      const project = discovery.projects[0];
      const stub = {
        queryRange: async ({ query, start, end, step }) => {
          const points = query.startsWith('max_over_time') ? 5 : Math.floor((end - start) / step) + 1;
          return [{ metric: {}, values: Array.from({ length: points }, (_, i) => [start + i * step, 10]) }];
        },
      };
      const result = await collectFor(project, { grafana: stub });
      const trailing = result.windows.find((w) => w.window === 'trailing_14d');
      expect(trailing.available).to.equal(false);
      expect(trailing.unavailable_reason).to.equal('insufficient history: 5 days');
    });

    it('records a failed query as unavailable but lets an unavailable metrics source propagate', async () => {
      const project = discovery.projects[0];
      const flaky = { queryRange: sinon.stub().rejects(new Error('query timed out')) };
      const result = await collectFor(project, { grafana: flaky });
      expect(result.windows.every((w) => w.available === false)).to.equal(true);
      expect(result.windows[0].unavailable_reason).to.include('query timed out');
      const unreachable = new codes.ExitError(codes.UNAVAILABLE, 'metrics source unreachable');
      const down = { queryRange: sinon.stub().rejects(unreachable) };
      await expect(collectFor(project, { grafana: down })).to.be.rejectedWith(codes.ExitError);
    });

    it('adds the previous cycle window when an expected-load window is active', async () => {
      const project = discovery.projects[0];
      const activeWindow = { id: 'month-end', cycle_days: 30 };
      const result = await collectFor(project, { activeWindow });
      const cycle = result.windows
        .find((w) => w.metric === 'cht_sentinel_backlog_count' && w.window === 'previous_cycle');
      expect(cycle).to.exist;
      expect(cycle.available).to.equal(true);
    });
  });
});

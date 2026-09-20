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

    it('wraps anything but a bare selector as a subquery, since ranges apply to selectors only (R-15)', () => {
      expect(trailingQuery('cht_plain')).to.equal('max_over_time(cht_plain[1d])');
      expect(trailingQuery('sum(rate(cht_x{instance="a.org"}[5m]))'))
        .to.equal('max_over_time((sum(rate(cht_x{instance="a.org"}[5m])))[1d:5m])');
      expect(trailingQuery('cht_conflict_count{instance="a.org"} >= 0'))
        .to.equal('max_over_time((cht_conflict_count{instance="a.org"} >= 0)[1d:5m])');
      expect(trailingQuery('rate(cht_couchdb_doc_total{instance="a.org"}[1h]) * 60 * 60'))
        .to.equal('max_over_time((rate(cht_couchdb_doc_total{instance="a.org"}[1h]) * 60 * 60)[1d:5m])');
      const multiline = '(\n\tsum(\n\t\tcht_a{instance="a.org", code=~"^[45]..$"} OR on() vector(0)\n\t)'
        + ' / sum(cht_a{instance="a.org"})\n)*100';
      expect(trailingQuery(multiline)).to.equal(`max_over_time((${multiline})[1d:5m])`);
    });
  });

  describe('dashboard variables in panel expressions (FR-071)', () => {
    const alpha = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
    const panel = ({ id, expr, metric, variables, unresolved }) => ({
      panel_id: id, title: `P${id}`, ref_id: 'A', expr, metric, unit: 'count', per_project: true, variables, unresolved,
    });
    const discoveryWith = (panels, variables) => ({
      run_start: RUN_START.toISOString(),
      dashboards: [{ uid: 'd1', title: 'D', slug: 'd', url: '/d/d1/d', panels, variables, duplicate_panel_ids: [] }],
      scrape_target_metric: 'up{job="cht"}',
      projects: [alpha],
    });
    const recording = () => {
      const queries = [];
      const grafana = {
        queryRange: async ({ query }) => {
          queries.push(query);
          // Numeric samples as the client returns them: enough daily points for the trailing baseline too.
          const values = Array.from({ length: 20 }, (_, i) => [seconds(RUN_START) - i * DAY, 1]);
          return [{ metric: { instance: 'alpha.example.org' }, values }];
        },
      };
      return { grafana, queries };
    };
    const spyLogger = () => ({ debug() {}, info() {}, warn: sinon.spy(), error() {} });

    it('substitutes the dashboard interval and built-ins before querying, in every window', async () => {
      const { grafana, queries } = recording();
      const discovery = discoveryWith([
        panel({
          id: 1, metric: 'sum(rate(cht_api_http_request_duration_seconds_count[$interval]))',
          expr: 'sum(rate(cht_api_http_request_duration_seconds_count{instance=~"$cht_instance"}[$interval]))',
          variables: ['interval'], unresolved: [],
        }),
        panel({
          id: 2, metric: 'rate(cht_api_process_cpu_seconds_total[$__rate_interval])',
          expr: 'rate(cht_api_process_cpu_seconds_total{instance=~"$cht_instance"}[$__rate_interval])',
          variables: ['__rate_interval'], unresolved: [],
        }),
      ], { interval: '10m' });
      const logger = spyLogger();
      const result = await collectWindows({ grafana, project: alpha, discovery, runStart: RUN_START, logger });
      expect(queries.some((q) => q.includes('$'))).to.equal(false);
      expect(queries.filter((q) => q.includes('[10m]'))).to.have.length(4);
      const scoped = 'sum(rate(cht_api_http_request_duration_seconds_count{instance="alpha.example.org"}[10m]))';
      expect(queries).to.include(`max_over_time((${scoped})[1d:5m])`);
      expect(queries).to.include('rate(cht_api_process_cpu_seconds_total{instance="alpha.example.org"}[20m])');
      expect(result.windows.filter((w) => w.metric.startsWith('sum(rate(')).every((w) => w.available)).to.equal(true);
      expect(logger.warn.called).to.equal(false);
    });

    it('marks a metric with an unresolvable variable unavailable without querying, naming the variable', async () => {
      const { grafana, queries } = recording();
      const discovery = discoveryWith([
        panel({
          id: 1, metric: 'cht_couchdb_doc_total{db="$db_name"}',
          expr: 'cht_couchdb_doc_total{instance=~"$cht_instance", db="$db_name"}',
          variables: ['db_name'], unresolved: ['db_name'],
        }),
        panel({
          id: 2, metric: 'cht_conflict_count',
          expr: 'cht_conflict_count{instance=~"$cht_instance"}',
          variables: [], unresolved: [],
        }),
      ], { db_name: null });
      const logger = spyLogger();
      const result = await collectWindows({ grafana, project: alpha, discovery, runStart: RUN_START, logger });
      const blocked = result.windows.filter((w) => w.metric === 'cht_couchdb_doc_total{db="$db_name"}');
      expect(blocked).to.have.length(4);
      expect(blocked.every((w) => w.available === false && w.unavailable_reason === 'unresolved variable $db_name'))
        .to.equal(true);
      expect(queries.some((q) => q.includes('cht_couchdb_doc_total'))).to.equal(false);
      expect(queries.filter((q) => q.includes('cht_conflict_count'))).to.have.length(4);
      expect(logger.warn.calledOnce).to.equal(true);
      expect(logger.warn.firstCall.args[0]).to.equal('collect.unresolved_variable');
      expect(logger.warn.firstCall.args[1])
        .to.include({ project: 'alpha.example.org', dashboard_uid: 'd1', panel_id: 1 });
      expect(logger.warn.firstCall.args[1].variables).to.deep.equal(['db_name']);
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

    it('sends the fake, which rejects what Prometheus rejects, only queries it accepts (R-15)', async () => {
      const result = await collectFor(discovery.projects[0]);
      const failed = (w) => w.unavailable_reason && w.unavailable_reason.startsWith('query failed');
      const rejected = result.windows.filter(failed);
      expect(rejected.map((w) => `${w.metric} ${w.window}: ${w.unavailable_reason}`)).to.deep.equal([]);
      expect(result.windows.filter((w) => w.window === 'trailing_14d' && w.metric.startsWith('sum(rate('))
        .every((w) => w.available)).to.equal(true);
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

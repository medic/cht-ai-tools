const path = require('node:path');
const { createGrafanaClient, verifyDatasourceUid, HttpError } = require('../../src/collect/grafana');
const codes = require('../../src/cli/exit-codes');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath } = require('../helpers/fixtures');

const FIXTURE = fixturePath('runs', 'seeded-anomaly');
const BASE = 'https://watchdog.example.org';
const UID = 'PBFA97CFB590B2093';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

const rejectsWithCode = (promise, code) => expect(promise).to.be.rejectedWith(codes.ExitError)
  .and.eventually.have.property('code', code);

const clientWith = (fetch, extra = {}) => createGrafanaClient({
  baseUrl: BASE, token: 'glsa_test', datasourceUid: UID, timeoutMs: 1500, fetch, ...extra,
});

describe('collect/grafana', () => {
  let fake;
  beforeEach(() => {
    fake = createFakeGrafana({ fixtureDir: FIXTURE, baseUrl: BASE, token: 'glsa_test', datasourceUid: UID });
  });

  it('sends the bearer token and an abort signal with every request', async () => {
    const fetch = sinon.stub().resolves(jsonResponse([]));
    await clientWith(fetch).search();
    const [url, init] = fetch.firstCall.args;
    expect(url).to.equal(`${BASE}/api/search?type=dash-db&limit=5000`);
    expect(init.headers.Authorization).to.equal('Bearer glsa_test');
    expect(init.signal).to.be.instanceOf(AbortSignal);
  });

  it('lists dashboards, reads one by uid and reports a missing one with its status', async () => {
    const client = clientWith(fake.fetch);
    const found = await client.search();
    expect(found.map((d) => d.uid)).to.include('oa2OfL-Vk');
    const doc = await client.dashboard('oa2OfL-Vk');
    expect(doc.dashboard.uid).to.equal('oa2OfL-Vk');
    expect(doc.meta.slug).to.equal('cht-admin-overview');
    let error;
    try {
      await client.dashboard('nope');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(HttpError);
    expect(error.status).to.equal(404);
    expect(error).to.not.be.instanceOf(codes.ExitError);
  });

  it('reads annotations for a window and dashboard', async () => {
    const fetch = sinon.stub().resolves(jsonResponse([{ id: 1 }]));
    const result = await clientWith(fetch).annotations({ from: 1000, to: 2000, dashboardUid: 'oa2OfL-Vk' });
    expect(result).to.deep.equal([{ id: 1 }]);
    const url = new URL(fetch.firstCall.args[0]);
    expect(url.pathname).to.equal('/api/annotations');
    expect(url.searchParams.get('from')).to.equal('1000');
    expect(url.searchParams.get('to')).to.equal('2000');
    expect(url.searchParams.get('dashboardUID')).to.equal('oa2OfL-Vk');
  });

  it('reads scrape targets through the datasource proxy', async () => {
    const client = clientWith(fake.fetch);
    const targets = await client.targets();
    expect(fake.calls[0].url).to.equal(`${BASE}/api/datasources/proxy/uid/${UID}/api/v1/targets?state=active`);
    expect(targets.map((t) => `${t.labels.instance}:${t.health}`)).to.deep.equal([
      'alpha.example.org:up', 'beta.example.org:up', 'gamma.example.org:down',
    ]);
  });

  it('runs a range query with unix-second bounds and returns numeric samples', async () => {
    const client = clientWith(fake.fetch);
    const end = fake.runStart;
    const result = await client.queryRange({
      query: 'cht_sentinel_backlog_count{instance="alpha.example.org"}', start: end - 86400, end, step: 300,
    });
    const url = new URL(fake.calls[0].url);
    expect(url.pathname).to.equal(`/api/datasources/proxy/uid/${UID}/api/v1/query_range`);
    expect(url.searchParams.get('step')).to.equal('300');
    expect(url.searchParams.get('start')).to.equal(String(end - 86400));
    expect(result).to.have.length(1);
    expect(result[0].metric.instance).to.equal('alpha.example.org');
    expect(result[0].values).to.have.length(289);
    const [ts, value] = result[0].values[result[0].values.length - 1];
    expect(ts).to.equal(end);
    expect(value).to.be.a('number');
    expect(value).to.equal(912);
  });

  it('runs an instant query and returns a vector with numeric values', async () => {
    const client = clientWith(fake.fetch);
    const result = await client.queryInstant({ query: 'up{job="cht"}', time: fake.runStart });
    expect(result.map((r) => r.metric.instance))
      .to.deep.equal(['alpha.example.org', 'beta.example.org', 'gamma.example.org']);
    expect(result[2].value[1]).to.equal(0);
  });

  it('classifies connection failures and timeouts as unavailable (exit 69)', async () => {
    const down = clientWith(sinon.stub().rejects(new TypeError('fetch failed')));
    await rejectsWithCode(down.targets(), codes.UNAVAILABLE);
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const slow = clientWith(sinon.stub().rejects(timeout));
    await rejectsWithCode(slow.search(), codes.UNAVAILABLE);
  });

  it('classifies 401 and 403 as configuration errors (exit 78) and other statuses as HttpError', async () => {
    const unauthorised = clientWith(sinon.stub().resolves(jsonResponse({ message: 'Unauthorized' }, 401)));
    await rejectsWithCode(unauthorised.search(), codes.CONFIG);
    const forbidden = clientWith(sinon.stub().resolves(jsonResponse({ message: 'Forbidden' }, 403)));
    await rejectsWithCode(forbidden.search(), codes.CONFIG);
    const broken = clientWith(sinon.stub().resolves(jsonResponse({ message: 'boom' }, 500)));
    await expect(broken.search()).to.be.rejectedWith(HttpError).and.eventually.have.property('status', 500);
  });

  it('puts the response detail in the error message, never just the status (R-15)', async () => {
    const prometheus = clientWith(sinon.stub().resolves(jsonResponse({
      status: 'error', errorType: 'bad_data',
      error: 'invalid parameter "query": 1:14: parse error: ranges only allowed for vector selectors',
    }, 400)));
    await expect(prometheus.queryRange({ query: 'max_over_time(sum(x)[1d])', start: 0, end: 1, step: 1 }))
      .to.be.rejectedWith(/400 .*bad_data: invalid parameter "query".*ranges only allowed for vector selectors/);
    const grafana = clientWith(sinon.stub().resolves(jsonResponse({ message: 'Data source not found' }, 404)));
    await expect(grafana.search()).to.be.rejectedWith(/404 .*Data source not found/);
    const html = clientWith(sinon.stub().resolves(new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(html.search()).to.be.rejectedWith(/502 .*Bad Gateway/);
    const long = clientWith(sinon.stub().resolves(jsonResponse({ message: 'x'.repeat(1000) }, 500)));
    const error = await long.search().catch((e) => e);
    expect(error.message.length).to.be.below(400);
    expect(error.body).to.include('x'.repeat(1000));
  });

  describe('query timeouts and retries (FR-073)', () => {
    const ok = () => jsonResponse({ status: 'success', data: { resultType: 'matrix', result: [] } });
    // A fetch that honours the abort signal like the real one: it rejects with the signal's reason on timeout.
    const slow = (ms) => (url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(ok()), ms);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
    const warnings = () => {
      const logger = { debug() {}, info() {}, warn: sinon.spy(), error() {} };
      return logger;
    };
    const range = (client) => client.queryRange({ query: 'x', start: 0, end: 1, step: 1 });

    it('gives range and instant queries their own timeout and retries a timed-out query once', async () => {
      const fetch = sinon.stub();
      fetch.onCall(0).callsFake(slow(500));
      fetch.onCall(1).resolves(ok());
      const logger = warnings();
      const client = clientWith(fetch, { queryTimeoutMs: 40, retryDelayMs: 0, logger });
      expect(await range(client)).to.deep.equal([]);
      expect(fetch.callCount).to.equal(2);
      expect(logger.warn.calledOnce).to.equal(true);
      expect(logger.warn.firstCall.args[0]).to.equal('grafana.query_retry');
      expect(logger.warn.firstCall.args[1]).to.include({ attempt: 1, reason: 'timeout' });
      expect(logger.warn.firstCall.args[1].path).to.include('/api/v1/query_range');
    });

    it('turns a second timeout into a failed query, not an unreachable source', async () => {
      const client = clientWith(slow(500), { queryTimeoutMs: 40, retryDelayMs: 0, logger: warnings() });
      const error = await range(client).catch((e) => e);
      expect(error).to.be.instanceOf(HttpError);
      expect(error).to.not.be.instanceOf(codes.ExitError);
      expect(error.message).to.match(/timed out after 40 ms \(2 attempts\)/);
      expect(error.message).to.include('/api/v1/query_range');
    });

    it('declares the source unreachable after three consecutive failed queries, reset by a success', async () => {
      const fetch = sinon.stub();
      let call = 0;
      fetch.callsFake((url, init) => {
        call += 1;
        // Queries 1 to 4 (two attempts each) time out; query 3 succeeds; queries 4 to 6 time out again.
        return call === 5 ? Promise.resolve(ok()) : slow(500)(url, init);
      });
      const client = clientWith(fetch, { queryTimeoutMs: 30, retryDelayMs: 0, logger: warnings() });
      await expect(range(client)).to.be.rejectedWith(HttpError);
      await expect(range(client)).to.be.rejectedWith(HttpError);
      expect(await range(client), 'the third query succeeds on its first attempt').to.deep.equal([]);
      await expect(range(client)).to.be.rejectedWith(HttpError);
      await expect(range(client)).to.be.rejectedWith(HttpError);
      const third = await range(client).catch((e) => e);
      expect(third).to.be.instanceOf(codes.ExitError);
      expect(third.code).to.equal(codes.UNAVAILABLE);
      expect(third.message).to.match(/3 consecutive/);
    });

    it('counts a failed query of any status as consecutive; only a success resets (revision 33)', async () => {
      const statuses = [422, 500, 400];
      const fetch = sinon.stub().callsFake(async () => jsonResponse({ message: 'refused' }, statuses.shift() || 200));
      const client = clientWith(fetch, { retryDelayMs: 0, logger: warnings() });
      await expect(range(client)).to.be.rejectedWith(HttpError).and.eventually.have.property('status', 422);
      await expect(range(client)).to.be.rejectedWith(HttpError).and.eventually.have.property('status', 500);
      const third = await range(client).catch((e) => e);
      expect(third).to.be.instanceOf(codes.ExitError);
      expect(third.code).to.equal(codes.UNAVAILABLE);
      expect(third.message).to.match(/3 consecutive query failures, last status 400/);
      const mixed = [422, 200, 422, 422, 200];
      const flaky = sinon.stub().callsFake(async () => (mixed.shift() === 200
        ? ok()
        : jsonResponse({ message: 'refused' }, 422)));
      const second = clientWith(flaky, { retryDelayMs: 0, logger: warnings() });
      await expect(range(second)).to.be.rejectedWith(HttpError);
      expect(await range(second)).to.deep.equal([]);
      await expect(range(second)).to.be.rejectedWith(HttpError);
      await expect(range(second)).to.be.rejectedWith(HttpError);
      expect(await range(second), 'two failures then a success is not unreachable').to.deep.equal([]);
    });

    it('retries a 502, 503 or 504 from the proxy once and reports the status when it persists', async () => {
      const flaky = sinon.stub();
      flaky.onCall(0).resolves(jsonResponse({ message: 'Bad Gateway' }, 502));
      flaky.onCall(1).resolves(ok());
      expect(await range(clientWith(flaky, { retryDelayMs: 0, logger: warnings() }))).to.deep.equal([]);
      const down = clientWith(sinon.stub().resolves(new Response('upstream timed out', { status: 504 })), {
        retryDelayMs: 0, logger: warnings(),
      });
      const error = await range(down).catch((e) => e);
      expect(error).to.be.instanceOf(HttpError);
      expect(error.status).to.equal(504);
      expect(error).to.not.be.instanceOf(codes.ExitError);
    });

    it('keeps connection failures unreachable after one retry, and API timeouts unreachable at once', async () => {
      const connectionError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      const refused = sinon.stub().rejects(connectionError);
      const client = clientWith(refused, { retryDelayMs: 0, logger: warnings() });
      await rejectsWithCode(range(client), codes.UNAVAILABLE);
      expect(refused.callCount).to.equal(2);
      const api = clientWith(slow(500), { timeoutMs: 30, queryTimeoutMs: 5000, retryDelayMs: 0, logger: warnings() });
      const started = Date.now();
      await rejectsWithCode(api.search(), codes.UNAVAILABLE);
      expect(Date.now() - started).to.be.below(400);
    });
  });

  it('surfaces a Prometheus error envelope as an error', async () => {
    const fetch = sinon.stub().resolves(jsonResponse({ status: 'error', errorType: 'bad_data', error: 'parse error' }));
    const query = clientWith(fetch).queryRange({ query: 'x{', start: 0, end: 1, step: 1 });
    await expect(query).to.be.rejectedWith(/parse error/);
  });

  it('honours a rejected token from the real fake as a configuration error', async () => {
    const client = clientWith(fake.fetch, { token: 'wrong' });
    await rejectsWithCode(client.search(), codes.CONFIG);
  });

  describe('verifyDatasourceUid', () => {
    it('passes when the configured uid is the one the dashboards query', async () => {
      const client = clientWith(fake.fetch);
      const doc = await client.dashboard('oa2OfL-Vk');
      expect(() => verifyDatasourceUid(client, [doc])).to.not.throw();
    });

    it('fails with exit 78 when the dashboards use a different datasource', async () => {
      const client = clientWith(fake.fetch, { datasourceUid: 'other' });
      const fetch = clientWith(fake.fetch);
      const doc = await fetch.dashboard('oa2OfL-Vk');
      let error;
      try {
        verifyDatasourceUid(client, [doc]);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(codes.ExitError);
      expect(error.code).to.equal(codes.CONFIG);
      expect(error.message).to.include('PBFA97CFB590B2093');
    });
  });

  it('reads the fixture directory used by the other specs', () => {
    expect(path.basename(FIXTURE)).to.equal('seeded-anomaly');
  });
});

describe('collect/grafana: alerting endpoints (FR-064, research.md R-14)', () => {
  const alertsFake = (options = {}) => createFakeGrafana({
    fixtureDir: fixturePath('runs', 'alerts-day'), baseUrl: BASE, token: 'glsa_test', datasourceUid: UID, ...options,
  });

  it('reads the Prometheus-compatible rules endpoint page by page, following groupNextToken', async () => {
    const fake = alertsFake();
    const client = clientWith(fake.fetch);
    const data = await client.alertRules({ groupLimit: 1 });
    const calls = fake.calls.filter((c) => c.url.includes('/api/prometheus/grafana/api/v1/rules'));
    expect(calls.length).to.be.greaterThan(1);
    expect(new URL(calls[0].url).searchParams.get('group_limit')).to.equal('1');
    expect(new URL(calls[0].url).searchParams.get('group_next_token')).to.equal(null);
    expect(new URL(calls[1].url).searchParams.get('group_next_token')).to.be.a('string').and.not.equal('');
    expect(data.groups.map((g) => g.name)).to.include.members(['10m', '1m']);
    expect(data.pages).to.equal(calls.length);
    expect(data.raw).to.have.length(calls.length);
    const rule = data.groups.flatMap((g) => g.rules).find((r) => r.name === 'Sentinel Backlog');
    expect(rule).to.include({ uid: 'FzCrECYVk', type: 'alerting', state: 'firing' });
    expect(rule.alerts[0]).to.have.all.keys('labels', 'annotations', 'state', 'activeAt', 'value');
  });

  it('reads the alerts endpoint and surfaces a non-success envelope as an error', async () => {
    const fake = alertsFake();
    const client = clientWith(fake.fetch);
    const alerts = await client.alertInstances();
    expect(alerts.length).to.be.greaterThan(10);
    expect(alerts[0].labels).to.have.property('alertname');
    const broken = sinon.stub().resolves(jsonResponse({ status: 'error', errorType: 'internal', error: 'boom' }));
    await expect(clientWith(broken).alertInstances()).to.be.rejectedWith(/internal: boom/);
  });

  it('throws the usual errors on an unavailable alerting API, for the collector to catch', async () => {
    const fake = alertsFake({ alertsStatus: { rules: 403 } });
    await rejectsWithCode(clientWith(fake.fetch).alertRules(), codes.CONFIG);
    const down = alertsFake({ alertsStatus: { rules: 503 } });
    await expect(clientWith(down.fetch).alertRules()).to.be.rejectedWith(HttpError);
  });
});

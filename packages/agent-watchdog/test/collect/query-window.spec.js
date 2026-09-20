const { createQueryWindow } = require('../../src/collect/query-window');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath } = require('../helpers/fixtures');

describe('collect/query-window', () => {
  const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
  const grafana = createGrafanaClient({
    baseUrl: fake.baseUrl,
    token: fake.token,
    datasourceUid: fake.datasourceUid,
    timeoutMs: 1000,
    fetch: fake.fetch,
  });
  const runStart = new Date('2026-09-18T06:00:00Z');
  const alpha = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };

  it('returns the current window of a metric with the instance matcher added', async () => {
    const query = createQueryWindow({ grafana, runStart });
    const w = await query(alpha, 'cht_sentinel_backlog_count', 'current');
    expect(w.available).to.equal(true);
    expect(w.values.length).to.be.greaterThan(200);
    expect(w.values[w.values.length - 1][1]).to.equal(912);
    expect(w.step_s).to.equal(300);
    const last = fake.calls[fake.calls.length - 1].url;
    expect(decodeURIComponent(last)).to.include('instance="alpha.example.org"');
  });

  it('queries daily maxima for the trailing window', async () => {
    const query = createQueryWindow({ grafana, runStart });
    const w = await query(alpha, 'cht_sentinel_backlog_count', 'trailing_14d');
    expect(w.step_s).to.equal(86400);
    expect(decodeURIComponent(fake.calls[fake.calls.length - 1].url)).to.include('max_over_time(');
  });

  it('resolves dashboard variables through specFor and refuses a metric with an unresolved one (FR-071)', async () => {
    const specFor = (metric) => (metric.includes('$db_name')
      ? { variables: { db_name: null }, unresolved: ['db_name'] }
      : { variables: { interval: '10m' }, unresolved: [] });
    const query = createQueryWindow({ grafana, runStart, specFor });
    const before = fake.calls.length;
    const w = await query(alpha, 'rate(cht_sentinel_backlog_count[$interval])', 'current');
    expect(w.available).to.equal(true);
    const sent = decodeURIComponent(fake.calls[fake.calls.length - 1].url);
    expect(sent).to.include('rate(cht_sentinel_backlog_count{instance="alpha.example.org"}[10m])');
    expect(sent).to.not.include('$');
    const blocked = await query(alpha, 'cht_couchdb_doc_total{db="$db_name"}', 'current');
    expect(blocked).to.include({ available: false, unavailable_reason: 'unresolved variable $db_name' });
    expect(fake.calls.length).to.equal(before + 1);
  });

  it('reports unavailable for an unknown window or a metric with no series', async () => {
    const query = createQueryWindow({ grafana, runStart });
    expect(await query(alpha, 'cht_sentinel_backlog_count', 'last_month')).to.include({ available: false });
    const none = await query(alpha, 'couch2pg_progress_pending', 'current');
    expect(none.available).to.equal(false);
    expect(none.unavailable_reason).to.equal('no series returned');
  });
});

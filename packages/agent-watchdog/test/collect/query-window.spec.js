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

describe('collect/query-window: one series, the panel\'s unit, the active window (FR-003, FR-075, revision 34)', () => {
  const runStart = new Date('2026-09-18T06:00:00Z');
  const alpha = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
  const matrix = (result) => new Response(JSON.stringify({
    status: 'success', data: { resultType: 'matrix', result },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const clientWith = (fetch) => createGrafanaClient({
    baseUrl: 'https://watchdog.example.org', token: 'glsa_test', datasourceUid: 'PBFA97CFB590B2093',
    timeoutMs: 1000, fetch,
  });

  it('refuses a query that answers several series for the project, naming the labels that differ', async () => {
    const fetch = sinon.stub().resolves(matrix([
      { metric: { __name__: 'cht_couchdb_doc_total', instance: 'alpha.example.org', db: 'medic' }, values: [[1, '5']] },
      {
        metric: { __name__: 'cht_couchdb_doc_total', instance: 'alpha.example.org', db: 'medic-sentinel' },
        values: [[1, '7']],
      },
    ]));
    const query = createQueryWindow({ grafana: clientWith(fetch), runStart });
    const w = await query(alpha, 'cht_couchdb_doc_total', 'current');
    expect(w.available).to.equal(false);
    expect(w.values).to.deep.equal([]);
    expect(w.unavailable_reason).to.equal('2 series, not one per project (labels: db)');
  });

  it('answers a target-scoped panel whose one series carries the exporter\'s instance, like collection', async () => {
    const fetch = sinon.stub().callsFake(async () => matrix([
      {
        metric: { __name__: 'couch2pg_progress_pending', instance: 'sql-exporter:9399', target: 'alpha.example.org' },
        values: [[1, '5'], [2, '7']],
      },
    ]));
    const query = createQueryWindow({ grafana: clientWith(fetch), runStart });
    const w = await query(alpha, 'couch2pg_progress_pending', 'current');
    expect(w.available).to.equal(true);
    expect(w.values).to.deep.equal([[1, 5], [2, 7]]);
  });

  it('carries the panel\'s unit from the discovery spec and counts by default', async () => {
    const fetch = sinon.stub().callsFake(async () => matrix([
      { metric: { __name__: 'cht_couchdb_disk_bytes', instance: 'alpha.example.org' }, values: [[1, '5']] },
    ]));
    const bytes = { unit: 'bytes', variables: {}, unresolved: [] };
    const specFor = (metric) => (metric === 'cht_couchdb_disk_bytes' ? bytes : null);
    const query = createQueryWindow({ grafana: clientWith(fetch), runStart, specFor });
    expect((await query(alpha, 'cht_couchdb_disk_bytes', 'current')).unit).to.equal('bytes');
    expect((await query(alpha, 'cht_other_count', 'current')).unit).to.equal('count');
  });

  it('knows the previous-cycle window when the project has an active expected-load window', async () => {
    const fetch = sinon.stub().callsFake(async () => matrix([
      { metric: { __name__: 'cht_sentinel_backlog_count', instance: 'alpha.example.org' }, values: [[1, '5']] },
    ]));
    const without = createQueryWindow({ grafana: clientWith(fetch), runStart });
    expect(await without(alpha, 'cht_sentinel_backlog_count', 'previous_cycle'))
      .to.include({ available: false, unavailable_reason: 'unknown window "previous_cycle"' });
    const activeWindowFor = () => ({ id: 'month-end', kind: 'month_end', cycle_days: 30 });
    const withWindow = createQueryWindow({ grafana: clientWith(fetch), runStart, activeWindowFor });
    const w = await withWindow(alpha, 'cht_sentinel_backlog_count', 'previous_cycle');
    expect(w.available).to.equal(true);
    expect(w.start).to.equal('2026-08-18T06:00:00.000Z');
    expect(w.end).to.equal('2026-08-19T06:00:00.000Z');
  });
});

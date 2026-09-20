// The fake watchdog rejects what Prometheus rejects, so a query the real proxy would answer with 400 fails offline too.
const { createFakeGrafana, promqlError } = require('./fake-grafana');
const { fixturePath } = require('./fixtures');

describe('helpers/fake-grafana PromQL validation', () => {
  const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
  const start = fake.runStart - 20 * 86400;
  const rangeQuery = (query, step) => fake.fetch(
    `${fake.baseUrl}/api/datasources/proxy/uid/${fake.datasourceUid}/api/v1/query_range`
    + `?query=${encodeURIComponent(query)}&start=${start}&end=${fake.runStart}&step=${step}`,
    { headers: { Authorization: `Bearer ${fake.token}` } },
  );

  it('names the parse errors Prometheus would raise', () => {
    expect(promqlError('rate(cht_x{instance="a.org"}[$interval])')).to.match(/parse error: unexpected character: '\$'/);
    expect(promqlError('x[${interval}]')).to.match(/unexpected character/);
    expect(promqlError('max_over_time(sum(cht_x{instance="a.org"})[1d])'))
      .to.match(/ranges only allowed for vector selectors/);
    expect(promqlError('max_over_time((cht_x{instance="a.org"} >= 0)[1d:5m])')).to.equal(null);
    expect(promqlError('max_over_time(cht_x{instance="a.org"}[1d])')).to.equal(null);
    expect(promqlError('sum(rate(cht_x{instance="a.org"}[5m])) * 60')).to.equal(null);
  });

  it('answers 400 with a Prometheus error envelope for an invalid query and data for the subquery form', async () => {
    const inner = 'sum(rate(cht_sentinel_backlog_count{instance="alpha.example.org"}[5m]))';
    const bad = await rangeQuery(`max_over_time(${inner}[1d])`, 86400);
    expect(bad.status).to.equal(400);
    expect(await bad.json()).to.include({ status: 'error', errorType: 'bad_data' });
    const unresolved = await rangeQuery('rate(cht_sentinel_backlog_count{instance="a.org"}[$interval])', 300);
    expect(unresolved.status).to.equal(400);
    const good = await rangeQuery(`max_over_time((${inner})[1d:5m])`, 86400);
    expect(good.status).to.equal(200);
    const body = await good.json();
    expect(body.data.result).to.have.length(1);
    expect(body.data.result[0].values.length).to.be.at.least(14);
  });
});

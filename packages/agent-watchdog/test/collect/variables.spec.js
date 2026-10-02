// Dashboard template variables in panel expressions (FR-071, research.md R-15): which ones an expression uses,
// what a dashboard's templating gives each one, and how they resolve to literals for one query.
const {
  variablesIn, dashboardVariables, resolveExpression, durationText, RESOLUTION_S, DEFAULT_SCRAPE_INTERVAL_S,
} = require('../../src/collect/variables');

const doc = (list) => ({ dashboard: { uid: 'd', title: 'D', templating: { list }, panels: [] } });

describe('collect/variables', () => {
  it('lists the variables an expression uses in every Grafana spelling, leaving the instance to scoping', () => {
    const expr = 'sum(rate(x{instance=~"$cht_instance"}[$interval])) + y[$__rate_interval] + ${interval}'
      + ' + [[db]] + ${fmt:csv}';
    expect(variablesIn(expr)).to.deep.equal(['interval', '__rate_interval', 'db', 'fmt']);
    expect(variablesIn('cht_x{instance=~"$cht_instance"}')).to.deep.equal([]);
    expect(variablesIn('rate(x[5m]) * 60')).to.deep.equal([]);
  });

  it('resolves interval, constant, custom and textbox variables to their single current value', () => {
    const variables = dashboardVariables(doc([
      { name: 'cht_instance', type: 'query', current: { value: 'a.org' } },
      { name: 'interval', type: 'interval', current: { value: '10m' }, auto: false },
      { name: 'auto_interval', type: 'interval', current: { value: '$__auto_interval_auto_interval' }, auto: true },
      { name: 'step', type: 'constant', current: { value: '2m' } },
      { name: 'env', type: 'custom', current: { value: 'prod' } },
      { name: 'single', type: 'custom', current: { value: ['only'] } },
      { name: 'note', type: 'textbox', current: { value: '12h' } },
      { name: 'db_name', type: 'query', current: { value: ['medic', 'sentinel'] } },
      { name: 'all', type: 'custom', current: { value: '$__all' } },
      { name: 'ds', type: 'datasource', current: { value: 'PBFA97CFB590B2093' } },
    ]));
    expect(variables).to.deep.equal({
      interval: '10m', auto_interval: durationText(RESOLUTION_S), step: '2m', env: 'prod', single: 'only', note: '12h',
      db_name: null, all: null, ds: null,
    });
    expect(dashboardVariables({ dashboard: { uid: 'x' } })).to.deep.equal({});
  });

  it('substitutes dashboard variables and the built-in time variables, reporting what it could not resolve', () => {
    const scoped = 'sum(rate(cht_api_http_request_duration_seconds_count{instance="a.org"}[$interval]))';
    expect(resolveExpression(scoped, { variables: { interval: '10m' } })).to.deep.equal({
      query: 'sum(rate(cht_api_http_request_duration_seconds_count{instance="a.org"}[10m]))', unresolved: [],
    });
    expect(resolveExpression('x[${interval}] + y[[[interval]]]', { variables: { interval: '10m' } }).query)
      .to.equal('x[10m] + y[10m]');
    const builtins = 'a[$__interval] b[$__rate_interval] c[$__range] $__interval_ms $__range_s $__range_ms';
    expect(resolveExpression(builtins, {}).query).to.equal('a[5m] b[20m] c[1d] 300000 86400 86400000');
    expect(resolveExpression('a[$__rate_interval]', { scrapeIntervalS: 60 }).query).to.equal('a[6m]');
    expect(resolveExpression('a[$__rate_interval]', { scrapeIntervalS: DEFAULT_SCRAPE_INTERVAL_S }).query)
      .to.equal('a[20m]');
    const left = resolveExpression('cht_couchdb_doc_total{instance="a.org", db="$db_name"}[$interval]', {
      variables: { interval: '10m', db_name: null },
    });
    expect(left).to.deep.equal({
      query: 'cht_couchdb_doc_total{instance="a.org", db="$db_name"}[10m]', unresolved: ['db_name'],
    });
    expect(resolveExpression('x{instance=~"$cht_instance"}', {}).unresolved).to.deep.equal(['cht_instance']);
  });

  it('formats durations in the largest exact PromQL unit', () => {
    expect([90, 300, 1200, 3600, 86400, 172800].map(durationText))
      .to.deep.equal(['90s', '5m', '20m', '1h', '1d', '2d']);
  });
});

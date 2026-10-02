const {
  checkReadiness, renderReport, monitoringUrl, hostMetricsUrl, MINIMUM_VERSION, API_METRICS_VERSION,
  COUCHDB_SIZE_VERSION,
} = require('../../src/readiness/check');
const codes = require('../../src/cli/exit-codes');

const NOW = new Date('2026-09-18T09:00:00Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

const monitoring = (app) => ({
  version: { app, node: 'v20.11.1', couchdb: '3.3.3' },
  couchdb: { medic: { doc_count: 1 } },
});

/** A fetch stub answering the monitoring endpoint and, optionally, the host-metrics exporter. */
const fetchFor = ({ app = '4.11.0', metrics = null, monitoringResponse = null } = {}) => sinon.stub()
  .callsFake(async (url) => {
    if (url === hostMetricsUrl('cht.example.org')) {
      if (metrics instanceof Error) {
        throw metrics;
      }
      return metrics === null ? text('nothing here', 404) : metrics;
    }
    if (monitoringResponse instanceof Error) {
      throw monitoringResponse;
    }
    return monitoringResponse || json(monitoring(app));
  });

const byName = (report) => Object.fromEntries(report.checks.map((c) => [c.name, c]));

describe('readiness/check (FR-048, research.md R-6)', () => {
  it('names the endpoints and the version thresholds', () => {
    expect(monitoringUrl('cht.example.org')).to.equal('https://cht.example.org/api/v2/monitoring');
    expect(hostMetricsUrl('cht.example.org')).to.equal('https://cht.example.org:8443/metrics');
    expect([MINIMUM_VERSION, API_METRICS_VERSION, COUCHDB_SIZE_VERSION]).to.deep.equal(['3.12.0', '4.3.0', '4.11.0']);
  });

  it('reports a 4.11.0 instance as ready with every check met and probes nothing else', async () => {
    const fetch = fetchFor({ app: '4.11.0' });
    const report = await checkReadiness({ url: 'https://cht.example.org', fetch, timeoutMs: 1000, now: () => NOW });
    expect(report).to.include({ url: 'https://cht.example.org', host: 'cht.example.org', reachable: true, ready: true });
    expect(report.version).to.deep.equal({ app: '4.11.0', node: 'v20.11.1', couchdb: '3.3.3' });
    expect(report.checked_at).to.equal('2026-09-18T09:00:00.000Z');
    expect(report.checks.map((c) => c.name)).to.deep.equal([
      'monitoring_endpoint', 'minimum_version', 'api_metrics', 'couchdb_size_metrics',
    ]);
    expect(report.checks.every((c) => c.status === 'met')).to.equal(true);
    expect(fetch).to.have.been.calledOnce;
    expect(fetch.firstCall.args[0]).to.equal('https://cht.example.org/api/v2/monitoring');
    expect(fetch.firstCall.args[1].signal).to.be.instanceOf(AbortSignal);
  });

  it('reports 3.11.0 as not ready with the minimum-version prerequisite unmet in plain language', async () => {
    const report = await checkReadiness({ url: 'https://cht.example.org/', fetch: fetchFor({ app: '3.11.0' }) });
    expect(report.ready).to.equal(false);
    const checks = byName(report);
    expect(checks.minimum_version.status).to.equal('unmet');
    expect(checks.minimum_version.message).to.equal(
      'CHT 3.12.0 or later is required for the watchdog\'s monitoring API; this instance runs 3.11.0',
    );
    expect(checks.api_metrics.status).to.equal('info');
    expect(checks.couchdb_size_metrics.status).to.equal('info');
  });

  it('accepts 3.12.0 as the minimum and reports 4.5.2 as ready with two informational notes', async () => {
    const minimum = await checkReadiness({ url: 'https://cht.example.org', fetch: fetchFor({ app: '3.12.0' }) });
    expect(minimum.ready).to.equal(true);
    expect(byName(minimum).minimum_version.status).to.equal('met');

    const mid = await checkReadiness({ url: 'https://cht.example.org', fetch: fetchFor({ app: '4.5.2' }) });
    expect(mid.ready).to.equal(true);
    const checks = byName(mid);
    expect(checks.api_metrics.status).to.equal('met');
    expect(checks.couchdb_size_metrics.status).to.equal('info');
    expect(checks.couchdb_size_metrics.message).to.include('4.11.0').and.include('4.5.2');

    const old = await checkReadiness({ url: 'https://cht.example.org', fetch: fetchFor({ app: '4.2.0' }) });
    expect(byName(old).api_metrics.status).to.equal('info');
    expect(byName(old).api_metrics.message).to.equal(
      'CHT 4.3.0 or later exposes API metrics (cht_api_*); this instance runs 4.2.0, so the API Server and '
      + 'Replication dashboards will be empty',
    );
    expect(old.ready).to.equal(true);
  });

  it('treats a missing or unreadable version as an unmet prerequisite, not a crash', async () => {
    const noVersion = fetchFor({ monitoringResponse: json({ couchdb: {} }) });
    const report = await checkReadiness({ url: 'https://cht.example.org', fetch: noVersion });
    expect(report.ready).to.equal(false);
    expect(report.version).to.equal(null);
    expect(byName(report).minimum_version.status).to.equal('unmet');
    expect(byName(report).minimum_version.message).to.match(/could not be read/);
    const garbage = fetchFor({ app: 'latest' });
    const report2 = await checkReadiness({ url: 'https://cht.example.org', fetch: garbage });
    expect(byName(report2).minimum_version.status).to.equal('unmet');
    expect(byName(report2).minimum_version.message).to.include('latest');
  });

  it('exits 69 when the monitoring endpoint times out, refuses the connection, errors or is not JSON', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const refused = Object.assign(new Error('fetch failed'), { name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
    const cases = [
      [fetchFor({ monitoringResponse: timeout }), /timed out/],
      [fetchFor({ monitoringResponse: refused }), /connection error/],
      [fetchFor({ monitoringResponse: text('busy', 503) }), /HTTP 503/],
      [fetchFor({ monitoringResponse: text('<html>login</html>', 200) }), /not valid JSON/],
    ];
    for (const [fetch, reason] of cases) {
      let error;
      try {
        await checkReadiness({ url: 'https://cht.example.org', fetch, timeoutMs: 50 });
      } catch (e) {
        error = e;
      }
      expect(error, String(reason)).to.be.instanceOf(codes.ExitError);
      expect(error.code).to.equal(codes.UNAVAILABLE);
      expect(error.message).to.match(/^monitoring endpoint unreachable: /).and.match(reason);
    }
  });

  it('probes the host-metrics exporter only when asked, and reports a silent exporter as unmet', async () => {
    const withMetrics = fetchFor({ app: '4.11.0', metrics: text('# HELP container_cpu_usage_seconds_total\n') });
    const report = await checkReadiness({ url: 'https://cht.example.org', fetch: withMetrics, hostMetrics: true });
    expect(withMetrics).to.have.been.calledTwice;
    expect(withMetrics.secondCall.args[0]).to.equal('https://cht.example.org:8443/metrics');
    expect(withMetrics.secondCall.args[1].signal).to.be.instanceOf(AbortSignal);
    expect(byName(report).host_metrics.status).to.equal('met');
    expect(report.ready).to.equal(true);

    const failure = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    const silent = fetchFor({ app: '4.11.0', metrics: failure });
    const unmet = await checkReadiness({ url: 'https://cht.example.org', fetch: silent, hostMetrics: true });
    expect(byName(unmet).host_metrics.status).to.equal('unmet');
    expect(byName(unmet).host_metrics.message)
      .to.match(/^the host-metrics exporter \(cAdvisor on port 8443\) did not answer: /);
    expect(unmet.ready).to.equal(false);

    const wrongBody = fetchFor({ app: '4.11.0', metrics: text('<html>caddy</html>') });
    const notExporter = await checkReadiness({ url: 'https://cht.example.org', fetch: wrongBody, hostMetrics: true });
    expect(byName(notExporter).host_metrics.status).to.equal('unmet');

    const notAsked = fetchFor({ app: '4.11.0' });
    const skipped = await checkReadiness({ url: 'https://cht.example.org', fetch: notAsked, hostMetrics: false });
    expect(notAsked).to.have.been.calledOnce;
    expect(skipped.checks.map((c) => c.name)).to.not.include('host_metrics');
  });

  it('renders the report as plain-language lines with a verdict', async () => {
    const report = await checkReadiness({ url: 'https://cht.example.org', fetch: fetchFor({ app: '4.5.2' }) });
    const lines = renderReport(report).split('\n');
    expect(lines[0]).to.equal('Readiness of cht.example.org (CHT 4.5.2)');
    expect(lines[1]).to.match(/^met\s+monitoring endpoint/);
    expect(lines.some((l) => /^info\s+CHT 4\.11\.0 or later/.test(l))).to.equal(true);
    expect(lines[lines.length - 1]).to.equal('ready');

    const old = await checkReadiness({ url: 'https://cht.example.org', fetch: fetchFor({ app: '3.11.0' }) });
    const oldLines = renderReport(old).split('\n');
    expect(oldLines.some((l) => /^UNMET\s+CHT 3\.12\.0 or later is required/.test(l))).to.equal(true);
    expect(oldLines[oldLines.length - 1]).to.equal('not ready: 1 prerequisite unmet');
  });
});

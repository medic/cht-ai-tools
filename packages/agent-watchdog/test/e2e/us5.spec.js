// End-to-end User Story 5: new projects and readiness. Real stages on the synthetic fixtures with a fake
// Grafana, a scripted model and a fake browser; the readiness command runs against a stubbed CHT endpoint.
// Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeDiscovery, makeProject } = require('../rollup/factories');
const check = require('../../src/cli/commands/check');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { runCase, envFor, capture } = require('./helpers');

const NEW_PROJECT = /New project since the previous run: gamma\.example\.org \(unconfigured\)/;

describe('e2e: User Story 5, new projects and readiness', function () {
  this.timeout(60000);
  const dirs = [];
  const fresh = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      removeDir(dirs.pop());
    }
  });

  it('scenario 1: a project that appears with no configuration entry is analysed and named as new', async () => {
    // Yesterday's run knew alpha and beta only; today gamma appears in the metrics store.
    const dataDir = fresh();
    await ensureDataLayout(dataDir);
    const yesterday = await RunDir.create(dataDir, '2026-09-17');
    await yesterday.writeJson('discovery.json', makeDiscovery({
      projects: [makeProject('alpha.example.org'), makeProject('beta.example.org')],
    }));
    await yesterday.updateRun({ run_id: '2026-09-17', status: 'heartbeat' });

    const r = await runCase({
      caseName: 'seeded-anomaly', dataDir, flags: { 'dry-run': true }, envExtra: { SLACK_BOT_TOKEN: '' }, slack: null,
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.runId).to.equal('2026-09-18');
    const discovery = r.read('discovery.json');
    const gamma = discovery.projects.find((p) => p.host === 'gamma.example.org');
    expect(gamma.configured).to.equal(false);
    // Analysed like any other: windows, changes and candidates exist and the down scrape target is flagged.
    expect(fs.existsSync(path.join(r.root, 'gamma-example-org', 'inputs', 'windows.json.gz'))).to.equal(true);
    expect(r.read('gamma-example-org/candidates.json').some((c) => c.rule === 'target_down')).to.equal(true);
    expect(r.read('rollup/items.ranked.json').some((i) => i.project_url === 'https://gamma.example.org')).to.equal(true);

    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('brief');
    expect(brief.notices).to.have.length(1);
    expect(brief.notices[0]).to.match(NEW_PROJECT);
    expect(brief.notices[0]).to.not.include('alpha.example.org');
    const payload = r.read('rollup/payload.json');
    expect(payload.parent.text).to.match(NEW_PROJECT);
    const contexts = payload.parent.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
    expect(contexts.some((text) => NEW_PROJECT.test(text))).to.equal(true);
    expect(JSON.parse(r.out.text()).parent.text).to.match(NEW_PROJECT);
    const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
    expect(report).to.include('New project since the previous run');

    // On a data volume with no earlier run, the first brief names every project instead.
    const first = await runCase({ caseName: 'quiet-day', dataDir: fresh() });
    expect(first.error, first.error && first.error.stack).to.equal(undefined);
    const heartbeat = first.read('rollup/brief.json');
    expect(heartbeat.kind).to.equal('heartbeat');
    expect(heartbeat.notices).to.have.length(1);
    expect(heartbeat.notices[0]).to.include('First run: 3 projects analysed');
    for (const host of ['alpha.example.org', 'beta.example.org', 'gamma.example.org']) {
      expect(heartbeat.notices[0]).to.include(host);
    }
    expect(first.slack.chat.postMessage.firstCall.args[0].text).to.include('First run: 3 projects analysed');
  });

  it('scenario 2: the readiness check names each unmet prerequisite in plain language and exits non-zero', async () => {
    const monitoring = (app) => new Response(JSON.stringify({ version: { app, node: 'v20.11.1', couchdb: '3.3.3' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const fetchFor = ({ app, hostMetrics = 'absent' }) => sinon.stub().callsFake(async (url) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/v2/monitoring') {
        return monitoring(app);
      }
      if (target.port === '8443' && target.pathname === '/metrics') {
        if (hostMetrics === 'present') {
          return new Response('container_cpu_usage_seconds_total 1\nmachine_memory_bytes 2\n', { status: 200 });
        }
        throw new TypeError('fetch failed');
      }
      throw new Error(`unexpected request ${target}`);
    });
    const configDir = fresh();
    fs.writeFileSync(path.join(configDir, 'projects.yaml'), [
      'projects:',
      '  old.example.org: { host_metrics: true }',
      '',
    ].join('\n'));
    const run = async (url, fetch) => {
      const out = capture();
      const err = capture();
      const args = {
        positionals: [url], flags: {}, env: envFor(fresh(), { AGENT_WATCHDOG_CONFIG_DIR: configDir }),
        stdout: out.stream, logger: createLogger({ stream: err.stream, level: 'warn' }), deps: { fetch },
      };
      try {
        return { code: await check(args), out: out.text(), fetch };
      } catch (error) {
        return { error, out: out.text(), fetch };
      }
    };

    // Below the minimum version: unmet, plain language, exit 1.
    const below = await run('https://old.example.org', fetchFor({ app: '3.11.0' }));
    expect(below.code).to.equal(1);
    expect(below.out).to.include('Readiness of old.example.org (CHT 3.11.0)');
    expect(below.out).to.match(/UNMET .*3\.12\.0 or later is required/);
    expect(below.out).to.include('this instance runs 3.11.0');
    // old.example.org opted into host metrics, so the exporter on 8443 is probed and its absence is unmet too.
    expect(below.out).to.match(/UNMET .*host-metrics exporter/);
    expect(below.out).to.match(/not ready: 2 prerequisites unmet/);
    expect(below.fetch.getCalls().map((c) => new URL(String(c.args[0])).port)).to.include('8443');

    // A supported version with everything met: exit 0, informational lines for newer metrics.
    const supported = await run('https://cht.example.org', fetchFor({ app: '4.5.2' }));
    expect(supported.code).to.equal(0);
    expect(supported.out).to.match(/met\s+CHT 3\.12\.0 or later/);
    expect(supported.out).to.match(/info\s+CHT 4\.11\.0 or later exposes CouchDB size metrics/);
    expect(supported.out.trim().split('\n').pop()).to.equal('ready');
    // No host_metrics entry for this host, so port 8443 is never probed.
    expect(supported.fetch.getCalls().map((c) => new URL(String(c.args[0])).port)).to.not.include('8443');

    // With the exporter present the opted-in host is fully ready.
    const ready = await run('https://old.example.org', fetchFor({ app: '4.11.0', hostMetrics: 'present' }));
    expect(ready.code).to.equal(0);
    expect(ready.out).to.match(/met\s+.*host-metrics/);

    // Unreachable: exit 69 and nothing on stdout.
    const gone = await run('https://gone.example.org', sinon.stub().rejects(new TypeError('fetch failed')));
    expect(gone.error).to.be.instanceOf(codes.ExitError);
    expect(gone.error.code).to.equal(codes.UNAVAILABLE);
    expect(gone.out).to.equal('');
  });

  it('scenario 3: fewer than fourteen days of history means no comparison computed from partial data', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh(), historyDays: { 'beta.example.org': 5 } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('published');
    const discovery = r.read('discovery.json');
    expect(discovery.projects.find((p) => p.host === 'beta.example.org').history_days).to.equal(5);
    expect(discovery.projects.find((p) => p.host === 'alpha.example.org').history_days).to.be.at.least(14);

    const changes = r.read('beta-example-org/changes.json');
    expect(changes.length).to.be.greaterThan(0);
    for (const change of changes) {
      expect(change.trailing_mean, change.metric).to.equal(null);
      expect(change.trailing_stddev, change.metric).to.equal(null);
      expect(change.deviation_sigma, change.metric).to.equal(null);
    }
    expect(changes.some((c) => c.previous_day_value !== null)).to.equal(true);
    expect(r.read('beta-example-org/candidates.json').filter((c) => c.rule === 'deviation')).to.deep.equal([]);
    // A project with full history still gets its deviation computed.
    const alpha = r.read('alpha-example-org/changes.json').find((c) => c.metric === 'cht_sentinel_backlog_count');
    expect(alpha.deviation_sigma).to.be.a('number');
  });
});

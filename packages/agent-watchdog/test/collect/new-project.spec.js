// User Story 5: a host that appears in the metrics store with no projects.yaml entry is analysed like any other
// and named as new in the brief; a project with fewer than fourteen days of history never has history
// comparisons computed from partial data.
const path = require('node:path');
const { discover } = require('../../src/collect/discovery');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { collectWindows } = require('../../src/collect/windows');
const { computeChanges } = require('../../src/analyze/changes');
const { computeCandidates } = require('../../src/analyze/candidates');
const { effectiveThresholds } = require('../../src/analyze/thresholds');
const { loadPolicy } = require('../../src/config/policy');
const { newProjectNotices, previousHostsFor } = require('../../src/rollup/new-projects');
const { buildHeartbeat } = require('../../src/rollup/deterministic-brief');
const { buildPayload } = require('../../src/publish/payload');
const { schemas } = require('../../src/model/schemas');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');
const { makeDiscovery, makeProject, footer } = require('../rollup/factories');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const RUN_START = new Date('2026-09-18T06:00:00Z');
const quiet = createLogger({ level: 'error', stream: { write() {} } });

const clientFor = (fake) => createGrafanaClient({
  baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
});

describe('collect: new and unconfigured projects (US5 scenario 1)', () => {
  it('discovers a host with no projects.yaml entry as unconfigured and analyses it like any other', async () => {
    const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
    const policy = loadPolicy({ configDir: tempDir(), defaultsDir: DEFAULTS_DIR });
    policy.projects.projects = { 'alpha.example.org': { owner: 'hosting' } };
    const discovery = await discover({
      grafana: clientFor(fake), policy, config: {}, runStart: RUN_START, logger: quiet,
    });
    const gamma = discovery.projects.find((p) => p.host === 'gamma.example.org');
    expect(gamma.configured).to.equal(false);
    expect(discovery.projects.find((p) => p.host === 'alpha.example.org').configured).to.equal(true);
    const { windows } = await collectWindows({
      grafana: clientFor(fake), project: gamma, discovery, runStart: RUN_START, logger: quiet,
    });
    const changes = computeChanges({ windows, project: gamma });
    const thresholds = effectiveThresholds(policy.thresholds, null);
    const candidates = computeCandidates({ changes, project: gamma, thresholds, policy, date: '2026-09-18', windows });
    expect(changes.length).to.be.greaterThan(0);
    expect(candidates.some((c) => c.rule === 'target_down')).to.equal(true);
  });
});

describe('rollup/new-projects: naming new projects in the brief', () => {
  const discovery = makeDiscovery();

  it('names the hosts that were not in the previous run and says which have no configuration entry', () => {
    const notices = newProjectNotices({
      discovery: makeDiscovery({
        projects: [
          makeProject('alpha.example.org', { configured: true }),
          makeProject('beta.example.org'),
          makeProject('gamma.example.org'),
        ],
      }),
      previousHosts: new Set(['alpha.example.org', 'beta.example.org']),
    });
    expect(notices).to.have.length(1);
    expect(notices[0]).to.include('New project since the previous run');
    expect(notices[0]).to.include('gamma.example.org');
    expect(notices[0]).to.match(/unconfigured/);
    expect(notices[0]).to.not.include('alpha.example.org');
    expect(notices[0]).to.not.include('beta.example.org');
  });

  it('says nothing when every host was already known, and names everything on the first run', () => {
    expect(newProjectNotices({ discovery, previousHosts: new Set(discovery.projects.map((p) => p.host)) }))
      .to.deep.equal([]);
    const first = newProjectNotices({ discovery, previousHosts: null });
    expect(first).to.have.length(1);
    expect(first[0]).to.include('First run');
    for (const project of discovery.projects) {
      expect(first[0]).to.include(project.host);
    }
  });

  it('caps the list and counts the rest', () => {
    const many = makeDiscovery({
      projects: Array.from({ length: 14 }, (_, i) => makeProject(`p${String(i).padStart(2, '0')}.example.org`)),
    });
    const [notice] = newProjectNotices({ discovery: many, previousHosts: new Set(), max: 10 });
    expect(notice).to.include('p09.example.org');
    expect(notice).to.not.include('p10.example.org');
    expect(notice).to.include('and 4 more');
  });

  it('reads the previous run\'s discovered hosts from the data volume, or null when there is none', async () => {
    const dataDir = tempDir();
    try {
      await ensureDataLayout(dataDir);
      const earlier = await RunDir.create(dataDir, '2026-09-16');
      await earlier.writeJson('discovery.json', makeDiscovery({
        projects: [makeProject('alpha.example.org'), makeProject('beta.example.org')],
      }));
      await RunDir.create(dataDir, '2026-09-17'); // a run without discovery (failed before collect) is skipped
      await RunDir.create(dataDir, '2026-09-18');
      const hosts = await previousHostsFor({ dataDir, runId: '2026-09-18' });
      expect([...hosts].sort()).to.deep.equal(['alpha.example.org', 'beta.example.org']);
      expect(await previousHostsFor({ dataDir, runId: '2026-09-16' })).to.equal(null);
    } finally {
      removeDir(dataDir);
    }
  });

  it('carries the notices on the brief entity and into the Slack payload as a context block', () => {
    const notice = 'New project since the previous run: gamma.example.org (unconfigured)';
    const brief = buildHeartbeat({
      runId: '2026-09-18', discovery, candidatesCount: 0, footer: footer(), notices: [notice],
    });
    expect(brief.notices).to.deep.equal([notice]);
    expect(() => schemas.Brief.parse(brief)).to.not.throw();
    expect(schemas.Brief.parse({ ...brief, notices: undefined }).notices).to.deep.equal([]);
    const payload = buildPayload({
      brief, items: [], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C1',
    });
    expect(payload.parent.text).to.include('gamma.example.org');
    const full = { ...brief, kind: 'brief', bullets: [] };
    const posted = buildPayload({
      brief: full, items: [], runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C1',
    });
    const contexts = posted.parent.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text);
    expect(contexts.some((text) => text.includes('gamma.example.org'))).to.equal(true);
    expect(contexts[contexts.length - 1]).to.include('cost $');
  });
});

describe('collect/analyze: fewer than fourteen days of history (US5 scenario 3)', () => {
  it('marks history comparisons unavailable and never computes deviation from partial data', async () => {
    const fake = createFakeGrafana({
      fixtureDir: fixturePath('runs', 'seeded-anomaly'), historyDays: { 'beta.example.org': 5 },
    });
    const policy = loadPolicy({ configDir: tempDir(), defaultsDir: DEFAULTS_DIR });
    const discovery = await discover({
      grafana: clientFor(fake), policy, config: {}, runStart: RUN_START, logger: quiet,
    });
    const beta = discovery.projects.find((p) => p.host === 'beta.example.org');
    const alpha = discovery.projects.find((p) => p.host === 'alpha.example.org');
    expect(beta.history_days).to.equal(5);
    expect(alpha.history_days).to.be.at.least(14);
    const { windows } = await collectWindows({
      grafana: clientFor(fake), project: beta, discovery, runStart: RUN_START, logger: quiet,
    });
    // Metrics the host reports at all (a current window with data) must have their trailing window marked as
    // short history, never computed from the five points that exist.
    const withData = new Set(windows.filter((w) => w.window === 'current' && w.available).map((w) => w.metric));
    expect(withData.size).to.be.greaterThan(0);
    const trailing = windows.filter((w) => w.window === 'trailing_14d' && withData.has(w.metric));
    expect(trailing.length).to.equal(withData.size);
    for (const window of trailing) {
      expect(window.available, window.metric).to.equal(false);
      expect(window.unavailable_reason, window.metric).to.equal('insufficient history: 5 days');
    }
    const changes = computeChanges({ windows, project: beta });
    for (const change of changes) {
      expect(change.trailing_mean, change.metric).to.equal(null);
      expect(change.trailing_stddev, change.metric).to.equal(null);
      expect(change.deviation_sigma, change.metric).to.equal(null);
    }
    // Comparisons that need no history are still made for the metrics the host reports.
    for (const change of changes.filter((c) => withData.has(c.metric))) {
      expect(change.previous_day_value, change.metric).to.not.equal(null);
    }
    const thresholds = effectiveThresholds(policy.thresholds, null);
    const candidates = computeCandidates({ changes, project: beta, thresholds, policy, date: '2026-09-18', windows });
    expect(candidates.filter((c) => c.rule === 'deviation')).to.deep.equal([]);
  });
});

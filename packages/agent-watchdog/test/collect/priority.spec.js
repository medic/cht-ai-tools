// The priority list steers analysis (FR-003, US3 scenario 2): its order is the analysis order, adding a
// dashboard adds its panels, and the model may still query metrics beyond the list.
const fs = require('node:fs');
const path = require('node:path');
const { discover } = require('../../src/collect/discovery');
const { metricSpecs, collectWindows } = require('../../src/collect/windows');
const { computeChanges } = require('../../src/analyze/changes');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { loadPolicy } = require('../../src/config/policy');
const { createWatchdogTools } = require('../../src/agent/tools/watchdog-tools');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const RUN_START = new Date('2026-09-18T06:00:00Z');
const OVERVIEW = 'oa2OfL-Vk';
const DETAILS = 'hkQUbyfVk';
const API = '3J_78b6Zz';
const REPLICATION = 'd4f05050-804e-4ea4-9642-4d088cc39a1b';
const quiet = createLogger({ level: 'error', stream: { write() {} } });

/** A policy whose dashboards.yaml lists exactly these uids, in this order, every panel included. */
const policyWithDashboards = (uids) => {
  const dir = tempDir();
  try {
    const yaml = ['dashboards:', ...uids.map((uid) => `  - uid: ${uid}\n    panels: []`)].join('\n');
    fs.writeFileSync(path.join(dir, 'dashboards.yaml'), `${yaml}\n`);
    return loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
  } finally {
    removeDir(dir);
  }
};

describe('collect/priority (the dashboards.yaml priority list)', function () {
  this.timeout(20000);
  let fake;
  let grafana;
  beforeEach(() => {
    fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
    grafana = createGrafanaClient({
      baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
    });
  });

  const discoverWith = (policy) => discover({ grafana, policy, config: {}, runStart: RUN_START, logger: quiet });

  it('reordering the list changes the order dashboards, metrics and computed changes are analysed in', async () => {
    const overviewFirst = await discoverWith(policyWithDashboards([OVERVIEW, DETAILS, API, REPLICATION]));
    const detailsFirst = await discoverWith(policyWithDashboards([DETAILS, OVERVIEW, API, REPLICATION]));
    expect(overviewFirst.dashboards.map((d) => d.uid)).to.deep.equal([OVERVIEW, DETAILS, API, REPLICATION]);
    expect(detailsFirst.dashboards.map((d) => d.uid)).to.deep.equal([DETAILS, OVERVIEW, API, REPLICATION]);

    const specsA = metricSpecs(overviewFirst).map((s) => s.metric);
    const specsB = metricSpecs(detailsFirst).map((s) => s.metric);
    expect([...specsA].sort()).to.deep.equal([...specsB].sort());
    expect(specsA).to.not.deep.equal(specsB);
    const firstMetricOf = (discovery) => discovery.dashboards[0].panels.find((p) => p.per_project).metric;
    expect(specsA[0]).to.equal(firstMetricOf(overviewFirst));
    expect(specsB[0]).to.equal(firstMetricOf(detailsFirst));
    expect(specsB[0]).to.equal('cht_couchdb_doc_total{db="medic"}');
    // The first panel in priority order owns a metric shared by two dashboards.
    const sentinelA = metricSpecs(overviewFirst).find((s) => s.metric === 'cht_sentinel_backlog_count');
    const sentinelB = metricSpecs(detailsFirst).find((s) => s.metric === 'cht_sentinel_backlog_count');
    expect(sentinelA.panel_ref).to.include({ dashboard_uid: OVERVIEW, panel_id: 3 });
    expect(sentinelB.panel_ref).to.include({ dashboard_uid: DETAILS, panel_id: 69 });

    const alpha = overviewFirst.projects.find((p) => p.host === 'alpha.example.org');
    const changesFor = async (discovery) => {
      const { windows } = await collectWindows({
        grafana, project: alpha, discovery, runStart: RUN_START, logger: quiet,
      });
      return computeChanges({ windows, project: alpha }).map((c) => c.metric);
    };
    expect(await changesFor(overviewFirst)).to.deep.equal(specsA);
    expect(await changesFor(detailsFirst)).to.deep.equal(specsB);
  });

  it('adding a dashboard to the list adds its panels and per-project metrics to the next run', async () => {
    const three = await discoverWith(policyWithDashboards([OVERVIEW, DETAILS, API]));
    const four = await discoverWith(policyWithDashboards([OVERVIEW, DETAILS, API, REPLICATION]));
    expect(three.dashboards).to.have.length(3);
    expect(four.dashboards).to.have.length(4);
    const added = four.dashboards[3];
    expect(added.uid).to.equal(REPLICATION);
    expect(added.panels.length).to.be.greaterThan(0);
    const addedMetrics = added.panels.filter((p) => p.per_project).map((p) => p.metric);
    expect(addedMetrics.length).to.be.greaterThan(0);
    for (const metric of addedMetrics) {
      expect(three.metrics).to.not.include(metric);
      expect(four.metrics).to.include(metric);
    }
    expect(metricSpecs(four).length).to.equal(metricSpecs(three).length + addedMetrics.length);
    expect(three.dashboards.map((d) => d.uid)).to.deep.equal(four.dashboards.slice(0, 3).map((d) => d.uid));
  });

  it('query_metric still reaches a metric that is on no listed dashboard, and refuses unknown names', async () => {
    const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
    const queryWindow = sinon.stub().resolves({
      window: 'previous_week', metric: 'cht_conflict_count', values: [[1, 2]],
    });
    const tools = createWatchdogTools({
      deps: { getWindows: sinon.stub().resolves({}), queryWindow, itemHistory: sinon.stub().resolves([]) },
      project,
      discovery: { metrics: ['cht_sentinel_backlog_count'] },
    });
    const query = tools.find((t) => t.name === 'query_metric');
    const parse = (out) => JSON.parse(out.content[0].text);
    const reached = parse(await query.handler({ metric: 'cht_conflict_count', window: 'previous_week' }));
    expect(reached).to.include({ window: 'previous_week', metric: 'cht_conflict_count' });
    expect(queryWindow).to.have.been.calledOnceWith(project, 'cht_conflict_count', 'previous_week');
    const refused = parse(await query.handler({ metric: 'made_up_metric', window: 'previous_week' }));
    expect(refused.error).to.match(/unknown metric/);
    expect(queryWindow).to.have.been.calledOnce;
  });
});

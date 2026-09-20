const path = require('node:path');
const { discover, metricKey, flattenPanels, panelRecords, dashboardVariables } = require('../../src/collect/discovery');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { loadPolicy } = require('../../src/config/policy');
const { schemas } = require('../../src/model/schemas');
const { createLogger } = require('../../src/log/logger');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const RUN_START = new Date('2026-09-18T06:00:00Z');
const quiet = createLogger({ level: 'error', stream: { write() {} } });

const policyWith = (projects) => {
  const dir = tempDir();
  try {
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    policy.projects.projects = projects;
    return policy;
  } finally {
    removeDir(dir);
  }
};

describe('collect/discovery', () => {
  let fake;
  let grafana;
  beforeEach(() => {
    fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
    grafana = createGrafanaClient({
      baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
    });
  });

  describe('metricKey', () => {
    it('drops the instance matcher and an empty selector', () => {
      expect(metricKey('cht_sentinel_backlog_count{instance=~"$cht_instance"}')).to.equal('cht_sentinel_backlog_count');
      expect(metricKey('cht_couchdb_fragmentation{instance=~"$cht_instance", db="medic"}'))
        .to.equal('cht_couchdb_fragmentation{db="medic"}');
      expect(metricKey('increase(cht_feedback_total{instance=~"$cht_instance"}[1d])'))
        .to.equal('increase(cht_feedback_total[1d])');
      expect(metricKey('up{job="cht", instance="alpha.example.org"}')).to.equal('up{job="cht"}');
    });

    it('leaves expressions without an instance matcher alone', () => {
      expect(metricKey('up{job="prometheus"}')).to.equal('up{job="prometheus"}');
      expect(metricKey('couch2pg_progress_pending{target="$cht_instance"}'))
        .to.equal('couch2pg_progress_pending{target="$cht_instance"}');
    });
  });

  describe('flattenPanels and panelRecords', () => {
    const dashboard = {
      meta: { slug: 's', url: '/d/x/s' },
      dashboard: {
        uid: 'x',
        title: 'X',
        panels: [
          {
            id: 1,
            title: 'A',
            targets: [{ refId: 'A', expr: 'm{instance=~"$cht_instance"}' }],
            fieldConfig: { defaults: { unit: 'short' } },
          },
          { id: 9, title: 'Row', type: 'row', panels: [
            { id: 2, title: 'B', targets: [{ refId: 'A', expr: 'up{job="prometheus"}' }] },
            {
              id: 3,
              title: 'C',
              targets: [
                { refId: 'A', expr: 'n{instance=~"$cht_instance"}' },
                { refId: 'B', expr: 'o{instance=~"$cht_instance"}' },
              ],
            },
          ] },
        ],
      },
    };

    it('includes panels nested inside rows and skips panels without targets', () => {
      expect(flattenPanels(dashboard.dashboard).map((p) => p.id)).to.deep.equal([1, 2, 3]);
    });

    it('records one entry per target, marks per-project expressions, and restricts to listed ids', () => {
      const all = panelRecords(dashboard, []);
      expect(all.map((p) => `${p.panel_id}${p.ref_id}`)).to.deep.equal(['1A', '2A', '3A', '3B']);
      expect(all[0]).to.include({ panel_id: 1, title: 'A', unit: 'count', metric: 'm', per_project: true });
      expect(all[1].per_project).to.equal(false);
      expect(panelRecords(dashboard, [3]).map((p) => p.panel_id)).to.deep.equal([3, 3]);
    });
  });

  describe('dashboard variables (FR-071)', () => {
    const templated = {
      meta: { slug: 't', url: '/d/t/t' },
      dashboard: {
        uid: 't',
        title: 'T',
        templating: { list: [
          { name: 'cht_instance', type: 'query', current: { value: 'a.org' } },
          { name: 'interval', type: 'interval', current: { value: '10m' }, auto: false },
          { name: 'db_name', type: 'query', current: { value: ['medic', 'sentinel'] } },
        ] },
        panels: [
          { id: 1, title: 'Rate', targets: [{ refId: 'A', expr: 'rate(a{instance=~"$cht_instance"}[$interval])' }] },
          { id: 2, title: 'Docs', targets: [{ refId: 'A', expr: 'b{instance=~"$cht_instance", db="$db_name"}' }] },
          {
            id: 3,
            title: 'CPU',
            targets: [{ refId: 'A', expr: 'rate(c{instance=~"$cht_instance"}[$__rate_interval])' }],
          },
        ],
      },
    };

    it('records what each dashboard variable resolves to and which panels still depend on an unresolved one', () => {
      expect(dashboardVariables(templated)).to.deep.equal({ interval: '10m', db_name: null });
      const records = panelRecords(templated, []);
      expect(records.map((r) => [r.panel_id, r.variables, r.unresolved])).to.deep.equal([
        [1, ['interval'], []],
        [2, ['db_name'], ['db_name']],
        [3, ['__rate_interval'], []],
      ]);
      expect(records.every((r) => r.per_project)).to.equal(true);
    });
  });

  describe('discover', () => {
    const discoverDefault = () => discover({
      grafana, policy: policyWith({}), config: {}, runStart: RUN_START, logger: quiet,
    });

    it('finds projects from the instance label and annotates configured ones', async () => {
      const policy = policyWith({
        'alpha.example.org': {
          owner: 'hosting', notes: 'big', host_metrics: true,
          thresholds: { pct_change_vs_previous_day: 80 },
          expected_load_windows: [
            {
              id: 'sync', kind: 'dates', start: '2026-10-05', end: '2026-10-09', timezone: 'UTC',
              note: 'n', cycle_days: 90,
            },
          ],
        },
      });
      const discovery = await discover({ grafana, policy, config: {}, runStart: RUN_START, logger: quiet });
      expect(discovery.run_start).to.equal('2026-09-18T06:00:00.000Z');
      expect(discovery.datasource_uid).to.equal(fake.datasourceUid);
      expect(discovery.projects.map((p) => p.host))
        .to.deep.equal(['alpha.example.org', 'beta.example.org', 'gamma.example.org']);
      const alpha = discovery.projects[0];
      expect(alpha).to.include({ url: 'https://alpha.example.org', slug: 'alpha-example-org', configured: true, owner: 'hosting' });
      expect(alpha.thresholds).to.deep.equal({ pct_change_vs_previous_day: 80 });
      expect(alpha.expected_load_windows.map((w) => w.id)).to.deep.equal(['sync', 'month-end']);
      expect(discovery.projects[1].configured).to.equal(false);
      expect(discovery.projects[1].expected_load_windows.map((w) => w.id)).to.deep.equal(['month-end']);
      for (const project of discovery.projects) {
        expect(() => schemas.Project.parse(project)).to.not.throw();
      }
    });

    it('reads the CHT version labels, history days and scrape-target health per project', async () => {
      const discovery = await discoverDefault();
      const [alpha, , gamma] = discovery.projects;
      expect(alpha.cht_version).to.equal('4.11.0');
      expect(gamma.cht_version).to.equal('3.17.0');
      expect(alpha.history_days).to.equal(21);
      expect(alpha.scrape_targets).to.deep.equal([
        { job: 'cht', scrape_url: alpha.scrape_targets[0].scrape_url, health: 'up', last_error: null },
      ]);
      expect(gamma.scrape_targets[0].health).to.equal('down');
      expect(gamma.scrape_targets[0].last_error).to.include('Failed to fetch');
      expect(discovery.targets_summary).to.deep.equal({ up: 2, down: 1, unknown: 0 });
    });

    it('walks the priority list in order, restricts panels to the listed ids and flags duplicate ids', async () => {
      const discovery = await discoverDefault();
      expect(discovery.dashboards.every((d) => d.variables && typeof d.variables === 'object')).to.equal(true);
      expect(discovery.dashboards.every((d) => d.panels.every((p) => Array.isArray(p.unresolved)))).to.equal(true);
      expect(discovery.dashboards.map((d) => d.uid)).to.deep.equal([
        'oa2OfL-Vk', 'hkQUbyfVk', '3J_78b6Zz', 'd4f05050-804e-4ea4-9642-4d088cc39a1b',
      ]);
      const overview = discovery.dashboards[0];
      expect(overview).to.include({
        title: 'CHT Admin Overview', slug: 'cht-admin-overview', url: '/d/oa2OfL-Vk/cht-admin-overview',
      });
      expect(overview.panels.map((p) => p.panel_id)).to.deep.equal([2, 3, 21, 7, 14, 16, 19, 13, 8, 23, 27, 50]);
      expect(overview.panels.map((p) => p.panel_id)).to.not.include.members([12, 34, 35]);
      expect(overview.duplicate_panel_ids).to.deep.equal([]);
      const details = discovery.dashboards[1];
      expect(details.panels).to.have.length(7);
      expect(details.duplicate_panel_ids).to.deep.equal([2]);
    });

    it('lists the unique per-project metric keys plus the scrape-target metric', async () => {
      const discovery = await discoverDefault();
      expect(discovery.metrics.filter((m) => m === 'cht_sentinel_backlog_count')).to.have.length(1);
      expect(discovery.metrics).to.include.members([
        'cht_outbound_push_backlog_count', 'up{job="cht"}', 'couch2pg_progress_pending{target="$cht_instance"}',
      ]);
      expect(discovery.metrics).to.deep.equal([...discovery.metrics].sort());
      expect(discovery.scrape_target_metric).to.equal('up{job="cht"}');
    });
  });
});

describe('collect/discovery: programme groups and ignored hosts (FR-068, User Story 9)', () => {
  const aliases = {
    'nepal-a.example.org': 'alpha.example.org',
    'nepal-b.example.org': 'gamma.example.org',
    'echis-a.example.org': 'alpha.example.org',
    'cht-dev.example.org': 'alpha.example.org',
    'cht.dev.example.org': 'beta.example.org',
  };
  const groupedPolicy = () => {
    const policy = policyWith({});
    policy.projects.groups = [
      { label: 'MoH Nepal', host_patterns: ['*nepal*'] },
      { label: 'eCHIS Kenya', host_patterns: ['*echis*'] },
    ];
    policy.projects.ignore = ['*.dev.*', '*-dev.*'];
    return policy;
  };
  let fake;
  let grafana;
  let discovery;
  before(async () => {
    fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly'), hostAliases: aliases });
    grafana = createGrafanaClient({
      baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
    });
    discovery = await discover({ grafana, policy: groupedPolicy(), config: {}, runStart: RUN_START, logger: quiet });
  });

  it('assigns every project the first matching group in file order, else Other', () => {
    const groups = Object.fromEntries(discovery.projects.map((p) => [p.host, p.group]));
    expect(groups).to.deep.equal({
      'alpha.example.org': 'Other',
      'beta.example.org': 'Other',
      'echis-a.example.org': 'eCHIS Kenya',
      'gamma.example.org': 'Other',
      'nepal-a.example.org': 'MoH Nepal',
      'nepal-b.example.org': 'MoH Nepal',
    });
    for (const project of discovery.projects) {
      expect(() => schemas.Project.parse(project)).to.not.throw();
    }
  });

  it('lists the groups with their hosts, Other included, and the ignored hosts with the pattern that matched', () => {
    expect(discovery.groups).to.deep.equal([
      { label: 'MoH Nepal', hosts: ['nepal-a.example.org', 'nepal-b.example.org'] },
      { label: 'eCHIS Kenya', hosts: ['echis-a.example.org'] },
      { label: 'Other', hosts: ['alpha.example.org', 'beta.example.org', 'gamma.example.org'] },
    ]);
    expect(discovery.ignored).to.deep.equal([
      { host: 'cht-dev.example.org', pattern: '*-dev.*' },
      { host: 'cht.dev.example.org', pattern: '*.dev.*' },
    ]);
  });

  it('never queries an ignored host, so it costs nothing and cannot be named', () => {
    expect(discovery.projects.map((p) => p.host))
      .to.not.include.members(['cht-dev.example.org', 'cht.dev.example.org']);
    const perHost = fake.calls.filter((c) => /cht_version|max_over_time/.test(decodeURIComponent(c.url)));
    expect(perHost.length).to.be.greaterThan(0);
    expect(perHost.some((c) => /cht-dev|cht\.dev/.test(decodeURIComponent(c.url)))).to.equal(false);
  });

  it('puts every host under Other when no groups are declared and ignores nothing without patterns', async () => {
    const plainPolicy = policyWith({});
    plainPolicy.projects.groups = [];
    plainPolicy.projects.ignore = [];
    const plain = await discover({ grafana, policy: plainPolicy, config: {}, runStart: RUN_START, logger: quiet });
    expect(plain.projects).to.have.length(8);
    expect(plain.projects.every((p) => p.group === 'Other')).to.equal(true);
    expect(plain.groups).to.deep.equal([{ label: 'Other', hosts: plain.projects.map((p) => p.host) }]);
    expect(plain.ignored).to.deep.equal([]);
  });
});

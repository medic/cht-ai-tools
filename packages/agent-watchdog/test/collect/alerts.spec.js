// FR-064: Grafana-managed alert rules and firing instances are read with the Viewer token, normalised, and an
// unavailable alerting API is recorded as such while the run continues.
const { collectAlerts, normaliseState, instanceIdFor } = require('../../src/collect/alerts');
const { createGrafanaClient } = require('../../src/collect/grafana');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath } = require('../helpers/fixtures');
const { alertsPolicy } = require('../helpers/alerts');

const RUN_START = new Date('2026-09-18T06:00:00Z');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const policyWith = (ignore = ['*.dev.*', '*-dev.*']) => ({
  projects: { defaults: { expected_load_windows: [] }, projects: {}, groups: [], ignore },
  alerts: alertsPolicy(),
});

const clientFor = (fake) => createGrafanaClient({
  baseUrl: fake.baseUrl, token: fake.token, datasourceUid: fake.datasourceUid, timeoutMs: 1000, fetch: fake.fetch,
});

describe('collect/alerts', () => {
  describe('normaliseState', () => {
    it('maps Grafana state names case-insensitively and Alerting to firing', () => {
      expect(normaliseState('Alerting')).to.equal('firing');
      expect(normaliseState('alerting')).to.equal('firing');
      expect(normaliseState('firing')).to.equal('firing');
      expect(normaliseState('Pending')).to.equal('pending');
      expect(normaliseState('NoData')).to.equal('nodata');
      expect(normaliseState('Error')).to.equal('error');
      expect(normaliseState('Normal')).to.equal('normal');
      expect(normaliseState('inactive')).to.equal('normal');
      expect(normaliseState(undefined)).to.equal('normal');
    });
  });

  describe('instanceIdFor', () => {
    it('hashes the rule uid and the sorted labels without alertname, so label order does not matter', () => {
      const a = instanceIdFor('FzCrECYVk', { instance: 'a.example.org', db: 'medic', alertname: 'Sentinel Backlog' });
      const b = instanceIdFor('FzCrECYVk', { db: 'medic', instance: 'a.example.org' });
      expect(a).to.match(/^[0-9a-f]{12}$/);
      expect(a).to.equal(b);
      expect(instanceIdFor('FzCrECYVk', { instance: 'b.example.org' })).to.not.equal(a);
    });
  });

  describe('collectAlerts against the recorded alert day', () => {
    let fake;
    let doc;
    before(async () => {
      fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'alerts-day') });
      doc = await collectAlerts({
        grafana: clientFor(fake), policy: policyWith(), logger: quiet, now: RUN_START,
      });
    });

    it('reads the rules endpoint with the bearer token, follows groupNextToken and records the pages', () => {
      const ruleCalls = fake.calls.filter((c) => c.url.includes('/api/prometheus/grafana/api/v1/rules'));
      expect(ruleCalls.length).to.be.greaterThan(1);
      expect(ruleCalls.every((c) => c.headers.authorization === `Bearer ${fake.token}`)).to.equal(true);
      expect(new URL(ruleCalls[1].url).searchParams.get('group_next_token')).to.be.a('string');
      expect(doc.available).to.equal(true);
      expect(doc.source).to.equal('rules');
      expect(doc.fetched_at).to.equal('2026-09-18T06:00:00.000Z');
      expect(doc.pages).to.equal(ruleCalls.length);
    });

    it('normalises every rule: uid, title, folder, group, pending duration, dashboard and panel', () => {
      const titles = doc.rules.map((r) => r.title).sort();
      expect(titles).to.include.members([
        'API Server Down', 'Client Feedback/Error Rate', 'DB Conflicts Rate', 'DB Fragmentation', 'Disk Usage High',
        'Message Delivery Rate', 'Outbound Push Backlog', 'Sentinel Backlog', 'Server Time Accurate',
        'Users Over Replication Limit', 'Watchdog Scrape Failures',
      ]);
      const sentinel = doc.rules.find((r) => r.title === 'Sentinel Backlog');
      expect(sentinel).to.include({
        rule_uid: 'FzCrECYVk', folder: 'CHT', rule_group: '10m', pending_for: '1h', dashboard_uid: 'oa2OfL-Vk',
        panel_id: 3, state: 'firing',
      });
      expect(doc.rules.find((r) => r.title === 'Server Time Accurate').state).to.equal('normal');
    });

    it('normalises every instance: host from the instance label, state, activeAt, value, dashboard and panel', () => {
      const firing = doc.instances.filter((i) => i.state === 'firing');
      expect(firing).to.have.length(16);
      const nepalA = firing.find((i) => i.title === 'Sentinel Backlog' && i.host === 'nepal-a.example.org');
      expect(nepalA).to.include({
        rule_uid: 'FzCrECYVk', project_url: 'https://nepal-a.example.org', active_at: '2026-09-17T20:00:00.000Z',
        dashboard_uid: 'oa2OfL-Vk', panel_id: 3,
      });
      expect(nepalA.instance_id).to.match(/^[0-9a-f]{12}$/);
      expect(nepalA.labels.instance).to.equal('https://nepal-a.example.org');
      expect(typeof nepalA.value).to.equal('string');
      const watchdog = firing.find((i) => i.title === 'Watchdog Scrape Failures');
      expect(watchdog).to.include({ host: null, project_url: null });
      // A pending instance is stored, not counted as firing.
      expect(doc.instances.some((i) => i.state === 'pending')).to.equal(true);
    });

    it('drops instances on ignored hosts and counts them', () => {
      expect(doc.instances.some((i) => i.host === 'cht-dev.example.org')).to.equal(false);
      expect(doc.ignored)
        .to.deep.equal([{ host: 'cht-dev.example.org', pattern: '*-dev.*', title: 'Sentinel Backlog' }]);
    });

    it('keeps the raw responses for replay', () => {
      expect(doc.raw).to.be.an('array').that.is.not.empty;
      expect(doc.raw[0]).to.have.nested.property('data.groups');
    });
  });

  describe('collectAlerts when the alerting API is not usable', () => {
    it('falls back to the alerts endpoint when the rules endpoint fails, and marks the source', async () => {
      const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'alerts-day'), alertsStatus: { rules: 500 } });
      const doc = await collectAlerts({
        grafana: clientFor(fake), policy: policyWith(), logger: quiet, now: RUN_START,
      });
      expect(doc.available).to.equal(true);
      expect(doc.source).to.equal('alerts');
      expect(doc.rules).to.deep.equal([]);
      expect(doc.instances.filter((i) => i.state === 'firing')).to.have.length(16);
    });

    for (const status of [401, 403, 503]) {
      it(`records available: false with a reason on HTTP ${status} and does not throw`, async () => {
        const fake = createFakeGrafana({
          fixtureDir: fixturePath('runs', 'alerts-day'), alertsStatus: { rules: status, alerts: status },
        });
        const doc = await collectAlerts({
          grafana: clientFor(fake), policy: policyWith(), logger: quiet, now: RUN_START,
        });
        expect(doc.available).to.equal(false);
        expect(doc.reason).to.include(String(status));
        expect(doc.rules).to.deep.equal([]);
        expect(doc.instances).to.deep.equal([]);
      });
    }

    it('records a timeout or network failure as unavailable', async () => {
      const failing = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      const client = createGrafanaClient({
        baseUrl: 'https://watchdog.example.org', token: 't', datasourceUid: 'u', timeoutMs: 100, fetch: failing,
      });
      const doc = await collectAlerts({ grafana: client, policy: policyWith(), logger: quiet, now: RUN_START });
      expect(doc.available).to.equal(false);
      expect(doc.reason).to.match(/ECONNREFUSED|unreachable/);
    });

    it('treats a Grafana with no alert rules as available and empty', async () => {
      const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'quiet-day') });
      const doc = await collectAlerts({
        grafana: clientFor(fake), policy: policyWith(), logger: quiet, now: RUN_START,
      });
      expect(doc).to.include({ available: true, source: 'rules' });
      expect(doc.rules).to.deep.equal([]);
      expect(doc.instances).to.deep.equal([]);
    });
  });
});

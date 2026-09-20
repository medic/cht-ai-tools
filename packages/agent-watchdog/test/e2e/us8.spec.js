// End-to-end User Story 8: Grafana-managed alerts read with the same token, classified from alerts.yaml, grouped
// per programme and category into code-built bullets with links, one thread reply per alert group, durable episodes
// with correlations across two days, and a notice when alerting is unavailable. The recorded alert day is the
// seeded-anomaly day with alerts; programme hosts are aliases of the series' own hosts. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase } = require('./helpers');

const DAY1 = '2026-09-18';
const DAY2 = '2026-09-19';
const GROUPED_PROJECTS_YAML = [
  'groups:',
  '  - label: MoH Nepal',
  "    host_patterns: ['*nepal*']",
  '  - label: eCHIS Kenya',
  "    host_patterns: ['*echis*']",
  "ignore: ['*-dev.*', '*.dev.*']",
  'projects: {}',
  '',
].join('\n');
// alpha carries the sentinel climb and gamma the down scrape target; beta is quiet.
const ALIASES = {
  'nepal-a.example.org': 'alpha.example.org',
  'nepal-b.example.org': 'gamma.example.org',
  'nepal-c.example.org': 'beta.example.org',
  'echis-a.example.org': 'alpha.example.org',
  'echis-b.example.org': 'beta.example.org',
};
const readJsonl = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

describe('e2e: User Story 8, alerts in the brief', function () {
  this.timeout(90000);
  const dirs = [];
  const fresh = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  const configDir = () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'projects.yaml'), GROUPED_PROJECTS_YAML);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      removeDir(dirs.pop());
    }
  });

  it('scenarios 1 to 5: grouped alert bullets, staleness, importance, thread replies and episodes across two days',
    async () => {
      const dataDir = fresh();
      const env = { AGENT_WATCHDOG_CONFIG_DIR: configDir() };
      const day1 = await runCase({ caseName: 'alerts-day', dataDir, date: DAY1, hostAliases: ALIASES, envExtra: env });
      expect(day1.error, day1.error && day1.error.stack).to.equal(undefined);
      expect(day1.read('run.json').status).to.equal('published');

      // Collected as recorded: rules, instances with hosts normalised, the development host dropped and counted.
      const alerts = day1.read('alerts.json');
      expect(alerts).to.include({ available: true, source: 'rules' });
      expect(alerts.rules.map((r) => r.title))
        .to.include.members(['Sentinel Backlog', 'API Server Down', 'Disk Usage High']);
      expect(alerts.instances.filter((i) => i.state === 'firing')).to.have.length(16);
      expect(alerts.ignored)
        .to.deep.equal([{ host: 'cht-dev.example.org', pattern: '*-dev.*', title: 'Sentinel Backlog' }]);

      // Classified: category and importance from alerts.yaml, three stale, the unknown rule uncategorised and medium.
      const classified = day1.read('alerts.classified.json');
      expect(classified.stale_after_days).to.equal(14);
      expect(classified.instances.filter((i) => i.stale).map((i) => i.host))
        .to.deep.equal(['nepal-b.example.org', 'nepal-b.example.org', 'nepal-b.example.org']);
      expect(classified.instances.filter((i) => i.state === 'firing').every((i) => i.new)).to.equal(true);
      const unknown = classified.instances.find((i) => i.title === 'Disk Usage High');
      expect(unknown).to.include({ category: 'uncategorised', importance: 'medium', known: false, group: 'MoH Nepal' });
      expect(classified.instances.find((i) => i.title === 'Watchdog Scrape Failures'))
        .to.include({ group: 'Watchdog', host: null });
      expect(classified.groups.map((g) => g.alert_key)).to.include.members([
        'MoH Nepal/availability', 'MoH Nepal/backlog', 'MoH Nepal/database', 'MoH Nepal/uncategorised',
        'eCHIS Kenya/messaging', 'eCHIS Kenya/client_errors', 'eCHIS Kenya/replication', 'Watchdog/uncategorised',
      ]);
      const backlog = classified.groups.find((g) => g.alert_key === 'MoH Nepal/backlog');
      expect(backlog)
        .to.include({ firing: 5, stale: 2, importance: 'high', oldest_started_at: '2026-08-20T00:00:00.000Z' });

      // The brief: the critical programme's alerts bullet first, one sub-bullet per category, counts and staleness
      // in the text, no URL in the body; every alert group has its own thread reply with links under Grafana.
      const brief = day1.read('rollup/brief.json');
      expect(brief.kind).to.equal('brief');
      expect(brief.bullets.length).to.be.at.most(5);
      expect(brief.bullets[0]).to.include({ kind: 'alerts', group: 'MoH Nepal' });
      expect(brief.bullets[0].text).to.equal('MoH Nepal alerts: 11 firing, 3 stale for more than 14 days');
      expect(brief.bullets[0].children.map((c) => c.text.split(':')[0])).to.deep.equal([
        'availability', 'backlog', 'database', 'uncategorised',
      ]);
      const backlogLine = brief.bullets[0].children.find((c) => c.text.startsWith('backlog')).text;
      expect(backlogLine).to.include('5 firing').and.include('oldest since 2026-08-20').and.include('2 stale');
      for (const bullet of brief.bullets) {
        expect(bullet.text).to.not.match(/https?:\/\//);
        expect(bullet.children.every((c) => !/https?:\/\//.test(c.text))).to.equal(true);
      }
      expect(brief.notices.some((n) => /alerts unavailable/i.test(n))).to.equal(false);
      const layout = day1.read('rollup/layout.json');
      expect(layout.slots[0]).to.include({ kind: 'alerts', group: 'MoH Nepal' });
      expect([...layout.body_alerts, ...layout.thread_alerts].sort())
        .to.deep.equal(classified.groups.map((g) => g.alert_key).sort());
      expect(day1.read('rollup/verification.draft1.json').outcome).to.equal('accepted');

      const payload = day1.read('rollup/payload.json');
      const alertReplies = payload.replies.filter((r) => r.alert_key);
      expect(alertReplies.map((r) => r.alert_key).sort())
        .to.deep.equal(classified.groups.map((g) => g.alert_key).sort());
      const ranked = day1.read('rollup/items.ranked.json');
      expect(payload.replies.filter((r) => r.item_id)).to.have.length(ranked.length);
      const backlogReply = alertReplies.find((r) => r.alert_key === 'MoH Nepal/backlog');
      expect(backlogReply.metadata).to.deep.equal({
        event_type: 'agent_watchdog.alerts',
        event_payload: { run_id: DAY1, date: DAY1, group: 'MoH Nepal', category: 'backlog', firing: 5 },
      });
      expect(backlogReply.text).to.include('Sentinel Backlog on nepal-b.example.org');
      expect(backlogReply.text).to.match(/<https:\/\/watchdog\.example\.org\/alerting\/list\?search=[^|]+\|/);
      expect(backlogReply.text).to.include('rule%3A%22Sentinel%20Backlog%22');
      expect(JSON.stringify(payload)).to.not.include('cht-dev');
      const publication = day1.read('rollup/publication.json');
      expect(publication.replies.filter((r) => r.alert_key)).to.have.length(classified.groups.length);
      expect(day1.slack.chat.postMessage.callCount).to.equal(1 + ranked.length + classified.groups.length);

      // Episodes: one opened event per firing instance with its correlations; the Sentinel Backlog alert on nepal-a
      // is explained by the sentinel item the analysis raised on that project.
      const episodes = readJsonl(path.join(dataDir, 'alerts', 'episodes.jsonl'));
      expect(episodes).to.have.length(16);
      expect(episodes.every((e) => e.event === 'opened' && e.run_id === DAY1)).to.equal(true);
      const nepalAItem = ranked.find((i) => i.project_url === 'https://nepal-a.example.org' && /sentinel/.test(i.metric));
      const sentinelEpisode = episodes.find((e) => e.title === 'Sentinel Backlog' && e.host === 'nepal-a.example.org');
      expect(sentinelEpisode.correlations.related_items).to.include(nepalAItem.item_id);
      expect(sentinelEpisode.correlations.related_candidates.length).to.be.greaterThan(0);
      expect(sentinelEpisode.explanation).to.deep.equal({ item_id: nepalAItem.item_id, why_now: nepalAItem.why_now });
      expect(sentinelEpisode.correlations.version_change).to.equal(null);
      expect(sentinelEpisode.started_at).to.equal('2026-09-17T20:00:00.000Z');
      // The agent saw the project's firing alerts.
      const prompt = fs.readFileSync(path.join(day1.root, 'nepal-a-example-org', 'prompt.pass1.md'), 'utf8');
      expect(prompt).to.include('<untrusted source="alerts">');
      expect(prompt).to.include('Sentinel Backlog');

      // Day two: one instance cleared, one new; episodes observe, clear and open accordingly, the cleared one
      // reaches the corpus, and newness and staleness move on.
      const day2 = await runCase({
        caseName: 'alerts-day', dataDir, date: DAY2, runStart: `${DAY2}T06:00:00Z`, hostAliases: ALIASES, envExtra: env,
      });
      expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
      const classified2 = day2.read('alerts.classified.json');
      expect(classified2.instances.filter((i) => i.state === 'firing')).to.have.length(16);
      const fresh2 = classified2.instances.filter((i) => i.new);
      expect(fresh2.map((i) => `${i.title}@${i.host}`))
        .to.deep.equal(['Client Feedback/Error Rate@echis-b.example.org']);
      expect(classified2.instances.some((i) => i.title === 'Sentinel Backlog' && i.host === 'nepal-c.example.org'))
        .to.equal(false);
      expect(classified2.instances.filter((i) => i.stale)).to.have.length(3);
      const events2 = readJsonl(path.join(dataDir, 'alerts', 'episodes.jsonl')).filter((e) => e.run_id === DAY2);
      expect(events2.filter((e) => e.event === 'observed')).to.have.length(15);
      expect(events2.filter((e) => e.event === 'opened')).to.have.length(1);
      const cleared = events2.filter((e) => e.event === 'cleared');
      expect(cleared).to.have.length(1);
      expect(cleared[0]).to.include({
        title: 'Sentinel Backlog', host: 'nepal-c.example.org', cleared_at: `${DAY2}T06:00:00.000Z`, duration_hours: 27,
      });
      const outcomes = readJsonl(path.join(dataDir, 'corpus', 'outcomes', `${DAY2}.jsonl`));
      expect(outcomes.filter((o) => o.kind === 'alert_episode').map((o) => o.episode_id))
        .to.deep.equal([cleared[0].episode_id]);
      expect(day2.read('rollup/brief.json').bullets[0].text)
        .to.equal('MoH Nepal alerts: 10 firing, 3 stale for more than 14 days');
    });

  it('scenario 6: when the alerting endpoints are unavailable the brief says so and the run completes', async () => {
    const dataDir = fresh();
    const r = await runCase({
      caseName: 'alerts-day', dataDir, date: DAY1, hostAliases: ALIASES,
      envExtra: { AGENT_WATCHDOG_CONFIG_DIR: configDir() }, alertsStatus: { rules: 503, alerts: 503 },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('published');
    const alerts = r.read('alerts.json');
    expect(alerts.available).to.equal(false);
    expect(alerts.reason).to.include('503');
    const classified = r.read('alerts.classified.json');
    expect(classified.groups).to.deep.equal([]);
    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('brief');
    expect(brief.bullets.every((b) => b.kind !== 'alerts')).to.equal(true);
    expect(brief.notices.some((n) => /^Alerts unavailable: .*503/.test(n))).to.equal(true);
    const payload = r.read('rollup/payload.json');
    expect(payload.parent.text).to.match(/Alerts unavailable/);
    expect(payload.replies.every((reply) => !reply.alert_key)).to.equal(true);
    expect(fs.existsSync(path.join(dataDir, 'alerts', 'episodes.jsonl'))).to.equal(false);
  });
});

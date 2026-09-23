// End-to-end User Story 8: Grafana-managed alerts read with the same token, classified from alerts.yaml, grouped
// per programme and category, summed into one alerts reply with counts and links (revision 28), durable episodes
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
  '  - label: North Programme',
  "    host_patterns: ['*north*']",
  '  - label: South Programme',
  "    host_patterns: ['*south*']",
  "ignore: ['*-dev.*', '*.dev.*']",
  'projects: {}',
  '',
].join('\n');
// alpha carries the sentinel climb and gamma the down scrape target; beta is quiet.
const ALIASES = {
  'north-a.example.org': 'alpha.example.org',
  'north-b.example.org': 'gamma.example.org',
  'north-c.example.org': 'beta.example.org',
  'south-a.example.org': 'alpha.example.org',
  'south-b.example.org': 'beta.example.org',
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

  it('scenarios 1 to 5: grouped alerts, staleness, importance, the alerts reply and episodes across two days',
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
        .to.deep.equal(['north-b.example.org', 'north-b.example.org', 'north-b.example.org']);
      expect(classified.instances.filter((i) => i.state === 'firing').every((i) => i.new)).to.equal(true);
      const unknown = classified.instances.find((i) => i.title === 'Disk Usage High');
      expect(unknown).to.include({
        category: 'uncategorised', importance: 'medium', known: false, group: 'North Programme',
      });
      expect(classified.instances.find((i) => i.title === 'Watchdog Scrape Failures'))
        .to.include({ group: 'Watchdog', host: null });
      expect(classified.groups.map((g) => g.alert_key)).to.include.members([
        'North Programme/availability', 'North Programme/backlog', 'North Programme/database',
        'North Programme/uncategorised', 'South Programme/messaging', 'South Programme/client_errors',
        'South Programme/replication', 'Watchdog/uncategorised',
      ]);
      const backlog = classified.groups.find((g) => g.alert_key === 'North Programme/backlog');
      expect(backlog)
        .to.include({ firing: 3, stale: 0, importance: 'high', oldest_started_at: '2026-09-17T20:00:00.000Z' });
      // The three stale alerts sit on the host whose scrape target is down: housekeeping, not news (FR-080).
      expect(classified.housekeeping.map((h) => [h.title, h.host])).to.deep.equal([
        ['DB Fragmentation', 'north-b.example.org'], ['Outbound Push Backlog', 'north-b.example.org'],
        ['Sentinel Backlog', 'north-b.example.org'],
      ]);
      expect(classified.counts).to.include({ housekeeping: 3, firing: 13 });

      // The brief: no alerts bullet since revision 28 and no URL in the body; the alerts go to one thread reply with
      // each programme's counts and its filtered alert list, closed by the housekeeping notice (FR-066, FR-080).
      const brief = day1.read('rollup/brief.json');
      expect(brief.kind).to.equal('brief');
      expect(brief.bullets.length).to.be.at.most(2);
      expect(brief.bullets.every((b) => b.kind !== 'alerts')).to.equal(true);
      for (const bullet of [...brief.bullets, ...brief.thread]) {
        expect(bullet.text).to.not.match(/https?:\/\//);
        expect(bullet.children.every((c) => !/https?:\/\//.test(c.text))).to.equal(true);
      }
      expect(brief.notices.some((n) => /alerts unavailable/i.test(n))).to.equal(false);
      expect(brief.notices).to.include(
        'Housekeeping: 3 alerts stale for 24+ days on 1 host with no data (north-b.example.org): remove them from the '
        + 'watchdog or silence the rules',
      );
      const layout = day1.read('rollup/layout.json');
      expect(layout.slots.every((s) => s.kind !== 'alerts')).to.equal(true);
      expect(layout.body_alerts).to.deep.equal([]);
      expect([...layout.thread_alerts].sort()).to.deep.equal(classified.groups.map((g) => g.alert_key).sort());
      expect(day1.read('rollup/verification.draft1.json').outcome).to.equal('accepted');

      const payload = day1.read('rollup/payload.json');
      expect(payload.replies.some((r) => r.item_id || r.alert_key), 'no item or alert-group replies').to.equal(false);
      const alertsReplies = payload.replies.filter((r) => r.kind === 'alerts');
      expect(alertsReplies, 'one alerts reply').to.have.length(1);
      const [alertsReply] = alertsReplies;
      expect(payload.replies[payload.replies.length - 1], 'the alerts reply comes last').to.equal(alertsReply);
      const ranked = day1.read('rollup/items.ranked.json');
      expect(payload.report.items).to.equal(ranked.length);
      expect(alertsReply.metadata.event_type).to.equal('agent_watchdog.alerts');
      expect(alertsReply.metadata.event_payload).to.include({ run_id: DAY1, date: DAY1, firing: 13 });
      expect(alertsReply.metadata.event_payload.programmes)
        .to.deep.equal(['North Programme', 'South Programme', 'Watchdog']);
      const lines = alertsReply.text.split('\n');
      expect(lines[0]).to.equal('*ALERTS* · 13 firing across 3 programmes');
      expect(lines[1]).to.match(/^• North Programme: 8 firing \([^)]*backlog 3[^)]*\), \d+ new, 0 stale · /);
      expect(lines[1]).to.match(/<https:\/\/watchdog\.example\.org\/alerting\/list\?search=[^|]+\|alert list>$/);
      // The programme's link filters the alert list by its hosts (regex-escaped, then URL-encoded).
      expect(lines[1]).to.include(encodeURIComponent('north-a\\.example\\.org'));
      expect(lines[2]).to.match(/^• South Programme: 4 firing \(/);
      expect(lines[3]).to.match(/^• Watchdog: 1 firing \(uncategorised 1\)/);
      expect(lines[4])
        .to.match(/^<https:\/\/watchdog\.example\.org\/alerting\/list\?search=[^|]+\|all firing alerts>$/);
      expect(lines.slice(5).join('\n')).to.include('Housekeeping: 3 alerts stale for 24+ days');
      expect(alertsReply.text, 'instances are in the report, not the reply').to.not.include('Sentinel Backlog on');
      expect(alertsReply.text, 'housekeeping instances are not listed').to.not.include('DB Fragmentation');
      expect(payload.parent.text).to.not.include('Housekeeping');
      expect(JSON.stringify(payload)).to.not.include('cht-dev');
      const publication = day1.read('rollup/publication.json');
      expect(publication.replies.filter((r) => r.kind === 'alerts')).to.have.length(1);
      expect(day1.slack.chat.postMessage.callCount).to.equal(1 + payload.replies.length);
      // The report carries the alert instances the reply only counts.
      const report = fs.readFileSync(path.join(day1.root, 'rollup', 'report.html'), 'utf8');
      expect(report).to.include('Sentinel Backlog').and.include('north-a.example.org');

      // Episodes: one opened event per firing instance with its correlations; the Sentinel Backlog alert on north-a
      // is explained by the sentinel item the analysis raised on that project.
      const episodes = readJsonl(path.join(dataDir, 'alerts', 'episodes.jsonl'));
      expect(episodes).to.have.length(16);
      expect(episodes.every((e) => e.event === 'opened' && e.run_id === DAY1)).to.equal(true);
      const northAItem = ranked.find((i) => i.project_url === 'https://north-a.example.org' && /sentinel/.test(i.metric));
      const sentinelEpisode = episodes.find((e) => e.title === 'Sentinel Backlog' && e.host === 'north-a.example.org');
      expect(sentinelEpisode.correlations.related_items).to.include(northAItem.item_id);
      expect(sentinelEpisode.correlations.related_candidates.length).to.be.greaterThan(0);
      expect(sentinelEpisode.explanation).to.deep.equal({ item_id: northAItem.item_id, why_now: northAItem.why_now });
      expect(sentinelEpisode.correlations.version_change).to.equal(null);
      expect(sentinelEpisode.started_at).to.equal('2026-09-17T20:00:00.000Z');
      // The agent saw the project's firing alerts.
      const prompt = fs.readFileSync(path.join(day1.root, 'north-a-example-org', 'prompt.pass1.md'), 'utf8');
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
        .to.deep.equal(['Client Feedback/Error Rate@south-b.example.org']);
      expect(classified2.instances.some((i) => i.title === 'Sentinel Backlog' && i.host === 'north-c.example.org'))
        .to.equal(false);
      expect(classified2.instances.filter((i) => i.stale)).to.have.length(3);
      const events2 = readJsonl(path.join(dataDir, 'alerts', 'episodes.jsonl')).filter((e) => e.run_id === DAY2);
      expect(events2.filter((e) => e.event === 'observed')).to.have.length(15);
      expect(events2.filter((e) => e.event === 'opened')).to.have.length(1);
      const cleared = events2.filter((e) => e.event === 'cleared');
      expect(cleared).to.have.length(1);
      expect(cleared[0]).to.include({
        // Episode times are the clock when the alerts were read (the e2e clock runs at 06:05), not the run start.
        title: 'Sentinel Backlog', host: 'north-c.example.org', cleared_at: `${DAY2}T06:05:00.000Z`,
        duration_hours: 27.08,
      });
      const outcomes = readJsonl(path.join(dataDir, 'corpus', 'outcomes', `${DAY2}.jsonl`));
      expect(outcomes.filter((o) => o.kind === 'alert_episode').map((o) => o.episode_id))
        .to.deep.equal([cleared[0].episode_id]);
      const brief2 = day2.read('rollup/brief.json');
      const payload2 = day2.read('rollup/payload.json');
      const alertsReply2 = payload2.replies.find((r) => r.kind === 'alerts');
      expect(alertsReply2.text).to.include('• North Programme: 7 firing (');
      // north-c's sentinel alert ended overnight: a resolved line in the alerts reply, not silence (FR-080).
      const resolved = 'Resolved since the previous run: Sentinel Backlog on north-c.example.org';
      expect(brief2.notices.some((n) => n.startsWith(resolved))).to.equal(true);
      expect(alertsReply2.text).to.include(resolved);
      expect(payload2.parent.text).to.not.include('Resolved since');
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
    // The notice closes the alerts reply, not the post body (revision 28).
    expect(payload.parent.text).to.not.match(/Alerts unavailable/);
    const alertsReply = payload.replies.find((reply) => reply.kind === 'alerts');
    expect(alertsReply.text).to.match(/^\*ALERTS\* · none firing\n\S+ Alerts unavailable: .*503/);
    expect(payload.replies.every((reply) => !reply.alert_key && !reply.item_id)).to.equal(true);
    expect(fs.existsSync(path.join(dataDir, 'alerts', 'episodes.jsonl'))).to.equal(false);
  });
});

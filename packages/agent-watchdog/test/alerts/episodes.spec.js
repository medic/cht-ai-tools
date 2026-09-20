// FR-067: durable episode events (opened, observed, cleared) with code-built correlations and the analysis's
// explanation, appended to alerts/episodes.jsonl and, once cleared, to the corpus outcomes.
const fs = require('node:fs');
const path = require('node:path');
const {
  episodeId, readEpisodeEvents, openEpisodes, correlationsFor, updateEpisodes, EPISODES_FILE,
} = require('../../src/alerts/episodes');
const { ensureDataLayout, dataPaths } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { classified, alertsPolicy, RUN_START } = require('../helpers/alerts');
const { makeItem, makeCandidate, makeProject } = require('../rollup/factories');

const DAY2 = '2026-09-19T06:00:00Z';
const NEPAL_A = 'https://nepal-a.example.org';

describe('alerts/episodes', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
  });
  afterEach(() => removeDir(dataDir));

  const project = makeProject('nepal-a.example.org', {
    group: 'MoH Nepal', cht_version: '4.11.0',
    expected_load_windows: [{
      id: 'month-end', scope: 'all', kind: 'month_end', start: null, end: null, timezone: 'UTC', note: 'n',
      cycle_days: 30, days_before: 2, days_after: 2,
    }],
  });
  const sentinelItem = makeItem({ project_url: NEPAL_A, why_now: 'Sentinel backlog climbed for seven hours.' });
  const conflictItem = makeItem({ project_url: NEPAL_A, metric: 'cht_conflict_count', severity: 'low' });
  const candidates = [makeCandidate({ project_url: NEPAL_A }), makeCandidate({
    candidate_id: 'cccccccccccc', project_url: NEPAL_A, metric: 'cht_conflict_count', severity_floor: 'low',
  })];

  it('derives the episode id from the instance and the start date and the data layout has the alerts directory', () => {
    expect(episodeId('abcdefabcdef', '2026-09-17T20:00:00Z')).to.match(/^[0-9a-f]{12}$/);
    expect(episodeId('abcdefabcdef', '2026-09-17T20:00:00Z'))
      .to.not.equal(episodeId('abcdefabcdef', '2026-09-18T20:00:00Z'));
    expect(EPISODES_FILE).to.equal('alerts/episodes.jsonl');
    expect(fs.existsSync(dataPaths(dataDir).alerts)).to.equal(true);
    expect(dataPaths(dataDir).alertEpisodesFile).to.equal(path.join(dataDir, 'alerts', 'episodes.jsonl'));
  });

  it('computes correlations by code: the active window at the start, a version change and related records', () => {
    const instance = classified('sentinel', 'nepal-a.example.org', { started_at: '2026-08-31T20:00:00Z' });
    const correlations = correlationsFor({
      instance, project, previousProject: { ...project, cht_version: '4.10.0' }, candidates,
      items: [sentinelItem, conflictItem], categories: alertsPolicy().categories, observedAt: RUN_START,
    });
    expect(correlations.expected_load_window_id).to.equal('month-end');
    expect(correlations.version_change).to.deep.equal({ from: '4.10.0', to: '4.11.0', observed: RUN_START });
    expect(correlations.related_candidates).to.deep.equal(['0123456789ab']);
    expect(correlations.related_items).to.deep.equal([sentinelItem.item_id]);
    const explanation = correlationsFor({
      instance, project, previousProject: project, candidates, items: [sentinelItem],
      categories: alertsPolicy().categories, observedAt: RUN_START,
    });
    expect(explanation.version_change).to.equal(null);
    expect(explanation.explanation).to.deep.equal({ item_id: sentinelItem.item_id, why_now: sentinelItem.why_now });
  });

  it('opens, observes and clears episodes across runs and appends cleared ones to the corpus outcomes', async () => {
    const firing = classified('sentinel', 'nepal-a.example.org');
    const soonCleared = classified('outbound', 'nepal-a.example.org', { started_at: '2026-09-17T06:00:00Z' });
    const day1 = await updateEpisodes({
      dataDir, runId: '2026-09-18', date: '2026-09-18', runStart: new Date(RUN_START),
      classified: { instances: [firing, soonCleared] }, items: [sentinelItem],
      candidatesByProject: { [NEPAL_A]: candidates },
      discovery: { projects: [project] }, previousDiscovery: null, categories: alertsPolicy().categories,
    });
    expect(day1.opened.map((e) => e.instance_id).sort())
      .to.deep.equal([firing.instance_id, soonCleared.instance_id].sort());
    expect(day1.observed).to.deep.equal([]);
    expect(day1.cleared).to.deep.equal([]);
    const opened = day1.opened.find((e) => e.instance_id === firing.instance_id);
    expect(opened).to.include({
      event: 'opened', run_id: '2026-09-18', title: 'Sentinel Backlog', host: 'nepal-a.example.org',
      project_url: NEPAL_A, group: 'MoH Nepal', category: 'backlog', importance: 'high', started_at: firing.started_at,
      cleared_at: null, duration_hours: null,
    });
    expect(opened.episode_id).to.equal(episodeId(firing.instance_id, firing.started_at));
    expect(opened.correlations.related_items).to.deep.equal([sentinelItem.item_id]);
    expect(opened.explanation).to.deep.equal({ item_id: sentinelItem.item_id, why_now: sentinelItem.why_now });

    const events = await readEpisodeEvents(dataDir);
    expect(events).to.have.length(2);
    expect(openEpisodes(events).size).to.equal(2);

    const day2 = await updateEpisodes({
      dataDir, runId: '2026-09-19', date: '2026-09-19', runStart: new Date(DAY2),
      classified: { instances: [{ ...firing, days_firing: 1 }] }, items: [], candidatesByProject: {},
      discovery: { projects: [project] }, previousDiscovery: { projects: [project] },
      categories: alertsPolicy().categories,
    });
    expect(day2.opened).to.deep.equal([]);
    expect(day2.observed.map((e) => e.instance_id)).to.deep.equal([firing.instance_id]);
    expect(day2.observed[0]).to.include({ event: 'observed', episode_id: opened.episode_id, run_id: '2026-09-19' });
    expect(day2.cleared.map((e) => e.instance_id)).to.deep.equal([soonCleared.instance_id]);
    expect(day2.cleared[0])
      .to.include({ event: 'cleared', cleared_at: '2026-09-19T06:00:00.000Z', duration_hours: 48 });

    const all = await readEpisodeEvents(dataDir);
    expect(all.map((e) => e.event)).to.deep.equal(['opened', 'opened', 'observed', 'cleared']);
    expect(openEpisodes(all).size).to.equal(1);
    const outcomes = fs.readFileSync(path.join(dataDir, 'corpus', 'outcomes', '2026-09-19.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    expect(outcomes).to.have.length(1);
    expect(outcomes[0])
      .to.include({ kind: 'alert_episode', episode_id: day2.cleared[0].episode_id, duration_hours: 48 });
  });

  it('is durable for retention and empty on a fresh volume', async () => {
    const { classify } = require('../../src/store/retention');
    expect(classify('alerts/episodes.jsonl')).to.equal('durable');
    expect(await readEpisodeEvents(dataDir)).to.deep.equal([]);
  });
});

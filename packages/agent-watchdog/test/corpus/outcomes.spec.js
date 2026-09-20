const fs = require('node:fs');
const path = require('node:path');
const { appendOutcomes, readOutcomes } = require('../../src/corpus/outcomes');
const { ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const entry = (over) => ({
  project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', pattern_card: null,
  up: 0, down: 0, retracted: 0, notes: [], verdict: 'unreviewed', horizon: null, ...over,
});

describe('corpus/outcomes (FR-030)', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
  });
  afterEach(() => removeDir(dataDir));

  const byItem = {
    aaaaaaaaaaaa: entry({ up: 2, verdict: 'confirmed', notes: ['useful'] }),
    bbbbbbbbbbbb: entry({ down: 1, verdict: 'dismissed', metric: 'cht_conflict_count' }),
    cccccccccccc: entry({ up: 1, down: 1, verdict: 'contested' }),
    dddddddddddd: entry(),
  };

  it('appends confirmed and dismissed items only, once per day', async () => {
    const first = await appendOutcomes({ dataDir, date: '2026-09-18', runId: '2026-09-18', byItem });
    expect(first.appended).to.equal(2);
    const file = path.join(dataDir, 'corpus', 'outcomes', '2026-09-18.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines.map((l) => l.outcome).sort()).to.deep.equal(['confirmed', 'dismissed']);
    expect(lines.find((l) => l.item_id === 'aaaaaaaaaaaa')).to.include({
      date: '2026-09-18', run_id: '2026-09-18', project_url: 'https://alpha.example.org', up: 2, down: 0,
    });
    expect(lines.find((l) => l.item_id === 'aaaaaaaaaaaa').notes).to.deep.equal(['useful']);
    const again = await appendOutcomes({ dataDir, date: '2026-09-18', runId: '2026-09-18-f1', byItem });
    expect(again.appended).to.equal(0);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).to.have.length(2);
  });

  it('accepts a Map and reads outcomes back by date range', async () => {
    await appendOutcomes({ dataDir, date: '2026-09-10', runId: '2026-09-10', byItem: new Map(Object.entries(byItem)) });
    await appendOutcomes({ dataDir, date: '2026-09-18', runId: '2026-09-18', byItem });
    expect(await readOutcomes(dataDir, { from: '2026-09-01', to: '2026-09-30' })).to.have.length(4);
    expect(await readOutcomes(dataDir, { from: '2026-09-15', to: '2026-09-30' })).to.have.length(2);
    expect(await readOutcomes(dataDir, { from: '2026-10-01', to: '2026-10-31' })).to.deep.equal([]);
  });
});

describe('corpus/outcomes: alert episodes (FR-067, User Story 8)', () => {
  const { appendAlertEpisodes, readAlertEpisodes } = require('../../src/corpus/outcomes');
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
  });
  afterEach(() => removeDir(dataDir));

  const episode = (id) => ({
    episode_id: id, instance_id: 'i'.repeat(12), rule_uid: 'FzCrECYVk', title: 'Sentinel Backlog',
    host: 'nepal-a.example.org', project_url: 'https://nepal-a.example.org', group: 'MoH Nepal', category: 'backlog',
    importance: 'high', started_at: '2026-09-17T06:00:00Z', cleared_at: '2026-09-19T06:00:00Z', duration_hours: 48,
    correlations: { expected_load_window_id: null, version_change: null, related_candidates: [], related_items: [] },
    explanation: null,
  });

  it('appends cleared episodes once per id as alert_episode records that item readers never see', async () => {
    const first = await appendAlertEpisodes({
      dataDir, date: '2026-09-19', runId: '2026-09-19', episodes: [episode('e1e1e1e1e1e1')],
    });
    expect(first.appended).to.equal(1);
    const again = await appendAlertEpisodes({
      dataDir, date: '2026-09-19', runId: '2026-09-19-f1', episodes: [episode('e1e1e1e1e1e1'), episode('e2e2e2e2e2e2')],
    });
    expect(again.appended).to.equal(1);
    const file = path.join(dataDir, 'corpus', 'outcomes', '2026-09-19.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).to.have.length(2);
    expect(lines[0])
      .to.include({ kind: 'alert_episode', date: '2026-09-19', run_id: '2026-09-19', episode_id: 'e1e1e1e1e1e1' });
    await appendOutcomes({ dataDir, date: '2026-09-19', runId: '2026-09-19', byItem: {
      aaaaaaaaaaaa: entry({ up: 1, verdict: 'confirmed' }),
    } });
    // Item outcome readers (calibration) see only item outcomes; the episode reader sees only episodes.
    expect(await readOutcomes(dataDir, { from: '2026-09-01', to: '2026-09-30' })).to.have.length(1);
    expect((await readAlertEpisodes(dataDir, { from: '2026-09-01', to: '2026-09-30' })).map((e) => e.episode_id))
      .to.deep.equal(['e1e1e1e1e1e1', 'e2e2e2e2e2e2']);
  });
});

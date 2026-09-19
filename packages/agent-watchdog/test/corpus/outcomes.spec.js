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

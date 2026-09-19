const fs = require('node:fs');
const path = require('node:path');
const { appendRecords, readAll, readByItem } = require('../../src/feedback/store');
const { tempDir, removeDir } = require('../helpers/fixtures');

const record = (overrides = {}) => ({
  feedback_id: 'abcdefabcdef',
  date: '2026-09-18',
  run_id: '2026-09-17',
  target: 'item',
  item_id: '49bd5cd2499f',
  kind: 'reaction',
  verdict: 'down',
  note: null,
  horizon: null,
  author: 'U1',
  matched: true,
  source_ts: '1758088801.000200',
  ...overrides,
});

describe('feedback/store', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('appends validated records to feedback.jsonl and skips ids already present', async () => {
    const first = await appendRecords(dataDir, [record(), record({ feedback_id: 'bbbbbbbbbbbb', author: 'U2' })]);
    expect(first).to.deep.equal({ appended: 2, skipped: 0 });
    const again = await appendRecords(dataDir, [record(), record({ feedback_id: 'cccccccccccc', author: 'U3' })]);
    expect(again).to.deep.equal({ appended: 1, skipped: 1 });
    const lines = fs.readFileSync(path.join(dataDir, 'feedback.jsonl'), 'utf8').trim().split('\n');
    expect(lines).to.have.length(3);
    expect(await readAll(dataDir)).to.have.length(3);
  });

  it('rejects an invalid record before writing anything', async () => {
    await expect(appendRecords(dataDir, [record({ verdict: 'meh' })])).to.be.rejected;
    await expect(appendRecords(dataDir, [record({ target: 'item', item_id: null })])).to.be.rejected;
    expect(fs.existsSync(path.join(dataDir, 'feedback.jsonl'))).to.equal(false);
  });

  it('groups records by item and leaves brief-level records out of the map', async () => {
    await appendRecords(dataDir, [
      record(),
      record({ feedback_id: 'bbbbbbbbbbbb', author: 'U2', item_id: 'a09c1ddc330a', verdict: 'up' }),
      record({
        feedback_id: 'cccccccccccc', author: 'U9', target: 'brief', item_id: null, verdict: 'up',
        source_ts: '1758088800.000100',
      }),
    ]);
    const byItem = await readByItem(dataDir);
    expect([...byItem.keys()].sort()).to.deep.equal(['49bd5cd2499f', 'a09c1ddc330a']);
    expect(byItem.get('49bd5cd2499f')).to.have.length(1);
  });

  it('returns an empty list when no feedback has ever been recorded', async () => {
    expect(await readAll(dataDir)).to.deep.equal([]);
    expect((await readByItem(dataDir)).size).to.equal(0);
  });
});

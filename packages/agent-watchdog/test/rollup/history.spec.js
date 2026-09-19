const { previousItemCounts, previousRunIds } = require('../../src/rollup/history');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

describe('rollup/history', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  const runWith = async (runId, itemIds) => {
    const run = await RunDir.create(dataDir, runId);
    if (itemIds) {
      await run.writeJson('rollup/items.ranked.json', itemIds.map((id) => ({ item_id: id })));
    }
    return run;
  };

  it('counts consecutive preceding runs that contained each item, most recent first', async () => {
    await runWith('2026-09-14', ['A']);
    await runWith('2026-09-15', ['A', 'B']);
    await runWith('2026-09-16', ['A', 'B']);
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-18', null);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.get('A')).to.equal(4);
    expect(counts.has('B')).to.equal(false);
  });

  it('ends every streak at a run without a ranked items file', async () => {
    await runWith('2026-09-15', ['A']);
    await runWith('2026-09-16', null);
    await runWith('2026-09-17', ['A', 'B']);
    await runWith('2026-09-18', null);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.get('A')).to.equal(1);
    expect(counts.get('B')).to.equal(1);
  });

  it('lists the n most recent run ids before the current one', async () => {
    for (const id of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      await runWith(id, null);
    }
    expect(await previousRunIds(dataDir, '2026-09-18', 2)).to.deep.equal(['2026-09-17', '2026-09-16']);
    expect(await previousRunIds(dataDir, '2026-09-15', 2)).to.deep.equal([]);
  });
});

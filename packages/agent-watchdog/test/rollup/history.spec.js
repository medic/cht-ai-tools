const { previousItemCounts, previousRunIds, lastRunPerDate, analysedDatesBefore } = require('../../src/rollup/history');
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

  it('counts consecutive preceding dates that contained each item, most recent first', async () => {
    await runWith('2026-09-14', ['A']);
    await runWith('2026-09-15', ['A', 'B']);
    await runWith('2026-09-16', ['A', 'B']);
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-18', null);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.get('A')).to.equal(4);
    expect(counts.has('B')).to.equal(false);
  });

  it('ends every streak at a date without a ranked items file', async () => {
    await runWith('2026-09-15', ['A']);
    await runWith('2026-09-16', null);
    await runWith('2026-09-17', ['A', 'B']);
    await runWith('2026-09-18', null);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.get('A')).to.equal(1);
    expect(counts.get('B')).to.equal(1);
  });

  it('reports the same streak for two forced runs of one date', async () => {
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-18', ['A']);
    await runWith('2026-09-18-f1', ['A']);
    const first = await previousItemCounts(dataDir, '2026-09-18');
    const forced = await previousItemCounts(dataDir, '2026-09-18-f1');
    expect(first.get('A')).to.equal(1);
    expect(forced.get('A')).to.equal(1);
  });

  it('counts one more on the first run of the next date', async () => {
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-18', ['A']);
    await runWith('2026-09-18-f1', ['A']);
    const next = await previousItemCounts(dataDir, '2026-09-19');
    expect(next.get('A')).to.equal(2);
  });

  it('ends the streak at a date whose latest run wrote no ranked items', async () => {
    await runWith('2026-09-16', ['A']);
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-17-f1', null);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.has('A')).to.equal(false);
  });

  it('does not break a streak when an aborted first run of a date was re-run', async () => {
    await runWith('2026-09-16', ['A']);
    await runWith('2026-09-17', null);
    await runWith('2026-09-17-f1', ['A']);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.get('A')).to.equal(2);
  });

  it('counts only dates strictly before its own when an older date is re-run', async () => {
    await runWith('2026-09-16', ['A']);
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-18', ['A']);
    const counts = await previousItemCounts(dataDir, '2026-09-17-f1');
    expect(counts.get('A')).to.equal(1);
  });

  it('takes the numerically last forced run as the one that speaks for its date', async () => {
    await runWith('2026-09-17', ['A']);
    await runWith('2026-09-17-f2', ['A']);
    await runWith('2026-09-17-f10', ['B']);
    const counts = await previousItemCounts(dataDir, '2026-09-18');
    expect(counts.has('A')).to.equal(false);
    expect(counts.get('B')).to.equal(1);
  });

  it('ends the streak at a date that shares no item with it', async () => {
    await runWith('2026-09-15', ['A']);
    await runWith('2026-09-16', ['B']);
    const counts = await previousItemCounts(dataDir, '2026-09-17');
    expect(counts.get('B')).to.equal(1);
    expect(counts.has('A')).to.equal(false);
  });

  it('lists the n most recent run ids before the current one', async () => {
    for (const id of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      await runWith(id, null);
    }
    expect(await previousRunIds(dataDir, '2026-09-18', 2)).to.deep.equal(['2026-09-17', '2026-09-16']);
    expect(await previousRunIds(dataDir, '2026-09-15', 2)).to.deep.equal([]);
  });
});

describe('rollup/history lastRunPerDate (revision 36)', () => {
  const ids = ['2026-09-15', '2026-09-16', '2026-09-16-f2', '2026-09-16-f10', '2026-09-17', '2026-09-18'];

  it('keeps the last run of each date, by its sequence, within the bounds given', () => {
    expect([...lastRunPerDate(ids).entries()]).to.deep.equal([
      ['2026-09-15', '2026-09-15'], ['2026-09-16', '2026-09-16-f10'], ['2026-09-17', '2026-09-17'],
      ['2026-09-18', '2026-09-18'],
    ]);
    expect([...lastRunPerDate(ids, { from: '2026-09-16', to: '2026-09-17' }).values()])
      .to.deep.equal(['2026-09-16-f10', '2026-09-17']);
    expect([...lastRunPerDate(ids, { before: '2026-09-17' }).keys()]).to.deep.equal(['2026-09-15', '2026-09-16']);
    // The persistence streak reads the same selection, most recent first.
    expect(analysedDatesBefore(ids, '2026-09-18')).to.deep.equal([
      ['2026-09-17', '2026-09-17'], ['2026-09-16', '2026-09-16-f10'], ['2026-09-15', '2026-09-15'],
    ]);
  });
});

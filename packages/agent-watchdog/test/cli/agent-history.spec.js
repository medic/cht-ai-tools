'use strict';
// The item-history tool answers in analysed dates (revision 22): one entry per date, from the last run of that
// date, over the most recent dates strictly before the current run's own. Forced re-runs of one date are one date.
const { itemHistoryFor } = require('../../src/cli/stages/agent');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const PROJECT = 'https://cht.example.org';
const SLUG = 'cht-example-org';
const METRIC = 'cht_sentinel_backlog_count';

describe('cli/stages/agent itemHistoryFor', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  const runWith = async (runId, metrics) => {
    const run = await RunDir.create(dataDir, runId);
    const items = metrics.map((metric, i) => ({
      item_id: `${runId.replace(/[^0-9]/g, '')}${i}`.padEnd(12, '0').slice(0, 12),
      metric, pattern_card: null, severity: 'medium', confidence: 0.6,
    }));
    await run.writeJson(`${SLUG}/passes.json`, { passes: [{ pass: 1, items }], items, converged: true });
  };

  it('returns one entry for a date analysed twice, from the later run', async () => {
    await runWith('2026-09-17', [METRIC]);
    await runWith('2026-09-17-f1', [METRIC]);
    const history = await itemHistoryFor(dataDir, '2026-09-18', SLUG)(PROJECT, METRIC, null);
    expect(history.map((h) => h.run_id)).to.deep.equal(['2026-09-17-f1']);
  });

  it('excludes earlier runs of the current run\'s own date: they are not history', async () => {
    await runWith('2026-09-17', [METRIC]);
    await runWith('2026-09-18', [METRIC]);
    const history = await itemHistoryFor(dataDir, '2026-09-18-f1', SLUG)(PROJECT, METRIC, null);
    expect(history.map((h) => h.run_id)).to.deep.equal(['2026-09-17']);
  });

  it('lets the numerically last forced run speak for its date', async () => {
    await runWith('2026-09-17', [METRIC]);
    await runWith('2026-09-17-f2', [METRIC]);
    await runWith('2026-09-17-f10', ['cht_outbound_push_backlog_count']);
    const history = await itemHistoryFor(dataDir, '2026-09-18', SLUG)(PROJECT, METRIC, null);
    expect(history).to.deep.equal([]);
  });

  it('counts its depth in dates, not runs', async () => {
    // Thirty-two consecutive dates, a recent one re-run three times: a run-keyed reading would spend three of its
    // thirty slots on the re-runs and list that date four times.
    const start = Date.UTC(2026, 7, 1);
    const dates = Array.from({ length: 32 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
    for (const date of dates) {
      await runWith(date, [METRIC]);
    }
    for (const suffix of ['-f1', '-f2', '-f3']) {
      await runWith(`2026-08-30${suffix}`, [METRIC]);
    }
    const history = await itemHistoryFor(dataDir, '2026-09-02', SLUG)(PROJECT, METRIC, null);
    const runIds = history.map((h) => h.run_id);
    expect(runIds).to.have.length(30);
    expect(new Set(runIds.map((id) => id.slice(0, 10))).size, 'one entry per date').to.equal(30);
    expect(runIds).to.include('2026-08-30-f3');
    expect(runIds).to.not.include('2026-08-30');
    expect(runIds).to.not.include('2026-08-01');
    expect(runIds).to.not.include('2026-08-02');
    expect(runIds[0]).to.equal('2026-08-03');
    expect(runIds[29]).to.equal('2026-09-01');
  });
});

describe('cli/stages/agent itemHistoryFor: the notes it serves are masked (FR-029, revision 36)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { dataPaths } = require('../../src/store/run-dir');
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('masks people, phones and e-mails in every note of the history', async () => {
    const run = await RunDir.create(dataDir, '2026-09-17');
    const item = { item_id: 'a1b2c3d4e5f6', metric: METRIC, pattern_card: null, severity: 'medium', confidence: 0.6 };
    await run.writeJson(`${SLUG}/passes.json`, {
      passes: [{ pass: 1, items: [item] }], items: [item], converged: true,
    });
    fs.writeFileSync(dataPaths(dataDir).feedbackFile, `${JSON.stringify({
      feedback_id: 'f1f1f1f1f1f1', date: '2026-09-18', run_id: '2026-09-17', target: 'item', item_id: item.item_id,
      kind: 'note', verdict: 'up', note: '<@U024BE7LH> says call +254 712 345 678, mail ops@example.org', author: 'U9',
      matched: true, source_ts: '1.1',
    })}\n`);
    const history = await itemHistoryFor(dataDir, '2026-09-18', SLUG)(PROJECT, METRIC, null);
    expect(history).to.have.length(1);
    expect(history[0].feedback).to.deep.equal([{
      verdict: 'up', note: '[person] says call [address], mail [address]', author: 'U9',
    }]);
    expect(path.basename(dataPaths(dataDir).feedbackFile)).to.equal('feedback.jsonl');
  });
});

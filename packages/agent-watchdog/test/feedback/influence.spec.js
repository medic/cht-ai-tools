// FR-060: feedback adjusts ranking only within the influence window, while every record stays on disk and a
// horizon stated in a note holds until its date.
const path = require('node:path');
const { ingestFeedback } = require('../../src/feedback/ingest');
const identity = require('../../src/model/identity');
const { appendRecords, readAll } = require('../../src/feedback/store');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const ALPHA = '49bd5cd2499f';
const record = (overrides) => ({
  feedback_id: overrides.feedback_id,
  date: overrides.date,
  run_id: overrides.run_id || '2026-06-30',
  target: 'item',
  item_id: ALPHA,
  kind: overrides.kind || 'reaction',
  verdict: overrides.verdict === undefined ? 'down' : overrides.verdict,
  note: overrides.note || null,
  horizon: overrides.horizon || null,
  author: 'U1',
  matched: true,
  source_ts: overrides.source_ts || '1751000000.000100',
});

// No earlier run exists, so nothing is read from Slack; the tallies come from the stored records alone.
const ingest = (dataDir, influenceDays) => ingestFeedback({
  client: {}, channel: 'C123', dataDir, runId: '2026-09-18', date: '2026-09-18', influenceDays,
  model: 'claude-fable-5-1', now: () => new Date('2026-09-18T06:05:00Z'),
});

describe('feedback/ingest: influence window (FR-060)', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    await RunDir.create(dataDir, '2026-09-18');
    await appendRecords(dataDir, [
      record({ feedback_id: 'aaaaaaaaaaaa', date: '2026-07-01', verdict: 'down' }),
      record({
        feedback_id: 'bbbbbbbbbbbb', date: '2026-06-01', kind: 'note', verdict: null,
        note: 'known migration, expected until 1 October', horizon: '2026-10-01', source_ts: '1748700000.000100',
      }),
      record({
        feedback_id: 'cccccccccccc', date: '2026-09-17', verdict: 'up', run_id: '2026-09-16',
        source_ts: '1758000000.000100',
      }),
    ]);
  });
  afterEach(() => removeDir(dataDir));

  it('counts only records inside the window for the tallies, keeps every record, and keeps the horizon', async () => {
    const doc = await ingest(dataDir, 30);
    expect(doc.influence).to.deep.equal({ days: 30, window_start: '2026-08-19' });
    expect(path.isAbsolute(doc.records_path)).to.equal(true);
    expect(doc.records_path.endsWith('feedback.jsonl')).to.equal(true);
    const alpha = doc.by_item[ALPHA];
    expect(alpha).to.include({ up: 1, down: 0, verdict: 'confirmed' });
    expect(alpha.notes).to.deep.equal([]);
    // The old note's horizon has not passed, so it still applies to ranking and suppression.
    expect(alpha.horizon).to.equal('2026-10-01');
    expect(doc.horizons.some((h) => h.item_id === ALPHA && h.horizon === '2026-10-01')).to.equal(true);
    expect((await readAll(dataDir)).map((r) => r.feedback_id).sort())
      .to.deep.equal(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
  });

  it('widens with the configured window and ignores a horizon that has passed', async () => {
    const wide = await ingest(dataDir, 120);
    expect(wide.influence.window_start).to.equal('2026-05-21');
    expect(wide.by_item[ALPHA]).to.include({ up: 1, down: 1, verdict: 'contested' });
    expect(wide.by_item[ALPHA].notes).to.deep.equal(['known migration, expected until 1 October']);
    await appendRecords(dataDir, [record({
      feedback_id: 'dddddddddddd', date: '2026-09-10', kind: 'note', verdict: null, run_id: '2026-09-09',
      note: 'quiet until 15 September', horizon: '2026-09-15', source_ts: '1757400000.000100',
    })]);
    const doc = await ingest(dataDir, 30);
    // The notes on one item are one conversation (FR-085, revision 29): the later note restated the expectation
    // as "until 15 September", so once that date has passed nothing holds the item back, however long the
    // earlier note's horizon was; a later note that extends the horizon wins the same way.
    expect(doc.by_item[ALPHA].horizon).to.equal(null);
    expect(doc.horizons).to.deep.equal([]);
    await appendRecords(dataDir, [record({
      feedback_id: 'eeeeeeeeeeee', date: '2026-09-17', kind: 'note', verdict: null, run_id: '2026-09-16',
      note: 'still migrating, until 15 October now', horizon: '2026-10-15', source_ts: '1758000001.000100',
    })]);
    const extended = await ingest(dataDir, 30);
    expect(extended.by_item[ALPHA].horizon).to.equal('2026-10-15');
    expect(extended.horizons.map((h) => [h.horizon, h.author_count, h.source]))
      .to.deep.equal([['2026-10-15', 1, 'stored']]);
  });
});

describe('feedback/ingest: a note read again keeps the horizon it was first given', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    const posted = await RunDir.create(dataDir, '2026-09-18');
    await posted.writeJson('rollup/publication.json', {
      channel_id: 'C123',
      ts: '1758175000.000100',
      permalink: null,
      replies: [{ item_id: ALPHA, ts: '1758175000.000200' }],
    });
    await posted.writeJson('rollup/items.ranked.json', [{
      item_id: ALPHA, project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', pattern_card: null,
    }]);
    await RunDir.create(dataDir, '2026-10-25');
    // The note was first read on 19 September and parsed to 1 October 2026; its id is the one ingestion derives.
    const noteId = identity.feedbackId('1758200000.000300', 'U1', 'note', null);
    await appendRecords(dataDir, [record({
      feedback_id: noteId, date: '2026-09-19', run_id: '2026-09-18', kind: 'note', verdict: null,
      note: 'alpha.example.org sentinel backlog: known migration, expected until 1 October', horizon: '2026-10-01',
      source_ts: '1758200000.000300',
    })]);
  });
  afterEach(() => removeDir(dataDir));

  it('does not re-parse a stored note against today, so "until 1 October" does not become next year', async () => {
    const client = {
      conversations: {
        replies: sinon.stub().resolves({
          ok: true,
          has_more: false,
          response_metadata: { next_cursor: '' },
          messages: [
            { type: 'message', ts: '1758175000.000100', thread_ts: '1758175000.000100', bot_id: 'B001', text: 'brief' },
            { type: 'message', ts: '1758175000.000200', thread_ts: '1758175000.000100', bot_id: 'B001', text: 'item' },
            {
              type: 'message', ts: '1758200000.000300', thread_ts: '1758175000.000100', user: 'U1',
              text: 'alpha.example.org sentinel backlog: known migration, expected until 1 October',
            },
          ],
        }),
      },
      reactions: {
        get: sinon.stub().resolves({ ok: true, type: 'message', message: { type: 'message', reactions: [] } }),
      },
    };
    const engine = { singleTurn: sinon.stub().rejects(new Error('must not be called')) };
    const doc = await ingestFeedback({
      client, channel: 'C123', dataDir, runId: '2026-10-25', date: '2026-10-25', influenceDays: 30, engine,
      model: 'claude-fable-5-1', now: () => new Date('2026-10-25T06:05:00Z'),
    });
    expect(doc.records).to.deep.equal([]);
    expect(doc.horizons).to.deep.equal([]);
    expect(doc.by_item[ALPHA].horizon).to.equal(null);
    expect(engine.singleTurn).to.not.have.been.called;
    const [stored] = await readAll(dataDir);
    expect(stored).to.include({ horizon: '2026-10-01', date: '2026-09-19' });
    expect((await readAll(dataDir))).to.have.length(1);
  });
});

const fs = require('node:fs');
const path = require('node:path');
const { ingestFeedback } = require('../../src/feedback/ingest');
const { appendRecords, readAll } = require('../../src/feedback/store');
const { RunDir } = require('../../src/store/run-dir');
const { schemas } = require('../../src/model/schemas');
const identity = require('../../src/model/identity');
const { createLogger } = require('../../src/log/logger');
const { loadJson, tempDir, removeDir } = require('../helpers/fixtures');
const { Writable } = require('node:stream');

const ALPHA = '49bd5cd2499f';
const GAMMA = 'a09c1ddc330a';
const BETA = 'aee954327c15';
const PARENT_TS = '1758088800.000100';
const ALPHA_TS = '1758088801.000200';
const GAMMA_TS = '1758088802.000300';
const P16 = '1758002400.000100';
const B16 = '1758002401.000200';

const quietLogger = () => createLogger({
  stream: new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  }),
  level: 'error',
});

// A Slack Web API stub driven by the recorded fixtures.
const fakeClient = () => {
  const page1 = loadJson('slack', 'replies-page1.json');
  const page2 = loadJson('slack', 'replies-page2.json');
  const replies16 = loadJson('slack', 'replies-2026-09-16.json');
  const reactions = { ...loadJson('slack', 'reactions.json'), ...loadJson('slack', 'reactions-2026-09-16.json') };
  const history = loadJson('slack', 'history-page.json');
  return {
    conversations: {
      replies: sinon.spy(async ({ ts, cursor }) => {
        if (ts === P16) {
          return replies16;
        }
        return cursor === 'cursor-page-2' ? page2 : page1;
      }),
      history: sinon.spy(async () => history),
    },
    reactions: {
      get: sinon.spy(async ({ timestamp }) => ({
        ok: true, type: 'message', message: { reactions: reactions[timestamp] || [] },
      })),
    },
    fixtures: { reactions },
  };
};

const seedRun = async (dataDir, runId, { publication = true, items = true } = {}) => {
  const run = await RunDir.create(dataDir, runId);
  await run.writeJson('run.json', { run_id: runId, status: 'published' });
  if (publication) {
    await run.writeJson('rollup/publication.json', loadJson('slack', 'publication-2026-09-17.json'));
  }
  if (items) {
    await run.writeJson('rollup/items.ranked.json', loadJson('slack', 'items-2026-09-17.json'));
  }
  return run;
};

const ingest = (dataDir, client, overrides = {}) => ingestFeedback({
  client,
  channel: 'C123',
  dataDir,
  runId: '2026-09-18',
  date: '2026-09-18',
  lookbackRuns: 7,
  since: null,
  engine: null,
  model: 'claude-fable-5-1',
  definition: null,
  logger: quietLogger(),
  now: () => new Date('2026-09-18T06:05:00Z'),
  ...overrides,
});

describe('feedback/ingest', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  it('pages replies, reads full reaction lists and records every verdict and note', async () => {
    await seedRun(dataDir, '2026-09-17');
    const client = fakeClient();
    const doc = await ingest(dataDir, client);

    expect(client.conversations.replies).to.have.been.calledTwice;
    const [first, second] = client.conversations.replies.getCalls().map((c) => c.args[0]);
    expect(first).to.include({ channel: 'C123', ts: PARENT_TS, include_all_metadata: true });
    expect(first.cursor).to.equal(undefined);
    expect(second.cursor).to.equal('cursor-page-2');
    expect(client.reactions.get.callCount).to.equal(3);
    for (const call of client.reactions.get.getCalls()) {
      expect(call.args[0]).to.include({ channel: 'C123', full: true });
    }
    const reactionTargets = client.reactions.get.getCalls().map((c) => c.args[0].timestamp).sort();
    expect(reactionTargets).to.deep.equal([PARENT_TS, ALPHA_TS, GAMMA_TS].sort());
    expect(client.conversations.history).to.not.have.been.called;

    for (const record of doc.records) {
      schemas.Feedback.parse(record);
      expect(record.date).to.equal('2026-09-18');
      expect(record.run_id).to.equal('2026-09-17');
    }
    const reactions = doc.records.filter((r) => r.kind === 'reaction');
    expect(reactions.map((r) => `${r.target}:${r.item_id}:${r.verdict}:${r.author}`).sort()).to.deep.equal([
      `brief:null:up:U9`,
      `item:${ALPHA}:down:U1`,
      `item:${GAMMA}:up:U1`,
      `item:${GAMMA}:up:U2`,
    ].sort());
    const briefReaction = reactions.find((r) => r.target === 'brief');
    expect(briefReaction.item_id).to.equal(null);
    expect(briefReaction.source_ts).to.equal(PARENT_TS);
    expect(briefReaction.feedback_id).to.equal(identity.feedbackId(PARENT_TS, 'U9', 'reaction', 'up'));

    const notes = doc.records.filter((r) => r.kind === 'note');
    expect(notes).to.have.length(4);
    const matched = notes.find((n) => n.matched && n.author === 'U1');
    expect(matched).to.include({ target: 'item', item_id: ALPHA, author: 'U1', horizon: '2026-10-01', verdict: null });
    expect(matched.note).to.include('known migration');
    // A note citing the item by rank with a thumbs written in it is that item's feedback with a verdict (revision 23).
    const byRank = notes.find((n) => n.author === 'U5');
    expect(byRank)
      .to.include({ target: 'item', item_id: ALPHA, matched: true, verdict: 'down', horizon: '2026-10-01' });
    expect(byRank.feedback_id).to.equal(identity.feedbackId('1758097000.000600', 'U5', 'note', null));
    const unmatched = notes.find((n) => !n.matched && n.author === 'U4');
    expect(unmatched).to.include({ target: 'brief', item_id: null, author: 'U4', note: 'what is this?' });
    // A thumbs that cites nothing stays unmatched, its verdict recorded but counted nowhere.
    const bareThumbs = notes.find((n) => n.author === 'U6');
    expect(bareThumbs).to.include({ target: 'brief', item_id: null, matched: false, verdict: 'up' });
    expect(doc.unmatched).to.deep.equal([unmatched, bareThumbs]);

    // Two notes on alpha state the same horizon: one entry for the thread, both authors counted (FR-085).
    expect(doc.horizons).to.have.length(1);
    expect(doc.horizons[0]).to.include({
      item_id: ALPHA, project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', pattern_card: null,
      horizon: '2026-10-01', expected_max: null, observed_value: 912, author_count: 2, source_run_id: '2026-09-17',
    });

    expect(doc.by_item[ALPHA]).to.include({
      up: 0, down: 2, retracted: 0, verdict: 'dismissed', horizon: '2026-10-01',
    });
    expect(doc.by_item[ALPHA].notes).to.deep.equal([matched.note, byRank.note]);
    expect(doc.by_item[GAMMA]).to.include({ up: 2, down: 0, retracted: 0, verdict: 'confirmed', horizon: null });
    expect(doc.brief).to.deep.equal({ up: 1, down: 0, notes: ['what is this?', ':+1:'] });
    expect(Object.keys(doc.projects).sort()).to.deep.equal(['https://alpha.example.org', 'https://gamma.example.org']);
    expect(doc.projects['https://alpha.example.org'].map((r) => r.kind).sort())
      .to.deep.equal(['note', 'note', 'reaction']);
    expect(doc.sources).to.deep.equal([
      { run_id: '2026-09-17', parent_ts: PARENT_TS, replies: 2, notes: 4, fallback: false },
    ]);
    expect(doc.run_id).to.equal('2026-09-18');
    expect((await readAll(dataDir)).length).to.equal(doc.records.length);
  });

  it('records a retraction when a recorded reaction is gone and counts it against that verdict', async () => {
    await seedRun(dataDir, '2026-09-17');
    await appendRecords(dataDir, [{
      feedback_id: identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'up'),
      date: '2026-09-17', run_id: '2026-09-17', target: 'item', item_id: GAMMA, kind: 'reaction', verdict: 'up',
      note: null, horizon: null, author: 'U3', matched: true, source_ts: GAMMA_TS,
    }]);
    const doc = await ingest(dataDir, fakeClient());
    const retraction = doc.records.find((r) => r.verdict === 'retracted');
    expect(retraction).to.include({
      author: 'U3', item_id: GAMMA, source_ts: GAMMA_TS, note: 'retracted: up', kind: 'reaction',
    });
    expect(retraction.feedback_id).to.equal(identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'retracted:up'));
    expect(doc.by_item[GAMMA]).to.include({ up: 2, retracted: 1, verdict: 'confirmed' });
  });

  it('records the retraction of an up and of a down by one person on one message as two records', async () => {
    await seedRun(dataDir, '2026-09-17');
    const base_ = {
      date: '2026-09-17', run_id: '2026-09-17', target: 'item', item_id: GAMMA, kind: 'reaction', note: null,
      horizon: null, author: 'U3', matched: true, source_ts: GAMMA_TS,
    };
    await appendRecords(dataDir, [
      { ...base_, feedback_id: identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'up'), verdict: 'up' },
      { ...base_, feedback_id: identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'down'), verdict: 'down' },
    ]);
    // The fixture shows neither reaction from U3 today.
    const doc = await ingest(dataDir, fakeClient());
    const retractions = doc.records.filter((r) => r.verdict === 'retracted' && r.author === 'U3');
    expect(retractions.map((r) => r.note).sort()).to.deep.equal(['retracted: down', 'retracted: up']);
    expect(new Set(retractions.map((r) => r.feedback_id)).size).to.equal(2);
    expect(retractions.map((r) => r.feedback_id).sort()).to.deep.equal([
      identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'retracted:up'),
      identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'retracted:down'),
    ].sort());
    expect(doc.by_item[GAMMA]).to.include({ retracted: 2 });
  });

  it('records a reaction added again after a recorded retraction under a new id, and counts it', async () => {
    await seedRun(dataDir, '2026-09-17');
    await appendRecords(dataDir, [
      {
        feedback_id: identity.feedbackId(GAMMA_TS, 'U1', 'reaction', 'up'),
        date: '2026-09-16', run_id: '2026-09-17', target: 'item', item_id: GAMMA, kind: 'reaction', verdict: 'up',
        note: null, horizon: null, author: 'U1', matched: true, source_ts: GAMMA_TS,
      },
      {
        feedback_id: identity.feedbackId(GAMMA_TS, 'U1', 'reaction', 'retracted:up'),
        date: '2026-09-17', run_id: '2026-09-17', target: 'item', item_id: GAMMA, kind: 'reaction',
        verdict: 'retracted',
        note: 'retracted: up', horizon: null, author: 'U1', matched: true, source_ts: GAMMA_TS,
      },
    ]);
    // The fixture shows U1's thumbs-up on the gamma reply again today.
    const doc = await ingest(dataDir, fakeClient());
    const readded = doc.records.find((r) => r.author === 'U1' && r.source_ts === GAMMA_TS && r.verdict === 'up');
    expect(readded, 'the re-added reaction is a new record').to.not.equal(undefined);
    expect(readded.feedback_id).to.equal(identity.feedbackId(GAMMA_TS, 'U1', 'reaction', 'up#1'));
    expect(doc.by_item[GAMMA]).to.include({ up: 2, retracted: 1, verdict: 'confirmed' });
    // Ingested again with nothing changed, nothing new is written.
    const again = await ingest(dataDir, fakeClient());
    expect(again.records.filter((r) => r.source_ts === GAMMA_TS)).to.deep.equal([]);
  });

  it('appends nothing new when the same feedback is ingested twice', async () => {
    await seedRun(dataDir, '2026-09-17');
    const first = await ingest(dataDir, fakeClient());
    const before = (await readAll(dataDir)).length;
    const second = await ingest(dataDir, fakeClient());
    expect(second.records).to.deep.equal([]);
    expect((await readAll(dataDir)).length).to.equal(before);
    expect(second.by_item[GAMMA].up).to.equal(first.by_item[GAMMA].up);
  });

  it('falls back to conversations.history when a run has no publication record', async () => {
    await seedRun(dataDir, '2026-09-16', { publication: false, items: false });
    const client = fakeClient();
    const doc = await ingest(dataDir, client);
    expect(client.conversations.history).to.have.been.calledOnce;
    const args = client.conversations.history.firstCall.args[0];
    expect(args).to.include({ channel: 'C123', include_all_metadata: true });
    expect(Number(args.oldest)).to.equal(Date.parse('2026-09-16T00:00:00Z') / 1000);
    expect(Number(args.latest)).to.equal(Date.parse('2026-09-17T00:00:00Z') / 1000);
    expect(client.conversations.replies.firstCall.args[0].ts).to.equal(P16);
    expect(doc.sources).to.deep.equal([
      { run_id: '2026-09-16', parent_ts: P16, replies: 1, notes: 0, fallback: true },
    ]);
    const beta = doc.records.find((r) => r.item_id === BETA);
    expect(beta).to.include({ verdict: 'up', author: 'U5', run_id: '2026-09-16', source_ts: B16 });
    expect(doc.by_item[BETA]).to.include({
      project_url: 'https://beta.example.org', metric: 'cht_conflict_count', verdict: 'confirmed',
    });
  });

  it('reads only runs on or after --since, and otherwise only the last N runs', async () => {
    await seedRun(dataDir, '2026-09-15', { publication: false, items: false });
    await seedRun(dataDir, '2026-09-16', { publication: false, items: false });
    await seedRun(dataDir, '2026-09-17');
    const sinceClient = fakeClient();
    const sinceDoc = await ingest(dataDir, sinceClient, { since: '2026-09-17' });
    expect(sinceClient.conversations.history).to.not.have.been.called;
    expect(sinceDoc.sources.map((s) => s.run_id)).to.deep.equal(['2026-09-17']);
    expect(sinceDoc.since).to.equal('2026-09-17');

    const lookbackClient = fakeClient();
    const lookbackDoc = await ingest(dataDir, lookbackClient, { lookbackRuns: 1 });
    expect(lookbackDoc.sources.map((s) => s.run_id)).to.deep.equal(['2026-09-17']);
    expect(lookbackClient.conversations.history).to.not.have.been.called;
  });

  it('skips a fallback run whose brief cannot be found in the history and says so', async () => {
    await seedRun(dataDir, '2026-09-14', { publication: false, items: false });
    const client = fakeClient();
    const doc = await ingest(dataDir, client);
    expect(doc.sources).to.deep.equal([
      { run_id: '2026-09-14', parent_ts: null, replies: 0, notes: 0, fallback: true },
    ]);
    expect(doc.records).to.deep.equal([]);
  });

  it('ignores runs dated on or after the current run', async () => {
    await seedRun(dataDir, '2026-09-19');
    const client = fakeClient();
    const doc = await ingest(dataDir, client);
    expect(doc.sources).to.deep.equal([]);
    expect(client.conversations.replies).to.not.have.been.called;
  });

  it('paces between Slack calls', async () => {
    await seedRun(dataDir, '2026-09-17');
    const pace = sinon.stub().resolves();
    await ingest(dataDir, fakeClient(), { pace });
    expect(pace.callCount).to.be.greaterThan(3);
  });
});

describe('cli/stages/feedback', () => {
  const stage = require('../../src/cli/stages/feedback');
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  const ctxFor = async (runDir, { slack, token = 'xoxb-test', flags = {} }) => ({
    runId: runDir.runId,
    date: '2026-09-18',
    runDir,
    flags,
    engine: null,
    definition: null,
    logger: quietLogger(),
    deps: slack ? { slack } : {},
    config: {
      secrets: { slackBotToken: token },
      endpoints: { slackChannelId: 'C123' },
      storage: { dataDir },
      behaviour: { feedbackLookbackRuns: 7, feedbackInfluenceDays: 30 },
      model: { feedback: 'claude-fable-5-1', effort: 'max' },
      bounds: { maxTurns: 20, maxBudgetUsdProject: 2, modelTimeoutMs: 900000 },
      paths: { promptsDir: path.join(__dirname, '..', '..', 'prompts') },
    },
  });

  it('writes an explicit skipped record when there are no Slack credentials', async () => {
    const runDir = await RunDir.create(dataDir, '2026-09-18');
    const result = await stage.run(await ctxFor(runDir, { slack: null, token: null }));
    const doc = await runDir.readJson('feedback.ingested.json');
    expect(doc).to.include({ run_id: '2026-09-18', skipped: 'no Slack credentials' });
    expect(doc.records).to.deep.equal([]);
    expect(doc.projects).to.deep.equal({});
    expect(result.records).to.equal(0);
  });

  it('ingests through the injected client and writes feedback.ingested.json', async () => {
    await seedRun(dataDir, '2026-09-17');
    const runDir = await RunDir.create(dataDir, '2026-09-18');
    const client = fakeClient();
    const result = await stage.run(await ctxFor(runDir, { slack: client }));
    const doc = await runDir.readJson('feedback.ingested.json');
    expect(doc.records.length).to.be.greaterThan(0);
    expect(doc.projects['https://alpha.example.org']).to.be.an('array');
    // The two notes on alpha share one horizon since revision 29 (FR-085).
    expect(result).to.include({ records: doc.records.length, unmatched: 2, horizons: 1, sources: 1 });
    expect(fs.existsSync(path.join(dataDir, 'feedback.jsonl'))).to.equal(true);
  });

  it('reviews the day\'s notes when an engine is present and records the review in the document', async () => {
    await seedRun(dataDir, '2026-09-17');
    const runDir = await RunDir.create(dataDir, '2026-09-18');
    const client = fakeClient();
    const engine = {
      singleTurn: sinon.stub().callsFake(async ({ name }) => ({
        structuredOutput: name === 'feedback-review'
          ? { classification: 'none', title: 't', lesson: 'l', projects_yaml: null, rationale: 'r' }
          : { horizon: null, expected_max: null, item_reference: null },
        result: {
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          total_cost_usd: 0.001, num_turns: 1, duration_ms: 1, session_id: 's',
        },
        toolCalls: [],
        referenceUnavailable: false,
      })),
    };
    const ctx = await ctxFor(runDir, { slack: client });
    ctx.engine = engine;
    const result = await stage.run(ctx);
    const doc = await runDir.readJson('feedback.ingested.json');
    expect(doc.influence).to.deep.equal({ days: 30, window_start: '2026-08-19' });
    expect(doc.review.classified.length).to.be.greaterThan(0);
    expect(doc.review.classified.every((c) => c.classification === 'none')).to.equal(true);
    expect(doc.review.unclassified).to.deep.equal([]);
    expect(doc.review.skipped_reactions).to.be.greaterThan(0);
    // Four notes, three calls: the two on alpha are one thread (FR-085), the two on no item one call each.
    expect(doc.review.classified).to.have.length(4);
    expect(doc.review.calls).to.have.length(3);
    expect(result.reviewed).to.equal(doc.review.classified.length);
    const reviewCalls = engine.singleTurn.getCalls().filter((c) => c.args[0].name === 'feedback-review');
    expect(reviewCalls.length).to.equal(doc.review.calls.length);
    const stored = (await readAll(dataDir)).filter((r) => r.kind === 'note');
    expect(stored.every((r) => r.classification === 'none')).to.equal(true);
  });

  it('counts a failed review attempt on every note it could not classify, run after run (revision 34)', async () => {
    await seedRun(dataDir, '2026-09-17');
    const engine = {
      singleTurn: sinon.stub().callsFake(async ({ name }) => {
        if (name === 'feedback-review') {
          throw new Error('model unavailable');
        }
        return {
          structuredOutput: { horizon: null, expected_max: null, item_reference: null },
          result: { subtype: 'success', usage: {}, total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: 's' },
          toolCalls: [],
          referenceUnavailable: false,
        };
      }),
    };
    const first = await RunDir.create(dataDir, '2026-09-18');
    const ctx1 = await ctxFor(first, { slack: fakeClient() });
    ctx1.engine = engine;
    await stage.run(ctx1);
    const doc = await first.readJson('feedback.ingested.json');
    expect(doc.review.unclassified.length).to.be.greaterThan(0);
    const notes = (await readAll(dataDir)).filter((r) => r.kind === 'note');
    expect(notes.length).to.be.greaterThan(0);
    expect(notes.map((r) => r.review_attempts)).to.deep.equal(notes.map(() => 1));
    const second = await RunDir.create(dataDir, '2026-09-19');
    const ctx2 = await ctxFor(second, { slack: fakeClient() });
    ctx2.engine = engine;
    await stage.run(ctx2);
    const again = (await readAll(dataDir)).filter((r) => r.kind === 'note');
    expect(again.map((r) => r.review_attempts)).to.deep.equal(again.map(() => 2));
  });

  it('records that review was skipped when no engine is available', async () => {
    await seedRun(dataDir, '2026-09-17');
    const runDir = await RunDir.create(dataDir, '2026-09-18');
    await stage.run(await ctxFor(runDir, { slack: fakeClient() }));
    const doc = await runDir.readJson('feedback.ingested.json');
    expect(doc.review).to.deep.equal({ skipped: 'no engine', classified: [], unclassified: [], calls: [] });
  });

  it('passes --since through to the ingester', async () => {
    await seedRun(dataDir, '2026-09-16', { publication: false, items: false });
    await seedRun(dataDir, '2026-09-17');
    const runDir = await RunDir.create(dataDir, '2026-09-18');
    const client = fakeClient();
    await stage.run(await ctxFor(runDir, { slack: client, flags: { since: '2026-09-17' } }));
    expect(client.conversations.history).to.not.have.been.called;
  });
});

describe('feedback/ingest: reactions and notes on alert-group replies (FR-066, User Story 8)', () => {
  const PARENT = '1758100000.000100';
  const ITEM_REPLY = '1758100001.000200';
  const ALERT_REPLY = '1758100002.000300';
  const NOTE_TS = '1758100003.000400';
  const items = loadJson('slack', 'items-2026-09-17.json');

  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const alertsClient = () => ({
    conversations: {
      replies: sinon.spy(async () => ({
        ok: true,
        has_more: false,
        response_metadata: { next_cursor: '' },
        messages: [
          {
            type: 'message', ts: PARENT, thread_ts: PARENT, bot_id: 'B001', text: 'brief',
            metadata: {
              event_type: 'agent_watchdog.brief',
              event_payload: { run_id: '2026-09-17', date: '2026-09-17', kind: 'brief' },
            },
          },
          {
            type: 'message', ts: ITEM_REPLY, thread_ts: PARENT, bot_id: 'B001', text: 'item',
            metadata: {
              event_type: 'agent_watchdog.item',
              event_payload: {
                run_id: '2026-09-17', item_id: items[0].item_id, project_url: items[0].project_url,
                metric: items[0].metric,
              },
            },
          },
          {
            type: 'message', ts: ALERT_REPLY, thread_ts: PARENT, bot_id: 'B001', text: 'alerts',
            metadata: {
              event_type: 'agent_watchdog.alerts',
              event_payload: {
                run_id: '2026-09-17', date: '2026-09-17', group: 'North Programme', category: 'backlog', firing: 5,
              },
            },
          },
          {
            type: 'message', ts: NOTE_TS, thread_ts: PARENT, user: 'U7',
            text: 'North Programme backlog alerts: known migration, ignore this week',
          },
        ],
      })),
      history: sinon.stub().resolves({
        ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' },
      }),
    },
    reactions: {
      get: sinon.spy(async ({ timestamp }) => ({
        ok: true, type: 'message',
        message: { reactions: timestamp === ALERT_REPLY ? [{ name: '-1', users: ['U7', 'U8'], count: 2 }] : [] },
      })),
    },
  });

  it('records a thumbs-down on an alert-group reply and a note naming the group against the alert key', async () => {
    const run = await RunDir.create(dataDir, '2026-09-17');
    await run.writeJson('run.json', { run_id: '2026-09-17', status: 'published' });
    await run.writeJson('rollup/publication.json', {
      channel_id: 'C123', ts: PARENT, permalink: null,
      replies: [
        { item_id: items[0].item_id, alert_key: null, ts: ITEM_REPLY },
        { item_id: null, alert_key: 'North Programme/backlog', ts: ALERT_REPLY },
      ],
    });
    await run.writeJson('rollup/items.ranked.json', items);
    const client = alertsClient();
    const doc = await ingest(dataDir, client);
    const alertRecords = doc.records.filter((r) => r.target === 'alert_group');
    expect(alertRecords.map((r) => `${r.kind}:${r.verdict}:${r.author}`).sort()).to.deep.equal([
      'note:null:U7', 'reaction:down:U7', 'reaction:down:U8',
    ]);
    for (const record of alertRecords) {
      schemas.Feedback.parse(record);
      expect(record).to.include({ alert_key: 'North Programme/backlog', item_id: null, matched: true });
    }
    expect(doc.alerts['North Programme/backlog']).to.deep.include({ up: 0, down: 2 });
    expect(doc.alerts['North Programme/backlog'].notes)
      .to.deep.equal(['North Programme backlog alerts: known migration, ignore this week']);
    // Alert feedback never touches an item's tallies or the unmatched list.
    expect(Object.keys(doc.by_item)).to.deep.equal([]);
    expect(doc.unmatched).to.deep.equal([]);
    expect((await readAll(dataDir)).filter((r) => r.target === 'alert_group')).to.have.length(3);
  });
});

describe('feedback/ingest: the notes on one item are one conversation (FR-085, revision 29)', () => {
  const PARENT = PARENT_TS;
  const parent = {
    type: 'message', ts: PARENT, thread_ts: PARENT, bot_id: 'B001', text: 'brief',
    metadata: {
      event_type: 'agent_watchdog.brief', event_payload: { run_id: '2026-09-17', date: '2026-09-17', kind: 'brief' },
    },
  };
  const messageOf = (ts, user, text) => ({ type: 'message', ts, thread_ts: PARENT, user, text });
  const clientWith = (messages) => ({
    conversations: {
      replies: sinon.stub().resolves({
        ok: true, messages: [parent, ...messages], has_more: false, response_metadata: { next_cursor: '' },
      }),
      history: sinon.stub().resolves({
        ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' },
      }),
    },
    reactions: { get: sinon.stub().resolves({ ok: true, type: 'message', message: { reactions: [] } }) },
  });
  const storedNote = (overrides) => ({
    feedback_id: 'a1a1a1a1a1a1', date: '2026-09-17', run_id: '2026-09-16', target: 'item', item_id: ALPHA,
    alert_key: null, kind: 'note', verdict: null, note: 'expected until 1 October', horizon: '2026-10-01',
    author: 'U1', matched: true, source_ts: '1758002500.000001', acknowledged_run_id: '2026-09-17',
    classification: 'expectation', proposal_id: null, ...overrides,
  });
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await RunDir.create(dataDir, '2026-09-18');
    await seedRun(dataDir, '2026-09-17');
  });
  afterEach(() => removeDir(dataDir));

  const FIRST_NOTE = 'alpha.example.org sentinel backlog: known migration, expected until 1 October';

  it('applies the last horizon the thread states, once, while every record keeps its own', async () => {
    const client = clientWith([
      messageOf('1758090000.000001', 'U1', FIRST_NOTE),
      messageOf('1758090000.000002', 'U7', '#1 correction: the migration ends sooner, expected until 25 September'),
      messageOf('1758090000.000003', 'U8', '#1 thanks, noted'),
    ]);
    const doc = await ingest(dataDir, client);
    const notes = doc.records.filter((r) => r.kind === 'note');
    expect(notes.map((r) => r.horizon)).to.deep.equal(['2026-10-01', '2026-09-25', null]);
    expect(notes.every((r) => r.item_id === ALPHA && r.matched)).to.equal(true);
    expect(doc.horizons).to.have.length(1);
    expect(doc.horizons[0]).to.include({
      item_id: ALPHA, project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count',
      horizon: '2026-09-25', author_count: 3, source_run_id: '2026-09-17', observed_value: 912,
    });
    expect(doc.horizons[0].note).to.include('correction');
    expect(doc.by_item[ALPHA].horizon).to.equal('2026-09-25');
    expect(doc.by_item[ALPHA].notes).to.have.length(3);
  });

  it('never pushes a stored horizon a later stored note corrected, and follows the correction in by_item', async () => {
    await appendRecords(dataDir, [
      storedNote({}),
      storedNote({
        feedback_id: 'a2a2a2a2a2a2', source_ts: '1758002500.000002', author: 'U7',
        note: 'correction: until 20 September', horizon: '2026-09-20',
      }),
    ]);
    const doc = await ingest(dataDir, clientWith([]));
    expect(doc.horizons.map((h) => h.horizon)).to.deep.equal(['2026-09-20']);
    expect(doc.horizons[0]).to.include({ item_id: ALPHA, source: 'stored', author_count: 2 });
    expect(doc.by_item[ALPHA].horizon).to.equal('2026-09-20');
    // A correction that has already passed leaves no horizon at all, however long the first note's was.
    await appendRecords(dataDir, [storedNote({
      feedback_id: 'a3a3a3a3a3a3', source_ts: '1758002500.000003', author: 'U9', note: 'ended, until 2026-09-10',
      horizon: '2026-09-10',
    })]);
    const later = await ingest(dataDir, clientWith([]));
    expect(later.horizons).to.deep.equal([]);
    expect(later.by_item[ALPHA].horizon).to.equal(null);
  });

  it('hands a dateless note to the model with the earlier notes of its thread as untrusted context', async () => {
    const engine = {
      singleTurn: sinon.stub().resolves({
        structuredOutput: { horizon: '2026-09-25', expected_max: null, item_reference: null },
        result: { subtype: 'success' },
      }),
    };
    const client = clientWith([
      messageOf('1758090000.000001', 'U1', FIRST_NOTE),
      messageOf('1758090000.000002', 'U7', '#1 make that the 25th'),
    ]);
    const doc = await ingest(dataDir, client, { engine });
    expect(engine.singleTurn).to.have.been.calledOnce;
    const prompt = engine.singleTurn.firstCall.args[0].userPrompt;
    expect(prompt).to.include(`<untrusted source="earlier-notes">\n1. ${FIRST_NOTE}\n</untrusted>`);
    expect(prompt.indexOf('earlier-notes')).to.be.lessThan(prompt.indexOf('<untrusted source="slack-note">'));
    expect(prompt).to.not.match(/\bU[17]\b/);
    expect(doc.horizons.map((h) => h.horizon)).to.deep.equal(['2026-09-25']);
    expect(doc.records.filter((r) => r.kind === 'note').map((r) => r.horizon))
      .to.deep.equal(['2026-10-01', '2026-09-25']);
  });
  it('stores the expected maximum and the observed value on the note; a stored horizon keeps its size', async () => {
    const client = clientWith([
      messageOf('1758090000.000001', 'U1', 'alpha.example.org sentinel backlog: expected up to 1,500 until 1 October'),
    ]);
    const doc = await ingest(dataDir, client);
    const [note] = doc.records.filter((r) => r.kind === 'note');
    expect(note).to.include({
      horizon: '2026-10-01', expected_max: 1500, observed_value: 912, horizon_source: 'deterministic',
    });
    expect(doc.horizons[0]).to.include({ horizon: '2026-10-01', expected_max: 1500, observed_value: 912 });
    // The next day nothing is parsed again, and the stored record still says how large "expected" is.
    const tomorrow = await ingestFeedback({
      client: clientWith([]), channel: 'C123', dataDir, runId: '2026-09-19', date: '2026-09-19', lookbackRuns: 7,
      model: 'claude-fable-5-1', logger: quietLogger(), now: () => new Date('2026-09-19T06:05:00Z'),
    });
    expect(tomorrow.horizons[0]).to.include({
      horizon: '2026-10-01', expected_max: 1500, observed_value: 912, source: 'stored',
    });
  });

  it('resolves a horizon against the date the note was written, not the run date (revision 34)', async () => {
    // Written on 15 September; read by a run on 25 October: "until 30 September" is 2026-09-30, and it has passed.
    const client = clientWith([
      messageOf('1789473600.000001', 'U1', 'alpha.example.org sentinel backlog: expected until 30 September'),
    ]);
    const doc = await ingest(dataDir, client, {
      runId: '2026-10-25', date: '2026-10-25', now: () => new Date('2026-10-25T06:05:00Z'),
    });
    const [note] = doc.records.filter((r) => r.kind === 'note');
    expect(note).to.include({ horizon: '2026-09-30', date: '2026-10-25' });
    expect(doc.horizons).to.deep.equal([]);
    expect(doc.by_item[ALPHA].horizon).to.equal(null);
  });

  it('logs a failed model parse, stores its source, retries it next run and counts the call', async () => {
    const message = messageOf('1758090000.000002', 'U7', '#1 make that the 25th');
    const failing = { singleTurn: sinon.stub().rejects(new Error('model unavailable')) };
    const logger = { warn: sinon.spy(), info: sinon.spy(), debug() {}, error() {} };
    logger.child = () => logger;
    const first = await ingest(dataDir, clientWith([messageOf('1758090000.000001', 'U1', FIRST_NOTE), message]), {
      engine: failing, logger,
    });
    const stored = first.records.find((r) => r.source_ts === message.ts);
    expect(stored).to.include({ horizon: null, horizon_source: 'model-failed' });
    expect(logger.warn)
      .to.have.been.calledWithMatch('feedback.parse_failed', sinon.match({ feedback_id: stored.feedback_id }));
    expect(first.calls).to.deep.equal([]);
    expect(first.horizons.map((h) => h.horizon)).to.deep.equal(['2026-10-01']);

    const working = {
      singleTurn: sinon.stub().resolves({
        structuredOutput: { horizon: '2026-09-25', expected_max: null, item_reference: null },
        result: { subtype: 'success', usage: { input_tokens: 40, output_tokens: 8 }, total_cost_usd: 0.002 },
      }),
    };
    const second = await ingestFeedback({
      client: clientWith([messageOf('1758090000.000001', 'U1', FIRST_NOTE), message]), channel: 'C123', dataDir,
      runId: '2026-09-19', date: '2026-09-19', lookbackRuns: 7, engine: working, model: 'claude-fable-5-1', logger,
      now: () => new Date('2026-09-19T06:05:00Z'),
    });
    expect(working.singleTurn).to.have.been.calledOnce;
    const retried = (await readAll(dataDir)).find((r) => r.source_ts === message.ts);
    expect(retried).to.include({ horizon: '2026-09-25', horizon_source: 'model' });
    expect(logger.info)
      .to.have.been.calledWithMatch('feedback.parse_retried', sinon.match({ feedback_id: retried.feedback_id }));
    expect(second.horizons.map((h) => h.horizon)).to.deep.equal(['2026-09-25']);
    expect(second.calls).to.have.length(1);
    expect(second.calls[0]).to.include({
      stage: 'feedback', kind: 'parse', model: 'claude-fable-5-1', cost_usd: 0.002, run_id: '2026-09-19', pass: null,
      project_url: null,
    });
  });
});

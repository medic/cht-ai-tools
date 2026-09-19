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
    expect(notes).to.have.length(2);
    const matched = notes.find((n) => n.matched);
    expect(matched).to.include({ target: 'item', item_id: ALPHA, author: 'U1', horizon: '2026-10-01', verdict: null });
    expect(matched.note).to.include('known migration');
    const unmatched = notes.find((n) => !n.matched);
    expect(unmatched).to.include({ target: 'brief', item_id: null, author: 'U4', note: 'what is this?' });
    expect(doc.unmatched).to.deep.equal([unmatched]);

    expect(doc.horizons).to.have.length(1);
    expect(doc.horizons[0]).to.include({
      item_id: ALPHA, project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', pattern_card: null,
      horizon: '2026-10-01', expected_max: null, observed_value: 912, author_count: 1, source_run_id: '2026-09-17',
    });

    expect(doc.by_item[ALPHA]).to.include({
      up: 0, down: 1, retracted: 0, verdict: 'dismissed', horizon: '2026-10-01',
    });
    expect(doc.by_item[ALPHA].notes).to.deep.equal([matched.note]);
    expect(doc.by_item[GAMMA]).to.include({ up: 2, down: 0, retracted: 0, verdict: 'confirmed', horizon: null });
    expect(doc.brief).to.deep.equal({ up: 1, down: 0, notes: ['what is this?'] });
    expect(Object.keys(doc.projects).sort()).to.deep.equal(['https://alpha.example.org', 'https://gamma.example.org']);
    expect(doc.projects['https://alpha.example.org'].map((r) => r.kind).sort()).to.deep.equal(['note', 'reaction']);
    expect(doc.sources).to.deep.equal([
      { run_id: '2026-09-17', parent_ts: PARENT_TS, replies: 2, notes: 2, fallback: false },
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
    expect(retraction.feedback_id).to.equal(identity.feedbackId(GAMMA_TS, 'U3', 'reaction', 'retracted'));
    expect(doc.by_item[GAMMA]).to.include({ up: 2, retracted: 1, verdict: 'confirmed' });
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
      behaviour: { feedbackLookbackRuns: 7 },
      model: { feedback: 'claude-fable-5-1' },
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
    expect(result).to.include({ records: doc.records.length, unmatched: 1, horizons: 1, sources: 1 });
    expect(fs.existsSync(path.join(dataDir, 'feedback.jsonl'))).to.equal(true);
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

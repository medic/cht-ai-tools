// End-to-end User Story 2: day one posts the brief, people react and leave notes, day two reads them.
// Real stages, fake Grafana replaying the same shapes a day later, a scripted model, a stubbed Slack client.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { fakeSlack, runCase } = require('./helpers');

const DAY1 = '2026-09-18';
const DAY2 = '2026-09-19';

const readJsonl = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

// A Slack client whose thread and reactions come from day one's publication. Since revision 28 the thread's replies
// are code-built (programme, Other, alerts): a reaction on them is not feedback on an item, and they are never notes.
const slackWithFeedback = ({ publication, notes, reactionsByTs }) => {
  const slack = fakeSlack();
  const parent = {
    type: 'message',
    ts: publication.ts,
    thread_ts: publication.ts,
    bot_id: 'B001',
    text: 'Watchdog brief',
    reply_count: publication.replies.length + notes.length,
    metadata: { event_type: 'agent_watchdog.brief', event_payload: { run_id: DAY1, date: DAY1, kind: 'brief' } },
  };
  const replies = publication.replies.map((reply) => ({
    type: 'message',
    ts: reply.ts,
    thread_ts: publication.ts,
    bot_id: 'B001',
    text: `${reply.kind} ${reply.group || ''}`.trim(),
    metadata: {
      event_type: reply.kind === 'alerts' ? 'agent_watchdog.alerts' : 'agent_watchdog.programme',
      event_payload: { run_id: DAY1, date: DAY1, kind: reply.kind, group: reply.group },
    },
  }));
  const noteMessages = notes.map((note, i) => ({
    type: 'message',
    ts: `1700000100.00000${i + 1}`,
    thread_ts: publication.ts,
    user: note.user,
    text: note.text,
  }));
  slack.conversations = {
    replies: sinon.spy(async () => ({
      ok: true,
      messages: [parent, ...replies, ...noteMessages],
      has_more: false,
      response_metadata: { next_cursor: '' },
    })),
    history: sinon.stub().resolves({ ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } }),
  };
  slack.reactions = {
    get: sinon.spy(async ({ timestamp }) => ({
      ok: true,
      type: 'message',
      message: { type: 'message', ts: timestamp, reactions: reactionsByTs[timestamp] || [] },
    })),
  };
  return slack;
};

describe('e2e: User Story 2, feedback that changes tomorrow\'s brief', function () {
  this.timeout(60000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => {
    if (process.env.E2E_KEEP) {
      console.log(`E2E_KEEP: run directory kept at ${dataDir}`);
      return;
    }
    removeDir(dataDir);
  });

  it('records notes with their thumbs, honours the horizon, raises confidence and appends outcomes', async () => {
    // Day one: the brief is posted; the flagged projects are in the body, the report in the thread, and no item has
    // a reply of its own (revision 28), so feedback on an item is a thread note citing it (FR-027).
    const day1 = await runCase({ caseName: 'seeded-anomaly', dataDir, date: DAY1 });
    expect(day1.error, day1.error && day1.error.stack).to.equal(undefined);
    const publication = day1.read('rollup/publication.json');
    expect(publication.replies.some((r) => r.item_id), 'no item replies').to.equal(false);
    const items = day1.read('rollup/items.ranked.json');
    const alpha = items.find((i) => i.project_url === 'https://alpha.example.org');
    const gamma = items.find((i) => i.project_url === 'https://gamma.example.org');
    expect(alpha && gamma, 'both projects are flagged').to.exist;

    // People write in the thread: a thumbs-down note with a horizon on alpha, two thumbs-up notes on gamma citing
    // its number in the report, a thumbs-up reaction on the brief itself, and one note nobody can match.
    const slack = slackWithFeedback({
      publication,
      notes: [
        { user: 'U1', text: '👎 alpha.example.org sentinel backlog: known migration, expected until 1 October' },
        { user: 'U1', text: `#${gamma.rank} :+1: confirmed, the target is down` },
        { user: 'U2', text: `#${gamma.rank} 👍` },
        { user: 'U9', text: 'is anyone looking at the other one?' },
      ],
      reactionsByTs: {
        [publication.ts]: [{ name: '+1', users: ['U3'], count: 1 }],
      },
    });

    // Day two: the same shapes recur; the feedback must change the brief.
    const day2 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: DAY2, runStart: `${DAY2}T06:00:00Z`, slack,
    });
    expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
    expect(day2.read('run.json').status).to.equal('published');

    // Scenario 1: stored with identity, verdict, note and author; horizon parsed; memory holds the note;
    // the pattern is not flagged again before the horizon.
    const records = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    const alphaNote = records.find((r) => r.item_id === alpha.item_id && r.kind === 'note');
    // The thumbs written in the note is its verdict (FR-027).
    expect(alphaNote).to.include({
      target: 'item', kind: 'note', verdict: 'down', author: 'U1', run_id: DAY1, matched: true, horizon: '2026-10-01',
    });
    expect(alphaNote.note).to.include('known migration');
    const ingested = day2.read('feedback.ingested.json');
    expect(ingested.horizons.some((h) => h.item_id === alpha.item_id && h.horizon === '2026-10-01')).to.equal(true);
    expect(ingested.by_item[alpha.item_id].verdict).to.equal('dismissed');
    const memory = fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8');
    expect(memory).to.include('known migration');
    expect(fs.existsSync(path.join(dataDir, 'memory', 'history', `${DAY2}.patch`))).to.equal(true);
    expect(fs.existsSync(path.join(day2.root, 'memory.patch'))).to.equal(true);
    const suppressed = day2.read('alpha-example-org/suppressed.json');
    expect(suppressed.some((s) => s.horizon === '2026-10-01')).to.equal(true);
    const alphaCandidates = day2.read('alpha-example-org/candidates.json');
    expect(alphaCandidates.some((c) => c.metric.startsWith('cht_sentinel_backlog_count'))).to.equal(false);
    const ranked2 = day2.read('rollup/items.ranked.json');
    expect(ranked2.some((i) => i.project_url === 'https://alpha.example.org')).to.equal(false);

    // Scenario 2: two thumbs-up notes are both recorded and the pattern's confidence rises.
    const gammaUps = records.filter((r) => r.item_id === gamma.item_id && r.verdict === 'up');
    expect(gammaUps.map((r) => r.author).sort()).to.deep.equal(['U1', 'U2']);
    expect(gammaUps.every((r) => r.kind === 'note' && r.matched)).to.equal(true);
    expect(ingested.by_item[gamma.item_id]).to.include({ verdict: 'confirmed', up: 2, down: 0 });
    const gamma2 = ranked2.find((i) => i.project_url === 'https://gamma.example.org');
    expect(gamma2.confidence).to.be.greaterThan(gamma.confidence);
    expect(gamma2.persisting_days).to.equal(2);

    // Scenario 3: a reaction on the parent is feedback on the brief as a whole.
    const briefFeedback = records.find((r) => r.target === 'brief');
    expect(briefFeedback).to.include({ item_id: null, verdict: 'up', author: 'U3' });

    // Scenario 4: the unmatched note is recorded as such and surfaced in the next brief's thread.
    const unmatched = records.find((r) => r.kind === 'note' && r.matched === false);
    expect(unmatched.note).to.include('the other one');
    expect(ingested.unmatched).to.have.length(1);
    const payload2 = day2.read('rollup/payload.json');
    // Since User Story 7 the unmatched note is listed in the feedback digest, the one acknowledgement reply per run.
    expect(payload2.replies.some((reply) => reply.kind === 'unmatched_notes')).to.equal(false);
    expect(payload2.digest, 'feedback digest present').to.not.equal(null);
    expect(payload2.digest.text, 'unmatched note surfaced in the digest').to.include('the other one');

    // Scenario 5: confirmed and dismissed items are appended to the corpus as run outcomes.
    const outcomes = readJsonl(path.join(dataDir, 'corpus', 'outcomes', `${DAY2}.jsonl`));
    expect(outcomes.find((o) => o.item_id === gamma.item_id)).to.include({ outcome: 'confirmed' });
    expect(outcomes.find((o) => o.item_id === alpha.item_id)).to.include({ outcome: 'dismissed' });

    // Reads were driven from the stored publication, not by scanning history; the brief is the only reaction target.
    expect(slack.conversations.replies).to.have.been.calledOnce;
    expect(slack.conversations.history).to.not.have.been.called;
    expect(slack.reactions.get.callCount).to.equal(1);
  });

  it('re-ingesting the same feedback adds nothing and records a retraction when a reaction disappears', async () => {
    const day1 = await runCase({ caseName: 'seeded-anomaly', dataDir, date: DAY1 });
    expect(day1.error, day1.error && day1.error.stack).to.equal(undefined);
    const publication = day1.read('rollup/publication.json');
    const items = day1.read('rollup/items.ranked.json');
    const gamma = items.find((i) => i.project_url === 'https://gamma.example.org');
    const notes = [{ user: 'U1', text: `#${gamma.rank} 👍 confirmed` }];

    const withUp = slackWithFeedback({
      publication, notes, reactionsByTs: { [publication.ts]: [{ name: '+1', users: ['U2'], count: 1 }] },
    });
    const day2 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: DAY2, runStart: `${DAY2}T06:00:00Z`, slack: withUp,
    });
    expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
    const afterDay2 = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    expect(afterDay2.filter((r) => r.verdict === 'up').map((r) => r.target).sort()).to.deep.equal(['brief', 'item']);
    expect(afterDay2.find((r) => r.kind === 'note')).to.include({ item_id: gamma.item_id, author: 'U1' });

    // The next day the same note is read again and adds nothing; the reaction on the brief is gone, so a
    // retraction is recorded.
    const withoutUp = slackWithFeedback({ publication, notes, reactionsByTs: {} });
    const day3 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: '2026-09-20', runStart: '2026-09-20T06:00:00Z', slack: withoutUp,
    });
    expect(day3.error, day3.error && day3.error.stack).to.equal(undefined);
    const afterDay3 = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    expect(afterDay3.filter((r) => r.kind === 'note')).to.have.length(1);
    expect(afterDay3.filter((r) => r.verdict === 'up')).to.have.length(2);
    const retraction = afterDay3.find((r) => r.verdict === 'retracted');
    expect(retraction).to.include({ target: 'brief', item_id: null, author: 'U2' });
  });
});

// End-to-end User Story 7: day one posts the brief, people react and leave notes, day two acknowledges every
// record once with a digest, turns the notes into proposals and reacts on them; the records stay on disk for
// ever while their influence on ranking expires. Real stages, a fake Grafana replaying the same shapes on later
// days, a scripted model, a stubbed Slack client and a fake browser. Nothing touches the network.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const calibrate = require('../../src/cli/commands/calibrate');
const { readProposals } = require('../../src/rollup/proposals');
const { purge } = require('../../src/store/retention');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { fakeSlack, runCase, envFor, capture, fakeTracer } = require('./helpers');

const DAY1 = '2026-09-18';
const DAY2 = '2026-09-19';
const DAY3 = '2026-10-25';
const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const REVIEWED = ['prompts', 'skill', 'schema', 'agent', path.join('config', 'defaults')];
const AUTHORS = /\b(U1|U2|U3|U4|U5|U9|U0123ABCD)\b|<@/;

const readJsonl = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

const hashTree = (dir) => {
  const hash = crypto.createHash('sha256');
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        hash.update(path.relative(dir, full)).update('\0').update(fs.readFileSync(full)).update('\0');
      }
    }
  };
  visit(dir);
  return hash.digest('hex');
};
const reviewedHashes = () => Object.fromEntries(REVIEWED.map((rel) => [rel, hashTree(path.join(PACKAGE_ROOT, rel))]));

// A Slack client whose thread and reactions come from day one's publication, and that accepts reactions.
const slackWithFeedback = ({ publication, items, notes, reactionsByTs }) => {
  const slack = fakeSlack();
  const parent = {
    type: 'message', ts: publication.ts, thread_ts: publication.ts, bot_id: 'B001', text: 'Watchdog brief',
    reply_count: publication.replies.length + notes.length,
    metadata: { event_type: 'agent_watchdog.brief', event_payload: { run_id: DAY1, date: DAY1, kind: 'brief' } },
  };
  const replies = publication.replies.map((reply) => {
    const item = items.find((i) => i.item_id === reply.item_id);
    return {
      type: 'message', ts: reply.ts, thread_ts: publication.ts, bot_id: 'B001', text: `item ${reply.item_id}`,
      metadata: {
        event_type: 'agent_watchdog.item',
        event_payload: { run_id: DAY1, item_id: reply.item_id, project_url: item.project_url, metric: item.metric },
      },
    };
  });
  const noteMessages = notes.map((note, i) => ({
    type: 'message', ts: `1700000100.00000${i + 1}`, thread_ts: publication.ts, user: note.user, text: note.text,
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
    add: sinon.stub().resolves({ ok: true }),
  };
  return { slack, noteMessages };
};

describe('e2e: User Story 7, feedback acknowledged and made permanent', function () {
  this.timeout(90000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('acknowledges once, turns notes into proposals, keeps the records and expires their influence', async () => {
    const before = reviewedHashes();
    const day1 = await runCase({ caseName: 'seeded-anomaly', dataDir, date: DAY1 });
    expect(day1.error, day1.error && day1.error.stack).to.equal(undefined);
    const publication = day1.read('rollup/publication.json');
    const items = day1.read('rollup/items.ranked.json');
    const alpha = items.find((i) => i.project_url === 'https://alpha.example.org');
    const gamma = items.find((i) => i.project_url === 'https://gamma.example.org');
    const alphaReply = publication.replies.find((r) => r.item_id === alpha.item_id);
    const gammaReply = publication.replies.find((r) => r.item_id === gamma.item_id);

    // Four reactions and four notes: an expectation with a horizon, a project fact, a wording complaint with a
    // mention in it, and one note nobody can match.
    const { slack, noteMessages } = slackWithFeedback({
      publication,
      items,
      notes: [
        { user: 'U1', text: 'alpha.example.org sentinel backlog: known migration, expected until 1 October' },
        {
          user: 'U4',
          text: 'alpha.example.org cht_sentinel_backlog_count is normally around 300, that is its usual baseline',
        },
        { user: 'U5', text: 'gamma.example.org: the bullet wording is too long, put the window first <@U0123ABCD>' },
        { user: 'U9', text: 'is anyone looking at the other one?' },
      ],
      reactionsByTs: {
        [alphaReply.ts]: [{ name: '-1', users: ['U1'], count: 1 }],
        [gammaReply.ts]: [{ name: '+1', users: ['U1', 'U2'], count: 2 }],
        [publication.ts]: [{ name: '+1', users: ['U3'], count: 1 }],
      },
    });

    const day2 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: DAY2, runStart: `${DAY2}T06:00:00Z`, slack,
    });
    expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
    expect(day2.read('run.json').status).to.equal('published');
    const records = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    expect(records).to.have.length(8);

    // Scenario 1: one digest in the new brief's thread naming each item's effect and the retention statement.
    const payload2 = day2.read('rollup/payload.json');
    expect(payload2.digest, 'digest in the payload').to.not.equal(null);
    const digest = day2.read('rollup/feedback.digest.json');
    expect(digest.acknowledged.sort()).to.deep.equal(records.map((r) => r.feedback_id).sort());
    const alphaEffect = digest.items.find((i) => i.item_id === alpha.item_id);
    const gammaEffect = digest.items.find((i) => i.item_id === gamma.item_id);
    expect(alphaEffect).to.include({ effect: 'suppressed', until: '2026-10-01' });
    expect(gammaEffect.effect).to.equal('confidence_up');
    expect(digest.brief).to.include({ up: 1 });
    expect(digest.retention.records_path.endsWith('feedback.jsonl')).to.equal(true);
    expect(digest.retention.influence_days).to.equal(30);
    expect(payload2.digest.text).to.include('feedback.jsonl').and.include('30 days');
    expect(payload2.digest.text).to.include('gamma.example.org').and.include('alpha.example.org');
    expect(payload2.digest.text).to.include('the other one');
    const publication2 = day2.read('rollup/publication.json');
    const digestPost = day2.slack.chat.postMessage.getCalls()
      .find((c) => c.args[0].metadata && c.args[0].metadata.event_type === 'agent_watchdog.feedback_digest');
    expect(digestPost, 'digest posted').to.not.equal(undefined);
    expect(digestPost.args[0].thread_ts).to.equal(publication2.ts);
    expect(digestPost.args[0].metadata.event_payload).to.include({ run_id: DAY2, acknowledged: 8 });
    expect(readJsonl(path.join(dataDir, 'corpus', 'outcomes', `${DAY2}.jsonl`)).length).to.be.greaterThan(0);

    // Scenario 2: the notes with a lesson became proposals for their destination; the digest names them; and
    // no skill, prompt, threshold or configuration file changed.
    const proposals = await readProposals(dataDir);
    const annotation = proposals.find((p) => p.type === 'project_annotation');
    const prompt = proposals.find((p) => p.type === 'prompt');
    expect(annotation, 'project annotation proposal').to.not.equal(undefined);
    expect(prompt, 'prompt proposal').to.not.equal(undefined);
    expect(annotation.body).to.include('```yaml').and.include('projects:').and.include('notes:');
    expect(annotation.body).to.not.include('alpha.example.org');
    expect(annotation.flags.some((f) => f.kind === 'hostname' && f.excerpt === 'alpha.example.org')).to.equal(true);
    expect(JSON.stringify(annotation)).to.not.match(AUTHORS);
    expect(digest.proposals.map((p) => p.type).sort()).to.deep.equal(['project_annotation', 'prompt']);
    for (const p of digest.proposals) {
      expect(payload2.digest.text).to.include(p.proposal_id);
    }
    const reviewed = records.filter((r) => r.kind === 'note');
    expect(reviewed.map((r) => r.classification).sort())
      .to.deep.equal(['expectation', 'none', 'project_annotation', 'prompt']);
    expect(reviewed.filter((r) => r.proposal_id).map((r) => r.classification).sort())
      .to.deep.equal(['project_annotation', 'prompt']);
    expect(reviewedHashes()).to.deep.equal(before);

    // Scenario 3: reactions never reached the model; one call per note.
    const reviewCalls = day2.engine.calls.singleTurns.filter((c) => c.name === 'feedback-review');
    expect(reviewCalls).to.have.length(4);
    for (const call of reviewCalls) {
      expect(call.userPrompt).to.include('<untrusted source="feedback-note">');
      expect(call.userPrompt).to.not.match(AUTHORS);
    }

    // Scenario 6: the digest names no person, and every note got the seen reaction.
    expect(payload2.digest.text).to.not.match(AUTHORS);
    expect(JSON.stringify(payload2.digest)).to.not.match(AUTHORS);
    expect(day2.slack.reactions.add.callCount).to.equal(noteMessages.length);
    for (const call of day2.slack.reactions.add.getCalls()) {
      expect(call.args[0]).to.include({ name: 'eyes' });
      expect(noteMessages.map((m) => m.ts)).to.include(call.args[0].timestamp);
    }
    for (const record of records) {
      expect(record.acknowledged_run_id, record.feedback_id).to.equal(DAY2);
    }

    // Scenario 4 and 5: five weeks later the same feedback is read again, nothing new is acknowledged, no digest
    // is posted, the horizon has passed and the records no longer adjust ranking, yet they are all still there.
    const later = slackWithFeedback({
      publication, items,
      notes: noteMessages.map((m, i) => ({ user: ['U1', 'U4', 'U5', 'U9'][i], text: m.text })),
      reactionsByTs: {
        [alphaReply.ts]: [{ name: '-1', users: ['U1'], count: 1 }],
        [gammaReply.ts]: [{ name: '+1', users: ['U1', 'U2'], count: 2 }],
        [publication.ts]: [{ name: '+1', users: ['U3'], count: 1 }],
      },
    });
    const day3 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: DAY3, runStart: `${DAY3}T06:00:00Z`, slack: later.slack,
    });
    expect(day3.error, day3.error && day3.error.stack).to.equal(undefined);
    expect(day3.read('rollup/payload.json').digest).to.equal(null);
    expect(day3.slack.chat.postMessage.getCalls()
      .some((c) => c.args[0].metadata && c.args[0].metadata.event_type === 'agent_watchdog.feedback_digest'))
      .to.equal(false);
    expect(day3.slack.reactions.add).to.not.have.been.called;
    expect(day3.engine.calls.singleTurns.filter((c) => c.name === 'feedback-review')).to.have.length(0);
    const ingested3 = day3.read('feedback.ingested.json');
    expect(ingested3.influence).to.include({ days: 30 });
    const gammaTally = ingested3.by_item[gamma.item_id];
    expect(!gammaTally || gammaTally.up === 0, 'old thumbs no longer counted').to.equal(true);
    const ranked3 = day3.read('rollup/items.ranked.json');
    expect(ranked3.find((i) => i.project_url === 'https://gamma.example.org').confidence).to.equal(gamma.confidence);
    expect(ranked3.some((i) => i.project_url === 'https://alpha.example.org'), 'horizon passed').to.equal(true);
    const stillThere = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    expect(stillThere).to.have.length(8);
    expect(stillThere.every((r) => r.acknowledged_run_id === DAY2)).to.equal(true);

    // SC-013: a purge dated a year later leaves the file byte for byte.
    const file = path.join(dataDir, 'feedback.jsonl');
    const bytes = fs.readFileSync(file);
    const purged = await purge(dataDir, { rawDays: 14, keptDays: 30, now: new Date('2027-09-19T06:00:00Z') });
    expect(purged.removed.some((r) => r.path.includes('feedback.jsonl'))).to.equal(false);
    expect(fs.readFileSync(file).equals(bytes)).to.equal(true);

    // Scenario 7: the weekly report lists the proposals still awaiting review, with their age.
    const out = capture();
    const err = capture();
    const code = await calibrate({
      flags: { week: '2026-W38' },
      env: envFor(dataDir),
      stdout: out.stream,
      logger: createLogger({ stream: err.stream, level: 'warn' }),
      deps: {
        tracer: fakeTracer(),
        now: () => new Date(`${DAY2}T12:00:00Z`),
        engine: { name: 'fake', singleTurn: sinon.stub().rejects(new Error('no summary in this test')) },
      },
    });
    expect(code).to.equal(0);
    const report = JSON.parse(out.text());
    expect(report.open_proposals.map((p) => p.type).sort()).to.deep.equal(['project_annotation', 'prompt']);
    for (const open of report.open_proposals) {
      expect(open.age_days).to.be.a('number').at.least(0);
    }
    expect(fs.readFileSync(path.join(dataDir, 'calibration', '2026-W38.md'), 'utf8')).to.include('Open proposals');
  });
});

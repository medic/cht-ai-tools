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
const AUTHORS = /\b(U1|U2|U3|U4|U5|U6|U9|U0123ABCD)\b|<@/;

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

// A Slack client whose thread and reactions come from day one's publication, and that accepts reactions. Since
// revision 28 the thread's replies are code-built (programme, Other, alerts), so feedback on an item is a note.
const slackWithFeedback = ({ publication, notes, reactionsByTs }) => {
  const slack = fakeSlack();
  const parent = {
    type: 'message', ts: publication.ts, thread_ts: publication.ts, bot_id: 'B001', text: 'Watchdog brief',
    reply_count: publication.replies.length + notes.length,
    metadata: { event_type: 'agent_watchdog.brief', event_payload: { run_id: DAY1, date: DAY1, kind: 'brief' } },
  };
  const replies = publication.replies.map((reply) => ({
    type: 'message', ts: reply.ts, thread_ts: publication.ts, bot_id: 'B001', text: `${reply.kind}`,
    metadata: {
      event_type: reply.kind === 'alerts' ? 'agent_watchdog.alerts' : 'agent_watchdog.programme',
      event_payload: { run_id: DAY1, date: DAY1, kind: reply.kind, group: reply.group },
    },
  }));
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
    expect(publication.replies.some((r) => r.item_id), 'no item replies since revision 28').to.equal(false);

    // One reaction on the brief and six notes in thread order: on alpha a thumbs-down expectation with a horizon
    // and, from a second person, a correction of that horizon (FR-085); on gamma a project fact and a thumbs-up,
    // both citing its number in the report; a wording complaint with a mention in it that names no item; and one
    // note nobody can match.
    const NOTE_AUTHORS = ['U1', 'U6', 'U4', 'U2', 'U5', 'U9'];
    const noteTexts = [
      '👎 alpha.example.org sentinel backlog: known migration, expected until 1 October',
      'alpha.example.org sentinel backlog: correction, the migration ends sooner, expected until 25 September',
      `#${gamma.rank} is normally 1 all day long, that is its usual baseline`,
      `#${gamma.rank} 👍 confirmed`,
      'the bullet wording is too long, put the window first <@U0123ABCD>',
      'is anyone looking at the other one?',
    ];
    const { slack, noteMessages } = slackWithFeedback({
      publication,
      notes: noteTexts.map((text, i) => ({ user: NOTE_AUTHORS[i], text })),
      reactionsByTs: {
        [publication.ts]: [{ name: '+1', users: ['U3'], count: 1 }],
      },
    });

    const day2 = await runCase({
      caseName: 'seeded-anomaly', dataDir, date: DAY2, runStart: `${DAY2}T06:00:00Z`, slack,
    });
    expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
    expect(day2.read('run.json').status).to.equal('published');
    const records = readJsonl(path.join(dataDir, 'feedback.jsonl'));
    expect(records).to.have.length(7);

    // Scenario 1: one digest in the new brief's thread naming each item's effect and the retention statement.
    const payload2 = day2.read('rollup/payload.json');
    expect(payload2.digest, 'digest in the payload').to.not.equal(null);
    const digest = day2.read('rollup/feedback.digest.json');
    expect(digest.acknowledged.sort()).to.deep.equal(records.map((r) => r.feedback_id).sort());
    const alphaEffect = digest.items.find((i) => i.item_id === alpha.item_id);
    const gammaEffect = digest.items.find((i) => i.item_id === gamma.item_id);
    // Scenario 8 (FR-085): the two notes on alpha are one conversation, so the corrected horizon is the one applied.
    expect(alphaEffect).to.include({ effect: 'suppressed', until: '2026-09-25' });
    expect(gammaEffect.effect).to.equal('confidence_up');
    const ingested = day2.read('feedback.ingested.json');
    const alphaHorizons = ingested.horizons.filter((h) => h.item_id === alpha.item_id);
    expect(alphaHorizons.map((h) => h.horizon)).to.deep.equal(['2026-09-25']);
    expect(alphaHorizons[0].author_count).to.equal(2);
    expect(day2.read('alpha-example-org/suppressed.json').every((s) => s.horizon === '2026-09-25')).to.equal(true);
    expect(records.filter((r) => r.item_id === alpha.item_id && r.kind === 'note').map((r) => r.horizon).sort())
      .to.deep.equal(['2026-09-25', '2026-10-01']);
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
    expect(digestPost.args[0].metadata.event_payload).to.include({ run_id: DAY2, acknowledged: 7 });
    expect(readJsonl(path.join(dataDir, 'corpus', 'outcomes', `${DAY2}.jsonl`)).length).to.be.greaterThan(0);

    // Scenario 2: the notes with a lesson became proposals for their destination; the digest names them; and
    // no skill, prompt, threshold or configuration file changed.
    const proposals = await readProposals(dataDir);
    const annotation = proposals.find((p) => p.type === 'project_annotation');
    const prompt = proposals.find((p) => p.type === 'prompt');
    expect(annotation, 'project annotation proposal').to.not.equal(undefined);
    expect(prompt, 'prompt proposal').to.not.equal(undefined);
    expect(annotation.body).to.include('```yaml').and.include('projects:').and.include('notes:');
    expect(annotation.body).to.not.include('gamma.example.org');
    expect(annotation.flags.some((f) => f.kind === 'hostname' && f.excerpt === 'gamma.example.org')).to.equal(true);
    expect(JSON.stringify(annotation)).to.not.match(AUTHORS);
    expect(digest.proposals.map((p) => p.type).sort()).to.deep.equal(['project_annotation', 'prompt']);
    for (const p of digest.proposals) {
      expect(payload2.digest.text).to.include(p.proposal_id);
    }
    // The notes of one item were reviewed together (FR-085): alpha's two share a classification, gamma's two share
    // the annotation proposal, whose evidence names both.
    const reviewed = records.filter((r) => r.kind === 'note');
    expect(reviewed.map((r) => r.classification).sort())
      .to.deep.equal(['expectation', 'expectation', 'none', 'project_annotation', 'project_annotation', 'prompt']);
    expect(reviewed.filter((r) => r.proposal_id).map((r) => r.classification).sort())
      .to.deep.equal(['project_annotation', 'project_annotation', 'prompt']);
    expect(annotation.evidence.map((e) => e.feedback_id).sort())
      .to.deep.equal(reviewed.filter((r) => r.item_id === gamma.item_id).map((r) => r.feedback_id).sort());
    expect(reviewedHashes()).to.deep.equal(before);

    // Scenario 8 (FR-085): the digest says where the feedback acted. Alpha's candidates were held back before
    // analysis; gamma was analysed, so its lines are quoted exactly from its prompt with the run's trace link.
    expect(payload2.digest.text).to.include(
      '↳ applied before analysis: candidates suppressed until 2026-09-25 (alpha-example-org/suppressed.json)',
    );
    expect(payload2.digest.text).to.match(new RegExp(
      '↳ in today\'s analysis prompt for gamma\\.example\\.org \\(gamma-example-org/prompt\\.pass1\\.md, '
      + '\\d+ of \\d+ lines quoted\\) · <https://langfuse\\.example\\.org/trace/t1\\|trace>',
    ));
    const gammaPrompt = fs.readFileSync(path.join(day2.root, 'gamma-example-org', 'prompt.pass1.md'), 'utf8');
    const quoted = payload2.digest.text.split('\n').filter((l) => l.startsWith('> ') && !l.startsWith('> …'));
    expect(quoted.length).to.be.at.least(4);
    for (const line of quoted) {
      expect(gammaPrompt, line).to.include(line.slice(2));
    }
    expect(payload2.digest.text).to.include(`"note": "#${gamma.rank} 👍 confirmed",`);
    expect(digest.items.find((i) => i.item_id === gamma.item_id).provenance).to.include({
      applied: 'prompt', prompt_path: 'gamma-example-org/prompt.pass1.md', records: 2,
      trace_url: 'https://langfuse.example.org/trace/t1',
    });
    expect(digest.items.find((i) => i.item_id === alpha.item_id).provenance).to.include({
      applied: 'suppressed', suppressed_until: '2026-09-25', suppressed_path: 'alpha-example-org/suppressed.json',
    });

    // Scenario 3: the reaction never reached the model; one call per item thread, one per note on no item.
    const reviewCalls = day2.engine.calls.singleTurns.filter((c) => c.name === 'feedback-review');
    expect(reviewCalls).to.have.length(4);
    expect(reviewCalls.filter((c) => /Note 1 of 2 \(earliest\)/.test(c.userPrompt))).to.have.length(2);
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
      publication,
      notes: noteMessages.map((m, i) => ({ user: NOTE_AUTHORS[i], text: m.text })),
      reactionsByTs: {
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
    expect(stillThere).to.have.length(7);
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

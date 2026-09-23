const stage = require('../../src/cli/stages/publish');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeBrief, makeDiscovery, makeConfig, quietLogger } = require('../rollup/factories');

const fakeClient = () => ({
  files: { uploadV2: sinon.stub().resolves({ ok: true, files: [{ files: [{ id: 'F1' }] }] }) },
  chat: {
    postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => ({
      ok: true, channel: 'C123', ts: threadTs ? `${threadTs}9` : '1.000',
    })),
    getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://slack/p${ts}` })),
  },
});

describe('cli/stages/publish', () => {
  let dataDir;
  let runDir;
  const item = makeItem({ rank: 1, placement: 'body' });
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    await runDir.writeJson('rollup/items.ranked.json', [item]);
    await runDir.writeJson('rollup/brief.json', makeBrief({
      bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
    }));
  });
  afterEach(() => removeDir(dataDir));

  const ctx = (mode, client) => ({
    config: makeConfig(), logger: quietLogger(), runDir, runId: '2026-09-18', date: '2026-09-18', mode,
    links: { buildItemLinks: () => new Map([[item.item_id, 'https://watchdog.example.org/d/oa2OfL-Vk/x']]) },
    deps: { slack: client },
  });

  it('in preview mode writes the exact payload and posts nothing', async () => {
    const client = fakeClient();
    const out = await stage.run(ctx('preview', client));
    expect(out.posted).to.equal(false);
    // No item replies since revision 28: the body carries the project, the report the rest (FR-020).
    expect(out.payload.replies).to.deep.equal([]);
    expect(out.payload.parent.text).to.include('alpha 912 vs 300');
    expect(runDir.exists('rollup/payload.json')).to.equal(true);
    expect(runDir.exists('rollup/publication.json')).to.equal(false);
    expect(client.chat.postMessage.called).to.equal(false);
    expect(client.files.uploadV2.called).to.equal(false);
    const payload = await runDir.readJson('rollup/payload.json');
    expect(payload.image).to.equal(null);
  });

  it('publishes for real, records the publication and updates the brief', async () => {
    const client = fakeClient();
    const out = await stage.run(ctx('scheduled', client));
    expect(out).to.include({ posted: true, ts: '1.000' });
    const publication = await runDir.readJson('rollup/publication.json');
    expect(publication).to.include({ channel_id: 'C123', ts: '1.000', slack_file_id: null });
    expect(client.files.uploadV2.called, 'no image upload since revision 24').to.equal(false);
    expect(publication.replies).to.deep.equal([]);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.publication).to.deep.equal({ channel_id: 'C123', ts: '1.000', permalink: 'https://slack/p1.000' });
    expect(brief.image).to.equal(null);
  });

  it('refuses to run without the brief', async () => {
    const fresh = await RunDir.create(dataDir, '2026-09-19');
    let error;
    try {
      await stage.run({ ...ctx('preview', fakeClient()), runDir: fresh });
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(65);
  });
});

describe('cli/stages/publish: feedback digest (FR-062)', () => {
  const { appendRecords, readAll } = require('../../src/feedback/store');
  const { ensureDataLayout } = require('../../src/store/run-dir');
  let dataDir;
  let runDir;
  const item = makeItem({ rank: 1, placement: 'body' });
  const record = (overrides = {}) => ({
    feedback_id: 'f1f1f1f1f1f1', date: '2026-09-18', run_id: '2026-09-17', target: 'item', item_id: item.item_id,
    kind: 'reaction', verdict: 'up', note: null, horizon: null, author: 'U1', matched: true,
    source_ts: '1700000000.000100', ...overrides,
  });
  const noteRecord = record({
    feedback_id: 'f2f2f2f2f2f2', kind: 'note', verdict: null, note: 'looks right, thanks <@U0123ABCD>',
    source_ts: '1700000000.000200',
  });
  const client = () => ({
    files: { uploadV2: sinon.stub().resolves({ ok: true, files: [{ files: [{ id: 'F1' }] }] }) },
    chat: {
      postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => ({
        ok: true, channel: 'C123', ts: threadTs ? `${threadTs}9` : '1.000',
      })),
      getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => (
        { ok: true, permalink: `https://slack/p${ts}` }
      )),
    },
    reactions: { add: sinon.stub().resolves({ ok: true }) },
  });

  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    await runDir.writeJson('rollup/items.ranked.json', [item]);
    await runDir.writeJson('rollup/brief.json', makeBrief({
      bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
    }));
    await runDir.writeJson('alpha-example-org/suppressed.json', []);
    await appendRecords(dataDir, [record(), noteRecord]);
    await runDir.writeJson('feedback.ingested.json', {
      run_id: '2026-09-18',
      by_item: {
        [item.item_id]: {
          project_url: item.project_url, metric: item.metric, up: 1, down: 0, notes: ['looks right'],
          verdict: 'confirmed',
        },
      },
      unmatched: [],
      review: {
        classified: [{
          feedback_id: 'f2f2f2f2f2f2', item_id: item.item_id, classification: 'skill',
          proposal_id: '2026-09-18-skill-sentinel-lesson',
          proposal_path: `${dataDir}/proposals/2026-09-18-skill-sentinel-lesson.md`,
          destination: 'skill',
        }],
        unclassified: [],
      },
      influence: { days: 30, window_start: '2026-08-19' },
      records_path: `${dataDir}/feedback.jsonl`,
    });
  });
  afterEach(() => removeDir(dataDir));

  const ctx = (mode, slack, overrides = {}) => ({
    config: { ...makeConfig(), storage: { dataDir }, behaviour: { feedbackInfluenceDays: 30 } },
    logger: quietLogger(), runDir, runId: '2026-09-18', date: '2026-09-18', mode,
    links: { buildItemLinks: () => new Map() },
    feedbackByItem: new Map([[item.item_id, {
      up: 1, down: 0, verdict: 'confirmed', project_url: item.project_url, metric: item.metric,
    }]]),
    deps: { slack },
    ...overrides,
  });

  it('in preview builds the digest into the payload and the run record, posts nothing and marks nothing', async () => {
    const slack = client();
    const out = await stage.run(ctx('preview', slack));
    expect(out.posted).to.equal(false);
    expect(out.payload.digest).to.not.equal(null);
    expect(out.payload.digest.text).to.include('Feedback from yesterday: 1 reaction, 1 note');
    expect(out.payload.digest.text).to.include('2026-09-18-skill-sentinel-lesson.md');
    expect(out.payload.digest.text).to.include('confidence raised');
    expect(out.payload.digest.text).to.not.include('U0123ABCD');
    expect(out.payload.digest.acknowledged.sort()).to.deep.equal(['f1f1f1f1f1f1', 'f2f2f2f2f2f2']);
    const entity = await runDir.readJson('rollup/feedback.digest.json');
    expect(entity.items[0]).to.include({ item_id: item.item_id, up: 1, notes: 1, effect: 'confidence_up' });
    expect(entity.publication).to.equal(null);
    expect(slack.chat.postMessage.called).to.equal(false);
    expect(slack.reactions.add.called).to.equal(false);
    expect((await readAll(dataDir)).every((r) => r.acknowledged_run_id === null)).to.equal(true);
  });

  it('posts the digest under the brief, marks the records once and reacts with eyes on the notes only', async () => {
    const slack = client();
    const out = await stage.run(ctx('scheduled', slack));
    expect(out.posted).to.equal(true);
    const calls = slack.chat.postMessage.getCalls().map((c) => c.args[0]);
    const digestCall = calls.find((c) => c.metadata && c.metadata.event_type === 'agent_watchdog.feedback_digest');
    expect(digestCall).to.not.equal(undefined);
    expect(digestCall.thread_ts).to.equal('1.000');
    expect(calls.indexOf(digestCall)).to.equal(calls.length - 1);
    expect(slack.reactions.add).to.have.been.calledOnce;
    expect(slack.reactions.add.firstCall.args[0])
      .to.deep.equal({ channel: 'C123', timestamp: '1700000000.000200', name: 'eyes' });
    const records = await readAll(dataDir);
    expect(records.map((r) => r.acknowledged_run_id)).to.deep.equal(['2026-09-18', '2026-09-18']);
    const entity = await runDir.readJson('rollup/feedback.digest.json');
    expect(entity.publication).to.include({ channel_id: 'C123', ts: '1.0009' });
    expect(entity.reactions).to.deep.equal([{ source_ts: '1700000000.000200', name: 'eyes', ok: true }]);
    const publication = await runDir.readJson('rollup/publication.json');
    expect(publication.digest).to.include({ ts: '1.0009' });

    // A second publish acknowledges nothing again and posts no digest.
    const again = await RunDir.create(dataDir, '2026-09-19');
    await again.writeJson('discovery.json', makeDiscovery());
    await again.writeJson('rollup/items.ranked.json', [item]);
    await again.writeJson('rollup/brief.json', makeBrief({ kind: 'heartbeat', bullets: [] }));
    const slack2 = client();
    const out2 = await stage.run(ctx('scheduled', slack2, { runDir: again, runId: '2026-09-19', date: '2026-09-19' }));
    expect(out2.posted).to.equal(true);
    expect((await again.readJson('rollup/payload.json')).digest).to.equal(null);
    expect(slack2.chat.postMessage).to.have.been.calledOnce;
    expect(slack2.reactions.add.called).to.equal(false);
    expect(again.exists('rollup/feedback.digest.json')).to.equal(false);
  });

  it('posts the digest in a heartbeat thread on a quiet day and survives a failed reaction', async () => {
    await runDir.writeJson('rollup/brief.json', makeBrief({ kind: 'heartbeat', bullets: [] }));
    const slack = client();
    slack.reactions.add.rejects(Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }));
    const out = await stage.run(ctx('scheduled', slack));
    expect(out.posted).to.equal(true);
    expect(slack.chat.postMessage).to.have.been.calledTwice;
    const [heartbeat, digestCall] = slack.chat.postMessage.getCalls().map((c) => c.args[0]);
    expect(heartbeat.metadata.event_payload.kind).to.equal('heartbeat');
    expect(digestCall.thread_ts).to.equal('1.000');
    const entity = await runDir.readJson('rollup/feedback.digest.json');
    expect(entity.reactions[0]).to.include({ ok: false });
    expect((await readAll(dataDir)).every((r) => r.acknowledged_run_id === '2026-09-18')).to.equal(true);
  });
});

describe('cli/stages/publish: the report shared into the thread (revision 23)', () => {
  let dataDir;
  let runDir;
  const item = makeItem({ rank: 1, placement: 'body' });
  const sharingClient = () => ({
    files: {
      uploadV2: sinon.stub().callsFake(async ({ channel_id: channelId }) => ({
        ok: true,
        files: [{ files: [channelId
          ? { id: 'F2', permalink: 'https://slack/files/F2', shares: { public: { C123: [{ ts: '1.0009' }] } } }
          : { id: 'F1' }] }],
      })),
    },
    chat: {
      postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => ({
        ok: true, channel: 'C123', ts: threadTs ? `${threadTs}9` : '1.000',
      })),
      getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://slack/p${ts}` })),
    },
  });
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    await runDir.writeJson('rollup/items.ranked.json', [item]);
    await runDir.writeJson('rollup/layout.json', {
      slots: [], replies: [], entries: {}, body_items: [item.item_id], reply_items: [], thread_items: [],
      body_alerts: [], thread_alerts: [],
    });
    await runDir.writeJson('rollup/brief.json', makeBrief({
      bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
      report: { path: 'rollup/report.html', slack_file_id: null, ts: null },
    }));
    await runDir.writeText('rollup/report.html', '<html></html>');
  });
  afterEach(() => removeDir(dataDir));

  const ctx = (mode, client) => ({
    config: makeConfig(), logger: quietLogger(), runDir, runId: '2026-09-18', date: '2026-09-18', mode,
    links: { buildItemLinks: () => new Map() }, deps: { slack: client },
  });

  it('records the report on the preview payload and uploads nothing', async () => {
    const client = sharingClient();
    const out = await stage.run(ctx('preview', client));
    expect(out.payload.report).to.include({ path: 'rollup/report.html', slack_file_id: null, items: 1 });
    expect(out.payload.report).to.not.have.property('replied');
    expect(client.files.uploadV2.called).to.equal(false);
  });

  it('shares the report for real and records it on the publication and the brief', async () => {
    const client = sharingClient();
    await stage.run(ctx('scheduled', client));
    const publication = await runDir.readJson('rollup/publication.json');
    expect(publication.report).to.deep.equal({ file_id: 'F2', ts: '1.0009', permalink: 'https://slack/files/F2' });
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.report).to.deep.equal({ path: 'rollup/report.html', slack_file_id: 'F2', ts: '1.0009' });
    expect(brief.image).to.equal(null);
    expect(client.files.uploadV2).to.have.been.calledOnce;
  });
});

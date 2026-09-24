const fs = require('node:fs');
const path = require('node:path');
const { createSlackPublisher } = require('../../src/publish/slack');
const { buildPayload } = require('../../src/publish/payload');
const codes = require('../../src/cli/exit-codes');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeBrief, quietLogger } = require('../rollup/factories');

const settle = (stream) => new Promise((resolve) => {
  if (!stream || typeof stream.on !== 'function') {
    resolve();
    return;
  }
  stream.on('open', () => {
    stream.destroy();
    resolve();
  });
  stream.on('error', () => resolve());
  stream.on('close', () => resolve());
});

const fakeClient = () => ({
  files: {
    uploadV2: sinon.stub().callsFake(async ({ file }) => {
      await settle(file);
      return { ok: true, files: [{ ok: true, files: [{ id: 'F123', title: 'brief' }] }] };
    }),
  },
  chat: {
    postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => ({
      ok: true, channel: 'C123', ts: threadTs ? `${threadTs}1` : '1700000000.000100',
    })),
    getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://medic.slack.com/archives/C123/p${ts.replace('.', '')}` })),
  },
});

const rateLimited = (retryAfter) => Object.assign(new Error('rate limited'), {
  code: 'slack_webapi_rate_limited_error',
  data: { retryAfter },
});

// A thread bullet as the roll-up assembles one (revision 28): a programme or Other reply with one project line.
const threadBullet = (group, member, text = 'conflicts up') => ({
  kind: 'group', item_id: null, item_ids: [], group, text: `${group}: 1 project with issues`, alert_key: null,
  children: [{ item_id: member.item_id, item_ids: [member.item_id], text }],
});

describe('publish/slack', () => {
  let dir;
  let imagePath;
  const item = makeItem({ rank: 1, placement: 'body' });
  // The second item is in the thread: a programme reply and the Other reply exercise the posting mechanics.
  const second = makeItem({ metric: 'cht_conflict_count', severity: 'high', rank: 2, placement: 'thread' });
  const brief = makeBrief({
    bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
    thread: [threadBullet('North Programme', second), threadBullet('Other', second)],
  });
  const payloadFor = (b = brief) => buildPayload({
    brief: b,
    items: [item, second],
    links: new Map(),
    runId: '2026-09-18',
    date: '2026-09-18',
    audience: 'internal',
    channel: 'C123',
  });

  beforeEach(() => {
    dir = tempDir();
    imagePath = path.join(dir, 'brief.png');
    fs.writeFileSync(imagePath, 'PNG');
  });
  afterEach(() => removeDir(dir));

  it('posts the parent without any upload before it, threads the programme replies, records permalinks', async () => {
    const client = fakeClient();
    const pace = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), pace });
    const publication = await publisher.publish({ payload: payloadFor() });

    // The brief image was retired in revision 24: nothing is uploaded before the parent is posted.
    expect(client.files.uploadV2.called).to.equal(false);
    expect(publication.slack_file_id).to.equal(null);

    const parent = client.chat.postMessage.firstCall.args[0];
    expect(parent).to.include({ channel: 'C123', unfurl_links: false, unfurl_media: false });
    expect(parent.blocks.some((b) => b.type === 'image')).to.equal(false);
    expect(parent.metadata.event_type).to.equal('agent_watchdog.brief');
    expect(parent).to.not.have.property('thread_ts');

    expect(client.chat.postMessage.callCount).to.equal(3);
    for (const call of client.chat.postMessage.getCalls().slice(1)) {
      expect(call.args[0].thread_ts).to.equal('1700000000.000100');
      expect(call.args[0].metadata.event_type).to.equal('agent_watchdog.programme');
      expect(call.args[0]).to.not.have.property('reply_broadcast');
    }
    expect(client.chat.getPermalink.callCount).to.equal(3);
    expect(publication).to.include({ channel_id: 'C123', ts: '1700000000.000100' });
    expect(publication.permalink).to.include('p1700000000000100');
    expect(publication.replies).to.have.length(2);
    expect(publication.replies[0]).to.include({ kind: 'programme', group: 'North Programme', item_id: null });
    expect(publication.replies[1]).to.include({ kind: 'other', group: 'Other', item_id: null, alert_key: null });
    expect(publication.replies[0].permalink).to.be.a('string');
    expect(pace.callCount).to.be.at.least(2);
  });

  it('adds a superseded link when a forced run replaces an earlier post', async () => {
    const client = fakeClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    await publisher.publish({ payload: payloadFor(), superseded: 'https://medic.slack.com/archives/C123/p1' });
    const parent = client.chat.postMessage.firstCall.args[0];
    expect(parent.blocks[0].type).to.equal('context');
    expect(parent.blocks[0].elements[0].text).to.include('https://medic.slack.com/archives/C123/p1');
  });

  it('retries a rate-limited call after retryAfter seconds and then succeeds', async () => {
    const client = fakeClient();
    const original = client.chat.postMessage;
    let attempts = 0;
    client.chat.postMessage = sinon.stub().callsFake(async (args) => {
      attempts += 1;
      if (attempts === 1) {
        throw rateLimited(2);
      }
      return original(args);
    });
    const sleep = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), sleep });
    const publication = await publisher.publish({ payload: payloadFor() });
    expect(sleep).to.have.been.calledWith(2000);
    expect(publication.ts).to.equal('1700000000.000100');
  });

  it('reports the parent as soon as it is posted, so a later failure leaves a record of it (revision 34)', async () => {
    const client = fakeClient();
    client.files.uploadV2 = sinon.stub().rejects(new Error('upload broken'));
    const onParent = sinon.stub().resolves();
    const sleep = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), sleep });
    const withReport = payloadFor();
    withReport.report = {
      filename: 'report.html', title: 'Report', path: imagePath, items: 1, initial_comment: 'c', slack_file_id: null,
      ts: null,
    };
    const error = await publisher.publish({ payload: withReport, reportPath: imagePath, onParent }).catch((e) => e);
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(74);
    expect(onParent).to.have.been.calledOnce;
    expect(onParent.firstCall.args[0]).to.include({ channel_id: 'C123', ts: '1700000000.000100', partial: true });
    expect(onParent.firstCall.args[0].permalink).to.include('p1700000000000100');
    expect(onParent.firstCall.args[0].replies).to.deep.equal([]);
  });

  it('gives up after three attempts with exit code 74', async () => {
    const client = fakeClient();
    client.chat.postMessage = sinon.stub().rejects(new Error('socket hang up'));
    const sleep = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), sleep });
    let error;
    try {
      await publisher.publish({ payload: payloadFor() });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(74);
    expect(client.chat.postMessage.callCount).to.equal(3);
  });

  it('posts heartbeat and failure notices as text-only messages with metadata', async () => {
    const client = fakeClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    const heartbeat = payloadFor(makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [] }));
    const hb = await publisher.postHeartbeat(heartbeat);
    expect(client.chat.postMessage.firstCall.args[0]).to.include({ channel: 'C123', text: heartbeat.parent.text });
    expect(client.chat.postMessage.firstCall.args[0]).to.not.have.property('blocks');
    expect(hb).to.include({ channel_id: 'C123' });
    const failure = await publisher.postFailureNotice({ text: 'Run failed: metrics source unreachable', traceUrl: 'https://langfuse.example.org/trace/t1', runId: '2026-09-18', date: '2026-09-18' });
    const posted = client.chat.postMessage.secondCall.args[0];
    expect(posted.text).to.include('Run failed');
    expect(posted.text).to.include('<https://langfuse.example.org/trace/t1|trace>');
    expect(posted.metadata.event_payload.kind).to.equal('failure');
    expect(failure.ts).to.be.a('string');
  });
});

describe('publish/slack: feedback digest and seen reactions (FR-062)', () => {
  const { createSlackPublisher } = require('../../src/publish/slack');
  const { quietLogger } = require('../rollup/factories');
  const digest = {
    text: 'Feedback from yesterday: 1 reaction',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
    metadata: {
      event_type: 'agent_watchdog.feedback_digest', event_payload: { run_id: 'r', date: 'd', acknowledged: 1 },
    },
    acknowledged: ['f1f1f1f1f1f1'], reactions: [],
  };
  const clientWith = (reactionsAdd) => ({
    chat: {
      postMessage: sinon.stub().callsFake(async ({ thread_ts: threadTs }) => (
        { ok: true, channel: 'C123', ts: `${threadTs}5` }
      )),
      getPermalink: sinon.stub().callsFake(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://slack/p${ts}` })),
    },
    reactions: { add: reactionsAdd },
  });

  it('posts the digest as one threaded reply under the parent with its metadata', async () => {
    const client = clientWith(sinon.stub().resolves({ ok: true }));
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    const publication = await publisher.postDigest({ digest, parentTs: '1.000' });
    expect(client.chat.postMessage).to.have.been.calledOnce;
    const call = client.chat.postMessage.firstCall.args[0];
    expect(call).to.include({ channel: 'C123', thread_ts: '1.000', text: digest.text });
    expect(call.blocks).to.deep.equal(digest.blocks);
    expect(call.metadata.event_type).to.equal('agent_watchdog.feedback_digest');
    expect(call).to.not.have.property('reply_broadcast');
    expect(publication).to.deep.equal({ channel_id: 'C123', ts: '1.0005', permalink: 'https://slack/p1.0005' });
  });

  it('adds an eyes reaction per note, treats already_reacted as success and logs other failures', async () => {
    const add = sinon.stub();
    add.onFirstCall().resolves({ ok: true });
    const apiError = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
    add.onSecondCall().rejects(apiError('already_reacted'));
    add.onThirdCall().rejects(apiError('missing_scope'));
    const logger = quietLogger();
    const publisher = createSlackPublisher({ client: clientWith(add), channel: 'C123', logger });
    const records = [
      { feedback_id: 'a', kind: 'note', source_ts: '1.1' },
      { feedback_id: 'b', kind: 'note', source_ts: '1.2' },
      { feedback_id: 'c', kind: 'note', source_ts: '1.3' },
    ];
    const results = await publisher.reactToNotes({ records });
    expect(add.callCount).to.equal(3);
    expect(add.firstCall.args[0]).to.deep.equal({ channel: 'C123', timestamp: '1.1', name: 'eyes' });
    expect(results.map((r) => [r.source_ts, r.ok])).to.deep.equal([['1.1', true], ['1.2', true], ['1.3', false]]);
    expect(results[2].error).to.include('missing_scope');
    expect(logger.events.some((e) => e.level === 'warn' && e.event === 'slack.reaction_failed')).to.equal(true);
  });
});

describe('publish/slack: the alerts reply (User Story 8, revision 28)', () => {
  it('records each reply\'s kind and group, the alerts reply last, and an older item reply as an item', async () => {
    const client = fakeClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    const payload = {
      parent: { text: 'brief', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*h*' } }], metadata: {} },
      image: null,
      replies: [
        {
          kind: 'programme', group: 'North Programme', item_id: null, alert_key: null, text: 'programme', blocks: [],
          metadata: { event_type: 'agent_watchdog.programme' },
        },
        { item_id: 'a'.repeat(12), text: 'item', blocks: [], metadata: { event_type: 'agent_watchdog.item' } },
        {
          kind: 'alerts', group: null, item_id: null, alert_key: null, text: 'alerts', blocks: [],
          metadata: { event_type: 'agent_watchdog.alerts' },
        },
      ],
    };
    const publication = await publisher.publish({ payload, imagePath: null });
    expect(publication.replies).to.have.length(3);
    expect(publication.replies[0])
      .to.include({ kind: 'programme', group: 'North Programme', item_id: null, alert_key: null });
    expect(publication.replies[1]).to.include({ kind: 'item', group: null, item_id: 'a'.repeat(12), alert_key: null });
    expect(publication.replies[2]).to.include({ kind: 'alerts', group: null, item_id: null, alert_key: null });
    expect(client.chat.postMessage.getCall(3).args[0].metadata.event_type).to.equal('agent_watchdog.alerts');
  });
});

describe('publish/slack: the report shared into the thread (FR-022, revision 23)', () => {
  let dir;
  let imagePath;
  let reportPath;
  const item = makeItem({ rank: 1, placement: 'body' });
  const threadItem = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'thread' });
  const brief = makeBrief({
    bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
    thread: [threadBullet('Other', threadItem)],
    report: { path: 'rollup/report.html', slack_file_id: null, ts: null },
  });
  const payloadFor = (b = brief) => buildPayload({
    brief: b, items: [item, threadItem], runId: '2026-09-18', date: '2026-09-18', audience: 'internal',
    channel: 'C123',
  });
  const sharingClient = () => {
    const client = fakeClient();
    client.files.uploadV2 = sinon.stub().callsFake(async ({ file, channel_id: channelId }) => {
      await settle(file);
      const shared = channelId
        ? { id: 'F456', title: 'report', permalink: 'https://medic.slack.com/files/F456', shares: { public: { C123: [{ ts: '1700000000.000150' }] } } }
        : { id: 'F123', title: 'brief' };
      return { ok: true, files: [{ ok: true, files: [shared] }] };
    });
    return client;
  };

  beforeEach(() => {
    dir = tempDir();
    imagePath = path.join(dir, 'brief.png');
    reportPath = path.join(dir, 'report.html');
    fs.writeFileSync(imagePath, 'PNG');
    fs.writeFileSync(reportPath, '<html></html>');
  });
  afterEach(() => removeDir(dir));

  it('shares the report into the thread after the parent, with the comment, and records the share', async () => {
    const client = sharingClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), pace: async () => {} });
    const publication = await publisher.publish({ payload: payloadFor(), reportPath });
    expect(client.files.uploadV2).to.have.been.calledOnce;
    const share = client.files.uploadV2.firstCall.args[0];
    expect(share)
      .to.include({ channel_id: 'C123', thread_ts: '1700000000.000100', filename: 'report-2026-09-18.html' });
    expect(share.title).to.include('2026-09-18');
    expect(share.initial_comment).to.include('2 items');
    // The share is posted after the parent and before the thread replies.
    expect(client.files.uploadV2.firstCall.calledAfter(client.chat.postMessage.firstCall)).to.equal(true);
    expect(client.chat.postMessage.secondCall.calledAfter(client.files.uploadV2.firstCall)).to.equal(true);
    expect(publication.report).to.deep.equal({
      file_id: 'F456', ts: '1700000000.000150', permalink: 'https://medic.slack.com/files/F456',
    });
    expect(publication.slack_file_id).to.equal(null);
  });

  it('shares nothing when the payload carries no report', async () => {
    const client = sharingClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), pace: async () => {} });
    const plain = payloadFor(makeBrief({ bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }] }));
    const publication = await publisher.publish({ payload: plain, reportPath });
    expect(client.files.uploadV2.called).to.equal(false);
    expect(publication.report).to.equal(null);
  });

  it('fails loudly when the share cannot be made, like the image upload', async () => {
    const client = sharingClient();
    client.files.uploadV2.rejects(new Error('boom'));
    const publisher = createSlackPublisher({
      client, channel: 'C123', logger: quietLogger(), pace: async () => {}, sleep: async () => {},
    });
    let error = null;
    try {
      await publisher.publish({ payload: payloadFor(), reportPath });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(codes.IOERR);
  });
});

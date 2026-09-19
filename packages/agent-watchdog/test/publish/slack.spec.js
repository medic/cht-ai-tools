const fs = require('node:fs');
const path = require('node:path');
const { createSlackPublisher } = require('../../src/publish/slack');
const { buildPayload } = require('../../src/publish/payload');
const codes = require('../../src/cli/exit-codes');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeBrief, quietLogger } = require('../rollup/factories');

const fakeClient = () => ({
  files: {
    uploadV2: sinon.stub().resolves({ ok: true, files: [{ ok: true, files: [{ id: 'F123', title: 'brief' }] }] }),
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

describe('publish/slack', () => {
  let dir;
  let imagePath;
  const item = makeItem({ rank: 1, placement: 'body' });
  const second = makeItem({ metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'body' });
  const brief = makeBrief({ bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }] });
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

  it('uploads privately, posts the parent with the image, threads a reply per item, records permalinks', async () => {
    const client = fakeClient();
    const pace = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), pace });
    const publication = await publisher.publish({ payload: payloadFor(), imagePath });

    const upload = client.files.uploadV2.firstCall.args[0];
    expect(upload).to.not.have.property('channel_id');
    expect(upload).to.include({ filename: 'brief-2026-09-18.png' });
    expect(upload.file).to.exist;
    expect(publication.slack_file_id).to.equal('F123');

    const parent = client.chat.postMessage.firstCall.args[0];
    expect(parent).to.include({ channel: 'C123', unfurl_links: false, unfurl_media: false });
    expect(parent.blocks.find((b) => b.type === 'image').slack_file.id).to.equal('F123');
    expect(parent.metadata.event_type).to.equal('agent_watchdog.brief');
    expect(parent).to.not.have.property('thread_ts');

    expect(client.chat.postMessage.callCount).to.equal(3);
    for (const call of client.chat.postMessage.getCalls().slice(1)) {
      expect(call.args[0].thread_ts).to.equal('1700000000.000100');
      expect(call.args[0].metadata.event_type).to.equal('agent_watchdog.item');
      expect(call.args[0]).to.not.have.property('reply_broadcast');
    }
    expect(client.chat.getPermalink.callCount).to.equal(3);
    expect(publication).to.include({ channel_id: 'C123', ts: '1700000000.000100' });
    expect(publication.permalink).to.include('p1700000000000100');
    expect(publication.replies).to.have.length(2);
    expect(publication.replies[0]).to.include({ item_id: item.item_id });
    expect(publication.replies[0].permalink).to.be.a('string');
    expect(pace.callCount).to.be.at.least(2);
  });

  it('adds a superseded link when a forced run replaces an earlier post', async () => {
    const client = fakeClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    await publisher.publish({ payload: payloadFor(), imagePath, superseded: 'https://medic.slack.com/archives/C123/p1' });
    const parent = client.chat.postMessage.firstCall.args[0];
    expect(parent.blocks[0].type).to.equal('context');
    expect(parent.blocks[0].elements[0].text).to.include('https://medic.slack.com/archives/C123/p1');
  });

  it('posts without an upload when the brief has no image', async () => {
    const client = fakeClient();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger() });
    const noImage = payloadFor();
    noImage.image = null;
    const publication = await publisher.publish({ payload: noImage, imagePath: null });
    expect(client.files.uploadV2.called).to.equal(false);
    expect(publication.slack_file_id).to.equal(null);
    expect(client.chat.postMessage.firstCall.args[0].blocks.some((b) => b.type === 'image')).to.equal(false);
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
    const publication = await publisher.publish({ payload: payloadFor(), imagePath });
    expect(sleep).to.have.been.calledWith(2000);
    expect(publication.ts).to.equal('1700000000.000100');
  });

  it('gives up after three attempts with exit code 74', async () => {
    const client = fakeClient();
    client.chat.postMessage = sinon.stub().rejects(new Error('socket hang up'));
    const sleep = sinon.stub().resolves();
    const publisher = createSlackPublisher({ client, channel: 'C123', logger: quietLogger(), sleep });
    let error;
    try {
      await publisher.publish({ payload: payloadFor(), imagePath });
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

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
      image: { path: 'rollup/brief.png', slack_file_id: null },
    }));
    await runDir.writeText('rollup/brief.png', 'PNG');
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
    expect(out.payload.replies[0].text).to.include('|dashboard>');
    expect(runDir.exists('rollup/payload.json')).to.equal(true);
    expect(runDir.exists('rollup/publication.json')).to.equal(false);
    expect(client.chat.postMessage.called).to.equal(false);
    expect(client.files.uploadV2.called).to.equal(false);
    const payload = await runDir.readJson('rollup/payload.json');
    expect(payload.image.slack_file_id).to.equal(null);
  });

  it('publishes for real, records the publication and updates the brief', async () => {
    const client = fakeClient();
    const out = await stage.run(ctx('scheduled', client));
    expect(out).to.include({ posted: true, ts: '1.000' });
    const publication = await runDir.readJson('rollup/publication.json');
    expect(publication).to.include({ channel_id: 'C123', ts: '1.000', slack_file_id: 'F1' });
    expect(publication.replies).to.have.length(1);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.publication).to.deep.equal({ channel_id: 'C123', ts: '1.000', permalink: 'https://slack/p1.000' });
    expect(brief.image.slack_file_id).to.equal('F1');
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

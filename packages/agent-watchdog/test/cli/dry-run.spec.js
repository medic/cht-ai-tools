// Preview mode (FR-025, US3 scenario 5): every artefact of a real run, the exact payload on stdout, nothing posted.
const fs = require('node:fs');
const path = require('node:path');
const runCommand = require('../../src/cli/commands/run');
const publishStage = require('../../src/cli/stages/publish');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeBrief } = require('../rollup/factories');
const { DATE, fakeStages, fakeSlackClient, runArgs, attempt } = require('./helpers');

const readRun = (dataDir, runId = DATE) => JSON.parse(
  fs.readFileSync(path.join(dataDir, 'runs', runId, 'run.json'), 'utf8'),
);

const listFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
};

// A roll-up that writes a real brief and ranked items so the real publish stage has something to build from.
const rollupWriting = () => async (ctx) => {
  const item = makeItem({ rank: 1, placement: 'body' });
  await ctx.runDir.writeJson('rollup/items.ranked.json', [item]);
  await ctx.runDir.writeJson('rollup/brief.json', makeBrief({
    run_id: ctx.runId, bullets: [{ item_id: item.item_id, text: 'alpha sentinel backlog 912 vs 300 yesterday' }],
  }));
  return { kind: 'brief', items: 1, bullets: 1, degraded: false, calls: [] };
};

describe('cli/commands/run in preview mode (--dry-run)', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('treats --dry-run and AGENT_WATCHDOG_DRY_RUN=true alike', async () => {
    const preview = { posted: false, payload: { run_id: DATE, kind: 'brief', parent: { text: 'p' }, replies: [] } };
    const byFlag = runArgs(dataDir, {
      flags: { 'dry-run': true }, deps: { stages: fakeStages({ publish: preview }).stages },
    });
    expect((await attempt(runCommand, byFlag.args)).code).to.equal(0);
    expect(readRun(dataDir)).to.include({ mode: 'preview', status: 'previewed' });

    const other = tempDir();
    try {
      const byEnv = runArgs(other, {
        env: { AGENT_WATCHDOG_DRY_RUN: 'true' }, deps: { stages: fakeStages({ publish: preview }).stages },
      });
      expect((await attempt(runCommand, byEnv.args)).code).to.equal(0);
      expect(readRun(other)).to.include({ mode: 'preview', status: 'previewed' });
      expect(JSON.parse(byEnv.out.text())).to.deep.equal(preview.payload);
    } finally {
      removeDir(other);
    }
  });

  it('writes payload.json, prints exactly it, posts nothing and records no publication', async () => {
    const slack = fakeSlackClient();
    const { stages } = fakeStages({ rollup: rollupWriting() });
    stages.publish = publishStage;
    const t = runArgs(dataDir, { flags: { 'dry-run': true }, deps: { stages, slack } });
    const { code, error } = await attempt(runCommand, t.args);
    expect(error, error && error.stack).to.equal(null);
    expect(code).to.equal(0);
    const root = path.join(dataDir, 'runs', DATE);
    const payload = JSON.parse(fs.readFileSync(path.join(root, 'rollup', 'payload.json'), 'utf8'));
    expect(JSON.parse(t.out.text())).to.deep.equal(payload);
    expect(payload.kind).to.equal('brief');
    expect(payload.parent.channel).to.equal('C123');
    expect(payload.replies).to.have.length(1);
    expect(payload.image.slack_file_id).to.equal(null);
    expect(fs.existsSync(path.join(root, 'rollup', 'publication.json'))).to.equal(false);
    expect(slack.chat.postMessage).to.not.have.been.called;
    expect(slack.files.uploadV2).to.not.have.been.called;
    expect(t.slackPublisher.postFailureNotice).to.not.have.been.called;
    expect(readRun(dataDir).status).to.equal('previewed');
  });

  it('stores the same artefacts as a posted run, minus publication.json', async () => {
    const stagesWithPublish = () => ({ ...fakeStages({ rollup: rollupWriting() }).stages, publish: publishStage });
    const posted = runArgs(dataDir, { deps: { stages: stagesWithPublish(), slack: fakeSlackClient() } });
    expect((await attempt(runCommand, posted.args)).code).to.equal(0);
    const previewDir = tempDir();
    try {
      const preview = runArgs(previewDir, {
        flags: { 'dry-run': true }, deps: { stages: stagesWithPublish(), slack: fakeSlackClient() },
      });
      expect((await attempt(runCommand, preview.args)).code).to.equal(0);
      const postedFiles = listFiles(path.join(dataDir, 'runs', DATE));
      const previewFiles = listFiles(path.join(previewDir, 'runs', DATE));
      expect(postedFiles).to.include('rollup/publication.json');
      expect(previewFiles).to.deep.equal(postedFiles.filter((f) => f !== 'rollup/publication.json'));
      expect(readRun(dataDir).status).to.equal('published');
      expect(readRun(previewDir).status).to.equal('previewed');
    } finally {
      removeDir(previewDir);
    }
  });
});

const fs = require('node:fs');
const path = require('node:path');
const stage = require('../../src/cli/stages/render');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeBrief, makeDiscovery, makeConfig, quietLogger } = require('../rollup/factories');

const fakeLauncher = () => {
  const locator = { screenshot: sinon.stub().resolves(Buffer.from('PNG')) };
  const page = {
    route: sinon.stub().resolves(),
    setContent: sinon.stub().resolves(),
    locator: sinon.stub().returns(locator),
  };
  const context = { newPage: sinon.stub().resolves(page), close: sinon.stub().resolves() };
  const browser = { newContext: sinon.stub().resolves(context), close: sinon.stub().resolves() };
  return { launch: sinon.stub().resolves(browser) };
};

describe('cli/stages/render', () => {
  let dataDir;
  let runDir;
  const item = makeItem({ rank: 1, placement: 'body' });
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    await runDir.writeJson('rollup/items.ranked.json', [item]);
    await runDir.writeGz('alpha-example-org/inputs/windows.json.gz', [
      {
        project_url: item.project_url,
        metric: item.metric,
        window: 'current',
        values: [[1, 300], [2, 600], [3, 912]],
        available: true,
      },
    ]);
  });
  afterEach(() => removeDir(dataDir));

  const ctx = (launcher) => ({
    config: makeConfig(),
    logger: quietLogger(),
    runDir,
    runId: '2026-09-18',
    date: '2026-09-18',
    mode: 'scheduled',
    deps: { browserLauncher: launcher },
  });

  it('renders the report and the image for a brief and records the image on the brief', async () => {
    const written = makeBrief({ bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }] });
    await runDir.writeJson('rollup/brief.json', written);
    const launcher = fakeLauncher();
    const out = await stage.run(ctx(launcher));
    expect(out).to.include({ report: 'rollup/report.html', image: 'rollup/brief.png' });
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'report.html'))).to.equal(true);
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'brief.png'))).to.equal(true);
    expect(launcher.launch).to.have.been.calledOnce;
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.image).to.deep.equal({ path: 'rollup/brief.png', slack_file_id: null });
    expect(fs.readFileSync(path.join(runDir.root, 'rollup', 'report.html'), 'utf8')).to.include('912');
  });

  it('renders the report but skips the image for a heartbeat', async () => {
    await runDir.writeJson('rollup/brief.json', makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [] }));
    const launcher = fakeLauncher();
    const out = await stage.run(ctx(launcher));
    expect(out.image).to.equal(null);
    expect(launcher.launch.called).to.equal(false);
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'report.html'))).to.equal(true);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.image).to.equal(null);
  });

  it('refuses to run without the brief', async () => {
    let error;
    try {
      await stage.run(ctx(fakeLauncher()));
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(65);
  });
});

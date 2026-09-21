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

  it('renders the report only, launches no browser, and records the report on the brief (revision 24)', async () => {
    const written = makeBrief({ bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }] });
    await runDir.writeJson('rollup/brief.json', written);
    const launcher = fakeLauncher();
    const out = await stage.run(ctx(launcher));
    expect(out).to.deep.equal({ report: 'rollup/report.html', image: null });
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'report.html'))).to.equal(true);
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'brief.png'))).to.equal(false);
    expect(launcher.launch.called).to.equal(false);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.image).to.equal(null);
    expect(brief.report).to.deep.equal({ path: 'rollup/report.html', slack_file_id: null, ts: null });
    expect(fs.readFileSync(path.join(runDir.root, 'rollup', 'report.html'), 'utf8')).to.include('912');
  });

  it('renders the report for a heartbeat without a report share', async () => {
    await runDir.writeJson('rollup/brief.json', makeBrief({ kind: 'heartbeat', headline: 'All quiet', bullets: [] }));
    const out = await stage.run(ctx(fakeLauncher()));
    expect(out.image).to.equal(null);
    expect(fs.existsSync(path.join(runDir.root, 'rollup', 'report.html'))).to.equal(true);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.image).to.equal(null);
    expect(brief.report).to.equal(null);
  });

  it('links the report to the hosted panels by default and to nothing when links are none (revision 24)', async () => {
    await runDir.writeJson('rollup/brief.json', makeBrief({
      bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
    }));
    await runDir.writeJson('rollup/standing.json', [{
      rule: 'backlog_absolute', project_url: 'https://beta.example.org', host: 'beta.example.org', group: 'Other',
      metric: 'cht_outbound_push_backlog_count', value: 12, previous_day_value: 10,
      panel_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 2, panel_title: 'Outbound Push Backlog', ref_id: 'A' },
    }]);
    await stage.run(ctx(fakeLauncher()));
    const linked = fs.readFileSync(path.join(runDir.root, 'rollup', 'report.html'), 'utf8');
    expect(linked).to.include('href="https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview?');
    expect(linked).to.include('var-cht_instance=beta.example.org');
    expect(linked).to.include('href="https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts"');
    const none = ctx(fakeLauncher());
    none.config = { ...makeConfig(), publish: { reportLinks: 'none' } };
    await stage.run(none);
    const bare = fs.readFileSync(path.join(runDir.root, 'rollup', 'report.html'), 'utf8');
    expect(bare).to.not.include('href=');
    expect(bare).to.include('beta.example.org');
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

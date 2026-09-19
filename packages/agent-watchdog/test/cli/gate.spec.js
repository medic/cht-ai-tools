const { createFindingsGate } = require('../../src/cli/gate');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const config = {
  endpoints: {
    grafanaUrl: 'https://watchdog.example.org',
    langfuseBaseUrl: 'https://langfuse.example.org',
    promptsUrl: 'https://github.com/medic/cht-ai-tools',
    configUrl: 'https://github.com/medic/medic-infrastructure',
    docsMcpUrl: 'https://docs-mcp.example.org/mcp',
  },
  bounds: { httpTimeoutMs: 1000 },
};

describe('cli/gate adapter', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects: [], dashboards: [], metrics: [] });
    await runDir.writeGz('alpha-example-org/inputs/windows.json.gz', { windows: [{ metric: 'm', window: 'current' }] });
  });
  afterEach(() => removeDir(dataDir));

  it('fills in discovery, windows, allow-list, resolver and a per-pass attempt counter', async () => {
    const verifyFindings = sinon.stub().resolves({ report: { outcome: 'accepted' }, items: [] });
    const gate = createFindingsGate({ gateModule: { verifyFindings }, runDir, config, fetch: async () => null });
    const project = { slug: 'alpha-example-org', url: 'https://alpha.example.org', host: 'alpha.example.org' };
    const call = { findings: { pass: 1 }, pass: 1, project, candidates: [{ candidate_id: 'c' }], changes: [], toolResultUrls: ['https://a'] };
    await gate(call);
    await gate(call);
    await gate({ ...call, pass: 2 });
    expect(verifyFindings).to.have.been.calledThrice;
    const first = verifyFindings.firstCall.args[0];
    expect(first.discovery).to.deep.equal({ projects: [], dashboards: [], metrics: [] });
    expect(first.windows).to.deep.equal([{ metric: 'm', window: 'current' }]);
    expect(first.toolResultUrls).to.be.instanceOf(Set);
    expect(first.allowlist).to.be.an('array').that.is.not.empty;
    expect(first.resolveLinks).to.be.a('function');
    expect(first.grafanaUrl).to.equal('https://watchdog.example.org');
    expect([first.attempt, verifyFindings.secondCall.args[0].attempt, verifyFindings.thirdCall.args[0].attempt])
      .to.deep.equal([1, 2, 1]);
  });

  it('passes an empty window list for a project without collected windows', async () => {
    const verifyFindings = sinon.stub().resolves({ report: {}, items: [] });
    const gate = createFindingsGate({ gateModule: { verifyFindings }, runDir, config, fetch: async () => null });
    await gate({ findings: {}, pass: 1, project: { slug: 'nobody', url: 'https://n', host: 'n' } });
    expect(verifyFindings.firstCall.args[0].windows).to.deep.equal([]);
  });
});

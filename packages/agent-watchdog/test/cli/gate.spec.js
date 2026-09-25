const { createFindingsGate } = require('../../src/cli/gate');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const config = {
  endpoints: {
    grafanaUrl: 'https://watchdog.example.org',
    langfuseBaseUrl: 'https://langfuse.example.org',
    specsUrl: 'https://github.com/medic/cht-ai-tools',
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

  it('offline (replay) never builds a resolver and passes resolveLinks null so links report unresolved', async () => {
    const verifyFindings = sinon.stub().resolves({ report: {}, items: [] });
    const fetch = sinon.stub().rejects(new Error('fetch must not be called offline'));
    const gate = createFindingsGate({ gateModule: { verifyFindings }, runDir, config, fetch, offline: true });
    const project = { slug: 'alpha-example-org', url: 'https://alpha.example.org', host: 'alpha.example.org' };
    await gate({ findings: { pass: 1 }, pass: 1, project, candidates: [], changes: [], toolResultUrls: [] });
    const args = verifyFindings.firstCall.args[0];
    expect(args.resolveLinks).to.equal(null);
    expect(args.grafanaUrl).to.equal('https://watchdog.example.org');
    expect(args.allowlist).to.be.an('array').that.is.not.empty;
    expect(fetch).to.not.have.been.called;
  });

  it('offline mode with the real gate module reports links as not resolved instead of failing', async () => {
    const gateModule = require('../../src/verify/gate');
    const gate = createFindingsGate({ gateModule, runDir, config, fetch: sinon.stub(), offline: true });
    const project = { slug: 'alpha-example-org', url: 'https://alpha.example.org', host: 'alpha.example.org' };
    const findings = {
      project_url: project.url, pass: 1, items: [], not_selected: [], changes: [], converged: true, notes: '',
    };
    const { report } = await gate({ findings, pass: 1, project, candidates: [], changes: [], toolResultUrls: [] });
    const resolve = report.checks.find((c) => c.name === 'links_resolve');
    expect(resolve.status).to.equal('pass');
    expect(resolve.reasons).to.deep.equal(['not resolved (offline)']);
  });
});

describe('cli/gate adapter: the text the model was given (revision 23)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects: [], dashboards: [], metrics: [] });
  });
  afterEach(() => removeDir(dataDir));

  it('forwards givenText to the verification module, and an empty list when the loop sends none', async () => {
    const verifyFindings = sinon.stub().resolves({ report: {}, items: [] });
    const gate = createFindingsGate({
      gateModule: { verifyFindings }, runDir, config, fetch: async () => null, offline: true,
    });
    const project = { slug: 'alpha-example-org', url: 'https://alpha.example.org', host: 'alpha.example.org' };
    await gate({ findings: {}, pass: 1, project, givenText: ['prompt text', '{"count": 41}'] });
    expect(verifyFindings.firstCall.args[0].givenText).to.deep.equal(['prompt text', '{"count": 41}']);
    await gate({ findings: {}, pass: 2, project });
    expect(verifyFindings.secondCall.args[0].givenText).to.deep.equal([]);
    // The system prompt travels as text given for dates only (revision 36; forwarded since revision 37).
    await gate({ findings: {}, pass: 3, project, givenDateText: ['Run date (UTC): 2026-09-18', 'until 2026-10-10'] });
    expect(verifyFindings.thirdCall.args[0].givenDateText).to.deep.equal([
      'Run date (UTC): 2026-09-18', 'until 2026-10-10',
    ]);
    expect(verifyFindings.secondCall.args[0].givenDateText).to.deep.equal([]);
  });
});

describe('cli/gate adapter: the production path of the revision 36 fixes (revision 37)', () => {
  const gateModule = require('../../src/verify/gate');
  const { buildEgress, guardFetch } = require('../../src/net/egress');
  const helpers = require('../verify/helpers/context');
  let dataDir;
  let runDir;
  let ctx;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    ctx = helpers.baseContext();
    await runDir.writeJson('discovery.json', ctx.discovery);
    await runDir.writeGz(`${ctx.project.slug}/inputs/windows.json.gz`, { windows: ctx.windows });
  });
  afterEach(() => removeDir(dataDir));

  const findingsCall = (findings, extra = {}) => ({
    findings, pass: 1, project: ctx.project, candidates: ctx.candidates, changes: ctx.changes, toolResultUrls: [],
    givenText: [], ...extra,
  });

  it('exempts a date the system prompt gave, through the real verification module', async () => {
    const gate = createFindingsGate({
      gateModule, runDir, config: helpers.config, fetch: async () => null, offline: true,
    });
    const findings = JSON.parse(JSON.stringify(ctx.findings));
    findings.items[0].why_now += ' Volumes are expected until 2026-10-10 (campaign).';
    const refused = await gate(findingsCall(findings));
    expect(refused.report.checks.find((c) => c.name === 'dates_match').status).to.equal('fail');
    const given = await gate(findingsCall(findings, {
      givenDateText: ['- campaign: Measles campaign until 2026-10-10'],
    }));
    expect(given.report.checks.find((c) => c.name === 'dates_match').status).to.equal('pass');
  });

  it('records a cited link outside the egress list as not requested and finishes the pass', async () => {
    const cfg = { ...helpers.config, bounds: { httpTimeoutMs: 100 } };
    const inner = sinon.stub().resolves(new Response(null, { status: 200 }));
    const gate = createFindingsGate({ gateModule, runDir, config: cfg, fetch: guardFetch(inner, buildEgress(cfg)) });
    const url = 'https://docs.communityhealthtoolkit.org:8443/hosting/monitoring/';
    const findings = JSON.parse(JSON.stringify(ctx.findings));
    findings.items[0].reference_urls = [url];
    const verdict = await gate(findingsCall(findings, { toolResultUrls: [url] }));
    expect(verdict.report.outcome).to.equal('rejected');
    const resolve = verdict.report.checks.find((c) => c.name === 'links_resolve');
    expect(resolve.reasons.join(' ')).to.include('outside the egress list');
    expect(inner.called).to.equal(false);
  });
});

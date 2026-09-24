// The tools-server command: the same local tools the agent stage builds, served to the `claude` CLI engine.
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const toolsServer = require('../../src/cli/commands/tools-server');
const { buildTools, SERVERS } = require('../../src/cli/commands/tools-server');
const codes = require('../../src/cli/exit-codes');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const METRIC = 'cht_sentinel_backlog_count';
const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
  cb(); 
} }) });
const parse = (out) => JSON.parse(out.content[0].text);
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

describe('cli/commands/tools-server', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', {
      run_start: '2026-09-18T06:00:00Z', projects: [project], metrics: [METRIC], dashboards: [],
    });
    await runDir.writeJson(`${project.slug}/changes.json`, [{ metric: METRIC, current_value: 912 }]);
    await runDir.writeGz(`${project.slug}/inputs/windows.json.gz`, {
      windows: [
        { metric: METRIC, window: 'current', values: [[1, 912]] }, { metric: 'other', window: 'current', values: [] },
      ],
    });
    await runDir.appendJsonl(`${project.slug}/recorded-tool-calls.jsonl`, {
      tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: METRIC },
      tool_response: JSON.stringify({ recorded: true }),
    });
    await runDir.appendJsonl(`${project.slug}/recorded-tool-calls.jsonl`, {
      tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel' }, tool_response: 'Source: https://d/s',
    });
  });
  afterEach(() => removeDir(dataDir));

  const base = (overrides = {}) => ({
    runRoot: runDir.root, dataDir, slug: project.slug, server: 'watchdog', replay: false, config: null, logger,
    ...overrides,
  });

  it('builds the four watchdog tools reading windows and changes from the run directory', async () => {
    const tools = byName(await buildTools(base()));
    expect(Object.keys(tools).sort())
      .to.deep.equal(['get_item_history', 'get_windows', 'query_metric', 'read_pattern_card']);
    const out = parse(await tools.get_windows.handler({ metric: METRIC }));
    expect(out.windows).to.deep.equal([{ metric: METRIC, window: 'current', values: [[1, 912]] }]);
    expect(out.change).to.deep.equal({ metric: METRIC, current_value: 912 });
    const history = parse(await tools.get_item_history.handler({ metric: METRIC, pattern_card: null }));
    expect(history).to.deep.equal({ history: [] });
  });

  it('answers query_metric as unavailable without Grafana, and live through an injected query', async () => {
    const offline = byName(await buildTools(base()));
    const miss = parse(await offline.query_metric.handler({ metric: METRIC, window: 'previous_week' }));
    expect(miss.unavailable).to.equal(true);
    const queryWindow = sinon.stub().resolves({ window: 'previous_week', values: [[1, 1]] });
    const live = byName(await buildTools(base({ deps: { queryWindow } })));
    const hit = parse(await live.query_metric.handler({ metric: METRIC, window: 'previous_week' }));
    expect(hit.values).to.deep.equal([[1, 1]]);
    expect(queryWindow).to.have.been.calledWith(sinon.match({ slug: project.slug }), METRIC, 'previous_week');
  });

  it('wires a live query window from the Grafana configuration when it is present', async () => {
    const fetch = sinon.stub().resolves(new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: { instance: project.host }, values: [[1, '5']] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const config = {
      endpoints: { grafanaUrl: 'https://watchdog.example.org', prometheusDatasourceUid: 'PBFA97CFB590B2093' },
      secrets: { grafanaToken: 'glsa_test' },
      bounds: { httpTimeoutMs: 1000 },
    };
    const tools = byName(await buildTools(base({ config, deps: { fetch } })));
    const hit = parse(await tools.query_metric.handler({ metric: METRIC, window: 'previous_week' }));
    expect(hit.available).to.equal(true);
    expect(hit.values).to.deep.equal([[1, 5]]);
    expect(fetch).to.have.been.calledOnce;
    expect(fetch.firstCall.args[0]).to.include('/api/datasources/proxy/uid/PBFA97CFB590B2093/api/v1/query_range');
  });

  it('serves recordings under --replay for the watchdog server and the documentation server', async () => {
    const watchdog = byName(await buildTools(base({ replay: true })));
    expect(parse(await watchdog.get_windows.handler({ metric: METRIC }))).to.deep.equal({ recorded: true });
    expect(parse(await watchdog.get_windows.handler({ metric: 'other' })))
      .to.deep.equal({ unavailable: true, reason: 'not recorded' });
    const docs = byName(await buildTools(base({ replay: true, server: 'cht-docs' })));
    expect(Object.keys(docs).sort()).to.deep.equal(['get_sources', 'search_docs']);
    expect((await docs.search_docs.handler({ query: 'sentinel' })).content[0].text).to.equal('Source: https://d/s');
    expect(parse(await docs.search_docs.handler({ query: 'x' })))
      .to.deep.equal({ unavailable: true, reason: 'not recorded' });
  });

  it('refuses the documentation server outside replay and unknown servers', async () => {
    await expect(buildTools(base({ server: 'cht-docs' })))
      .to.be.rejectedWith(codes.ExitError).and.eventually.have.property('code', codes.USAGE);
    await expect(buildTools(base({ server: 'shell' })))
      .to.be.rejectedWith(codes.ExitError).and.eventually.have.property('code', codes.USAGE);
    expect(SERVERS).to.deep.equal(['watchdog', 'cht-docs']);
  });

  it('serves the merged pattern cards of config.paths.skillDir to read_pattern_card (revision 34)', async () => {
    const { PACKAGE_PATHS } = require('../../src/config/schema');
    const { renderCardFile } = require('../../src/corpus/cards');
    const skillDir = tempDir();
    fs.cpSync(PACKAGE_PATHS.skillDir, skillDir, { recursive: true });
    const card = {
      card_id: 'sentinel-stall', title: 'Sentinel stall',
      symptom: 'Backlog climbs.', metrics: [{ metric: METRIC, shape: 'rises' }],
      watchdog_appearance: 'Panel climbs.', root_cause: 'Transition error.', resolution: 'Fix it.',
      confirmation_steps: ['Read the sentinel log.'], false_positives: [], sources: [], status: 'merged',
    };
    fs.writeFileSync(path.join(skillDir, 'pattern-cards', 'sentinel-stall.md'), renderCardFile(card, {}));
    try {
      const tools = byName(await buildTools(base({ config: { paths: { skillDir } } })));
      const out = parse(await tools.read_pattern_card.handler({ card_id: 'sentinel-stall' }));
      expect(out.card_id).to.equal('sentinel-stall');
      expect(out.text).to.include('Sentinel stall');
      const none = byName(await buildTools(base()));
      const missing = parse(await none.read_pattern_card.handler({ card_id: 'sentinel-stall' }));
      expect(missing.error).to.include('unknown card');
    } finally {
      removeDir(skillDir);
    }
  });

  it('hands the live query the project\'s active expected-load window, so previous_cycle is known', async () => {
    const fetch = sinon.stub().resolves(new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: { instance: project.host }, values: [[1, '5']] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const config = {
      endpoints: { grafanaUrl: 'https://watchdog.example.org', prometheusDatasourceUid: 'PBFA97CFB590B2093' },
      secrets: { grafanaToken: 'glsa_test' },
      bounds: { httpTimeoutMs: 1000 },
    };
    const windowed = {
      ...project,
      expected_load_windows: [{
        id: 'always', kind: 'dates', start: '2026-01-01', end: '2026-12-31', timezone: 'UTC', note: 'n', cycle_days: 30,
      }],
    };
    await runDir.writeJson('discovery.json', {
      run_start: '2026-09-18T06:00:00Z', projects: [windowed], metrics: [METRIC], dashboards: [],
    });
    const tools = byName(await buildTools(base({ config, deps: { fetch } })));
    const hit = parse(await tools.query_metric.handler({ metric: METRIC, window: 'previous_cycle' }));
    expect(hit.available).to.equal(true);
    expect(hit.start).to.equal('2026-08-18T06:00:00.000Z');
  });

  describe('command handler', () => {
    const env = { AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR };
    const call = (flags, deps = {}) => toolsServer({
      command: 'tools-server', flags, positionals: [], env, logger, deps,
    });

    it('validates its flags with usage and data errors', async () => {
      await expect(call({ project: [project.slug] }))
        .to.be.rejectedWith(/--run-dir/).and.eventually.have.property('code', codes.USAGE);
      await expect(call({ 'run-dir': runDir.root }))
        .to.be.rejectedWith(/--project/).and.eventually.have.property('code', codes.USAGE);
      await expect(call({ 'run-dir': runDir.root, project: [project.slug], server: 'shell' }))
        .to.be.rejectedWith(/unknown server/).and.eventually.have.property('code', codes.USAGE);
      await expect(call({ 'run-dir': path.join(dataDir, 'missing'), project: [project.slug] }))
        .to.be.rejectedWith(/run directory/).and.eventually.have.property('code', codes.DATAERR);
      await expect(call({ 'run-dir': runDir.root, project: ['nobody'] }))
        .to.be.rejectedWith(/project/).and.eventually.have.property('code', codes.DATAERR);
    });

    it('builds the tools and hands them to the stdio server, returning 0 when the transport closes', async () => {
      const serve = sinon.stub().resolves();
      const code = await call({ 'run-dir': runDir.root, 'data-dir': dataDir, project: [project.slug] }, { serve });
      expect(code).to.equal(0);
      expect(serve).to.have.been.calledOnce;
      const options = serve.firstCall.args[0];
      expect(options.name).to.equal('watchdog');
      expect(options.tools.map((t) => t.name).sort())
        .to.deep.equal(['get_item_history', 'get_windows', 'query_metric', 'read_pattern_card']);
      expect(fs.existsSync(runDir.root)).to.equal(true);
    });

    it('serves the recorded documentation tools when asked for --server cht-docs --replay', async () => {
      const serve = sinon.stub().resolves();
      await call({
        'run-dir': runDir.root, 'data-dir': dataDir, project: [project.slug], server: 'cht-docs', replay: true,
      }, { serve });
      const options = serve.firstCall.args[0];
      expect(options.name).to.equal('cht-docs');
      expect(options.tools.map((t) => t.name).sort()).to.deep.equal(['get_sources', 'search_docs']);
    });
  });
  describe('the egress guard (FR-083, revision 33)', () => {
    it('serves under the egress guard on the global fetch and restores it afterwards', async () => {
      const before = globalThis.fetch;
      let seen = null;
      const serve = async () => {
        seen = { guarded: globalThis.fetch.egressGuard === true, same: globalThis.fetch === before };
      };
      const env = { AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR };
      const code = await toolsServer({
        command: 'tools-server', flags: { 'run-dir': runDir.root, project: [project.slug] }, positionals: [], env,
        logger, deps: { serve },
      });
      expect(code).to.equal(0);
      expect(seen).to.deep.equal({ guarded: true, same: false });
      expect(globalThis.fetch).to.equal(before);
    });
  });
});

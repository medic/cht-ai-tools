const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const stage = require('../../src/cli/stages/agent');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir, ensureDataLayout, dataPaths } = require('../../src/store/run-dir');
const { createFakeEngine } = require('../helpers/fake-engine');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');

const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' };
const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
const projects = [
  { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' },
  { host: 'beta.example.org', url: 'https://beta.example.org', slug: 'beta-example-org' },
  { host: 'gamma.example.org', url: 'https://gamma.example.org', slug: 'gamma-example-org' },
];
const METRIC = 'cht_sentinel_backlog_count';
const WINDOW = { from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' };
const acceptedItem = (projectUrl, metric) => ({
  item_id: 'abcdefabcdef', project_url: projectUrl, metric, severity: 'high',
  evidence: [{ window: 'current', value: 1, unit: 'count' }],
  why_now: 'w', suggested_check: 's', confidence: 0.5, persisting_days: 1, pattern_card: null,
  candidate_ids: ['c1'], reference_urls: [],
  dashboard_ref: { dashboard_uid: 'd', panel_id: 1, project_url: projectUrl, ...WINDOW },
  rank: null, placement: null, pass_history: [],
});
const gate = async ({ findings, project }) => ({
  report: { subject: 'pass', subject_ref: `${project.slug}/pass1`, attempt: 1, checks: [], outcome: 'accepted' },
  items: (findings && findings.items ? findings.items : []).map((i) => acceptedItem(project.url, i.item_key.metric)),
});
const findingsFor = (project, metric) => ({
  project_url: project.url, pass: 1, converged: true, not_selected: [], changes: [], notes: '',
  items: [{
    item_key: { metric, pattern_card: null }, severity: 'high',
    evidence: [{ window: 'current', value: 1, unit: 'count' }],
    why_now: 'w', suggested_check: 's', dashboard_ref: { dashboard_uid: 'd', panel_id: 1, ...WINDOW },
    confidence: 0.5, candidate_ids: ['c1'], reference_urls: [],
  }],
});
const projectFor = (userText) => projects.find((p) => userText.includes(p.url));
const plainResult = {
  subtype: 'success', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: 's',
};

describe('cli/stages/agent', () => {
  let dataDir;
  let runDir;
  const logs = [];
  const logger = createLogger({
    level: 'debug',
    stream: new Writable({ write(c, e, cb) {
      logs.push(JSON.parse(c.toString())); cb(); 
    } }),
  });

  beforeEach(async () => {
    logs.length = 0;
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects, metrics: [METRIC] });
    // alpha and gamma have candidates; beta has none
    for (const p of projects) {
      const changes = [{ metric: METRIC, current_value: 1, expected_load_window_id: null }];
      await runDir.writeJson(`${p.slug}/changes.json`, { changes });
      const candidates = p.slug === 'beta-example-org'
        ? []
        : [{ candidate_id: 'c1', project_url: p.url, metric: METRIC, rule: 'monotonic' }];
      await runDir.writeJson(`${p.slug}/candidates.json`, { candidates });
      await runDir.writeGz(`${p.slug}/inputs/windows.json.gz`, { windows: [] });
    }
    fs.writeFileSync(dataPaths(dataDir).memoryFile, 'remember this');
  });
  afterEach(() => removeDir(dataDir));

  const ctx = (engine, overrides = {}) => ({
    config: {
      model: { name: 'm', effort: 'max' },
      storage: { dataDir },
      paths: PACKAGE_PATHS,
      bounds: {
        maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000, verifyMaxRetries: 0, passes: 1,
        passConvergence: true,
        projectConcurrency: 2, runTimeoutMs: 60000,
      },
      secrets: {},
      endpoints: {},
    },
    env, runDir, runId: '2026-09-18', date: '2026-09-18', logger, tracer: null,
    deps: { engine, gate, definition, ...overrides.deps },
    ...overrides,
  });

  it('declares its name and inputs', () => {
    expect(stage.name).to.equal('agent');
    expect(stage.inputs).to.deep.equal(['discovery.json']);
  });

  it('runs a session for every project with candidates and skips the rest without any engine call', async () => {
    const engine = createFakeEngine({
      responses: (userText) => ({ structuredOutput: findingsFor(projectFor(userText), METRIC) }),
    });
    const result = await stage.run(ctx(engine));
    expect(result.projects_analysed).to.deep.equal(['https://alpha.example.org', 'https://gamma.example.org']);
    expect(result.projects_skipped).to.deep.equal(['https://beta.example.org']);
    expect(engine.sessions).to.have.length(2);
    expect(result.items).to.have.length(2);
    expect(result.bounds_hit).to.deep.equal([]);
    expect(result.reference_sources_unavailable).to.equal(false);
    expect(result.cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(logs.some((l) => l.event === 'agent.skip' && l.project_url === 'https://beta.example.org')).to.equal(true);
    expect(fs.existsSync(path.join(runDir.root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(true);
    expect(fs.existsSync(path.join(runDir.root, 'beta-example-org', 'findings.pass1.json'))).to.equal(false);
    expect(fs.existsSync(path.join(runDir.root, 'agent.summary.json'))).to.equal(true);
    expect(engine.sessions[0].options.systemPrompt[2]).to.include('remember this');
  });

  it('refuses to start without a gate and without its input file', async () => {
    const engine = createFakeEngine({ responses: [] });
    await expect(stage.run(ctx(engine, { deps: { engine, definition, gate: null } }))).to.be.rejectedWith(/gate/);
    fs.rmSync(runDir.path('discovery.json'));
    await expect(stage.run(ctx(engine))).to.be.rejected.and.eventually.have.property('code', 65);
  });

  it('limits concurrency to the configured number of sessions', async () => {
    let inFlight = 0;
    let peak = 0;
    const engine = createFakeEngine({ responses: [] });
    const base = engine.openSession;
    engine.openSession = async (options) => {
      const session = await base(options);
      session.turn = async (text) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return {
          structuredOutput: findingsFor(projectFor(text), METRIC),
          result: plainResult,
          toolCalls: [],
          referenceUnavailable: false,
        };
      };
      return session;
    };
    const context = ctx(engine);
    context.config.bounds.projectConcurrency = 1;
    await stage.run(context);
    expect(peak).to.equal(1);
  });

  it('propagates the reference-source flag and bounds from any project', async () => {
    const engine = createFakeEngine({ responses: (userText) => {
      const project = projectFor(userText);
      return {
        structuredOutput: findingsFor(project, METRIC),
        referenceUnavailable: project.slug === 'gamma-example-org',
        result: project.slug === 'alpha-example-org' ? { subtype: 'error_max_budget_usd' } : {},
      };
    } });
    const result = await stage.run(ctx(engine));
    expect(result.reference_sources_unavailable).to.equal(true);
    expect(result.bounds_hit).to.deep.equal(['budget']);
  });
});

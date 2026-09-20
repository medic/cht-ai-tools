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
const { createReplayLookup } = require('../../src/agent/tools/replay-shim');

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

  it('stops starting sessions at the run budget and names the projects left unanalysed', async () => {
    // Two projects have candidates (alpha, gamma) and each session costs 0.8; a run budget of 1.0 leaves 0.2 for
    // the second session, below the 0.25 minimum, so it is never opened.
    const engine = createFakeEngine({ responses: (text) => ({
      structuredOutput: findingsFor(projectFor(text), METRIC), result: { total_cost_usd: 0.8 },
    }) });
    const context = ctx(engine);
    context.config.bounds.projectConcurrency = 1;
    context.config.bounds.maxBudgetUsdRun = 1.0;
    const summary = await stage.run(context);
    expect(engine.sessions).to.have.length(1);
    expect(engine.sessions[0].options.bounds.maxBudgetUsd, 'the first session gets the project budget').to.equal(1);
    expect(summary.projects_analysed).to.have.length(1);
    expect(summary.run_budget).to.deep.equal({
      limit: 1, spent: 0.8, reached: true, not_analysed: [projects.find((p) => p.slug === 'gamma-example-org').url],
    });
    expect(summary.bounds_hit).to.include('budget');
    expect(logs.some((l) => l.event === 'agent.run_budget_reached' && l.not_analysed === 1)).to.equal(true);
    const written = await runDir.readJson('agent.summary.json');
    expect(written.run_budget.not_analysed).to.have.length(1);
  });

  it('grants a session only what the run budget still allows', async () => {
    const engine = createFakeEngine({ responses: (text) => ({
      structuredOutput: findingsFor(projectFor(text), METRIC), result: { total_cost_usd: 0.5 },
    }) });
    const context = ctx(engine);
    context.config.bounds.projectConcurrency = 1;
    context.config.bounds.maxBudgetUsdRun = 1.3;
    const summary = await stage.run(context);
    expect(engine.sessions.map((s) => s.options.bounds.maxBudgetUsd)).to.deep.equal([1, 0.8]);
    expect(summary.run_budget).to.deep.equal({ limit: 1.3, spent: 1, reached: false, not_analysed: [] });
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

  it('restricts the sessions to --project hosts when the flag is given', async () => {
    const engine = createFakeEngine({
      responses: (userText) => ({ structuredOutput: findingsFor(projectFor(userText), METRIC) }),
    });
    const result = await stage.run(ctx(engine, { flags: { project: ['https://gamma.example.org/'] } }));
    expect(result.projects_analysed).to.deep.equal(['https://gamma.example.org']);
    expect(engine.sessions).to.have.length(1);
    expect(result.projects_skipped).to.deep.equal([]);
  });

  describe('replay mode', () => {
    const recordings = [
      {
        pass: 1, attempt: 1, ts: '2026-09-18T06:01:00Z', tool_name: 'mcp__watchdog__get_windows',
        tool_input: { metric: METRIC },
        tool_response: JSON.stringify({
          windows: [{ window: 'current', values: [[1, 7]] }], change: { current_value: 7 },
        }),
      },
      {
        pass: 1, attempt: 1, ts: '2026-09-18T06:01:01Z', tool_name: 'mcp__cht-docs__search_docs',
        tool_input: { query: 'sentinel' },
        tool_response: '**Sentinel**\nSource: https://docs.communityhealthtoolkit.org/sentinel',
      },
    ];
    const text = (out) => out.content[0].text;

    // A fake engine whose turn exercises the in-process tools the stage attached to the session.
    const toolCallingEngine = () => {
      const engine = createFakeEngine({ responses: [] });
      const base = engine.openSession;
      engine.openSession = async (options) => {
        const session = await base(options);
        session.turn = async (userText) => {
          const windows = options.localTools.find((t) => t.name === 'get_windows');
          const query = options.localTools.find((t) => t.name === 'query_metric');
          // Live sessions have no in-process documentation server; replay serves it from recordings.
          const search = (options.localServers['cht-docs'] || []).find((t) => t.name === 'search_docs') || null;
          session.replayed = {
            windows: JSON.parse(text(await windows.handler({ metric: METRIC }))),
            query: JSON.parse(text(await query.handler({ metric: METRIC, window: 'previous_week' }))),
            doc: search ? text(await search.handler({ query: 'sentinel' })) : null,
            miss: search ? JSON.parse(text(await search.handler({ query: 'never asked before' }))) : null,
          };
          return {
            structuredOutput: findingsFor(projectFor(userText), METRIC), result: plainResult, toolCalls: [],
            referenceUnavailable: false,
          };
        };
        return session;
      };
      return engine;
    };

    it('serves recorded results in-process, attaches no remote server and reports what was not recorded', async () => {
      const unavailable = [];
      const queryWindow = sinon.stub().resolves({ live: true });
      const engine = toolCallingEngine();
      const context = ctx(engine, {
        deps: { engine, gate, definition, queryWindow },
        replay: {
          recordedFor: (slug) => (slug === 'alpha-example-org' ? createReplayLookup(recordings) : null),
          onUnavailable: (slug, call) => unavailable.push({ slug, tool: call.tool }),
        },
      });
      const result = await stage.run(context);
      expect(result.projects_analysed).to.deep.equal(['https://alpha.example.org', 'https://gamma.example.org']);
      const bySlug = Object.fromEntries(engine.sessions.map((s) => [s.options.sessionName, s]));
      const alpha = bySlug['alpha-example-org'];
      const gamma = bySlug['gamma-example-org'];
      for (const session of [alpha, gamma]) {
        expect(session.options.mcpConfig).to.deep.equal({ mcpServers: {} });
        expect(session.options.localServers['cht-docs'].map((t) => t.name))
          .to.deep.equal(['search_docs', 'get_sources']);
        expect(session.replayed.miss).to.deep.equal({ unavailable: true, reason: 'not recorded' });
      }
      expect(alpha.replayed.windows).to.deep.equal({
        windows: [{ window: 'current', values: [[1, 7]] }], change: { current_value: 7 },
      });
      expect(alpha.replayed.doc).to.include('Source: https://docs.communityhealthtoolkit.org/sentinel');
      expect(alpha.replayed.query).to.deep.equal({ unavailable: true, reason: 'not recorded' });
      // gamma has no recordings at all: every call is unavailable and nothing is fetched live
      expect(gamma.replayed.windows).to.deep.equal({ unavailable: true, reason: 'not recorded' });
      expect(gamma.replayed.doc).to.equal(JSON.stringify({ unavailable: true, reason: 'not recorded' }));
      expect(queryWindow).to.not.have.been.called;
      const counts = unavailable.reduce((acc, u) => ({ ...acc, [u.slug]: (acc[u.slug] || 0) + 1 }), {});
      expect(counts).to.deep.equal({ 'alpha-example-org': 2, 'gamma-example-org': 4 });
      expect(unavailable.filter((u) => u.slug === 'alpha-example-org').map((u) => u.tool).sort())
        .to.deep.equal(['query_metric', 'search_docs']);
    });

    it('keeps the live wiring when no replay context is present', async () => {
      const engine = toolCallingEngine();
      const queryWindow = sinon.stub().resolves({ live: true });
      const result = await stage.run(ctx(engine, { deps: { engine, gate, definition, queryWindow } }));
      expect(result.projects_analysed).to.have.length(2);
      const session = engine.sessions[0];
      expect(session.options.mcpConfig.mcpServers).to.have.property('cht-docs');
      expect(session.options.localServers).to.deep.equal({});
      expect(session.replayed.query).to.deep.equal({ live: true });
      expect(session.replayed.windows.windows).to.deep.equal([]);
    });
  });
});

describe('cli/stages/agent (stage inputs)', () => {
  let dataDir;
  let runDir;
  const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
    cb();
  } }) });

  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects: projects.slice(0, 1), metrics: [METRIC] });
    await runDir.writeJson('alpha-example-org/candidates.json', [
      { candidate_id: 'c1', project_url: projects[0].url, metric: METRIC, rule: 'monotonic' },
    ]);
  });
  afterEach(() => removeDir(dataDir));

  it('exits 65 naming <slug>/changes.json when candidates exist but the computed changes are missing', async () => {
    const engine = createFakeEngine({ responses: [] });
    const context = {
      config: {
        model: { name: 'm', effort: 'max' }, storage: { dataDir }, paths: PACKAGE_PATHS, secrets: {}, endpoints: {},
        bounds: {
          maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000, verifyMaxRetries: 0, passes: 1,
          passConvergence: true, projectConcurrency: 1, runTimeoutMs: 60000,
        },
      },
      env, runDir, runId: '2026-09-18', date: '2026-09-18', logger, tracer: null,
      deps: { engine, gate, definition },
    };
    let error;
    try {
      await stage.run(context);
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the stage to refuse').to.be.instanceOf(Error);
    expect(error.code).to.equal(65);
    expect(error.message).to.include('alpha-example-org/changes.json');
    expect(engine.sessions).to.have.length(0);
  });
});

describe('cli/stages/agent (pattern cards from the skill directory)', () => {
  const { renderCardFile } = require('../../src/corpus/cards');
  let dataDir;
  let runDir;
  let skillDir;
  const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
    cb();
  } }) });
  const card = {
    card_id: 'sentinel-stall', title: 'Sentinel stall',
    symptom: 'Backlog climbs.', metrics: [{ metric: METRIC, shape: 'rises' }],
    watchdog_appearance: 'Panel climbs.', root_cause: 'Transition error.', resolution: 'Fix it.',
    confirmation_steps: ['Read the sentinel log.'], false_positives: [], sources: [], status: 'merged',
  };

  beforeEach(async () => {
    dataDir = tempDir();
    skillDir = tempDir();
    fs.cpSync(PACKAGE_PATHS.skillDir, skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'pattern-cards', 'sentinel-stall.md'), renderCardFile(card, {}));
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects: projects.slice(0, 1), metrics: [METRIC] });
    await runDir.writeJson('alpha-example-org/changes.json', [{ metric: METRIC, current_value: 1 }]);
    await runDir.writeJson('alpha-example-org/candidates.json', [
      { candidate_id: 'c1', project_url: projects[0].url, metric: METRIC, rule: 'monotonic' },
    ]);
  });
  afterEach(() => {
    removeDir(dataDir);
    removeDir(skillDir);
  });

  it('loads the merged cards of config.paths.skillDir for read_pattern_card when none are injected', async () => {
    const engine = createFakeEngine({ responses: () => ({ structuredOutput: findingsFor(projects[0], METRIC) }) });
    const context = {
      config: {
        model: { name: 'm', effort: 'max' }, storage: { dataDir }, paths: { ...PACKAGE_PATHS, skillDir },
        secrets: {}, endpoints: {},
        bounds: {
          maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000, verifyMaxRetries: 0, passes: 1,
          passConvergence: true, projectConcurrency: 1, runTimeoutMs: 60000,
        },
      },
      env, runDir, runId: '2026-09-18', date: '2026-09-18', logger, tracer: null,
      deps: { engine, gate, definition },
    };
    await stage.run(context);
    const read = engine.sessions[0].options.localTools.find((t) => t.name === 'read_pattern_card');
    const out = JSON.parse((await read.handler({ card_id: 'sentinel-stall' })).content[0].text);
    expect(out.text).to.include('Read the sentinel log.');
    const miss = JSON.parse((await read.handler({ card_id: 'other' })).content[0].text);
    expect(miss.error).to.include('unknown card');
  });
});

describe('cli/stages/agent: alerts as context (User Story 8)', () => {
  const { RunDir: RunDirectory, ensureDataLayout: ensureLayout } = require('../../src/store/run-dir');
  const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
    cb();
  } }) });
  const { createFakeEngine: fakeEngine } = require('../helpers/fake-engine');
  const { tempDir: mkTemp, removeDir: rmDir } = require('../helpers/fixtures');
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = mkTemp();
    await ensureLayout(dataDir);
    runDir = await RunDirectory.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', { projects, metrics: [METRIC] });
    for (const p of projects) {
      await runDir.writeJson(`${p.slug}/changes.json`, {
        changes: [{ metric: METRIC, current_value: 1, expected_load_window_id: null }],
      });
      const candidates = p.slug === 'beta-example-org'
        ? []
        : [{ candidate_id: 'c1', project_url: p.url, metric: METRIC, rule: 'monotonic' }];
      await runDir.writeJson(`${p.slug}/candidates.json`, { candidates });
      await runDir.writeGz(`${p.slug}/inputs/windows.json.gz`, { windows: [] });
    }
    await runDir.writeJson('alerts.classified.json', {
      available: true,
      instances: [
        {
          instance_id: 'a'.repeat(12), title: 'Sentinel Backlog', project_url: 'https://alpha.example.org', host: 'alpha.example.org',
          category: 'backlog', importance: 'high', state: 'firing', started_at: '2026-09-17T20:00:00Z', days_firing: 0,
          stale: false, new: true, value: '1200', labels: {}, annotations: {},
        },
        {
          instance_id: 'b'.repeat(12), title: 'DB Fragmentation', project_url: 'https://alpha.example.org', host: 'alpha.example.org',
          category: 'database', importance: 'low', state: 'pending', started_at: '2026-09-18T05:00:00Z', days_firing: 0,
          stale: false, new: true, value: '9', labels: {}, annotations: {},
        },
      ],
      groups: [],
    });
  });
  afterEach(() => rmDir(dataDir));

  it('gives each session its project\'s firing alerts and nothing else', async () => {
    const engine = fakeEngine({
      responses: (userText) => ({ structuredOutput: findingsFor(projectFor(userText), METRIC) }),
    });
    const stageCtx = {
      config: {
        model: { name: 'm', effort: 'max' }, storage: { dataDir }, paths: PACKAGE_PATHS, secrets: {}, endpoints: {},
        bounds: {
          maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000, verifyMaxRetries: 0, passes: 1,
          passConvergence: true, projectConcurrency: 1, runTimeoutMs: 60000,
        },
      },
      env, runDir, runId: '2026-09-18', date: '2026-09-18', logger, tracer: null, deps: { engine, gate, definition },
    };
    await stage.run(stageCtx);
    const alphaSession = engine.sessions.find((s) => s.turns[0].includes('https://alpha.example.org'));
    const gammaSession = engine.sessions.find((s) => s.turns[0].includes('https://gamma.example.org'));
    expect(alphaSession.turns[0]).to.include('<untrusted source="alerts">');
    expect(alphaSession.turns[0]).to.include('Sentinel Backlog');
    expect(alphaSession.turns[0]).to.not.include('DB Fragmentation');
    expect(gammaSession.turns[0]).to.match(/no alert is firing/i);
  });
});

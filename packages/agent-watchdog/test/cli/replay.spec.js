// The replay command (contracts/cli.md "replay", FR-041, US3 scenario 3): findings are regenerated from a stored
// run's retained inputs with recorded tool results, never contacting Grafana or Slack, and compared with the original.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const replayCommand = require('../../src/cli/commands/replay');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { itemId } = require('../../src/model/identity');
const { createFakeEngine } = require('../helpers/fake-engine');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { buildStoredRun, METRIC } = require('../helpers/stored-run');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');

const capture = () => {
  const chunks = [];
  const stream = new Writable({
    write(c, e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
};

const envFor = (dataDir, extra = {}) => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  AGENT_WATCHDOG_GRAFANA_TOKEN: 'glsa_test',
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
  AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID: 'PBFA97CFB590B2093',
  AGENT_WATCHDOG_SLACK_CHANNEL_ID: 'C123',
  AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
  LANGFUSE_BASE_URL: 'https://langfuse.example.org',
  AGENT_WATCHDOG_SPECS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: dataDir,
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
  AGENT_WATCHDOG_PASSES: '1', // the stored runs hold one pass; replay honours the current pass count
  ...extra,
});

const fakeTracer = () => ({
  start: sinon.stub().resolves({ traceId: 't-replay' }),
  stage: sinon.spy(async (name, fn) => fn()),
  generation: sinon.stub(),
  traceUrl: sinon.stub().resolves('https://langfuse.example.org/trace/t-replay'),
  finish: sinon.stub().resolves(),
  traceId: 't-replay',
});

const fakeSlack = () => ({
  chat: { postMessage: sinon.stub().resolves({ ok: true }) },
  files: { uploadV2: sinon.stub().resolves({ ok: true }) },
  conversations: { replies: sinon.stub().resolves({ ok: true, messages: [] }) },
});

// A gate that accepts every schema-shaped finding and derives the item identity by code, like the real one.
const acceptingGate = async ({ findings, project, pass }) => ({
  report: {
    subject: 'pass', subject_ref: `${project.slug}/pass${pass}`, attempt: 1, outcome: 'accepted',
    checks: [{ name: 'schema', status: 'pass', reasons: [] }],
  },
  items: (findings.items || []).map((item) => ({
    item_id: itemId(project.url, item.item_key.metric, item.item_key.pattern_card),
    project_url: project.url,
    metric: item.item_key.metric,
    severity: item.severity,
    evidence: item.evidence,
    why_now: item.why_now,
    suggested_check: item.suggested_check,
    // The real gate builds this from the run's windows (FR-009, revision 18).
    dashboard_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: project.url,
      from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' },
    confidence: item.confidence,
    persisting_days: 1,
    pattern_card: item.item_key.pattern_card,
    candidate_ids: item.candidate_ids,
    reference_urls: item.reference_urls,
    rank: null,
    placement: null,
    pass_history: [],
  })),
});

const projectOf = (userText, projects) => projects.find((p) => userText.includes(p.url));

const modelFindings = (project, { severity = 'high', value = 912 } = {}) => ({
  project_url: project.url,
  pass: 1,
  items: [{
    item_key: { metric: METRIC, pattern_card: null },
    severity,
    evidence: [{ window: 'current', value, unit: 'count' }, { window: 'previous_day', value: 300, unit: 'count' }],
    why_now: 'Sentinel backlog has climbed steadily for seven hours to three times yesterday.',
    suggested_check: 'Check sentinel logs for a stuck transition.',
    confidence: 0.85,
    candidate_ids: [project.candidate.candidate_id],
    reference_urls: [],
  }],
  not_selected: [],
  changes: [],
  converged: true,
  notes: '',
});

const invoke = async ({ dataDir, flags, deps = {}, env = {} }) => {
  const out = capture();
  const err = capture();
  const fetch = sinon.stub().rejects(new Error('fetch must never be called during replay'));
  const slack = fakeSlack();
  const args = {
    command: 'replay',
    flags,
    positionals: [],
    env: envFor(dataDir, env),
    stdout: out.stream,
    stderr: err.stream,
    logger: createLogger({ stream: err.stream, level: 'warn' }),
    deps: {
      tracer: fakeTracer(), gate: acceptingGate, fetch, slack, gitSha: 'replay1',
      now: () => new Date('2026-09-19T10:11:12Z'), ...deps,
    },
  };
  let code;
  let error;
  try {
    code = await replayCommand(args);
  } catch (e) {
    error = e;
  }
  return { code, error, out, err, fetch, slack, args };
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('cli/commands/replay', function () {
  this.timeout(20000);
  let dataDir;
  let stored;
  beforeEach(async () => {
    dataDir = tempDir();
    stored = await buildStoredRun({ dataDir });
  });
  afterEach(() => removeDir(dataDir));

  const findingsEngine = (mutate = () => ({})) => createFakeEngine({
    responses: (userText) => {
      const project = projectOf(userText, stored.projects);
      return { structuredOutput: modelFindings(project, mutate(project)) };
    },
  });

  it('regenerates findings under runs-replay/<run_id>/<label> in the run layout, printing the comparison', async () => {
    const engine = findingsEngine();
    const r = await invoke({ dataDir, flags: { date: '2026-09-18', label: 'baseline' }, deps: { engine } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    const root = path.join(dataDir, 'runs-replay', '2026-09-18', 'baseline');
    for (const rel of [
      'run.json', 'config.effective.json', 'discovery.json', 'comparison.json',
      'alpha-example-org/changes.json', 'alpha-example-org/candidates.json', 'alpha-example-org/suppressed.json',
      'alpha-example-org/inputs/windows.json.gz', 'alpha-example-org/recorded-tool-calls.jsonl',
      'alpha-example-org/prompt.pass1.md', 'alpha-example-org/findings.pass1.json',
      'alpha-example-org/verification.pass1.json', 'alpha-example-org/passes.json', 'alpha-example-org/session.json',
      'gamma-example-org/findings.pass1.json', 'agent.summary.json',
    ]) {
      expect(fs.existsSync(path.join(root, rel)), rel).to.equal(true);
    }
    expect(readJson(path.join(root, 'discovery.json')))
      .to.deep.equal(readJson(path.join(stored.runDir.root, 'discovery.json')));
    const run = readJson(path.join(root, 'run.json'));
    expect(run).to.include({
      run_id: '2026-09-18', replay_of: '2026-09-18', label: 'baseline', mode: 'replay', status: 'drafted',
    });
    expect(run.date).to.equal('2026-09-18');
    expect(run.versions.git_sha).to.equal('replay1');
    expect(run.versions.prompts_hash).to.match(/^[0-9a-f]{64}$/);
    expect(run.versions.config_hash).to.match(/^[0-9a-f]{64}$/);
    expect(run.source_versions).to.deep.equal(readJson(path.join(stored.runDir.root, 'run.json')).versions);
    expect(run.stages.map((s) => [s.name, s.status])).to.deep.equal([['agent', 'completed']]);
    expect(run.projects).to.deep.equal(['https://alpha.example.org', 'https://gamma.example.org']);
    expect(run.cost_usd).to.be.a('number');
    expect(run.trace_url).to.equal('https://langfuse.example.org/trace/t-replay');
    const printed = JSON.parse(r.out.text());
    expect(printed).to.deep.equal(readJson(path.join(root, 'comparison.json')));
    expect(printed).to.include({
      run_id: '2026-09-18', label: 'baseline', replay_dir: path.join('runs-replay', '2026-09-18', 'baseline'),
    });
    expect(printed.engine).to.equal('fake');
    expect(printed.prompts.hash).to.equal(run.versions.prompts_hash);
    expect(printed.skill.hash).to.equal(run.versions.skill_hash);
    expect(printed.projects.map((p) => p.slug)).to.deep.equal(['alpha-example-org', 'gamma-example-org']);
    const alpha = printed.projects[0];
    expect(alpha.before).to.deep.equal({ pass: 1, items: [stored.projects[0].item_id], gate: 'accepted' });
    expect(alpha.after).to.deep.equal({ pass: 1, items: [stored.projects[0].item_id], gate: 'accepted' });
    expect(alpha).to.include({ unavailable_tool_calls: 0 });
    expect(alpha.added).to.deep.equal([]);
    expect(alpha.removed).to.deep.equal([]);
    expect(alpha.changed).to.deep.equal([]);
    expect(printed.totals).to.deep.equal({
      projects: 2, before_items: 2, after_items: 2, added: 0, removed: 0, changed: 0, unavailable_tool_calls: 0,
    });
    expect(printed.cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(printed.duration_ms).to.be.a('number');
    expect(r.args.deps.tracer.start).to.have.been.calledWithMatch({ runId: '2026-09-18', mode: 'replay' });
    expect(r.args.deps.tracer.finish).to.have.been.calledOnce;
    // the original run is untouched
    expect(fs.existsSync(path.join(stored.runDir.root, 'comparison.json'))).to.equal(false);
    expect(readJson(path.join(stored.runDir.root, 'run.json')).status).to.equal('published');
  });

  it('never contacts Grafana or Slack: no fetch, no Slack call, no remote MCP server', async () => {
    const engine = findingsEngine();
    const r = await invoke({ dataDir, flags: { date: '2026-09-18', label: 'offline' }, deps: { engine } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.fetch).to.not.have.been.called;
    expect(r.slack.chat.postMessage).to.not.have.been.called;
    expect(r.slack.conversations.replies).to.not.have.been.called;
    for (const session of engine.sessions) {
      expect(session.options.mcpConfig).to.deep.equal({ mcpServers: {} });
      expect(session.options.localServers['cht-docs'].map((t) => t.name))
        .to.deep.equal(['search_docs', 'get_sources']);
    }
    const verification = readJson(
      path.join(dataDir, 'runs-replay', '2026-09-18', 'offline', 'alpha-example-org', 'verification.pass1.json'),
    );
    expect(verification.outcome).to.equal('accepted');
  });

  it('serves recorded tool results through the replay shim and counts what was not recorded', async () => {
    const seen = [];
    const engine = createFakeEngine({ responses: [] });
    const base = engine.openSession;
    engine.openSession = async (options) => {
      const session = await base(options);
      session.turn = async (userText) => {
        const project = projectOf(userText, stored.projects);
        const text = (out) => out.content[0].text;
        const windows = options.localTools.find((t) => t.name === 'get_windows');
        const search = options.localServers['cht-docs'].find((t) => t.name === 'search_docs');
        seen.push({
          slug: project.slug,
          windows: JSON.parse(text(await windows.handler({ metric: METRIC }))),
          doc: text(await search.handler({ query: 'sentinel backlog' })),
          miss: JSON.parse(text(await search.handler({ query: 'not recorded before' }))),
        });
        return {
          structuredOutput: modelFindings(project), toolCalls: [{
            tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'not recorded before' },
            tool_response: JSON.stringify({ unavailable: true, reason: 'not recorded' }),
          }],
          result: {
            subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.005, num_turns: 2,
            duration_ms: 5, session_id: 'replay-session', permission_denials: [], errors: [],
          },
          referenceUnavailable: false,
        };
      };
      return session;
    };
    const r = await invoke({ dataDir, flags: { date: '2026-09-18', label: 'shim' }, deps: { engine } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(seen).to.have.length(2);
    for (const call of seen) {
      expect(call.windows).to.deep.equal({
        windows: [{ window: 'current', values: [[1, 912]] }], change: { current_value: 912 },
      });
      expect(call.doc).to.include('Source: https://docs.communityhealthtoolkit.org/sentinel');
      expect(call.miss).to.deep.equal({ unavailable: true, reason: 'not recorded' });
    }
    const printed = JSON.parse(r.out.text());
    expect(printed.projects.map((p) => p.unavailable_tool_calls)).to.deep.equal([1, 1]);
    expect(printed.totals.unavailable_tool_calls).to.equal(2);
    // the replay's own tool-calls.jsonl holds the new session's calls; the recording is kept beside it
    const root = path.join(dataDir, 'runs-replay', '2026-09-18', 'shim', 'alpha-example-org');
    const recorded = fs.readFileSync(path.join(root, 'recorded-tool-calls.jsonl'), 'utf8').trim().split('\n');
    expect(recorded).to.have.length(2);
    const fresh = fs.readFileSync(path.join(root, 'tool-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(fresh).to.have.length(1);
    expect(fresh[0]).to.include({ tool_name: 'mcp__cht-docs__search_docs', pass: 1 });
  });

  it('honours --prompts and --skill: hashes differ from the source and the files under test are used', async () => {
    const promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-experiment-'));
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-experiment-'));
    try {
      fs.cpSync(PACKAGE_PATHS.promptsDir, promptsDir, { recursive: true });
      fs.cpSync(PACKAGE_PATHS.skillDir, skillDir, { recursive: true });
      fs.appendFileSync(path.join(promptsDir, 'pass-first.md'), '\nEXPERIMENT-PROMPT-LINE\n');
      fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\nEXPERIMENT-SKILL-LINE\n');
      const engine = findingsEngine();
      const r = await invoke({
        dataDir,
        flags: { date: '2026-09-18', label: 'experiment', prompts: promptsDir, skill: skillDir },
        deps: { engine },
      });
      expect(r.error, r.error && r.error.stack).to.equal(undefined);
      const run = readJson(path.join(dataDir, 'runs-replay', '2026-09-18', 'experiment', 'run.json'));
      const underTest = loadDefinition({ paths: { ...PACKAGE_PATHS, promptsDir, skillDir }, env: r.args.env }).hashes;
      const shipped = loadDefinition({ paths: PACKAGE_PATHS, env: r.args.env }).hashes;
      expect(run.versions.prompts_hash).to.equal(underTest.prompts_hash);
      expect(run.versions.skill_hash).to.equal(underTest.skill_hash);
      expect(run.versions.prompts_hash).to.not.equal(shipped.prompts_hash);
      expect(run.versions.skill_hash).to.not.equal(shipped.skill_hash);
      expect(run.versions.schema_hash).to.equal(shipped.schema_hash);
      expect(run.versions.prompts_hash).to.not.equal(run.source_versions.prompts_hash);
      expect(run.prompts_dir).to.equal(promptsDir);
      expect(run.skill_dir).to.equal(skillDir);
      expect(engine.sessions[0].options.systemPrompt[0]).to.include('EXPERIMENT-SKILL-LINE');
      expect(engine.sessions[0].turns[0]).to.include('EXPERIMENT-PROMPT-LINE');
      const printed = JSON.parse(r.out.text());
      expect(printed.prompts).to.deep.equal({ dir: promptsDir, hash: underTest.prompts_hash });
      expect(printed.skill).to.deep.equal({ dir: skillDir, hash: underTest.skill_hash });
    } finally {
      removeDir(promptsDir);
      removeDir(skillDir);
    }
  });

  it('reports items added, removed and changed against the original run', async () => {
    const engine = createFakeEngine({
      responses: (userText) => {
        const project = projectOf(userText, stored.projects);
        if (project.slug === 'gamma-example-org') {
          // gamma: the item disappears and a conflict item appears instead
          const findings = modelFindings(project);
          findings.items = [{ ...findings.items[0], item_key: { metric: 'cht_conflict_count', pattern_card: null } }];
          return { structuredOutput: findings };
        }
        // alpha: same identity, lower severity
        return { structuredOutput: modelFindings(project, { severity: 'low' }) };
      },
    });
    const r = await invoke({ dataDir, flags: { date: '2026-09-18', label: 'diff' }, deps: { engine } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const printed = JSON.parse(r.out.text());
    const [alpha, gamma] = printed.projects;
    expect(alpha.changed).to.deep.equal([stored.projects[0].item_id]);
    expect(alpha.added).to.deep.equal([]);
    expect(alpha.removed).to.deep.equal([]);
    expect(gamma.removed).to.deep.equal([stored.projects[1].item_id]);
    expect(gamma.added).to.deep.equal([itemId('https://gamma.example.org', 'cht_conflict_count', null)]);
    expect(gamma.changed).to.deep.equal([]);
    expect(printed.totals).to.include({ added: 1, removed: 1, changed: 1, before_items: 2, after_items: 2 });
  });

  it('restricts the replay to --project and still compares only those projects', async () => {
    const engine = findingsEngine();
    const r = await invoke({
      dataDir, flags: { date: '2026-09-18', label: 'one', project: ['gamma.example.org'] }, deps: { engine },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(engine.sessions).to.have.length(1);
    const printed = JSON.parse(r.out.text());
    expect(printed.projects.map((p) => p.slug)).to.deep.equal(['gamma-example-org']);
    expect(printed.totals.projects).to.equal(1);
    const root = path.join(dataDir, 'runs-replay', '2026-09-18', 'one');
    expect(fs.existsSync(path.join(root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(false);
  });

  it('replays from retained inputs when the raw windows were purged', async () => {
    removeDir(dataDir);
    dataDir = tempDir();
    stored = await buildStoredRun({ dataDir, withWindows: false });
    const engine = findingsEngine();
    const r = await invoke({ dataDir, flags: { date: '2026-09-18', label: 'purged' }, deps: { engine } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const root = path.join(dataDir, 'runs-replay', '2026-09-18', 'purged');
    expect(fs.existsSync(path.join(root, 'alpha-example-org', 'inputs', 'windows.json.gz'))).to.equal(false);
    expect(fs.existsSync(path.join(root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(true);
    expect(JSON.parse(r.out.text()).totals.after_items).to.equal(2);
  });

  it('selects the latest run of a date or an exact forced run id, defaulting the label to a timestamp', async () => {
    await buildStoredRun({ dataDir, runId: '2026-09-18-f1', hosts: ['beta.example.org'] });
    const engine = findingsEngine();
    engine.openSession = createFakeEngine({
      responses: () => ({
        structuredOutput: modelFindings({ url: 'https://beta.example.org', candidate: { candidate_id: 'x' } }),
      }),
    }).openSession;
    const latest = await invoke({ dataDir, flags: { date: '2026-09-18' }, deps: { engine } });
    expect(latest.error, latest.error && latest.error.stack).to.equal(undefined);
    const printedLatest = JSON.parse(latest.out.text());
    expect(printedLatest.run_id).to.equal('2026-09-18-f1');
    expect(printedLatest.label).to.equal('20260919T101112Z');
    expect(fs.existsSync(path.join(dataDir, 'runs-replay', '2026-09-18-f1', '20260919T101112Z'))).to.equal(true);
    const exact = await invoke({ dataDir, flags: { date: '2026-09-18-f1', label: 'exact' }, deps: { engine } });
    expect(exact.error).to.equal(undefined);
    expect(JSON.parse(exact.out.text()).run_id).to.equal('2026-09-18-f1');
  });

  it('uses the SDK engine by default and only reaches for the CLI engine when asked', async () => {
    const created = [];
    const r = await invoke({
      dataDir,
      flags: { date: '2026-09-18', label: 'engine' },
      deps: {
        engine: null,
        createEngine: (options) => {
          created.push(options);
          return findingsEngine();
        },
      },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(created).to.have.length(1);
    expect(created[0].engineName).to.equal('sdk');
    expect(created[0].mcpConfig).to.deep.equal({ mcpServers: {} });
    expect(created[0].replay).to.equal(true);
    expect(created[0].runDir.kind).to.equal('replay');
    const cli = await invoke({
      dataDir,
      flags: { date: '2026-09-18', label: 'engine-cli', engine: 'cli' },
      deps: { engine: null, createEngine: (options) => {
        created.push(options);
        return findingsEngine();
      } },
    });
    expect(cli.error, cli.error && cli.error.stack).to.equal(undefined);
    expect(created[1].engineName).to.equal('cli');
  });

  it('runs under the egress guard on the global fetch and restores it afterwards (FR-083, revision 33)', async () => {
    const before = globalThis.fetch;
    let seen = null;
    const tracer = fakeTracer();
    tracer.start = sinon.stub().callsFake(async () => {
      seen = globalThis.fetch.egressGuard === true;
      return { traceId: 't1' };
    });
    const flags = { date: '2026-09-18', label: 'guarded' };
    const r = await invoke({ dataDir, flags, deps: { engine: findingsEngine(), tracer } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(seen).to.equal(true);
    expect(globalThis.fetch).to.equal(before);
  });

  it('prints the comparison and exits 0 when the trace flush rejects, logging it (revision 35)', async () => {
    const tracer = fakeTracer();
    tracer.finish.rejects(new Error('Unauthorized'));
    const flags = { date: '2026-09-18', label: 'flush' };
    const r = await invoke({ dataDir, flags, deps: { engine: findingsEngine(), tracer } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    expect(JSON.parse(r.out.text()).run_id).to.equal('2026-09-18');
    expect(r.err.text()).to.include('trace.finish_failed');
  });

  describe('exit codes', () => {
    it('64 without a target, with --date and --from together, with --from alone, or a bad --prompts', async () => {
      const cases = [
        {},
        { date: '2026-09-18', from: '2026-09-17', to: '2026-09-18' },
        { from: '2026-09-17' },
        { date: '2026-09-18', prompts: path.join(dataDir, 'no-such-dir') },
        { date: 'yesterday' },
        { date: '2026-09-18', label: 'a/b' },
      ];
      for (const flags of cases) {
        const r = await invoke({ dataDir, flags, deps: { engine: findingsEngine() } });
        expect(r.error && r.error.code, JSON.stringify(flags)).to.equal(codes.USAGE);
      }
    });

    it('65 when no stored run matches the date and 75 when the label already exists', async () => {
      const attempt = (flags) => invoke({ dataDir, flags, deps: { engine: findingsEngine() } });
      const missing = await attempt({ date: '2026-01-01', label: 'x' });
      expect(missing.error.code).to.equal(codes.DATAERR);
      expect(missing.error.message).to.include('2026-01-01');
      const first = await attempt({ date: '2026-09-18', label: 'dup' });
      expect(first.error).to.equal(undefined);
      const second = await attempt({ date: '2026-09-18', label: 'dup' });
      expect(second.error.code).to.equal(codes.TEMPFAIL);
      expect(second.error.message).to.include('dup');
    });

    it('65 when the stored run has no discovery.json, marking the replay failed', async () => {
      removeDir(dataDir);
      dataDir = tempDir();
      stored = await buildStoredRun({ dataDir, withDiscovery: false });
      const r = await invoke({
        dataDir, flags: { date: '2026-09-18', label: 'broken' }, deps: { engine: findingsEngine() },
      });
      expect(r.error.code).to.equal(codes.DATAERR);
      expect(r.error.message).to.include('discovery.json');
    });
  });
});

describe('cli/commands/replay: pattern cards', function () {
  this.timeout(20000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('hands the merged card ids to the gate and the cards to the agent stage', async () => {
    const stored = await buildStoredRun({ dataDir, hosts: ['alpha.example.org'] });
    const engine = createFakeEngine({
      responses: () => ({ structuredOutput: modelFindings(stored.projects[0]) }),
    });
    const verifyFindings = sinon.stub().callsFake(async (args) => acceptingGate(args));
    const patternCards = {
      index: ['sentinel-stall'], merged: [], get: () => null, byMetric: () => [], read: async () => '',
    };
    const r = await invoke({
      dataDir, flags: { date: '2026-09-18', label: 'cards' },
      deps: { engine, gate: null, gateModule: { verifyFindings }, patternCards },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    expect(verifyFindings).to.have.been.called;
    expect(verifyFindings.firstCall.args[0].knownCards).to.deep.equal(['sentinel-stall']);
    expect(engine.sessions[0].options.localTools.map((t) => t.name)).to.include('read_pattern_card');
  });
});

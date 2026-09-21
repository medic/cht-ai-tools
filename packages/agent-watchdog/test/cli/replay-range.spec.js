// `replay --from --to` (SC-006): every stored run in the inclusive range, bounded concurrency, one comparison per run
// and a summary on stdout; a failing run is recorded without aborting the others.
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const replayCommand = require('../../src/cli/commands/replay');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
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
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
  AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
  LANGFUSE_BASE_URL: 'https://langfuse.example.org',
  AGENT_WATCHDOG_PROMPTS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: dataDir,
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
  AGENT_WATCHDOG_PASSES: '1',
  ...extra,
});

const fakeTracer = () => ({
  start: sinon.stub().resolves({ traceId: 't-range' }),
  stage: sinon.spy(async (name, fn) => fn()),
  generation: sinon.stub(),
  traceUrl: sinon.stub().resolves('https://langfuse.example.org/trace/t-range'),
  finish: sinon.stub().resolves(),
  traceId: 't-range',
});

const gate = async ({ findings, project, pass }) => ({
  report: {
    subject: 'pass', subject_ref: `${project.slug}/pass${pass}`, attempt: 1, outcome: 'accepted',
    checks: [{ name: 'schema', status: 'pass', reasons: [] }],
  },
  items: (findings.items || []).map((item) => ({
    item_id: itemId(project.url, item.item_key.metric, item.item_key.pattern_card),
    project_url: project.url, metric: item.item_key.metric, severity: item.severity, evidence: item.evidence,
    why_now: item.why_now, suggested_check: item.suggested_check,
    // The real gate builds this from the run's windows (FR-009, revision 18).
    dashboard_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: project.url,
      from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' }, confidence: item.confidence,
    persisting_days: 1, pattern_card: item.item_key.pattern_card, candidate_ids: item.candidate_ids,
    reference_urls: item.reference_urls, rank: null, placement: null, pass_history: [],
  })),
});

const findingsFor = (url, candidateIds) => ({
  project_url: url,
  pass: 1,
  items: [{
    item_key: { metric: METRIC, pattern_card: null }, severity: 'high',
    evidence: [{ window: 'current', value: 912, unit: 'count' }, { window: 'previous_day', value: 300, unit: 'count' }],
    why_now: 'Sentinel backlog has climbed steadily.', suggested_check: 'Check sentinel logs.',
    confidence: 0.85, candidate_ids: candidateIds, reference_urls: [],
  }],
  not_selected: [], changes: [], converged: true, notes: '',
});

// The pass prompt carries the project url and its candidate ids; answer for whichever project is asked about.
const answeringEngine = ({ delayMs = 0, track = null } = {}) => {
  const engine = createFakeEngine({ responses: [] });
  const base = engine.openSession;
  engine.openSession = async (options) => {
    const session = await base(options);
    session.turn = async (userText) => {
      if (track) {
        track.inFlight += 1;
        track.peak = Math.max(track.peak, track.inFlight);
      }
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (track) {
        track.inFlight -= 1;
      }
      const url = /https:\/\/[a-z]+\.example\.org/.exec(userText)[0];
      const ids = [...new Set(userText.match(/\b[0-9a-f]{12}\b/g) || [])];
      return {
        structuredOutput: findingsFor(url, ids),
        result: {
          subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01, num_turns: 1,
          duration_ms: 3, session_id: 'range', permission_denials: [], errors: [],
        },
        toolCalls: [],
        referenceUnavailable: false,
      };
    };
    return session;
  };
  return engine;
};

const invoke = async ({ dataDir, flags, deps = {}, env = {} }) => {
  const out = capture();
  const err = capture();
  const fetch = sinon.stub().rejects(new Error('fetch must never be called during replay'));
  const args = {
    command: 'replay', flags, positionals: [], env: envFor(dataDir, env), stdout: out.stream, stderr: err.stream,
    logger: createLogger({ stream: err.stream, level: 'warn' }),
    deps: { tracer: fakeTracer(), gate, fetch, gitSha: 'range1', now: () => new Date('2026-09-19T10:00:00Z'), ...deps },
  };
  let code;
  let error;
  try {
    code = await replayCommand(args);
  } catch (e) {
    error = e;
  }
  return { code, error, out, err, fetch, args };
};

describe('cli/commands/replay --from --to', function () {
  this.timeout(30000);
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    for (const runId of ['2026-09-16', '2026-09-17', '2026-09-18']) {
      await buildStoredRun({ dataDir, runId, hosts: ['alpha.example.org'] });
    }
  });
  afterEach(() => removeDir(dataDir));

  it('replays every stored run in the inclusive range, one comparison each, and prints a summary', async () => {
    const engine = answeringEngine();
    const r = await invoke({
      dataDir, flags: { from: '2026-09-16', to: '2026-09-17', label: 'range' }, deps: { engine },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    for (const runId of ['2026-09-16', '2026-09-17']) {
      const root = path.join(dataDir, 'runs-replay', runId, 'range');
      expect(fs.existsSync(path.join(root, 'comparison.json')), runId).to.equal(true);
      expect(fs.existsSync(path.join(root, 'alpha-example-org', 'findings.pass1.json')), runId).to.equal(true);
    }
    expect(fs.existsSync(path.join(dataDir, 'runs-replay', '2026-09-18'))).to.equal(false);
    const printed = JSON.parse(r.out.text());
    expect(printed).to.include({ from: '2026-09-16', to: '2026-09-17', label: 'range' });
    expect(printed.runs.map((c) => c.run_id)).to.deep.equal(['2026-09-16', '2026-09-17']);
    expect(printed.summary).to.include({
      runs: 2, replayed: 2, before_items: 2, after_items: 2, added: 0, removed: 0, changed: 0,
      unavailable_tool_calls: 0,
    });
    expect(printed.summary.failed).to.deep.equal([]);
    expect(printed.summary.cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(printed.summary.duration_ms).to.be.a('number');
    expect(r.fetch).to.not.have.been.called;
    expect(r.args.deps.tracer.start).to.have.been.calledOnce;
    expect(r.args.deps.tracer.finish).to.have.been.calledOnce;
  });

  it('bounds concurrency by AGENT_WATCHDOG_PROJECT_CONCURRENCY', async () => {
    const track = { inFlight: 0, peak: 0 };
    const engine = answeringEngine({ delayMs: 25, track });
    const r = await invoke({
      dataDir, flags: { from: '2026-09-16', to: '2026-09-18', label: 'pool' }, deps: { engine },
      env: { AGENT_WATCHDOG_PROJECT_CONCURRENCY: '2' },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(JSON.parse(r.out.text()).summary.replayed).to.equal(3);
    expect(track.peak).to.equal(2);
    const serial = { inFlight: 0, peak: 0 };
    const r2 = await invoke({
      dataDir, flags: { from: '2026-09-16', to: '2026-09-18', label: 'serial' },
      deps: { engine: answeringEngine({ delayMs: 10, track: serial }) },
      env: { AGENT_WATCHDOG_PROJECT_CONCURRENCY: '1' },
    });
    expect(r2.error, r2.error && r2.error.stack).to.equal(undefined);
    expect(serial.peak).to.equal(1);
  });

  it('records a failing run without aborting the others and still exits 0', async () => {
    fs.rmSync(path.join(dataDir, 'runs', '2026-09-17', 'discovery.json'));
    const r = await invoke({
      dataDir, flags: { from: '2026-09-16', to: '2026-09-18', label: 'partial' }, deps: { engine: answeringEngine() },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    const printed = JSON.parse(r.out.text());
    expect(printed.runs.map((c) => c.run_id)).to.deep.equal(['2026-09-16', '2026-09-18']);
    expect(printed.summary.runs).to.equal(3);
    expect(printed.summary.replayed).to.equal(2);
    expect(printed.summary.failed).to.have.length(1);
    expect(printed.summary.failed[0].run_id).to.equal('2026-09-17');
    expect(printed.summary.failed[0].error).to.include('discovery.json');
    const failedRun = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'runs-replay', '2026-09-17', 'partial', 'run.json'), 'utf8'),
    );
    expect(failedRun.status).to.equal('failed');
  });

  it('throws the last error when every run in the range fails', async () => {
    for (const runId of ['2026-09-16', '2026-09-17', '2026-09-18']) {
      fs.rmSync(path.join(dataDir, 'runs', runId, 'discovery.json'));
    }
    const r = await invoke({
      dataDir, flags: { from: '2026-09-16', to: '2026-09-18', label: 'allfail' }, deps: { engine: answeringEngine() },
    });
    expect(r.error && r.error.code).to.equal(codes.DATAERR);
  });

  it('rejects --date together with --from, --from without --to, a reversed range and an empty range', async () => {
    const cases = [
      { date: '2026-09-18', from: '2026-09-16', to: '2026-09-18', expected: codes.USAGE },
      { from: '2026-09-16', expected: codes.USAGE },
      { to: '2026-09-16', expected: codes.USAGE },
      { from: '2026-09-18', to: '2026-09-16', expected: codes.USAGE },
      { from: 'monday', to: '2026-09-16', expected: codes.USAGE },
      { from: '2026-01-01', to: '2026-01-31', expected: codes.DATAERR },
    ];
    for (const { expected, ...flags } of cases) {
      const r = await invoke({ dataDir, flags: { ...flags, label: 'x' }, deps: { engine: answeringEngine() } });
      expect(r.error && r.error.code, JSON.stringify(flags)).to.equal(expected);
    }
    expect(fs.existsSync(path.join(dataDir, 'runs-replay'))).to.equal(true);
    expect(fs.readdirSync(path.join(dataDir, 'runs-replay'))).to.deep.equal([]);
  });
});

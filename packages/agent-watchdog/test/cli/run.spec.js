const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const runCommand = require('../../src/cli/commands/run');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');

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

const envFor = (dataDir) => ({
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
  AGENT_WATCHDOG_PROMPTS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: dataDir,
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
});

const fakeTracer = () => ({
  start: sinon.stub().resolves({ traceId: 't1' }),
  stage: sinon.spy(async (name, fn) => fn()),
  generation: sinon.stub(),
  traceUrl: sinon.stub().resolves('https://langfuse.example.org/trace/t1'),
  finish: sinon.stub().resolves(),
  traceId: 't1',
});

// Fake stages: each records that it ran and returns a scripted result.
const fakeStages = (overrides = {}) => {
  const calls = [];
  const make = (name, result) => ({
    name,
    inputs: [],
    run: sinon.spy(async (ctx) => {
      calls.push(name);
      if (result instanceof Error) {
        throw result;
      }
      if (name === 'rollup') {
        await ctx.runDir.writeJson('rollup/brief.json', { kind: result.kind || 'brief' });
      }
      return result;
    }),
  });
  const defaults = {
    purge: { removed: 0 },
    feedback: { records: 0 },
    collect: { projects: 2, metrics: 10 },
    analyze: { projects: 2, candidates: 3 },
    agent: { projects_analysed: 1, projects_skipped: 1, items: 2, cost_usd: 0.5, bounds_hit: [], usage: null },
    rollup: { kind: 'brief', items: 2, bullets: 2, degraded: false },
    render: { rendered: true },
    publish: { posted: true, ts: '1.1', permalink: 'https://slack.example/p1' },
  };
  const stages = Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([n, r]) => [n, make(n, r)]));
  return { stages, calls };
};

const base = (dataDir, extra = {}) => {
  const out = capture();
  const err = capture();
  const logger = createLogger({ stream: err.stream });
  const slackPublisher = { postFailureNotice: sinon.stub().resolves({ ts: '9.9' }) };
  return {
    out,
    err,
    slackPublisher,
    args: {
      command: 'run',
      flags: { date: '2026-09-18', ...(extra.flags || {}) },
      positionals: [],
      env: { ...envFor(dataDir), ...(extra.env || {}) },
      stdout: out.stream,
      stderr: err.stream,
      logger,
      deps: {
        tracer: fakeTracer(),
        slackPublisher,
        gate: {},
        links: {},
        engine: {},
        gitSha: 'abc1234',
        ...(extra.deps || {}),
      },
    },
  };
};

const readRun = (dataDir, runId = '2026-09-18') => {
  const file = path.join(dataDir, 'runs', runId, 'run.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

describe('cli/commands/run', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir(); 
  });
  afterEach(() => removeDir(dataDir));

  it('runs every stage in order and ends published with exit 0', async () => {
    const { stages, calls } = fakeStages();
    const t = base(dataDir, { deps: { stages } });
    const code = await runCommand(t.args);
    expect(code).to.equal(0);
    expect(calls).to.deep.equal(['purge', 'feedback', 'collect', 'analyze', 'agent', 'rollup', 'render', 'publish']);
    const run = readRun(dataDir);
    expect(run.status).to.equal('published');
    expect(run.mode).to.equal('scheduled');
    const { version } = require('../../package.json');
    expect(run.versions).to.include({ package: version, git_sha: 'abc1234' });
    expect(run.versions.config_hash).to.match(/^[0-9a-f]{64}$/);
    expect(run.stages.map((s) => s.name))
      .to.include.members(['collect', 'analyze', 'agent', 'rollup', 'render', 'publish']);
    expect(run.stages.every((s) => s.status === 'completed')).to.equal(true);
    expect(run.cost_usd).to.equal(0.5);
    expect(run.trace_url).to.equal('https://langfuse.example.org/trace/t1');
    const effectivePath = path.join(dataDir, 'runs', '2026-09-18', 'config.effective.json');
    expect(fs.existsSync(effectivePath)).to.equal(true);
    const effective = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
    expect(JSON.stringify(effective)).to.not.include('xoxb-test');
    expect(t.args.deps.tracer.finish).to.have.been.calledOnce;
  });

  it('logs a failing trace flush and keeps the exit code (revision 13)', async () => {
    const { stages } = fakeStages();
    const tracer = fakeTracer();
    tracer.finish.rejects(Object.assign(new Error('Unauthorized'), { name: 'OTLPExporterError', code: 401 }));
    const t = base(dataDir, { deps: { stages, tracer } });
    const code = await runCommand(t.args);
    expect(code).to.equal(0);
    expect(t.err.text()).to.include('trace.finish_failed');
    expect(readRun(dataDir).status).to.equal('published');
  });

  it('passes a deadline and shared dependencies to every stage', async () => {
    const { stages } = fakeStages();
    const t = base(dataDir, { deps: { stages } });
    await runCommand(t.args);
    const ctx = stages.collect.run.firstCall.args[0];
    expect(ctx.deadline).to.be.a('number');
    expect(ctx.deadline - Date.now()).to.be.within(3500000, 3600000);
    expect(ctx.runId).to.equal('2026-09-18');
    expect(ctx.date).to.equal('2026-09-18');
    expect(ctx.stage).to.equal('collect');
    expect(ctx.gate).to.equal(t.args.deps.gate);
    expect(ctx.links).to.equal(t.args.deps.links);
    expect(ctx.deps.engine).to.equal(t.args.deps.engine);
  });

  it('wires ingested feedback into the corpus outcomes and the roll-up context', async () => {
    const { stages } = fakeStages();
    const ingested = {
      run_id: '2026-09-18',
      records: [],
      unmatched: [{ feedback_id: 'ffffffffffff' }],
      horizons: [{ item_id: 'aaaaaaaaaaaa', project_url: 'https://a', metric: 'm', horizon: '2026-10-01' }],
      by_item: {
        aaaaaaaaaaaa: { project_url: 'https://a', metric: 'm', pattern_card: null, up: 0, down: 1, notes: [], verdict: 'dismissed' },
        bbbbbbbbbbbb: { project_url: 'https://a', metric: 'n', pattern_card: null, up: 2, down: 0, notes: [], verdict: 'confirmed' },
        cccccccccccc: { project_url: 'https://a', metric: 'o', pattern_card: null, up: 1, down: 1, notes: [], verdict: 'contested' },
      },
      brief: { up: 1, down: 0, notes: [] },
    };
    stages.feedback = {
      name: 'feedback',
      inputs: [],
      run: sinon.spy(async (ctx) => {
        await ctx.runDir.writeJson('feedback.ingested.json', ingested);
        return { records: 4 };
      }),
    };
    const t = base(dataDir, { deps: { stages } });
    expect(await runCommand(t.args)).to.equal(0);
    const outcomes = fs.readFileSync(path.join(dataDir, 'corpus', 'outcomes', '2026-09-18.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    expect(outcomes.map((o) => o.outcome).sort()).to.deep.equal(['confirmed', 'dismissed']);
    const analyzeCtx = stages.analyze.run.firstCall.args[0];
    expect(analyzeCtx.feedbackHorizons).to.have.length(1);
    const rollupCtx = stages.rollup.run.firstCall.args[0];
    expect(rollupCtx.feedbackByItem).to.be.instanceOf(Map);
    expect(rollupCtx.feedbackByItem.size).to.equal(3);
    expect(rollupCtx.feedbackUnmatched).to.have.length(1);
    expect(rollupCtx.feedbackBrief).to.deep.equal({ up: 1, down: 0, notes: [] });
    expect(rollupCtx.memory).to.equal('');
    expect(rollupCtx.previousItemIds).to.be.instanceOf(Map);
  });

  it('records a heartbeat when the roll-up produced no items', async () => {
    const { stages } = fakeStages({ rollup: { kind: 'heartbeat', items: 0, bullets: 0, degraded: false } });
    const t = base(dataDir, { deps: { stages } });
    expect(await runCommand(t.args)).to.equal(0);
    expect(readRun(dataDir).status).to.equal('heartbeat');
  });

  it('records degraded and still exits 0 when the roll-up degraded', async () => {
    const { stages } = fakeStages({ rollup: { kind: 'degraded', items: 1, bullets: 1, degraded: true } });
    const t = base(dataDir, { deps: { stages } });
    expect(await runCommand(t.args)).to.equal(0);
    expect(readRun(dataDir).status).to.equal('degraded');
  });

  it('previews without posting: payload on stdout, status previewed', async () => {
    const payload = { run_id: '2026-09-18', kind: 'brief', parent: { text: 'hi' }, replies: [] };
    const { stages } = fakeStages({ publish: { posted: false, payload } });
    const t = base(dataDir, { flags: { 'dry-run': true }, deps: { stages } });
    expect(await runCommand(t.args)).to.equal(0);
    expect(readRun(dataDir).status).to.equal('previewed');
    expect(readRun(dataDir).mode).to.equal('preview');
    expect(JSON.parse(t.out.text())).to.deep.equal(payload);
    expect(stages.publish.run.firstCall.args[0].mode).to.equal('preview');
  });

  it('refuses a second run for the same date without --force and allocates -f1 with it', async () => {
    const first = base(dataDir, { deps: { stages: fakeStages().stages } });
    await runCommand(first.args);
    const again = base(dataDir, { deps: { stages: fakeStages().stages } });
    let error;
    try {
      await runCommand(again.args); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(codes.TEMPFAIL);
    const forced = base(dataDir, { flags: { force: true }, deps: { stages: fakeStages().stages } });
    expect(await runCommand(forced.args)).to.equal(0);
    const run = readRun(dataDir, '2026-09-18-f1');
    expect(run.status).to.equal('published');
    expect(run.supersedes).to.equal('2026-09-18');
    expect(readRun(dataDir, '2026-09-18').superseded_by).to.equal('2026-09-18-f1');
  });

  it('posts a failure notice and exits 69 when the metrics source is unavailable', async () => {
    const { stages, calls } = fakeStages({ collect: new codes.ExitError(codes.UNAVAILABLE, 'grafana timed out') });
    const t = base(dataDir, { deps: { stages } });
    let error;
    try {
      await runCommand(t.args); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(codes.UNAVAILABLE);
    expect(calls).to.deep.equal(['purge', 'feedback', 'collect']);
    const run = readRun(dataDir);
    expect(run.status).to.equal('failed');
    expect(run.stages.find((s) => s.name === 'collect').status).to.equal('failed');
    expect(t.slackPublisher.postFailureNotice).to.have.been.calledOnce;
    expect(t.slackPublisher.postFailureNotice.firstCall.args[0].text).to.include('grafana timed out');
    expect(t.slackPublisher.postFailureNotice.firstCall.args[0].traceUrl).to.equal('https://langfuse.example.org/trace/t1');
    expect(t.args.deps.tracer.finish).to.have.been.calledOnce;
  });

  it('posts a failure notice and exits 1 on an unexpected error', async () => {
    const { stages } = fakeStages({ analyze: new Error('kaboom') });
    const t = base(dataDir, { deps: { stages } });
    let error;
    try {
      await runCommand(t.args); 
    } catch (e) {
      error = e; 
    }
    expect(error).to.be.instanceOf(Error);
    expect(error.code).to.equal(undefined);
    expect(readRun(dataDir).status).to.equal('failed');
    expect(t.slackPublisher.postFailureNotice).to.have.been.calledOnce;
  });

  it('does not post a failure notice in preview mode', async () => {
    const { stages } = fakeStages({ analyze: new Error('kaboom') });
    const t = base(dataDir, { flags: { 'dry-run': true }, deps: { stages } });
    try {
      await runCommand(t.args); 
    } catch { /* expected */ }
    expect(t.slackPublisher.postFailureNotice).to.not.have.been.called;
  });

  it('marks the run unposted and exits 74 when Slack fails after retries', async () => {
    const { stages } = fakeStages({ publish: new codes.ExitError(codes.IOERR, 'slack unavailable') });
    const t = base(dataDir, { deps: { stages } });
    let error;
    try {
      await runCommand(t.args); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(codes.IOERR);
    expect(readRun(dataDir).status).to.equal('unposted');
    expect(t.slackPublisher.postFailureNotice).to.not.have.been.called;
  });

  it('runs a single stage on an existing run directory with --stage', async () => {
    const full = base(dataDir, { deps: { stages: fakeStages().stages } });
    await runCommand(full.args);
    const { stages, calls } = fakeStages();
    const t = base(dataDir, { flags: { stage: 'analyze' }, deps: { stages } });
    expect(await runCommand(t.args)).to.equal(0);
    expect(calls).to.deep.equal(['analyze']);
    const run = readRun(dataDir);
    expect(run.mode).to.equal('scheduled');
    expect(run.stage_runs).to.have.length(1);
    expect(run.stage_runs[0]).to.include({ stage: 'analyze', mode: 'stage' });
  });

  it('exits 65 when --stage names a stage whose inputs are missing', async () => {
    const stage = { name: 'render', inputs: ['rollup/brief.json'], run: sinon.stub().resolves({}) };
    const { stages } = fakeStages();
    stages.render = stage;
    const t = base(dataDir, { flags: { stage: 'render' }, deps: { stages } });
    let error;
    try {
      await runCommand(t.args); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(codes.DATAERR);
    expect(stage.run).to.not.have.been.called;
  });

  it('marks only the stage failed on a --stage failure, keeps the run status and posts no notice', async () => {
    const full = base(dataDir, { deps: { stages: fakeStages().stages } });
    await runCommand(full.args);
    const missing = new codes.ExitError(codes.DATAERR, 'missing stage input: x/changes.json');
    const { stages } = fakeStages({ analyze: missing });
    const t = base(dataDir, { flags: { stage: 'analyze' }, deps: { stages } });
    let error;
    try {
      await runCommand(t.args);
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(codes.DATAERR);
    const run = readRun(dataDir);
    expect(run.status).to.equal('published');
    expect(run.stages.find((s) => s.name === 'analyze').status).to.equal('failed');
    expect(t.slackPublisher.postFailureNotice).to.not.have.been.called;
  });

  it('hands the merged pattern-card ids to the gate and the cards to every stage', async () => {
    const verifyFindings = sinon.stub().resolves({
      report: { subject: 'pass', subject_ref: 'alpha-example-org/pass1', attempt: 1, checks: [], outcome: 'accepted' },
      items: [],
    });
    const patternCards = {
      index: ['sentinel-stall'], merged: [], get: () => null, byMetric: () => [], read: async () => '',
    };
    const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
    const { stages } = fakeStages();
    stages.collect = {
      name: 'collect', inputs: [],
      run: sinon.spy(async (ctx) => {
        await ctx.runDir.writeJson('discovery.json', { projects: [project], dashboards: [], metrics: [] });
        return { projects: 1 };
      }),
    };
    stages.agent = {
      name: 'agent', inputs: [],
      run: sinon.spy(async (ctx) => {
        await ctx.deps.gate({
          findings: { items: [] }, pass: 1, project, candidates: [], changes: [], toolResultUrls: [],
        });
        return { projects_analysed: [project.url], projects_skipped: [], items: [], cost_usd: 0, bounds_hit: [] };
      }),
    };
    const t = base(dataDir, { deps: { stages, gate: { verifyFindings }, patternCards } });
    expect(await runCommand(t.args)).to.equal(0);
    expect(verifyFindings).to.have.been.calledOnce;
    expect(verifyFindings.firstCall.args[0].knownCards).to.deep.equal(['sentinel-stall']);
    expect(stages.rollup.run.firstCall.args[0].deps.patternCards).to.equal(patternCards);
    expect(stages.agent.run.firstCall.args[0].deps.patternCards).to.equal(patternCards);
  });

  it('exits 78 when configuration is invalid and creates no run directory', async () => {
    const t = base(dataDir, { env: { AGENT_WATCHDOG_PASSES: '99' }, deps: { stages: fakeStages().stages } });
    let error;
    try {
      await runCommand(t.args); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(codes.CONFIG);
    expect(fs.existsSync(path.join(dataDir, 'runs', '2026-09-18'))).to.equal(false);
  });
});

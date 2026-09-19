// End-to-end User Story 1 on the synthetic fixtures: real stages, a fake Grafana, a scripted model,
// a stubbed Slack client and a fake browser. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const runCommand = require('../../src/cli/commands/run');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const identity = require('../../src/model/identity');
const atomic = require('../../src/store/atomic');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const DATE = '2026-09-18';

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
  AGENT_WATCHDOG_PROMPTS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: dataDir,
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
  ...extra,
});

const fakeTracer = () => ({
  start: sinon.stub().resolves({ traceId: 't1' }),
  stage: sinon.spy(async (name, fn) => fn()),
  generation: sinon.stub(),
  traceUrl: sinon.stub().resolves('https://langfuse.example.org/trace/t1'),
  finish: sinon.stub().resolves(),
  traceId: 't1',
});

const fakeSlack = () => {
  let counter = 0;
  return {
    files: { uploadV2: sinon.stub().resolves({ ok: true, files: [{ files: [{ id: 'F0001' }] }] }) },
    chat: {
      postMessage: sinon.spy(async () => {
        counter += 1;
        return { ok: true, channel: 'C123', ts: `1700000000.00${String(counter).padStart(4, '0')}` };
      }),
      getPermalink: sinon.spy(async ({ message_ts: ts }) => ({ ok: true, permalink: `https://medic.slack.com/archives/C123/p${ts}` })),
    },
  };
};

const fakeBrowserLauncher = () => {
  const page = {
    route: sinon.stub().resolves(),
    setContent: sinon.stub().resolves(),
    locator: sinon.stub().returns({ screenshot: sinon.stub().resolves(Buffer.from('fake-png')) }),
  };
  const context = { newPage: sinon.stub().resolves(page), close: sinon.stub().resolves() };
  const browser = { newContext: sinon.stub().resolves(context), close: sinon.stub().resolves() };
  return { launch: sinon.stub().resolves(browser), page, context, browser };
};

// Reads the run directory to answer like a careful model would: one item per metric with evidence
// equal to the computed values, and a brief whose numbers come from the same evidence.
const createScriptedEngine = ({ dataDir, briefMode = 'good' }) => {
  const { formatValue } = require('../../src/verify/format');
  const calls = { sessions: [], turns: [], singleTurns: [] };

  const projects = () => {
    const runsDir = path.join(dataDir, 'runs');
    const runId = fs.readdirSync(runsDir).sort().pop();
    const root = path.join(runsDir, runId);
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'candidates.json')))
      .map((d) => {
        const slug = d.name;
        const candidates = JSON.parse(fs.readFileSync(path.join(root, slug, 'candidates.json'), 'utf8'));
        const changes = JSON.parse(fs.readFileSync(path.join(root, slug, 'changes.json'), 'utf8'));
        return { slug, root, candidates, changes };
      });
  };

  // Scrape-target candidates carry a pseudo panel reference ('targets'); point the item at a real panel
  // on the first priority dashboard instead, as the prompt instructs the model to do.
  const dashboardRefFor = (root, cands) => {
    const discovery = JSON.parse(fs.readFileSync(path.join(root, 'discovery.json'), 'utf8'));
    const known = new Set(discovery.dashboards.map((d) => d.uid));
    const real = cands.find((c) => known.has(c.panel_ref.dashboard_uid));
    if (real) {
      return { dashboard_uid: real.panel_ref.dashboard_uid, panel_id: real.panel_ref.panel_id };
    }
    const first = discovery.dashboards[0];
    const uptime = first.panels.find((p) => /uptime/i.test(p.title)) || first.panels[0];
    return { dashboard_uid: first.uid, panel_id: uptime.panel_id };
  };

  const itemsFor = async (project) => {
    const byMetric = new Map();
    for (const c of project.candidates) {
      if (!byMetric.has(c.metric)) {
        byMetric.set(c.metric, []);
      }
      byMetric.get(c.metric).push(c);
    }
    const windows = await atomic.readGzipJson(path.join(project.root, project.slug, 'inputs', 'windows.json.gz'));
    const items = [];
    for (const [metric, cands] of byMetric) {
      const change = project.changes.find((ch) => ch.metric === metric);
      const current = windows.windows.find((w) => w.metric === metric && w.window === 'current');
      const unit = cands[0].evidence[0] ? cands[0].evidence[0].unit : 'count';
      const evidence = [{ window: 'current', value: change.current_value, unit }];
      if (change.previous_day_value !== null) {
        evidence.push({ window: 'previous_day', value: change.previous_day_value, unit });
      }
      const severity = cands.some((c) => c.severity_floor === 'high') ? 'high' : 'low';
      items.push({
        item_key: { metric, pattern_card: null },
        severity,
        evidence,
        why_now: cands.some((c) => c.rule === 'target_down')
          ? 'The scrape target is down, so the watchdog has no fresh data for this project.'
          : 'The backlog has climbed steadily for hours and is now well above yesterday.',
        suggested_check: 'Open the dashboard panel and confirm the trend before paging anyone.',
        dashboard_ref: { ...dashboardRefFor(project.root, cands), from: current.start, to: current.end },
        confidence: 0.85,
        candidate_ids: cands.map((c) => c.candidate_id),
        reference_urls: [],
      });
    }
    return { items, unitOf: (metric) => (byMetric.get(metric)[0].evidence[0] || {}).unit || 'count' };
  };

  const result = () => ({
    subtype: 'success',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.01,
    num_turns: 2,
    duration_ms: 120,
    session_id: 'sess-1',
    permission_denials: [],
    errors: [],
  });

  const openSession = async (options) => {
    calls.sessions.push(options);
    let pass = 0;
    let sessionProject = null;
    return {
      async turn(userText) {
        pass += 1;
        calls.turns.push({ pass, userText });
        const ids = [...new Set(userText.match(/\b[0-9a-f]{12}\b/g) || [])];
        // A revision turn may carry only reasons; the session stays bound to the project of its first turn.
        const matched = projects().find((p) => p.candidates.some((c) => ids.includes(c.candidate_id)));
        sessionProject = matched || sessionProject;
        const project = sessionProject;
        const { items } = await itemsFor(project);
        const projectUrl = project.candidates[0].project_url;
        return {
          structuredOutput: {
            project_url: projectUrl, pass, items, not_selected: [], changes: [], converged: pass > 1, notes: '',
          },
          result: result(),
          toolCalls: [],
          referenceUnavailable: false,
        };
      },
      async close() {},
    };
  };

  const singleTurn = async (options) => {
    calls.singleTurns.push(options);
    const ids = [...new Set(options.userPrompt.match(/\b[0-9a-f]{12}\b/g) || [])];
    const all = [];
    for (const project of projects().filter((p) => p.candidates.length > 0)) {
      const { items } = await itemsFor(project);
      const url = project.candidates[0].project_url;
      for (const item of items) {
        all.push({ ...item, id: identity.itemId(url, item.item_key.metric, null), host: new URL(url).host });
      }
    }
    const ordered = ids.map((id) => all.find((i) => i.id === id)).filter(Boolean);
    const bullets = ordered.slice(0, 3).map((item) => {
      const [cur, prev] = item.evidence;
      const now = briefMode === 'bad' ? '999999' : formatValue(cur.value, cur.unit);
      const before = prev ? ` vs ${formatValue(prev.value, prev.unit)} yesterday` : '';
      return { item_id: item.id, text: `${item.host} \`${item.item_key.metric}\`: ${now} now${before}` };
    });
    return {
      structuredOutput: {
        headline: `Watchdog brief: ${ordered.length} item${ordered.length === 1 ? '' : 's'} to look at`,
        bullets,
        thread_order: ordered.map((i) => i.id),
        expected_load_notice: null,
        memory_update: { replace_with: null },
        proposals: [],
      },
      result: result(),
      toolCalls: [],
      referenceUnavailable: false,
    };
  };

  return { openSession, singleTurn, calls };
};

const runCase = async ({ caseName, dataDir, envExtra = {}, flags = {}, briefMode = 'good' }) => {
  const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', caseName) });
  const out = capture();
  const err = capture();
  const slack = fakeSlack();
  const browserLauncher = fakeBrowserLauncher();
  const engine = createScriptedEngine({ dataDir, briefMode });
  const args = {
    command: 'run',
    flags: { date: DATE, ...flags },
    positionals: [],
    env: envFor(dataDir, envExtra),
    stdout: out.stream,
    stderr: err.stream,
    logger: createLogger({ stream: err.stream, level: 'warn' }),
    deps: {
      fetch: fake.fetch,
      slack,
      browserLauncher,
      engine,
      tracer: fakeTracer(),
      gitSha: 'e2e',
      now: () => new Date(`${DATE}T06:05:00Z`),
    },
  };
  let code;
  let error;
  try {
    code = await runCommand(args);
  } catch (e) {
    error = e;
  }
  const runId = fs.readdirSync(path.join(dataDir, 'runs')).sort().pop();
  const root = path.join(dataDir, 'runs', runId);
  if (process.env.E2E_KEEP) {
    fs.writeFileSync(path.join(root, 'stderr.log'), err.text());
  }
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  return { code, error, out, err, slack, browserLauncher, engine, fake, root, read, runId };
};

describe('e2e: User Story 1, the daily brief', function () {
  this.timeout(30000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => {
    if (process.env.E2E_KEEP) {
      console.log(`E2E_KEEP: run directory kept at ${dataDir}`);
      return;
    }
    removeDir(dataDir);
  });

  it('flags the seeded sentinel climb and the down scrape target, posts a brief with threaded replies', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    const run = r.read('run.json');
    expect(run.status).to.equal('published');

    const alpha = r.read('alpha-example-org/candidates.json');
    const sentinel = alpha.filter((c) => c.metric.startsWith('cht_sentinel_backlog_count'));
    expect(sentinel.map((c) => c.rule).sort()).to.deep.equal(['deviation', 'monotonic', 'pct_change']);
    expect(sentinel.every((c) => c.severity_floor === 'high')).to.equal(true);
    const gamma = r.read('gamma-example-org/candidates.json');
    expect(gamma.some((c) => c.rule === 'target_down' && c.severity_floor === 'high')).to.equal(true);

    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('brief');
    expect(brief.bullets.length).to.be.within(1, 3);
    const alphaBullet = brief.bullets.find((b) => b.text.includes('alpha.example.org'));
    expect(alphaBullet.text).to.include('912');
    expect(alphaBullet.text).to.match(/yesterday/);

    const ranked = r.read('rollup/items.ranked.json');
    const alphaItem = ranked.find((i) => i.project_url === 'https://alpha.example.org');
    expect(alphaItem.severity).to.equal('high');
    expect(alphaItem.evidence.map((e) => e.window)).to.include.members(['current', 'previous_day']);
    expect(alphaItem.dashboard_ref).to.include({ dashboard_uid: 'oa2OfL-Vk', panel_id: 3 });

    const payload = r.read('rollup/payload.json');
    expect(payload.parent.metadata.event_type).to.equal('agent_watchdog.brief');
    expect(payload.replies.length).to.equal(ranked.length);
    const publication = r.read('rollup/publication.json');
    expect(publication.ts).to.be.a('string');
    expect(r.slack.files.uploadV2).to.have.been.calledOnce;
    expect(r.slack.files.uploadV2.firstCall.args[0]).to.not.have.property('channel_id');
    expect(r.slack.chat.postMessage.callCount).to.equal(1 + ranked.length);
    const parentCall = r.slack.chat.postMessage.firstCall.args[0];
    const imageBlock = parentCall.blocks.find((b) => b.type === 'image');
    expect(imageBlock && imageBlock.slack_file && imageBlock.slack_file.id).to.equal('F0001');
    for (const call of r.slack.chat.postMessage.getCalls().slice(1)) {
      expect(call.args[0].thread_ts).to.equal(publication.ts);
    }
    expect(fs.existsSync(path.join(r.root, 'rollup', 'report.html'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'rollup', 'brief.png'))).to.equal(true);
    const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
    expect(report).to.include('id="brief-summary"');
    expect(report).to.not.include('<script');
  });

  it('posts a one-line heartbeat on a quiet day without calling the model', async () => {
    const r = await runCase({ caseName: 'quiet-day', dataDir });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('heartbeat');
    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('heartbeat');
    expect(brief.bullets).to.have.length(0);
    expect(brief.headline).to.match(/3 projects/);
    expect(r.engine.calls.sessions).to.have.length(0);
    expect(r.engine.calls.singleTurns).to.have.length(0);
    expect(r.slack.chat.postMessage).to.have.been.calledOnce;
    expect(r.slack.files.uploadV2).to.not.have.been.called;
    for (const slug of ['alpha-example-org', 'beta-example-org', 'gamma-example-org']) {
      expect(r.read(`${slug}/candidates.json`)).to.deep.equal([]);
    }
  });

  it('previews the exact payload without posting anything', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, flags: { 'dry-run': true } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('previewed');
    expect(r.slack.chat.postMessage).to.not.have.been.called;
    expect(r.slack.files.uploadV2).to.not.have.been.called;
    const payload = JSON.parse(r.out.text());
    expect(payload).to.deep.equal(r.read('rollup/payload.json'));
    expect(payload.image.slack_file_id).to.equal(null);
    expect(fs.existsSync(path.join(r.root, 'rollup', 'publication.json'))).to.equal(false);
  });

  it('degrades to the deterministic brief after three rejected drafts and still posts with a notice', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, briefMode: 'bad' });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('degraded');
    const brief = r.read('rollup/brief.json');
    expect(brief.kind).to.equal('degraded');
    expect(brief.degradation_notice).to.be.a('string').and.not.empty;
    expect(r.engine.calls.singleTurns).to.have.length(3);
    for (const n of [1, 2, 3]) {
      const report = r.read(`rollup/verification.draft${n}.json`);
      expect(report.outcome).to.equal('rejected');
      expect(report.checks.find((c) => c.name === 'numbers_match').status).to.equal('fail');
    }
    expect(r.slack.chat.postMessage).to.have.been.called;
  });

  it('records two passes with reasons and stops early once a pass changes nothing', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, envExtra: { AGENT_WATCHDOG_PASSES: '3' } });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const passes = r.read('alpha-example-org/passes.json');
    expect(passes.passes).to.have.length(2);
    expect(passes.converged).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass2.json'))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'alpha-example-org', 'findings.pass3.json'))).to.equal(false);
    const session = r.read('alpha-example-org/session.json');
    expect(session.calls).to.have.length(2);
    expect(session.reference_sources_unavailable).to.equal(false);
    // beta had no candidates and must not have opened a session (FR-013)
    expect(fs.existsSync(path.join(r.root, 'beta-example-org', 'session.json'))).to.equal(false);
  });

  it('exits 69 with a failure notice when Grafana is unreachable', async () => {
    const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'quiet-day') });
    const failingFetch = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const out = capture();
    const err = capture();
    const slackPublisher = { postFailureNotice: sinon.stub().resolves({ ts: '1.1' }) };
    let error;
    try {
      await runCommand({
        command: 'run',
        flags: { date: DATE },
        positionals: [],
        env: envFor(dataDir),
        stdout: out.stream,
        stderr: err.stream,
        logger: createLogger({ stream: err.stream, level: 'error' }),
        deps: {
          fetch: failingFetch,
          slackPublisher,
          engine: createScriptedEngine({ dataDir }),
          tracer: fakeTracer(),
          gitSha: 'e2e',
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(codes.UNAVAILABLE);
    expect(slackPublisher.postFailureNotice).to.have.been.calledOnce;
    expect(fake.calls).to.have.length(0);
  });
});

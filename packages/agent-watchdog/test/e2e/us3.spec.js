// End-to-end User Story 3: steering, auditing and running it yourself. Real stages on the synthetic fixtures,
// a fake Grafana, a scripted model, a stubbed Slack client and a fake browser. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { schemas } = require('../../src/model/schemas');
const { tempDir, removeDir } = require('../helpers/fixtures');
const replayCommand = require('../../src/cli/commands/replay');
const { createLogger } = require('../../src/log/logger');
const { runCase, envFor, capture, fakeTracer, createScriptedEngine } = require('./helpers');

const PACKAGE_VERSION = require('../../package.json').version;
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const FAKE_CLAUDE = path.join(__dirname, '..', 'helpers', 'fake-claude.js');
const HEX64 = /^[0-9a-f]{64}$/;

const walk = (root, rel = '') => {
  const out = [];
  const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(root, next));
    } else {
      out.push(next);
    }
  }
  return out;
};

const DASHBOARDS = {
  overview: { uid: 'oa2OfL-Vk', title: 'CHT Admin Overview', panels: [2, 3, 21, 7, 14, 16, 19, 13, 8, 23, 27, 50] },
  details: { uid: 'hkQUbyfVk', title: 'CHT Admin Details', panels: [] },
  api: { uid: '3J_78b6Zz', title: 'CHT API Server', panels: [] },
  replication: { uid: 'd4f05050-804e-4ea4-9642-4d088cc39a1b', title: 'CHT Replication', panels: [] },
};

const writeDashboardsPolicy = (dir, entries) => {
  const lines = ['dashboards:'];
  for (const entry of entries) {
    lines.push(`  - uid: ${entry.uid}`, `    title: ${entry.title}`, `    panels: [${entry.panels.join(', ')}]`);
  }
  fs.writeFileSync(path.join(dir, 'dashboards.yaml'), `${lines.join('\n')}\n`);
};

describe('e2e: User Story 3, steering, auditing and running it yourself', function () {
  this.timeout(60000);
  const dirs = [];
  const fresh = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      const dir = dirs.pop();
      if (process.env.E2E_KEEP) {
        console.log(`E2E_KEEP: run directory kept at ${dir}`);
      } else {
        removeDir(dir);
      }
    }
  });

  it('scenario 1: the footer leads to the prompts, the configuration and the trace, and shows the cost', async () => {
    const dataDir = fresh();
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const env = envFor(dataDir);
    const brief = r.read('rollup/brief.json');
    expect(brief.footer).to.include({
      specs_url: env.AGENT_WATCHDOG_SPECS_URL,
      config_url: env.AGENT_WATCHDOG_CONFIG_URL,
      trace_url: 'https://langfuse.example.org/trace/t1',
    });
    expect(brief.footer.cost_usd).to.be.a('number').greaterThan(0);
    expect(brief.footer.cost_usd).to.equal(r.read('run.json').cost_usd);
    const payload = r.read('rollup/payload.json');
    const footerBlock = payload.parent.blocks[payload.parent.blocks.length - 1];
    expect(footerBlock.type).to.equal('context');
    const text = footerBlock.elements[0].text;
    expect(text).to.include(`<${env.AGENT_WATCHDOG_SPECS_URL}|specs>`);
    expect(text).to.include(`<${env.AGENT_WATCHDOG_CONFIG_URL}|configuration>`);
    expect(text).to.include('<https://langfuse.example.org/trace/t1|trace>');
    expect(text).to.match(/cost \$\d+\.\d{2}/);
    // SC-011: the configuration link is one click from the brief; the priority list lives in that configuration.
    const posted = r.slack.chat.postMessage.firstCall.args[0];
    expect(JSON.stringify(posted.blocks)).to.include(env.AGENT_WATCHDOG_CONFIG_URL);
  });

  it('scenario 2: reordering the priority list changes analysis order; adding a dashboard adds panels', async () => {
    const defaultRun = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh() });
    expect(defaultRun.error, defaultRun.error && defaultRun.error.stack).to.equal(undefined);

    const reordered = fresh();
    const { details, overview, api, replication: replicationEntry } = DASHBOARDS;
    writeDashboardsPolicy(reordered, [details, overview, api, replicationEntry]);
    const reorderedRun = await runCase({
      caseName: 'seeded-anomaly', dataDir: fresh(), envExtra: { AGENT_WATCHDOG_CONFIG_DIR: reordered },
    });
    expect(reorderedRun.error, reorderedRun.error && reorderedRun.error.stack).to.equal(undefined);
    const firstUid = (run) => run.read('discovery.json').dashboards[0].uid;
    expect(firstUid(defaultRun)).to.equal(DASHBOARDS.overview.uid);
    expect(firstUid(reorderedRun)).to.equal(DASHBOARDS.details.uid);
    const metricsOf = (run) => run.read('alpha-example-org/changes.json').map((c) => c.metric);
    expect(metricsOf(defaultRun)).to.not.deep.equal(metricsOf(reorderedRun));
    expect([...metricsOf(defaultRun)].sort()).to.deep.equal([...metricsOf(reorderedRun)].sort());
    expect(metricsOf(reorderedRun)[0]).to.equal(reorderedRun.read('discovery.json').dashboards[0].panels
      .find((p) => p.per_project).metric);
    const configHash = (run) => run.read('run.json').versions.config_hash;
    expect(configHash(reorderedRun)).to.not.equal(configHash(defaultRun));

    const shorter = fresh();
    writeDashboardsPolicy(shorter, [DASHBOARDS.overview, DASHBOARDS.details, DASHBOARDS.api]);
    const shorterRun = await runCase({
      caseName: 'seeded-anomaly', dataDir: fresh(), envExtra: { AGENT_WATCHDOG_CONFIG_DIR: shorter },
    });
    expect(shorterRun.error, shorterRun.error && shorterRun.error.stack).to.equal(undefined);
    const shorterDiscovery = shorterRun.read('discovery.json');
    const fullDiscovery = defaultRun.read('discovery.json');
    expect(shorterDiscovery.dashboards).to.have.length(3);
    expect(fullDiscovery.dashboards).to.have.length(4);
    const replication = fullDiscovery.dashboards.find((d) => d.uid === DASHBOARDS.replication.uid);
    expect(replication.panels.length).to.be.greaterThan(0);
    const shorterPanels = shorterDiscovery.dashboards.flatMap((d) => d.panels.map((p) => `${d.uid}#${p.panel_id}`));
    const fullPanels = fullDiscovery.dashboards.flatMap((d) => d.panels.map((p) => `${d.uid}#${p.panel_id}`));
    expect(fullPanels).to.include.members(shorterPanels);
    expect(fullPanels.length).to.equal(shorterPanels.length + replication.panels.length);
    expect(fullDiscovery.metrics).to.include.members(shorterDiscovery.metrics);
    // The seeded anomalies are on the overview dashboard, so the brief still flags them with the shorter list.
    expect(shorterRun.read('rollup/brief.json').kind).to.equal('brief');
  });

  it('scenario 3: a stored run replays against a changed prompt without contacting Grafana or Slack', async () => {
    const dataDir = fresh();
    const original = await runCase({ caseName: 'seeded-anomaly', dataDir, useTools: true });
    expect(original.error, original.error && original.error.stack).to.equal(undefined);
    const sourceVersions = original.read('run.json').versions;

    // The prompt set under test: a copy of prompts/ with one changed line in the first-pass prompt.
    const promptsDir = fresh();
    for (const name of fs.readdirSync(PROMPTS_DIR)) {
      fs.copyFileSync(path.join(PROMPTS_DIR, name), path.join(promptsDir, name));
    }
    fs.appendFileSync(path.join(promptsDir, 'pass-first.md'), '\nPrefer one item per metric and state the trend.\n');

    const out = capture();
    const err = capture();
    const fetchStub = sinon.stub().rejects(new Error('replay must not fetch'));
    const engine = createScriptedEngine({ dataDir, useTools: true });
    const code = await replayCommand({
      flags: { date: original.runId, prompts: promptsDir, label: 'tighter-severity', engine: 'sdk' },
      env: envFor(dataDir),
      stdout: out.stream,
      logger: createLogger({ stream: err.stream, level: 'warn' }),
      deps: {
        engine, tracer: fakeTracer(), fetch: fetchStub, gitSha: 'e2e', now: () => new Date('2026-09-19T09:00:00Z'),
      },
    });
    expect(code).to.equal(0);
    expect(fetchStub).to.not.have.been.called;

    const replayRoot = path.join(dataDir, 'runs-replay', original.runId, 'tighter-severity');
    const read = (rel) => JSON.parse(fs.readFileSync(path.join(replayRoot, rel), 'utf8'));
    const run = read('run.json');
    expect(run).to.include({ mode: 'replay', replay_of: original.runId, label: 'tighter-severity' });
    expect(run.versions.prompts_hash).to.match(HEX64);
    expect(run.versions.prompts_hash).to.not.equal(sourceVersions.prompts_hash);
    expect(run.versions.skill_hash).to.equal(sourceVersions.skill_hash);
    expect(run.source_versions).to.deep.equal(sourceVersions);
    for (const slug of ['alpha-example-org', 'gamma-example-org']) {
      for (const rel of ['candidates.json', 'changes.json', 'findings.pass1.json', 'verification.pass1.json',
        'passes.json', 'session.json', 'recorded-tool-calls.jsonl', 'prompt.pass1.md']) {
        expect(fs.existsSync(path.join(replayRoot, slug, rel)), `${slug}/${rel}`).to.equal(true);
      }
      expect(fs.readFileSync(path.join(replayRoot, slug, 'prompt.pass1.md'), 'utf8'))
        .to.include('Prefer one item per metric and state the trend.');
      expect(read(`${slug}/verification.pass1.json`).outcome).to.equal('accepted');
    }
    expect(fs.existsSync(path.join(replayRoot, 'rollup'))).to.equal(false);
    // Tool results came from the recording: the replay's get_windows answer equals the source run's, and no
    // call fell through to anything live.
    const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const sourceCalls = readJsonl(path.join(original.root, 'alpha-example-org', 'tool-calls.jsonl'));
    const recorded = readJsonl(path.join(replayRoot, 'alpha-example-org', 'recorded-tool-calls.jsonl'));
    const replayCalls = readJsonl(path.join(replayRoot, 'alpha-example-org', 'tool-calls.jsonl'));
    expect(recorded).to.deep.equal(sourceCalls);
    expect(sourceCalls[0]).to.include({ tool_name: 'mcp__watchdog__get_windows' });
    expect(JSON.parse(sourceCalls[0].tool_response).change.current_value).to.equal(912);
    expect(replayCalls.map((c) => c.tool_response)).to.deep.equal(sourceCalls.map((c) => c.tool_response));

    const comparison = JSON.parse(out.text());
    expect(comparison).to.deep.equal(read('comparison.json'));
    expect(comparison).to.include({ run_id: original.runId, label: 'tighter-severity', engine: 'sdk' });
    expect(comparison.prompts.hash).to.equal(run.versions.prompts_hash);
    // Every discovered project is listed; beta had no candidates and therefore no items before or after.
    expect(comparison.projects.map((p) => p.slug).sort())
      .to.deep.equal(['alpha-example-org', 'beta-example-org', 'gamma-example-org']);
    const beta = comparison.projects.find((p) => p.slug === 'beta-example-org');
    expect(beta.before.items).to.deep.equal([]);
    expect(beta.after.items).to.deep.equal([]);
    // The scripted model answers identically from the same inputs, so nothing was added, removed or changed.
    expect(comparison.totals).to.include({ projects: 3, added: 0, removed: 0, changed: 0 });
    expect(comparison.totals.before_items).to.equal(comparison.totals.after_items);
    expect(comparison.totals.before_items).to.equal(original.read('rollup/items.ranked.json').length);
    expect(comparison.totals.unavailable_tool_calls).to.equal(0);
    for (const project of comparison.projects) {
      expect(project.before.items).to.deep.equal(project.after.items);
      if (project.after.items.length) {
        expect(project.after.gate).to.equal('accepted');
      }
    }
    // The original run is untouched and Slack saw only the original posting.
    expect(original.read('run.json').status).to.equal('published');
    expect(original.slack.chat.postMessage.callCount).to.equal(1 + original.read('rollup/payload.json').replies.length);
  });

  it('scenario 4: the run record names the code, prompt and configuration versions', async () => {
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh() });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const { versions } = r.read('run.json');
    expect(Object.keys(versions).sort()).to.deep.equal([
      'config_hash', 'git_sha', 'package', 'prompts_hash', 'schema_hash', 'skill_hash',
    ]);
    expect(versions.package).to.equal(PACKAGE_VERSION);
    expect(versions.git_sha).to.equal('e2e');
    for (const key of ['prompts_hash', 'skill_hash', 'schema_hash', 'config_hash']) {
      expect(versions[key], key).to.match(HEX64);
    }
  });

  it('scenario 5: preview produces the same artefacts as a posted run and prints the exact payload', async () => {
    const posted = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh() });
    const preview = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh(), flags: { 'dry-run': true } });
    expect(posted.error, posted.error && posted.error.stack).to.equal(undefined);
    expect(preview.error, preview.error && preview.error.stack).to.equal(undefined);
    expect(preview.read('run.json')).to.include({ mode: 'preview', status: 'previewed' });
    const postedFiles = walk(posted.root).filter((f) => f !== 'rollup/publication.json');
    expect(walk(preview.root)).to.deep.equal(postedFiles);
    expect(walk(posted.root)).to.include('rollup/publication.json');
    const payload = JSON.parse(preview.out.text());
    expect(payload).to.deep.equal(preview.read('rollup/payload.json'));
    expect(payload.replies.length).to.equal(posted.read('rollup/payload.json').replies.length);
    expect(payload.image).to.equal(null);
    expect(payload.parent.text).to.equal(posted.read('rollup/payload.json').parent.text);
    expect(preview.slack.chat.postMessage).to.not.have.been.called;
    expect(preview.slack.files.uploadV2).to.not.have.been.called;
    expect(preview.read('rollup/brief.json').publication).to.equal(null);
  });
  it('scenario 6: a contributor runs one stage at a time; each stage reads the previous stage\'s files', async () => {
    const dataDir = fresh();
    const stage = (name, extra = {}) => runCase({
      caseName: 'seeded-anomaly', dataDir, flags: { stage: name, ...extra },
    });

    const collect = await stage('collect');
    expect(collect.error, collect.error && collect.error.stack).to.equal(undefined);
    expect(collect.read('run.json')).to.include({ mode: 'stage', status: 'created', run_id: collect.runId });
    expect(fs.existsSync(path.join(collect.root, 'discovery.json'))).to.equal(true);
    expect(fs.existsSync(path.join(collect.root, 'alpha-example-org', 'inputs', 'windows.json.gz'))).to.equal(true);
    expect(fs.existsSync(path.join(collect.root, 'alpha-example-org', 'changes.json'))).to.equal(false);
    expect(collect.slack.chat.postMessage).to.not.have.been.called;

    const analyze = await stage('analyze');
    expect(analyze.error, analyze.error && analyze.error.stack).to.equal(undefined);
    expect(analyze.read('alpha-example-org/candidates.json').length).to.be.greaterThan(0);
    // Analysis reads only stored files: the fake Grafana saw no request during this stage.
    expect(analyze.fake.calls).to.have.length(0);

    // Deleting an input makes the next stage refuse, naming the file, instead of fabricating it.
    fs.rmSync(path.join(analyze.root, 'alpha-example-org', 'changes.json'));
    const refused = await stage('agent');
    expect(refused.error).to.be.instanceOf(Error);
    expect(refused.error.code).to.equal(65);
    expect(refused.error.message).to.include('alpha-example-org/changes.json');
    expect(refused.read('run.json').stages.find((s) => s.name === 'agent').status).to.equal('failed');
    expect(refused.read('run.json').status).to.equal('created');
    expect(refused.slack.chat.postMessage).to.not.have.been.called;
    expect(fs.existsSync(path.join(refused.root, 'gamma-example-org', 'findings.pass1.json'))).to.equal(false);

    // Re-running a stage overwrites its outputs atomically.
    const before = analyze.read('alpha-example-org/candidates.json');
    const again = await stage('analyze');
    expect(again.error, again.error && again.error.stack).to.equal(undefined);
    expect(again.read('alpha-example-org/candidates.json')).to.deep.equal(before);
    expect(walk(again.root).filter((f) => f.endsWith('.tmp'))).to.deep.equal([]);

    const alphaOnly = await stage('agent', { project: ['alpha.example.org'] });
    expect(alphaOnly.error, alphaOnly.error && alphaOnly.error.stack).to.equal(undefined);
    expect(fs.existsSync(path.join(alphaOnly.root, 'alpha-example-org', 'findings.pass1.json'))).to.equal(true);
    expect(fs.existsSync(path.join(alphaOnly.root, 'gamma-example-org', 'findings.pass1.json'))).to.equal(false);
    const agent = await stage('agent');
    expect(agent.error, agent.error && agent.error.stack).to.equal(undefined);
    expect(fs.existsSync(path.join(agent.root, 'gamma-example-org', 'findings.pass1.json'))).to.equal(true);

    const rollup = await stage('rollup');
    expect(rollup.error, rollup.error && rollup.error.stack).to.equal(undefined);
    expect(rollup.read('rollup/brief.json').kind).to.equal('brief');
    const render = await stage('render');
    expect(render.error, render.error && render.error.stack).to.equal(undefined);
    expect(fs.existsSync(path.join(render.root, 'rollup', 'report.html'))).to.equal(true);
    expect(fs.existsSync(path.join(render.root, 'rollup', 'brief.png'))).to.equal(false);
    const publish = await stage('publish', { 'dry-run': true });
    expect(publish.error, publish.error && publish.error.stack).to.equal(undefined);
    expect(JSON.parse(publish.out.text())).to.deep.equal(publish.read('rollup/payload.json'));
    expect(fs.existsSync(path.join(publish.root, 'rollup', 'publication.json'))).to.equal(false);
    expect(publish.slack.chat.postMessage).to.not.have.been.called;

    const run = publish.read('run.json');
    expect(run.status).to.equal('created');
    expect(run.stage_runs.map((s) => s.stage)).to.deep.equal([
      'collect', 'analyze', 'agent', 'analyze', 'agent', 'agent', 'rollup', 'render', 'publish',
    ]);
  });

  it('scenario 7: the analysis stage driven through the runtime\'s command line yields the same items', async () => {
    // Reference: the same fixture through the scripted SDK-style engine.
    const reference = await runCase({ caseName: 'seeded-anomaly', dataDir: fresh(), flags: { 'dry-run': true } });
    expect(reference.error, reference.error && reference.error.stack).to.equal(undefined);

    // Under test: collect and analyze as usual, then the agent stage with the real CLI engine driving a fake
    // `claude` executable that answers from the run directory exactly as the scripted engine does.
    const dataDir = fresh();
    const recordFile = path.join(fresh(), 'fake-claude.jsonl');
    const cliEnv = {
      AGENT_WATCHDOG_CLAUDE_PATH: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: 'findings',
      FAKE_CLAUDE_DATA_DIR: dataDir,
      FAKE_CLAUDE_RECORD: recordFile,
    };
    for (const name of ['collect', 'analyze']) {
      const r = await runCase({ caseName: 'seeded-anomaly', dataDir, flags: { stage: name } });
      expect(r.error, r.error && r.error.stack).to.equal(undefined);
    }
    const cli = await runCase({
      caseName: 'seeded-anomaly', dataDir, flags: { stage: 'agent', engine: 'cli' }, envExtra: cliEnv, engine: false,
    });
    expect(cli.error, cli.error && cli.error.stack).to.equal(undefined);
    expect(cli.code).to.equal(0);

    const normalise = (pass) => pass.items.map((item) => ({
      item_id: item.item_id, metric: item.metric, severity: item.severity, evidence: item.evidence,
      candidate_ids: [...item.candidate_ids].sort(), dashboard_ref: item.dashboard_ref, confidence: item.confidence,
    })).sort((a, b) => a.item_id.localeCompare(b.item_id));
    for (const slug of ['alpha-example-org', 'gamma-example-org']) {
      const pass = cli.read(`${slug}/findings.pass1.json`);
      expect(() => schemas.Pass.parse(pass), slug).to.not.throw();
      expect(pass.items.length).to.be.greaterThan(0);
      expect(normalise(pass)).to.deep.equal(normalise(reference.read(`${slug}/findings.pass1.json`)));
      const verdict = cli.read(`${slug}/verification.pass1.json`);
      const referenceVerdict = reference.read(`${slug}/verification.pass1.json`);
      expect(verdict.outcome).to.equal('accepted');
      expect(verdict.outcome).to.equal(referenceVerdict.outcome);
      const summary = (report) => report.checks.map((c) => [c.name, c.status]);
      expect(summary(verdict)).to.deep.equal(summary(referenceVerdict));
      expect(cli.read(`${slug}/session.json`).engine).to.equal('cli');
      expect(fs.existsSync(path.join(cli.root, 'agent', `system-prompt.${slug}.md`))).to.equal(true);
      const mcp = JSON.parse(fs.readFileSync(path.join(cli.root, 'agent', `mcp.${slug}.json`), 'utf8'));
      expect(mcp.mcpServers.watchdog).to.include({ type: 'stdio' });
      expect(mcp.mcpServers.watchdog.args).to.include.members(['tools-server', '--project', slug]);
      expect(JSON.stringify(mcp)).to.not.include('xoxb-test');
    }
    expect(cli.read('agent.summary.json').projects_analysed).to.have.length(2);

    // The fake executable saw the verified argument contract and one stream-json user turn per pass.
    const events = fs.readFileSync(recordFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const starts = events.filter((e) => e.event === 'start');
    expect(starts).to.have.length(2);
    for (const { argv } of starts) {
      expect(argv.slice(0, 8)).to.deep.equal([
        '-p', '--bare', '--verbose', '--no-session-persistence', '--input-format', 'stream-json', '--output-format',
        'stream-json',
      ]);
      expect(argv).to.include.members(['--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config']);
      expect(argv[argv.indexOf('--allowed-tools') + 1]).to.equal('mcp__cht-docs__search_docs');
      expect(argv).to.not.include('--max-turns');
      expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]).title).to.include('findings');
    }
    const stdinLines = events.filter((e) => e.event === 'stdin');
    expect(stdinLines.length).to.be.greaterThan(0);
    for (const { line } of stdinLines) {
      const message = typeof line === 'string' ? JSON.parse(line) : line;
      expect(message).to.include({ type: 'user', parent_tool_use_id: null });
      expect(message.message.role).to.equal('user');
    }
  });
});

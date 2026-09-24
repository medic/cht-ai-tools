const fs = require('node:fs');
const path = require('node:path');
const stage = require('../../src/cli/stages/rollup');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeCandidate, makeDiscovery, makeConfig, quietLogger } = require('./factories');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { estimateTokens } = require('../../src/rollup/memory');
const { parseProposalFile } = require('../../src/rollup/proposals');

const pass = (n, items) => ({
  pass: n,
  session_id: 's',
  items,
  not_selected: [],
  changes: [],
  converged: n === 2,
  gate: null,
  usage: null,
  cost_usd: 0.01,
  num_turns: 3,
  duration_ms: 100,
  tool_calls_path: 'alpha-example-org/tool-calls.jsonl',
});

describe('cli/stages/rollup: a filtered run (FR-066, revision 19)', () => {
  const { analysedHosts, scopeClassified } = require('../../src/rollup/scope');

  it('narrows what the brief covers without touching the classified record or the episodes', () => {
    // The seam this relies on: the stage scopes a copy for presentation and writes neither file.
    const discovery = {
      projects: [
        { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' },
        { host: 'beta.example.org', url: 'https://beta.example.org', slug: 'beta-example-org' },
      ],
      groups: [{ label: 'Other', hosts: ['alpha.example.org', 'beta.example.org'] }],
    };
    const hosts = analysedHosts({ discovery, flags: { project: ['https://alpha.example.org'] } });
    expect([...hosts]).to.deep.equal(['alpha.example.org']);
    const classified = {
      available: true,
      instances: [
        { instance_id: 'aaaaaaaaaaaa', host: 'alpha.example.org', state: 'firing', group: 'Other',
          category: 'backlog', importance: 'high', started_at: '2026-09-17T06:00:00Z', days_firing: 1,
          stale: false, new: false, housekeeping: false, title: 'Sentinel Backlog', rule_uid: 'r1' },
        { instance_id: 'bbbbbbbbbbbb', host: 'beta.example.org', state: 'firing', group: 'Other',
          category: 'database', importance: 'low', started_at: '2026-09-17T06:00:00Z', days_firing: 1,
          stale: false, new: false, housekeeping: false, title: 'DB Fragmentation', rule_uid: 'r2' },
      ],
      groups: [{ alert_key: 'Other/backlog' }, { alert_key: 'Other/database' }],
      housekeeping: [],
      counts: { firing: 2, new: 0, stale: 0, housekeeping: 0, pending: 0, unknown_rules: 0 },
    };
    const before = JSON.stringify(classified);
    const scoped = scopeClassified(classified, hosts, { groupSizes: { Other: 2 } });
    expect(scoped.groups.map((g) => g.alert_key)).to.deep.equal(['Other/backlog']);
    expect(scoped.counts.firing).to.equal(1);
    expect(JSON.stringify(classified)).to.equal(before);
  });
});

describe('cli/stages/rollup', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    const first = makeItem({ why_now: 'pass one wording' });
    const revised = makeItem({ why_now: 'pass two wording' });
    await runDir.writeJson('alpha-example-org/candidates.json', [makeCandidate()]);
    await runDir.writeJson('alpha-example-org/changes.json', []);
    await runDir.writeJson('alpha-example-org/findings.pass1.json', pass(1, [first]));
    await runDir.writeJson('alpha-example-org/findings.pass2.json', pass(2, [revised]));
    await runDir.writeJson('alpha-example-org/passes.json', { passes: [1, 2], converged: true, bounds_hit: [] });
    await runDir.writeJson('alpha-example-org/session.json', { reference_sources_unavailable: false, calls: [] });
    await runDir.writeJson('beta-example-org/candidates.json', []);
  });
  afterEach(() => removeDir(dataDir));

  // The roll-up drafts in one session (revision 23); the memory condenser still uses a single turn.
  const sessionEngine = (output) => {
    const session = { turn: sinon.stub().resolves(output), close: sinon.stub().resolves() };
    return { openSession: sinon.stub().resolves(session), session, singleTurn: sinon.stub().resolves(output) };
  };
  const ctxWith = (engineOutput) => ({
    config: makeConfig(),
    logger: quietLogger(),
    runDir,
    runId: '2026-09-18',
    date: '2026-09-18',
    mode: 'scheduled',
    traceUrl: 'https://langfuse.example.org/trace/t1',
    costSoFar: 0.05,
    engine: sessionEngine(engineOutput),
    gate: {
      verifyBrief: sinon.stub().resolves({
        report: { subject: 'brief', subject_ref: 'rollup/draft1', attempt: 1, checks: [], outcome: 'accepted' },
      }),
    },
  });

  it('counts the analysed projects in what was checked when the run was restricted (FR-066, revision 25)', async () => {
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
      },
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    await stage.run({ ...ctx, flags: { project: ['https://alpha.example.org'] } });
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.checked.projects).to.equal(1);
    expect(brief.checked.candidates).to.equal(1);
  });

  it('gathers the last pass of every project, ranks, composes and writes the rollup files', async () => {
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
      },
      result: {
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.01,
        num_turns: 1,
        duration_ms: 5,
        session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    const out = await stage.run(ctx);
    expect(out).to.include({ kind: 'brief', items: 1, bullets: 1, degraded: false });
    const ranked = await runDir.readJson('rollup/items.ranked.json');
    expect(ranked).to.have.length(1);
    expect(ranked[0].why_now).to.equal('pass two wording');
    expect(ranked[0]).to.include({ rank: 1, placement: 'body' });
    expect(runDir.exists('rollup/brief.draft1.json')).to.equal(true);
    expect(runDir.exists('rollup/verification.draft1.json')).to.equal(true);
    const brief = await runDir.readJson('rollup/brief.json');
    // agent cost so far (0.05) plus the roll-up's own draft call (0.01)
    expect(brief.footer).to.include({ trace_url: 'https://langfuse.example.org/trace/t1', cost_usd: 0.06 });
    expect(brief.checked.candidates).to.equal(1);
    const output = await runDir.readJson('rollup/rollup-output.json');
    expect(output).to.have.keys([
      'memory_update', 'proposals', 'proposal_ids', 'proposals_superseded', 'memory', 'alerts',
    ]);
    expect(output.alerts)
      .to.deep.equal({ available: false, groups: 0, episodes: { opened: 0, observed: 0, cleared: 0 } });
    expect(output.proposal_ids).to.deep.equal([]);
    expect(out.proposals).to.deep.equal([]);
    expect(output.memory).to.include({ applied: false, reason: 'no change' });
  });

  it('folds every roll-up draft call into the footer cost so the post and run.json agree', async () => {
    const item = makeItem();
    const draft = {
      headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
      expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
    };
    const turn = (cost) => ({
      structuredOutput: draft,
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: cost, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    const ctx = ctxWith(null);
    ctx.engine.session.turn = sinon.stub().onFirstCall().resolves(turn(0.02)).onSecondCall().resolves(turn(0.03));
    const rejected = {
      subject: 'brief', subject_ref: 'rollup/draft1', attempt: 1, outcome: 'rejected',
      checks: [{ name: 'numbers_match', status: 'fail', reasons: ['bullets[0] contains 913'] }],
    };
    const accepted = { subject: 'brief', subject_ref: 'rollup/draft2', attempt: 2, checks: [], outcome: 'accepted' };
    ctx.gate.verifyBrief = sinon.stub()
      .onFirstCall().resolves({ report: rejected })
      .onSecondCall().resolves({ report: accepted });
    const out = await stage.run(ctx);
    expect(out.calls.map((c) => c.cost_usd)).to.deep.equal([0.02, 0.03]);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.footer.cost_usd).to.equal(0.1);
  });

  it('leaves the heartbeat footer at the agent cost because a heartbeat makes no draft call', async () => {
    fs.rmSync(path.join(runDir.root, 'alpha-example-org'), { recursive: true, force: true });
    const ctx = ctxWith(null);
    await stage.run(ctx);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.footer.cost_usd).to.equal(0.05);
  });

  it('writes a heartbeat without calling the engine when no project produced items', async () => {
    fs.rmSync(path.join(runDir.root, 'alpha-example-org'), { recursive: true, force: true });
    const ctx = ctxWith(null);
    const out = await stage.run(ctx);
    expect(out.kind).to.equal('heartbeat');
    expect(ctx.engine.openSession.called).to.equal(false);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.headline).to.include('All quiet');
  });

  it('writes proposals from the accepted draft with identifiers masked and flagged (FR-032, FR-033)', async () => {
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null },
        proposals: [{
          type: 'skill',
          title: 'Sentinel climbs before month end on alpha.example.org',
          body: 'Seen on alpha.example.org, confirmed by <@U0123ABCD>: a rise over six hours precedes a stuck'
            + ' transition.',
        }],
      },
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    ctx.feedbackAuthors = ['U0123ABCD'];
    const out = await stage.run(ctx);
    const id = '2026-09-18-skill-sentinel-climbs-before-month-end-on-hostname';
    expect(out.proposals).to.deep.equal([id]);
    const file = path.join(dataDir, 'proposals', `${id}.md`);
    expect(fs.existsSync(file)).to.equal(true);
    expect(fs.existsSync(runDir.path('proposals', `${id}.md`))).to.equal(true);
    const text = fs.readFileSync(file, 'utf8');
    const { frontMatter, body } = parseProposalFile(text);
    expect(body).to.include('Seen on [hostname], confirmed by [person]');
    expect(body).to.not.include('alpha.example.org');
    expect(frontMatter.title).to.equal('Sentinel climbs before month end on [hostname]');
    expect(frontMatter.flags.map((f) => f.kind)).to.deep.equal(['hostname', 'person']);
    const output = await runDir.readJson('rollup/rollup-output.json');
    expect(output.proposal_ids).to.deep.equal([id]);
    expect(output.proposals_superseded).to.deep.equal([]);
    expect(output.proposals).to.have.length(1);
  });

  it('condenses an over-cap memory update through the model instead of failing and folds its cost in', async () => {
    const item = makeItem();
    const over = `${Array.from({ length: 300 }, (_, i) => `note ${i}: something durable`).join('\n')}\n`;
    const draft = {
      headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
      expected_load_notice: null, memory_update: { replace_with: over }, proposals: [],
    };
    const turn = (structuredOutput, cost) => ({
      structuredOutput,
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: cost, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    const ctx = ctxWith(null);
    ctx.config.behaviour = { memoryMaxTokens: 500 };
    ctx.definition = loadDefinition({ paths: PACKAGE_PATHS, env: { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' } });
    ctx.engine.session.turn = sinon.stub().resolves(turn(draft, 0.01));
    ctx.engine.singleTurn = sinon.stub().resolves(turn({ memory: 'condensed durable facts\n' }, 0.02));
    const out = await stage.run(ctx);
    expect(out.kind).to.equal('brief');
    expect(ctx.engine.singleTurn.firstCall.args[0].name).to.equal('memory-condense');
    expect(fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8')).to.equal('condensed durable facts\n');
    expect(runDir.exists('memory.patch')).to.equal(true);
    expect(out.calls.map((c) => c.cost_usd)).to.deep.equal([0.01, 0.02]);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.footer.cost_usd).to.equal(0.08);
    const output = await runDir.readJson('rollup/rollup-output.json');
    expect(output.memory).to.include({ applied: true, reason: 'condensed', condensed_by: 'model' });
    expect(Math.ceil(estimateTokens(over) * 1.1)).to.be.greaterThan(500);
  });

  it('writes the standing conditions, names them in a notice and counts every candidate (revision 23)', async () => {
    const standingBacklog = makeCandidate({
      candidate_id: 'b'.repeat(12), metric: 'cht_outbound_push_backlog_count', rule: 'backlog_absolute', observed: 100,
      evidence: [
        { window: 'current', value: 100, unit: 'count' }, { window: 'previous_day', value: 90, unit: 'count' },
      ],
    });
    await runDir.writeJson('alpha-example-org/candidates.json', [makeCandidate(), standingBacklog]);
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
      },
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    await stage.run(ctx);
    const standing = await runDir.readJson('rollup/standing.json');
    expect(standing).to.have.length(1);
    expect(standing[0]).to.include({
      rule: 'backlog_absolute', host: 'alpha.example.org', group: 'Other', value: 100, previous_day_value: 90,
    });
    const brief = await runDir.readJson('rollup/brief.json');
    const standingLine = 'Standing: outbound push backlog above zero on 1 project as yesterday';
    expect(brief.notices.some((n) => n.startsWith(standingLine))).to.equal(true);
    expect(brief.checked.candidates, 'standing candidates are still counted').to.equal(2);
    expect(runDir.exists('rollup/prompt.md')).to.equal(true);
  });

  it('builds the expected-load notice from the run directory\'s window objects, in a stage-only run too', async () => {
    const discovery = makeDiscovery();
    discovery.projects[0].expected_load_windows = [{
      id: 'month-end', kind: 'month_end', days_before: 2, days_after: 2, timezone: 'Africa/Nairobi',
      note: 'Month-end reporting; volumes rise across most projects.', cycle_days: 30, scope: 'alpha.example.org',
    }];
    await runDir.writeJson('discovery.json', discovery);
    await runDir.writeJson('alpha-example-org/changes.json', [{
      project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count', current_value: 912,
      previous_day_value: 300, expected_load_window_id: 'month-end',
    }]);
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
      },
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    // No `activeWindows` on the context: the stage reads the run directory, as `run --stage rollup` must.
    await stage.run(ctx);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.expected_load_notice)
      .to.equal('Expected-load window active: Month-end reporting; volumes rise across most projects.');
    const prompt = ctx.engine.session.turn.firstCall.args[0];
    expect(prompt).to.include('Month-end reporting; volumes rise across most projects.');
    const gateArgs = ctx.gate.verifyBrief.firstCall.args[0];
    expect(gateArgs.givenText.some((t) => t.includes('Month-end reporting'))).to.equal(true);
  });

  it('masks people and addresses in the memory update before storing it (FR-044, revision 33)', async () => {
    const item = makeItem();
    const replaceWith = 'Call <@U024BE7LH> or U024BE7LH at +254 712 345 678 or ops@example.org about '
      + 'alpha.example.org.';
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: replaceWith }, proposals: [],
      },
      result: {
        subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 5, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    await stage.run(ctx);
    const memory = fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8');
    expect(memory).to.equal('Call [person] or [person] at [address] or [address] about alpha.example.org.');
    const patch = fs.readFileSync(path.join(runDir.root, 'memory.patch'), 'utf8');
    expect(patch).to.not.include('U024BE7LH');
    expect(patch).to.not.include('ops@example.org');
    const masked = ctx.logger.events.find((e) => e.event === 'rollup.memory_masked');
    expect(masked).to.include({ level: 'info' });
    expect(masked.kinds).to.deep.equal(['address', 'person']);
  });

  it('refuses to run without discovery.json', async () => {
    fs.rmSync(path.join(runDir.root, 'discovery.json'));
    let error;
    try {
      await stage.run(ctxWith(null));
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(65);
  });
});

const fs = require('node:fs');
const path = require('node:path');
const { runProjectSession } = require('../../src/agent/session-loop');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir } = require('../../src/store/run-dir');
const { createFakeEngine } = require('../helpers/fake-engine');
const { createLogger } = require('../../src/log/logger');
const { schemas } = require('../../src/model/schemas');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { Writable } = require('node:stream');

const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp' };
const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
  cb(); 
} }) });
const config = (overrides = {}) => ({
  model: { name: 'claude-fable-5-1', effort: 'max' },
  bounds: {
    maxTurns: 20, maxBudgetUsdProject: 2, modelTimeoutMs: 900000, verifyMaxRetries: 2, passes: 2, passConvergence: true,
    ...overrides,
  },
});

const candidates = [{
  candidate_id: 'cand00000001', project_url: project.url, metric: 'cht_sentinel_backlog_count', rule: 'monotonic',
  observed: 7,
}];
const changes = [{ metric: 'cht_sentinel_backlog_count', current_value: 912, previous_day_value: 300 }];

const findings = (items, extra = {}) => ({
  project_url: project.url, pass: 1, items, not_selected: [], changes: [], converged: false, notes: '', ...extra,
});
const modelItem = (value = 912, severity = 'high') => ({
  item_key: { metric: 'cht_sentinel_backlog_count', pattern_card: null }, severity,
  evidence: [{ window: 'current', value, unit: 'count' }], why_now: 'climbing', suggested_check: 'check sentinel',
  confidence: 0.9, candidate_ids: ['cand00000001'], reference_urls: [],
});
const acceptedItem = (value = 912, severity = 'high') => ({
  item_id: 'abcdefabcdef', project_url: project.url, metric: 'cht_sentinel_backlog_count', severity,
  evidence: [{ window: 'current', value, unit: 'count' }], why_now: 'climbing', suggested_check: 'check sentinel',
  dashboard_ref: {
    dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: project.url,
    from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z',
  },
  confidence: 0.9, persisting_days: 1, pattern_card: null, candidate_ids: ['cand00000001'], reference_urls: [],
  rank: null,
  placement: null, pass_history: [],
});
const report = (outcome, reasons = []) => ({
  subject: 'pass', subject_ref: 'alpha-example-org/pass1', attempt: 1, outcome,
  checks: [{ name: 'numbers_match', status: outcome === 'accepted' ? 'pass' : 'fail', reasons }],
});
// A gate that accepts whatever it is given unless the evidence value is 913.
const acceptingGate = async ({ findings: f }) => {
  const bad = f && f.items.some((i) => i.evidence.some((e) => e.value === 913));
  if (bad) {
    return { report: report('rejected', ['numbers_match: 913 is not a computed value']), items: [] };
  }
  const items = ((f && f.items) || []).map((i) => acceptedItem(i.evidence[0].value, i.severity));
  return { report: report('accepted'), items };
};

describe('agent/session-loop', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const run = (engine, overrides = {}) => runProjectSession({
    engine, definition, project, candidates, changes, feedback: [], memory: '', activeWindow: null,
    config: config(overrides.bounds), gate: overrides.gate || acceptingGate, runDir, logger,
    tracer: overrides.tracer || null, now: () => new Date('2026-09-18T06:00:00Z'), deadline: overrides.deadline,
    localTools: [],
    localServers: overrides.localServers || {},
  });

  it('runs two passes in one session, converges when nothing changes, and writes every artefact', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem()]) },
      { structuredOutput: findings([modelItem()], { pass: 2 }) },
    ] });
    const result = await run(engine);
    expect(engine.sessions).to.have.length(1);
    const session = engine.sessions[0];
    expect(session.turns).to.have.length(2);
    expect(session.closed).to.equal(true);
    expect(session.options.systemPrompt[1]).to.equal('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(session.options.outputSchema.$id).to.match(/findings/);
    expect(session.options.bounds).to.deep.equal({ maxTurns: 20, maxBudgetUsd: 2, timeoutMs: 900000 });
    expect(session.options.model).to.equal('claude-fable-5-1');
    expect(result.converged).to.equal(true);
    expect(result.items).to.have.length(1);
    expect(result.bounds_hit).to.deep.equal([]);
    expect(result.cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(result.usage.input_tokens).to.equal(201);
    const slug = project.slug;
    const files = [
      'prompt.pass1.md', 'findings.pass1.json', 'verification.pass1.json', 'prompt.pass2.md', 'findings.pass2.json',
      'passes.json', 'session.json',
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(runDir.root, slug, file)), file).to.equal(true);
    }
    const pass1 = JSON.parse(fs.readFileSync(path.join(runDir.root, slug, 'findings.pass1.json'), 'utf8'));
    expect(() => schemas.Pass.parse(pass1)).to.not.throw();
    expect(pass1.items[0].item_id).to.equal('abcdefabcdef');
    const passes = JSON.parse(fs.readFileSync(path.join(runDir.root, slug, 'passes.json'), 'utf8'));
    expect(passes.converged).to.equal(true);
    expect(passes.diffs[0]).to.include({ from: 1, to: 2 });
    expect(passes.diffs[0].added).to.deep.equal([]);
    const sessionRecord = JSON.parse(fs.readFileSync(path.join(runDir.root, slug, 'session.json'), 'utf8'));
    expect(sessionRecord.session_id).to.equal('fake-session');
    expect(sessionRecord.calls).to.have.length(2);
    expect(sessionRecord.reference_sources_unavailable).to.equal(false);
  });

  it('passes in-process tool servers through to the engine session (replay serves recordings this way)', async () => {
    const engine = createFakeEngine({ responses: [{ structuredOutput: findings([modelItem()]) }] });
    const docsTools = [{ name: 'search_docs', description: 'd', schema: {}, handler: async () => ({ content: [] }) }];
    await run(engine, { bounds: { passes: 1 }, localServers: { 'cht-docs': docsTools } });
    expect(engine.sessions[0].options.localServers).to.deep.equal({ 'cht-docs': docsTools });
    expect(engine.sessions[0].options.localTools).to.deep.equal([]);
  });

  it('sends a revision turn with the gate reasons and stops revising after the retry cap', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem(913)]) },
      { structuredOutput: findings([modelItem(913)]) },
      { structuredOutput: findings([modelItem(913)]) },
    ] });
    const result = await run(engine, { bounds: { passes: 1 } });
    const session = engine.sessions[0];
    expect(session.turns).to.have.length(3);
    expect(session.turns[1]).to.include('913 is not a computed value');
    expect(session.turns[1]).to.match(/revise/i);
    expect(result.items).to.deep.equal([]);
    const verificationFile = path.join(runDir.root, project.slug, 'verification.pass1.json');
    const verification = JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
    expect(verification.outcome).to.equal('rejected');
    expect(verification.attempt).to.equal(3);
    // The pass record carries the final gate verdict; the roll-up reads it to name the project (revision 22).
    const passes = JSON.parse(fs.readFileSync(path.join(runDir.root, project.slug, 'passes.json'), 'utf8'));
    expect(passes.passes[0].gate.outcome).to.equal('rejected');
    expect(passes.passes[0].gate.attempt).to.equal(3);
    expect(passes.passes[0].items).to.deep.equal([]);
  });

  it('asks for a revision with only the failing checks\' reasons, never a passing check\'s text (revision 18)',
    async () => {
      const engine = createFakeEngine({ responses: [
        { structuredOutput: findings([modelItem()]) },
        { structuredOutput: findings([modelItem()]) },
      ] });
      let call = 0;
      const gate = async () => {
        call += 1;
        if (call === 1) {
          return {
            report: {
              subject: 'pass',
              subject_ref: 'alpha-example-org/pass1',
              attempt: 1,
              outcome: 'rejected',
              checks: [
                { name: 'numbers_match', status: 'fail', reasons: ['items[0].why_now contains 999'] },
                { name: 'bullet_count', status: 'pass', reasons: ['not applicable to findings'] },
                { name: 'bullet_length', status: 'pass', reasons: ['not applicable to findings'] },
                { name: 'dates_match', status: 'pass', reasons: [] },
              ],
            },
            items: [],
          };
        }
        return { report: report('accepted'), items: [acceptedItem()] };
      };
      const result = await run(engine, { gate, bounds: { passes: 1 } });
      expect(result.items).to.have.length(1);
      const revision = engine.sessions[0].turns[1];
      expect(revision).to.include('items[0].why_now contains 999');
      expect(revision).to.not.include('not applicable to findings');
      const prompt = fs.readFileSync(path.join(runDir.root, project.slug, 'prompt.pass1.md'), 'utf8');
      expect(prompt).to.not.include('not applicable to findings');
    });

  it('keeps the earlier accepted items when a later pass is rejected', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem(912)]) },
      { structuredOutput: findings([modelItem(913)], { pass: 2 }) },
      { structuredOutput: findings([modelItem(913)], { pass: 2 }) },
      { structuredOutput: findings([modelItem(913)], { pass: 2 }) },
    ] });
    const result = await run(engine);
    expect(result.items).to.have.length(1);
    expect(result.items[0].evidence[0].value).to.equal(912);
    expect(result.converged).to.equal(false);
  });

  it('continues to a further pass when items changed and records the diff with reasons', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem(912, 'medium')]) },
      {
        structuredOutput: findings([modelItem(912, 'high')], {
          pass: 2,
          changes: [{
            item_key: { metric: 'cht_sentinel_backlog_count', pattern_card: null },
            change: 'changed',
            reason: 'exceeds three times baseline',
          }],
        }),
      },
      { structuredOutput: findings([modelItem(912, 'high')], { pass: 3 }) },
    ] });
    const result = await run(engine, { bounds: { passes: 3 } });
    expect(engine.sessions[0].turns).to.have.length(3);
    const passes = JSON.parse(fs.readFileSync(path.join(runDir.root, project.slug, 'passes.json'), 'utf8'));
    expect(passes.diffs[0].changed).to.deep.equal(['abcdefabcdef']);
    expect(passes.passes[1].changes[0].reason).to.equal('exceeds three times baseline');
    expect(result.converged).to.equal(true);
  });

  it('stops on a budget or turn bound and records which bound was hit', async () => {
    const budget = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem()]), result: { subtype: 'error_max_budget_usd' } },
    ] });
    const r1 = await run(budget);
    expect(r1.bounds_hit).to.deep.equal(['budget']);
    expect(budget.sessions[0].turns).to.have.length(1);
    expect(r1.items).to.have.length(1);
    const turns = createFakeEngine({ responses: [{ structuredOutput: null, result: { subtype: 'error_max_turns' } }] });
    const r2 = await run(turns);
    expect(r2.bounds_hit).to.deep.equal(['turns']);
    expect(r2.items).to.deep.equal([]);
  });

  it('treats an exhausted structured-output retry as a rejected draft', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: null, result: { subtype: 'error_max_structured_output_retries' } },
      { structuredOutput: findings([modelItem()]) },
    ] });
    const result = await run(engine, { bounds: { passes: 1 } });
    expect(engine.sessions[0].turns).to.have.length(2);
    expect(result.items).to.have.length(1);
  });

  it('records a runtime failure as an error bound with its message, not as a timeout (revision 13)', async () => {
    const message = 'Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON Schema';
    const failing = async () => {
      throw new Error(message);
    };
    const engine = { name: 'broken', openSession: async () => ({ turn: failing, close: async () => {} }) };
    const result = await run(engine);
    expect(result.bounds_hit).to.deep.equal(['error']);
    expect(result.items).to.deep.equal([]);
    expect(result.errors).to.have.length(1);
    expect(result.errors[0]).to.include({ pass: 1, attempt: 1, bound: 'error' });
    expect(result.errors[0].message).to.include('--json-schema');
    const passes = await runDir.readJson(`${project.slug}/passes.json`);
    expect(passes.bounds_hit).to.deep.equal(['error']);
    expect(passes.errors[0].message).to.include('--json-schema');
    const timingOut = async () => {
      throw Object.assign(new Error('turn timed out after 5 ms'), { code: 'TIMEOUT' });
    };
    const timing = { name: 'slow', openSession: async () => ({ turn: timingOut, close: async () => {} }) };
    const slow = await run(timing);
    expect(slow.bounds_hit).to.deep.equal(['timeout']);
    expect(slow.errors[0].bound).to.equal('timeout');
  });

  it('records a result the runtime marks as an error as an error bound with its message and stops (revision 17)',
    async () => {
      const text = "There's an issue with the selected model (claude-opus-4.8). It may not exist or you may not have "
        + 'access to it. Run --model to pick a different model.';
      const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
      const engine = createFakeEngine({ responses: [
        { structuredOutput: null, result: { subtype: 'success', is_error: true, result_text: text, usage: zero,
          total_cost_usd: 0, num_turns: 1 } },
      ] });
      const result = await run(engine);
      expect(result.bounds_hit).to.deep.equal(['error']);
      expect(result.items).to.deep.equal([]);
      expect(result.errors).to.deep.equal([{ pass: 1, attempt: 1, message: text, bound: 'error' }]);
      // No revision and no second pass: the failure will not change with a new prompt.
      expect(engine.sessions[0].turns).to.have.length(1);
      const passes = await runDir.readJson(`${project.slug}/passes.json`);
      expect(passes.bounds_hit).to.deep.equal(['error']);
      expect(passes.errors[0].message).to.include('selected model');
      // A budget stop the runtime also marks as an error keeps its bound.
      const budget = createFakeEngine({ responses: [
        { structuredOutput: null, result: { subtype: 'error_max_budget_usd', is_error: true, result_text: 'budget' } },
      ] });
      const stopped = await run(budget);
      expect(stopped.bounds_hit).to.deep.equal(['budget']);
      expect(stopped.errors).to.deep.equal([]);
    });

  it('runs no review pass when the accepted pass produced no items, and records one pass (revision 19)',
    async () => {
      const engine = createFakeEngine({ responses: [
        { structuredOutput: findings([]) },
        { structuredOutput: findings([modelItem()], { pass: 2 }) },
      ] });
      const emptyGate = async () => ({ report: report('accepted'), items: [] });
      const result = await run(engine, { gate: emptyGate });
      expect(result.items).to.deep.equal([]);
      expect(result.passes).to.have.length(1);
      expect(engine.sessions[0].turns).to.have.length(1);
      expect(result.bounds_hit).to.deep.equal([]);
      const passes = await runDir.readJson(`${project.slug}/passes.json`);
      expect(passes.passes).to.have.length(1);
      // A pass that produced items is still reviewed as before.
      const busy = createFakeEngine({ responses: [
        { structuredOutput: findings([modelItem()]) },
        { structuredOutput: findings([modelItem()], { pass: 2 }) },
      ] });
      expect((await run(busy)).passes).to.have.length(2);
    });

  it('logs how the session used its tools, per project, with failures and refusals (revision 19)', async () => {
    const lines = [];
    const counting = createLogger({ level: 'info', stream: new Writable({ write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
      cb();
    } }) });
    const engine = createFakeEngine({ responses: [{
      structuredOutput: findings([modelItem()]),
      result: { permission_denials: [{ tool_name: 'mcp__cht-docs__ask_question' }] },
      toolCalls: [
        { tool_name: 'mcp__watchdog__get_windows', tool_input: {}, tool_response: '{"windows":[]}' },
        { tool_name: 'mcp__watchdog__get_windows', tool_input: {}, tool_response: '{"error":"unknown metric: x"}' },
        { tool_name: 'mcp__cht-docs__search_docs', tool_input: {}, tool_response: 'a doc' },
        // A documentation result that quotes an error payload of its own is not a failed call: run 2026-09-20-f1
        // counted the only call of the session as failed because the text was searched (revision 19).
        {
          tool_name: 'mcp__cht-docs__search_docs',
          tool_input: {},
          tool_response: 'API logs:\n```\nStatusCodeError: 503 - {"error":"503 Service Unavailable"}\n```',
        },
        // The runtime's own output mechanism is not a tool the model reads with, so it is left out of the count.
        { tool_name: 'StructuredOutput', tool_input: {}, tool_response: 'ok' },
      ],
    }] });
    await runProjectSession({
      engine, definition, project, candidates, changes, feedback: [], memory: '', activeWindow: null,
      config: config({ passes: 1 }), gate: acceptingGate, runDir, logger: counting, tracer: null,
      now: () => new Date('2026-09-18T06:00:00Z'), localTools: [], localServers: {},
    });
    const usage = lines.find((l) => l.event === 'agent.tool_usage');
    expect(usage).to.include({ project_url: project.url, calls: 4, failed: 1, refused: 1 });
    expect(usage.by_tool).to.deep.equal({
      'mcp__watchdog__get_windows': { calls: 2, failed: 1 },
      'mcp__cht-docs__search_docs': { calls: 2, failed: 0 },
    });
    expect(usage.refused_tools).to.deep.equal(['mcp__cht-docs__ask_question']);
  });

  it('honours the run deadline before opening a new turn', async () => {
    const engine = createFakeEngine({ responses: [{ structuredOutput: findings([modelItem()]) }] });
    const result = await run(engine, { deadline: Date.now() - 1 });
    expect(result.bounds_hit).to.deep.equal(['timeout']);
    expect(engine.sessions).to.have.length(0);
  });

  it('records a generation per turn on the tracer and every tool call to tool-calls.jsonl', async () => {
    // The tracer's observation id, when it gives one, is kept on the session record so a digest can link the
    // generation (FR-085, revision 29); a tracer that returns nothing leaves null.
    const tracer = { generation: sinon.stub().onFirstCall().returns({ id: 'obs1' }).onSecondCall().returns(undefined) };
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings([modelItem()]), toolCalls: [{ tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel' }, tool_response: 'Source: https://docs.communityhealthtoolkit.org/x' }] },
      { structuredOutput: findings([modelItem()], { pass: 2 }) },
    ] });
    const gateSpy = sinon.spy(acceptingGate);
    await run(engine, { tracer, gate: gateSpy });
    expect(tracer.generation).to.have.callCount(2);
    expect(tracer.generation.firstCall.args[0]).to.include({ model: 'claude-fable-5-1', costUsd: 0.01 });
    const session = JSON.parse(fs.readFileSync(path.join(runDir.root, project.slug, 'session.json'), 'utf8'));
    expect(session.calls.map((c) => c.observation_id)).to.deep.equal(['obs1', null]);
    const lines = fs.readFileSync(path.join(runDir.root, project.slug, 'tool-calls.jsonl'), 'utf8').trim().split('\n');
    expect(lines).to.have.length(1);
    expect(JSON.parse(lines[0])).to.include({ pass: 1, tool_name: 'mcp__cht-docs__search_docs' });
    expect(gateSpy.firstCall.args[0].toolResultUrls).to.deep.equal(['https://docs.communityhealthtoolkit.org/x']);
  });
});

describe('agent/session-loop: the text the model was given reaches the gate (FR-016, revision 23)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  it('hands the gate every prompt sent in the session and every tool result text', async () => {
    const engine = createFakeEngine({ responses: [
      {
        structuredOutput: findings([modelItem(913)]),
        toolCalls: [{
          tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'x' }, tool_response: '{"count": 41}',
        }],
      },
      { structuredOutput: findings([modelItem()]) },
    ] });
    const gateSpy = sinon.spy(acceptingGate);
    await runProjectSession({
      engine, definition, project, candidates, changes, feedback: [], memory: '', activeWindow: null,
      config: config({ passes: 1 }), gate: gateSpy, runDir, logger, now: () => new Date('2026-09-18T06:00:00Z'),
      localTools: [], localServers: {}, mcpConfig: { mcpServers: {} },
    });
    expect(gateSpy).to.have.been.calledTwice;
    const first = gateSpy.firstCall.args[0].givenText;
    expect(first.some((text) => text.includes('cht_sentinel_backlog_count')), 'the pass prompt').to.equal(true);
    expect(first).to.include('{"count": 41}');
    const second = gateSpy.secondCall.args[0].givenText;
    expect(second.length).to.be.greaterThan(first.length);
    expect(second.some((text) => text.includes('913')), 'the revision prompt').to.equal(true);
  });
});

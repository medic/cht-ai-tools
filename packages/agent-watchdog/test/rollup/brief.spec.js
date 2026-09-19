const { composeBrief } = require('../../src/rollup/brief');
const { schemas } = require('../../src/model/schemas');
const { rankItems } = require('../../src/rollup/rank');
const { makeItem, makeCandidate, makeDiscovery, footer, makeConfig, quietLogger } = require('./factories');

const draftFor = (items, overrides = {}) => ({
  headline: 'Sentinel backlog tripled on alpha',
  bullets: items.slice(0, 3).map((i) => ({ item_id: i.item_id, text: `${i.metric} 912 vs 300 yesterday` })),
  thread_order: items.map((i) => i.item_id),
  expected_load_notice: null,
  memory_update: { replace_with: 'remember: alpha sentinel spikes at month end' },
  proposals: [{ type: 'threshold', title: 'Loosen alpha sentinel', body: 'pattern-level body' }],
  ...overrides,
});

const successResult = (structuredOutput) => ({
  structuredOutput,
  result: {
    subtype: 'success',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.02,
    num_turns: 1,
    duration_ms: 1500,
    session_id: 's1',
  },
  toolCalls: [],
  referenceUnavailable: false,
});

const accepted = {
  report: { subject: 'brief', subject_ref: 'rollup/draft1', attempt: 1, checks: [], outcome: 'accepted' },
};
const rejected = (reasons) => ({
  report: {
    subject: 'brief',
    subject_ref: 'rollup/draft1',
    attempt: 1,
    checks: [{ name: 'numbers_match', status: 'fail', reasons }],
    outcome: 'rejected',
  },
});

const makeCtx = ({ engine, gate }) => ({
  config: makeConfig(),
  logger: quietLogger(),
  runId: '2026-09-18',
  date: '2026-09-18',
  engine,
  gate,
  definition: { rollup: 'ROLLUP TEMPLATE {{date}}' },
});

describe('rollup/brief composeBrief', () => {
  const items = rankItems({
    items: [makeItem(), makeItem({ metric: 'cht_conflict_count', severity: 'low', confidence: 0.4 })],
  });
  const base = () => ({
    discovery: makeDiscovery(),
    changes: {},
    candidates: [makeCandidate()],
    memory: 'memory text',
    feedbackUnmatched: [],
    expectedLoadNotice: null, referenceSourcesUnavailable: false, footer: footer(),
  });

  it('accepts the first draft, returns a brief with ranked bullets and the memory update and proposals', async () => {
    const engine = { singleTurn: sinon.stub().resolves(successResult(draftFor(items))) };
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(false);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    expect(out.brief.kind).to.equal('brief');
    expect(out.brief.bullets.map((b) => b.item_id)).to.deep.equal(items.slice(0, 3).map((i) => i.item_id));
    expect(out.brief.footer).to.deep.equal(footer());
    expect(out.brief.checked).to.deep.equal({ projects: 3, panels: 3, candidates: 1 });
    expect(out.drafts).to.have.length(1);
    expect(out.memoryUpdate).to.deep.equal({ replace_with: 'remember: alpha sentinel spikes at month end' });
    expect(out.proposals).to.have.length(1);
    expect(out.calls).to.have.length(1);
    expect(out.calls[0]).to.include({ cost_usd: 0.02, model: 'claude-fable-5-1' });
    const call = engine.singleTurn.firstCall.args[0];
    expect(call.outputSchema.$id).to.include('brief.schema.json');
    expect(call.systemPrompt).to.deep.equal(['ROLLUP TEMPLATE {{date}}']);
    expect(call.userPrompt).to.include(items[0].item_id);
    expect(call.userPrompt).to.include('<untrusted');
    expect(call.bounds).to.deep.equal({ maxTurns: 20, maxBudgetUsd: 2, timeoutMs: 900000 });
    expect(call).to.include({ model: 'claude-fable-5-1', effort: 'max' });
  });

  it('returns rejection reasons to the model and accepts a later draft', async () => {
    const engine = { singleTurn: sinon.stub() };
    engine.singleTurn.onCall(0).resolves(successResult(draftFor(items, { headline: 'bad numbers' })));
    engine.singleTurn.onCall(1).resolves(successResult(draftFor(items, { headline: 'still bad' })));
    engine.singleTurn.onCall(2).resolves(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub() };
    gate.verifyBrief.onCall(0).resolves(rejected(['912 does not match']));
    gate.verifyBrief.onCall(1).resolves(rejected(['still wrong']));
    gate.verifyBrief.onCall(2).resolves(accepted);
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(false);
    expect(out.drafts).to.have.length(3);
    expect(out.drafts.map((d) => d.attempt)).to.deep.equal([1, 2, 3]);
    expect(engine.singleTurn.secondCall.args[0].userPrompt).to.include('912 does not match');
    expect(engine.singleTurn.thirdCall.args[0].userPrompt).to.include('still wrong');
    expect(gate.verifyBrief.thirdCall.args[0].attempt).to.equal(3);
  });

  it('degrades to the deterministic brief after the third rejection', async () => {
    const engine = { singleTurn: sinon.stub().resolves(successResult(draftFor(items))) };
    const gate = { verifyBrief: sinon.stub().resolves(rejected(['nope'])) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(out.brief.kind).to.equal('degraded');
    expect(out.brief.degradation_notice).to.include('three');
    expect(engine.singleTurn.callCount).to.equal(3);
    expect(out.drafts).to.have.length(3);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
  });

  it('degrades immediately when the model result is unusable', async () => {
    const bad = successResult(null);
    bad.result.subtype = 'error_max_budget_usd';
    const engine = { singleTurn: sinon.stub().resolves(bad) };
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(engine.singleTurn.callCount).to.equal(1);
    expect(gate.verifyBrief.called).to.equal(false);
    expect(out.brief.degradation_notice).to.include('error_max_budget_usd');
  });

  it('degrades when the structured output does not match the brief schema', async () => {
    const engine = { singleTurn: sinon.stub().resolves(successResult({ headline: 5 })) };
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(gate.verifyBrief.called).to.equal(false);
  });

  it('skips the model entirely and returns a heartbeat when there are no items', async () => {
    const engine = { singleTurn: sinon.stub() };
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items: [], ...base(), candidates: [] });
    expect(engine.singleTurn.called).to.equal(false);
    expect(out.brief.kind).to.equal('heartbeat');
    expect(out.degraded).to.equal(false);
    expect(out.memoryUpdate).to.equal(null);
  });

  it('notes unavailable reference sources on the brief and in the prompt', async () => {
    const engine = { singleTurn: sinon.stub().resolves(successResult(draftFor(items))) };
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({
      ctx: makeCtx({ engine, gate }), items, ...base(), referenceSourcesUnavailable: true,
    });
    expect(out.brief.degradation_notice).to.match(/reference sources were unavailable/i);
    expect(engine.singleTurn.firstCall.args[0].userPrompt).to.match(/reference sources were unavailable/i);
  });

  it('uses a built-in roll-up template when the definition has none', async () => {
    const engine = { singleTurn: sinon.stub().resolves(successResult(draftFor(items))) };
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const ctx = makeCtx({ engine, gate });
    delete ctx.definition;
    await composeBrief({ ctx, items, ...base() });
    expect(engine.singleTurn.firstCall.args[0].systemPrompt[0]).to.match(/bullets/i);
  });
});

const { composeBrief } = require('../../src/rollup/brief');
const { schemas } = require('../../src/model/schemas');
const { rankItems } = require('../../src/rollup/rank');
const { makeItem, makeCandidate, makeDiscovery, footer, makeConfig, quietLogger } = require('./factories');

const draftFor = (items, overrides = {}) => ({
  headline: 'Sentinel backlog tripled on alpha',
  bullets: items.filter((i) => i.placement !== 'thread')
    .map((i) => ({ item_id: i.item_id, text: `${i.metric} 912 vs 300 yesterday` })),
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


// The roll-up drafts in one session since revision 23: `openSession` once, one `turn` per attempt, closed at the end.
const engineWith = (...responses) => {
  const turn = sinon.stub();
  responses.forEach((response, i) => turn.onCall(i).resolves(response));
  if (responses.length === 1) {
    turn.resolves(responses[0]);
  }
  const session = { turn, close: sinon.stub().resolves() };
  return { openSession: sinon.stub().resolves(session), session, singleTurn: sinon.stub() };
};

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
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(false);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    expect(out.brief.kind).to.equal('brief');
    expect(out.brief.bullets.map((b) => b.item_id)).to.deep.equal(items.map((i) => i.item_id));
    expect(out.brief.bullets[0]).to.include({ kind: 'item', group: 'Other' });
    expect(gate.verifyBrief.firstCall.args[0].layout.body_items).to.deep.equal(items.map((i) => i.item_id));
    expect(out.brief.footer).to.deep.equal(footer());
    expect(out.brief.checked).to.deep.equal({ projects: 3, panels: 3, candidates: 1 });
    expect(out.drafts).to.have.length(1);
    expect(out.memoryUpdate).to.deep.equal({ replace_with: 'remember: alpha sentinel spikes at month end' });
    expect(out.proposals).to.have.length(1);
    expect(out.calls).to.have.length(1);
    expect(out.calls[0]).to.include({ cost_usd: 0.02, model: 'claude-fable-5-1' });
    const call = { ...engine.openSession.firstCall.args[0], userPrompt: engine.session.turn.firstCall.args[0] };
    expect(call.outputSchema.$id).to.include('brief.schema.json');
    expect(call.systemPrompt[0]).to.match(/one bullet per body item/i);
    expect(call.userPrompt).to.include('## Body layout');
    expect(call.userPrompt.startsWith('ROLLUP TEMPLATE 2026-09-18')).to.equal(true);
    expect(call.userPrompt).to.include(items[0].item_id);
    expect(call.userPrompt).to.include('<untrusted');
    expect(call.bounds).to.deep.equal({ maxTurns: 20, maxBudgetUsd: 2, timeoutMs: 900000 });
    expect(call).to.include({ model: 'claude-fable-5-1', effort: 'max' });
  });

  it('returns rejection reasons to the model and accepts a later draft', async () => {
    const engine = engineWith();
    engine.session.turn.onCall(0).resolves(successResult(draftFor(items, { headline: 'bad numbers' })));
    engine.session.turn.onCall(1).resolves(successResult(draftFor(items, { headline: 'still bad' })));
    engine.session.turn.onCall(2).resolves(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub() };
    gate.verifyBrief.onCall(0).resolves(rejected(['912 does not match']));
    gate.verifyBrief.onCall(1).resolves(rejected(['still wrong']));
    gate.verifyBrief.onCall(2).resolves(accepted);
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(false);
    expect(out.drafts).to.have.length(3);
    expect(out.drafts.map((d) => d.attempt)).to.deep.equal([1, 2, 3]);
    expect(engine.session.turn.secondCall.args[0]).to.include('912 does not match');
    expect(engine.session.turn.thirdCall.args[0]).to.include('still wrong');
    expect(gate.verifyBrief.thirdCall.args[0].attempt).to.equal(3);
  });

  it('degrades to the deterministic brief after the third rejection', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(rejected(['nope'])) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(out.brief.kind).to.equal('degraded');
    expect(out.brief.degradation_notice).to.include('three');
    expect(engine.session.turn.callCount).to.equal(3);
    expect(out.drafts).to.have.length(3);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
  });

  it('degrades immediately when the model result is unusable', async () => {
    const bad = successResult(null);
    bad.result.subtype = 'error_max_budget_usd';
    const engine = engineWith(bad);
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(engine.session.turn.callCount).to.equal(1);
    expect(gate.verifyBrief.called).to.equal(false);
    expect(out.brief.degradation_notice).to.include('error_max_budget_usd');
  });

  it('degrades when the structured output does not match the brief schema', async () => {
    const engine = engineWith(successResult({ headline: 5 }));
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(true);
    expect(gate.verifyBrief.called).to.equal(false);
  });

  it('skips the model entirely and returns a heartbeat when there are no items', async () => {
    const engine = engineWith();
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items: [], ...base(), candidates: [] });
    expect(engine.openSession.called).to.equal(false);
    expect(out.brief.kind).to.equal('heartbeat');
    expect(out.degraded).to.equal(false);
    expect(out.memoryUpdate).to.equal(null);
  });

  it('notes unavailable reference sources on the brief and in the prompt', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({
      ctx: makeCtx({ engine, gate }), items, ...base(), referenceSourcesUnavailable: true,
    });
    expect(out.brief.degradation_notice).to.match(/reference sources were unavailable/i);
    expect(engine.session.turn.firstCall.args[0]).to.match(/reference sources were unavailable/i);
  });

  it('uses a built-in roll-up template when the definition has none', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const ctx = makeCtx({ engine, gate });
    delete ctx.definition;
    await composeBrief({ ctx, items, ...base() });
    expect(engine.openSession.firstCall.args[0].systemPrompt[0]).to.match(/bullets/i);
  });
});

describe('rollup/brief: the roll-up sees the day\'s feedback (FR-029, User Story 7)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rollupTemplate = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'rollup.md'), 'utf8');
  const items = rankItems({ items: [makeItem()] });
  const feedback = [{
    item_id: items[0].item_id, project_url: items[0].project_url, metric: items[0].metric, pattern_card: null,
    up: 0, down: 1, retracted: 0, verdict: 'dismissed', horizon: '2026-10-01',
    notes: ['known migration, expected until 1 October'],
    author: 'U0123ABCD',
  }];
  const ctxWith = (engine) => ({
    config: makeConfig(), logger: quietLogger(), runId: '2026-09-18', date: '2026-09-18', engine,
    gate: { verifyBrief: sinon.stub().resolves(accepted) }, definition: { rollup: rollupTemplate },
  });
  const inputs = () => ({
    discovery: makeDiscovery(), changes: {}, candidates: [makeCandidate()], memory: 'alpha spikes at month end',
    feedbackUnmatched: [{ feedback_id: 'ffffffffffff', note: 'what about beta?' }], expectedLoadNotice: null,
    referenceSourcesUnavailable: false, footer: footer(), feedback, feedbackBrief: { up: 1, down: 0, notes: [] },
  });

  it('fills every placeholder of prompts/rollup.md and puts the matched feedback in the user turn', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    await composeBrief({ ctx: ctxWith(engine), items, ...inputs() });
    const call = { ...engine.openSession.firstCall.args[0], userPrompt: engine.session.turn.firstCall.args[0] };
    expect(call.systemPrompt).to.have.length(1);
    expect(call.systemPrompt[0]).to.match(/^## Instructions/m).and.match(/one bullet per body item/i);
    expect(call.userPrompt).to.include('## Body layout');
    expect(call.userPrompt).to.include('"one_line"');
    expect(call.systemPrompt[0]).to.not.include('{{');
    expect(call.systemPrompt[0]).to.not.include('## Memory condensation');
    expect(call.userPrompt).to.not.include('{{');
    expect(call.userPrompt).to.include('Run date: 2026-09-18');
    expect(call.userPrompt).to.include('<untrusted source="ranked-items">');
    expect(call.userPrompt).to.include(items[0].item_id);
    expect(call.userPrompt).to.match(/3 projects, \d+ panels, 1 candidate/);
    expect(call.userPrompt).to.include('<untrusted source="feedback">');
    expect(call.userPrompt).to.include('known migration, expected until 1 October');
    expect(call.userPrompt).to.include('"verdict": "dismissed"');
    expect(call.userPrompt).to.include('"horizon": "2026-10-01"');
    expect(call.userPrompt).to.include('"brief"');
    expect(call.userPrompt).to.not.include('U0123ABCD');
    expect(call.userPrompt).to.not.match(/"author"/);
    expect(call.userPrompt).to.include('<untrusted source="memory">');
    expect(call.userPrompt).to.include('alpha spikes at month end');
    expect(call.userPrompt).to.include('<untrusted source="unmatched-feedback-notes">');
    expect(call.userPrompt).to.include('what about beta?');
    const order = ['ranked-items', 'source="feedback"', 'source="memory"'].map((m) => call.userPrompt.indexOf(m));
    expect(order).to.deep.equal([...order].sort((a, b) => a - b));
  });

  it('says so when there is no feedback, no memory and no expected-load window', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    await composeBrief({
      ctx: ctxWith(engine), items, ...inputs(), feedback: [], feedbackBrief: null, memory: null, feedbackUnmatched: [],
    });
    const prompt = engine.session.turn.firstCall.args[0];
    expect(prompt).to.include('No feedback was recorded for this run.');
    expect(prompt).to.include('No memory has been recorded yet.');
    expect(prompt).to.include('No expected-load window is active.');
    expect(prompt).to.not.include('{{');
  });
});

describe('rollup/brief: the body layout and programme bullets (FR-010, FR-069, User Story 9)', () => {
  const { buildLayout, groupOfProjects } = require('../../src/rollup/layout');
  const { makeProject } = require('./factories');
  const discovery = makeDiscovery({
    projects: [
      makeProject('north-a.example.org', { group: 'North Programme' }),
      makeProject('north-b.example.org', { group: 'North Programme' }),
      makeProject('alpha.example.org'),
    ],
  });
  const groupOf = groupOfProjects(discovery);
  const items = rankItems({
    items: [
      makeItem({ project_url: 'https://north-a.example.org', confidence: 0.9 }),
      makeItem({ project_url: 'https://alpha.example.org', confidence: 0.8 }),
      makeItem({ project_url: 'https://north-b.example.org', confidence: 0.7 }),
    ],
    groupOf,
  });
  const layout = buildLayout(items, { groupOf });
  const inputs = (engine, gate) => ({
    ctx: makeCtx({ engine, gate }), items, layout, discovery, changes: {}, candidates: [makeCandidate()], memory: null,
    feedbackUnmatched: [], expectedLoadNotice: null, referenceSourcesUnavailable: false, footer: footer(),
  });

  it('tells the model which items are one-line sub-bullets and passes the layout to the gate', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    await composeBrief(inputs(engine, gate));
    const prompt = engine.session.turn.firstCall.args[0];
    const section = prompt.slice(prompt.indexOf('## Body layout'));
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)[1]);
    expect(json).to.deep.equal(layout.slots);
    expect(json[0]).to.include({ kind: 'group', group: 'North Programme', one_line: true });
    expect(json[0].item_ids).to.deep.equal([items[0].item_id, items[2].item_id]);
    expect(gate.verifyBrief.firstCall.args[0].layout).to.deep.equal(layout);
  });

  it('assembles a group bullet from the layout with code-built text and the model\'s one-line children', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief(inputs(engine, gate));
    expect(out.degraded).to.equal(false);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    expect(out.brief.bullets).to.have.length(2);
    const [group, single] = out.brief.bullets;
    expect(group).to.deep.include({ kind: 'group', item_id: null, group: 'North Programme', alert_key: null });
    expect(group.text).to.equal('North Programme: 2 projects with issues');
    expect(group.children).to.deep.equal([
      { item_id: items[0].item_id, text: 'cht_sentinel_backlog_count 912 vs 300 yesterday' },
      { item_id: items[2].item_id, text: 'cht_sentinel_backlog_count 912 vs 300 yesterday' },
    ]);
    expect(single).to.deep.include({ kind: 'item', item_id: items[1].item_id, group: 'Other', children: [] });
  });

  it('builds the layout itself from the discovery when the caller passes none', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({ ...inputs(engine, gate), layout: undefined });
    expect(out.brief.bullets).to.have.length(2);
    expect(gate.verifyBrief.firstCall.args[0].layout.slots).to.have.length(2);
  });
});

describe('rollup/brief: alert bullets (FR-066, User Story 8)', () => {
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const northBacklog = alertGroupOf([
    classified('sentinel', 'north-a.example.org', { new: true }),
    classified('sentinel', 'north-b.example.org', { started_at: '2026-08-20T00:00:00Z' }),
  ]);
  const northAvailability = alertGroupOf([classified('apiDown', 'north-b.example.org')]);
  const alertGroups = [northBacklog, northAvailability];
  const items = rankItems({ items: [makeItem()] });
  const base = (engine, gate) => ({
    ctx: makeCtx({ engine, gate }), items, discovery: makeDiscovery(), changes: {}, candidates: [makeCandidate()],
    memory: null, feedbackUnmatched: [], expectedLoadNotice: null, referenceSourcesUnavailable: false, footer: footer(),
    alertGroups, staleAfterDays: 14,
  });

  it('puts the code-built alerts bullet first and hands the alert links to the gate', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const links = ['https://watchdog.example.org/alerting/list?search=x'];
    const out = await composeBrief({ ...base(engine, gate), alertLinks: links });
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    expect(out.brief.bullets.map((b) => b.kind)).to.deep.equal(['alerts', 'item']);
    expect(out.brief.bullets[0].text).to.equal('North Programme alerts: 3 firing, 1 stale for more than 14 days');
    expect(out.brief.bullets[0].children.map((c) => c.text)).to.deep.equal([
      'availability: 1 firing (API Server Down), oldest since 2026-09-17',
      'backlog: 2 firing (Sentinel Backlog), oldest since 2026-08-20, 1 stale, 1 new',
    ]);
    const prompt = engine.session.turn.firstCall.args[0];
    expect(prompt).to.match(/kind.*alerts.*written by code/i);
    const layoutArg = gate.verifyBrief.firstCall.args[0].layout;
    expect(layoutArg.slots[0]).to.include({ kind: 'alerts', group: 'North Programme' });
    expect(layoutArg.body_items).to.deep.equal([items[0].item_id]);
    expect(gate.verifyBrief.firstCall.args[0].extraUrls).to.deep.equal(links);
  });

  it('degrades to the deterministic brief and names the failure when the sessions failed (revision 13)', async () => {
    const engine = engineWith();
    const gate = { verifyBrief: sinon.stub() };
    const analysis = {
      projects: 2,
      failed: ['https://alpha.example.org', 'https://beta.example.org'],
      errors: ['Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON Schema'],
    };
    const out = await composeBrief({ ...base(engine, gate), items: [], candidates: [makeCandidate()], analysis });
    expect(engine.openSession.called).to.equal(false);
    expect(out.degraded).to.equal(true);
    expect(out.brief.kind).to.equal('degraded');
    expect(out.brief.headline).to.not.include('no metric changes');
    expect(out.brief.degradation_notice).to.include('model analysis failed on 2 of 2 projects');
    expect(out.brief.degradation_notice).to.include('--json-schema');
    const kinds = out.brief.bullets.map((b) => b.kind);
    expect(kinds, 'alert bullets stay in the degraded layout').to.include('alerts');
    expect(kinds).to.include('item');
    const prefix = 'Analysis incomplete: model sessions failed on 2 of 2';
    const incomplete = out.brief.notices.filter((n) => n.startsWith(prefix));
    expect(incomplete).to.have.length(1);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    // Without candidates there is nothing to show: the alerts-only brief, but still with the notice.
    const empty = await composeBrief({ ...base(engine, gate), items: [], candidates: [], analysis });
    expect(empty.brief.kind).to.equal('brief');
    expect(empty.brief.notices.some((n) => n.startsWith('Analysis incomplete'))).to.equal(true);
  });

  it('degrades and names the bound when every session was stopped before a result (revision 16)', async () => {
    const engine = engineWith();
    const gate = { verifyBrief: sinon.stub() };
    const analysis = {
      projects: 1, failed: [], errors: [],
      incomplete: [{ project_url: 'https://alpha.example.org', bounds: ['budget'], cost_usd: 0.84874 }],
    };
    const out = await composeBrief({ ...base(engine, gate), items: [], candidates: [makeCandidate()], analysis });
    expect(engine.openSession.called).to.equal(false);
    expect(out.degraded).to.equal(true);
    expect(out.brief.kind).to.equal('degraded');
    expect(out.brief.degradation_notice)
      .to.include('model sessions were stopped by the session budget on 1 of 1 projects before a result ($0.85 spent)');
    const notice = 'Analysis incomplete: model sessions were stopped by the session budget on 1 of 1 projects '
      + 'before a result ($0.85 spent)';
    expect(out.brief.notices.filter((n) => n === notice)).to.have.length(1);
    expect(out.brief.bullets.map((b) => b.kind)).to.include('item');
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    // Both failures and cut-offs: one notice each, and the degradation names both.
    const both = {
      projects: 3, failed: ['https://beta.example.org'], errors: ['session ended before a result'],
      incomplete: [
        { project_url: 'https://alpha.example.org', bounds: ['budget'], cost_usd: 0.5 },
        { project_url: 'https://gamma.example.org', bounds: ['turns'], cost_usd: 0.25 },
      ],
    };
    const mixed = await composeBrief({
      ...base(engine, gate), items: [], candidates: [makeCandidate()], analysis: both,
    });
    expect(mixed.brief.degradation_notice).to.include('model analysis failed on 1 of 3 projects (session ended before '
      + 'a result); model sessions were stopped by the session budget or turn cap on 2 of 3 projects before a result '
      + '($0.75 spent)');
    expect(mixed.brief.notices.filter((n) => n.startsWith('Analysis incomplete'))).to.have.length(2);
  });

  it('keeps the model brief when only some sessions were stopped before a result, and says so', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const analysis = {
      projects: 3, failed: [], errors: [],
      incomplete: [{ project_url: 'https://gamma.example.org', bounds: ['turns'], cost_usd: 1.2 }],
    };
    const out = await composeBrief({ ...base(engine, gate), analysis });
    expect(out.degraded).to.equal(false);
    expect(out.brief.notices).to.include('Analysis incomplete: model sessions were stopped by the turn cap on 1 of 3 '
      + 'projects before a result ($1.20 spent)');
  });

  it('degrades and names the gate when every finding was rejected on every attempt (revision 22)', async () => {
    const engine = engineWith();
    const gate = { verifyBrief: sinon.stub() };
    const analysis = {
      projects: 3, failed: [], errors: [], incomplete: [],
      rejected: [{ project_url: 'https://alpha.example.org', reason: 'numbers_match' }],
    };
    const out = await composeBrief({ ...base(engine, gate), items: [], candidates: [makeCandidate()], analysis });
    expect(engine.openSession.called).to.equal(false);
    expect(out.degraded).to.equal(true);
    const text = 'no findings for 1 of 3 projects (alpha.example.org): the verification gate refused the model\'s '
      + 'analysis on every attempt, mostly for a number that matched no computed value';
    expect(out.brief.degradation_notice).to.include(text);
    expect(out.brief.notices.filter((n) => n === `Analysis incomplete: ${text}`)).to.have.length(1);
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
  });

  it('keeps the model brief when only some sessions failed, and says so in the notices', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const analysis = { projects: 3, failed: ['https://gamma.example.org'], errors: ['session ended before a result'] };
    const out = await composeBrief({ ...base(engine, gate), analysis });
    expect(out.degraded).to.equal(false);
    expect(out.brief.notices.some((n) => n === 'Analysis incomplete: model sessions failed on 1 of 3 projects '
      + '(session ended before a result)')).to.equal(true);
  });

  it('posts alert bullets without any model call when no item was flagged, instead of a heartbeat', async () => {
    const engine = engineWith();
    const gate = { verifyBrief: sinon.stub() };
    const out = await composeBrief({ ...base(engine, gate), items: [], candidates: [] });
    expect(engine.openSession.called).to.equal(false);
    expect(gate.verifyBrief.called).to.equal(false);
    expect(out.brief.kind).to.equal('brief');
    expect(out.degraded).to.equal(false);
    expect(out.brief.headline).to.equal('Alerts only: 3 firing across 2 projects, no metric changes to flag');
    expect(out.brief.bullets).to.have.length(1);
    expect(out.brief.bullets[0].kind).to.equal('alerts');
    expect(() => schemas.Brief.parse(out.brief)).to.not.throw();
    const quiet = await composeBrief({ ...base(engine, gate), items: [], candidates: [], alertGroups: [] });
    expect(quiet.brief.kind).to.equal('heartbeat');
  });
});

describe('rollup/brief: one session that recovers instead of restarting (FR-017, revision 23)', () => {
  const { RunDir } = require('../../src/store/run-dir');
  const { tempDir, removeDir } = require('../helpers/fixtures');
  const items = rankItems({
    items: [makeItem(), makeItem({ metric: 'cht_conflict_count', severity: 'low', confidence: 0.4 })],
  });
  const base = () => ({
    discovery: makeDiscovery(), changes: {}, candidates: [makeCandidate()], memory: null, feedbackUnmatched: [],
    expectedLoadNotice: null, referenceSourcesUnavailable: false, footer: footer(),
  });
  const draftWith = (texts, overrides = {}) => draftFor(items, {
    bullets: items.map((item, i) => ({ item_id: item.item_id, text: texts[i] })), ...overrides,
  });
  const rejectedWith = (reasons) => ({
    report: {
      subject: 'brief', subject_ref: 'rollup/draft1', attempt: 1, outcome: 'rejected',
      checks: [{ name: 'numbers_match', status: 'fail', reasons }],
    },
  });

  it('opens one session with no tools, takes one turn per attempt and closes it', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(engine.openSession).to.have.been.calledOnce;
    expect(engine.openSession.firstCall.args[0]).to.include({ model: 'claude-fable-5-1', sessionName: 'rollup' });
    expect(engine.openSession.firstCall.args[0].tools).to.deep.equal([]);
    expect(engine.session.turn).to.have.been.calledOnce;
    expect(engine.session.close).to.have.been.calledOnce;
    expect(engine.singleTurn.called).to.equal(false);
  });

  it('asks the second turn for the failing bullets only and keeps the other bullets from the first draft', async () => {
    const engine = engineWith(
      successResult(draftWith(['first-0 912 vs 300', 'first-1 999 conflicts'], { headline: 'first headline' })),
      successResult(draftWith(['second-0 rewritten', 'second-1 12 conflicts'], { headline: 'second headline' })),
    );
    const gate = { verifyBrief: sinon.stub() };
    gate.verifyBrief.onCall(0).resolves(rejectedWith(['bullets[1] contains 999, which matches no computed value']));
    gate.verifyBrief.onCall(1).resolves(accepted);
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.degraded).to.equal(false);
    const revision = engine.session.turn.secondCall.args[0];
    expect(revision).to.include('bullets[1]').and.include(items[1].item_id).and.include('999');
    expect(revision).to.match(/copy|verbatim/i);
    expect(revision).to.not.include('first-0 912 vs 300');
    const verified = gate.verifyBrief.secondCall.args[0].draft;
    expect(verified.bullets.map((b) => b.text)).to.deep.equal(['first-0 912 vs 300', 'second-1 12 conflicts']);
    expect(verified.headline).to.equal('first headline');
    expect(out.drafts[1].draft).to.deep.equal(verified);
    expect(out.brief.headline).to.equal('first headline');
    expect(out.brief.bullets.map((b) => b.text)).to.deep.equal(['first-0 912 vs 300', 'second-1 12 conflicts']);
  });

  it('takes the new headline when the headline failed, and the whole new draft when no bullet is named', async () => {
    const engine = engineWith(
      successResult(draftWith(['first-0', 'first-1'], { headline: 'first headline' })),
      successResult(draftWith(['second-0', 'second-1'], { headline: 'second headline' })),
    );
    const gate = { verifyBrief: sinon.stub() };
    gate.verifyBrief.onCall(0).resolves(rejectedWith(['headline names partner.other.org']));
    gate.verifyBrief.onCall(1).resolves(accepted);
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.brief.headline).to.equal('second headline');
    expect(out.brief.bullets.map((b) => b.text)).to.deep.equal(['first-0', 'first-1']);

    const whole = engineWith(
      successResult(draftWith(['first-0', 'first-1'])),
      successResult(draftWith(['second-0', 'second-1'])),
    );
    const gate2 = { verifyBrief: sinon.stub() };
    gate2.verifyBrief.onCall(0).resolves(rejectedWith(['draft has 2 bullets but the layout has 3']));
    gate2.verifyBrief.onCall(1).resolves(accepted);
    const out2 = await composeBrief({ ctx: makeCtx({ engine: whole, gate: gate2 }), items, ...base() });
    expect(out2.brief.bullets.map((b) => b.text)).to.deep.equal(['second-0', 'second-1']);
  });

  it('writes the roll-up prompt and its revisions to rollup/prompt.md when given a run directory', async () => {
    const dataDir = tempDir();
    try {
      const runDir = await RunDir.create(dataDir, '2026-09-18');
      const engine = engineWith(successResult(draftFor(items)), successResult(draftFor(items)));
      const gate = { verifyBrief: sinon.stub() };
      gate.verifyBrief.onCall(0).resolves(rejectedWith(['bullets[0] contains 7, which matches no computed value']));
      gate.verifyBrief.onCall(1).resolves(accepted);
      await composeBrief({ ctx: { ...makeCtx({ engine, gate }), runDir }, items, ...base() });
      const prompt = await runDir.readText('rollup/prompt.md');
      expect(prompt.startsWith('ROLLUP TEMPLATE 2026-09-18')).to.equal(true);
      expect(prompt).to.include('# Revision 1').and.include('bullets[0] contains 7');
    } finally {
      removeDir(dataDir);
    }
  });

  it('records the cache counters under either spelling the runtime uses', async () => {
    const spelled = successResult(draftFor(items));
    spelled.result.usage = { input_tokens: 5, output_tokens: 6, cache_read_tokens: 10, cache_creation_tokens: 5 };
    const engine = engineWith(spelled);
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    expect(out.calls[0]).to.include({ cache_read_tokens: 10, cache_creation_tokens: 5, input_tokens: 5 });
    const other = engineWith(successResult(draftFor(items)));
    const out2 = await composeBrief({ ctx: makeCtx({ engine: other, gate }), items, ...base() });
    expect(out2.calls[0]).to.include({ cache_read_tokens: 10, cache_creation_tokens: 0 });
  });

  it('hands the gate the layout and checked texts and each item\'s prompt entry as given text', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base() });
    const call = gate.verifyBrief.firstCall.args[0];
    // The brief's gate sees the run's candidates, so a cited candidate's value counts in a bullet (revision 25).
    expect(call.candidates).to.deep.equal(base().candidates);
    expect(call.givenText.some((text) => text.includes('Computed by code'))).to.equal(true);
    expect(call.givenText.some((text) => text.includes('3 projects'))).to.equal(true);
    expect(call.itemTexts).to.be.instanceOf(Map);
    expect(call.itemTexts.get(items[0].item_id)).to.include('"rank": 1').and.include(items[0].item_id);
    expect(call.itemTexts.get(items[0].item_id)).to.not.include(items[1].item_id);
  });
});

describe('rollup/brief: the incomplete-analysis notice in words, and the analysed count (revision 25)', () => {
  const items = rankItems({ items: [makeItem()] });
  const base = () => ({
    discovery: makeDiscovery(), changes: {}, candidates: [makeCandidate()], memory: '', feedbackUnmatched: [],
    expectedLoadNotice: null, referenceSourcesUnavailable: false, footer: footer(),
  });
  const rejected = (urls, reason) => ({
    projects: 30, failed: [], errors: [], incomplete: [], rejected: urls.map((url) => ({ project_url: url, reason })),
  });

  it('names the rejected hosts and says what the check refused in plain words', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const analysis = rejected(['https://north-a.example.org', 'https://north-b.example.org'], 'personal_data_absent');
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base(), analysis });
    expect(out.brief.notices).to.include('Analysis incomplete: no findings for 2 of 30 projects (north-a.example.org, '
      + 'north-b.example.org): the verification gate refused the model\'s analysis on every attempt, mostly for digits '
      + 'that looked like a phone number');
    expect(out.brief.notices.join(' ')).to.not.include('commonest reason').and.not.include('personal_data_absent');
  });

  it('lists three hosts and counts the rest, and spells an unknown check as itself', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const urls = ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.example.org`);
    const analysis = rejected(urls, 'odd_check');
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base(), analysis });
    const notice = out.brief.notices.find((n) => n.includes('no findings'));
    expect(notice).to.include('5 of 30 projects (a.example.org, b.example.org, c.example.org and 2 more)');
    expect(notice).to.include('mostly for odd_check');
  });

  it('counts the analysed projects in what was checked when told', async () => {
    const engine = engineWith(successResult(draftFor(items)));
    const gate = { verifyBrief: sinon.stub().resolves(accepted) };
    const out = await composeBrief({ ctx: makeCtx({ engine, gate }), items, ...base(), analysedProjects: 2 });
    expect(out.brief.checked).to.deep.equal({ projects: 2, panels: 3, candidates: 1 });
  });
});

const { createWatchdogTools, argsHash } = require('../../../src/agent/tools/watchdog-tools');
const { createReplayLookup } = require('../../../src/agent/tools/replay-shim');
const { createSdkToolServer } = require('../../../src/agent/tools/sdk-server');

const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const discovery = {
  metrics: [
    'cht_sentinel_backlog_count',
    'cht_conflict_count',
    'cht_couchdb_doc_total{db="medic"}',
    'rate(cht_messaging_outgoing_total{status="delivered"}[24h])',
  ],
};
const parse = (out) => JSON.parse(out.content[0].text);

const build = (overrides = {}) => {
  const recorded = [];
  const deps = {
    getWindows: sinon.stub().resolves({
      windows: [{ window: 'current', values: [[1, 2]] }], change: { current_value: 2 },
    }),
    queryWindow: sinon.stub().resolves({ window: 'previous_week', values: [[1, 1]] }),
    itemHistory: sinon.stub().resolves([
      { run_id: '2026-09-17', severity: 'high', feedback: [{ verdict: 'up', author: 'U123' }] },
    ]),
    ...overrides.deps,
  };
  const patternCards = { index: ['sentinel-stall'], read: sinon.stub().callsFake(async (id) => `# ${id}\nsteps`) };
  const tools = createWatchdogTools({
    deps, project, discovery, patternCards, replay: overrides.replay || null, recorder: (c) => recorded.push(c),
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { tools, byName, deps, patternCards, recorded };
};

describe('agent/tools/watchdog-tools', () => {
  it('get_windows accepts a collected metric key, functions and matchers included (revision 19)', async () => {
    const { byName, deps } = build();
    // The key the candidates and the computed changes use, which is what the tool's own schema promises. This
    // exact call was refused in run 2026-09-20 for the metric the model then published.
    const key = 'rate(cht_messaging_outgoing_total{status="delivered"}[24h])';
    expect(parse(await byName.get_windows.handler({ metric: key }))).to.not.have.property('error');
    expect(deps.getWindows).to.have.been.calledWith(project, key);
    // A label matcher, and the same key with the per-project instance matcher the panels carry.
    expect(parse(await byName.get_windows.handler({ metric: 'cht_couchdb_doc_total{db="medic"}' })))
      .to.not.have.property('error');
    const withInstance = 'cht_couchdb_doc_total{instance=~"$cht_instance",db="medic"}';
    expect(parse(await byName.get_windows.handler({ metric: withInstance }))).to.not.have.property('error');
    // A metric the run never collected is still refused, and the refusal still names it.
    const unknown = parse(await byName.get_windows.handler({ metric: 'cht_made_up_total' }));
    expect(unknown.error).to.include('unknown metric');
    // Nothing enormous or multi-line gets through to the lookup.
    expect(parse(await byName.get_windows.handler({ metric: 'a'.repeat(400) })).error).to.include('unknown metric');
    expect(parse(await byName.get_windows.handler({ metric: 'cht_conflict_count\nmore' })).error)
      .to.include('unknown metric');
  });

  it('never echoes an argument in an error, so a URL passed as a name is not seen in a result', async () => {
    const { byName } = build();
    const url = 'https://forum.communityhealthtoolkit.org/t/planted-post-1';
    const answers = [
      parse(await byName.get_windows.handler({ metric: url })),
      parse(await byName.query_metric.handler({ metric: url, window: 'current' })),
      parse(await byName.query_metric.handler({ metric: 'cht_conflict_count', window: url })),
      parse(await byName.read_pattern_card.handler({ card_id: url })),
    ];
    for (const answer of answers) {
      expect(answer.error).to.be.a('string');
      expect(JSON.stringify(answer)).to.not.include('planted-post');
      expect(JSON.stringify(answer)).to.not.include('https://');
    }
    expect(answers[2].error).to.include('expected one of current, previous_day');
  });

  it('query_metric still takes a bare metric name, which is what it queries with', async () => {
    const { byName } = build();
    const expression = parse(await byName.query_metric.handler({
      metric: 'rate(cht_messaging_outgoing_total{status="delivered"}[24h])', window: 'current',
    }));
    expect(expression.error).to.include('unknown metric');
    expect(parse(await byName.query_metric.handler({ metric: 'cht_conflict_count', window: 'previous_week' })))
      .to.not.have.property('error');
  });

  it('exposes exactly the four enumerated read-only tools with zod shapes and descriptions', () => {
    const { tools } = build();
    expect(tools.map((t) => t.name).sort())
      .to.deep.equal(['get_item_history', 'get_windows', 'query_metric', 'read_pattern_card']);
    for (const tool of tools) {
      expect(tool.description).to.be.a('string').with.length.greaterThan(10);
      expect(tool.schema).to.be.an('object');
      expect(tool.handler).to.be.a('function');
    }
  });

  it('get_windows returns collected windows and the computed change, and records the call', async () => {
    const { byName, deps, recorded } = build();
    const out = parse(await byName.get_windows.handler({ metric: 'cht_sentinel_backlog_count' }));
    expect(out.change.current_value).to.equal(2);
    expect(deps.getWindows).to.have.been.calledWith(project, 'cht_sentinel_backlog_count');
    expect(recorded[0]).to.include({ tool: 'get_windows' });
    expect(recorded[0].args).to.deep.equal({ metric: 'cht_sentinel_backlog_count' });
  });

  it('query_metric accepts only known metrics and the five windows, and caps calls at 20 per session', async () => {
    const { byName, deps } = build();
    const bad = parse(await byName.query_metric.handler({ metric: 'rate(anything{job="x"}[5m])', window: 'current' }));
    expect(bad.error).to.match(/unknown metric/);
    expect(deps.queryWindow).to.not.have.been.called;
    const badWindow = parse(await byName.query_metric.handler({ metric: 'cht_conflict_count', window: 'last_month' }));
    expect(badWindow.error).to.match(/window/);
    for (let i = 0; i < 20; i += 1) {
      const ok = parse(await byName.query_metric.handler({ metric: 'cht_conflict_count', window: 'previous_week' }));
      expect(ok.window).to.equal('previous_week');
    }
    expect(deps.queryWindow).to.have.callCount(20);
    expect(deps.queryWindow.firstCall.args).to.deep.equal([project, 'cht_conflict_count', 'previous_week']);
    const capped = parse(await byName.query_metric.handler({ metric: 'cht_conflict_count', window: 'previous_week' }));
    expect(capped.error).to.match(/cap/);
    expect(deps.queryWindow).to.have.callCount(20);
  });

  it('query_metric also accepts the base metric names even when discovery lists none', async () => {
    const { byName, deps } = build();
    const tools = createWatchdogTools({
      deps, project, discovery: {}, patternCards: { index: [], read: async () => '' }, recorder: () => {},
    });
    const query = tools.find((t) => t.name === 'query_metric');
    const ok = parse(await query.handler({ metric: 'cht_outbound_push_backlog_count', window: 'current' }));
    expect(ok.error).to.equal(undefined);
    expect(byName).to.be.an('object');
  });

  it('read_pattern_card serves only ids from the merged index', async () => {
    const { byName, patternCards } = build();
    const ok = parse(await byName.read_pattern_card.handler({ card_id: 'sentinel-stall' }));
    expect(ok.card_id).to.equal('sentinel-stall');
    expect(ok.text).to.include('steps');
    const missing = parse(await byName.read_pattern_card.handler({ card_id: '../../etc/passwd' }));
    expect(missing.error).to.match(/unknown card/);
    expect(patternCards.read).to.have.been.calledOnce;
  });

  it('get_item_history replaces author identifiers with a role label', async () => {
    const { byName, deps } = build();
    const args = { metric: 'cht_sentinel_backlog_count', pattern_card: null };
    const out = parse(await byName.get_item_history.handler(args));
    expect(deps.itemHistory).to.have.been.calledWith('https://alpha.example.org', 'cht_sentinel_backlog_count', null);
    expect(JSON.stringify(out)).to.not.include('U123');
    expect(out.history[0].feedback[0].author).to.equal('a reviewer');
  });

  it('answers from recordings in replay mode and marks unrecorded queries unavailable', async () => {
    const records = [
      { tool: 'get_windows', args: { metric: 'cht_sentinel_backlog_count' }, result: { recorded: true } },
    ];
    const replay = createReplayLookup(records);
    const { byName, deps } = build({ replay });
    const hit = parse(await byName.get_windows.handler({ metric: 'cht_sentinel_backlog_count' }));
    expect(hit).to.deep.equal({ recorded: true });
    const miss = parse(await byName.get_windows.handler({ metric: 'cht_conflict_count' }));
    expect(miss).to.deep.equal({ unavailable: true, reason: 'not recorded' });
    expect(deps.getWindows).to.not.have.been.called;
  });

  it('hashes arguments stably regardless of key order', () => {
    expect(argsHash({ a: 1, b: 2 })).to.equal(argsHash({ b: 2, a: 1 }));
    expect(argsHash({ a: 1 })).to.not.equal(argsHash({ a: 2 }));
  });

  it('builds an in-process SDK server from the tool definitions', () => {
    const { tools } = build();
    const sdk = {
      tool: sinon.stub().callsFake((name, description, schema, handler) => ({ name, description, schema, handler })),
      createSdkMcpServer: sinon.stub().callsFake((options) => ({ type: 'sdk', ...options })),
    };
    const server = createSdkToolServer(sdk, tools);
    expect(server.name).to.equal('watchdog');
    expect(sdk.tool).to.have.callCount(4);
    expect(server.tools.map((t) => t.name)).to.include('get_windows');
  });
});

describe('agent/tools/watchdog-tools: a loose key is resolved to the collected one (revision 34)', () => {
  it('looks a base name or a stripped key up as the collected key, and refuses an ambiguous one', async () => {
    const { byName, deps } = build();
    const full = 'rate(cht_messaging_outgoing_total{status="delivered"}[24h])';
    expect(parse(await byName.get_windows.handler({ metric: 'cht_messaging_outgoing_total' })))
      .to.not.have.property('error');
    expect(deps.getWindows).to.have.been.calledWith(project, full);
    const withInstance = 'cht_couchdb_doc_total{instance=~"$cht_instance",db="medic"}';
    expect(parse(await byName.get_windows.handler({ metric: withInstance }))).to.not.have.property('error');
    expect(deps.getWindows).to.have.been.calledWith(project, 'cht_couchdb_doc_total{db="medic"}');
    const twoKeys = {
      metrics: ['sum(cht_feedback_total)', 'rate(cht_feedback_total[1d])'],
    };
    const tools = createWatchdogTools({
      deps, project, discovery: twoKeys, patternCards: { index: [], read: async () => '' }, recorder: () => {},
    });
    const windows = tools.find((t) => t.name === 'get_windows');
    const ambiguous = parse(await windows.handler({ metric: 'cht_feedback_total' }));
    expect(ambiguous.error).to.include('ambiguous metric');
    expect(ambiguous.error).to.include('sum(cht_feedback_total)');
    expect(ambiguous.error).to.include('rate(cht_feedback_total[1d])');
    expect(parse(await windows.handler({ metric: 'sum(cht_feedback_total)' }))).to.not.have.property('error');
  });
});

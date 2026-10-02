const { buildHooks, RUNTIME_TOOLS } = require('../../agent/hooks');

describe('agent/hooks', () => {
  const allowed = ['mcp__cht-docs__search_docs', 'mcp__watchdog__get_windows'];

  it('exposes PreToolUse, PostToolUse and Stop hook matchers in the SDK shape', () => {
    const hooks = buildHooks({ allowed, recorder: () => {} });
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) {
      expect(hooks[event]).to.be.an('array').with.length(1);
      expect(hooks[event][0].hooks[0]).to.be.a('function');
    }
  });

  it('denies any tool not on the allow-list and approves listed ones', async () => {
    const hooks = buildHooks({ allowed, recorder: () => {} });
    const pre = hooks.PreToolUse[0].hooks[0];
    const denied = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, 't1', {});
    expect(denied.decision).to.equal('block');
    expect(denied.reason).to.include('Bash');
    const input = { hook_event_name: 'PreToolUse', tool_name: 'mcp__watchdog__get_windows', tool_input: {} };
    const ok = await pre(input, 't2', {});
    expect(ok.decision).to.equal('approve');
  });

  it('approves the runtime\'s StructuredOutput tool without listing it and never records it', async () => {
    const recorder = sinon.spy();
    const logger = { warn: sinon.spy() };
    const hooks = buildHooks({ allowed: ['mcp__watchdog__get_windows'], recorder, logger });
    const pre = hooks.PreToolUse[0].hooks[0];
    expect(await pre({ tool_name: 'StructuredOutput', tool_input: { items: [] } }))
      .to.deep.equal({ decision: 'approve' });
    expect(logger.warn.called).to.equal(false);
    const post = hooks.PostToolUse[0].hooks[0];
    await post({ tool_name: 'StructuredOutput', tool_input: { items: [] }, tool_response: 'ok' });
    expect(recorder.called, 'the findings hand-off is not a tool call worth replaying').to.equal(false);
    await post({ tool_name: 'mcp__watchdog__get_windows', tool_input: {}, tool_response: 'x' });
    expect(recorder.calledOnce).to.equal(true);
    expect(RUNTIME_TOOLS).to.deep.equal(['StructuredOutput']);
  });

  it('records every tool result and never blocks on PostToolUse', async () => {
    const recorded = [];
    const hooks = buildHooks({ allowed, recorder: (call) => recorded.push(call) });
    const post = hooks.PostToolUse[0].hooks[0];
    const call = { tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'm' }, tool_response: { a: 1 } };
    const out = await post(call, 't3', {});
    expect(out).to.deep.equal({});
    expect(recorded).to.deep.equal([call]);
  });

  it('runs the gate on Stop and blocks with the reasons when it fails', async () => {
    const gate = sinon.stub().resolves({ ok: false, reasons: ['bullet_count: 4 bullets'] });
    const hooks = buildHooks({ allowed, recorder: () => {}, gate });
    const stop = hooks.Stop[0].hooks[0];
    const out = await stop({ hook_event_name: 'Stop', last_assistant_message: '{"items":[]}' }, undefined, {});
    expect(gate).to.have.been.calledWith('{"items":[]}');
    expect(out.decision).to.equal('block');
    expect(out.reason).to.include('bullet_count');
    const okGate = sinon.stub().resolves({ ok: true, reasons: [] });
    const pass = buildHooks({ allowed, recorder: () => {}, gate: okGate }).Stop[0].hooks[0];
    expect(await pass({ last_assistant_message: 'x' }, undefined, {})).to.deep.equal({});
  });
});

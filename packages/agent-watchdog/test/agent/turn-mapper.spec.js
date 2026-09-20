const { createTurnMapper } = require('../../src/agent/turn-mapper');

const init = (servers = [{ name: 'cht-docs', status: 'connected' }]) => ({
  type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: servers,
});
const result = (extra = {}) => ({
  type: 'result', subtype: 'success', total_cost_usd: 0.02, num_turns: 3, duration_ms: 1500,
  structured_output: { a: 1 }, session_id: 'sess-1', stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
  permission_denials: [], errors: [], ...extra,
});
const toolUse = (id, name, input) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, content, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});

describe('agent/turn-mapper', () => {
  it('records the session id at init and completes a turn only on its result message', () => {
    const mapper = createTurnMapper();
    expect(mapper.handle(init())).to.equal(null);
    expect(mapper.sessionId).to.equal('sess-1');
    expect(mapper.handle(result())).to.equal(null);
    mapper.beginTurn();
    expect(mapper.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).to.equal(null);
    const turn = mapper.handle(result());
    expect(turn.structuredOutput).to.deep.equal({ a: 1 });
    expect(turn.result).to.deep.equal({
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 50, cache_creation_tokens: 5 },
      total_cost_usd: 0.02,
      cumulative_cost_usd: 0.02,
      num_turns: 3,
      duration_ms: 1500,
      session_id: 'sess-1',
      permission_denials: [],
      errors: [],
      stop_reason: 'end_turn',
      is_error: false,
      result_text: null,
    });
    expect(turn.toolCalls).to.deep.equal([]);
    expect(turn.referenceUnavailable).to.equal(false);
    expect(mapper.handle(result())).to.equal(null);
  });

  it('reports the per-turn cost as the delta of the cumulative total the runtime sends', () => {
    const mapper = createTurnMapper();
    mapper.handle(init());
    mapper.beginTurn();
    const first = mapper.handle(result({ total_cost_usd: 0.02 }));
    mapper.beginTurn();
    const second = mapper.handle(result({ total_cost_usd: 0.05 }));
    mapper.beginTurn();
    const third = mapper.handle(result({ total_cost_usd: 0.05 }));
    expect(first.result.total_cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(second.result.total_cost_usd).to.be.closeTo(0.03, 1e-9);
    expect(second.result.cumulative_cost_usd).to.be.closeTo(0.05, 1e-9);
    expect(third.result.total_cost_usd).to.equal(0);
    expect(third.result.cumulative_cost_usd).to.be.closeTo(0.05, 1e-9);
  });

  it('collects tool calls from tool_use and tool_result pairs and flags documentation failures', () => {
    const mapper = createTurnMapper();
    mapper.handle(init());
    mapper.beginTurn();
    mapper.handle(toolUse('tu1', 'mcp__cht-docs__search_docs', { query: 'sentinel' }));
    mapper.handle(toolResult('tu1', 'connection refused', true));
    mapper.handle(toolUse('tu2', 'mcp__watchdog__get_windows', { metric: 'm' }));
    mapper.handle(toolResult('tu2', [{ type: 'text', text: '{"ok":true}' }]));
    expect(mapper.assistantTurns).to.equal(2);
    const turn = mapper.handle(result());
    expect(turn.toolCalls).to.deep.equal([
      {
        tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel' }, tool_response: 'connection refused',
      },
      { tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'm' }, tool_response: '{"ok":true}' },
    ]);
    expect(turn.referenceUnavailable).to.equal(true);
  });

  it('flags a documentation server that failed at init and a denied documentation tool', () => {
    const failed = createTurnMapper();
    failed.handle(init([{ name: 'cht-docs', status: 'failed' }]));
    failed.beginTurn();
    expect(failed.initUnavailable).to.equal(true);
    expect(failed.handle(result()).referenceUnavailable).to.equal(true);
    const denied = createTurnMapper();
    denied.handle(init());
    denied.beginTurn();
    const turn = denied.handle(result({ permission_denials: [{ tool_name: 'mcp__cht-docs__search_docs' }] }));
    expect(turn.referenceUnavailable).to.equal(true);
    expect(turn.result.permission_denials).to.have.length(1);
  });

  it('maps error subtypes and exposes the runtime errors', () => {
    const mapper = createTurnMapper();
    mapper.beginTurn();
    const turn = mapper.handle(result({
      subtype: 'error_max_budget_usd', errors: ['budget exceeded'], structured_output: undefined,
    }));
    expect(turn.result.subtype).to.equal('error_max_budget_usd');
    expect(turn.result.errors).to.deep.equal(['budget exceeded']);
    expect(turn.structuredOutput).to.equal(null);
  });

  it('exposes a result the runtime marks as an error with its text, as the CLI reports a bad model (revision 17)',
    () => {
      const mapper = createTurnMapper();
      mapper.beginTurn();
      const text = "There's an issue with the selected model (claude-opus-4.8). It may not exist or you may not have "
        + 'access to it. Run --model to pick a different model.';
      const turn = mapper.handle(result({
        subtype: 'success', is_error: true, result: text, structured_output: undefined, total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      }));
      expect(turn.structuredOutput).to.equal(null);
      expect(turn.result).to.include({ subtype: 'success', is_error: true, result_text: text, total_cost_usd: 0 });
      // The text is capped so a runaway runtime message cannot flood the pass record.
      mapper.beginTurn();
      const long = mapper.handle(result({ is_error: true, result: 'x'.repeat(2000) }));
      expect(long.result.result_text).to.have.length(500);
    });

  it('counts assistant messages in the current turn and synthesises a capped result with the calls so far', () => {
    const mapper = createTurnMapper();
    mapper.handle(init());
    mapper.beginTurn();
    mapper.handle(result({ total_cost_usd: 0.04 }));
    mapper.beginTurn();
    mapper.handle(toolUse('tu1', 'mcp__watchdog__get_windows', { metric: 'm' }));
    mapper.handle(toolResult('tu1', 'x'));
    mapper.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'still thinking' }] } });
    expect(mapper.assistantTurns).to.equal(2);
    const capped = mapper.synthesizeResult({
      subtype: 'error_max_turns', errors: ['harness turn cap reached'], durationMs: 12,
    });
    expect(capped.structuredOutput).to.equal(null);
    expect(capped.result).to.deep.equal({
      subtype: 'error_max_turns',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      total_cost_usd: 0,
      cumulative_cost_usd: 0.04,
      num_turns: 2,
      duration_ms: 12,
      session_id: 'sess-1',
      permission_denials: [],
      errors: ['harness turn cap reached'],
      stop_reason: null,
      is_error: false,
      result_text: null,
    });
    expect(capped.toolCalls).to.have.length(1);
    expect(mapper.assistantTurns).to.equal(0);
  });
});

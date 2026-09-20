const { forStructuredOutput } = require('../../src/agent/output-schema');
const { createSdkEngine } = require('../../src/agent/engine-sdk');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { createLogger } = require('../../src/log/logger');
const { Writable } = require('node:stream');

const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp', AGENT_WATCHDOG_DOCS_MCP_TOKEN: 't' };
const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
  cb(); 
} }) });
const config = {
  model: { name: 'claude-fable-5-1', effort: 'max' },
  bounds: { maxTurns: 20, maxBudgetUsdProject: 2, modelTimeoutMs: 5000 },
  runtime: { mcpTimeoutMs: 30000 },
};
const mcpConfig = definition.renderMcpConfig(env);
const CONNECTED = [{ name: 'cht-docs', status: 'connected' }];

// A scripted fake of the SDK module: query() consumes the streaming prompt and, for each user message,
// emits the scripted messages for that turn followed by a result message.
const fakeSdk = (script) => {
  const captured = { options: null, prompts: [], servers: [] };
  const init = { type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: script.mcpServers || CONNECTED };
  const query = ({ prompt, options }) => {
    captured.options = options;
    return (async function* messages() {
      yield init;
      let index = 0;
      for await (const userMessage of prompt) {
        captured.prompts.push(userMessage);
        const turn = script.turns[index] || script.turns[script.turns.length - 1];
        index += 1;
        for (const message of turn.messages || []) {
          yield message;
        }
        yield { type: 'result', session_id: 'sess-1', ...turn.result };
      }
    }());
  };
  const sdk = {
    query,
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (options) => {
      captured.servers.push(options);
      return { type: 'sdk', name: options.name, instance: {} };
    },
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  };
  return { sdk, captured };
};

const success = (structured) => ({
  subtype: 'success', total_cost_usd: 0.02, num_turns: 3, duration_ms: 1500, structured_output: structured,
  usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
  permission_denials: [], errors: [],
});

const makeEngine = (sdk, engineEnv = {}) => createSdkEngine({
  config, definition, mcpConfig, sdkLoader: async () => sdk, env: engineEnv, logger,
});

const bareSession = (engine, overrides = {}) => engine.openSession({
  systemPrompt: ['p'], outputSchema: {}, tools: [], localTools: [], mcpConfig,
  bounds: { maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 5000 }, model: 'm', effort: 'low', ...overrides,
});

describe('agent/engine-sdk', () => {
  const localTools = [{ name: 'get_windows', description: 'd', schema: {}, handler: async () => ({ content: [] }) }];

  it('opens an isolated session with the verified options and streams turns through one query', async () => {
    const { sdk, captured } = fakeSdk({ turns: [{ result: success({ a: 1 }) }, { result: success({ a: 2 }) }] });
    const engine = makeEngine(sdk, { PATH: '/bin' });
    const session = await engine.openSession({
      systemPrompt: ['prefix', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'suffix'],
      outputSchema: definition.outputSchemas.findings,
      tools: definition.tools.allowed,
      localTools,
      mcpConfig,
      bounds: { maxTurns: 7, maxBudgetUsd: 1.5, timeoutMs: 5000 },
      model: 'claude-fable-5-1',
      effort: 'max',
      sessionName: 'alpha',
    });
    const first = await session.turn('first prompt');
    const second = await session.turn('second prompt');
    await session.close();
    const o = captured.options;
    expect(o.settingSources).to.deep.equal([]);
    expect(o.tools).to.deep.equal([]);
    expect(o.allowedTools).to.deep.equal(definition.tools.allowed);
    expect(o.permissionMode).to.equal('dontAsk');
    expect(o.strictMcpConfig).to.equal(true);
    expect(o.persistSession).to.equal(false);
    expect(o.outputFormat).to.deep.equal({
      type: 'json_schema', schema: forStructuredOutput(definition.outputSchemas.findings),
    });
    expect(o.outputFormat.schema.$schema, 'the runtime refuses the 2020-12 dialect (S-4)').to.equal(undefined);
    expect(o.maxTurns).to.equal(7);
    expect(o.maxBudgetUsd).to.equal(1.5);
    expect(o.model).to.equal('claude-fable-5-1');
    expect(o.effort).to.equal('max');
    expect(o.systemPrompt).to.deep.equal(['prefix', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'suffix']);
    expect(o.mcpServers['cht-docs']).to.include({ type: 'http', url: 'https://docs-mcp.example.org/mcp' });
    expect(o.mcpServers.watchdog.type).to.equal('sdk');
    expect(captured.servers[0].tools[0].name).to.equal('get_windows');
    expect(o.hooks.PreToolUse).to.be.an('array');
    expect(o.env.PATH).to.equal('/bin');
    expect(o.env.CLAUDE_CONFIG_DIR).to.be.a('string');
    expect(o.env).to.include({
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(o.abortController).to.be.instanceOf(AbortController);
    expect(captured.prompts.map((p) => p.message.content)).to.deep.equal(['first prompt', 'second prompt']);
    expect(captured.prompts[0]).to.include({ type: 'user', parent_tool_use_id: null });
    expect(first.structuredOutput).to.deep.equal({ a: 1 });
    expect(second.structuredOutput).to.deep.equal({ a: 2 });
    expect(first.result).to.include({ subtype: 'success', total_cost_usd: 0.02, num_turns: 3, session_id: 'sess-1' });
    expect(first.result.usage).to.deep.equal({
      input_tokens: 100, output_tokens: 10, cache_read_tokens: 50, cache_creation_tokens: 5,
    });
    expect(first.referenceUnavailable).to.equal(false);
  });

  it('collects tool calls from the message stream and flags cht-docs failures', async () => {
    const toolUse = (id, name, input) => ({
      type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const toolResult = (id, content, isError = false) => ({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
    });
    const messages = [
      toolUse('tu1', 'mcp__cht-docs__search_docs', { query: 'sentinel' }),
      toolResult('tu1', 'connection refused', true),
      toolUse('tu2', 'mcp__watchdog__get_windows', { metric: 'm' }),
      toolResult('tu2', [{ type: 'text', text: '{"ok":true}' }]),
    ];
    const { sdk } = fakeSdk({ turns: [{ messages, result: success(null) }] });
    const session = await bareSession(makeEngine(sdk));
    const turn = await session.turn('x');
    await session.close();
    expect(turn.toolCalls).to.have.length(2);
    expect(turn.toolCalls[0]).to.include({ tool_name: 'mcp__cht-docs__search_docs' });
    expect(turn.toolCalls[0].tool_response).to.equal('connection refused');
    expect(turn.toolCalls[1].tool_response).to.equal('{"ok":true}');
    expect(turn.referenceUnavailable).to.equal(true);
  });

  it('flags a failed cht-docs MCP server at init and a permission denial for a cht-docs tool', async () => {
    const failed = fakeSdk({
      mcpServers: [{ name: 'cht-docs', status: 'failed' }], turns: [{ result: success(null) }],
    });
    const s1 = await bareSession(makeEngine(failed.sdk));
    expect((await s1.turn('x')).referenceUnavailable).to.equal(true);
    await s1.close();
    const denial = { ...success(null), permission_denials: [{ tool_name: 'mcp__cht-docs__search_docs' }] };
    const denied = fakeSdk({ turns: [{ result: denial }] });
    const s2 = await bareSession(makeEngine(denied.sdk));
    expect((await s2.turn('x')).referenceUnavailable).to.equal(true);
    await s2.close();
  });

  it('maps error subtypes and exposes errors', async () => {
    const result = { ...success(null), subtype: 'error_max_budget_usd', errors: ['budget exceeded'] };
    const { sdk } = fakeSdk({ turns: [{ result }] });
    const session = await bareSession(makeEngine(sdk));
    const turn = await session.turn('x');
    await session.close();
    expect(turn.result.subtype).to.equal('error_max_budget_usd');
    expect(turn.result.errors).to.deep.equal(['budget exceeded']);
  });

  it('runs a single turn without tools for the roll-up', async () => {
    const { sdk, captured } = fakeSdk({ turns: [{ result: success({ headline: 'h' }) }] });
    const turn = await makeEngine(sdk).singleTurn({
      systemPrompt: ['p'], userPrompt: 'write the brief', outputSchema: definition.outputSchemas.brief,
      bounds: { maxTurns: 3, maxBudgetUsd: 0.5, timeoutMs: 5000 }, model: 'm', effort: 'high', name: 'rollup',
    });
    expect(turn.structuredOutput).to.deep.equal({ headline: 'h' });
    expect(captured.options.allowedTools).to.deep.equal([]);
    expect(captured.options.mcpServers).to.deep.equal({});
    expect(captured.options.maxTurns).to.equal(3);
    expect(captured.prompts[0].message.content).to.equal('write the brief');
  });

  it('aborts a turn that exceeds the timeout', async () => {
    const sdk = {
      query: ({ options }) => (async function* hang() {
        yield { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] };
        await new Promise((resolve) => {
          options.abortController.signal.addEventListener('abort', resolve);
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }()),
      tool: () => ({}),
      createSdkMcpServer: () => ({ type: 'sdk' }),
    };
    const session = await bareSession(makeEngine(sdk), { bounds: { maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 20 } });
    await expect(session.turn('x')).to.be.rejectedWith(/timed out/);
    await session.close();
  });

  it('attaches extra in-process servers from localServers and replaces the remote docs server', async () => {
    const { sdk, captured } = fakeSdk({ turns: [{ result: success({ a: 1 }) }] });
    const docsTools = [{ name: 'search_docs', description: 'd', schema: {}, handler: async () => ({ content: [] }) }];
    const session = await bareSession(makeEngine(sdk), {
      tools: definition.tools.allowed, localTools, localServers: { 'cht-docs': docsTools },
    });
    await session.turn('x');
    await session.close();
    const o = captured.options;
    expect(o.mcpServers['cht-docs']).to.include({ type: 'sdk', name: 'cht-docs' });
    expect(o.mcpServers.watchdog).to.include({ type: 'sdk', name: 'watchdog' });
    expect(captured.servers.map((s) => s.name).sort()).to.deep.equal(['cht-docs', 'watchdog']);
    expect(captured.servers.find((s) => s.name === 'cht-docs').tools[0].name).to.equal('search_docs');
  });

  it('exposes cumulative cost and reports each turn cost as a delta', async () => {
    const { sdk } = fakeSdk({ turns: [
      { result: success({ a: 1 }) }, { result: { ...success({ a: 2 }), total_cost_usd: 0.05 } },
    ] });
    const session = await bareSession(makeEngine(sdk));
    const first = await session.turn('x');
    const second = await session.turn('y');
    await session.close();
    expect(first.result.total_cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(first.result.cumulative_cost_usd).to.be.closeTo(0.02, 1e-9);
    expect(second.result.total_cost_usd).to.be.closeTo(0.03, 1e-9);
    expect(second.result.cumulative_cost_usd).to.be.closeTo(0.05, 1e-9);
  });
});

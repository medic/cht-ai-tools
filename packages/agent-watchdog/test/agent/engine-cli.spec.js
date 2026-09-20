// The `claude` command-line engine against a fake executable (test/helpers/fake-claude.js): argument contract,
// stdin turns, tool-call recording, harness bounds and mapping parity with the SDK engine.
const { forStructuredOutput } = require('../../src/agent/output-schema');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createCliEngine } = require('../../src/agent/engine-cli');
const { createSdkEngine } = require('../../src/agent/engine-sdk');
const { runProjectSession } = require('../../src/agent/session-loop');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir } = require('../../src/store/run-dir');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');

const FAKE = path.join(__dirname, '..', 'helpers', 'fake-claude.js');
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'agent-watchdog.js');
const TOKEN = 'secret-token-123';
const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp', AGENT_WATCHDOG_DOCS_MCP_TOKEN: TOKEN };
const definition = loadDefinition({ paths: PACKAGE_PATHS, env });
const mcpConfig = definition.renderMcpConfig(env);
const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
  cb(); 
} }) });
const localTools = [{ name: 'get_windows', description: 'd', schema: {}, handler: async () => ({ content: [] }) }];

const success = (structured, extra = {}) => ({
  subtype: 'success', total_cost_usd: 0.02, num_turns: 3, duration_ms: 1500, structured_output: structured,
  usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
  permission_denials: [], errors: [], stop_reason: 'end_turn', ...extra,
});
const toolUse = (id, name, input) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, content, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});

/** The fake's JSONL record folded into one { argv, stdin_lines } per process start. */
const readRecord = (file) => {
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.event === 'start') {
      records.push({ argv: event.argv, stdin_lines: [] });
    } else {
      records[records.length - 1].stdin_lines.push(event.line);
    }
  }
  return records;
};

describe('agent/engine-cli', function () {
  this.timeout(15000);
  let dataDir;
  let runDir;
  let recordFile;
  let scenarioFile;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    recordFile = path.join(dataDir, 'fake-claude.jsonl');
    scenarioFile = path.join(dataDir, 'scenario.json');
  });
  afterEach(() => removeDir(dataDir));

  const config = () => ({
    model: { name: 'claude-fable-5-1', effort: 'max' },
    bounds: { maxTurns: 20, maxBudgetUsdProject: 2, modelTimeoutMs: 5000 },
    storage: { dataDir },
    runtime: {},
  });
  const writeScenario = (scenario) => fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const fakeEnv = (extra = {}) => ({
    PATH: process.env.PATH, FAKE_CLAUDE_RECORD: recordFile, FAKE_CLAUDE_SCENARIO: scenarioFile, ...extra,
  });
  const makeEngine = (overrides = {}) => createCliEngine({
    config: config(), definition, mcpConfig, env: fakeEnv(overrides.env), logger, runDir, claudePath: FAKE,
    ...overrides.engine,
  });
  const bounds = (extra = {}) => ({ maxTurns: 7, maxBudgetUsd: 1.5, timeoutMs: 5000, ...extra });
  const openWithTools = (engine, extra = {}) => engine.openSession({
    systemPrompt: ['prefix', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'suffix'],
    outputSchema: definition.outputSchemas.findings,
    tools: definition.tools.allowed,
    localTools,
    mcpConfig,
    bounds: bounds(),
    model: 'claude-fable-5-1',
    effort: 'max',
    sessionName: 'alpha-example-org',
    ...extra,
  });

  it('spawns claude with the verified print-mode arguments, private MCP config and a redacted copy', async () => {
    writeScenario({ session_id: 'sess-1', turns: [{ result: success({ a: 1 }) }] });
    const engine = makeEngine();
    expect(engine.name).to.equal('cli');
    const session = await openWithTools(engine);
    const turn = await session.turn('first prompt');
    const [record] = readRecord(recordFile);
    const promptFile = runDir.path('agent', 'system-prompt.alpha-example-org.md');
    const mcpFile = record.argv[record.argv.indexOf('--mcp-config') + 1];
    expect(record.argv).to.deep.equal([
      '-p', '--bare', '--verbose', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--system-prompt-file', promptFile,
      '--tools', '',
      '--allowed-tools', ...definition.tools.allowed,
      '--permission-mode', 'dontAsk',
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--json-schema', JSON.stringify(forStructuredOutput(definition.outputSchemas.findings)),
      '--model', 'claude-fable-5-1', '--effort', 'max', '--max-budget-usd', '1.5',
    ]);
    expect(fs.readFileSync(promptFile, 'utf8')).to.equal('prefix\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nsuffix');
    expect(path.dirname(mcpFile)).to.not.include(runDir.root);
    expect(fs.statSync(mcpFile).mode.toString(8).slice(-3)).to.equal('600');
    const real = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    expect(real.mcpServers['cht-docs']).to.include({ type: 'http', url: 'https://docs-mcp.example.org/mcp' });
    expect(real.mcpServers['cht-docs'].headers.Authorization).to.equal(`Bearer ${TOKEN}`);
    expect(real.mcpServers.watchdog).to.deep.equal({
      type: 'stdio',
      command: process.execPath,
      args: [BIN, 'tools-server', '--run-dir', runDir.root, '--data-dir', dataDir, '--project', 'alpha-example-org'],
    });
    const redactedFile = runDir.path('agent', 'mcp.alpha-example-org.json');
    const redactedText = fs.readFileSync(redactedFile, 'utf8');
    expect(redactedText).to.not.include(TOKEN);
    expect(JSON.parse(redactedText).mcpServers['cht-docs'].headers.Authorization).to.equal('Bearer [redacted]');
    expect(record.stdin_lines).to.deep.equal([
      { type: 'user', message: { role: 'user', content: 'first prompt' }, parent_tool_use_id: null },
    ]);
    expect(turn.structuredOutput).to.deep.equal({ a: 1 });
    expect(turn.result).to.include({ subtype: 'success', total_cost_usd: 0.02, num_turns: 3, session_id: 'sess-1' });
    expect(session.sessionId).to.equal('sess-1');
    await session.close();
    expect(fs.existsSync(mcpFile)).to.equal(false);
  });

  it('feeds later turns over the same stdin after each result and reports per-turn cost deltas', async () => {
    writeScenario({ turns: [
      { result: success({ a: 1 }, { total_cost_usd: 0.02 }) },
      { result: success({ a: 2 }, { total_cost_usd: 0.05 }) },
    ] });
    const session = await openWithTools(makeEngine());
    const first = await session.turn('first prompt');
    const second = await session.turn('second prompt');
    await session.close();
    expect(first.structuredOutput).to.deep.equal({ a: 1 });
    expect(second.structuredOutput).to.deep.equal({ a: 2 });
    expect(second.result.total_cost_usd).to.be.closeTo(0.03, 1e-9);
    expect(second.result.cumulative_cost_usd).to.be.closeTo(0.05, 1e-9);
    const [record] = readRecord(recordFile);
    expect(record.stdin_lines.map((l) => l.message.content)).to.deep.equal(['first prompt', 'second prompt']);
    expect(readRecord(recordFile)).to.have.length(1);
  });

  it('runs a single turn without tools: no --allowed-tools, no --mcp-config, built-ins still disabled', async () => {
    writeScenario({ turns: [{ result: success({ headline: 'h' }) }] });
    const turn = await makeEngine().singleTurn({
      systemPrompt: ['p'], userPrompt: 'write the brief', outputSchema: definition.outputSchemas.brief,
      bounds: { maxTurns: 3, maxBudgetUsd: 0.5, timeoutMs: 5000 }, model: 'm', effort: 'high', name: 'rollup',
    });
    expect(turn.structuredOutput).to.deep.equal({ headline: 'h' });
    const [record] = readRecord(recordFile);
    expect(record.argv).to.not.include('--allowed-tools');
    expect(record.argv).to.not.include('--mcp-config');
    expect(record.argv).to.include('--strict-mcp-config');
    const toolsAt = record.argv.indexOf('--tools');
    expect(record.argv.slice(toolsAt, toolsAt + 2)).to.deep.equal(['--tools', '']);
    expect(record.argv[record.argv.indexOf('--json-schema') + 1])
      .to.equal(JSON.stringify(forStructuredOutput(definition.outputSchemas.brief)));
    expect(record.argv.slice(-6)).to.deep.equal(['--model', 'm', '--effort', 'high', '--max-budget-usd', '0.5']);
    expect(record.argv[record.argv.indexOf('--system-prompt-file') + 1])
      .to.equal(runDir.path('agent', 'system-prompt.rollup.md'));
    expect(record.stdin_lines[0].message.content).to.equal('write the brief');
    expect(fs.existsSync(runDir.path('agent', 'mcp.rollup.json'))).to.equal(false);
  });

  it('collects tool calls from the event stream and the session loop records them to tool-calls.jsonl', async () => {
    const messages = [
      toolUse('tu1', 'mcp__cht-docs__search_docs', { query: 'sentinel' }),
      toolResult('tu1', 'connection refused', true),
      toolUse('tu2', 'mcp__watchdog__get_windows', { metric: 'm' }),
      toolResult('tu2', [{ type: 'text', text: '{"ok":true}' }]),
    ];
    const findings = {
      project_url: 'https://alpha.example.org', pass: 1, items: [], not_selected: [], changes: [], converged: true,
      notes: '',
    };
    writeScenario({ turns: [{ messages, result: success(findings) }] });
    const engine = makeEngine();
    const session = await openWithTools(engine);
    const turn = await session.turn('x');
    await session.close();
    expect(turn.toolCalls).to.deep.equal([
      {
        tool_name: 'mcp__cht-docs__search_docs', tool_input: { query: 'sentinel' }, tool_response: 'connection refused',
      },
      { tool_name: 'mcp__watchdog__get_windows', tool_input: { metric: 'm' }, tool_response: '{"ok":true}' },
    ]);
    expect(turn.referenceUnavailable).to.equal(true);

    const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
    const gate = async () => ({
      report: { subject: 'pass', subject_ref: 'alpha-example-org/pass1', attempt: 1, checks: [], outcome: 'accepted' },
      items: [],
    });
    const result = await runProjectSession({
      engine: makeEngine(), definition, project, candidates: [{ candidate_id: 'cand00000001' }], changes: [],
      config: { ...config(), bounds: { ...config().bounds, verifyMaxRetries: 2, passes: 1, passConvergence: true } },
      gate, runDir, logger, now: () => new Date('2026-09-18T06:00:00Z'), localTools: [],
    });
    expect(result.reference_sources_unavailable).to.equal(true);
    const lines = fs.readFileSync(runDir.path('alpha-example-org', 'tool-calls.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    expect(lines).to.have.length(2);
    expect(lines[0]).to.include({
      pass: 1, attempt: 1, tool_name: 'mcp__cht-docs__search_docs', tool_response: 'connection refused',
    });
    expect(lines[0].tool_input).to.deep.equal({ query: 'sentinel' });
    expect(lines[1]).to.include({ tool_name: 'mcp__watchdog__get_windows', tool_response: '{"ok":true}' });
    const sessionRecord = JSON.parse(fs.readFileSync(runDir.path('alpha-example-org', 'session.json'), 'utf8'));
    expect(sessionRecord.engine).to.equal('cli');
  });

  it('enforces the turn cap from the event stream: stdin closed, process ended, error_max_turns reported', async () => {
    const engine = makeEngine({ env: { FAKE_CLAUDE_MODE: 'chatter', FAKE_CLAUDE_CHATTER: '3' } });
    const session = await openWithTools(engine, { bounds: bounds({ maxTurns: 2 }) });
    const turn = await session.turn('x');
    expect(turn.structuredOutput).to.equal(null);
    expect(turn.result).to.include({ subtype: 'error_max_turns', num_turns: 3, total_cost_usd: 0 });
    expect(turn.result.errors).to.deep.equal(['harness turn cap reached']);
    const exit = await session.exited;
    expect(exit.code !== null || exit.signal !== null).to.equal(true);
    await session.close();
  });

  it('kills the process and rejects the turn when the wall clock expires', async () => {
    const engine = makeEngine({ env: { FAKE_CLAUDE_MODE: 'hang' } });
    const session = await openWithTools(engine, { bounds: bounds({ timeoutMs: 150 }) });
    await expect(session.turn('x')).to.be.rejectedWith(/timed out after 150 ms/);
    const exit = await session.exited;
    expect(exit.code !== null || exit.signal !== null).to.equal(true);
    await session.close();
  });

  it('rejects the pending turn when the process exits before a result and refuses turns afterwards', async () => {
    writeScenario({ turns: [{ result: success({ a: 1 }) }] });
    const engine = makeEngine({ env: { FAKE_CLAUDE_MODE: 'hang' } });
    const session = await openWithTools(engine);
    const promise = session.turn('x');
    session.process.stdin.end();
    await expect(promise).to.be.rejectedWith(/session ended before a result/);
    await expect(session.turn('y')).to.be.rejectedWith(/session has ended/);
    await session.close();
  });

  it('fails fast with a clear error when the executable cannot be started', async () => {
    writeScenario({ turns: [{ result: success({ a: 1 }) }] });
    const engine = makeEngine({ engine: { claudePath: path.join(dataDir, 'no-such-claude') } });
    await expect(openWithTools(engine)).to.be.rejectedWith(/could not start/);
  });

  it('resolves the executable from AGENT_WATCHDOG_CLAUDE_PATH (config.runtime.claudePath)', async () => {
    writeScenario({ turns: [{ result: success({ a: 1 }) }] });
    const engine = createCliEngine({
      config: { ...config(), runtime: { claudePath: FAKE } }, definition, mcpConfig, env: fakeEnv(), logger, runDir,
    });
    const session = await openWithTools(engine);
    expect((await session.turn('x')).structuredOutput).to.deep.equal({ a: 1 });
    await session.close();
    expect(readRecord(recordFile)).to.have.length(1);
  });

  it('needs a run directory to serve local tools but not for a tool-less session', async () => {
    writeScenario({ turns: [{ result: success({ a: 1 }) }] });
    const bare = createCliEngine({ config: config(), definition, mcpConfig, env: fakeEnv(), logger, claudePath: FAKE });
    await expect(openWithTools(bare)).to.be.rejectedWith(/run directory/);
    const turn = await bare.singleTurn({
      systemPrompt: ['p'], userPrompt: 'u', outputSchema: {}, bounds: bounds(), model: 'm', effort: 'low', name: 'n',
    });
    expect(turn.structuredOutput).to.deep.equal({ a: 1 });
  });

  it('serves every local server from recordings under replay and drops the remote documentation server', async () => {
    writeScenario({ turns: [{ result: success({ a: 1 }) }] });
    const engine = makeEngine({ engine: { replay: true } });
    const docsTools = [{ name: 'search_docs', description: 'd', schema: {}, handler: async () => ({ content: [] }) }];
    const session = await openWithTools(engine, { localServers: { 'cht-docs': docsTools } });
    await session.turn('x');
    const [record] = readRecord(recordFile);
    const real = JSON.parse(fs.readFileSync(record.argv[record.argv.indexOf('--mcp-config') + 1], 'utf8'));
    expect(real.mcpServers.watchdog.args).to.deep.equal([
      BIN, 'tools-server', '--run-dir', runDir.root, '--data-dir', dataDir, '--project', 'alpha-example-org',
      '--replay',
    ]);
    expect(real.mcpServers['cht-docs']).to.deep.equal({
      type: 'stdio',
      command: process.execPath,
      args: [
        BIN, 'tools-server', '--run-dir', runDir.root, '--data-dir', dataDir, '--project', 'alpha-example-org',
        '--server', 'cht-docs', '--replay',
      ],
    });
    expect(JSON.stringify(real)).to.not.include(TOKEN);
    await session.close();
  });

  it('maps the same event stream exactly like the SDK engine (parity)', async () => {
    const messages = [
      toolUse('tu1', 'mcp__cht-docs__search_docs', { query: 'sentinel' }),
      toolResult('tu1', 'connection refused', true),
      toolUse('tu2', 'mcp__watchdog__get_windows', { metric: 'm' }),
      toolResult('tu2', [{ type: 'text', text: '{"ok":true}' }]),
    ];
    const scripted = { session_id: 'sess-1', turns: [
      { messages, result: success({ a: 1 }, { total_cost_usd: 0.02 }) },
      {
        result: success({ a: 2 }, {
          total_cost_usd: 0.05, permission_denials: [{ tool_name: 'mcp__cht-docs__get_sources' }],
        }),
      },
    ] };
    writeScenario(scripted);
    const cliSession = await openWithTools(makeEngine());
    const cliTurns = [await cliSession.turn('first'), await cliSession.turn('second')];
    await cliSession.close();

    // The SDK fake from test/agent/engine-sdk.spec.js: one query consuming the streaming prompt.
    const sdk = {
      query: ({ prompt }) => (async function* run() {
        yield {
          type: 'system', subtype: 'init', session_id: 'sess-1',
          mcp_servers: [{ name: 'cht-docs', status: 'connected' }],
        };
        let index = 0;
        for await (const userMessage of prompt) {
          void userMessage;
          const turn = scripted.turns[Math.min(index, scripted.turns.length - 1)];
          index += 1;
          for (const message of turn.messages || []) {
            yield message;
          }
          yield { type: 'result', session_id: 'sess-1', ...turn.result };
        }
      }()),
      tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
      createSdkMcpServer: (options) => ({ type: 'sdk', name: options.name, instance: {} }),
    };
    const sdkEngine = createSdkEngine({
      config: config(), definition, mcpConfig, sdkLoader: async () => sdk, env: {}, logger,
    });
    const sdkSession = await sdkEngine.openSession({
      systemPrompt: ['p'], outputSchema: definition.outputSchemas.findings, tools: definition.tools.allowed, localTools,
      mcpConfig, bounds: bounds(), model: 'claude-fable-5-1', effort: 'max', sessionName: 'alpha-example-org',
    });
    const sdkTurns = [await sdkSession.turn('first'), await sdkSession.turn('second')];
    await sdkSession.close();
    expect(cliTurns).to.deep.equal(sdkTurns);
    expect(cliTurns[1].referenceUnavailable).to.equal(true);
    expect(cliTurns[1].result.total_cost_usd).to.be.closeTo(0.03, 1e-9);
  });
});

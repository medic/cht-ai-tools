'use strict';
// The `claude` command-line face of the same agent definition (contracts/agent-definition.md, research.md R-3):
// one `claude -p` process per project session fed stream-json user turns over stdin, its stream-json stdout
// mapped to the same turn objects as the SDK engine by src/agent/turn-mapper.js. Hooks do not fire under
// --bare, so the harness enforces the turn cap and the wall clock from the event stream itself.
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTurnMapper } = require('./turn-mapper');

const DOCS_SERVER = 'cht-docs';
const DOCS_PREFIX = `mcp__${DOCS_SERVER}__`;
const WATCHDOG_SERVER = 'watchdog';
const DEFAULT_BIN = path.resolve(__dirname, '..', '..', 'bin', 'agent-watchdog.js');
const DEFAULT_EXECUTABLE = 'claude';
const KILL_GRACE_MS = 2000;
const STDERR_SNIPPET = 500;

// PATH falls back to this process's PATH: without one neither `claude` nor a `#!/usr/bin/env node` tool server
// could be found, and a caller passing a reduced environment never means to hide the executables.
const subprocessEnv = (env) => ({
  ...env,
  PATH: env.PATH || process.env.PATH,
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || path.join(os.tmpdir(), 'agent-watchdog-runtime'),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

/** The verified print-mode argument list; --verbose is required by the CLI for stream-json output. */
const buildArgs = ({ systemPromptFile, tools, mcpConfigFile, outputSchema, model, effort, maxBudgetUsd }) => {
  const args = [
    '-p', '--bare', '--verbose', '--no-session-persistence',
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--system-prompt-file', systemPromptFile,
    '--tools', '',
  ];
  if (tools.length) {
    args.push('--allowed-tools', ...tools);
  }
  args.push('--permission-mode', 'dontAsk');
  if (mcpConfigFile) {
    args.push('--mcp-config', mcpConfigFile);
  }
  args.push('--strict-mcp-config', '--json-schema', JSON.stringify(outputSchema));
  args.push('--model', model, '--effort', effort, '--max-budget-usd', String(maxBudgetUsd));
  return args;
};

/** A copy of an MCP configuration with every bearer token blanked, for the run record. */
const redactMcpConfig = (config) => JSON.parse(JSON.stringify(config).replace(/Bearer [^"\\]*/g, 'Bearer [redacted]'));

const safeName = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_');

const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

/**
 * @param {object} options
 * @param {object} options.config configuration (model, bounds, storage, runtime)
 * @param {object} options.definition the agent definition (tools allow-list)
 * @param {object} [options.mcpConfig] rendered MCP configuration ({ mcpServers })
 * @param {object} [options.env] environment to derive the subprocess environment from
 * @param {object} [options.logger]
 * @param {import('../store/run-dir').RunDir} [options.runDir] where prompt files and the redacted MCP copy go
 * @param {Function} [options.spawn] child_process.spawn replacement for tests
 * @param {string} [options.claudePath] executable; defaults to AGENT_WATCHDOG_CLAUDE_PATH, then `claude` on PATH
 * @param {string} [options.binPath] this package's executable, used to launch the stdio tool servers
 * @param {boolean} [options.replay] serve every local server from recordings and attach no remote server
 */
const createCliEngine = ({
  config, definition, mcpConfig = null, env = process.env, logger = null, runDir = null,
  spawn = childProcess.spawn, claudePath = null, binPath = DEFAULT_BIN, replay = false,
}) => {
  const executable = claudePath || (config.runtime && config.runtime.claudePath) || DEFAULT_EXECUTABLE;
  const debug = (event, fields) => {
    if (logger) {
      logger.debug(event, fields);
    }
  };

  const stdioServer = (serverName, sessionName) => {
    if (!runDir || !sessionName) {
      throw new Error('the cli engine needs a run directory and a session name to serve local tools');
    }
    const args = [
      binPath, 'tools-server', '--run-dir', runDir.root, '--data-dir', config.storage.dataDir, '--project', sessionName,
    ];
    if (serverName !== WATCHDOG_SERVER) {
      args.push('--server', serverName);
    }
    if (replay) {
      args.push('--replay');
    }
    return { type: 'stdio', command: process.execPath, args };
  };

  const mcpServersFor = ({ tools, localTools, localServers, sessionMcp, sessionName }) => {
    const local = { ...localServers };
    if (localTools.length && !local[WATCHDOG_SERVER]) {
      local[WATCHDOG_SERVER] = localTools;
    }
    const servers = {};
    const remoteDocs = sessionMcp && sessionMcp.mcpServers ? sessionMcp.mcpServers[DOCS_SERVER] : null;
    const wantsDocs = tools.some((t) => t.startsWith(DOCS_PREFIX));
    if (remoteDocs && wantsDocs && !replay && !local[DOCS_SERVER]) {
      servers[DOCS_SERVER] = remoteDocs;
    }
    for (const [name, toolDefs] of Object.entries(local)) {
      if (toolDefs && toolDefs.length) {
        servers[name] = stdioServer(name, sessionName);
      }
    }
    return servers;
  };

  const writeSystemPrompt = async (systemPrompt, sessionName, tempDir) => {
    const text = Array.isArray(systemPrompt) ? systemPrompt.join('\n') : String(systemPrompt);
    const file = `system-prompt${sessionName ? `.${safeName(sessionName)}` : ''}.md`;
    if (runDir) {
      await runDir.writeText(path.join('agent', file), text);
      return runDir.path('agent', file);
    }
    const full = path.join(tempDir, file);
    await fs.writeFile(full, text, { mode: 0o600 });
    return full;
  };

  const writeMcpConfig = async (servers, sessionName, tempDir) => {
    if (!Object.keys(servers).length) {
      return null;
    }
    const document = { mcpServers: servers };
    const file = path.join(tempDir, 'mcp.json');
    await fs.writeFile(file, JSON.stringify(document, null, 2), { mode: 0o600 });
    if (runDir) {
      const rel = path.join('agent', `mcp${sessionName ? `.${safeName(sessionName)}` : ''}.json`);
      await runDir.writeJson(rel, redactMcpConfig(document));
    }
    return file;
  };

  const start = (args) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: subprocessEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const onError = (error) => reject(new Error(`could not start ${executable}: ${error.message}`));
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      resolve(child);
    });
  });

  const openSession = async (request) => {
    const {
      systemPrompt, outputSchema, tools = definition.tools.allowed, localTools = [], localServers = {},
      mcpConfig: sessionMcp = mcpConfig, bounds, model = config.model.name, effort = config.model.effort,
      sessionName = null,
    } = request;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-watchdog-cli-'));
    const cleanup = () => fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    let child;
    try {
      const servers = mcpServersFor({ tools, localTools, localServers, sessionMcp, sessionName });
      const systemPromptFile = await writeSystemPrompt(systemPrompt, sessionName, tempDir);
      const mcpConfigFile = await writeMcpConfig(servers, sessionName, tempDir);
      const args = buildArgs({
        systemPromptFile, tools, mcpConfigFile, outputSchema, model, effort, maxBudgetUsd: bounds.maxBudgetUsd,
      });
      child = await start(args);
    } catch (error) {
      await cleanup();
      throw error;
    }

    const mapper = createTurnMapper({ docsServer: DOCS_SERVER });
    let pending = null;
    let ended = false;
    let turnStartedAt = null;
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const settle = (turn) => {
      if (!pending) {
        return;
      }
      const { resolve } = pending;
      pending = null;
      resolve(turn);
    };
    const fail = (error) => {
      if (!pending) {
        return;
      }
      const { reject } = pending;
      pending = null;
      reject(error);
    };
    const terminate = () => {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed
      }
      if (!ended) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!ended) {
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS).unref();
      }
    };

    const onLine = (line) => {
      if (!line.trim()) {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        debug('cli.stdout_ignored', { session: sessionName, line: line.slice(0, STDERR_SNIPPET) });
        return;
      }
      const turn = mapper.handle(message);
      if (turn) {
        settle(turn);
        return;
      }
      if (pending && mapper.assistantTurns > bounds.maxTurns) {
        debug('cli.turn_cap', {
          session: sessionName, assistant_turns: mapper.assistantTurns, max_turns: bounds.maxTurns,
        });
        terminate();
        settle(mapper.synthesizeResult({
          subtype: 'error_max_turns',
          errors: ['harness turn cap reached'],
          durationMs: turnStartedAt === null ? null : Date.now() - turnStartedAt,
        }));
      }
    };

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      debug('cli.stderr', { session: sessionName, data: String(chunk).slice(0, STDERR_SNIPPET) });
    });
    child.stdin.on('error', (error) => fail(new Error(`could not write to ${executable}: ${error.message}`)));
    child.on('error', (error) => {
      ended = true;
      fail(error);
    });
    child.on('exit', () => {
      ended = true;
      if (buffer.trim()) {
        onLine(buffer);
        buffer = '';
      }
      fail(new Error('session ended before a result message arrived'));
    });

    const turn = (userText) => new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error('a turn is already in progress'));
        return;
      }
      if (ended) {
        reject(new Error('session has ended'));
        return;
      }
      const timer = setTimeout(() => {
        const current = pending;
        pending = null;
        terminate();
        if (current) {
          current.reject(new Error(`turn timed out after ${bounds.timeoutMs} ms`));
        }
      }, bounds.timeoutMs);
      pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      turnStartedAt = Date.now();
      mapper.beginTurn();
      child.stdin.write(`${JSON.stringify(userMessage(userText))}\n`);
    });

    const close = async () => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      const timeout = new Promise((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS));
      const settled = await Promise.race([exited.then(() => true), timeout]);
      if (!settled) {
        child.kill('SIGKILL');
        await exited;
      }
      await cleanup();
    };

    return {
      turn,
      close,
      exited,
      process: child,
      get sessionId() {
        return mapper.sessionId;
      },
    };
  };

  const singleTurn = async (request) => {
    const { systemPrompt, userPrompt, outputSchema, bounds, model, effort, name = 'single-turn' } = request;
    const session = await openSession({
      systemPrompt, outputSchema, tools: [], localTools: [], localServers: {}, mcpConfig: null, bounds, model, effort,
      sessionName: name,
    });
    try {
      return await session.turn(userPrompt);
    } finally {
      await session.close();
    }
  };

  return { name: 'cli', mcpConfig, openSession, singleTurn };
};

module.exports = { createCliEngine, buildArgs, redactMcpConfig, subprocessEnv };

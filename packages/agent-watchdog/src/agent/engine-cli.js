'use strict';
// The `claude` command-line face of the same agent definition (contracts/agent-definition.md, research.md R-3):
// one `claude -p` process per project session fed stream-json user turns over stdin, its stream-json stdout
// mapped to the same turn objects as the SDK engine by src/agent/turn-mapper.js. Hooks never fire (bare mode
// skips them; login mode loads no settings), so the harness enforces the turn cap and the wall clock from the
// event stream itself.
//
// Two authentication modes, chosen by whether ANTHROPIC_API_KEY is configured:
// - key mode: `--bare` with the key in a private configuration directory (the verified production shape);
// - login mode: no key, so the runtime uses the operator's `claude` login. Bare mode never reads that login,
//   so the process runs without `--bare` and is isolated by flags instead: `--setting-sources ""` (no settings
//   files, rules or CLAUDE.md), `--tools ""`, `--strict-mcp-config`, `--no-session-persistence`, and the
//   auto-memory switch in the environment.
const { RUNTIME_TOOLS } = require('../../agent/hooks');
const { forStructuredOutput } = require('./output-schema');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
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

const DEFAULT_CONFIG_DIR = path.join(os.tmpdir(), 'agent-watchdog-runtime');

/** Where the runtime keeps its login: CLAUDE_CONFIG_DIR, else `~/.claude`. */
const claudeConfigDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');

// PATH falls back to this process's PATH: without one neither `claude` nor a `#!/usr/bin/env node` tool server
// could be found, and a caller passing a reduced environment never means to hide the executables. Auto memory
// is off in both modes: nothing of a run belongs in the operator's memory directory.
const subprocessEnv = (env, { apiKey = null } = {}) => {
  const child = {
    ...env,
    PATH: env.PATH || process.env.PATH,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  if (apiKey) {
    child.ANTHROPIC_API_KEY = apiKey;
    child.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR || DEFAULT_CONFIG_DIR;
  } else {
    // Print mode uses a key whenever the variable is present, even blank (as `--env-file` leaves it), which
    // would hide the login; the configuration directory stays where the login is.
    delete child.ANTHROPIC_API_KEY;
  }
  return child;
};

/** The verified print-mode argument list; --verbose is required by the CLI for stream-json output. */
const buildArgs = ({
  systemPromptFile, tools, mcpConfigFile, outputSchema, model, effort, maxBudgetUsd, login = false,
}) => {
  const args = ['-p'];
  if (login) {
    args.push('--verbose', '--no-session-persistence', '--setting-sources', '');
  } else {
    args.push('--bare', '--verbose', '--no-session-persistence');
  }
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
  args.push('--system-prompt-file', systemPromptFile, '--tools', '');
  // The runtime's own StructuredOutput tool must be allowed for --json-schema output (agent/hooks.js).
  args.push('--allowed-tools', ...tools, ...RUNTIME_TOOLS);
  args.push('--permission-mode', 'dontAsk');
  if (mcpConfigFile) {
    args.push('--mcp-config', mcpConfigFile);
  }
  args.push('--strict-mcp-config', '--json-schema', JSON.stringify(forStructuredOutput(outputSchema)));
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
  const apiKey = (config.secrets && config.secrets.anthropicApiKey) || null;
  const login = !apiKey;
  const log = (level, event, fields) => {
    if (logger) {
      logger[level](event, fields);
    }
  };
  const debug = (event, fields) => log('debug', event, fields);
  if (login) {
    const configDir = claudeConfigDir(env);
    const credentialsFound = fsSync.existsSync(path.join(configDir, '.credentials.json'));
    log('info', 'agent.cli_auth', { mode: 'login', config_dir: configDir, credentials_found: credentialsFound });
    if (!credentialsFound) {
      log('warn', 'agent.cli_login_missing', {
        config_dir: configDir,
        hint: 'no credentials file there; run `claude` and /login (macOS may keep the login in the keychain), '
          + 'or set ANTHROPIC_API_KEY',
      });
    }
  } else {
    log('info', 'agent.cli_auth', { mode: 'api_key' });
  }

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
    const child = spawn(executable, args, { env: subprocessEnv(env, { apiKey }), stdio: ['pipe', 'pipe', 'pipe'] });
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
        systemPromptFile, tools, mcpConfigFile, outputSchema, model, effort, maxBudgetUsd: bounds.maxBudgetUsd, login,
      });
      child = await start(args);
    } catch (error) {
      await cleanup();
      throw error;
    }

    const mapper = createTurnMapper({ docsServer: DOCS_SERVER, allowedTools: tools });
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
          current.reject(Object.assign(new Error(`turn timed out after ${bounds.timeoutMs} ms`), { code: 'TIMEOUT' }));
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

module.exports = { createCliEngine, buildArgs, redactMcpConfig, subprocessEnv, claudeConfigDir };

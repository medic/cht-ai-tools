'use strict';
// The Claude Agent SDK engine (research.md R-2): one streaming-input query per project session, isolated
// from filesystem settings, with no built-in tools and an enumerated MCP allow-list. Messages are mapped to
// turn objects by src/agent/turn-mapper.js, the same mapper the command-line engine uses.
const { forStructuredOutput } = require('./output-schema');
const os = require('node:os');
const path = require('node:path');
const { buildHooks, RUNTIME_TOOLS } = require('../../agent/hooks');
const { createSdkToolServer } = require('./tools/sdk-server');
const { createTurnMapper, normaliseUsage, blockText } = require('./turn-mapper');

const DOCS_PREFIX = 'mcp__cht-docs__';
const DOCS_SERVER = 'cht-docs';
const WATCHDOG_SERVER = 'watchdog';

/** A push-based async iterable of user messages: the SDK's streaming-input prompt. */
const createQueue = () => {
  const items = [];
  const waiters = [];
  let closed = false;
  const push = (item) => {
    if (waiters.length) {
      waiters.shift()(item);
    } else {
      items.push(item);
    }
  };
  const close = () => {
    closed = true;
    while (waiters.length) {
      waiters.shift()(undefined);
    }
  };
  const next = () => {
    if (items.length) {
      return Promise.resolve(items.shift());
    }
    if (closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const iterable = async function* messages() {
    while (true) {
      const item = await next();
      if (item === undefined) {
        return;
      }
      yield item;
    }
  };
  return { push, close, iterable };
};

/**
 * @param {object} options
 * @param {object} options.config full configuration (model, bounds, runtime)
 * @param {object} options.definition the agent definition (tools allow-list)
 * @param {object} [options.mcpConfig] rendered MCP configuration ({ mcpServers })
 * @param {Function} [options.sdkLoader] returns the SDK module (defaults to dynamic import)
 * @param {object} [options.env] environment to derive the subprocess environment from
 * @param {object} [options.logger]
 */
const createSdkEngine = ({
  config, definition, mcpConfig = null, sdkLoader = () => import('@anthropic-ai/claude-agent-sdk'), env = process.env,
  logger = null, hooksFactory = buildHooks,
}) => {
  let sdkPromise = null;
  const loadSdk = () => {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve().then(() => sdkLoader());
    }
    return sdkPromise;
  };

  const subprocessEnv = () => ({
    ...env,
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || path.join(os.tmpdir(), 'agent-watchdog-runtime'),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });

  /**
   * The MCP servers of one session: the remote documentation server when a docs tool is allowed, plus one
   * in-process server per entry of localServers (localTools is the shorthand for the watchdog server). A local
   * `cht-docs` server, as replay supplies, replaces the remote one.
   */
  const mcpServersFor = ({ sdk, tools, localTools, localServers, sessionMcp }) => {
    const local = { ...localServers };
    if (localTools.length && !local[WATCHDOG_SERVER]) {
      local[WATCHDOG_SERVER] = localTools;
    }
    const mcpServers = {};
    const docs = sessionMcp && sessionMcp.mcpServers ? sessionMcp.mcpServers[DOCS_SERVER] : null;
    if (docs && !local[DOCS_SERVER] && tools.some((t) => t.startsWith(DOCS_PREFIX))) {
      mcpServers[DOCS_SERVER] = docs;
    }
    for (const [name, toolDefs] of Object.entries(local)) {
      if (toolDefs && toolDefs.length) {
        mcpServers[name] = createSdkToolServer(sdk, toolDefs, { name });
      }
    }
    return mcpServers;
  };

  const openSession = async (request) => {
    const {
      systemPrompt, outputSchema, tools = definition.tools.allowed, localTools = [], localServers = {},
      mcpConfig: sessionMcp = mcpConfig, bounds, model = config.model.name, effort = config.model.effort,
      sessionName = null,
    } = request;
    const sdk = await loadSdk();
    const abortController = new AbortController();
    const queue = createQueue();
    const mapper = createTurnMapper({ docsServer: DOCS_SERVER });
    let pending = null;
    let ended = false;

    const options = {
      systemPrompt,
      settingSources: [],
      tools: [],
      allowedTools: [...tools, ...RUNTIME_TOOLS],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: forStructuredOutput(outputSchema) },
      maxTurns: bounds.maxTurns,
      maxBudgetUsd: bounds.maxBudgetUsd,
      model,
      effort,
      mcpServers: mcpServersFor({ sdk, tools, localTools, localServers, sessionMcp }),
      hooks: hooksFactory({ allowed: tools, recorder: () => {}, logger }),
      env: subprocessEnv(),
      abortController,
      stderr: (data) => {
        if (logger) {
          logger.debug('sdk.stderr', { session: sessionName, data: String(data).slice(0, 500) });
        }
      },
    };

    const settle = (turn) => {
      if (pending) {
        const { resolve } = pending;
        pending = null;
        resolve(turn);
      }
    };
    const fail = (error) => {
      if (pending) {
        const { reject } = pending;
        pending = null;
        reject(error);
      }
    };

    const stream = sdk.query({ prompt: queue.iterable(), options });
    const pump = (async () => {
      try {
        for await (const message of stream) {
          const turn = mapper.handle(message);
          if (turn) {
            settle(turn);
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        ended = true;
        fail(new Error('session ended before a result message arrived'));
      }
    })();

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
        abortController.abort();
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
      mapper.beginTurn();
      queue.push({ type: 'user', message: { role: 'user', content: userText }, parent_tool_use_id: null });
    });

    const close = async () => {
      queue.close();
      const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 2000));
      const settled = await Promise.race([pump.then(() => true), timeout]);
      if (!settled) {
        abortController.abort();
      }
    };

    return {
      turn,
      close,
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

  return { name: 'sdk', mcpConfig, openSession, singleTurn };
};

module.exports = { createSdkEngine, createQueue, normaliseUsage, blockText };

'use strict';
// The Claude Agent SDK engine (research.md R-2): one streaming-input query per project session, isolated
// from filesystem settings, with no built-in tools and an enumerated MCP allow-list.
const os = require('node:os');
const path = require('node:path');
const { buildHooks } = require('../../agent/hooks');
const { createSdkToolServer } = require('./tools/sdk-server');

const DOCS_PREFIX = 'mcp__cht-docs__';
const DOCS_SERVER = 'cht-docs';

const normaliseUsage = (usage = {}) => ({
  input_tokens: usage.input_tokens || 0,
  output_tokens: usage.output_tokens || 0,
  cache_read_tokens: usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0,
  cache_creation_tokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0,
});

const blockText = (content) => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === 'string' ? block : block.text || '')).join('');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
};

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

  const openSession = async (request) => {
    const {
      systemPrompt, outputSchema, tools = definition.tools.allowed, localTools = [],
      mcpConfig: sessionMcp = mcpConfig, bounds, model = config.model.name, effort = config.model.effort,
      sessionName = null,
    } = request;
    const sdk = await loadSdk();
    const abortController = new AbortController();
    const queue = createQueue();
    const toolUses = new Map();
    let pending = null;
    let initUnavailable = false;
    let sessionId = null;
    let ended = false;

    const mcpServers = {};
    const docs = sessionMcp && sessionMcp.mcpServers ? sessionMcp.mcpServers[DOCS_SERVER] : null;
    if (docs && tools.some((t) => t.startsWith(DOCS_PREFIX))) {
      mcpServers[DOCS_SERVER] = docs;
    }
    if (localTools.length) {
      mcpServers.watchdog = createSdkToolServer(sdk, localTools);
    }

    const options = {
      systemPrompt,
      settingSources: [],
      tools: [],
      allowedTools: tools,
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: outputSchema },
      maxTurns: bounds.maxTurns,
      maxBudgetUsd: bounds.maxBudgetUsd,
      model,
      effort,
      mcpServers,
      hooks: hooksFactory({ allowed: tools, recorder: () => {}, logger }),
      env: subprocessEnv(),
      abortController,
      stderr: (data) => {
        if (logger) {
          logger.debug('sdk.stderr', { session: sessionName, data: String(data).slice(0, 500) });
        }
      },
    };

    const handle = (message) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id || sessionId;
        const servers = message.mcp_servers || [];
        if (servers.some((s) => s.name === DOCS_SERVER && s.status !== 'connected')) {
          initUnavailable = true;
        }
        return;
      }
      const blocks = message.message && Array.isArray(message.message.content) ? message.message.content : [];
      if (message.type === 'assistant') {
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            toolUses.set(block.id, { name: block.name, input: block.input });
          }
        }
        return;
      }
      if (message.type === 'user' && pending) {
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const use = toolUses.get(block.tool_use_id) || { name: 'unknown', input: null };
            pending.toolCalls.push({
              tool_name: use.name, tool_input: use.input, tool_response: blockText(block.content),
            });
            if (block.is_error && use.name.startsWith(DOCS_PREFIX)) {
              pending.referenceUnavailable = true;
            }
          }
        }
        return;
      }
      if (message.type === 'result' && pending) {
        const denials = message.permission_denials || [];
        const deniedDocs = denials.some((d) => String(d.tool_name || '').startsWith(DOCS_PREFIX));
        const turn = {
          structuredOutput: message.structured_output === undefined ? null : message.structured_output,
          result: {
            subtype: message.subtype,
            usage: normaliseUsage(message.usage),
            total_cost_usd: message.total_cost_usd || 0,
            num_turns: message.num_turns ?? null,
            duration_ms: message.duration_ms ?? null,
            session_id: message.session_id || sessionId,
            permission_denials: denials,
            errors: message.errors || [],
            stop_reason: message.stop_reason || null,
          },
          toolCalls: pending.toolCalls,
          referenceUnavailable: initUnavailable || pending.referenceUnavailable || deniedDocs,
        };
        const { resolve } = pending;
        pending = null;
        resolve(turn);
      }
    };

    const stream = sdk.query({ prompt: queue.iterable(), options });
    const pump = (async () => {
      try {
        for await (const message of stream) {
          handle(message);
        }
      } catch (error) {
        if (pending) {
          const { reject } = pending;
          pending = null;
          reject(error);
        }
      } finally {
        ended = true;
        if (pending) {
          const { reject } = pending;
          pending = null;
          reject(new Error('session ended before a result message arrived'));
        }
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
          current.reject(new Error(`turn timed out after ${bounds.timeoutMs} ms`));
        }
      }, bounds.timeoutMs);
      pending = {
        toolCalls: [],
        referenceUnavailable: false,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
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

    return { turn, close, get sessionId() {
      return sessionId; 
    } };
  };

  const singleTurn = async (request) => {
    const { systemPrompt, userPrompt, outputSchema, bounds, model, effort, name = 'single-turn' } = request;
    const session = await openSession({
      systemPrompt, outputSchema, tools: [], localTools: [], mcpConfig: null, bounds, model, effort, sessionName: name,
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

'use strict';
// Maps the runtime's stream-json events to the turn object both engines return (contracts/agent-definition.md
// "The per-project session loop (identical in both engines)"). The SDK engine feeds it the messages `query()`
// yields; the CLI engine feeds it the parsed stdout lines of `claude -p --output-format stream-json`.
// The runtime reports `total_cost_usd` as a running total across the turns of one session (sdk.d.ts), so the
// per-turn cost handed to the session loop is the delta and the running total travels as `cumulative_cost_usd`.

/** Cap on the runtime's result text kept on a turn, so a runaway message cannot flood the pass record. */
const RESULT_TEXT_MAX = 500;

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

const round6 = (value) => Number(value.toFixed(6));

/**
 * @param {object} [options]
 * @param {string} [options.docsServer] MCP server name whose failures mark reference sources unavailable
 */
const createTurnMapper = ({ docsServer = 'cht-docs' } = {}) => {
  const docsPrefix = `mcp__${docsServer}__`;
  const toolUses = new Map();
  let sessionId = null;
  let initUnavailable = false;
  let lastCumulativeCost = 0;
  let current = null;

  const beginTurn = () => {
    current = { toolCalls: [], referenceUnavailable: false, assistantTurns: 0 };
  };

  const finish = ({ structuredOutput, result }) => {
    const turn = {
      structuredOutput,
      result,
      toolCalls: current ? current.toolCalls : [],
      referenceUnavailable: initUnavailable
        || Boolean(current && current.referenceUnavailable)
        || result.permission_denials.some((d) => String(d.tool_name || '').startsWith(docsPrefix)),
    };
    current = null;
    return turn;
  };

  const handle = (message) => {
    if (!message || typeof message !== 'object') {
      return null;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id || sessionId;
      const servers = message.mcp_servers || [];
      if (servers.some((s) => s.name === docsServer && s.status !== 'connected')) {
        initUnavailable = true;
      }
      return null;
    }
    const blocks = message.message && Array.isArray(message.message.content) ? message.message.content : [];
    if (message.type === 'assistant') {
      if (current) {
        current.assistantTurns += 1;
      }
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          toolUses.set(block.id, { name: block.name, input: block.input });
        }
      }
      return null;
    }
    if (message.type === 'user' && current) {
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const use = toolUses.get(block.tool_use_id) || { name: 'unknown', input: null };
          current.toolCalls.push({
            tool_name: use.name, tool_input: use.input, tool_response: blockText(block.content),
          });
          if (block.is_error && use.name.startsWith(docsPrefix)) {
            current.referenceUnavailable = true;
          }
        }
      }
      return null;
    }
    if (message.type === 'result' && current) {
      const cumulative = message.total_cost_usd || 0;
      const delta = round6(Math.max(0, cumulative - lastCumulativeCost));
      lastCumulativeCost = Math.max(lastCumulativeCost, cumulative);
      return finish({
        structuredOutput: message.structured_output === undefined ? null : message.structured_output,
        result: {
          subtype: message.subtype,
          usage: normaliseUsage(message.usage),
          total_cost_usd: delta,
          cumulative_cost_usd: round6(lastCumulativeCost),
          num_turns: message.num_turns ?? null,
          duration_ms: message.duration_ms ?? null,
          session_id: message.session_id || sessionId,
          permission_denials: message.permission_denials || [],
          errors: message.errors || [],
          stop_reason: message.stop_reason || null,
          // The runtime reports some failures (a model it cannot use, an authentication problem) as a result it
          // marks with is_error and explains in `result` (revision 17).
          is_error: Boolean(message.is_error),
          result_text: typeof message.result === 'string' ? message.result.slice(0, RESULT_TEXT_MAX) : null,
        },
      });
    }
    return null;
  };

  /** End the current turn without a result from the runtime: the harness hit a bound of its own. */
  const synthesizeResult = ({ subtype, errors = [], durationMs = null }) => finish({
    structuredOutput: null,
    result: {
      subtype,
      usage: normaliseUsage({}),
      total_cost_usd: 0,
      cumulative_cost_usd: round6(lastCumulativeCost),
      num_turns: current ? current.assistantTurns : 0,
      duration_ms: durationMs,
      session_id: sessionId,
      permission_denials: [],
      errors,
      stop_reason: null,
      is_error: false,
      result_text: null,
    },
  });

  return {
    handle,
    beginTurn,
    synthesizeResult,
    get sessionId() {
      return sessionId;
    },
    get initUnavailable() {
      return initUnavailable;
    },
    get assistantTurns() {
      return current ? current.assistantTurns : 0;
    },
    get inTurn() {
      return current !== null;
    },
  };
};

module.exports = { createTurnMapper, normaliseUsage, blockText };

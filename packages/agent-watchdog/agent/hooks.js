'use strict';
// In-process hook callbacks for the SDK engine (contracts/agent-definition.md). The harness-driven gate
// is authoritative; these are the second line of defence and the tool-call recorder.

/**
 * @param {object} options
 * @param {string[]} options.allowed tool names the model may call
 * @param {Function} options.recorder called with { tool_name, tool_input, tool_response } after every tool
 * @param {Function} [options.gate] async (lastAssistantMessage) => { ok, reasons }
 * @param {object} [options.logger]
 */
const buildHooks = ({ allowed, recorder, gate = null, logger = null }) => {
  const allowedSet = new Set(allowed || []);

  const preToolUse = async (input) => {
    if (allowedSet.has(input.tool_name)) {
      return { decision: 'approve' };
    }
    if (logger) {
      logger.warn('agent.tool_denied', { tool_name: input.tool_name });
    }
    return { decision: 'block', reason: `tool ${input.tool_name} is not on the allow-list` };
  };

  const postToolUse = async (input) => {
    if (recorder) {
      recorder({ tool_name: input.tool_name, tool_input: input.tool_input, tool_response: input.tool_response });
    }
    return {};
  };

  const stop = async (input) => {
    if (!gate) {
      return {};
    }
    const verdict = await gate(input.last_assistant_message);
    if (verdict && verdict.ok === false) {
      return { decision: 'block', reason: `verification failed: ${(verdict.reasons || []).join('; ')}` };
    }
    return {};
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    Stop: [{ hooks: [stop] }],
  };
};

module.exports = { buildHooks };

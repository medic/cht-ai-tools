'use strict';
// A scripted engine for tests: records every system prompt, option set and user turn, and answers from a
// list of responses ({ structuredOutput, result, toolCalls, referenceUnavailable }). Responses may be a
// function of (userText, turnIndex).
const defaultResult = (index) => ({
  subtype: 'success',
  usage: { input_tokens: 100 + index, output_tokens: 20, cache_read_tokens: 50, cache_creation_tokens: 0 },
  total_cost_usd: 0.01,
  num_turns: 2,
  duration_ms: 120,
  session_id: 'fake-session',
  permission_denials: [],
  errors: [],
});

const createFakeEngine = ({ responses = [], mcpConfig = null } = {}) => {
  const queue = Array.isArray(responses) ? [...responses] : null;
  const engine = { name: 'fake', mcpConfig, sessions: [], singleTurns: [] };
  let turnIndex = 0;

  const nextResponse = (userText) => {
    const index = turnIndex;
    turnIndex += 1;
    const scripted = queue ? queue.shift() : responses(userText, index);
    const response = scripted || {};
    return {
      structuredOutput: response.structuredOutput === undefined ? null : response.structuredOutput,
      result: { ...defaultResult(index), ...(response.result || {}) },
      toolCalls: response.toolCalls || [],
      referenceUnavailable: Boolean(response.referenceUnavailable),
    };
  };

  engine.openSession = async (options) => {
    const session = { options, turns: [], closed: false };
    engine.sessions.push(session);
    session.turn = async (userText) => {
      session.turns.push(userText);
      const response = nextResponse(userText);
      if (response.result.subtype === 'error_timeout') {
        throw Object.assign(new Error('turn timed out'), { code: 'TIMEOUT' });
      }
      return response;
    };
    session.close = async () => {
      session.closed = true;
    };
    return session;
  };

  engine.singleTurn = async (options) => {
    engine.singleTurns.push(options);
    return nextResponse(options.userPrompt);
  };

  return engine;
};

module.exports = { createFakeEngine };

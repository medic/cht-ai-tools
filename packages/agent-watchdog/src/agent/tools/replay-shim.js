'use strict';
// Serves recorded tool results during replay so nothing external is contacted (FR-041). Recordings are the
// session loop's tool-calls.jsonl lines: full MCP tool names (mcp__<server>__<tool>), the model's input and
// the text of the tool result, which is JSON for the local tools and Markdown for the documentation service.
const { argsHash } = require('./args-hash');

const MCP_NAME = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

/** Split `mcp__<server>__<tool>` into its parts; a bare name has no server. */
const shortToolName = (name) => {
  const match = MCP_NAME.exec(String(name));
  return match ? { server: match[1], tool: match[2] } : { server: null, tool: String(name) };
};

const parseResponse = (value) => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const key = (tool, hash) => `${tool}:${hash}`;

/**
 * @param {object[]} records tool-calls.jsonl lines ({ tool_name, tool_input, tool_response }) or the older
 *   { tool, args, result } shape
 * @returns {{ size: number, misses: number, lookup: Function, forServer: Function }}
 */
const createReplayLookup = (records = []) => {
  const map = new Map();
  const entries = [];
  for (const record of records) {
    const fullName = record.tool || record.tool_name;
    if (!fullName) {
      continue;
    }
    const { server, tool } = shortToolName(fullName);
    const args = record.args || record.tool_input || {};
    const result = record.result !== undefined ? record.result : parseResponse(record.tool_response);
    const hash = argsHash(args);
    map.set(key(tool, hash), result);
    entries.push({ server, tool, args, result });
  }
  const lookup = {
    size: map.size,
    misses: 0,
    lookup(tool, hash) {
      const short = shortToolName(tool).tool;
      if (map.has(key(short, hash))) {
        return map.get(key(short, hash));
      }
      lookup.misses += 1;
      return undefined;
    },
    /** A lookup restricted to the recordings of one MCP server. */
    forServer(server) {
      return createReplayLookup(entries
        .filter((e) => e.server === server)
        .map((e) => ({ tool: e.tool, args: e.args, result: e.result })));
    },
  };
  return lookup;
};

module.exports = { createReplayLookup, shortToolName, parseResponse };

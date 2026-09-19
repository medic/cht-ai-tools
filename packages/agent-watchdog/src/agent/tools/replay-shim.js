'use strict';
// Serves recorded tool results during replay so nothing external is contacted (FR-041).
const { argsHash } = require('./args-hash');

const key = (tool, hash) => `${tool}:${hash}`;

const createReplayLookup = (records = []) => {
  const map = new Map();
  for (const record of records) {
    const tool = record.tool || record.tool_name;
    const args = record.args || record.tool_input || {};
    const result = record.result !== undefined ? record.result : record.tool_response;
    if (tool) {
      map.set(key(tool, argsHash(args)), result);
    }
  }
  return {
    size: map.size,
    lookup: (tool, hash) => (map.has(key(tool, hash)) ? map.get(key(tool, hash)) : undefined),
  };
};

module.exports = { createReplayLookup };

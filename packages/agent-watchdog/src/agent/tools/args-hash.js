'use strict';
// Stable hashing of tool arguments so recordings match replays regardless of key order.
const crypto = require('node:crypto');

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const argsHash = (args) => crypto.createHash('sha256').update(stableStringify(args || {})).digest('hex');

module.exports = { stableStringify, argsHash };

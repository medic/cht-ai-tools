'use strict';
// Exit codes (contracts/exit-codes.md). sysexits values avoid Node's own 1 to 13 range.
const CODES = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 64,
  DATAERR: 65,
  UNAVAILABLE: 69,
  IOERR: 74,
  TEMPFAIL: 75,
  CONFIG: 78,
});

const NAMES = Object.freeze(Object.fromEntries(Object.entries(CODES).map(([name, code]) => [code, name])));

class ExitError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
    this.details = details;
  }
}

const nameOf = (code) => NAMES[code] || 'UNKNOWN';

module.exports = { ...CODES, ExitError, nameOf };

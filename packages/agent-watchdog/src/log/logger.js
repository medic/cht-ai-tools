'use strict';
// Structured JSON logs on stderr, bound to a run id, with monotonic timestamps at every event (constitution V).
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const SERVICE = 'agent-watchdog';
const REDACTED = '[redacted]';

const SECRET_KEY_EXACT = new Set([
  'token', 'secret', 'password', 'authorization', 'credential', 'credentials', 'apikey', 'api_key', 'privatekey',
  'private_key',
]);
const SECRET_KEY_SUFFIXES = ['token', 'secret', 'password', 'apikey', 'api_key', '_key'];

const isSecretKey = (key, extra) => {
  const lower = String(key).toLowerCase();
  if (extra.has(lower) || SECRET_KEY_EXACT.has(lower)) {
    return true;
  }
  return SECRET_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

const serialiseError = (error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  ...(error.code !== undefined ? { code: error.code } : {}),
});

const sanitise = (value, extra, depth = 0) => {
  if (value instanceof Error) {
    return serialiseError(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitise(item, extra, depth + 1));
  }
  if (value && typeof value === 'object' && depth < 8) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSecretKey(key, extra) ? REDACTED : sanitise(inner, extra, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
};

const formatPretty = (record) => {
  const { ts, level, run_id: runId, stage, event, ...rest } = record;
  delete rest.mono_ns;
  delete rest.service;
  const scope = [runId, stage].filter(Boolean).join('/');
  const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${ts} ${level.padEnd(5)} ${scope ? `[${scope}] ` : ''}${event}${tail}\n`;
};

/**
 * Create a logger.
 * @param {object} [options]
 * @param {string} [options.level] minimum level (trace, debug, info, warn, error)
 * @param {string} [options.format] 'json' (default) or 'pretty'
 * @param {import('stream').Writable} [options.stream] defaults to process.stderr
 * @param {object} [options.bindings] fields added to every line (run_id, stage, ...)
 * @param {string[]} [options.redact] extra keys to redact wherever they appear
 */
const createLogger = (options = {}) => {
  const { level = 'info', format = 'json', stream = process.stderr, bindings = {}, redact = [] } = options;
  const threshold = LEVELS.indexOf(level);
  const extra = new Set(redact.map((k) => String(k).toLowerCase()));

  const write = (lvl, event, fields) => {
    if (LEVELS.indexOf(lvl) < threshold) {
      return;
    }
    const record = {
      ts: new Date().toISOString(),
      mono_ns: process.hrtime.bigint().toString(),
      level: lvl,
      service: SERVICE,
      ...bindings,
      event,
      ...sanitise(fields || {}, extra),
    };
    stream.write(format === 'pretty' ? formatPretty(record) : `${JSON.stringify(record)}\n`);
  };

  const logger = {
    level,
    bindings,
    child: (more) => createLogger({ level, format, stream, bindings: { ...bindings, ...more }, redact }),
  };
  for (const lvl of LEVELS) {
    logger[lvl] = (event, fields) => write(lvl, event, fields);
  }
  return logger;
};

module.exports = { createLogger, LEVELS, SERVICE, sanitise };

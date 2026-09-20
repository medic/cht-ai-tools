'use strict';
// Twelve-factor configuration: flag, then environment, then default; validated at startup (FR-051, FR-055).
const { HARD_CAPS, SECRET_KEYS, VARIABLES, PACKAGE_PATHS } = require('./schema');
const { loadPolicy } = require('./policy');

const CONFIG_EXIT_CODE = 78;

class ConfigError extends Error {
  constructor(problems) {
    const lines = problems.map((p) => `${p.env}: ${p.message}`);
    super(`invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}): ${lines.join('; ')}`);
    this.name = 'ConfigError';
    this.code = CONFIG_EXIT_CODE;
    this.keys = problems.map((p) => p.env);
    this.problems = problems;
  }
}

const setPath = (target, dotted, value) => {
  const parts = dotted.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = cursor[part] || {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
};

const isNil = (value) => value === undefined || value === null;

const getPath = (target, dotted) => dotted.split('.')
  .reduce((acc, part) => (isNil(acc) ? undefined : acc[part]), target);

const isUnset = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const issueMessage = (error) => {
  const issues = error && error.issues ? error.issues : [];
  return issues.map((i) => i.message).join(', ') || 'invalid value';
};

const readDryRun = (env, flags) => {
  if (flags['dry-run'] === true) {
    return true;
  }
  const raw = env.AGENT_WATCHDOG_DRY_RUN;
  return typeof raw === 'string' && ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
};

// The engine decides whether the model key is required, so it is read ahead of the variable loop with the
// same precedence (flag, environment, default); an invalid value is reported by the enumeration itself.
const readEngine = (env, flags) => {
  if (!isUnset(flags.engine)) {
    return String(flags.engine).trim();
  }
  return isUnset(env.AGENT_WATCHDOG_ENGINE) ? 'sdk' : env.AGENT_WATCHDOG_ENGINE.trim();
};

/**
 * Build the configuration for one command.
 * @param {object} options
 * @param {object} [options.env] environment (defaults to process.env)
 * @param {object} [options.flags] parsed command-line flags
 * @param {string} [options.command] command being run; decides which values are required
 * @param {boolean} [options.withPolicy] also load the policy files (default true)
 * @returns {{ config: object, effective: object, sources: object, policy: object|null }}
 */
const loadConfig = ({ env = process.env, flags = {}, command = 'run', withPolicy = true } = {}) => {
  const config = { paths: { ...PACKAGE_PATHS } };
  const sources = {};
  const problems = [];
  const context = { command, dryRun: readDryRun(env, flags), engine: readEngine(env, flags) };

  for (const variable of VARIABLES) {
    let raw;
    let source;
    if (variable.flag && !isUnset(flags[variable.flag])) {
      raw = flags[variable.flag];
      source = 'flag';
    } else if (!isUnset(env[variable.env])) {
      raw = env[variable.env];
      source = 'env';
    } else if (variable.default !== undefined) {
      raw = variable.default;
      source = 'default';
    } else {
      raw = undefined;
      source = 'unset';
    }

    if (raw === undefined) {
      const required = typeof variable.required === 'function' ? variable.required(context) : false;
      if (required) {
        const hint = variable.hint ? ` (${variable.hint})` : '';
        problems.push({ env: variable.env, message: `required for command "${command}" but not set${hint}` });
      }
      sources[variable.env] = source;
      setPath(config, variable.path, null);
      continue;
    }

    const parsed = variable.schema.safeParse(raw);
    if (!parsed.success) {
      problems.push({ env: variable.env, message: issueMessage(parsed.error) });
      sources[variable.env] = source;
      setPath(config, variable.path, null);
      continue;
    }
    sources[variable.env] = source;
    setPath(config, variable.path, parsed.data);
  }

  // Derived values: defaults that depend on other values.
  for (const variable of VARIABLES) {
    if (getPath(config, variable.path) !== null) {
      continue;
    }
    if (variable.defaultFrom && !isNil(getPath(config, variable.defaultFrom))) {
      setPath(config, variable.path, getPath(config, variable.defaultFrom));
      sources[variable.env] = 'derived';
    } else if (variable.derive) {
      setPath(config, variable.path, variable.derive(config));
      sources[variable.env] = 'derived';
    }
  }

  if (problems.length) {
    throw new ConfigError(problems);
  }

  let policy = null;
  if (withPolicy) {
    policy = loadPolicy({ configDir: config.storage.configDir, defaultsDir: config.paths.defaultsDir });
  }

  return { config, effective: redact(config), sources, policy };
};

const redact = (config) => {
  const clone = JSON.parse(JSON.stringify(config));
  clone.secrets = Object.fromEntries(
    Object.entries(config.secrets || {}).map(([key, value]) => [key, isNil(value) ? null : '[redacted]']),
  );
  clone.hard_caps = { ...HARD_CAPS };
  return clone;
};

module.exports = { loadConfig, redact, ConfigError, HARD_CAPS, SECRET_KEYS, CONFIG_EXIT_CODE };

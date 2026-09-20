'use strict';
// Command dispatch: `agent-watchdog <command> [flags]` with node:util parseArgs (contracts/cli.md).
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const codes = require('./exit-codes');
const { createLogger } = require('../log/logger');
const { writeResult } = require('./streams');

const COMMANDS = ['run', 'replay', 'distill', 'calibrate', 'check', 'purge', 'tools-server'];

const OPTIONS = {
  date: { type: 'string' },
  project: { type: 'string', multiple: true },
  stage: { type: 'string' },
  engine: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  since: { type: 'string' },
  prompts: { type: 'string' },
  skill: { type: 'string' },
  label: { type: 'string' },
  compare: { type: 'boolean' },
  all: { type: 'boolean' },
  item: { type: 'string', multiple: true },
  week: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'run-dir': { type: 'string' },
  replay: { type: 'boolean' },
  server: { type: 'string' },
  'config-dir': { type: 'string' },
  'data-dir': { type: 'string' },
  'log-level': { type: 'string' },
  'log-format': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const USAGE = `agent-watchdog <command> [flags]

Commands:
  run           the daily pipeline (--date --project --stage --engine --dry-run --force --since)
  replay        regenerate findings for a stored run offline (--date --project --prompts --skill --label --from --to)
  distill       turn new corpus items into proposed pattern cards (--all --item)
  calibrate     weekly calibration report and threshold proposals (--week --project)
  check <url>   readiness check for a CHT deployment
  purge         apply retention (--dry-run)
  tools-server  serve the read-only tools over stdio for the CLI engine
                (--run-dir --data-dir --project --server --replay)

Global flags: --config-dir --data-dir --log-level --log-format --help --version
Logs are JSON lines on stderr; results go to stdout. Exit codes: see contracts/exit-codes.md.
`;

const parseCommandLine = (argv) => {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
    return { command: positionals[0], positionals: positionals.slice(1), flags: values };
  } catch (error) {
    throw new codes.ExitError(codes.USAGE, error.message);
  }
};

const loadCommand = (name) => {
  const file = path.join(__dirname, 'commands', `${name}.js`);
  return fs.existsSync(file) ? require(file) : null;
};

const packageVersion = () => require('../../package.json').version;

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the executable
 * @param {object} [io] env, stdout, stderr, and an optional `commands` map for tests
 * @returns {Promise<number>} exit code
 */
const main = async (argv, options = {}) => {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, commands = null } = options;
  const logger = createLogger({
    level: env.AGENT_WATCHDOG_LOG_LEVEL || 'info',
    format: env.AGENT_WATCHDOG_LOG_FORMAT || 'json',
    stream: stderr,
  });
  const exit = (code, reason, extra = {}) => {
    logger[code === 0 ? 'info' : 'error']('run.exit', { code, code_name: codes.nameOf(code), reason, ...extra });
    return code;
  };

  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    return exit(error.code, error.message);
  }
  const { command, positionals, flags } = parsed;

  if (flags.version) {
    writeResult(stdout, packageVersion());
    return 0;
  }
  if (flags.help || !command) {
    writeResult(stdout, USAGE);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    return exit(codes.USAGE, `unknown command "${command}"`);
  }

  const handler = (commands && commands[command]) || loadCommand(command);
  if (!handler) {
    return exit(codes.USAGE, `command "${command}" is not implemented in this build`);
  }

  try {
    const code = await handler({ command, flags, positionals, env, stdout, stderr, logger });
    const finalCode = code === undefined || code === null ? 0 : code;
    return exit(finalCode, finalCode === 0 ? 'completed' : 'command returned non-zero');
  } catch (error) {
    const knownCode = typeof error.code === 'number' && codes.nameOf(error.code) !== 'UNKNOWN';
    if (error instanceof codes.ExitError || knownCode) {
      return exit(error.code, error.message, { details: error.details || null });
    }
    return exit(codes.FAILED, error.message, { error });
  }
};

module.exports = { main, parseCommandLine, COMMANDS, OPTIONS, USAGE };

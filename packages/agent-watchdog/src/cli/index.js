'use strict';
// Command dispatch: `agent-watchdog <command> [flags]` with node:util parseArgs (contracts/cli.md).
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const codes = require('./exit-codes');
const { createLogger } = require('../log/logger');
const { writeResult } = require('./streams');
const { imageVersion } = require('../store/versions');

const COMMANDS = ['run', 'replay', 'distill', 'calibrate', 'check', 'purge', 'egress', 'tools-server'];

// The flags each command owns (contracts/cli.md); one table is parsed for every command, so a flag of another
// command is refused here with exit 64 rather than silently ignored (revision 35: `replay --stage` ran a replay).
const GLOBAL_FLAGS = ['config-dir', 'data-dir', 'log-level', 'log-format', 'help', 'version'];
const COMMAND_FLAGS = {
  run: ['date', 'project', 'group', 'stage', 'engine', 'dry-run', 'force', 'since'],
  replay: ['date', 'project', 'group', 'prompts', 'skill', 'label', 'compare', 'from', 'to', 'engine'],
  distill: ['all', 'item'],
  calibrate: ['week', 'project'],
  check: [],
  purge: ['dry-run'],
  egress: ['format'],
  'tools-server': ['run-dir', 'project', 'server', 'replay'],
};
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const LOG_FORMATS = ['json', 'pretty'];

const OPTIONS = {
  date: { type: 'string' },
  project: { type: 'string', multiple: true },
  group: { type: 'string', multiple: true },
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
  format: { type: 'string' },
  'config-dir': { type: 'string' },
  'data-dir': { type: 'string' },
  'log-level': { type: 'string' },
  'log-format': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const USAGE = `agent-watchdog <command> [flags]

Commands:
  run           the daily pipeline (--date --project --group --stage --engine --dry-run --force --since)
                --group <label> analyses one programme's projects (repeatable, combines with --project)
  replay        regenerate findings for a stored run offline (--date --project --prompts --skill --label --from --to)
  distill       turn new corpus items into proposed pattern cards (--all --item)
  calibrate     weekly calibration report and threshold proposals (--week --project)
  check <url>   readiness check for a CHT deployment
  purge         apply retention (--dry-run)
  egress        the destinations a run contacts, for the platform's network policy (--format json|hosts)
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
  let logger = createLogger({
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
    writeResult(stdout, imageVersion(env) || packageVersion());
    return 0;
  }
  if (flags.help || !command) {
    writeResult(stdout, USAGE);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    return exit(codes.USAGE, `unknown command "${command}"`);
  }
  // The log flags apply to the command's logger (revision 35); a value outside the contract is a usage error.
  const level = flags['log-level'];
  const format = flags['log-format'];
  if (level !== undefined && !LOG_LEVELS.includes(level)) {
    return exit(codes.USAGE, `--log-level must be one of ${LOG_LEVELS.join(', ')}, got "${level}"`);
  }
  if (format !== undefined && !LOG_FORMATS.includes(format)) {
    return exit(codes.USAGE, `--log-format must be one of ${LOG_FORMATS.join(', ')}, got "${format}"`);
  }
  if (level !== undefined || format !== undefined) {
    logger = createLogger({
      level: level || env.AGENT_WATCHDOG_LOG_LEVEL || 'info',
      format: format || env.AGENT_WATCHDOG_LOG_FORMAT || 'json',
      stream: stderr,
    });
  }
  const owned = new Set([...GLOBAL_FLAGS, ...COMMAND_FLAGS[command]]);
  const foreign = Object.keys(flags).find((name) => !owned.has(name));
  if (foreign) {
    return exit(codes.USAGE, `--${foreign} is not a flag of ${command}`);
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

module.exports = {
  COMMAND_FLAGS, GLOBAL_FLAGS, main, parseCommandLine, COMMANDS, OPTIONS, USAGE };

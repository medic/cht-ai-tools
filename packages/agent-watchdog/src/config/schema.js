'use strict';
// Configuration variables: names, types, defaults and hard caps (contracts/environment.md).
const path = require('node:path');
const { z } = require('zod');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

// Safety rails: values above these are rejected at startup whatever the environment says (FR-054).
const HARD_CAPS = Object.freeze({
  maxBudgetUsdProject: 10,
  maxBudgetUsdRun: 100,
  maxTurns: 50,
  passes: 4,
  projectConcurrency: 8,
  modelTimeoutMs: 1800000,
  httpTimeoutMs: 60000,
  verifyMaxRetries: 2,
  runTimeoutMs: 7200000,
});

const SECRET_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'SLACK_BOT_TOKEN',
  'AGENT_WATCHDOG_GRAFANA_TOKEN',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'AGENT_WATCHDOG_DOCS_MCP_TOKEN',
]);

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ENGINES = ['sdk', 'cli'];
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const LOG_FORMATS = ['json', 'pretty'];

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

const bool = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  const lower = value.trim().toLowerCase();
  if (TRUE_WORDS.includes(lower)) {
    return true;
  }
  if (FALSE_WORDS.includes(lower)) {
    return false;
  }
  return value;
}, z.boolean());

const int = (min, max) => z.coerce.number().int().min(min).max(max);
const num = (min, max) => z.coerce.number().min(min).max(max);
const text = z.string().min(1);
const url = z.url();

const modelCommands = ['run', 'replay', 'distill', 'calibrate'];
const forRun = ({ command }) => command === 'run';
const forModel = ({ command }) => modelCommands.includes(command);
const forPosting = ({ command, dryRun }) => command === 'run' && !dryRun;

// Each entry: environment name, dotted config path, zod schema, default, requiredness, flag alias.
const VARIABLES = [
  {
    env: 'ANTHROPIC_API_KEY',
    path: 'secrets.anthropicApiKey',
    schema: text,
    secret: true,
    required: forModel,
  },
  {
    env: 'SLACK_BOT_TOKEN',
    path: 'secrets.slackBotToken',
    schema: text,
    secret: true,
    required: forPosting,
  },
  {
    env: 'AGENT_WATCHDOG_GRAFANA_TOKEN',
    path: 'secrets.grafanaToken',
    schema: text,
    secret: true,
    required: forRun,
  },
  {
    env: 'LANGFUSE_PUBLIC_KEY',
    path: 'secrets.langfusePublicKey',
    schema: text,
    secret: true,
    required: forModel,
  },
  {
    env: 'LANGFUSE_SECRET_KEY',
    path: 'secrets.langfuseSecretKey',
    schema: text,
    secret: true,
    required: forModel,
  },
  {
    env: 'AGENT_WATCHDOG_DOCS_MCP_TOKEN',
    path: 'secrets.docsMcpToken',
    schema: text,
    secret: true,
  },
  {
    env: 'AGENT_WATCHDOG_MODEL',
    path: 'model.name',
    schema: text,
    default: 'claude-fable-5-1',
  },
  {
    env: 'AGENT_WATCHDOG_EFFORT',
    path: 'model.effort',
    schema: z.enum(EFFORT_LEVELS),
    default: 'max',
  },
  {
    env: 'AGENT_WATCHDOG_MODEL_FEEDBACK',
    path: 'model.feedback',
    schema: text,
    defaultFrom: 'model.name',
  },
  {
    env: 'AGENT_WATCHDOG_MODEL_CALIBRATION',
    path: 'model.calibration',
    schema: text,
    defaultFrom: 'model.name',
  },
  {
    env: 'AGENT_WATCHDOG_MODEL_DISTILL',
    path: 'model.distill',
    schema: text,
    defaultFrom: 'model.name',
  },
  {
    env: 'AGENT_WATCHDOG_ENGINE',
    path: 'model.engine',
    schema: z.enum(ENGINES),
    default: 'sdk',
    flag: 'engine',
  },
  {
    env: 'AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT',
    path: 'bounds.maxBudgetUsdProject',
    schema: num(0.01, HARD_CAPS.maxBudgetUsdProject),
    default: 2,
  },
  {
    env: 'AGENT_WATCHDOG_MAX_BUDGET_USD_RUN',
    path: 'bounds.maxBudgetUsdRun',
    schema: num(0.01, HARD_CAPS.maxBudgetUsdRun),
    default: 25,
  },
  {
    env: 'AGENT_WATCHDOG_MAX_TURNS',
    path: 'bounds.maxTurns',
    schema: int(1, HARD_CAPS.maxTurns),
    default: 20,
  },
  {
    env: 'AGENT_WATCHDOG_MODEL_TIMEOUT_MS',
    path: 'bounds.modelTimeoutMs',
    schema: int(1000, HARD_CAPS.modelTimeoutMs),
    default: 900000,
  },
  {
    env: 'AGENT_WATCHDOG_HTTP_TIMEOUT_MS',
    path: 'bounds.httpTimeoutMs',
    schema: int(100, HARD_CAPS.httpTimeoutMs),
    default: 15000,
  },
  {
    env: 'AGENT_WATCHDOG_VERIFY_MAX_RETRIES',
    path: 'bounds.verifyMaxRetries',
    schema: int(0, HARD_CAPS.verifyMaxRetries),
    default: 2,
  },
  {
    env: 'AGENT_WATCHDOG_PASSES',
    path: 'bounds.passes',
    schema: int(1, HARD_CAPS.passes),
    default: 2,
  },
  {
    env: 'AGENT_WATCHDOG_PASS_CONVERGENCE',
    path: 'bounds.passConvergence',
    schema: bool,
    default: true,
  },
  {
    env: 'AGENT_WATCHDOG_RUN_TIMEOUT_MS',
    path: 'bounds.runTimeoutMs',
    schema: int(60000, HARD_CAPS.runTimeoutMs),
    default: 3600000,
  },
  {
    env: 'AGENT_WATCHDOG_PROJECT_CONCURRENCY',
    path: 'bounds.projectConcurrency',
    schema: int(1, HARD_CAPS.projectConcurrency),
    default: 3,
  },
  {
    env: 'AGENT_WATCHDOG_GRAFANA_URL',
    path: 'endpoints.grafanaUrl',
    schema: url,
    required: forRun,
  },
  {
    env: 'AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID',
    path: 'endpoints.prometheusDatasourceUid',
    schema: text,
    required: forRun,
  },
  {
    env: 'AGENT_WATCHDOG_SLACK_CHANNEL_ID',
    path: 'endpoints.slackChannelId',
    schema: text,
    required: forPosting,
  },
  {
    env: 'AGENT_WATCHDOG_DOCS_MCP_URL',
    path: 'endpoints.docsMcpUrl',
    schema: url,
    required: forModel,
  },
  {
    env: 'LANGFUSE_BASE_URL',
    path: 'endpoints.langfuseBaseUrl',
    schema: url,
    required: forModel,
  },
  {
    env: 'AGENT_WATCHDOG_PROMPTS_URL',
    path: 'endpoints.promptsUrl',
    schema: url,
    required: forRun,
  },
  {
    env: 'AGENT_WATCHDOG_CONFIG_URL',
    path: 'endpoints.configUrl',
    schema: url,
    required: forRun,
  },
  {
    env: 'AGENT_WATCHDOG_DATA_DIR',
    path: 'storage.dataDir',
    schema: text,
    default: '/data',
    flag: 'data-dir',
  },
  {
    env: 'AGENT_WATCHDOG_CONFIG_DIR',
    path: 'storage.configDir',
    schema: text,
    default: '/etc/agent-watchdog',
    flag: 'config-dir',
  },
  {
    env: 'AGENT_WATCHDOG_CORPUS_RAW_DIR',
    path: 'storage.corpusRawDir',
    schema: text,
    derive: (config) => path.join(config.storage.dataDir, 'knowledge-corpus', 'raw'),
  },
  {
    env: 'AGENT_WATCHDOG_RETENTION_RAW_DAYS',
    path: 'storage.retentionRawDays',
    schema: int(1, 3650),
    default: 14,
  },
  {
    env: 'AGENT_WATCHDOG_RETENTION_DAYS',
    path: 'storage.retentionDays',
    schema: int(1, 3650),
    default: 30,
  },
  {
    env: 'AGENT_WATCHDOG_FEEDBACK_LOOKBACK_RUNS',
    path: 'behaviour.feedbackLookbackRuns',
    schema: int(1, 90),
    default: 7,
  },
  {
    env: 'AGENT_WATCHDOG_MEMORY_MAX_TOKENS',
    path: 'behaviour.memoryMaxTokens',
    schema: int(500, 100000),
    default: 4000,
  },
  {
    env: 'AGENT_WATCHDOG_DRY_RUN',
    path: 'behaviour.dryRun',
    schema: bool,
    default: false,
    flag: 'dry-run',
  },
  {
    env: 'AGENT_WATCHDOG_LOG_LEVEL',
    path: 'logging.level',
    schema: z.enum(LOG_LEVELS),
    default: 'info',
    flag: 'log-level',
  },
  {
    env: 'AGENT_WATCHDOG_LOG_FORMAT',
    path: 'logging.format',
    schema: z.enum(LOG_FORMATS),
    default: 'json',
    flag: 'log-format',
  },
  {
    env: 'MCP_TIMEOUT',
    path: 'runtime.mcpTimeoutMs',
    schema: int(1000, 600000),
    default: 30000,
  },
  {
    env: 'AGENT_WATCHDOG_CHROMIUM_PATH',
    path: 'runtime.chromiumPath',
    schema: text,
  },
];

// Paths inside the package that the run reads but never writes (constitution VII).
const PACKAGE_PATHS = Object.freeze({
  packageRoot: PACKAGE_ROOT,
  defaultsDir: path.join(PACKAGE_ROOT, 'config', 'defaults'),
  promptsDir: path.join(PACKAGE_ROOT, 'prompts'),
  skillDir: path.join(PACKAGE_ROOT, 'skill', 'cht-watchdog'),
  schemaDir: path.join(PACKAGE_ROOT, 'schema'),
  templatesDir: path.join(PACKAGE_ROOT, 'templates'),
  agentDir: path.join(PACKAGE_ROOT, 'agent'),
});

module.exports = { HARD_CAPS, SECRET_KEYS, VARIABLES, PACKAGE_PATHS, EFFORT_LEVELS, ENGINES, LOG_LEVELS, LOG_FORMATS };

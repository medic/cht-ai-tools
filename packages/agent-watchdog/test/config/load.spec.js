const path = require('node:path');
const { loadConfig, ConfigError, HARD_CAPS, SECRET_KEYS } = require('../../src/config/load');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');

const baseEnv = () => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  AGENT_WATCHDOG_GRAFANA_TOKEN: 'glsa_test',
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
  AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
  AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID: 'PBFA97CFB590B2093',
  AGENT_WATCHDOG_SLACK_CHANNEL_ID: 'C123',
  AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
  LANGFUSE_BASE_URL: 'https://langfuse.example.org',
  AGENT_WATCHDOG_PROMPTS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts',
  AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
  AGENT_WATCHDOG_DATA_DIR: '/tmp/agent-watchdog-test-data',
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
});

describe('config/load', () => {
  it('applies defaults from the environment contract when a variable is unset', () => {
    const { config, sources } = loadConfig({ env: baseEnv(), command: 'run' });
    expect(config.model.name).to.equal('claude-fable-5-1');
    expect(config.model.effort).to.equal('max');
    expect(config.model.engine).to.equal('sdk');
    expect(config.bounds.maxTurns).to.equal(20);
    expect(config.bounds.passes).to.equal(2);
    expect(config.bounds.passConvergence).to.equal(true);
    expect(config.bounds.maxBudgetUsdProject).to.equal(2);
    expect(config.bounds.maxBudgetUsdRun).to.equal(25);
    expect(config.bounds.runTimeoutMs).to.equal(3600000);
    expect(config.bounds.projectConcurrency).to.equal(3);
    expect(config.storage.retentionRawDays).to.equal(14);
    expect(config.storage.retentionDays).to.equal(30);
    expect(config.behaviour.feedbackLookbackRuns).to.equal(7);
    expect(config.behaviour.memoryMaxTokens).to.equal(4000);
    expect(config.behaviour.dryRun).to.equal(false);
    expect(config.logging.level).to.equal('info');
    expect(config.logging.format).to.equal('json');
    expect(config.storage.corpusRawDir).to.equal('/tmp/agent-watchdog-test-data/knowledge-corpus/raw');
    expect(sources.AGENT_WATCHDOG_MODEL).to.equal('default');
  });

  it('prefers a flag over the environment and the environment over the default', () => {
    const env = { ...baseEnv(), AGENT_WATCHDOG_ENGINE: 'cli', AGENT_WATCHDOG_LOG_LEVEL: 'debug' };
    const { config, sources } = loadConfig({ env, flags: { engine: 'sdk', 'dry-run': true }, command: 'run' });
    expect(config.model.engine).to.equal('sdk');
    expect(sources.AGENT_WATCHDOG_ENGINE).to.equal('flag');
    expect(config.logging.level).to.equal('debug');
    expect(sources.AGENT_WATCHDOG_LOG_LEVEL).to.equal('env');
    expect(config.behaviour.dryRun).to.equal(true);
  });

  it('coerces numbers and booleans from strings', () => {
    const env = {
      ...baseEnv(),
      AGENT_WATCHDOG_MAX_TURNS: '12',
      AGENT_WATCHDOG_PASS_CONVERGENCE: 'false',
      AGENT_WATCHDOG_DRY_RUN: 'true',
    };
    const { config } = loadConfig({ env, command: 'run' });
    expect(config.bounds.maxTurns).to.equal(12);
    expect(config.bounds.passConvergence).to.equal(false);
    expect(config.behaviour.dryRun).to.equal(true);
  });

  it('exposes the hard caps and rejects values above them with exit code 78', () => {
    expect(HARD_CAPS).to.include({
      maxBudgetUsdProject: 10, maxBudgetUsdRun: 100, maxTurns: 50, passes: 4, projectConcurrency: 8,
      modelTimeoutMs: 1800000, httpTimeoutMs: 60000, verifyMaxRetries: 2,
    });
    const env = { ...baseEnv(), AGENT_WATCHDOG_MAX_BUDGET_USD_RUN: '500', AGENT_WATCHDOG_PASSES: '9' };
    let error;
    try {
      loadConfig({ env, command: 'run' }); 
    } catch (e) {
      error = e; 
    }
    expect(error).to.be.instanceOf(ConfigError);
    expect(error.code).to.equal(78);
    expect(error.keys).to.include.members(['AGENT_WATCHDOG_MAX_BUDGET_USD_RUN', 'AGENT_WATCHDOG_PASSES']);
  });

  it('requires a minimum of one pass', () => {
    const env = { ...baseEnv(), AGENT_WATCHDOG_PASSES: '0' };
    expect(() => loadConfig({ env, command: 'run' })).to.throw(ConfigError);
  });

  it('names missing required values without printing them and exits 78', () => {
    const env = baseEnv();
    delete env.ANTHROPIC_API_KEY;
    delete env.AGENT_WATCHDOG_GRAFANA_URL;
    let error;
    try {
      loadConfig({ env, command: 'run' }); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(78);
    expect(error.keys).to.include.members(['ANTHROPIC_API_KEY', 'AGENT_WATCHDOG_GRAFANA_URL']);
    expect(error.message).to.not.include('sk-ant');
  });

  it('rejects invalid enumerations and bad URLs, redacting secret values in the message', () => {
    const env = {
      ...baseEnv(),
      AGENT_WATCHDOG_EFFORT: 'extreme',
      AGENT_WATCHDOG_GRAFANA_URL: 'not a url',
      SLACK_BOT_TOKEN: 'xoxb-secret-value',
    };
    let error;
    try {
      loadConfig({ env, command: 'run' }); 
    } catch (e) {
      error = e; 
    }
    expect(error.keys).to.include.members(['AGENT_WATCHDOG_EFFORT', 'AGENT_WATCHDOG_GRAFANA_URL']);
    expect(error.message).to.not.include('xoxb-secret-value');
  });

  it('does not require the Slack token in dry-run mode, but does otherwise', () => {
    const env = baseEnv();
    delete env.SLACK_BOT_TOKEN;
    expect(() => loadConfig({ env, flags: { 'dry-run': true }, command: 'run' })).to.not.throw();
    expect(() => loadConfig({ env, command: 'run' })).to.throw(ConfigError);
  });

  it('requires no credentials for the readiness check command', () => {
    const env = { AGENT_WATCHDOG_DATA_DIR: '/tmp/x', AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR };
    expect(() => loadConfig({ env, command: 'check' })).to.not.throw();
  });

  it('produces a redacted effective configuration that never contains a secret value', () => {
    const { effective } = loadConfig({ env: baseEnv(), command: 'run' });
    const text = JSON.stringify(effective);
    for (const key of SECRET_KEYS) {
      expect(text).to.not.include(baseEnv()[key] || 'never');
    }
    expect(effective.secrets.anthropicApiKey).to.equal('[redacted]');
    expect(effective.secrets.docsMcpToken).to.equal(null);
    expect(effective.model.name).to.equal('claude-fable-5-1');
  });

  it('reads the optional claude executable path for the cli engine', () => {
    const unset = loadConfig({ env: baseEnv(), command: 'run' });
    expect(unset.config.runtime.claudePath).to.equal(null);
    const env = { ...baseEnv(), AGENT_WATCHDOG_CLAUDE_PATH: '/opt/claude/bin/claude' };
    const { config, sources } = loadConfig({ env, command: 'run' });
    expect(config.runtime.claudePath).to.equal('/opt/claude/bin/claude');
    expect(sources.AGENT_WATCHDOG_CLAUDE_PATH).to.equal('env');
    expect(() => loadConfig({ env: { ...baseEnv(), AGENT_WATCHDOG_CLAUDE_PATH: '' }, command: 'run' })).to.not.throw();
  });
});

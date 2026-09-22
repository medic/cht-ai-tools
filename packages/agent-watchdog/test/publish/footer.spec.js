const path = require('node:path');
const { buildFooter, formatCost } = require('../../src/publish/footer');
const { footerText, buildPayload } = require('../../src/publish/payload');
const { loadConfig } = require('../../src/config/load');
const { makeItem, makeBrief } = require('../rollup/factories');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const SPECS_URL = 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop';
const CONFIG_URL = 'https://github.com/medic/medic-infrastructure/tree/main/agent-watchdog';
const TRACE_URL = 'https://langfuse.example.org/trace/t1';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  AGENT_WATCHDOG_GRAFANA_TOKEN: 'glsa_test',
  LANGFUSE_PUBLIC_KEY: 'pk',
  LANGFUSE_SECRET_KEY: 'sk',
  AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
  AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID: 'PBFA97CFB590B2093',
  AGENT_WATCHDOG_SLACK_CHANNEL_ID: 'C123',
  AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
  LANGFUSE_BASE_URL: 'https://langfuse.example.org',
  AGENT_WATCHDOG_SPECS_URL: SPECS_URL,
  AGENT_WATCHDOG_CONFIG_URL: CONFIG_URL,
  AGENT_WATCHDOG_DATA_DIR: '/tmp/agent-watchdog-footer-spec',
  AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
};

describe('publish/footer', () => {
  const { config } = loadConfig({ env, command: 'run', withPolicy: false });

  it('carries the specification and configuration links from the environment, the trace URL and the cost', () => {
    const footer = buildFooter({ config, traceUrl: TRACE_URL, costUsd: 0.123456789 });
    expect(footer).to.deep.equal({
      specs_url: SPECS_URL, config_url: CONFIG_URL, trace_url: TRACE_URL, cost_usd: 0.123457,
    });
  });

  it('defaults the trace to null and the cost to zero', () => {
    expect(buildFooter({ config })).to.deep.equal({
      specs_url: SPECS_URL, config_url: CONFIG_URL, trace_url: null, cost_usd: 0,
    });
  });

  it('formats the cost in US dollars with two decimals', () => {
    expect(formatCost(0.1234)).to.equal('$0.12');
    expect(formatCost(12.5)).to.equal('$12.50');
    expect(formatCost(0)).to.equal('$0.00');
    expect(formatCost(null)).to.equal('$0.00');
    expect(formatCost(undefined)).to.equal('$0.00');
  });

  it('renders the one footer line of post and report: specs, configuration, trace, cost, run id (revision 25)', () => {
    const text = footerText(buildFooter({ config, traceUrl: TRACE_URL, costUsd: 0.1234 }), { runId: '2026-09-18' });
    expect(text).to.equal(
      `<${SPECS_URL}|specs> · <${CONFIG_URL}|configuration> · <${TRACE_URL}|trace> · cost $0.12 · run 2026-09-18`,
    );
    const offline = footerText(buildFooter({ config, costUsd: 2 }));
    expect(offline).to.not.include('|trace>');
    expect(offline).to.include('cost $2.00');
    expect(offline).to.not.include('run ');
    const withMore = footerText(buildFooter({ config, costUsd: 2 }), { runId: 'r1', furtherItems: 3 });
    expect(withMore.endsWith('cost $2.00 · run r1 · 3 more items in the report (thread)')).to.equal(true);
    expect(text).to.not.include('prompts');
  });

  it('puts the footer in the last context block of the parent message', () => {
    const item = makeItem({ rank: 1, placement: 'body' });
    const brief = makeBrief({
      bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }],
      footer: buildFooter({ config, traceUrl: TRACE_URL, costUsd: 0.5 }),
    });
    const payload = buildPayload({
      brief, items: [item], links: new Map(), runId: '2026-09-18', date: '2026-09-18', audience: 'internal',
      channel: 'C123',
    });
    const last = payload.parent.blocks[payload.parent.blocks.length - 1];
    expect(last.type).to.equal('context');
    expect(last.elements[0].text).to.include(`<${SPECS_URL}|specs>`);
    expect(last.elements[0].text).to.include('run 2026-09-18');
    expect(last.elements[0].text).to.include(`<${CONFIG_URL}|configuration>`);
    expect(last.elements[0].text).to.include(`<${TRACE_URL}|trace>`);
    expect(last.elements[0].text).to.include('cost $0.50');
  });

  it('keeps the trace link on a heartbeat, which has no blocks', () => {
    const brief = makeBrief({
      kind: 'heartbeat', bullets: [], headline: 'Quiet day: 3 projects checked',
      footer: buildFooter({ config, traceUrl: TRACE_URL, costUsd: 0 }),
    });
    const payload = buildPayload({
      brief, items: [], links: new Map(), runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C1',
    });
    expect(payload.parent.text).to.include(TRACE_URL);
  });
});

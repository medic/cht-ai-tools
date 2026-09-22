// SC-006: a maintainer can replay thirty days of stored runs against a changed prompt in under ten minutes.
// The model is a fake that returns recorded findings, so this measures the harness: copying, tool serving,
// the gate adapter, comparison and bookkeeping for thirty runs.
const path = require('node:path');
const { Writable } = require('node:stream');
const replayCommand = require('../../src/cli/commands/replay');
const { createLogger } = require('../../src/log/logger');
const { itemId } = require('../../src/model/identity');
const { createFakeEngine } = require('../helpers/fake-engine');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { buildStoredRun, METRIC } = require('../helpers/stored-run');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');
const TEN_MINUTES_MS = 600000;
const DAYS = 30;

const sink = () => new Writable({
  write(c, e, cb) {
    cb();
  },
});

const dateOf = (index) => new Date(Date.UTC(2026, 7, 20 + index)).toISOString().slice(0, 10);

const gate = async ({ findings, project, pass }) => ({
  report: {
    subject: 'pass', subject_ref: `${project.slug}/pass${pass}`, attempt: 1, outcome: 'accepted',
    checks: [{ name: 'schema', status: 'pass', reasons: [] }],
  },
  items: (findings.items || []).map((item) => ({
    item_id: itemId(project.url, item.item_key.metric, item.item_key.pattern_card),
    project_url: project.url, metric: item.item_key.metric, severity: item.severity, evidence: item.evidence,
    why_now: item.why_now, suggested_check: item.suggested_check,
    // The real gate builds this from the run's windows (FR-009, revision 18).
    dashboard_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, project_url: project.url,
      from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z' }, confidence: item.confidence,
    persisting_days: 1, pattern_card: item.item_key.pattern_card, candidate_ids: item.candidate_ids,
    reference_urls: item.reference_urls, rank: null, placement: null, pass_history: [],
  })),
});

// Answers with the recorded findings of whichever project the prompt is about.
const recordedEngine = () => createFakeEngine({
  responses: (userText) => {
    const url = /https:\/\/[a-z]+\.example\.org/.exec(userText)[0];
    const ids = [...new Set(userText.match(/\b[0-9a-f]{12}\b/g) || [])];
    return {
      structuredOutput: {
        project_url: url, pass: 1, not_selected: [], changes: [], converged: true, notes: '',
        items: [{
          item_key: { metric: METRIC, pattern_card: null }, severity: 'high',
          evidence: [{ window: 'current', value: 912, unit: 'count' }],
          why_now: 'Sentinel backlog has climbed steadily.', suggested_check: 'Check sentinel logs.',
          confidence: 0.85, candidate_ids: ids, reference_urls: [],
        }],
      },
    };
  },
});

describe('perf: replay thirty days (SC-006)', function () {
  this.timeout(TEN_MINUTES_MS);
  let dataDir;
  before(async () => {
    dataDir = tempDir();
    for (let i = 0; i < DAYS; i += 1) {
      await buildStoredRun({
        dataDir, runId: dateOf(i), hosts: ['alpha.example.org', 'beta.example.org', 'gamma.example.org'],
      });
    }
  });
  after(() => removeDir(dataDir));

  it('replays thirty stored runs with recorded model outputs in under ten minutes', async function () {
    const started = process.hrtime.bigint();
    const out = [];
    const code = await replayCommand({
      command: 'replay',
      flags: { from: dateOf(0), to: dateOf(DAYS - 1), label: 'thirty' },
      positionals: [],
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-test', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk',
        AGENT_WATCHDOG_GRAFANA_URL: 'https://watchdog.example.org',
        AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp',
        LANGFUSE_BASE_URL: 'https://langfuse.example.org',
        AGENT_WATCHDOG_SPECS_URL: 'https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/specs/001-watchdog-slack-loop',
        AGENT_WATCHDOG_CONFIG_URL: 'https://github.com/medic/medic-infrastructure',
        AGENT_WATCHDOG_DATA_DIR: dataDir, AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR,
      },
      stdout: new Writable({
        write(c, e, cb) {
          out.push(c.toString());
          cb();
        },
      }),
      stderr: sink(),
      logger: createLogger({ stream: sink(), level: 'error' }),
      deps: {
        engine: recordedEngine(),
        gate,
        fetch: sinon.stub().rejects(new Error('no network in replay')),
        gitSha: 'perf',
        tracer: {
          start: async () => ({ traceId: 't' }), stage: async (name, fn) => fn(), generation() {},
          traceUrl: async () => null, finish: async () => {}, traceId: 't',
        },
      },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.test.title += ` (${Math.round(elapsedMs)} ms for ${DAYS} runs)`;
    expect(code).to.equal(0);
    const printed = JSON.parse(out.join(''));
    expect(printed.summary.runs).to.equal(DAYS);
    expect(printed.summary.replayed).to.equal(DAYS);
    expect(printed.summary.failed).to.deep.equal([]);
    expect(printed.summary.after_items).to.equal(DAYS * 3);
    expect(elapsedMs).to.be.below(TEN_MINUTES_MS);
  });
});

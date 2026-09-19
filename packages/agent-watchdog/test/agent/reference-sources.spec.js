const fs = require('node:fs');
const path = require('node:path');
const { runProjectSession } = require('../../src/agent/session-loop');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { RunDir } = require('../../src/store/run-dir');
const { createFakeEngine } = require('../helpers/fake-engine');
const { createLogger } = require('../../src/log/logger');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { Writable } = require('node:stream');

const definition = loadDefinition({ paths: PACKAGE_PATHS, env: { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://d/mcp' } });
const project = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const logger = createLogger({ level: 'error', stream: new Writable({ write(c, e, cb) {
  cb(); 
} }) });
const gate = async ({ findings }) => ({
  report: { subject: 'pass', subject_ref: 'x', attempt: 1, checks: [], outcome: 'accepted' },
  items: (findings && findings.items ? findings.items : []).map(() => ({
    item_id: 'abcdefabcdef', project_url: project.url, metric: 'cht_conflict_count', severity: 'low',
    evidence: [], why_now: 'w', suggested_check: 's', confidence: 0.5, persisting_days: 1, pattern_card: null,
    dashboard_ref: {
      dashboard_uid: 'd', panel_id: 1, project_url: project.url,
      from: '2026-09-17T06:00:00Z', to: '2026-09-18T06:00:00Z',
    },
    candidate_ids: ['c1'], reference_urls: [], rank: null, placement: null, pass_history: [],
  })),
});
const findings = {
  project_url: project.url, pass: 1, items: [], not_selected: [], changes: [], converged: true, notes: '',
};

describe('agent/session-loop reference sources (T112, T113)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const run = (engine) => runProjectSession({
    engine, definition, project, changes: [], feedback: [],
    candidates: [{ candidate_id: 'c1', metric: 'cht_conflict_count' }],
    memory: '', activeWindow: null, gate, runDir, logger, tracer: null, localTools: [],
    config: {
      model: { name: 'm', effort: 'max' },
      bounds: {
        maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000, verifyMaxRetries: 0, passes: 2,
        passConvergence: true,
      },
    },
  });

  it('flags the session when a turn reports the documentation service unavailable and proceeds', async () => {
    const engine = createFakeEngine({ responses: [
      { structuredOutput: findings, referenceUnavailable: true },
      { structuredOutput: { ...findings, pass: 2 } },
    ] });
    const result = await run(engine);
    expect(result.reference_sources_unavailable).to.equal(true);
    const record = JSON.parse(fs.readFileSync(path.join(runDir.root, project.slug, 'session.json'), 'utf8'));
    expect(record.reference_sources_unavailable).to.equal(true);
    expect(engine.sessions[0].turns.length).to.be.greaterThan(0);
  });

  it('leaves the flag false when every turn reached its reference sources', async () => {
    const engine = createFakeEngine({
      responses: [{ structuredOutput: findings }, { structuredOutput: { ...findings, pass: 2 } }],
    });
    const result = await run(engine);
    expect(result.reference_sources_unavailable).to.equal(false);
  });
});

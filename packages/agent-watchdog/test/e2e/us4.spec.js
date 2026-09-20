// End-to-end User Story 4: self-improvement under review. Real stages on the synthetic fixtures, a scripted
// model that proposes and condenses, a stubbed Slack client and a fake browser. Nothing touches the network,
// and nothing the agent does may change a reviewed file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const calibrate = require('../../src/cli/commands/calibrate');
const { readProposals } = require('../../src/rollup/proposals');
const { createLogger } = require('../../src/log/logger');
const { buildCalibrationHistory, expectedFor } = require('../helpers/calibration-runs');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase, envFor, capture, fakeTracer } = require('./helpers');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const REVIEWED = ['prompts', 'skill', 'schema', 'agent', path.join('config', 'defaults')];

const hashTree = (dir) => {
  const hash = crypto.createHash('sha256');
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        hash.update(path.relative(dir, full)).update('\0').update(fs.readFileSync(full)).update('\0');
      }
    }
  };
  visit(dir);
  return hash.digest('hex');
};

const reviewedHashes = () => Object.fromEntries(REVIEWED.map((rel) => [rel, hashTree(path.join(PACKAGE_ROOT, rel))]));

const longMemory = (lines) => Array.from({ length: lines }, (_, i) => (
  `- note ${String(i + 1).padStart(2, '0')}: sentinel backlog on one project stayed high through month-end sync`
)).join('\n') + '\n';

describe('e2e: User Story 4, self-improvement under review', function () {
  this.timeout(60000);
  const dirs = [];
  const fresh = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      removeDir(dirs.pop());
    }
  });

  it('scenario 1: a learned pattern becomes an evidence-backed proposal and no reviewed file changes', async () => {
    const before = reviewedHashes();
    const dataDir = fresh();
    const proposal = {
      type: 'skill',
      title: 'Sentinel backlog climbs for hours before tripling',
      body: 'A sentinel backlog that rises monotonically for six hours or more and ends above three times the '
        + 'previous day (912 vs 300 in today\'s evidence) preceded a stuck transition each time it was confirmed. '
        + 'Add a transition-queue check to the skill\'s sentinel section.',
    };
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, proposals: [proposal] });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('published');

    const proposals = await readProposals(dataDir);
    expect(proposals).to.have.length(1);
    const [written] = proposals;
    expect(written.proposal_id).to.equal('2026-09-18-skill-sentinel-backlog-climbs-for-hours-before-tripling');
    expect(written).to.include({ type: 'skill', run_id: r.runId, status: 'proposed', title: proposal.title });
    expect(written.flags).to.deep.equal([]);
    expect(written.body).to.include('912 vs 300');
    expect(written.body).to.not.match(/example\.org/);
    expect(fs.existsSync(path.join(dataDir, 'proposals', `${written.proposal_id}.md`))).to.equal(true);
    expect(fs.existsSync(path.join(r.root, 'proposals', `${written.proposal_id}.md`))).to.equal(true);
    expect(r.read('rollup/rollup-output.json').proposal_ids).to.deep.equal([written.proposal_id]);

    expect(reviewedHashes()).to.deep.equal(before);
    expect(fs.existsSync(path.join(dataDir, 'prompts'))).to.equal(false);
  });

  it('scenario 2: at the memory cap the agent condenses within the cap as a diff and the run succeeds', async () => {
    const overCap = longMemory(40);
    const dataDir = fresh();
    const r = await runCase({
      caseName: 'seeded-anomaly', dataDir, memoryText: overCap, condense: { maxChars: 1500 },
      envExtra: { AGENT_WATCHDOG_MEMORY_MAX_TOKENS: '500' },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('published');
    const output = r.read('rollup/rollup-output.json');
    expect(output.memory).to.include({ applied: true, reason: 'condensed', condensed_by: 'model', version: 1 });
    const memory = fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8');
    expect(memory.length).to.be.at.most(1818);
    expect(memory).to.include('note 40');
    expect(memory).to.not.include('note 01');
    const historyPatch = path.join(dataDir, 'memory', 'history', `${r.runId}.patch`);
    expect(fs.existsSync(historyPatch)).to.equal(true);
    expect(fs.readFileSync(historyPatch, 'utf8')).to.equal(fs.readFileSync(path.join(r.root, 'memory.patch'), 'utf8'));
    expect(fs.readFileSync(historyPatch, 'utf8')).to.include('+- note 40');
    const condenseCall = r.engine.calls.singleTurns.find((c) => c.name === 'memory-condense');
    expect(condenseCall, 'the condensation call').to.not.equal(undefined);
    expect(condenseCall.userPrompt).to.include('<untrusted source="memory">');
    expect(condenseCall.systemPrompt.join('\n')).to.include('500');
    // The condensation call's cost is part of the run's cost and of the footer.
    expect(r.read('rollup/brief.json').footer.cost_usd).to.equal(r.read('run.json').cost_usd);

    // When the model's answer still overflows, code condenses instead and the run still succeeds.
    const fallbackDir = fresh();
    const f = await runCase({
      caseName: 'seeded-anomaly', dataDir: fallbackDir, memoryText: overCap, condense: { mode: 'overflow' },
      envExtra: { AGENT_WATCHDOG_MEMORY_MAX_TOKENS: '500' },
    });
    expect(f.error, f.error && f.error.stack).to.equal(undefined);
    expect(f.read('run.json').status).to.equal('published');
    expect(f.read('rollup/rollup-output.json').memory).to.include({ applied: true, condensed_by: 'code' });
    const fallbackMemory = fs.readFileSync(path.join(fallbackDir, 'memory', 'memory.md'), 'utf8');
    expect(fallbackMemory).to.match(/^<!-- condensed by code: \d+ lines dropped -->/);
    expect(fallbackMemory.length).to.be.at.most(1818);
  });

  it('scenario 3: a proposal naming a project or a person is written masked and flagged for the reviewer', async () => {
    const dataDir = fresh();
    const r = await runCase({
      caseName: 'seeded-anomaly', dataDir,
      proposals: [{
        type: 'prompt',
        title: 'Watch alpha.example.org sentinel after month-end',
        body: 'On alpha.example.org the backlog tripled; reviewer <@U0123ABCD> confirmed it in the thread. '
          + 'Contact ops@example.org or +254 712 345 678 for context, and see '
          + 'https://docs.communityhealthtoolkit.org/hosting/monitoring/ for the metric definition.',
      }],
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const [written] = await readProposals(dataDir);
    expect(written.proposal_id).to.not.include('alpha');
    expect(written.title).to.equal('Watch [hostname] sentinel after month-end');
    expect(written.body).to.include('On [hostname] the backlog tripled; reviewer [person] confirmed');
    expect(written.body).to.include('Contact [address] or [address] for context');
    expect(written.body).to.include('https://docs.communityhealthtoolkit.org/hosting/monitoring/');
    expect(written.body).to.not.match(/alpha\.example\.org|U0123ABCD|ops@|712 345/);
    const kinds = written.flags.map((f) => f.kind);
    expect(kinds).to.include.members(['hostname', 'person', 'address']);
    expect(written.flags.find((f) => f.kind === 'hostname').excerpt).to.equal('alpha.example.org');
    expect(written.flags.find((f) => f.kind === 'person').excerpt).to.include('U0123ABCD');
    for (const flag of written.flags.filter((f) => f.kind === 'address')) {
      expect(flag.excerpt).to.not.include('ops@example.org');
      expect(flag.excerpt).to.not.include('712 345 678');
    }
    expect(kinds).to.not.include('secret');
    const raw = fs.readFileSync(path.join(dataDir, 'proposals', `${written.proposal_id}.md`), 'utf8');
    expect(raw.startsWith('---\n')).to.equal(true);
    expect(raw).to.include('status: proposed');
    expect(raw).to.not.include('ops@example.org');
  });
  it('scenario 4: the weekly calibration backs a threshold suggestion with thirty days of evidence', async () => {
    const before = reviewedHashes();
    const dataDir = fresh();
    await buildCalibrationHistory({ dataDir, days: 30, endDate: '2026-09-18' });
    const expected = expectedFor(30);
    const out = capture();
    const err = capture();
    const engine = {
      name: 'fake',
      singleTurn: sinon.stub().resolves({
        structuredOutput: {
          summary: 'One metric is noisy on one project; raising the threshold keeps every confirmed item.',
        },
        result: {
          subtype: 'success',
          usage: { input_tokens: 500, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 },
          total_cost_usd: 0.003, num_turns: 1, duration_ms: 50, session_id: 's',
        },
        toolCalls: [],
        referenceUnavailable: false,
      }),
    };
    const code = await calibrate({
      flags: { week: '2026-W38' },
      env: envFor(dataDir),
      stdout: out.stream,
      logger: createLogger({ stream: err.stream, level: 'warn' }),
      deps: { tracer: fakeTracer(), engine, now: () => new Date('2026-09-18T12:00:00Z') },
    });
    expect(code).to.equal(0);

    const reportPath = path.join(dataDir, 'calibration', '2026-W38.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(JSON.parse(out.text())).to.deep.equal(report);
    expect(report.week).to.equal('2026-W38');
    const entry = report.entries.find((e) => e.metric === 'cht_sentinel_backlog_count');
    expect(entry.project_url).to.equal('https://alpha.example.org');
    expect(entry.current_threshold).to.equal(50);
    expect(entry.suggested_threshold).to.equal(80);
    expect(entry.distribution).to.include.keys(['days', 'pct_p50', 'pct_p95', 'pct_max', 'dev_p50', 'dev_max']);
    expect(entry.outcomes).to.deep.equal({
      confirmed: expected.confirmed, dismissed: expected.dismissed, unreviewed: expected.unreviewed,
    });
    expect(entry.effect_last_30d).to.deep.equal({
      items_kept: expected.itemsKeptAt(80),
      items_dropped: expected.sessions - expected.itemsKeptAt(80),
      confirmed_kept: expected.confirmedKeptAt(80),
    });
    expect(entry.effect_last_30d.confirmed_kept).to.equal(expected.confirmed);
    expect(report.pass_change_rate).to.be.closeTo(expected.changedSessions / expected.sessions, 1e-9);
    expect(report.feedback_rate.window_days).to.equal(60);
    expect(report.feedback_rate.overall).to.be.a('number');

    // The suggestion is a proposal file: current and proposed values, the distribution and the thirty-day
    // effect are its evidence; the project is named only in the evidence and flagged for the reviewer.
    expect(report.proposals).to.have.length(1);
    const proposals = await readProposals(dataDir);
    expect(proposals.map((p) => p.proposal_id)).to.deep.equal(report.proposals);
    const [proposal] = proposals;
    expect(proposal).to.include({ type: 'threshold', status: 'proposed' });
    expect(proposal.evidence[0]).to.include({
      project_url: 'https://alpha.example.org', metric: 'cht_sentinel_backlog_count',
      current_threshold: 50, suggested_threshold: 80,
    });
    expect(proposal.evidence[0].distribution).to.deep.equal(entry.distribution);
    expect(proposal.evidence[0].effect_last_30d).to.deep.equal(entry.effect_last_30d);
    expect(proposal.body).to.include('one project');
    expect(proposal.body).to.match(/\b50\b/).and.match(/\b80\b/);
    expect(proposal.body).to.not.include('alpha.example.org');
    expect(proposal.flags.some((f) => f.kind === 'hostname' && f.excerpt === 'alpha.example.org')).to.equal(true);

    const summary = fs.readFileSync(path.join(dataDir, 'calibration', '2026-W38.md'), 'utf8');
    expect(summary).to.include('raising the threshold keeps every confirmed item');
    expect(engine.singleTurn).to.have.been.calledOnce;
    expect(engine.singleTurn.firstCall.args[0].userPrompt).to.include('<untrusted source="calibration-report">');

    // Nothing reviewed changed: thresholds.yaml, prompts, skill, schema and agent files are byte-identical.
    expect(reviewedHashes()).to.deep.equal(before);
  });
});

const fs = require('node:fs');
const path = require('node:path');
const calibrate = require('../../src/cli/commands/calibrate');
const codes = require('../../src/cli/exit-codes');
const { schemas } = require('../../src/model/schemas');
const { createLogger } = require('../../src/log/logger');
const { capture, envFor, fakeTracer, attempt } = require('./helpers');
const { buildCalibrationHistory, PATTERN } = require('../helpers/calibration-runs');
const { tempDir, removeDir } = require('../helpers/fixtures');

const NOW = new Date('2026-09-18T12:00:00Z');
const WEEK = '2026-W38';

const turn = (structuredOutput, subtype = 'success') => ({
  structuredOutput,
  result: {
    subtype, usage: { input_tokens: 500, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 },
    total_cost_usd: 0.003, num_turns: 1, duration_ms: 50, session_id: 's',
  },
  toolCalls: [],
  referenceUnavailable: false,
});

const fakeEngine = (response) => ({
  name: 'fake',
  singleTurn: typeof response === 'function' ? sinon.stub().callsFake(response) : sinon.stub().resolves(response),
});

const writeProposalsStub = () => sinon.stub().callsFake(async ({ proposals, date }) => ({
  written: proposals.map((p, i) => ({
    proposal_id: `${date}-${p.type}-adjust-${i}`, type: p.type, path: `proposals/${date}-${p.type}-adjust-${i}.md`,
    run_path: null, flags: [{ kind: 'hostname', excerpt: 'alpha.example.org' }],
  })),
  superseded: [],
}));

const argsFor = (dataDir, { flags = {}, deps = {} } = {}) => {
  const out = capture();
  const err = capture();
  const writeProposals = writeProposalsStub();
  const engine = fakeEngine(turn({
    summary: 'One metric looks noisy on one project; the suggestion keeps every confirmed item.',
  }));
  return {
    out,
    err,
    writeProposals,
    engine,
    args: {
      command: 'calibrate',
      flags,
      positionals: [],
      env: envFor(dataDir),
      stdout: out.stream,
      stderr: err.stream,
      logger: createLogger({ stream: err.stream, level: 'warn' }),
      deps: { tracer: fakeTracer(), engine, writeProposals, now: () => NOW, ...deps },
    },
  };
};

describe('cli/commands/calibrate', function () {
  this.timeout(30000);
  let dataDir;
  let history;
  before(async () => {
    dataDir = tempDir();
    history = await buildCalibrationHistory({ dataDir, days: 30 });
  });
  after(() => removeDir(dataDir));
  afterEach(() => {
    for (const name of fs.readdirSync(path.join(dataDir, 'calibration'))) {
      fs.rmSync(path.join(dataDir, 'calibration', name));
    }
  });

  it('writes the report and its markdown, prints the report and records the proposal ids', async () => {
    const t = argsFor(dataDir, { flags: { week: WEEK } });
    expect(await calibrate(t.args)).to.equal(0);
    const printed = JSON.parse(t.out.text());
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'calibration', `${WEEK}.json`), 'utf8'));
    expect(printed).to.deep.equal(stored);
    expect(() => schemas.CalibrationReport.parse(stored)).to.not.throw();
    expect(stored.week).to.equal(WEEK);
    expect(stored.entries).to.have.length(1);
    expect(stored.entries[0].suggested_threshold).to.equal(PATTERN.expectedSuggestion);
    expect(stored.proposals).to.deep.equal([`2026-09-18-threshold-adjust-0`]);
    const markdown = fs.readFileSync(path.join(dataDir, 'calibration', `${WEEK}.md`), 'utf8');
    expect(markdown).to.include(`# Calibration ${WEEK}`);
    expect(markdown).to.include('One metric looks noisy on one project');
    expect(markdown).to.include('2026-09-18-threshold-adjust-0');
    expect(t.engine.singleTurn).to.have.been.calledOnce;
    const call = t.engine.singleTurn.firstCall.args[0];
    expect(call.model).to.equal('claude-fable-5-1');
    expect(call.userPrompt).to.include('<untrusted source="calibration-report">');
    expect(t.args.deps.tracer.start).to.have.been.calledOnce;
    expect(t.args.deps.tracer.finish).to.have.been.calledOnce;
  });

  it('writes a threshold proposal with evidence and a pattern-level body naming no host', async () => {
    const t = argsFor(dataDir, { flags: { week: WEEK } });
    await calibrate(t.args);
    expect(t.writeProposals).to.have.been.calledOnce;
    const request = t.writeProposals.firstCall.args[0];
    expect(request.dataDir).to.equal(dataDir);
    expect(request.date).to.equal('2026-09-18');
    expect(request.runId).to.equal(`calibrate-${WEEK}`);
    expect(request.hosts).to.include('alpha.example.org');
    expect(request.proposals).to.have.length(1);
    const [proposal] = request.proposals;
    expect(proposal.type).to.equal('threshold');
    expect(proposal.title).to.include(history.metric);
    expect(proposal.body).to.include('one project');
    expect(proposal.body).to.include('50').and.include('80');
    expect(proposal.body).to.not.include('alpha.example.org');
    expect(proposal.body).to.not.match(/https?:\/\//);
    expect(proposal.evidence).to.have.length(1);
    expect(proposal.evidence[0]).to.include({
      project_url: history.url, metric: history.metric, current_threshold: 50, suggested_threshold: 80,
    });
    expect(proposal.evidence[0].distribution.days).to.equal(30);
    expect(proposal.evidence[0].effect_last_30d.confirmed_kept).to.equal(history.expected.confirmed);
    expect(proposal.evidence[0].outcomes).to.deep.equal({
      confirmed: history.expected.confirmed, dismissed: history.expected.dismissed,
      unreviewed: history.expected.unreviewed,
    });
    expect(proposal.evidence[0].window).to.deep.equal({ from: '2026-08-20', to: '2026-09-18' });
  });

  it('defaults the week to the current ISO week', async () => {
    const t = argsFor(dataDir);
    expect(await calibrate(t.args)).to.equal(0);
    expect(fs.existsSync(path.join(dataDir, 'calibration', `${WEEK}.json`))).to.equal(true);
    expect(JSON.parse(t.out.text()).week).to.equal(WEEK);
  });

  it('exits 64 on a malformed week', async () => {
    const t = argsFor(dataDir, { flags: { week: '2026-38' } });
    const { error } = await attempt(calibrate, t.args);
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(codes.USAGE);
    expect(fs.existsSync(path.join(dataDir, 'calibration', `${WEEK}.json`))).to.equal(false);
  });

  it('restricts the report to --project and writes no proposal when nothing matches', async () => {
    const t = argsFor(dataDir, { flags: { week: WEEK, project: ['beta.example.org'] } });
    expect(await calibrate(t.args)).to.equal(0);
    const report = JSON.parse(t.out.text());
    expect(report.entries).to.deep.equal([]);
    expect(report.proposals).to.deep.equal([]);
    expect(t.writeProposals).to.not.have.been.called;
  });

  it('falls back to a deterministic table when the summary model fails, and still writes everything', async () => {
    const failing = fakeEngine(() => Promise.reject(new Error('model unavailable')));
    const t = argsFor(dataDir, { flags: { week: WEEK }, deps: { engine: failing } });
    expect(await calibrate(t.args)).to.equal(0);
    const markdown = fs.readFileSync(path.join(dataDir, 'calibration', `${WEEK}.md`), 'utf8');
    expect(markdown).to.include('| Project | Metric |');
    expect(markdown).to.include('alpha.example.org');
    expect(markdown).to.include('summary unavailable');
    expect(markdown).to.include('2026-09-18-threshold-adjust-0');
    expect(() => schemas.CalibrationReport.parse(JSON.parse(t.out.text()))).to.not.throw();
    const errors = t.err.text().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(errors.some((e) => e.event === 'calibrate.summary_unavailable')).to.equal(true);
  });

  it('treats an unusable summary (wrong shape or a URL) as unavailable', async () => {
    const withUrl = fakeEngine(turn({ summary: 'See https://alpha.example.org for details' }));
    const t = argsFor(dataDir, { flags: { week: WEEK }, deps: { engine: withUrl } });
    expect(await calibrate(t.args)).to.equal(0);
    const markdown = fs.readFileSync(path.join(dataDir, 'calibration', `${WEEK}.md`), 'utf8');
    expect(markdown).to.not.include('See https://');
    expect(markdown).to.include('summary unavailable');
  });
});

const fs = require('node:fs');
const path = require('node:path');
const stage = require('../../src/cli/stages/rollup');
const { RunDir } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem, makeCandidate, makeDiscovery, makeConfig, quietLogger } = require('./factories');

const pass = (n, items) => ({
  pass: n,
  session_id: 's',
  items,
  not_selected: [],
  changes: [],
  converged: n === 2,
  gate: null,
  usage: null,
  cost_usd: 0.01,
  num_turns: 3,
  duration_ms: 100,
  tool_calls_path: 'alpha-example-org/tool-calls.jsonl',
});

describe('cli/stages/rollup', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    runDir = await RunDir.create(dataDir, '2026-09-18');
    await runDir.writeJson('discovery.json', makeDiscovery());
    const first = makeItem({ why_now: 'pass one wording' });
    const revised = makeItem({ why_now: 'pass two wording' });
    await runDir.writeJson('alpha-example-org/candidates.json', [makeCandidate()]);
    await runDir.writeJson('alpha-example-org/changes.json', []);
    await runDir.writeJson('alpha-example-org/findings.pass1.json', pass(1, [first]));
    await runDir.writeJson('alpha-example-org/findings.pass2.json', pass(2, [revised]));
    await runDir.writeJson('alpha-example-org/passes.json', { passes: [1, 2], converged: true, bounds_hit: [] });
    await runDir.writeJson('alpha-example-org/session.json', { reference_sources_unavailable: false, calls: [] });
    await runDir.writeJson('beta-example-org/candidates.json', []);
  });
  afterEach(() => removeDir(dataDir));

  const ctxWith = (engineOutput) => ({
    config: makeConfig(),
    logger: quietLogger(),
    runDir,
    runId: '2026-09-18',
    date: '2026-09-18',
    mode: 'scheduled',
    traceUrl: 'https://langfuse.example.org/trace/t1',
    costSoFar: 0.05,
    engine: { singleTurn: sinon.stub().resolves(engineOutput) },
    gate: {
      verifyBrief: sinon.stub().resolves({
        report: { subject: 'brief', subject_ref: 'rollup/draft1', attempt: 1, checks: [], outcome: 'accepted' },
      }),
    },
  });

  it('gathers the last pass of every project, ranks, composes and writes the rollup files', async () => {
    const item = makeItem();
    const ctx = ctxWith({
      structuredOutput: {
        headline: 'h', bullets: [{ item_id: item.item_id, text: 'alpha 912 vs 300' }], thread_order: [item.item_id],
        expected_load_notice: null, memory_update: { replace_with: null }, proposals: [],
      },
      result: {
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.01,
        num_turns: 1,
        duration_ms: 5,
        session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    });
    const out = await stage.run(ctx);
    expect(out).to.include({ kind: 'brief', items: 1, bullets: 1, degraded: false });
    const ranked = await runDir.readJson('rollup/items.ranked.json');
    expect(ranked).to.have.length(1);
    expect(ranked[0].why_now).to.equal('pass two wording');
    expect(ranked[0]).to.include({ rank: 1, placement: 'body' });
    expect(runDir.exists('rollup/brief.draft1.json')).to.equal(true);
    expect(runDir.exists('rollup/verification.draft1.json')).to.equal(true);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.footer).to.include({ trace_url: 'https://langfuse.example.org/trace/t1', cost_usd: 0.05 });
    expect(brief.checked.candidates).to.equal(1);
    const output = await runDir.readJson('rollup/rollup-output.json');
    expect(output).to.have.keys(['memory_update', 'proposals']);
  });

  it('writes a heartbeat without calling the engine when no project produced items', async () => {
    fs.rmSync(path.join(runDir.root, 'alpha-example-org'), { recursive: true, force: true });
    const ctx = ctxWith(null);
    const out = await stage.run(ctx);
    expect(out.kind).to.equal('heartbeat');
    expect(ctx.engine.singleTurn.called).to.equal(false);
    const brief = await runDir.readJson('rollup/brief.json');
    expect(brief.headline).to.include('All quiet');
  });

  it('refuses to run without discovery.json', async () => {
    fs.rmSync(path.join(runDir.root, 'discovery.json'));
    let error;
    try {
      await stage.run(ctxWith(null));
    } catch (e) {
      error = e;
    }
    expect(error.code).to.equal(65);
  });
});

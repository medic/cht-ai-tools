const fs = require('node:fs');
const path = require('node:path');
const distillCommand = require('../../src/cli/commands/distill');
const codes = require('../../src/cli/exit-codes');
const { createLogger } = require('../../src/log/logger');
const { capture, envFor, fakeTracer, attempt } = require('./helpers');
const { copyCorpus, EXPLAINER } = require('../helpers/corpus');
const { tempDir, removeDir } = require('../helpers/fixtures');

const NOW = new Date('2026-09-19T08:00:00Z');

const turn = (structuredOutput) => ({
  structuredOutput,
  result: {
    subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    total_cost_usd: 0.002, num_turns: 1, duration_ms: 5, session_id: 's',
  },
  toolCalls: [],
  referenceUnavailable: false,
});

const card = {
  title: 'Sentinel backlog climbs after an upgrade',
  symptom: 'The sentinel backlog rises for hours while the API stays healthy.',
  metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises steadily for hours' }],
  watchdog_appearance: 'Sentinel Backlog panel climbs alone.',
  root_cause: 'A transition throws on a new document shape.',
  resolution: 'Fix or disable the transition.',
  confirmation_steps: ['Check the sentinel log for a repeated transition error.'],
  false_positives: ['A training day raises and drains the backlog within hours.'],
  matches_existing: null,
};

describe('cli/commands/distill', function () {
  this.timeout(20000);
  let dataDir;
  let rawDir;
  const argsFor = ({ flags = {}, env = {}, deps = {} } = {}) => {
    const out = capture();
    const err = capture();
    const engine = {
      name: 'fake',
      singleTurn: sinon.stub().callsFake(async ({ userPrompt }) => (
        turn(userPrompt.includes('conversations/') ? { cards: [card], notes: '' } : { cards: [], notes: '' })
      )),
    };
    return {
      out,
      err,
      engine,
      args: {
        command: 'distill',
        flags,
        positionals: [],
        env: envFor(dataDir, { AGENT_WATCHDOG_CORPUS_RAW_DIR: rawDir, ...env }),
        stdout: out.stream,
        stderr: err.stream,
        logger: createLogger({ stream: err.stream, level: 'warn' }),
        deps: { tracer: fakeTracer(), engine, patternCards: { merged: [], index: [] }, now: () => NOW, ...deps },
      },
    };
  };

  beforeEach(() => {
    dataDir = tempDir();
    rawDir = path.join(dataDir, 'raw');
    copyCorpus(rawDir);
  });
  afterEach(() => removeDir(dataDir));

  it('prints the report on stdout, writes the proposed cards and the index, and traces once', async () => {
    const t = argsFor();
    expect(await distillCommand(t.args)).to.equal(codes.OK);
    const report = JSON.parse(t.out.text());
    // The command applies the default size limit, so the 6 KiB dump is a readable item here: five processed.
    expect(report.processed.map((p) => p.relative_path)).to.have.length(5);
    expect(report.skipped.map((s) => s.reason)).to.deep.equal(['binary']);
    expect(report.cards.map((c) => c.card_id)).to.deep.equal(['sentinel-backlog-climbs-after-an-upgrade']);
    expect(report.cost_usd).to.be.closeTo(0.01, 1e-9);
    expect(fs.existsSync(path.join(dataDir, 'corpus', 'index.json'))).to.equal(true);
    expect(fs.readdirSync(path.join(dataDir, 'corpus', 'cards.proposed')))
      .to.deep.equal(['sentinel-backlog-climbs-after-an-upgrade.md']);
    expect(t.engine.singleTurn).to.have.callCount(5);
    expect(t.engine.singleTurn.firstCall.args[0].model).to.equal('claude-fable-5-1');
    expect(t.args.deps.tracer.start).to.have.been.calledOnce;
    expect(t.args.deps.tracer.finish).to.have.been.calledOnce;
    const events = t.err.text().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(events.some((e) => e.level === 'error')).to.equal(false);
  });

  it('uses the distillation model override when configured', async () => {
    const t = argsFor({ env: { AGENT_WATCHDOG_MODEL_DISTILL: 'claude-haiku-4-5-20251001' } });
    expect(await distillCommand(t.args)).to.equal(codes.OK);
    expect(t.engine.singleTurn.firstCall.args[0].model).to.equal('claude-haiku-4-5-20251001');
  });

  it('honours --all and --item', async () => {
    const first = argsFor();
    await distillCommand(first.args);
    const nothing = argsFor();
    await distillCommand(nothing.args);
    expect(nothing.engine.singleTurn).to.have.callCount(0);
    expect(JSON.parse(nothing.out.text()).processed).to.deep.equal([]);
    const all = argsFor({ flags: { all: true } });
    await distillCommand(all.args);
    expect(all.engine.singleTurn).to.have.callCount(5);
    expect(fs.readdirSync(path.join(dataDir, 'corpus', 'cards.proposed'))).to.have.length(1);
    const one = argsFor({ flags: { item: [EXPLAINER] } });
    await distillCommand(one.args);
    expect(one.engine.singleTurn).to.have.callCount(1);
    expect(JSON.parse(one.out.text()).processed.map((p) => p.relative_path)).to.deep.equal([EXPLAINER]);
  });

  it('masks people, phones and e-mails in a corpus item before the model reads it (revision 36)', async () => {
    fs.writeFileSync(
      path.join(rawDir, 'conversations', 'masked.md'),
      '# A thread\n\n<@U024BE7LH> said the backlog cleared; ring +254 712 345 678 or ops@example.org; '
        + '1073741824 bytes.\n',
    );
    const t = argsFor();
    expect(await distillCommand(t.args)).to.equal(codes.OK);
    const prompts = t.engine.singleTurn.getCalls().map((c) => c.args[0].userPrompt);
    const masked = prompts.find((p) => p.includes('conversations/masked.md'));
    expect(masked).to.include('[person] said the backlog cleared; ring [address] or [address]; 1073741824 bytes.');
    expect(masked).to.not.include('U024BE7LH');
    expect(prompts.join('\n')).to.not.include('254 712');
  });

  it('exits 65 naming the raw directory when it does not exist', async () => {
    const missing = path.join(dataDir, 'missing-raw');
    const t = argsFor({ env: { AGENT_WATCHDOG_CORPUS_RAW_DIR: missing } });
    const { error } = await attempt(distillCommand, t.args);
    expect(error).to.be.instanceOf(codes.ExitError);
    expect(error.code).to.equal(codes.DATAERR);
    expect(error.message).to.include(missing);
    expect(t.out.text()).to.equal('');
  });

  it('fails loudly when no engine can be built', async () => {
    const t = argsFor({ deps: { engine: null, createEngine: () => {
      throw new Error('no runtime here');
    } } });
    const { error } = await attempt(distillCommand, t.args);
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.include('no runtime here');
    expect(t.args.deps.tracer.finish).to.have.been.calledOnce;
  });
  it('runs under the egress guard on the global fetch and restores it afterwards (FR-083, revision 33)', async () => {
    const before = globalThis.fetch;
    let seen = null;
    const tracer = fakeTracer();
    tracer.start = sinon.stub().callsFake(async () => {
      seen = globalThis.fetch.egressGuard === true;
      return { traceId: 't1' };
    });
    const t = argsFor({ deps: { tracer } });
    await distillCommand(t.args);
    expect(seen).to.equal(true);
    expect(globalThis.fetch).to.equal(before);
  });
  it('logs a rejected trace flush after printing the report, and keeps the exit code (revision 35)', async () => {
    const tracer = fakeTracer();
    tracer.finish.rejects(Object.assign(new Error('Unauthorized'), { name: 'OTLPExporterError' }));
    const t = argsFor({ deps: { tracer } });
    expect(await distillCommand(t.args)).to.equal(codes.OK);
    expect(JSON.parse(t.out.text()).cards).to.have.length(1);
    expect(t.err.text()).to.include('trace.finish_failed');
  });
});

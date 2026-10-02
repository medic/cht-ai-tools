const fs = require('node:fs');
const path = require('node:path');
const { distill, verbatimOverlap, chooseItems, splitPrompt } = require('../../src/corpus/distill');
const { readIndex } = require('../../src/corpus/index');
const { parseCardFile } = require('../../src/corpus/cards');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { ensureDataLayout, dataPaths } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');
const {
  copyCorpus, sha256, CONVERSATION, EXPORT, INCIDENT, EXPLAINER, BINARY, TOO_LARGE,
} = require('../helpers/corpus');

const NOW = () => new Date('2026-09-19T08:00:00Z');
const CARD_A = 'sentinel-backlog-climbs-after-an-upgrade';
const CARD_B = 'outbound-push-stalls-after-a-credential-rotation';
const VERBATIM = 'a sentinel backlog that rises steadily for hours after an upgrade while the API stays healthy '
  + 'usually means a transition is throwing';

const config = {
  model: { name: 'claude-fable-5-1', distill: 'claude-distill', effort: 'max', engine: 'sdk' },
  bounds: { maxTurns: 5, maxBudgetUsdProject: 1, modelTimeoutMs: 1000 },
  paths: PACKAGE_PATHS,
};

const turn = (structuredOutput, subtype = 'success') => ({
  structuredOutput,
  result: {
    subtype,
    usage: { input_tokens: 500, output_tokens: 100, cache_read_tokens: 20, cache_creation_tokens: 0 },
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 10,
    session_id: 's',
  },
  toolCalls: [],
  referenceUnavailable: false,
});

const cardA = (overrides = {}) => ({
  title: 'Sentinel backlog climbs after an upgrade',
  symptom: 'On pilot.example.org the sentinel backlog rose for hours while the API stayed healthy; <@U04AB12CD> '
    + 'raised it and ops@example.org was told.',
  metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises steadily for hours and does not drain' }],
  watchdog_appearance: 'The Sentinel Backlog panel climbs while Outbound Push Backlog and uptime stay flat.',
  root_cause: 'A transition throws on a document shape introduced by an upgrade, so every affected change is requeued.',
  resolution: 'Fix or disable the failing transition; the queue drains on its own afterwards.',
  confirmation_steps: ['Look for a repeated transition error in the sentinel log.'],
  false_positives: ['A burst of user activity raises the backlog and drains within the day.'],
  matches_existing: null,
  ...overrides,
});

const cardB = () => ({
  title: 'Outbound push stalls after a credential rotation',
  symptom: 'The outbound push backlog steps from zero to a small number and stays there.',
  metrics: [{ metric: 'cht_outbound_push_backlog_count', shape: 'steps above zero and holds' }],
  watchdog_appearance: 'Outbound Push Backlog panel shows a step that never returns to zero.',
  root_cause: 'The receiving system rotated its credential and the new one was not configured.',
  resolution: 'Update the outbound credential; the queue drains without replay.',
  confirmation_steps: ['Check the outbound push log for repeated 401 responses.'],
  false_positives: ['A short receiving-system outage clears on its own within an hour.'],
  matches_existing: null,
});

// Answers by the item named in the prompt, so processing order does not matter.
const engineFor = (answers) => ({
  name: 'fake',
  singleTurn: sinon.stub().callsFake(async ({ userPrompt }) => {
    const entry = Object.entries(answers).find(([relativePath]) => userPrompt.includes(relativePath));
    const answer = entry ? entry[1] : { cards: [], notes: 'nothing reusable' };
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer.__turn) {
      return answer.__turn;
    }
    return turn(answer);
  }),
});

const defaultAnswers = () => ({
  [CONVERSATION]: { cards: [cardA()], notes: '' },
  [EXPORT]: {
    cards: [cardA({
      title: 'Sentinel backlog series',
      confirmation_steps: ['Plot the backlog over the last twelve hours and confirm it never turned down.'],
      matches_existing: CARD_A,
    })],
    notes: '',
  },
  [INCIDENT]: { cards: [cardB()], notes: '' },
  [EXPLAINER]: { cards: [], notes: 'explainer only' },
});

describe('corpus/distill (FR-035, FR-036, US6 scenarios 1 to 3)', () => {
  let dataDir;
  let rawDir;
  let proposedDir;
  const run = (overrides = {}) => distill({
    dataDir, rawDir, engine: engineFor(defaultAnswers()), config, now: NOW, maxBytes: 4096, ...overrides,
  });
  const readCard = (id) => parseCardFile(fs.readFileSync(path.join(proposedDir, `${id}.md`), 'utf8'));

  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    rawDir = path.join(dataDir, 'knowledge-corpus', 'raw');
    copyCorpus(rawDir);
    proposedDir = dataPaths(dataDir).corpusCardsProposed;
  });
  afterEach(() => removeDir(dataDir));

  it('processes new items only, writes one card per distinct pattern with sources, then nothing on rerun', async () => {
    const engine = engineFor(defaultAnswers());
    const report = await run({ engine });
    expect(engine.singleTurn).to.have.callCount(4);
    expect(report.processed.map((p) => p.relative_path)).to.deep.equal([CONVERSATION, EXPLAINER, EXPORT, INCIDENT]);
    expect(report.skipped).to.deep.equal([
      { relative_path: BINARY, reason: 'binary' }, { relative_path: TOO_LARGE, reason: 'too_large' },
    ]);
    expect(report.rejected).to.deep.equal([]);
    expect(fs.readdirSync(proposedDir).sort()).to.deep.equal([`${CARD_B}.md`, `${CARD_A}.md`].sort());

    const a = readCard(CARD_A);
    expect(a.card.status).to.equal('proposed');
    expect(a.card.title).to.equal('Sentinel backlog climbs after an upgrade');
    expect(a.card.sources).to.deep.equal([
      sha256(path.join(rawDir, CONVERSATION)), sha256(path.join(rawDir, EXPORT)),
    ]);
    expect(a.card.metrics).to.deep.equal([
      { metric: 'cht_sentinel_backlog_count', shape: 'rises steadily for hours and does not drain' },
    ]);
    expect(a.card.confirmation_steps).to.deep.equal([
      'Look for a repeated transition error in the sentinel log.',
      'Plot the backlog over the last twelve hours and confirm it never turned down.',
    ]);
    expect(a.card.false_positives).to.have.length(1);
    expect(a.frontMatter.created_at).to.equal('2026-09-19T08:00:00.000Z');
    expect(a.frontMatter.updated_at).to.equal('2026-09-19T08:00:00.000Z');
    expect(a.frontMatter.source_kind).to.equal('conversation');
    const b = readCard(CARD_B);
    expect(b.card.sources).to.deep.equal([sha256(path.join(rawDir, INCIDENT))]);
    expect(b.frontMatter.updated_at).to.equal(undefined);

    const cards = report.cards;
    expect(cards.map((c) => [c.card_id, c.updated]))
      .to.deep.equal([[CARD_A, false], [CARD_A, true], [CARD_B, false]]);
    expect(cards[0].path).to.equal(path.join(proposedDir, `${CARD_A}.md`));
    expect(cards.every((c) => c.status === 'proposed')).to.equal(true);
    expect(report.cost_usd).to.be.closeTo(0.04, 1e-9);
    expect(report.usage).to.deep.equal({
      input_tokens: 2000, output_tokens: 400, cache_read_tokens: 80, cache_creation_tokens: 0,
    });
    expect(report.index_path).to.equal(dataPaths(dataDir).corpusIndex);

    const index = await readIndex(report.index_path);
    const byPath = Object.fromEntries(index.items.map((i) => [i.relative_path, i]));
    expect(byPath[CONVERSATION]).to.include({ status: 'distilled', distilled_at: '2026-09-19T08:00:00.000Z' });
    expect(byPath[CONVERSATION].card_ids).to.deep.equal([CARD_A]);
    expect(byPath[EXPORT].card_ids).to.deep.equal([CARD_A]);
    expect(byPath[INCIDENT].card_ids).to.deep.equal([CARD_B]);
    expect(byPath[EXPLAINER]).to.include({ status: 'distilled' });
    expect(byPath[EXPLAINER].card_ids).to.deep.equal([]);
    expect(byPath[BINARY].status).to.equal('skipped');

    const again = await run({ engine });
    expect(engine.singleTurn).to.have.callCount(4);
    expect(again.processed).to.deep.equal([]);
    expect(again.skipped.map((s) => s.relative_path)).to.deep.equal([BINARY, TOO_LARGE]);
    expect(fs.readdirSync(proposedDir)).to.have.length(2);
  });

  it('re-processes everything with all, updating not duplicating, and only the named paths with items', async () => {
    await run();
    const engine = engineFor(defaultAnswers());
    const all = await run({ engine, all: true });
    expect(engine.singleTurn).to.have.callCount(4);
    expect(all.processed).to.have.length(4);
    expect(fs.readdirSync(proposedDir)).to.have.length(2);
    expect(all.cards.every((c) => c.updated)).to.equal(true);
    expect(readCard(CARD_A).card.sources).to.have.length(2);
    expect(readCard(CARD_B).card.sources).to.have.length(1);

    const picked = engineFor(defaultAnswers());
    const some = await run({ engine: picked, items: [INCIDENT, 'nope.md', BINARY] });
    expect(picked.singleTurn).to.have.callCount(1);
    expect(some.processed.map((p) => p.relative_path)).to.deep.equal([INCIDENT]);
    expect(some.skipped).to.deep.include({ relative_path: 'nope.md', reason: 'not in corpus' });
    expect(some.skipped).to.deep.include({ relative_path: BINARY, reason: 'binary' });
  });

  it('scrubs identifiers in the card text and lists them under flags', async () => {
    await run();
    const a = readCard(CARD_A);
    const text = fs.readFileSync(path.join(proposedDir, `${CARD_A}.md`), 'utf8');
    expect(a.card.symptom).to.include('On [hostname] the sentinel backlog');
    expect(a.card.symptom).to.include('[person] raised it and [address] was told');
    // The card itself and its body carry only placeholders; hostname and person excerpts live in the flags for
    // the reviewer, while the address excerpt is masked and the raw address appears nowhere.
    expect(JSON.stringify(a.card)).to.not.match(/pilot\.example\.org|U04AB12CD|ops@example\.org/);
    expect(a.body).to.not.match(/pilot\.example\.org|U04AB12CD|ops@example\.org/);
    expect(text).to.not.include('ops@example.org');
    const kinds = a.frontMatter.flags.map((f) => f.kind).sort();
    expect(kinds).to.deep.equal(['address', 'hostname', 'person']);
    expect(a.frontMatter.flags.find((f) => f.kind === 'hostname').excerpt).to.equal('pilot.example.org');
    expect(a.frontMatter.flags.find((f) => f.kind === 'address').excerpt).to.equal('o***@example.org');
    expect(a.frontMatter.flags.find((f) => f.kind === 'person').excerpt).to.equal('U04AB12CD');
  });

  it('rejects a card that reproduces raw content and leaves its item new', async () => {
    const answers = defaultAnswers();
    answers[CONVERSATION] = { cards: [cardA({ root_cause: `We learned that ${VERBATIM}.` })], notes: '' };
    const engine = engineFor(answers);
    const report = await run({ engine });
    expect(report.rejected).to.deep.equal([{
      relative_path: CONVERSATION, title: 'Sentinel backlog climbs after an upgrade', reason: 'reproduces raw content',
    }]);
    expect(fs.existsSync(path.join(proposedDir, `${CARD_A}.md`))).to.equal(false);
    const index = await readIndex(report.index_path);
    expect(index.items.find((i) => i.relative_path === CONVERSATION).status).to.equal('new');
    // The export's matches_existing pointed at a card that was never written, so it becomes its own card.
    expect(report.processed.find((p) => p.relative_path === EXPORT).cards).to.deep.equal(['sentinel-backlog-series']);
  });

  it('verbatimOverlap needs twelve consecutive words; short phrases and metric names pass', () => {
    const raw = fs.readFileSync(path.join(rawDir, CONVERSATION), 'utf8');
    expect(verbatimOverlap(raw, `Some intro, then ${VERBATIM} and more.`)).to.be.a('string');
    expect(verbatimOverlap(raw, 'the sentinel backlog climbed from about 300 to over 900')).to.equal(null);
    expect(verbatimOverlap(raw, 'cht_sentinel_backlog_count rises steadily for hours after an upgrade')).to.equal(null);
    const shouted = 'A   SENTINEL backlog that rises steadily for hours after an upgrade while the api stays '
      + 'healthy usually means a transition is throwing';
    expect(verbatimOverlap(raw, shouted)).to.be.a('string');
    expect(verbatimOverlap('short raw text', 'short raw text')).to.equal(null);
  });

  it('leaves an item new when the model fails or answers outside the schema', async () => {
    const answers = defaultAnswers();
    answers[INCIDENT] = new Error('model unavailable');
    answers[EXPLAINER] = { __turn: turn({ nope: true }) };
    answers[EXPORT] = { __turn: turn({ cards: [], notes: '' }, 'error_max_budget_usd') };
    const report = await run({ engine: engineFor(answers) });
    const reasons = Object.fromEntries(report.rejected.map((r) => [r.relative_path, r.reason]));
    expect(reasons[INCIDENT]).to.include('model unavailable');
    expect(reasons[EXPLAINER]).to.equal('output failed the schema');
    expect(reasons[EXPORT]).to.include('error_max_budget_usd');
    const index = await readIndex(report.index_path);
    const status = Object.fromEntries(index.items.map((i) => [i.relative_path, i.status]));
    expect(status[INCIDENT]).to.equal('new');
    expect(status[EXPLAINER]).to.equal('new');
    expect(status[EXPORT]).to.equal('new');
    expect(status[CONVERSATION]).to.equal('distilled');
  });

  it('records a match against a merged card without writing it and lists existing cards', async () => {
    const merged = {
      card_id: 'sentinel-stall', title: 'Sentinel stall', status: 'merged',
      metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises' }],
    };
    const answers = defaultAnswers();
    answers[CONVERSATION] = { cards: [cardA({ matches_existing: 'sentinel-stall' })], notes: '' };
    const engine = engineFor(answers);
    const report = await run({
      engine, cards: { merged: [merged], index: ['sentinel-stall'] }, items: [CONVERSATION],
    });
    const processed = report.processed[0];
    expect(processed.cards).to.deep.equal([]);
    expect(processed.matches_merged).to.deep.equal(['sentinel-stall']);
    expect(fs.existsSync(proposedDir) ? fs.readdirSync(proposedDir) : []).to.deep.equal([]);
    const index = await readIndex(report.index_path);
    expect(index.items.find((i) => i.relative_path === CONVERSATION)).to.include({ status: 'distilled' });
    const call = engine.singleTurn.firstCall.args[0];
    expect(call.model).to.equal('claude-distill');
    expect(call.name).to.equal('distill');
    expect(call.userPrompt).to.include('- sentinel-stall: Sentinel stall');
    expect(call.userPrompt).to.include('<untrusted source="corpus-item">');
    expect(call.userPrompt).to.include(CONVERSATION);
    expect(call.userPrompt).to.include('kind: conversation');
    expect(call.systemPrompt[0]).to.include('pattern card');
    expect(call.systemPrompt[0]).to.not.include('{{content}}');
    expect(call.outputSchema.properties.cards).to.be.an('object');
  });

  it('suffixes a slug that collides with an existing card and collapses duplicates within one run', async () => {
    const first = engineFor({ [INCIDENT]: { cards: [cardB()], notes: '' } });
    await run({ engine: first, items: [INCIDENT] });
    const twice = engineFor({
      [CONVERSATION]: { cards: [cardB(), { ...cardB(), resolution: 'Rotate both sides together.' }], notes: '' },
    });
    const report = await run({ engine: twice, items: [CONVERSATION] });
    expect(report.processed[0].cards).to.deep.equal([`${CARD_B}-2`]);
    expect(fs.readdirSync(proposedDir).sort()).to.deep.equal([`${CARD_B}-2.md`, `${CARD_B}.md`]);
    const suffixed = readCard(`${CARD_B}-2`);
    expect(suffixed.card.sources).to.deep.equal([sha256(path.join(rawDir, CONVERSATION))]);
  });

  it('truncates long items in the prompt and marks the truncation', async () => {
    const engine = engineFor(defaultAnswers());
    await run({ engine, items: [EXPLAINER], maxPromptChars: 200 });
    const prompt = engine.singleTurn.firstCall.args[0].userPrompt;
    expect(prompt).to.include('[truncated:');
    expect(prompt.length).to.be.lessThan(2000);
  });

  it('chooses items deterministically and splits the prompt at the item heading', () => {
    const index = { items: [
      { relative_path: 'a.md', status: 'new' }, { relative_path: 'b.md', status: 'distilled' },
      { relative_path: 'c.png', status: 'skipped', skipped_reason: 'binary' },
    ] };
    expect(chooseItems({ index }).chosen.map((i) => i.relative_path)).to.deep.equal(['a.md']);
    expect(chooseItems({ index, all: true }).chosen.map((i) => i.relative_path)).to.deep.equal(['a.md', 'b.md']);
    expect(chooseItems({ index, items: ['b.md', 'zz.md', 'c.png'] })).to.deep.equal({
      chosen: [{ relative_path: 'b.md', status: 'distilled' }],
      skipped: [{ relative_path: 'zz.md', reason: 'not in corpus' }, { relative_path: 'c.png', reason: 'binary' }],
    });
    const { system, item } = splitPrompt('intro\n\n## Item\n\nkind: {{kind}}\n{{content}}');
    expect(system).to.equal('intro');
    expect(item).to.include('{{content}}');
    expect(() => splitPrompt('no heading here')).to.throw(/## Item/);
  });
});

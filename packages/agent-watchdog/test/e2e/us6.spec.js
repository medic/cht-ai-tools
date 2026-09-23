// End-to-end User Story 6: learning from the knowledge corpus. Distillation runs against the corpus fixtures with
// a scripted model; the daily analysis runs against a skill directory holding a merged card. Nothing touches the
// network, and nothing under skill/, prompts/, schema/ or agent/ is ever written.
const fs = require('node:fs');
const path = require('node:path');
const { loadDefinition } = require('../../src/agent/definition');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { loadPatternCards, renderCardFile, parseCardFile } = require('../../src/corpus/cards');
const { readIndex } = require('../../src/corpus/index');
const distillCommand = require('../../src/cli/commands/distill');
const { createLogger } = require('../../src/log/logger');
const corpus = require('../helpers/corpus');
const { itemId } = require('../../src/model/identity');
const { buildCardIndex } = require('../../scripts/build-card-index');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase, envFor, capture, fakeTracer } = require('./helpers');

const CARD = {
  card_id: 'sentinel-stall-after-upgrade',
  title: 'Sentinel stalls after an upgrade',
  symptom: 'The sentinel backlog climbs steadily for hours while the API stays healthy.',
  metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises monotonically over hours' }],
  watchdog_appearance: 'Sentinel Backlog panel climbs while Outbound Push Backlog stays flat.',
  root_cause: 'A transition throws on a document shape introduced by the upgrade.',
  resolution: 'Fix or disable the failing transition and let the queue drain.',
  confirmation_steps: [
    'Check the sentinel log for a repeated transition error.',
    'Confirm the backlog drains after the transition is fixed.',
  ],
  false_positives: ['Month-end load makes the backlog rise and fall within a day.'],
  sources: ['a'.repeat(64)],
  status: 'merged',
};

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
};

/** A skill directory identical to the package's, plus one merged card and a regenerated index. */
const skillWithMergedCard = async (root) => {
  const skillDir = path.join(root, 'cht-watchdog');
  copyDir(PACKAGE_PATHS.skillDir, skillDir);
  fs.writeFileSync(path.join(skillDir, 'pattern-cards', `${CARD.card_id}.md`), renderCardFile(CARD, {}));
  const built = await buildCardIndex({ skillDir, check: false });
  expect(built.code).to.equal(0);
  return skillDir;
};

describe('e2e: User Story 6, learning from the knowledge corpus', function () {
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

  it('scenario 4: an item matching a merged card names the card and uses its confirmation steps', async () => {
    const skillDir = await skillWithMergedCard(fresh());
    const dataDir = fresh();
    const env = envFor(dataDir);
    const definition = loadDefinition({ paths: { ...PACKAGE_PATHS, skillDir }, env });
    const patternCards = loadPatternCards({ skillDir });
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, definition, patternCards });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.read('run.json').status).to.equal('published');

    const ranked = r.read('rollup/items.ranked.json');
    const sentinel = ranked.find((i) => i.metric === 'cht_sentinel_backlog_count');
    expect(sentinel.pattern_card).to.equal(CARD.card_id);
    expect(sentinel.suggested_check).to.equal(CARD.confirmation_steps.join(' '));
    expect(sentinel.item_id).to.equal(itemId('https://alpha.example.org', 'cht_sentinel_backlog_count', CARD.card_id));
    const other = ranked.find((i) => i.metric !== 'cht_sentinel_backlog_count');
    expect(other.pattern_card).to.equal(null);
    expect(other.suggested_check).to.not.include('sentinel log');
    // The gate accepted the pass because the card id is in the merged index.
    expect(r.read('alpha-example-org/verification.pass1.json').outcome).to.equal('accepted');
    // The card's confirmation steps are in the report shared into the thread; no item reply carries them since
    // revision 28 (FR-020, FR-022).
    const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
    expect(report).to.include('Check the sentinel log for a repeated transition error.');
    expect(r.read('rollup/payload.json').replies.some((rep) => rep.item_id)).to.equal(false);
    // Merged cards are never written by a run.
    const cardFile = path.join(skillDir, 'pattern-cards', `${CARD.card_id}.md`);
    expect(fs.readFileSync(cardFile, 'utf8')).to.equal(renderCardFile(CARD, {}));
  });

  it('scenario 5: the analysis loads only the one-line card index and reads a full card through the tool', async () => {
    const skillDir = await skillWithMergedCard(fresh());
    const dataDir = fresh();
    const env = envFor(dataDir);
    const definition = loadDefinition({ paths: { ...PACKAGE_PATHS, skillDir }, env });
    const patternCards = loadPatternCards({ skillDir });
    const r = await runCase({ caseName: 'seeded-anomaly', dataDir, definition, patternCards });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);

    const session = r.engine.calls.sessions.find((s) => s.sessionName === 'alpha-example-org');
    const staticPrefix = session.systemPrompt[0];
    expect(staticPrefix).to.include(`- ${CARD.card_id}: ${CARD.title}.`);
    expect(staticPrefix).to.include('cht_sentinel_backlog_count');
    // The card's body stays out of the prompt: it costs nothing until the model asks for it.
    expect(staticPrefix).to.not.include('Check the sentinel log for a repeated transition error.');
    expect(staticPrefix).to.not.include('## Root cause');
    expect(session.tools).to.include('mcp__watchdog__read_pattern_card');
    const readCard = session.localTools.find((t) => t.name === 'read_pattern_card');
    const full = JSON.parse((await readCard.handler({ card_id: CARD.card_id })).content[0].text);
    expect(full.text).to.include('## Confirmation steps');
    expect(full.text).to.include('Check the sentinel log for a repeated transition error.');
    const unknown = JSON.parse((await readCard.handler({ card_id: 'not-a-card' })).content[0].text);
    expect(unknown.error).to.include('unknown card');
    // Ten more merged cards add ten index lines and nothing else to the static prefix.
    const bigger = fresh();
    const bigSkill = path.join(bigger, 'cht-watchdog');
    copyDir(skillDir, bigSkill);
    for (let i = 0; i < 10; i += 1) {
      const extra = {
        ...CARD, card_id: `pattern-${i}`, title: `Pattern ${i}`, metrics: [{ metric: `metric_${i}`, shape: 's' }],
      };
      fs.writeFileSync(path.join(bigSkill, 'pattern-cards', `pattern-${i}.md`), renderCardFile(extra, {}));
    }
    expect((await buildCardIndex({ skillDir: bigSkill, check: false })).code).to.equal(0);
    const before = definition.systemPrefix.length;
    const after = loadDefinition({ paths: { ...PACKAGE_PATHS, skillDir: bigSkill }, env }).systemPrefix.length;
    const indexBytes = fs.readFileSync(path.join(bigSkill, 'pattern-cards', 'index.md'), 'utf8').length
      - fs.readFileSync(path.join(skillDir, 'pattern-cards', 'index.md'), 'utf8').length;
    expect(after - before).to.equal(indexBytes);
    expect(after - before).to.be.lessThan(2000);
  });
});

// A scripted distillation model: answers per corpus item from the prompt's `path:` line, names an existing card
// when the prompt lists one for the same pattern, and (in verbatim mode) copies a sentence from the item.
const SENTINEL_TITLE = 'Sentinel backlog climbs after an upgrade';
const OUTBOUND_TITLE = 'Outbound push stalls after a credential rotation';
const COPIED_SENTENCE = 'a sentinel backlog that rises steadily for hours after an upgrade while the API stays '
  + 'healthy usually means a transition is throwing';

const createDistillEngine = ({ verbatim = false } = {}) => {
  const calls = [];
  const sentinelCard = (existingId) => ({
    title: SENTINEL_TITLE,
    symptom: 'The sentinel backlog on pilot.example.org climbs steadily for hours while the API stays healthy; '
      + '<@U04AB12CD> and ops@example.org were the first to notice.',
    metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises steadily over several hours' }],
    watchdog_appearance: 'The Sentinel Backlog panel climbs while Outbound Push Backlog and uptime stay flat.',
    root_cause: verbatim
      ? `In short, ${COPIED_SENTENCE}.`
      : 'A transition throws on a document field introduced by an upgrade, so every new report is requeued.',
    resolution: 'Disable or fix the failing transition and let the queue drain.',
    confirmation_steps: [
      'Check the sentinel log for a repeated transition error.',
      'Confirm the backlog drains once the transition is disabled or fixed.',
    ],
    false_positives: ['Month-end reporting raises the backlog and it drains within a day.'],
    matches_existing: existingId,
  });
  const outboundCard = (existingId) => ({
    title: OUTBOUND_TITLE,
    symptom: 'The outbound push backlog rises above zero and stays there while everything else is normal.',
    metrics: [{ metric: 'cht_outbound_push_backlog_count', shape: 'steps above zero and stays flat' }],
    watchdog_appearance: 'Outbound Push Backlog shows a non-zero plateau starting at a specific hour.',
    root_cause: 'The credential the outbound integration uses was rotated without updating the configuration.',
    resolution: 'Update the outbound configuration with the new credential; the backlog drains on its own.',
    confirmation_steps: ['Check the API log for authentication failures against the outbound endpoint.'],
    false_positives: ['A planned maintenance window on the receiving system.'],
    matches_existing: existingId,
  });
  const existingIdFor = (prompt, title) => {
    const line = prompt.split('\n').find((l) => l.startsWith('- ') && l.includes(`: ${title}`));
    return line ? line.slice(2, line.indexOf(':')) : null;
  };
  const singleTurn = sinon.stub().callsFake(async (options) => {
    calls.push(options);
    const prompt = options.userPrompt;
    const rel = (/^path: (.+)$/m.exec(prompt) || [])[1];
    let cards = [];
    if (rel === corpus.CONVERSATION || rel === corpus.EXPORT) {
      cards = [sentinelCard(existingIdFor(prompt, SENTINEL_TITLE))];
    } else if (rel === corpus.INCIDENT) {
      cards = [outboundCard(existingIdFor(prompt, OUTBOUND_TITLE))];
    }
    return {
      structuredOutput: { cards, notes: cards.length ? '' : 'background material only' },
      result: {
        subtype: 'success',
        usage: { input_tokens: 800, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        total_cost_usd: 0.01, num_turns: 1, duration_ms: 50, session_id: 's',
      },
      toolCalls: [],
      referenceUnavailable: false,
    };
  });
  return { name: 'fake', singleTurn, calls };
};

const runDistill = async ({ dataDir, rawDir, engine, flags = {} }) => {
  const out = capture();
  const err = capture();
  const code = await distillCommand({
    flags,
    env: envFor(dataDir, { AGENT_WATCHDOG_CORPUS_RAW_DIR: rawDir }),
    stdout: out.stream,
    logger: createLogger({ stream: err.stream, level: 'warn' }),
    deps: { engine, tracer: fakeTracer(), now: () => new Date('2026-09-18T07:00:00Z') },
  });
  return { code, report: JSON.parse(out.text()) };
};

describe('e2e: User Story 6, distillation of the knowledge corpus', function () {
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

  it('scenarios 1 and 2: one cited card per distinct pattern; only new or changed items are processed', async () => {
    const dataDir = fresh();
    const rawDir = fresh();
    corpus.copyCorpus(rawDir);
    const engine = createDistillEngine();
    const first = await runDistill({ dataDir, rawDir, engine });
    expect(first.code).to.equal(0);
    const { report } = first;
    // Five text items processed, the binary skipped with a note; the explainer and the dump yield no card.
    expect(report.processed.map((p) => p.relative_path).sort()).to.deep.equal([
      corpus.CONVERSATION, corpus.EXPLAINER, corpus.EXPORT, corpus.INCIDENT, corpus.TOO_LARGE,
    ].sort());
    expect(report.skipped).to.deep.equal([{ relative_path: corpus.BINARY, reason: 'binary' }]);
    expect(report.rejected).to.deep.equal([]);
    expect(engine.calls).to.have.length(5);
    // One card per distinct pattern: the export cited the same pattern and updated the sentinel card, so the
    // report lists that card twice (written, then updated) but only two card files exist.
    expect([...new Set(report.cards.map((c) => c.card_id))].sort()).to.deep.equal([
      'outbound-push-stalls-after-a-credential-rotation', 'sentinel-backlog-climbs-after-an-upgrade',
    ]);
    const proposedDir = path.join(dataDir, 'corpus', 'cards.proposed');
    expect(fs.readdirSync(proposedDir).sort()).to.deep.equal([
      'outbound-push-stalls-after-a-credential-rotation.md', 'sentinel-backlog-climbs-after-an-upgrade.md',
    ]);
    const readCard = (name) => parseCardFile(fs.readFileSync(path.join(proposedDir, name), 'utf8'));
    const sentinel = readCard('sentinel-backlog-climbs-after-an-upgrade.md');
    expect(sentinel.card.status).to.equal('proposed');
    expect(sentinel.card.sources.sort()).to.deep.equal([
      corpus.sha256(path.join(rawDir, corpus.CONVERSATION)), corpus.sha256(path.join(rawDir, corpus.EXPORT)),
    ].sort());
    for (const key of ['symptom', 'watchdog_appearance', 'root_cause', 'resolution']) {
      expect(sentinel.card[key], key).to.be.a('string').with.length.greaterThan(20);
    }
    expect(sentinel.card.metrics)
      .to.deep.equal([{ metric: 'cht_sentinel_backlog_count', shape: 'rises steadily over several hours' }]);
    expect(sentinel.card.confirmation_steps).to.have.length(2);
    expect(sentinel.card.false_positives).to.have.length(1);
    expect(report.cards.filter((c) => c.card_id === 'sentinel-backlog-climbs-after-an-upgrade').map((c) => c.updated))
      .to.deep.equal([false, true]);
    // The index tracks every item by content hash and never holds content.
    const index = await readIndex(path.join(dataDir, 'corpus', 'index.json'));
    const byPath = Object.fromEntries(index.items.map((i) => [i.relative_path, i]));
    expect(byPath[corpus.CONVERSATION]).to.include({ kind: 'conversation', status: 'distilled' });
    expect(byPath[corpus.CONVERSATION].card_ids).to.deep.equal(['sentinel-backlog-climbs-after-an-upgrade']);
    expect(byPath[corpus.EXPORT]).to.include({ kind: 'export', status: 'distilled' });
    expect(byPath[corpus.INCIDENT]).to.include({ kind: 'incident', status: 'distilled' });
    expect(byPath[corpus.EXPLAINER]).to.include({ kind: 'explainer', status: 'distilled' });
    expect(byPath[corpus.BINARY]).to.include({ kind: 'unknown', status: 'skipped', skipped_reason: 'binary' });
    expect(byPath[corpus.CONVERSATION].content_hash).to.match(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(dataDir, 'corpus', 'index.json'), 'utf8')).to.not.include('transition error');

    // Scenario 2: nothing changed, nothing processed; a changed item is processed again and only it.
    const again = await runDistill({ dataDir, rawDir, engine });
    expect(again.report.processed).to.deep.equal([]);
    expect(again.report.cards).to.deep.equal([]);
    expect(engine.calls).to.have.length(5);
    fs.appendFileSync(path.join(rawDir, corpus.INCIDENT), '\nUpdate: the same thing happened again in July.\n');
    const changed = await runDistill({ dataDir, rawDir, engine });
    expect(changed.report.processed.map((p) => p.relative_path)).to.deep.equal([corpus.INCIDENT]);
    expect(engine.calls).to.have.length(6);
    const outbound = readCard('outbound-push-stalls-after-a-credential-rotation.md');
    expect(outbound.card.sources).to.include(corpus.sha256(path.join(rawDir, corpus.INCIDENT)));
    expect(fs.readdirSync(proposedDir)).to.have.length(2);
  });

  it('scenario 3: identifiers are removed or flagged and raw corpus text is never copied into a card', async () => {
    const dataDir = fresh();
    const rawDir = fresh();
    corpus.copyCorpus(rawDir, ['conversations']);
    const { report } = await runDistill({ dataDir, rawDir, engine: createDistillEngine() });
    expect(report.cards).to.have.length(1);
    const file = path.join(dataDir, 'corpus', 'cards.proposed', 'sentinel-backlog-climbs-after-an-upgrade.md');
    const text = fs.readFileSync(file, 'utf8');
    const { frontMatter, card, body } = parseCardFile(text);
    // The identifiers are gone from the card itself; only the reviewer-facing flags name the host and the
    // Slack id (the address is masked even there), the same rule proposals follow.
    expect(body).to.not.match(/pilot\.example\.org|U04AB12CD|ops@example\.org/);
    expect(JSON.stringify(card)).to.not.match(/pilot\.example\.org|U04AB12CD|ops@example\.org/);
    expect(body).to.include('[hostname]').and.include('[person]').and.include('[address]');
    const kinds = frontMatter.flags.map((f) => f.kind);
    expect(kinds).to.include.members(['hostname', 'person', 'address']);
    expect(frontMatter.flags.find((f) => f.kind === 'hostname').excerpt).to.equal('pilot.example.org');
    expect(frontMatter.flags.find((f) => f.kind === 'address').excerpt).to.not.include('ops@example.org');
    // No line of the raw thread appears in the card.
    const rawLines = fs.readFileSync(path.join(rawDir, corpus.CONVERSATION), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l.length > 40);
    for (const line of rawLines) {
      expect(text).to.not.include(line);
    }

    // A card that reproduces a sentence from the item is rejected and never written; the item stays new.
    const copyDataDir = fresh();
    const copyRawDir = fresh();
    corpus.copyCorpus(copyRawDir, ['conversations']);
    const rejected = await runDistill({
      dataDir: copyDataDir, rawDir: copyRawDir, engine: createDistillEngine({ verbatim: true }),
      flags: { item: [corpus.CONVERSATION] },
    });
    expect(rejected.code).to.equal(0);
    expect(rejected.report.cards).to.deep.equal([]);
    expect(rejected.report.rejected).to.have.length(1);
    expect(rejected.report.rejected[0])
      .to.include({ relative_path: corpus.CONVERSATION, reason: 'reproduces raw content' });
    expect(fs.existsSync(path.join(copyDataDir, 'corpus', 'cards.proposed'))
      && fs.readdirSync(path.join(copyDataDir, 'corpus', 'cards.proposed')).length).to.not.equal(true);
    const index = await readIndex(path.join(copyDataDir, 'corpus', 'index.json'));
    expect(index.items.find((i) => i.relative_path === corpus.CONVERSATION).status).to.equal('new');
  });
});

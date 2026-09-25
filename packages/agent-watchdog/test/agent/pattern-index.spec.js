// User Story 6 scenarios 4 and 5: only the one-line index of merged cards is in the static prefix, a full card
// is read through the read_pattern_card tool, and an item matching a merged card names it and uses its
// confirmation steps as the suggested check.
const fs = require('node:fs');
const path = require('node:path');
const { loadDefinition } = require('../../src/agent/definition');
const { createWatchdogTools } = require('../../src/agent/tools/watchdog-tools');
const { loadPatternCards, renderCardFile } = require('../../src/corpus/cards');
const { rankItems, matchPatternCards } = require('../../src/rollup/rank');
const { itemId } = require('../../src/model/identity');
const { PACKAGE_PATHS } = require('../../src/config/schema');
const { buildCardIndex } = require('../../scripts/build-card-index');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { makeItem } = require('../rollup/factories');

const STEP_ONE = 'Check the sentinel log for a repeated transition error.';
const STEP_TWO = 'Confirm the queue drains after a restart.';

const mergedCard = {
  card_id: 'sentinel-stall-after-upgrade',
  title: 'Sentinel stalls after an upgrade',
  symptom: 'The sentinel backlog climbs steadily for hours while the API stays healthy.',
  metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises monotonically over hours' }],
  watchdog_appearance: 'Sentinel Backlog panel climbs while Outbound Push Backlog stays flat.',
  root_cause: 'A transition throws on a document shape introduced by the upgrade.',
  resolution: 'Fix or disable the failing transition and let the queue drain.',
  confirmation_steps: [STEP_ONE, STEP_TWO],
  false_positives: ['Month-end load makes the backlog rise and fall within a day.'],
  sources: ['a'.repeat(64)],
  status: 'merged',
};
const proposedCard = {
  ...mergedCard, card_id: 'proposed-only', title: 'Proposed only card', status: 'proposed', metrics: [
    { metric: 'cht_conflict_count', shape: 'jumps after a release' },
  ],
};

const env = { AGENT_WATCHDOG_DOCS_MCP_URL: 'https://docs-mcp.example.org/mcp' };

describe('agent/pattern-index (FR-038, US6 scenarios 4 and 5)', () => {
  let skillDir;
  let cardsDir;
  before(async () => {
    skillDir = tempDir();
    fs.cpSync(PACKAGE_PATHS.skillDir, skillDir, { recursive: true });
    cardsDir = path.join(skillDir, 'pattern-cards');
    fs.writeFileSync(path.join(cardsDir, `${mergedCard.card_id}.md`), renderCardFile(mergedCard, {}));
    fs.writeFileSync(path.join(cardsDir, `${proposedCard.card_id}.md`), renderCardFile(proposedCard, {}));
    await buildCardIndex({ skillDir });
  });
  after(() => removeDir(skillDir));

  it('puts only the index line of a merged card into the static prefix, never a card body or a proposed card', () => {
    const definition = loadDefinition({ paths: { ...PACKAGE_PATHS, skillDir }, env });
    expect(definition.systemPrefix).to.include('- sentinel-stall-after-upgrade: Sentinel stalls after an upgrade');
    expect(definition.systemPrefix).to.include('cht_sentinel_backlog_count');
    expect(definition.systemPrefix).to.not.include(STEP_ONE);
    expect(definition.systemPrefix).to.not.include('Proposed only card');
    expect(definition.systemPrefix).to.not.include('## Root cause');
    const index = fs.readFileSync(path.join(cardsDir, 'index.md'), 'utf8');
    expect(index.split('\n').filter((line) => line.startsWith('- '))).to.have.length(1);
  });

  it('serves a full merged card only through read_pattern_card, and refuses proposed or unknown ids', async () => {
    const recorded = [];
    const tools = createWatchdogTools({
      deps: { getWindows: async () => ({}), queryWindow: async () => ({}), itemHistory: async () => [] },
      project: { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' },
      discovery: { metrics: [] },
      patternCards: loadPatternCards({ skillDir }),
      recorder: (call) => recorded.push(call),
    });
    const read = tools.find((t) => t.name === 'read_pattern_card');
    const parse = (out) => JSON.parse(out.content[0].text);
    const hit = parse(await read.handler({ card_id: 'sentinel-stall-after-upgrade' }));
    expect(hit.card_id).to.equal('sentinel-stall-after-upgrade');
    expect(hit.text).to.include('## Confirmation steps');
    expect(hit.text).to.include(STEP_ONE);
    const proposed = parse(await read.handler({ card_id: 'proposed-only' }));
    // The refusal names no argument (revision 36): a card id is the model's text, and an echoed URL would count as
    // seen in a tool result.
    expect(proposed.error).to.match(/^unknown card;/);
    expect(proposed.error).to.not.include('proposed-only');
    expect(parse(await read.handler({ card_id: 'nope' })).error).to.match(/^unknown card;/);
    expect(recorded.map((c) => c.tool)).to.deep.equal(['read_pattern_card', 'read_pattern_card', 'read_pattern_card']);
  });

  it('names the merged card on a matching item, uses its confirmation steps and recomputes the identity', () => {
    const cards = loadPatternCards({ skillDir });
    const sentinel = makeItem({ pattern_card: null, suggested_check: 'model text' });
    const conflicts = makeItem({
      metric: 'cht_conflict_count', pattern_card: null, suggested_check: 'look at conflicts',
    });
    const named = makeItem({
      project_url: 'https://beta.example.org', pattern_card: 'sentinel-stall-after-upgrade', suggested_check: 'model text',
    });
    const { items, matched } = matchPatternCards([sentinel, conflicts, named], cards);
    expect(items[0].pattern_card).to.equal('sentinel-stall-after-upgrade');
    expect(items[0].suggested_check).to.equal(`${STEP_ONE} ${STEP_TWO}`);
    expect(items[0].item_id).to.equal(itemId(sentinel.project_url, sentinel.metric, 'sentinel-stall-after-upgrade'));
    expect(items[0].item_id).to.not.equal(sentinel.item_id);
    expect(items[1]).to.deep.equal(conflicts);
    expect(items[2].pattern_card).to.equal('sentinel-stall-after-upgrade');
    expect(items[2].item_id).to.equal(named.item_id);
    expect(items[2].suggested_check).to.equal(`${STEP_ONE} ${STEP_TWO}`);
    expect(matched).to.deep.equal([{
      item_id_before: sentinel.item_id, item_id: items[0].item_id, card_id: 'sentinel-stall-after-upgrade',
    }]);
    expect(sentinel.pattern_card).to.equal(null);

    const ranked = rankItems({ items: [sentinel, conflicts], cards });
    expect(ranked.find((i) => i.metric === 'cht_sentinel_backlog_count').pattern_card)
      .to.equal('sentinel-stall-after-upgrade');
    expect(rankItems({ items: [sentinel] })[0].pattern_card).to.equal(null);
  });

  it('build-card-index --check fails on a stale index and passes once regenerated', async () => {
    const extra = { ...mergedCard, card_id: 'another-merged-card', title: 'Another merged card' };
    fs.writeFileSync(path.join(cardsDir, 'another-merged-card.md'), renderCardFile(extra, {}));
    const stale = await buildCardIndex({ skillDir, check: true });
    expect(stale.code).to.equal(1);
    expect(stale.changed).to.equal(true);
    expect(fs.readFileSync(path.join(cardsDir, 'index.md'), 'utf8')).to.not.include('another-merged-card');
    const written = await buildCardIndex({ skillDir });
    expect(written).to.include({ code: 0, changed: true, written: true });
    expect(written.merged).to.deep.equal(['another-merged-card', 'sentinel-stall-after-upgrade']);
    expect(fs.readFileSync(path.join(cardsDir, 'index.md'), 'utf8')).to.include('- another-merged-card:');
    const fresh = await buildCardIndex({ skillDir, check: true });
    expect(fresh).to.include({ code: 0, changed: false });
    fs.rmSync(path.join(cardsDir, 'another-merged-card.md'));
    await buildCardIndex({ skillDir });
  });
});

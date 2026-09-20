const fs = require('node:fs');
const path = require('node:path');
const {
  parseCardFile, renderCardFile, loadPatternCards, indexLine, buildIndex, CARD_SECTIONS,
} = require('../../src/corpus/cards');
const { schemas } = require('../../src/model/schemas');
const { tempDir, removeDir } = require('../helpers/fixtures');

const card = (overrides = {}) => ({
  card_id: 'sentinel-stall-after-upgrade',
  title: 'Sentinel stalls after an upgrade',
  symptom: 'The sentinel backlog climbs steadily for hours while the API stays healthy.',
  metrics: [{ metric: 'cht_sentinel_backlog_count', shape: 'rises monotonically over hours' }],
  watchdog_appearance: 'Sentinel Backlog panel climbs while Outbound Push Backlog stays flat.',
  root_cause: 'A transition throws on a document shape introduced by the upgrade.',
  resolution: 'Fix or disable the failing transition and let the queue drain.',
  confirmation_steps: [
    'Check the sentinel log for a repeated transition error.', 'Confirm the queue drains after a restart.',
  ],
  false_positives: ['Month-end load makes the backlog rise and fall within a day.'],
  sources: ['a'.repeat(64)],
  status: 'merged',
  ...overrides,
});

describe('corpus/cards: pattern-card files', () => {
  it('renders a card as YAML front matter plus a fixed-section body and parses it back', () => {
    const text = renderCardFile(card(), { created_at: '2026-09-18T06:00:00Z', flags: [] });
    expect(text.startsWith('---\n')).to.equal(true);
    for (const heading of CARD_SECTIONS) {
      expect(text).to.include(`## ${heading}`);
    }
    const parsed = parseCardFile(text);
    expect(parsed.card).to.deep.equal(card());
    expect(() => schemas.PatternCard.parse(parsed.card)).to.not.throw();
    expect(parsed.frontMatter.created_at).to.equal('2026-09-18T06:00:00Z');
    expect(parsed.body).to.include('Check the sentinel log');
  });

  it('rejects a card file whose front matter fails the entity schema, and refuses to render one', () => {
    const text = renderCardFile(card(), {}).replace('status: merged', 'status: draft');
    expect(() => parseCardFile(text)).to.throw(/status/);
    expect(() => renderCardFile(card({ status: 'draft' }), {})).to.throw(/status/);
    expect(() => parseCardFile('no front matter here')).to.throw(/front matter/);
  });

  it('builds a one-line index entry per merged card and nothing else', () => {
    const line = indexLine(card());
    expect(line).to.match(/^- sentinel-stall-after-upgrade: Sentinel stalls after an upgrade/);
    expect(line).to.include('cht_sentinel_backlog_count');
    expect(line).to.not.include('Check the sentinel log');
    const index = buildIndex([card(), card({ card_id: 'x', title: 'Proposed only', status: 'proposed' })]);
    expect(index).to.include('- sentinel-stall-after-upgrade:');
    expect(index).to.not.include('Proposed only');
    expect(buildIndex([])).to.include('No merged cards yet.');
  });

  describe('loadPatternCards', () => {
    let dir;
    beforeEach(() => {
      dir = tempDir();
      fs.mkdirSync(path.join(dir, 'pattern-cards'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pattern-cards', 'index.md'), '# Pattern cards\n');
      fs.writeFileSync(path.join(dir, 'pattern-cards', 'sentinel-stall-after-upgrade.md'), renderCardFile(card(), {}));
      fs.writeFileSync(path.join(dir, 'pattern-cards', 'proposed-thing.md'),
        renderCardFile(card({ card_id: 'proposed-thing', title: 'Proposed thing', status: 'proposed' }), {}));
    });
    afterEach(() => removeDir(dir));

    it('lists merged cards only, exposes their ids for the gate and reads a full card by id', async () => {
      const cards = loadPatternCards({ skillDir: dir });
      expect(cards.index).to.deep.equal(['sentinel-stall-after-upgrade']);
      expect(cards.merged.map((c) => c.card_id)).to.deep.equal(['sentinel-stall-after-upgrade']);
      expect(cards.byMetric('cht_sentinel_backlog_count').map((c) => c.card_id))
        .to.deep.equal(['sentinel-stall-after-upgrade']);
      expect(cards.byMetric('cht_conflict_count')).to.deep.equal([]);
      const text = await cards.read('sentinel-stall-after-upgrade');
      expect(text).to.include('## Confirmation steps');
      expect(await cards.read('proposed-thing')).to.equal('');
      expect(await cards.read('missing')).to.equal('');
    });

    it('returns an empty set when the directory has no cards', () => {
      const empty = loadPatternCards({ skillDir: tempDir() });
      expect(empty.index).to.deep.equal([]);
      expect(empty.merged).to.deep.equal([]);
    });
  });
});

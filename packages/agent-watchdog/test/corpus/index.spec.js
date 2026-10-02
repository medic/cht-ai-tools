const fs = require('node:fs');
const path = require('node:path');
const { scanCorpus, readIndex, writeIndex, classifyKind, isBinary, hashFile } = require('../../src/corpus/index');
const { schemas } = require('../../src/model/schemas');
const { tempDir, removeDir } = require('../helpers/fixtures');
const {
  copyCorpus, sha256, CONVERSATION, EXPORT, INCIDENT, EXPLAINER, BINARY, TOO_LARGE,
} = require('../helpers/corpus');

const ITEM_KEYS = [
  'card_ids', 'content_hash', 'distilled_at', 'kind', 'relative_path', 'size_bytes', 'skipped_reason', 'status',
];
const NOW = () => new Date('2026-09-19T08:00:00Z');

describe('corpus/index (FR-037, US6 scenario 2)', () => {
  let root;
  let rawDir;
  let outcomesDir;
  let indexPath;
  const scan = (overrides = {}) => scanCorpus({
    rawDir, outcomesDir, indexPath, now: NOW, maxBytes: 4096, ...overrides,
  });
  const itemFor = (index, relativePath) => index.items.find((i) => i.relative_path === relativePath);

  beforeEach(() => {
    root = tempDir();
    rawDir = path.join(root, 'raw');
    outcomesDir = path.join(root, 'corpus', 'outcomes');
    indexPath = path.join(root, 'corpus', 'index.json');
    copyCorpus(rawDir);
    fs.mkdirSync(outcomesDir, { recursive: true });
    fs.writeFileSync(path.join(outcomesDir, '2026-09-18.jsonl'), `${JSON.stringify({
      date: '2026-09-18', item_id: 'abcdefabcdef', outcome: 'confirmed', metric: 'cht_sentinel_backlog_count',
    })}\n`);
  });
  afterEach(() => removeDir(root));

  it('records every field, classifies kinds and skips binary and oversized files with a reason', async () => {
    const { index, changes } = await scan();
    expect(index.version).to.equal(1);
    expect(index.updated_at).to.equal('2026-09-19T08:00:00.000Z');
    expect(index.items.map((i) => i.relative_path)).to.deep.equal([
      BINARY, CONVERSATION, EXPLAINER, EXPORT, INCIDENT, 'outcomes/2026-09-18.jsonl', TOO_LARGE,
    ]);
    for (const item of index.items) {
      expect(() => schemas.CorpusItem.parse(item), item.relative_path).to.not.throw();
      expect(Object.keys(item).sort()).to.deep.equal(ITEM_KEYS);
      expect(item.content_hash).to.match(/^[0-9a-f]{64}$/);
    }
    const kinds = Object.fromEntries(index.items.map((i) => [i.relative_path, i.kind]));
    expect(kinds).to.deep.equal({
      [BINARY]: 'unknown',
      [CONVERSATION]: 'conversation',
      [EXPLAINER]: 'explainer',
      [EXPORT]: 'export',
      [INCIDENT]: 'incident',
      'outcomes/2026-09-18.jsonl': 'run_outcome',
      [TOO_LARGE]: 'unknown',
    });
    const conversation = itemFor(index, CONVERSATION);
    expect(conversation).to.include({ status: 'new', skipped_reason: null, distilled_at: null });
    expect(conversation.card_ids).to.deep.equal([]);
    expect(conversation.content_hash).to.equal(sha256(path.join(rawDir, CONVERSATION)));
    expect(conversation.size_bytes).to.equal(fs.statSync(path.join(rawDir, CONVERSATION)).size);
    expect(itemFor(index, BINARY)).to.include({ status: 'skipped', skipped_reason: 'binary' });
    expect(itemFor(index, TOO_LARGE)).to.include({ status: 'skipped', skipped_reason: 'too_large' });
    expect(itemFor(index, TOO_LARGE).size_bytes).to.be.greaterThan(4096);
    expect(changes.added).to.have.length(7);
    expect(changes.changed).to.deep.equal([]);
    expect(changes.removed).to.deep.equal([]);
    expect(await readIndex(indexPath)).to.deep.equal(index);
    expect(fs.existsSync(`${indexPath}.tmp`)).to.equal(false);
  });

  it('keeps a distilled item unchanged while a changed hash resets it to new and clears its cards', async () => {
    const first = await scan();
    const conversation = itemFor(first.index, CONVERSATION);
    const incident = itemFor(first.index, INCIDENT);
    for (const item of [conversation, incident]) {
      item.status = 'distilled';
      item.distilled_at = '2026-09-19T07:00:00.000Z';
      item.card_ids = ['sentinel-stall'];
    }
    await writeIndex(indexPath, first.index);
    fs.appendFileSync(path.join(rawDir, INCIDENT), '\nAddendum: the key had expired a week earlier.\n');

    const second = await scan();
    expect(itemFor(second.index, CONVERSATION)).to.include({
      status: 'distilled', distilled_at: '2026-09-19T07:00:00.000Z',
    });
    expect(itemFor(second.index, CONVERSATION).card_ids).to.deep.equal(['sentinel-stall']);
    const changed = itemFor(second.index, INCIDENT);
    expect(changed).to.include({ status: 'new', distilled_at: null });
    expect(changed.card_ids).to.deep.equal([]);
    expect(changed.content_hash).to.not.equal(incident.content_hash);
    expect(second.changes.changed).to.deep.equal([INCIDENT]);
    expect(second.changes.unchanged).to.include(CONVERSATION).and.include(EXPORT);
    expect(second.changes.added).to.deep.equal([]);
  });

  it('drops files that disappeared and reports them as removed', async () => {
    await scan();
    fs.rmSync(path.join(rawDir, EXPLAINER));
    const { index, changes } = await scan();
    expect(index.items.map((i) => i.relative_path)).to.not.include(EXPLAINER);
    expect(changes.removed).to.deep.equal([EXPLAINER]);
  });

  it('never holds content: only the schema fields, no text from any item', async () => {
    await scan();
    const text = fs.readFileSync(indexPath, 'utf8');
    expect(text).to.not.include('transition error');
    expect(text).to.not.include('ops@example.org');
    expect(text).to.not.include('pilot.example.org');
    expect(text).to.not.include('credential rotation');
    for (const item of JSON.parse(text).items) {
      expect(Object.keys(item).sort()).to.deep.equal(ITEM_KEYS);
    }
  });

  it('re-marks a formerly skipped file as new once it fits the size limit', async () => {
    await scan();
    const { index } = await scan({ maxBytes: 1024 * 1024 });
    expect(itemFor(index, TOO_LARGE)).to.include({ status: 'new', skipped_reason: null });
    expect(itemFor(index, BINARY)).to.include({ status: 'skipped', skipped_reason: 'binary' });
  });

  it('tolerates a missing raw directory and still indexes run outcomes', async () => {
    const { index } = await scanCorpus({
      rawDir: path.join(root, 'nowhere'), outcomesDir, indexPath, now: NOW,
    });
    expect(index.items.map((i) => i.relative_path)).to.deep.equal(['outcomes/2026-09-18.jsonl']);
    expect(index.items[0].kind).to.equal('run_outcome');
  });

  describe('classifyKind and isBinary', () => {
    it('classifies by directory, extension and chat-like text', () => {
      expect(classifyKind('conversations/anything.txt', 'plain')).to.equal('conversation');
      expect(classifyKind('notes/thread.txt', '[09:14] <@U04AB12CD>: hi\n[09:15] Ada: hello')).to.equal('conversation');
      expect(classifyKind('notes/chat.md', 'Ada: hello\nBob: hi there\nAda: ok')).to.equal('conversation');
      expect(classifyKind('exports/anything.md', 'x')).to.equal('export');
      expect(classifyKind('data/series.json', '{}')).to.equal('export');
      expect(classifyKind('data/sheet.xlsx', '')).to.equal('export');
      expect(classifyKind('postmortem-2026-06.md', 'text')).to.equal('incident');
      expect(classifyKind('incidents/x.md', 'text')).to.equal('incident');
      expect(classifyKind('docs/README.md', 'text')).to.equal('explainer');
      expect(classifyKind('explainers/api.md', 'text')).to.equal('explainer');
      expect(classifyKind('misc/notes.txt', 'plain notes without speakers')).to.equal('unknown');
      expect(classifyKind('outcomes/2026-09-18.jsonl', '', { outcome: true })).to.equal('run_outcome');
    });

    it('detects binaries by extension or a NUL byte in the sample', () => {
      expect(isBinary(Buffer.from('abc\u0000def'))).to.equal(true);
      expect(isBinary(Buffer.from('plain text'))).to.equal(false);
      expect(isBinary(Buffer.from('plain'), 'photo.jpg')).to.equal(true);
      expect(isBinary(Buffer.from('plain'), 'notes.md')).to.equal(false);
    });

    it('hashes a file with full SHA-256', async () => {
      const file = path.join(rawDir, EXPLAINER);
      expect(await hashFile(file)).to.equal(sha256(file));
    });
  });
});

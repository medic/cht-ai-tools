const fs = require('node:fs');
const path = require('node:path');
const { appendRecords, readAll } = require('../../src/feedback/store');
const { tempDir, removeDir } = require('../helpers/fixtures');

const record = (overrides = {}) => ({
  feedback_id: 'abcdefabcdef',
  date: '2026-09-18',
  run_id: '2026-09-17',
  target: 'item',
  item_id: '49bd5cd2499f',
  kind: 'reaction',
  verdict: 'down',
  note: null,
  horizon: null,
  author: 'U1',
  matched: true,
  source_ts: '1758088801.000200',
  ...overrides,
});

describe('feedback/store', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  it('appends validated records to feedback.jsonl and skips ids already present', async () => {
    const first = await appendRecords(dataDir, [record(), record({ feedback_id: 'bbbbbbbbbbbb', author: 'U2' })]);
    expect(first).to.deep.equal({ appended: 2, skipped: 0 });
    const again = await appendRecords(dataDir, [record(), record({ feedback_id: 'cccccccccccc', author: 'U3' })]);
    expect(again).to.deep.equal({ appended: 1, skipped: 1 });
    const lines = fs.readFileSync(path.join(dataDir, 'feedback.jsonl'), 'utf8').trim().split('\n');
    expect(lines).to.have.length(3);
    expect(await readAll(dataDir)).to.have.length(3);
  });

  it('rejects an invalid record before writing anything', async () => {
    await expect(appendRecords(dataDir, [record({ verdict: 'meh' })])).to.be.rejected;
    await expect(appendRecords(dataDir, [record({ target: 'item', item_id: null })])).to.be.rejected;
    expect(fs.existsSync(path.join(dataDir, 'feedback.jsonl'))).to.equal(false);
  });

  it('returns an empty list when no feedback has ever been recorded', async () => {
    expect(await readAll(dataDir)).to.deep.equal([]);
  });
});

describe('feedback/store: acknowledgement and review fields (US7)', () => {
  const {
    appendRecords, readAll, readUnacknowledged, markAcknowledged, updateRecords,
  } = require('../../src/feedback/store');
  const { schemas, enums } = require('../../src/model/schemas');
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  const base = (overrides = {}) => ({
    feedback_id: 'abcdefabcdef',
    date: '2026-09-18',
    run_id: '2026-09-17',
    target: 'item',
    item_id: '49bd5cd2499f',
    kind: 'note',
    verdict: null,
    note: 'known migration until 1 October',
    horizon: '2026-10-01',
    author: 'U1',
    matched: true,
    source_ts: '1758088801.000200',
    ...overrides,
  });

  it('parses records written before the new fields existed, defaulting them to null', () => {
    const parsed = schemas.Feedback.parse(base());
    expect(parsed).to.include({ acknowledged_run_id: null, classification: null, proposal_id: null });
    expect(enums.FeedbackClassification.options).to.deep.equal([
      'expectation', 'project_annotation', 'skill', 'prompt', 'threshold', 'pattern_card', 'none',
    ]);
    expect(() => schemas.Feedback.parse(base({ classification: 'other' }))).to.throw();
    expect(enums.ProposalType.options).to.include('project_annotation');
    expect(schemas.CalibrationReport.shape.open_proposals).to.not.equal(undefined);
  });

  it('lists unacknowledged records and marks them once, preserving every other record byte for byte', async () => {
    const reaction = base({ feedback_id: 'bbbbbbbbbbbb', kind: 'reaction', verdict: 'up', note: null, horizon: null });
    await appendRecords(dataDir, [base(), reaction]);
    const before = await readUnacknowledged(dataDir);
    expect(before.map((r) => r.feedback_id)).to.deep.equal(['abcdefabcdef', 'bbbbbbbbbbbb']);
    const marked = await markAcknowledged(dataDir, ['abcdefabcdef'], '2026-09-18');
    expect(marked).to.equal(1);
    const after = await readAll(dataDir);
    expect(after.find((r) => r.feedback_id === 'abcdefabcdef').acknowledged_run_id).to.equal('2026-09-18');
    expect(after.find((r) => r.feedback_id === 'bbbbbbbbbbbb').acknowledged_run_id).to.equal(null);
    expect((await readUnacknowledged(dataDir)).map((r) => r.feedback_id)).to.deep.equal(['bbbbbbbbbbbb']);
    // Marking again changes nothing: the first acknowledging run wins.
    expect(await markAcknowledged(dataDir, ['abcdefabcdef'], '2026-09-19')).to.equal(0);
    expect((await readAll(dataDir))[0].acknowledged_run_id).to.equal('2026-09-18');
    expect(fs.existsSync(path.join(dataDir, 'feedback.jsonl.tmp'))).to.equal(false);
  });

  it('updates classification and proposal id on a record through updateRecords, validating the result', async () => {
    await appendRecords(dataDir, [base()]);
    const changed = await updateRecords(dataDir, (record) => (record.feedback_id === 'abcdefabcdef'
      ? { ...record, classification: 'project_annotation', proposal_id: '2026-09-18-project_annotation-alpha-note' }
      : record));
    expect(changed).to.equal(1);
    const [stored] = await readAll(dataDir);
    expect(stored)
      .to.include({ classification: 'project_annotation', proposal_id: '2026-09-18-project_annotation-alpha-note' });
    await expect(updateRecords(dataDir, (record) => ({ ...record, classification: 'bogus' }))).to.be.rejected;
    expect((await readAll(dataDir))[0].classification).to.equal('project_annotation');
  });
});

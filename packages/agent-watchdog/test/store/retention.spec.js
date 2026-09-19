const fs = require('node:fs');
const path = require('node:path');
const { classify, purge } = require('../../src/store/retention');
const { RunDir, dataPaths, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const NOW = new Date('2026-09-18T06:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);

describe('store/retention', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir(); await ensureDataLayout(dataDir); 
  });
  afterEach(() => removeDir(dataDir));

  it('classifies files into raw, kept and durable', () => {
    expect(classify('runs/2026-09-01/cht-x/inputs/windows.json.gz')).to.equal('raw');
    expect(classify('runs/2026-09-01/rollup/brief.png')).to.equal('raw');
    expect(classify('runs/2026-09-01/rollup/report.html')).to.equal('kept');
    expect(classify('runs/2026-09-01/run.json')).to.equal('kept');
    expect(classify('calibration/2026-W36.json')).to.equal('kept');
    expect(classify('memory/memory.md')).to.equal('durable');
    expect(classify('proposals/2026-09-01-threshold-x.md')).to.equal('durable');
    expect(classify('corpus/index.json')).to.equal('durable');
    expect(classify('knowledge-corpus/raw/x.txt')).to.equal('durable');
  });

  it('removes raw files after the raw period and whole runs after the kept period', async () => {
    const old = await RunDir.create(dataDir, daysAgo(40));
    await old.writeJson('run.json', { run_id: old.runId });
    const mid = await RunDir.create(dataDir, daysAgo(20));
    await mid.writeJson('run.json', { run_id: mid.runId });
    await mid.writeGz('cht-x/inputs/windows.json.gz', { a: 1 });
    await mid.writeJson('cht-x/changes.json', { b: 2 });
    fs.mkdirSync(path.join(mid.root, 'rollup'));
    fs.writeFileSync(path.join(mid.root, 'rollup', 'brief.png'), 'png');
    const fresh = await RunDir.create(dataDir, daysAgo(3));
    await fresh.writeGz('cht-x/inputs/windows.json.gz', { a: 1 });

    const result = await purge(dataDir, { rawDays: 14, keptDays: 30, now: NOW });

    expect(fs.existsSync(old.root)).to.equal(false);
    expect(fs.existsSync(path.join(mid.root, 'cht-x', 'inputs', 'windows.json.gz'))).to.equal(false);
    expect(fs.existsSync(path.join(mid.root, 'rollup', 'brief.png'))).to.equal(false);
    expect(fs.existsSync(path.join(mid.root, 'cht-x', 'changes.json'))).to.equal(true);
    expect(fs.existsSync(path.join(fresh.root, 'cht-x', 'inputs', 'windows.json.gz'))).to.equal(true);
    expect(result.removed.map((r) => r.class).sort()).to.deep.equal(['kept', 'raw', 'raw']);
  });

  it('reports without deleting in dry-run mode', async () => {
    const old = await RunDir.create(dataDir, daysAgo(45));
    const result = await purge(dataDir, { rawDays: 14, keptDays: 30, now: NOW, dryRun: true });
    expect(result.removed).to.have.length(1);
    expect(fs.existsSync(old.root)).to.equal(true);
  });

  it('compacts feedback.jsonl only for records whose outcomes were appended to the corpus', async () => {
    const p = dataPaths(dataDir);
    const oldDate = daysAgo(45);
    const otherOld = daysAgo(50);
    fs.writeFileSync(p.feedbackFile, [
      JSON.stringify({ feedback_id: 'a', date: oldDate, item_id: 'i1' }),
      JSON.stringify({ feedback_id: 'b', date: otherOld, item_id: 'i2' }),
      JSON.stringify({ feedback_id: 'c', date: daysAgo(2), item_id: 'i3' }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(p.corpusOutcomes, `${oldDate}.jsonl`), JSON.stringify({ item_id: 'i1' }) + '\n');
    const result = await purge(dataDir, { rawDays: 14, keptDays: 30, now: NOW });
    const remaining = fs.readFileSync(p.feedbackFile, 'utf8').trim().split('\n')
      .map(JSON.parse).map((r) => r.feedback_id);
    expect(remaining).to.deep.equal(['b', 'c']);
    expect(result.compacted).to.equal(1);
  });
});

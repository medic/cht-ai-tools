const fs = require('node:fs');
const path = require('node:path');
const { RunDir, RunExistsError, dataPaths, ensureDataLayout } = require('../../src/store/run-dir');
const atomic = require('../../src/store/atomic');
const { tempDir, removeDir } = require('../helpers/fixtures');

describe('store/atomic', () => {
  let dir;
  beforeEach(() => {
    dir = tempDir(); 
  });
  afterEach(() => removeDir(dir));

  it('writes through a temporary file and renames, leaving no .tmp behind', async () => {
    const file = path.join(dir, 'a', 'b.json');
    await atomic.writeJsonAtomic(file, { x: 1 });
    expect(fs.readdirSync(path.join(dir, 'a'))).to.deep.equal(['b.json']);
    expect(await atomic.readJson(file)).to.deep.equal({ x: 1 });
  });

  it('round-trips gzip JSON', async () => {
    const file = path.join(dir, 'w.json.gz');
    const big = { values: Array.from({ length: 1000 }, (_, i) => [i, String(i)]) };
    await atomic.writeGzipJsonAtomic(file, big);
    expect(fs.readFileSync(file)[0]).to.equal(0x1f);
    expect(await atomic.readGzipJson(file)).to.deep.equal(big);
  });

  it('appends and reads JSON lines', async () => {
    const file = path.join(dir, 'f.jsonl');
    await atomic.appendJsonl(file, { a: 1 });
    await atomic.appendJsonl(file, { a: 2 });
    expect(await atomic.readJsonl(file)).to.deep.equal([{ a: 1 }, { a: 2 }]);
    expect(await atomic.readJsonl(path.join(dir, 'missing.jsonl'))).to.deep.equal([]);
  });
});

describe('store/run-dir', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir(); 
  });
  afterEach(() => removeDir(dataDir));

  it('lays out the data directory from the run-directory contract', async () => {
    await ensureDataLayout(dataDir);
    const p = dataPaths(dataDir);
    const dirs = [
      p.runs, p.memory, p.memoryHistory, p.proposals, p.corpus, p.corpusOutcomes, p.corpusCardsProposed, p.calibration,
    ];
    for (const d of dirs) {
      expect(fs.statSync(d).isDirectory(), d).to.equal(true);
    }
    expect(p.feedbackFile).to.equal(path.join(dataDir, 'feedback.jsonl'));
    expect(p.memoryFile).to.equal(path.join(dataDir, 'memory', 'memory.md'));
    expect(p.corpusIndex).to.equal(path.join(dataDir, 'corpus', 'index.json'));
  });

  it('creates a run directory once and refuses a duplicate date without force', async () => {
    const run = await RunDir.create(dataDir, '2026-09-18');
    expect(run.root).to.equal(path.join(dataDir, 'runs', '2026-09-18'));
    let error;
    try {
      await RunDir.create(dataDir, '2026-09-18'); 
    } catch (e) {
      error = e; 
    }
    expect(error).to.be.instanceOf(RunExistsError);
    expect(error.code).to.equal(75);
  });

  it('allocates forced run ids as <date>-f<n>', async () => {
    await RunDir.create(dataDir, '2026-09-18');
    expect(await RunDir.nextForcedId(dataDir, '2026-09-18')).to.equal('2026-09-18-f1');
    await RunDir.create(dataDir, '2026-09-18-f1');
    expect(await RunDir.nextForcedId(dataDir, '2026-09-18')).to.equal('2026-09-18-f2');
  });

  it('reads and writes project files and JSON lines under the contract layout', async () => {
    const run = await RunDir.create(dataDir, '2026-09-18');
    await run.writeJson('discovery.json', { projects: [] });
    await run.writeGz('cht-example-org/inputs/windows.json.gz', { windows: [1] });
    await run.appendJsonl('cht-example-org/tool-calls.jsonl', { tool: 'x' });
    expect(await run.readJson('discovery.json')).to.deep.equal({ projects: [] });
    expect(await run.readGz('cht-example-org/inputs/windows.json.gz')).to.deep.equal({ windows: [1] });
    expect(await run.readJsonl('cht-example-org/tool-calls.jsonl')).to.deep.equal([{ tool: 'x' }]);
    expect(run.exists('discovery.json')).to.equal(true);
    expect(run.exists('nope.json')).to.equal(false);
    expect(run.projectPath('cht-example-org', 'changes.json'))
      .to.equal(path.join(run.root, 'cht-example-org', 'changes.json'));
  });

  it('tracks stage boundaries in run.json with monotonic durations', async () => {
    const run = await RunDir.create(dataDir, '2026-09-18');
    await run.updateRun({ run_id: '2026-09-18', date: '2026-09-18', mode: 'scheduled', status: 'created' });
    await run.stageStart('collect');
    await run.stageEnd('collect', 'completed');
    const record = await run.readJson('run.json');
    expect(record.status).to.equal('created');
    expect(record.stages).to.have.length(1);
    expect(record.stages[0]).to.include({ name: 'collect', status: 'completed' });
    expect(record.stages[0].started_at).to.match(/^\d{4}-/);
    expect(record.stages[0].duration_ms).to.be.a('number');
    expect(record.updated_at).to.be.a('string');
  });

  it('lists existing run ids sorted', async () => {
    await RunDir.create(dataDir, '2026-09-17');
    await RunDir.create(dataDir, '2026-09-18');
    expect(await RunDir.list(dataDir)).to.deep.equal(['2026-09-17', '2026-09-18']);
  });
});

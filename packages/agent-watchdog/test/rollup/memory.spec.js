const fs = require('node:fs');
const path = require('node:path');
const { readMemory, estimateTokens, applyMemoryUpdate, unifiedDiff } = require('../../src/rollup/memory');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

describe('rollup/memory (FR-031)', () => {
  let dataDir;
  let runDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    runDir = await RunDir.create(dataDir, '2026-09-18');
  });
  afterEach(() => removeDir(dataDir));

  const update = (over) => applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', maxTokens: 4000, ...over });

  it('reads an empty memory as empty text at version 0 and estimates tokens as chars over four', async () => {
    expect(await readMemory(dataDir)).to.deep.equal({ text: '', version: 0 });
    expect(estimateTokens('abcd'.repeat(10))).to.equal(10);
    expect(estimateTokens('abcde')).to.equal(2);
  });

  it('reports no change for a null update or identical text and writes nothing', async () => {
    const none = await applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', replaceWith: null, maxTokens: 4000 });
    expect(none).to.include({ applied: false, reason: 'no change', version: 0 });
    const same = await applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', replaceWith: '', maxTokens: 4000 });
    expect(same.applied).to.equal(false);
    expect(fs.existsSync(path.join(dataDir, 'memory', 'memory.md'))).to.equal(false);
    expect(runDir.exists('memory.patch')).to.equal(false);
  });

  it('condenses an update over the cap by code, counting a ten percent margin, instead of refusing it', async () => {
    const text = `${Array.from({ length: 40 }, (_, i) => `note ${i + 1}`).join('\n')}\n`;
    expect(Math.ceil(estimateTokens(text) * 1.1)).to.be.greaterThan(60);
    const result = await applyMemoryUpdate({ dataDir, runDir, runId: '2026-09-18', replaceWith: text, maxTokens: 60 });
    expect(result).to.include({ applied: true, reason: 'condensed', condensed_by: 'code', version: 1 });
    const stored = fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8');
    expect(Math.ceil(estimateTokens(stored) * 1.1)).to.be.at.most(60);
    expect(stored).to.match(/^<!-- condensed by code: \d+ lines dropped -->\n/);
    expect(stored.endsWith('note 40\n')).to.equal(true);
  });

  it('applies an update, bumps the version and writes the same unified diff to both patch locations', async () => {
    const first = 'alpha: sentinel backlog is expected to stay high until 1 October\n';
    const applied = await update({ replaceWith: first });
    expect(applied).to.include({ applied: true, version: 1, patch_path: 'memory/history/2026-09-18.patch' });
    expect(fs.readFileSync(path.join(dataDir, 'memory', 'memory.md'), 'utf8')).to.equal(first);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'memory.json'), 'utf8')).version).to.equal(1);
    const historyPatch = fs.readFileSync(path.join(dataDir, 'memory', 'history', '2026-09-18.patch'), 'utf8');
    const runPatch = fs.readFileSync(runDir.path('memory.patch'), 'utf8');
    expect(runPatch).to.equal(historyPatch);
    expect(historyPatch).to.include('--- ').and.include('+++ ').and.include('@@ ');
    expect(historyPatch).to.include('+alpha: sentinel backlog is expected to stay high until 1 October');

    const runTwo = await RunDir.create(dataDir, '2026-09-19');
    const second = 'alpha: sentinel backlog is expected to stay high until 1 October\nbeta: quiet\n';
    const again = await update({ runDir: runTwo, runId: '2026-09-19', replaceWith: second });
    expect(again).to.include({ applied: true, version: 2 });
    const patch = fs.readFileSync(path.join(dataDir, 'memory', 'history', '2026-09-19.patch'), 'utf8');
    expect(patch).to.include('+beta: quiet');
    expect(patch).to.not.include('-alpha');
    expect((await readMemory(dataDir)).version).to.equal(2);
  });

  it('shows removed lines with a minus in the diff', async () => {
    await update({ replaceWith: 'one\ntwo\nthree\n' });
    const runTwo = await RunDir.create(dataDir, '2026-09-19');
    await update({ runDir: runTwo, runId: '2026-09-19', replaceWith: 'one\nthree\n' });
    const patch = fs.readFileSync(runTwo.path('memory.patch'), 'utf8');
    expect(patch).to.include('-two');
    expect(patch).to.match(/@@ -1,3 \+1,2 @@/);
  });

  describe('unifiedDiff', () => {
    it('returns an empty patch for identical text', () => {
      expect(unifiedDiff('a\nb\n', 'a\nb\n')).to.equal('');
    });

    it('offsets the hunk past unchanged leading lines and lists trailing removals and additions', () => {
      const before = `${['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'tail'].join('\n')}\n`;
      const after = `${['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'new1', 'new2'].join('\n')}\n`;
      const patch = unifiedDiff(before, after);
      expect(patch).to.match(/@@ -4,4 \+4,5 @@/);
      expect(patch).to.include(' l4\n').and.include('-tail\n').and.include('+new1\n+new2\n');
      expect(patch).to.not.include('l1');
    });

    it('describes a brand-new file from an empty range', () => {
      expect(unifiedDiff('', 'alpha\n')).to.match(/@@ -0,0 \+1,1 @@\n\+alpha\n$/);
    });
  });
});

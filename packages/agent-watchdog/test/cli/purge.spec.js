// The purge command (FR-040, contracts/cli.md): retention applied on demand, --dry-run lists without deleting,
// durable files untouched. The same retention runs as the first stage of every run.
const fs = require('node:fs');
const path = require('node:path');
const purgeCommand = require('../../src/cli/commands/purge');
const { RunDir, dataPaths, ensureDataLayout } = require('../../src/store/run-dir');
const { STAGE_ORDER } = require('../../src/cli/stages');
const { createLogger } = require('../../src/log/logger');
const { capture, DEFAULTS_DIR } = require('./helpers');
const { tempDir, removeDir } = require('../helpers/fixtures');

const NOW = new Date('2026-09-18T06:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);

describe('cli/commands/purge', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    const old = await RunDir.create(dataDir, daysAgo(40));
    await old.writeJson('run.json', { run_id: old.runId });
    const mid = await RunDir.create(dataDir, daysAgo(20));
    await mid.writeJson('run.json', { run_id: mid.runId });
    await mid.writeGz('cht-x/inputs/windows.json.gz', { a: 1 });
    await mid.writeJson('cht-x/changes.json', { b: 2 });
    fs.writeFileSync(dataPaths(dataDir).feedbackFile, `${JSON.stringify({ feedback_id: 'a', date: daysAgo(400) })}\n`);
    fs.writeFileSync(path.join(dataPaths(dataDir).alerts, 'episodes.jsonl'), '{"event":"opened"}\n');
  });
  afterEach(() => removeDir(dataDir));

  const run = async (flags = {}) => {
    const out = capture();
    const err = capture();
    const code = await purgeCommand({
      command: 'purge',
      flags,
      positionals: [],
      // Deliberately minimal: purge needs the data volume and the retention settings only.
      env: { AGENT_WATCHDOG_DATA_DIR: dataDir, AGENT_WATCHDOG_CONFIG_DIR: DEFAULTS_DIR },
      stdout: out.stream,
      stderr: err.stream,
      logger: createLogger({ stream: err.stream, level: 'info' }),
      deps: { now: () => NOW },
    });
    return { code, out: JSON.parse(out.text()), err: err.text() };
  };

  it('is the first stage of every run', () => {
    expect(STAGE_ORDER[0]).to.equal('purge');
  });

  it('lists what would be removed with --dry-run and deletes nothing', async () => {
    const { code, out, err } = await run({ 'dry-run': true });
    expect(code).to.equal(0);
    expect(out.dry_run).to.equal(true);
    expect(out.retention).to.deep.equal({ raw_days: 14, kept_days: 30 });
    expect(out.removed.map((r) => r.class).sort()).to.deep.equal(['kept', 'raw']);
    expect(out.removed.find((r) => r.class === 'kept').path).to.equal(path.join('runs', daysAgo(40)));
    expect(fs.existsSync(path.join(dataDir, 'runs', daysAgo(40)))).to.equal(true);
    expect(fs.existsSync(path.join(dataDir, 'runs', daysAgo(20), 'cht-x', 'inputs', 'windows.json.gz'))).to.equal(true);
    expect(err).to.include('purge.would_remove');
  });

  it('applies retention for real and leaves durable files alone', async () => {
    const { code, out } = await run();
    expect(code).to.equal(0);
    expect(out.dry_run).to.equal(false);
    expect(out.removed).to.have.length(2);
    expect(out.compacted).to.equal(0);
    expect(fs.existsSync(path.join(dataDir, 'runs', daysAgo(40)))).to.equal(false);
    const rawFile = path.join(dataDir, 'runs', daysAgo(20), 'cht-x', 'inputs', 'windows.json.gz');
    expect(fs.existsSync(rawFile)).to.equal(false);
    expect(fs.existsSync(path.join(dataDir, 'runs', daysAgo(20), 'cht-x', 'changes.json'))).to.equal(true);
    expect(fs.readFileSync(dataPaths(dataDir).feedbackFile, 'utf8')).to.include('"feedback_id":"a"');
    expect(fs.existsSync(path.join(dataPaths(dataDir).alerts, 'episodes.jsonl'))).to.equal(true);
    const again = await run();
    expect(again.out.removed).to.deep.equal([]);
  });
});

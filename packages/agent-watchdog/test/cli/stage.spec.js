// One stage at a time (FR-043, US3 scenario 6): each stage reads the previous stage's files and writes its own.
const fs = require('node:fs');
const path = require('node:path');
const runCommand = require('../../src/cli/commands/run');
const codes = require('../../src/cli/exit-codes');
const { createFakeGrafana } = require('../helpers/fake-grafana');
const { fixturePath, tempDir, removeDir } = require('../helpers/fixtures');
const { DATE, fakeStages, runArgs, attempt } = require('./helpers');

const runRoot = (dataDir, runId = DATE) => path.join(dataDir, 'runs', runId);
const readRun = (dataDir, runId = DATE) => JSON.parse(
  fs.readFileSync(path.join(runRoot(dataDir, runId), 'run.json'), 'utf8'),
);
const readJson = (dataDir, rel) => JSON.parse(fs.readFileSync(path.join(runRoot(dataDir), rel), 'utf8'));

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

describe('cli/commands/run --stage', function () {
  this.timeout(20000);
  let dataDir;
  beforeEach(() => {
    dataDir = tempDir();
  });
  afterEach(() => removeDir(dataDir));

  // The real collect stage against the fake Grafana; every other stage stays scripted.
  const collectArgs = (extra = {}) => {
    const fake = createFakeGrafana({ fixtureDir: fixturePath('runs', 'seeded-anomaly') });
    const { stages } = fakeStages();
    delete stages.collect;
    delete stages.analyze;
    delete stages.render;
    return runArgs(dataDir, { flags: { stage: 'collect' }, deps: { stages, fetch: fake.fetch, ...extra } });
  };

  it('creates the run directory when the first stage runs on a date with no run yet', async () => {
    const { stages, calls } = fakeStages();
    const t = runArgs(dataDir, { flags: { stage: 'collect' }, deps: { stages } });
    const { code, error } = await attempt(runCommand, t.args);
    expect(error, error && error.stack).to.equal(null);
    expect(code).to.equal(0);
    expect(calls).to.deep.equal(['collect']);
    const run = readRun(dataDir);
    expect(run).to.include({ run_id: DATE, date: DATE, mode: 'stage', status: 'created' });
    expect(Object.keys(run.versions).sort()).to.deep.equal([
      'config_hash', 'git_sha', 'package', 'prompts_hash', 'schema_hash', 'skill_hash',
    ]);
    expect(run.stage_runs).to.have.length(1);
    expect(run.stage_runs[0]).to.include({ stage: 'collect', mode: 'stage' });
    expect(run.stages.map((s) => s.name)).to.deep.equal(['collect']);
    expect(fs.existsSync(path.join(runRoot(dataDir), 'config.effective.json'))).to.equal(true);
  });

  it('opens the latest run of the date, including a forced one, rather than creating another', async () => {
    const full = runArgs(dataDir, { deps: { stages: fakeStages().stages } });
    expect((await attempt(runCommand, full.args)).code).to.equal(0);
    const forced = runArgs(dataDir, { flags: { force: true }, deps: { stages: fakeStages().stages } });
    expect((await attempt(runCommand, forced.args)).code).to.equal(0);
    const { stages, calls } = fakeStages();
    const t = runArgs(dataDir, { flags: { stage: 'analyze' }, deps: { stages } });
    expect((await attempt(runCommand, t.args)).code).to.equal(0);
    expect(calls).to.deep.equal(['analyze']);
    expect(fs.readdirSync(path.join(dataDir, 'runs')).sort()).to.deep.equal([DATE, `${DATE}-f1`]);
    expect(readRun(dataDir, `${DATE}-f1`).stage_runs).to.have.length(1);
    expect(readRun(dataDir).stage_runs || []).to.have.length(0);
    expect(readRun(dataDir, `${DATE}-f1`).status).to.equal('published');
  });

  it('collect then analyze: analyze reads the collected files and contacts neither Grafana nor Slack', async () => {
    const collected = await attempt(runCommand, collectArgs().args);
    expect(collected.error, collected.error && collected.error.stack).to.equal(null);
    expect(fs.existsSync(path.join(runRoot(dataDir), 'discovery.json'))).to.equal(true);
    expect(fs.existsSync(path.join(runRoot(dataDir), 'alpha-example-org', 'inputs', 'windows.json.gz'))).to.equal(true);

    const noNetwork = sinon.stub().rejects(new Error('network must not be used'));
    const { stages } = fakeStages();
    delete stages.analyze;
    const t = runArgs(dataDir, { flags: { stage: 'analyze' }, deps: { stages, fetch: noNetwork } });
    const { code, error } = await attempt(runCommand, t.args);
    expect(error, error && error.stack).to.equal(null);
    expect(code).to.equal(0);
    expect(noNetwork).to.not.have.been.called;
    expect(t.slackPublisher.postFailureNotice).to.not.have.been.called;
    const candidates = readJson(dataDir, 'alpha-example-org/candidates.json');
    expect(candidates.some((c) => c.metric === 'cht_sentinel_backlog_count')).to.equal(true);
    expect(readJson(dataDir, 'alpha-example-org/changes.json')).to.be.an('array').that.is.not.empty;
    const run = readRun(dataDir);
    expect(run.stage_runs.map((s) => s.stage)).to.deep.equal(['collect', 'analyze']);
    expect(run.status).to.equal('created');
  });

  it('exits 65 naming the missing input when a previous stage file was deleted', async () => {
    await attempt(runCommand, collectArgs().args);
    fs.rmSync(path.join(runRoot(dataDir), 'alpha-example-org', 'inputs', 'windows.json.gz'));
    const { stages } = fakeStages();
    delete stages.analyze;
    const t = runArgs(dataDir, { flags: { stage: 'analyze' }, deps: { stages, fetch: sinon.stub() } });
    const { error } = await attempt(runCommand, t.args);
    expect(error.code).to.equal(codes.DATAERR);
    expect(error.message).to.include('alpha-example-org/inputs/windows.json.gz');
    expect(readRun(dataDir).stages.find((s) => s.name === 'analyze').status).to.equal('failed');
  });

  it('exits 65 naming rollup/brief.json when render runs before rollup', async () => {
    await attempt(runCommand, collectArgs().args);
    const { stages } = fakeStages();
    delete stages.render;
    const t = runArgs(dataDir, { flags: { stage: 'render' }, deps: { stages } });
    const { error } = await attempt(runCommand, t.args);
    expect(error.code).to.equal(codes.DATAERR);
    expect(error.message).to.include('rollup/brief.json');
  });

  it('re-running a stage overwrites its outputs atomically and leaves the status alone', async () => {
    await attempt(runCommand, collectArgs().args);
    const analyze = () => {
      const { stages } = fakeStages();
      delete stages.analyze;
      const t = runArgs(dataDir, { flags: { stage: 'analyze' }, deps: { stages, fetch: sinon.stub() } });
      return attempt(runCommand, t.args);
    };
    expect((await analyze()).code).to.equal(0);
    const changesFile = path.join(runRoot(dataDir), 'alpha-example-org', 'changes.json');
    const first = fs.readFileSync(changesFile, 'utf8');
    const before = fs.statSync(changesFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await analyze()).code).to.equal(0);
    expect(fs.readFileSync(changesFile, 'utf8')).to.equal(first);
    expect(fs.statSync(changesFile).mtimeMs).to.be.greaterThan(before);
    expect(walk(runRoot(dataDir)).filter((f) => f.endsWith('.tmp'))).to.deep.equal([]);
    const run = readRun(dataDir);
    expect(run.stage_runs.map((s) => s.stage)).to.deep.equal(['collect', 'analyze', 'analyze']);
    expect(run.status).to.equal('created');
  });
});

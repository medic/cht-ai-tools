// Edge Cases, FR-013: a run over fifty projects completes within AGENT_WATCHDOG_RUN_TIMEOUT_MS at concurrency 3, and a
// project without candidates opens no model session. The seeded day is replayed across aliased hosts: a third mirror
// the sentinel climb, a third the down scrape target, a third the quiet project. The fake adds per-host noise, so a
// few quiet mirrors may cross the deviation rule by chance; the assertions therefore follow each project's own
// candidates rather than a fixed count.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase } = require('../e2e/helpers');

const PROJECTS = 50;
const SOURCES = ['alpha.example.org', 'gamma.example.org', 'beta.example.org'];
const RUN_TIMEOUT_MS = 3600000;

describe('perf: fifty projects at concurrency 3 (Edge Cases, FR-013)', function () {
  this.timeout(600000);
  let dataDir;
  before(() => {
    dataDir = tempDir();
  });
  after(() => removeDir(dataDir));

  it('completes well within the run timeout and skips the quiet projects without an engine call', async function () {
    const hostAliases = {};
    for (let i = 3; i < PROJECTS; i += 1) {
      hostAliases[`p${String(i).padStart(2, '0')}.example.org`] = SOURCES[i % 3];
    }
    const quietMirrors = 1 + Object.values(hostAliases).filter((source) => source === 'beta.example.org').length;
    const started = process.hrtime.bigint();
    const r = await runCase({
      caseName: 'seeded-anomaly', dataDir, hostAliases,
      envExtra: { AGENT_WATCHDOG_PROJECT_CONCURRENCY: '3', AGENT_WATCHDOG_RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS) },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.test.title += ` (${Math.round(elapsedMs)} ms for ${PROJECTS} projects)`;
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    expect(r.code).to.equal(0);
    expect(r.read('run.json').status).to.equal('published');
    expect(elapsedMs).to.be.below(RUN_TIMEOUT_MS);
    expect(r.read('config.effective.json').bounds.projectConcurrency).to.equal(3);
    expect(r.read('discovery.json').projects).to.have.length(PROJECTS);

    const summary = r.read('agent.summary.json');
    const slugOf = (url) => new URL(url).host.replace(/[^a-z0-9]+/g, '-');
    const candidatesOf = (url) => JSON.parse(fs.readFileSync(path.join(r.root, slugOf(url), 'candidates.json')));
    expect(summary.projects_skipped.length + summary.projects_analysed.length).to.equal(PROJECTS);
    // Most of the quiet third stays quiet; every skipped project had no candidates and opened no session.
    expect(summary.projects_skipped.length).to.be.at.least(Math.floor(quietMirrors * 0.6));
    for (const url of summary.projects_skipped) {
      expect(candidatesOf(url), url).to.deep.equal([]);
      expect(fs.existsSync(path.join(r.root, slugOf(url), 'session.json')), url).to.equal(false);
    }
    // Every analysed project had candidates and exactly one session; sessions never exceed analysed projects.
    for (const url of summary.projects_analysed) {
      expect(candidatesOf(url).length, url).to.be.above(0);
      expect(fs.existsSync(path.join(r.root, slugOf(url), 'session.json')), url).to.equal(true);
    }
    expect(r.engine.calls.sessions).to.have.length(summary.projects_analysed.length);
    expect(r.read('run.json').bounds_hit).to.deep.equal([]);
    // SC-010: the end-of-run scan over every artefact of fifty projects raises no warning.
    expect(r.err.text()).to.not.include('run.scan_findings');
    const brief = r.read('rollup/brief.json');
    expect(brief.bullets).to.have.length(5);
    expect(r.read('rollup/payload.json').replies).to.have.length(r.read('rollup/items.ranked.json').length);
  });
});

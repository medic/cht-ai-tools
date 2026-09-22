// Edge Cases, FR-013: a run over fifty projects completes within AGENT_WATCHDOG_RUN_TIMEOUT_MS at concurrency 3, and a
// project without candidates opens no model session. The seeded day is replayed across aliased hosts: a third mirror
// the sentinel climb, a third the down scrape target, a third the quiet project. The fake adds per-host noise, so a
// few quiet mirrors may cross the deviation rule by chance; the assertions therefore follow each project's own
// candidates rather than a fixed count.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase } = require('../e2e/helpers');
const { readGzipJson } = require('../../src/store/atomic');

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
    // One session per analysed project, plus the roll-up's own session (FR-017, revision 23).
    expect(r.engine.calls.sessions).to.have.length(summary.projects_analysed.length + 1);
    expect(r.read('run.json').bounds_hit).to.deep.equal([]);
    // SC-010: the end-of-run scan over every artefact of fifty projects raises no warning.
    expect(r.err.text()).to.not.include('run.scan_findings');
    const brief = r.read('rollup/brief.json');
    expect(brief.bullets).to.have.length(5);
    // Replies for the high items only, at most twenty-five (FR-020, revision 25); the report holds every item.
    const payload = r.read('rollup/payload.json');
    const high = r.read('rollup/items.ranked.json').filter((i) => i.severity === 'high').length;
    expect(payload.replies).to.have.length(Math.min(25, high));
    expect(payload.report.items).to.equal(r.read('rollup/items.ranked.json').length);

    // FR-072: a cold volume fetches four windows per metric; the next day reuses the previous-day window and the
    // ledger, so only the current and previous-week windows are fetched and no trailing query is sent.
    const metrics = r.read('discovery.json').metrics.length;
    const rangeQueries = (run) => run.fake.calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname.endsWith('/api/v1/query_range'))
      .map((u) => u.searchParams.get('query'));
    // Plus one range query per project from discovery, which reads the scrape target's history length.
    expect(rangeQueries(r)).to.have.length(PROJECTS * (metrics * 4 + 1));
    const day2 = await runCase({
      caseName: 'seeded-anomaly', dataDir, hostAliases, date: '2026-09-19', runStart: '2026-09-19T06:00:00Z',
      envExtra: { AGENT_WATCHDOG_PROJECT_CONCURRENCY: '3', AGENT_WATCHDOG_RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS) },
    });
    expect(day2.error, day2.error && day2.error.stack).to.equal(undefined);
    expect(day2.code).to.equal(0);
    const warm = rangeQueries(day2);
    // Every fetched window is one query, plus discovery's one history query per project. A metric with no data
    // cannot be reused (yesterday's current window was empty, the ledger has no day for it), so it is fetched again.
    const all = [];
    for (const project of day2.read('discovery.json').projects) {
      all.push(...(await readGzipJson(path.join(day2.root, project.slug, 'inputs', 'windows.json.gz'))).windows);
    }
    const fetched = all.filter((w) => w.source === 'fetched');
    const reused = all.filter((w) => w.source !== 'fetched');
    expect(warm).to.have.length(fetched.length + PROJECTS);
    expect(reused.length).to.be.at.least(all.length * 0.45);
    // Trailing queries: only the trailing windows fetched again, plus discovery's history query per project.
    const trailingFetched = fetched.filter((w) => w.window === 'trailing_14d').length;
    expect(warm.filter((q) => q.includes('max_over_time'))).to.have.length(trailingFetched + PROJECTS);
    expect(trailingFetched).to.be.below(all.filter((w) => w.window === 'trailing_14d').length * 0.2);
    const alpha = all.filter((w) => w.project_url === 'https://alpha.example.org');
    const withData = (name) => alpha.filter((w) => w.window === name && w.available);
    expect(withData('current').length).to.be.above(0);
    expect(withData('current').every((w) => w.source === 'fetched')).to.equal(true);
    expect(withData('previous_day').every((w) => w.source === 'stored:2026-09-18')).to.equal(true);
    expect(withData('previous_week').every((w) => w.source === 'fetched')).to.equal(true);
    expect(withData('trailing_14d').every((w) => w.source === 'ledger')).to.equal(true);
    expect(fs.existsSync(path.join(dataDir, 'history', 'alpha-example-org.json'))).to.equal(true);
  });
});

// The Daily Maxima Ledger and the reuse of stored windows (FR-072, research.md R-16): what an earlier run fetched is
// reused only when its bounds, step and metric match exactly; the ledger holds one number per metric per day.
const fs = require('node:fs');
const path = require('node:path');
const { createHistory, latestRunOf, earlierDate, dateKeyOf, ledgerPath } = require('../../src/collect/history');
const { windowBounds, DAY } = require('../../src/collect/windows');
const { RunDir, ensureDataLayout } = require('../../src/store/run-dir');
const { tempDir, removeDir } = require('../helpers/fixtures');

const RUN_START = new Date('2026-09-18T06:00:00Z');
const DATE = '2026-09-18';
const alpha = { host: 'alpha.example.org', url: 'https://alpha.example.org', slug: 'alpha-example-org' };
const seconds = (date) => Math.floor(date.getTime() / 1000);
const bounds = windowBounds(RUN_START, { activeWindow: { cycle_days: 3 } });
const bound = (name) => bounds.find((b) => b.window === name);
const iso = (date) => date.toISOString();

const currentWindowOf = (runStart, metric, values, extra = {}) => ({
  project_url: alpha.url, metric, window: 'current', step_s: 300, unit: 'count', available: true, values,
  start: iso(new Date(runStart.getTime() - DAY * 1000)), end: iso(runStart),
  panel_ref: { dashboard_uid: 'd', panel_id: 1, panel_title: 'P', ref_id: 'A' }, unavailable_reason: null, ...extra,
});

describe('collect/history', () => {
  let dataDir;
  const writeRun = async (runId, windows) => {
    const run = await RunDir.create(dataDir, runId);
    await run.writeJson('run.json', { run_id: runId });
    await run.writeGz(`${alpha.slug}/inputs/windows.json.gz`, { project_url: alpha.url, host: alpha.host, windows });
  };
  beforeEach(async () => {
    dataDir = tempDir();
    await ensureDataLayout(dataDir);
    const yesterday = new Date('2026-09-17T06:00:00Z');
    await writeRun('2026-09-17', [
      currentWindowOf(yesterday, 'm', [[seconds(yesterday) - 600, 1], [seconds(yesterday), 2]]),
      currentWindowOf(yesterday, 'n', [], { available: false, unavailable_reason: 'no data' }),
    ]);
    const forced = currentWindowOf(yesterday, 'm', [[seconds(yesterday) - 600, 5], [seconds(yesterday), 7]]);
    await writeRun('2026-09-17-f1', [forced]);
    const threeDaysAgo = new Date('2026-09-15T06:00:00Z');
    await writeRun('2026-09-15', [currentWindowOf(threeDaysAgo, 'm', [[seconds(threeDaysAgo), 11]], { step_s: 60 })]);
  });
  afterEach(() => removeDir(dataDir));

  const history = () => createHistory({ dataDir, runId: DATE, date: DATE, runStart: RUN_START, project: alpha }).load();

  it('names the latest run of a date, forced runs included, and does date arithmetic in UTC', () => {
    expect(latestRunOf(['2026-09-17', '2026-09-17-f1', '2026-09-17-f10', '2026-09-17-f2', '2026-09-18'], '2026-09-17'))
      .to.equal('2026-09-17-f10');
    expect(latestRunOf(['2026-09-18'], '2026-09-17')).to.equal(null);
    expect(earlierDate('2026-03-01', 1)).to.equal('2026-02-28');
    expect(earlierDate('2026-09-18', 7)).to.equal('2026-09-11');
    expect(dateKeyOf(seconds(RUN_START))).to.equal('2026-09-18');
    expect(ledgerPath(dataDir, alpha.slug)).to.equal(path.join(dataDir, 'history', 'alpha-example-org.json'));
  });

  it('reuses the current window of the latest run of the earlier date when bounds, step and metric match', async () => {
    const h = await history();
    const reused = await h.storedWindow('m', bound('previous_day'));
    expect(reused.source).to.equal('stored:2026-09-17-f1');
    expect(reused.values).to.deep.equal([[seconds(RUN_START) - DAY - 600, 5], [seconds(RUN_START) - DAY, 7]]);
    expect(await h.storedWindow('n', bound('previous_day')), 'unavailable stored window').to.equal(null);
    expect(await h.storedWindow('m', bound('current')), 'the current window is always fetched').to.equal(null);
    expect(await h.storedWindow('m', bound('previous_week')), 'no run seven days ago').to.equal(null);
    expect(await h.storedWindow('m', bound('previous_cycle')), 'step differs').to.equal(null);
    expect(await h.storedWindow('m', bound('trailing_14d')), 'not a one-day window').to.equal(null);
  });

  it('builds the trailing window from the ledger only when at least fourteen days are present', async () => {
    const h = await history();
    expect(h.ledgerWindow('m', bound('trailing_14d'))).to.equal(null);
    h.recordCurrent('m', [[seconds(RUN_START) - 600, 3], [seconds(RUN_START) - 300, 9], [seconds(RUN_START), 4]]);
    expect(h.ledger.metrics.m).to.deep.equal({ '2026-09-18': 9 });
    const fetched = Array.from({ length: 21 }, (_, i) => [seconds(RUN_START) - (20 - i) * DAY, 100 + i]);
    h.backfill('m', fetched);
    expect(h.ledger.metrics.m['2026-09-18'], 'backfill never overwrites a recorded day').to.equal(9);
    expect(h.ledger.metrics.m['2026-08-29']).to.equal(100);
    const trailing = h.ledgerWindow('m', bound('trailing_14d'));
    expect(trailing.source).to.equal('ledger');
    expect(trailing.values).to.have.length(21);
    expect(trailing.values[0]).to.deep.equal([seconds(RUN_START) - 20 * DAY, 100]);
    expect(trailing.values[20]).to.deep.equal([seconds(RUN_START), 9]);
    h.backfill('n', fetched.slice(0, 13));
    expect(h.ledgerWindow('n', bound('trailing_14d')), 'thirteen days are not enough').to.equal(null);
    h.recordCurrent('o', []);
    expect(h.ledger.metrics.o).to.equal(undefined);
  });

  it('persists the ledger atomically and reads it back on the next run', async () => {
    const h = await history();
    h.recordCurrent('m', [[seconds(RUN_START), 42]]);
    await h.save();
    const file = JSON.parse(fs.readFileSync(ledgerPath(dataDir, alpha.slug), 'utf8'));
    expect(file).to.include({ host: alpha.host, project_url: alpha.url, run_id: DATE });
    expect(file.metrics).to.deep.equal({ m: { '2026-09-18': 42 } });
    expect(file.updated_at).to.match(/^\d{4}-\d{2}-\d{2}T/);
    const tomorrow = await createHistory({
      dataDir, runId: '2026-09-19', date: '2026-09-19', runStart: new Date('2026-09-19T06:00:00Z'), project: alpha,
    }).load();
    expect(tomorrow.ledger.metrics.m['2026-09-18']).to.equal(42);
    tomorrow.recordCurrent('m', [[seconds(RUN_START) + DAY, 43]]);
    expect(tomorrow.ledger.metrics.m).to.deep.equal({ '2026-09-18': 42, '2026-09-19': 43 });
  });
});

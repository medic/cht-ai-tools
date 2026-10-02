'use strict';
// What the data volume already holds for a run's windows (FR-072, research.md R-16): the current windows of earlier
// runs, reused as today's comparison windows when their bounds match exactly, and the Daily Maxima Ledger,
// one number per metric per day, from which the trailing baseline is built once it holds enough days.
const fs = require('node:fs/promises');
const path = require('node:path');
const { RunDir, dataPaths } = require('../store/run-dir');
const { readGzipJson, readJson, writeJsonAtomic, exists } = require('../store/atomic');

const DAY = 86400;
const MIN_LEDGER_DAYS = 14;

const ledgerPath = (dataDir, slug) => path.join(dataPaths(dataDir).history, `${slug}.json`);
const dateKeyOf = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
const earlierDate = (date, daysBack) => new Date(Date.parse(`${date}T00:00:00Z`) - daysBack * DAY * 1000)
  .toISOString().slice(0, 10);

const forcedIndex = (runId) => {
  const match = /-f(\d+)$/.exec(runId);
  return match ? Number(match[1]) : 0;
};

/** The latest run of a date: a forced run supersedes the plain one, and higher forced numbers supersede lower. */
const latestRunOf = (runIds, date) => {
  const candidates = runIds.filter((id) => id === date || id.startsWith(`${date}-f`));
  if (!candidates.length) {
    return null;
  }
  return candidates.sort((a, b) => forcedIndex(a) - forcedIndex(b)).pop();
};

const emptyLedger = (project) => ({
  host: project.host, project_url: project.url, updated_at: null, run_id: null, metrics: {},
});

/**
 * @param {object} options dataDir, runId, date (YYYY-MM-DD), runStart (Date), project ({ host, url, slug }),
 *   minDays (ledger days needed for a trailing window, default 14)
 */
const createHistory = ({ dataDir, runId, date, runStart, project, minDays = MIN_LEDGER_DAYS }) => {
  const file = ledgerPath(dataDir, project.slug);
  const runStartS = Math.floor(runStart.getTime() / 1000);
  const windowsByRun = new Map();
  let runIds = null;
  const history = {
    ledger: emptyLedger(project),

    async load() {
      if (await exists(file)) {
        const stored = await readJson(file);
        history.ledger = { ...emptyLedger(project), ...stored, metrics: stored.metrics || {} };
      }
      return history;
    },

    /** The current window of the run `daysBack` days earlier, when it exists with exactly these bounds. */
    async storedWindow(metric, bound) {
      const lengthS = Math.round((bound.end.getTime() - bound.start.getTime()) / 1000);
      const daysBack = Math.round((runStart.getTime() - bound.end.getTime()) / (DAY * 1000));
      if (bound.window === 'current' || lengthS !== DAY || daysBack < 1) {
        return null;
      }
      runIds = runIds || await RunDir.list(dataDir);
      const id = latestRunOf(runIds, earlierDate(date, daysBack));
      if (!id) {
        return null;
      }
      if (!windowsByRun.has(id)) {
        const stored = path.join(dataDir, 'runs', id, project.slug, 'inputs', 'windows.json.gz');
        windowsByRun.set(id, (await exists(stored)) ? ((await readGzipJson(stored)).windows || []) : []);
      }
      const match = windowsByRun.get(id).find((w) => w.window === 'current' && w.metric === metric && w.available
        && w.step_s === bound.step_s && w.start === bound.start.toISOString() && w.end === bound.end.toISOString()
        && Array.isArray(w.values) && w.values.length > 0);
      return match ? { values: match.values, source: `stored:${id}` } : null;
    },

    /** The trailing window from the ledger, or null when fewer than `minDays` of its days are present. */
    ledgerWindow(metric, bound) {
      const days = history.ledger.metrics[metric] || {};
      const values = [];
      const start = Math.floor(bound.start.getTime() / 1000);
      const end = Math.floor(bound.end.getTime() / 1000);
      for (let ts = start; ts <= end; ts += bound.step_s) {
        const value = days[dateKeyOf(ts)];
        if (value !== undefined) {
          values.push([ts, value]);
        }
      }
      return values.length >= minDays ? { values, source: 'ledger' } : null;
    },

    /** Today's maximum of a metric from its current window; nothing is recorded for an empty window. */
    recordCurrent(metric, values) {
      const finite = values.map(([, value]) => value).filter(Number.isFinite);
      if (!finite.length) {
        return;
      }
      history.ledger.metrics[metric] = history.ledger.metrics[metric] || {};
      history.ledger.metrics[metric][dateKeyOf(runStartS)] = Math.max(...finite);
    },

    /** Days a fetched trailing window knows and the ledger does not; a recorded day is never overwritten. */
    backfill(metric, values) {
      const days = history.ledger.metrics[metric] || {};
      for (const [ts, value] of values) {
        const key = dateKeyOf(ts);
        if (days[key] === undefined && Number.isFinite(value)) {
          days[key] = value;
        }
      }
      if (Object.keys(days).length) {
        history.ledger.metrics[metric] = days;
      }
    },

    async save() {
      await fs.mkdir(path.dirname(file), { recursive: true });
      history.ledger.updated_at = new Date().toISOString();
      history.ledger.run_id = runId;
      await writeJsonAtomic(file, history.ledger);
    },
  };
  return history;
};

module.exports = { createHistory, latestRunOf, earlierDate, dateKeyOf, ledgerPath, MIN_LEDGER_DAYS };

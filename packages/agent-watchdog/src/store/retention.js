'use strict';
// Retention (FR-040): raw files go after AGENT_WATCHDOG_RETENTION_RAW_DAYS, kept files after
// AGENT_WATCHDOG_RETENTION_DAYS, durable files never.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { dataPaths, RUN_ID_PATTERN } = require('./run-dir');
const atomic = require('./atomic');

const DAY_MS = 86400000;
const RAW_PATTERNS = [/\/inputs\/windows\.json\.gz$/, /\/rollup\/brief\.png$/];

/** Classify a data-volume-relative path as raw, kept or durable. */
const classify = (relPath) => {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (rel.startsWith('runs/') || rel.startsWith('runs-replay/')) {
    return RAW_PATTERNS.some((p) => p.test(rel)) ? 'raw' : 'kept';
  }
  if (rel.startsWith('calibration/') || rel === 'feedback.jsonl') {
    return 'kept';
  }
  return 'durable';
};

const ageDays = (dateString, now) => Math.floor((now.getTime() - Date.parse(`${dateString}T00:00:00Z`)) / DAY_MS);

const isoWeekMonday = (weekString) => {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekString);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() - (jan4Day - 1) * DAY_MS + (week - 1) * 7 * DAY_MS);
  return monday.toISOString().slice(0, 10);
};

const walk = async (dir) => {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

/**
 * Apply retention to the data volume.
 * @returns {{ removed: Array<{ path: string, class: string, age_days: number }>, compacted: number }}
 */
const purge = async (dataDir, { rawDays, keptDays, now = new Date(), dryRun = false }) => {
  const p = dataPaths(dataDir);
  const removed = [];
  const remove = async (target, cls, age) => {
    removed.push({ path: path.relative(dataDir, target), class: cls, age_days: age });
    if (!dryRun) {
      await fs.rm(target, { recursive: true, force: true });
    }
  };

  if (fsSync.existsSync(p.runs)) {
    for (const entry of await fs.readdir(p.runs)) {
      if (!RUN_ID_PATTERN.test(entry)) {
        continue;
      }
      const age = ageDays(entry.slice(0, 10), now);
      const runRoot = path.join(p.runs, entry);
      if (age > keptDays) {
        await remove(runRoot, 'kept', age);
      } else if (age > rawDays) {
        for (const file of await walk(runRoot)) {
          if (classify(path.relative(dataDir, file)) === 'raw') {
            await remove(file, 'raw', age);
          }
        }
      }
    }
  }

  if (fsSync.existsSync(p.calibration)) {
    for (const entry of await fs.readdir(p.calibration)) {
      const monday = isoWeekMonday(entry.replace(/\.json$/, ''));
      if (monday && ageDays(monday, now) > keptDays) {
        await remove(path.join(p.calibration, entry), 'kept', ageDays(monday, now));
      }
    }
  }

  let compacted = 0;
  if (fsSync.existsSync(p.feedbackFile)) {
    const records = await atomic.readJsonl(p.feedbackFile);
    const keep = records.filter((record) => {
      const old = record.date && ageDays(record.date, now) > keptDays;
      const outcomesAppended = old && fsSync.existsSync(path.join(p.corpusOutcomes, `${record.date}.jsonl`));
      if (old && outcomesAppended) {
        compacted += 1;
        return false;
      }
      return true;
    });
    if (compacted > 0 && !dryRun) {
      const text = keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '');
      await atomic.writeFileAtomic(p.feedbackFile, text);
    }
  }

  return { removed, compacted };
};

module.exports = { classify, purge, ageDays, isoWeekMonday };

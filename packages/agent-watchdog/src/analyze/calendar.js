'use strict';
// Expected-load windows (FR-007): month-end, date ranges and weekly windows, each in its own timezone.

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The calendar date of an instant in a timezone. */
const dateInZone = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    weekday: WEEKDAYS[pick('weekday')],
  };
};

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (n) => String(n).padStart(2, '0');

const isActive = (window, date) => {
  const local = dateInZone(date, window.timezone);
  switch (window.kind) {
  case 'month_end': {
    const before = window.days_before || 0;
    const after = window.days_after || 0;
    return local.day > daysInMonth(local.year, local.month) - before || local.day <= after;
  }
  case 'dates': {
    const iso = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
    return (!window.start || iso >= window.start) && (!window.end || iso <= window.end);
  }
  case 'weekly':
    return local.weekday === window.weekday;
  default:
    return false;
  }
};

/**
 * The active expected-load window for a project at the run start, or null. Project windows take precedence
 * over the defaults; duplicates by id are evaluated once.
 */
const activeWindow = (windows, project, runStart) => {
  const projectWindows = (project && project.expected_load_windows) || [];
  const seen = new Set();
  for (const window of [...projectWindows, ...(windows || [])]) {
    if (seen.has(window.id)) {
      continue;
    }
    seen.add(window.id);
    if (isActive(window, runStart)) {
      return { ...window };
    }
  }
  return null;
};

/**
 * The expected-load window a computed change names, as the discovery describes it (id, kind, note), looked up on
 * the project first and then on every project (a default window is listed on each); `{ id }` alone when the
 * description is gone (revision 33: the roll-up's notice reads the window's note, never a bare id).
 */
const windowFor = (id, { project = null, discovery = null } = {}) => {
  if (!id) {
    return null;
  }
  const pools = [
    project && project.expected_load_windows,
    ...((discovery && discovery.projects) || []).map((p) => p && p.expected_load_windows),
    discovery && discovery.expected_load_windows,
  ];
  for (const pool of pools) {
    const found = (pool || []).find((window) => window && window.id === id);
    if (found) {
      return { ...found };
    }
  }
  return { id };
};

/** The active window of a project's computed changes, described, or null when none names one. */
const activeWindowOf = (changes, { project = null, discovery = null } = {}) => {
  const change = (changes || []).find((c) => c && c.expected_load_window_id);
  return change ? windowFor(change.expected_load_window_id, { project, discovery }) : null;
};

module.exports = { activeWindow, activeWindowOf, windowFor, dateInZone, isActive, daysInMonth };

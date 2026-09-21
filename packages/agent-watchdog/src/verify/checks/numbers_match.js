'use strict';
// Every number the model wrote in prose must equal a computed value under the display formatter; numerals inside
// code spans are exempt, but each span must be a collected expression or metric (data-model.md "Number matching").
const {
  formatValue, extractNumbers, extractNumbersEverywhere, codeSpans, parseToken, HOUR_SECONDS, DAY_SECONDS,
} = require('../format');
const { sameMetric, keyForms, flatPanels } = require('../metric-key');
const { enums } = require('../../model/schemas');

const NAME = 'numbers_match';

const RULE_UNITS = {
  pct_change: 'percent', deviation: 'ratio', monotonic: 'h', target_down: 'count', backlog_absolute: 'x',
};

const isNil = (value) => value === null || value === undefined;

const ratio = (a, b) => (isNil(a) || isNil(b) || b === 0 ? null : a / b);

const changeValues = (change) => [
  { value: change.current_value, unit: 'count' },
  { value: change.previous_day_value, unit: 'count' },
  { value: change.previous_week_value, unit: 'count' },
  { value: change.previous_cycle_value, unit: 'count' },
  { value: change.trailing_mean, unit: 'count' },
  { value: change.trailing_stddev, unit: 'count' },
  { value: change.pct_change_vs_previous_day, unit: 'percent' },
  { value: change.deviation_sigma, unit: 'ratio' },
  { value: change.monotonic_rise_hours, unit: 'h' },
  { value: ratio(change.current_value, change.previous_day_value), unit: 'x' },
  { value: ratio(change.current_value, change.previous_week_value), unit: 'x' },
  { value: ratio(change.current_value, change.previous_cycle_value), unit: 'x' },
  { value: ratio(change.current_value, change.trailing_mean), unit: 'x' },
];

const allowedValues = (item, ctx) => {
  const allowed = (item.evidence || []).map((e) => ({ value: e.value, unit: e.unit }));
  for (const change of ctx.changes || []) {
    if (change.project_url === item.project_url && sameMetric(change.metric, item.metric)) {
      allowed.push(...changeValues(change));
    }
  }
  const referenced = new Set(item.candidate_ids || []);
  for (const candidate of ctx.candidates || []) {
    if (referenced.has(candidate.candidate_id)) {
      const unit = RULE_UNITS[candidate.rule] || 'count';
      allowed.push({ value: candidate.observed, unit });
      allowed.push({ value: candidate.threshold && candidate.threshold.value, unit });
    }
  }
  return allowed.filter((a) => !isNil(a.value) && !Number.isNaN(Number(a.value)));
};

const close = (a, b, decimals) => Math.abs(a - b) <= 0.5 * Math.pow(10, -decimals) + 1e-9;

const matches = (token, allowed) => {
  const { numeric, suffix, decimals } = parseToken(token);
  return allowed.some(({ value, unit }) => {
    const v = Number(value);
    const percentLike = unit === 'percent' || unit === '%';
    if (suffix === '%') {
      if (percentLike) {
        return token === formatValue(v, 'percent') || close(numeric, v, decimals);
      }
      return unit === 'x' && close(numeric, v * 100, decimals);
    }
    if (suffix === 'h') {
      if (unit === 'h' || unit === 'hours' || unit === 'hour') {
        return close(numeric, v, decimals);
      }
      return (unit === 's' || unit === 'seconds') && close(numeric, v / HOUR_SECONDS, decimals);
    }
    if (suffix === 'd') {
      if (unit === 'd' || unit === 'days' || unit === 'day') {
        return close(numeric, v, decimals);
      }
      return (unit === 's' || unit === 'seconds') && close(numeric, v / DAY_SECONDS, decimals);
    }
    if (suffix === 'x') {
      return unit === 'x' && close(numeric, v, decimals);
    }
    const forms = [formatValue(v, unit), formatValue(v, 'count'), String(v)];
    return forms.includes(token) || close(numeric, v, decimals);
  });
};

const knownSpanForms = (ctx) => {
  const forms = new Set();
  for (const key of ctx.discovery.metrics || []) {
    for (const form of keyForms(key)) {
      forms.add(form);
    }
  }
  for (const dashboard of ctx.discovery.dashboards || []) {
    for (const panel of flatPanels(dashboard)) {
      for (const form of keyForms(panel.expr)) {
        forms.add(form);
      }
    }
  }
  return forms;
};

// A window is named, not measured: `trailing_14d`, the `14d` inside it and the `14` alone ("the trailing 14 days")
// are the run's own identifiers for a window, so a numeral that spells one is not a figure the model invented
// (revision 18, the bare numeral added in revision 22 after it was refused 61 times in one run).
const WINDOW_NAME_TOKENS = new Set(enums.WindowName.options.flatMap((name) => {
  const tokens = extractNumbers(name.replace(/_/g, ' ')).concat(extractNumbers(name));
  return tokens.concat(tokens.map((token) => token.replace(/[%hdx]$/, '')));
}));

/**
 * Every form of every collected metric key and panel expression, longest first so a whole expression is removed
 * before its bare metric name.
 */
const expressionForms = (ctx) => {
  const forms = new Set();
  const discovery = ctx.discovery || {};
  for (const key of discovery.metrics || []) {
    for (const form of keyForms(key)) {
      forms.add(form);
    }
  }
  for (const dashboard of discovery.dashboards || []) {
    for (const panel of flatPanels(dashboard)) {
      for (const form of keyForms(panel.expr)) {
        forms.add(form);
      }
    }
  }
  return [...forms].filter((form) => form.length >= 3).sort((a, b) => b.length - a.length);
};

/** The ids of every collected dashboard panel, as strings. */
const panelIds = (ctx) => {
  const ids = new Set();
  for (const dashboard of (ctx.discovery || {}).dashboards || []) {
    for (const panel of flatPanels(dashboard)) {
      if (panel.id !== undefined && panel.id !== null) {
        ids.add(String(panel.id));
      }
    }
  }
  return ids;
};

const PANEL_REFERENCE = /\bpanels?[\s-]*(\d+)\b/gi;

/**
 * Remove the run's own identifiers from prose before its numbers are checked (revision 22): a collected metric key
 * or panel expression written out ("rate(x[24h]) * 60 * 60 * 24" carries 24h, 60, 60 and 24) and a reference to a
 * collected panel by its id ("panel 34"). Both were given to the model by the run, so neither is a figure it
 * computed; a numeral outside them is checked exactly as before, and a panel id the run did not collect stays a
 * number to justify.
 */
const stripRunIdentifiers = (text, ctx) => {
  let out = String(text || '');
  for (const form of expressionForms(ctx)) {
    if (out.includes(form)) {
      out = out.split(form).join(' ');
    }
  }
  const ids = panelIds(ctx);
  return out.replace(PANEL_REFERENCE, (match, id) => (ids.has(id) ? ' ' : match));
};

/** A token's bare value: separators and the unit letter dropped, so `1,234`, `1234` and `1234d` agree. */
const bareValue = (token) => {
  const bare = String(token).replace(/,/g, '').replace(/[%hdx]$/, '');
  const n = Number(bare);
  return Number.isFinite(n) ? String(n) : bare;
};

/**
 * The numerals of the text the model was given (FR-016, revision 23): for findings, every prompt of the session and
 * every tool result it received; for a brief bullet, the item's own prompt entry and the run-wide counts. A numeral
 * the model read is not one it invented.
 */
const givenNumerals = (texts) => {
  const out = new Set();
  for (const text of texts || []) {
    for (const token of extractNumbersEverywhere(text)) {
      out.add(bareValue(token));
    }
  }
  return out;
};

// The derived values are built from at most this many computed values, so the set stays small for any item.
const DERIVED_BASE_LIMIT = 60;

/**
 * The values a reader would derive from two computed levels (FR-016, revision 24): their difference as a count,
 * their ratio as a multiple and their percent change. A model writing "+27", "3x" or "-56%" of two figures it was
 * given has computed nothing the reader could not; the gate refused 127 such numerals in one run (research.md R-29).
 * Only values in the count unit pair up: a level against a ratio, a percentage or a duration derives nothing a
 * reader would write, and admitting those pairs let almost any two-digit numeral through.
 */
const derivedValues = (allowed) => {
  const counts = (allowed || [])
    .filter((a) => a.unit === 'count' || a.unit === undefined || a.unit === null)
    .map((a) => Number(a.value))
    .filter((v) => Number.isFinite(v));
  const base = [...new Set(counts)].slice(0, DERIVED_BASE_LIMIT);
  const derived = [];
  for (const a of base) {
    for (const b of base) {
      if (a === b || b === 0) {
        continue;
      }
      derived.push({ value: a - b, unit: 'count' });
      derived.push({ value: a / b, unit: 'x' });
      derived.push({ value: ((a - b) / b) * 100, unit: 'percent' });
    }
  }
  return derived;
};

const checkText = (where, text, allowed, spanForms, reasons, ctx, given = new Set()) => {
  let derived = null;
  for (const token of extractNumbers(stripRunIdentifiers(text, ctx))) {
    if (WINDOW_NAME_TOKENS.has(token) || given.has(bareValue(token))) {
      continue;
    }
    if (matches(token, allowed)) {
      continue;
    }
    derived = derived || derivedValues(allowed);
    if (!matches(token, derived)) {
      reasons.push(`${where} contains ${token}, which matches no computed value`);
    }
  }
  for (const span of codeSpans(text)) {
    const normalised = span.replace(/\s+/g, ' ').trim();
    if (!spanForms.has(normalised) && !spanForms.has(span)) {
      reasons.push(`${where} code span ${span} is not a collected expression or metric`);
    }
  }
};

const check = (ctx) => {
  const reasons = [];
  const spanForms = knownSpanForms(ctx);
  const runGiven = givenNumerals(ctx.givenText || []);
  if (ctx.mode === 'brief') {
    const byId = new Map((ctx.items || []).map((item) => [item.item_id, item]));
    (ctx.draft.bullets || []).forEach((bullet, i) => {
      const item = byId.get(bullet.item_id);
      if (!item) {
        reasons.push(`bullets[${i}] refers to unknown item ${bullet.item_id}`);
        return;
      }
      // A bullet may quote its own item's prompt entry and the run-wide counts, never a neighbour's numbers.
      const own = ctx.itemTexts && typeof ctx.itemTexts.get === 'function' ? ctx.itemTexts.get(bullet.item_id) : null;
      const given = new Set([...runGiven, ...givenNumerals(own ? [own] : [])]);
      checkText(`bullets[${i}]`, bullet.text, allowedValues(item, ctx), spanForms, reasons, ctx, given);
    });
  } else {
    (ctx.items || []).forEach((item, i) => {
      const allowed = allowedValues(item, ctx);
      checkText(`items[${i}].why_now`, item.why_now, allowed, spanForms, reasons, ctx, runGiven);
      checkText(`items[${i}].suggested_check`, item.suggested_check, allowed, spanForms, reasons, ctx, runGiven);
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = {
  name: NAME, check, allowedValues, matches, stripRunIdentifiers, givenNumerals, bareValue, derivedValues,
  WINDOW_NAME_TOKENS,
};

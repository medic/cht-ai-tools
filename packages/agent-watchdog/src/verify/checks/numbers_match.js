'use strict';
// Every number the model wrote in prose must equal a computed value under the display formatter; numerals inside
// code spans are exempt, but each span must be a collected expression or metric (data-model.md "Number matching").
// The evidence the model attaches is checked against the values of its own window (a computed level of that window,
// a cited candidate's evidence for it, a collected sample of it) or, for a rate, ratio, sigma or hour value, against
// the metric's rates and cited thresholds in that unit (revisions 33, 36 and 37). An entry that passes is a value the
// prose may quote, rounded or derived, under the unit of the computed value it matched; one that fails is refused
// here and licenses nothing. A brief's headline and expected-load notice are checked as its bullets are.
const {
  formatValue, extractNumbers, extractNumbersEverywhere, codeSpans, parseToken, HOUR_SECONDS, DAY_SECONDS,
} = require('../format');
const { sameMetric, keyForms, flatPanels } = require('../metric-key');
const { coveredIds } = require('../../rollup/layout');
const { enums } = require('../../model/schemas');
const { stripDatePhrases } = require('../patterns');

const NAME = 'numbers_match';

const RULE_UNITS = {
  pct_change: 'percent', deviation: 'ratio', monotonic: 'h', target_down: 'count', backlog_absolute: 'x',
};

const isNil = (value) => value === null || value === undefined;

const ratio = (a, b) => (isNil(a) || isNil(b) || b === 0 ? null : a / b);

// A metric whose key ends in `_seconds` holds seconds, so a duration the model converted ("7.5 days") matches
// (revision 25); `_seconds_total` rates and everything else stay counts.
const levelUnitOf = (metric) => (/_seconds(?![\w])/.test(String(metric || '')) ? 's' : 'count');

const changeValues = (change) => [
  { value: change.current_value, unit: levelUnitOf(change.metric) },
  { value: change.previous_day_value, unit: levelUnitOf(change.metric) },
  { value: change.previous_week_value, unit: levelUnitOf(change.metric) },
  { value: change.previous_cycle_value, unit: levelUnitOf(change.metric) },
  { value: change.trailing_mean, unit: levelUnitOf(change.metric) },
  { value: change.trailing_stddev, unit: levelUnitOf(change.metric) },
  { value: change.pct_change_vs_previous_day, unit: 'percent' },
  { value: change.deviation_sigma, unit: 'ratio' },
  { value: change.monotonic_rise_hours, unit: 'h' },
  { value: ratio(change.current_value, change.previous_day_value), unit: 'x' },
  { value: ratio(change.current_value, change.previous_week_value), unit: 'x' },
  { value: ratio(change.current_value, change.previous_cycle_value), unit: 'x' },
  { value: ratio(change.current_value, change.trailing_mean), unit: 'x' },
];

/**
 * The values the item may quote: its metric's Computed Change, and the observed value and threshold of every
 * candidate it cites. In a finding the item's own evidence is not among them: only the entries evidenceReasons
 * verified against their window join the allow-list (revision 36), so an invented evidence value cannot license
 * the same numeral in prose. In a brief the items were accepted with their evidence verified, so it counts as
 * computed data there.
 */
const allowedValues = (item, ctx, { includeEvidence = ctx.mode === 'brief' } = {}) => {
  const allowed = includeEvidence ? (item.evidence || []).map((e) => ({ value: e.value, unit: e.unit })) : [];
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

const decimalsOf = (value) => {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
};

// Which computed levels each window holds (revision 36): evidence is checked against its own window's values. The
// day's restart count belongs to the current window (revision 37): a restart candidate's evidence is written as one.
const WINDOW_LEVELS = {
  current: ['current_value', 'restarts_24h'],
  previous_day: ['previous_day_value'],
  previous_week: ['previous_week_value'],
  previous_cycle: ['previous_cycle_value'],
  trailing_14d: ['trailing_mean', 'trailing_stddev'],
};
// The unit families evidence is compared within (revision 37): a sigma labelled "x" matches no multiple, and a
// multiple labelled "percent" no percentage. Anything else is a level in the metric's own unit.
const UNIT_GROUPS = {
  percent: 'percent', '%': 'percent', pct: 'percent',
  x: 'x', times: 'x', multiple: 'x', fold: 'x',
  ratio: 'ratio', sigma: 'ratio', 'σ': 'ratio', stddev: 'ratio', sd: 'ratio',
  h: 'h', hour: 'h', hours: 'h',
};
const unitGroup = (unit) => UNIT_GROUPS[String(unit === null || unit === undefined ? '' : unit).toLowerCase()]
  || 'level';

const changeOf = (item, ctx) => (ctx.changes || [])
  .find((change) => change.project_url === item.project_url && sameMetric(change.metric, item.metric)) || null;

/** The evidence values of every candidate the item cites, for one window: what the analysis was handed. */
const citedEvidenceValues = (item, window, ctx) => {
  const referenced = new Set(item.candidate_ids || []);
  return (ctx.candidates || [])
    .filter((candidate) => referenced.has(candidate.candidate_id))
    .flatMap((candidate) => (candidate.evidence || []).filter((e) => e.window === window).map((e) => Number(e.value)))
    .filter(Number.isFinite);
};

/** The collected samples of one window of the item's metric. */
const sampleValues = (item, window, ctx) => (ctx.windows || [])
  .filter((w) => w.project_url === item.project_url && sameMetric(w.metric, item.metric) && w.window === window)
  .flatMap((w) => (w.values || []).map((pair) => Number(Array.isArray(pair) ? pair[1] : pair)))
  .filter(Number.isFinite);

/** The candidates the item cites. */
const citedCandidates = (item, ctx) => {
  const referenced = new Set(item.candidate_ids || []);
  return (ctx.candidates || []).filter((candidate) => referenced.has(candidate.candidate_id));
};

/**
 * The metric's rates, ratios and hours and the cited candidates' observed values and thresholds, each with its
 * unit: values without a window, for evidence written in one of those units (revision 37).
 */
const typedValues = (item, ctx) => {
  const change = changeOf(item, ctx);
  const values = change ? changeValues(change).filter((entry) => unitGroup(entry.unit) !== 'level') : [];
  for (const candidate of citedCandidates(item, ctx)) {
    const unit = RULE_UNITS[candidate.rule] || 'count';
    values.push({ value: candidate.observed, unit }, { value: candidate.threshold && candidate.threshold.value, unit });
  }
  return values.filter((entry) => Number.isFinite(Number(entry.value)));
};

/** The observed values of the cited candidates that measure a level of the current window, such as a restart count. */
const citedLevelValues = (item, window, ctx) => (window === 'current'
  ? citedCandidates(item, ctx)
    .filter((candidate) => unitGroup(RULE_UNITS[candidate.rule] || 'count') === 'level')
    .map((candidate) => Number(candidate.observed))
    .filter(Number.isFinite)
  : []);

/**
 * Every `{ window, value, unit }` the model attached must equal, within its own decimals, a computed level of that
 * window (the Computed Change's value for it, a cited candidate's evidence or observed level for it, a collected
 * sample of it), or, when its unit is a percentage, a multiple, a sigma or hours, one of the metric's values in that
 * unit family (FR-016, revisions 33, 36 and 37). The entries that pass are returned as values the prose may quote,
 * under the unit of the value they matched; an invented one fails here and is quoted nowhere.
 */
const evidenceReasons = (item, index, ctx) => {
  const reasons = [];
  const verified = [];
  const change = changeOf(item, ctx);
  (item.evidence || []).forEach((evidence, j) => {
    const value = Number(evidence && evidence.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const group = unitGroup(evidence.unit);
    let pool;
    if (group === 'level') {
      const levels = (WINDOW_LEVELS[evidence.window] || [])
        .map((field) => (change ? Number(change[field]) : NaN))
        .filter(Number.isFinite);
      pool = [
        ...levels, ...citedEvidenceValues(item, evidence.window, ctx), ...sampleValues(item, evidence.window, ctx),
        ...citedLevelValues(item, evidence.window, ctx),
      ].map((v) => ({ value: v, unit: evidence.unit }));
    } else {
      pool = typedValues(item, ctx).filter((entry) => unitGroup(entry.unit) === group);
    }
    const matched = pool.find((entry) => close(value, Number(entry.value), decimalsOf(evidence.value)));
    if (matched) {
      verified.push({ value: evidence.value, unit: matched.unit });
      return;
    }
    reasons.push(
      `items[${index}].evidence[${j}] value ${evidence.value} for window ${evidence.window} matches no computed or `
      + 'collected value of that window',
    );
  });
  return { reasons, verified };
};

const matches = (token, allowed) => {
  const { numeric, suffix, decimals } = parseToken(token);
  return allowed.some(({ value, unit }) => {
    const v = Number(value);
    const percentLike = unit === 'percent' || unit === '%';
    if (suffix === '%') {
      // A percentage matches by magnitude: the direction ("fell", "rose") is in the words around it (revision 25).
      if (percentLike) {
        return token === formatValue(v, 'percent') || close(Math.abs(numeric), Math.abs(v), decimals);
      }
      return unit === 'x' && close(Math.abs(numeric), Math.abs(v) * 100, decimals);
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

const RANGE_LITERAL = /\[(\d+[hd])\]/g;

/**
 * The range literals of every collected metric key and panel expression (`24h` from `rate(x[24h])`), which a model
 * writes bare ("no restart in 24h"): identifiers the run gave it, not figures (revision 25).
 */
const rangeTokens = (ctx) => {
  const tokens = new Set();
  const discovery = (ctx && ctx.discovery) || {};
  const texts = [...(discovery.metrics || [])];
  for (const dashboard of discovery.dashboards || []) {
    for (const panel of flatPanels(dashboard)) {
      texts.push(panel.expr, panel.metric);
    }
  }
  for (const text of texts) {
    for (const match of String(text || '').matchAll(RANGE_LITERAL)) {
      tokens.add(match[1]);
    }
  }
  return tokens;
};

/**
 * Remove the run's own identifiers from prose before its numbers are checked (revision 22): a collected metric key
 * or panel expression written out ("rate(x[24h]) * 60 * 60 * 24" carries 24h, 60, 60 and 24) and a reference to a
 * collected panel by its id ("panel 34"). Both were given to the model by the run, so neither is a figure it
 * computed; a numeral outside them is checked exactly as before, and a panel id the run did not collect stays a
 * number to justify.
 */
const stripRunIdentifiers = (text, ctx) => {
  // A day-month phrase is a date for dates_match, never a numeral here (revision 36).
  let out = stripDatePhrases(String(text || ''));
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

/**
 * A token with a decimal point or a percent sign that rounds a numeral the model was given, within the token's own
 * decimals, is that numeral (`2.48` for `2.484518`, `+32.7%` for `32.656`); an integer must still equal one exactly,
 * because the given text holds thousands of integers (revision 25).
 */
const roundsGiven = (token, givenNumbers) => {
  const { numeric, suffix, decimals } = parseToken(token);
  if (!Number.isFinite(numeric) || (decimals === 0 && suffix !== '%')) {
    return false;
  }
  return givenNumbers.some((g) => (suffix === '%'
    ? close(Math.abs(numeric), Math.abs(g), decimals)
    : close(numeric, g, decimals)));
};

const givenNumbersOf = (given) => [...given].map(Number).filter((n) => Number.isFinite(n));

const checkText = (where, text, allowed, spanForms, reasons, ctx, given = new Set(), ranges = new Set()) => {
  let derived = null;
  let givenNumbers = null;
  for (const token of extractNumbers(stripRunIdentifiers(text, ctx))) {
    if (WINDOW_NAME_TOKENS.has(token) || ranges.has(token) || given.has(bareValue(token))) {
      continue;
    }
    if (matches(token, allowed)) {
      continue;
    }
    givenNumbers = givenNumbers || givenNumbersOf(given);
    if (roundsGiven(token, givenNumbers)) {
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
  const ranges = rangeTokens(ctx);
  if (ctx.mode === 'brief') {
    const byId = new Map((ctx.items || []).map((item) => [item.item_id, item]));
    // The headline and the notice speak for the whole brief (revision 33): they may quote any item's values and any
    // item's given entry, and nothing else.
    const ownTexts = ctx.itemTexts && typeof ctx.itemTexts.values === 'function' ? [...ctx.itemTexts.values()] : [];
    const everyGiven = new Set([...runGiven, ...givenNumerals(ownTexts)]);
    const everyAllowed = (ctx.items || []).flatMap((item) => allowedValues(item, ctx));
    checkText('headline', ctx.draft.headline, everyAllowed, spanForms, reasons, ctx, everyGiven, ranges);
    if (ctx.draft.expected_load_notice) {
      const notice = ctx.draft.expected_load_notice;
      checkText('expected_load_notice', notice, everyAllowed, spanForms, reasons, ctx, everyGiven, ranges);
    }
    (ctx.draft.bullets || []).forEach((bullet, i) => {
      // A line covers every item of its project (revision 28): it may quote any of their values and their prompt
      // entries, plus the run-wide counts, and nothing of a neighbour's.
      const covered = coveredIds(ctx.layout, bullet.item_id).map((id) => byId.get(id)).filter(Boolean);
      if (!covered.length) {
        reasons.push(`bullets[${i}] refers to unknown item ${bullet.item_id}`);
        return;
      }
      const own = ctx.itemTexts && typeof ctx.itemTexts.get === 'function' ? ctx.itemTexts.get(bullet.item_id) : null;
      const given = new Set([...runGiven, ...givenNumerals(own ? [own] : [])]);
      const allowed = covered.flatMap((item) => allowedValues(item, ctx));
      checkText(`bullets[${i}]`, bullet.text, allowed, spanForms, reasons, ctx, given, ranges);
    });
  } else {
    (ctx.items || []).forEach((item, i) => {
      // The evidence the check verified joins the values the prose may quote (revision 36); invented evidence fails
      // above and licenses nothing.
      const evidence = evidenceReasons(item, i, ctx);
      reasons.push(...evidence.reasons);
      const allowed = [...allowedValues(item, ctx, { includeEvidence: false }), ...evidence.verified];
      checkText(`items[${i}].why_now`, item.why_now, allowed, spanForms, reasons, ctx, runGiven, ranges);
      checkText(
        `items[${i}].suggested_check`, item.suggested_check, allowed, spanForms, reasons, ctx, runGiven, ranges,
      );
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = {
  name: NAME, check, allowedValues, matches, stripRunIdentifiers, givenNumerals, bareValue, derivedValues,
  rangeTokens, roundsGiven, levelUnitOf, WINDOW_NAME_TOKENS,
};

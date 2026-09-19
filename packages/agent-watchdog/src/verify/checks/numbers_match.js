'use strict';
// Every number the model wrote in prose must equal a computed value under the display formatter; numerals inside
// code spans are exempt, but each span must be a collected expression or metric (data-model.md "Number matching").
const { formatValue, extractNumbers, codeSpans, parseToken, HOUR_SECONDS, DAY_SECONDS } = require('../format');
const { sameMetric, keyForms, flatPanels } = require('../metric-key');

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

const checkText = (where, text, allowed, spanForms, reasons) => {
  for (const token of extractNumbers(text)) {
    if (!matches(token, allowed)) {
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
  if (ctx.mode === 'brief') {
    const byId = new Map((ctx.items || []).map((item) => [item.item_id, item]));
    (ctx.draft.bullets || []).forEach((bullet, i) => {
      const item = byId.get(bullet.item_id);
      if (!item) {
        reasons.push(`bullets[${i}] refers to unknown item ${bullet.item_id}`);
        return;
      }
      checkText(`bullets[${i}]`, bullet.text, allowedValues(item, ctx), spanForms, reasons);
    });
  } else {
    (ctx.items || []).forEach((item, i) => {
      const allowed = allowedValues(item, ctx);
      checkText(`items[${i}].why_now`, item.why_now, allowed, spanForms, reasons);
      checkText(`items[${i}].suggested_check`, item.suggested_check, allowed, spanForms, reasons);
    });
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check, allowedValues, matches };

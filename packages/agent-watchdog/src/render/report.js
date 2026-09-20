'use strict';
// The one-page report (FR-022): a filled template, never generated per run; every value escaped.
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { hostOf } = require('../rollup/deterministic-brief');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'report.hbs');
const KIND_LABELS = { brief: 'brief', heartbeat: 'all quiet', degraded: 'degraded', failure: 'failed' };

/** Triple-stash would bypass escaping, so it is forbidden in every template (constitution IV). */
const assertNoTripleStash = (templateText) => {
  if (templateText.includes('{{{')) {
    throw new Error('triple-stash {{{ }}} is forbidden in templates; every value is escaped');
  }
};

const numeric = (samples) => (Array.isArray(samples) ? samples : [])
  .map((sample) => (Array.isArray(sample) ? sample[1] : sample))
  .map(Number)
  .filter((n) => Number.isFinite(n));

/** An inline SVG sparkline built only from numbers; safe to mark as trusted markup. */
const sparklineSvg = (samples, width = 240, height = 40) => {
  const values = numeric(samples);
  if (values.length < 2) {
    return new Handlebars.SafeString('');
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 1 - ((v - min) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const svg = `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" `
    + `role="img" aria-label="trend of ${values.length} samples">`
    + `<polyline fill="none" stroke="#1f2937" stroke-width="2" points="${points}"/></svg>`;
  return new Handlebars.SafeString(svg);
};

const formatValue = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
};

const windowKey = (projectUrl, metric) => `${projectUrl}|${metric}`;

const samplesFor = (windowsByMetric, item) => {
  if (!windowsByMetric) {
    return [];
  }
  const key = windowKey(item.project_url, item.metric);
  const found = windowsByMetric instanceof Map ? windowsByMetric.get(key) : windowsByMetric[key];
  return numeric(found || []);
};

const itemView = (item, windowsByMetric) => ({
  item_id: item.item_id,
  host: hostOf(item.project_url),
  metric: item.metric,
  severity: item.severity,
  severity_label: item.severity.toUpperCase(),
  rank: item.rank === null || item.rank === undefined ? '-' : item.rank,
  persisting_text: item.persisting_days > 1 ? `persisting ${item.persisting_days} days` : 'new today',
  confidence_pct: Math.round((item.confidence || 0) * 100),
  why_now: item.why_now,
  suggested_check: item.suggested_check,
  evidence: (item.evidence || []).map((e) => ({ window: e.window, value: formatValue(e.value), unit: e.unit })),
  samples: samplesFor(windowsByMetric, item),
});

const buildView = ({ brief, items, windowsByMetric, runId }) => {
  if (typeof brief.headline !== 'string') {
    throw new Error('brief.headline is required to render the report');
  }
  const notices = [brief.expected_load_notice, brief.degradation_notice, ...(brief.notices || [])]
    .filter(Boolean)
    .map((text) => ({ text }));
  return {
    run_id: runId,
    date: brief.run_id ? brief.run_id.slice(0, 10) : runId,
    kind: brief.kind,
    kind_label: KIND_LABELS[brief.kind] || brief.kind,
    headline: brief.headline,
    has_bullets: brief.bullets.length > 0,
    bullets: brief.bullets.map((b) => ({
      text: b.text,
      has_children: Boolean(b.children && b.children.length),
      children: (b.children || []).map((child) => ({ text: child.text })),
    })),
    notices,
    checked: brief.checked,
    footer: {
      cost_text: `$${Number(brief.footer.cost_usd || 0).toFixed(2)}`,
      trace_text: brief.footer.trace_url ? 'recorded' : 'none',
    },
    items: (items || []).map((item) => itemView(item, windowsByMetric)),
  };
};

const compileTemplate = () => {
  const text = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  assertNoTripleStash(text);
  const handlebars = Handlebars.create();
  handlebars.registerHelper('sparkline', (samples) => sparklineSvg(samples));
  return handlebars.compile(text, { strict: true });
};

/**
 * Render the report HTML for a run.
 * @param {object} options brief, items (ranked), changes (by slug, informational), windowsByMetric
 *   (Map or object keyed `${project_url}|${metric}` -> current-window samples), discovery, runId
 */
const renderReport = ({ brief, items = [], windowsByMetric = new Map(), runId }) => {
  const template = compileTemplate();
  return template(buildView({ brief, items, windowsByMetric, runId }));
};

module.exports = { renderReport, assertNoTripleStash, sparklineSvg, windowKey, formatValue };

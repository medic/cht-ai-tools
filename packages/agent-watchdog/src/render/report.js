'use strict';
// The report (FR-022): the document a reader opens from the thread. A filled template, never generated per run;
// every value escaped; each reference to an alert, dashboard or panel linked or merely named by the run's link
// setting, and every decimal rounded for reading (revision 24). The template is the original design, kept at the
// operator's request after a redesign was tried (revision 25).
const fs = require('node:fs');
const path = require('node:path');
const Handlebars = require('handlebars');
const { hostOf } = require('../rollup/deterministic-brief');
const { headlineMarker, bulletMarker, noticeMarker, withMarker } = require('../rollup/markers');
const { buildItemLinks, buildDashboardLink, buildAlertGroupLinks } = require('../links/build');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'report.hbs');
const KIND_LABELS = { brief: 'brief', heartbeat: 'all quiet', degraded: 'degraded', failure: 'failed' };
// `internal` links every reference to the hosted watchdog; `none` names it, for a reader without credentials there.
const LINK_MODES = Object.freeze(['internal', 'none']);
const DAY_MS = 24 * 60 * 60 * 1000;

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
    + `<polyline fill="none" stroke="#4b5563" stroke-width="2" points="${points}"/></svg>`;
  return new Handlebars.SafeString(svg);
};

const grouped = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }).format(value);

/**
 * A number as a reader wants it (revision 24): an integer with its thousands grouped; a value of one or more to at
 * most three decimals; a value below one to three significant figures, so `0.0008130081300813008` reads `0.000813`
 * and not `0`. Only the report rounds; the stored items and the gate keep the exact values.
 */
const roundForReading = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  if (Number.isInteger(value)) {
    return grouped(value);
  }
  const rounded = Math.abs(value) >= 1 ? Number(value.toFixed(3)) : Number(value.toPrecision(3));
  return grouped(rounded);
};

// A decimal written with four or more fractional digits in prose, outside a longer token such as a version string.
const LONG_DECIMAL = /(?<![\w.])([+-]?\d+\.\d{4,})(?![\w.])/g;

/** The model's prose with each unrounded decimal rounded for reading; nothing else in the text changes. */
const roundProse = (text) => String(text === undefined || text === null ? '' : text)
  .replace(LONG_DECIMAL, (token) => roundForReading(Number(token)));

const windowKey = (projectUrl, metric) => `${projectUrl}|${metric}`;

const samplesFor = (windowsByMetric, item) => {
  if (!windowsByMetric) {
    return [];
  }
  const key = windowKey(item.project_url, item.metric);
  const found = windowsByMetric instanceof Map ? windowsByMetric.get(key) : windowsByMetric[key];
  return numeric(found || []);
};

const rankOf = (item) => (item.rank === null || item.rank === undefined ? Number.MAX_SAFE_INTEGER : item.rank);

const relationText = (relation) => String(relation || '').replace(/_/g, ' ');

/**
 * Items nested under the higher-ranked item they relate to (FR-009, revision 23), by that item's id; an item whose
 * relation points at a lower-ranked item, or at nothing in the run, stays at the top level.
 */
const nestedByParent = (items) => {
  const byId = new Map(items.map((item) => [item.item_id, item]));
  const nested = new Map();
  for (const item of items) {
    const parent = item.relates_to && item.relates_to.item_id ? byId.get(item.relates_to.item_id) : null;
    if (parent && parent !== item && rankOf(parent) < rankOf(item)) {
      if (!nested.has(parent.item_id)) {
        nested.set(parent.item_id, []);
      }
      nested.get(parent.item_id).push(item);
    }
  }
  return nested;
};

const toDate = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The links the report may carry, by the run's link setting. Without a setting nothing is linked: a renderer that
 * was not told where its reader may go names every reference instead.
 */
const linkBuilder = ({ links, items, discovery }) => {
  const mode = links && LINK_MODES.includes(links.mode) ? links.mode : 'none';
  const internal = mode === 'internal';
  const grafanaUrl = internal && links.grafanaUrl ? String(links.grafanaUrl) : null;
  const dashboards = new Map(((discovery && discovery.dashboards) || []).map((d) => [d.uid, d]));
  const itemLinks = grafanaUrl && discovery ? buildItemLinks(items, discovery, grafanaUrl) : new Map();
  const runStart = toDate(links && links.runStart) || toDate(discovery && discovery.run_start) || new Date();
  return {
    mode,
    internal,
    item: (item) => itemLinks.get(item.item_id) || null,
    // A standing host's panel over the day the run compared: the run's start and the twenty-four hours before it.
    standing: (record) => {
      const ref = record.panel_ref;
      const dashboard = ref && dashboards.get(ref.dashboard_uid);
      if (!grafanaUrl || !dashboard || !record.host) {
        return null;
      }
      return buildDashboardLink({
        grafanaUrl, dashboard, panelId: ref.panel_id, host: record.host,
        from: runStart.getTime() - DAY_MS, to: runStart.getTime(),
      });
    },
    alertGroup: (group) => (grafanaUrl ? buildAlertGroupLinks({ grafanaUrl, group }) : null),
  };
};

const itemView = (item, windowsByMetric, linker, related = []) => ({
  item_id: item.item_id,
  host: hostOf(item.project_url),
  metric: item.metric,
  link: linker.item(item),
  severity: item.severity,
  severity_label: item.severity.toUpperCase(),
  rank: item.rank === null || item.rank === undefined ? '-' : item.rank,
  rank_text: item.rank === null || item.rank === undefined ? '' : `#${item.rank}`,
  relation_text: item.relates_to ? relationText(item.relates_to.relation) : '',
  has_related: related.length > 0,
  related: related.map((other) => itemView(other, windowsByMetric, linker)),
  persisting_text: item.persisting_days > 1 ? `persisting ${item.persisting_days} days` : 'new today',
  confidence_pct: Math.round((item.confidence || 0) * 100),
  why_now: roundProse(item.why_now),
  suggested_check: roundProse(item.suggested_check),
  // Window names as the run records them (`previous_day`, `trailing_14d`); values and notes rounded for reading.
  evidence: (item.evidence || []).map((e) => ({
    window: e.window, value: roundForReading(e.value), unit: e.unit || '', note: roundProse(e.note || ''),
  })),
  samples: samplesFor(windowsByMetric, item),
});

const STANDING_RULE_TEXT = {
  backlog_absolute: 'Outbound push backlog above zero, as yesterday',
  target_down: 'Scrape target dark for the whole trailing fortnight',
};

/** Standing conditions grouped by rule, hosts sorted by value, largest first (FR-014, revision 23). */
const standingView = (standing, linker) => {
  const byRule = new Map();
  for (const record of standing || []) {
    if (!byRule.has(record.rule)) {
      byRule.set(record.rule, []);
    }
    byRule.get(record.rule).push(record);
  }
  return [...byRule.entries()].map(([rule, records]) => ({
    rule_text: STANDING_RULE_TEXT[rule] || rule,
    hosts: [...records].sort((a, b) => Number(b.value) - Number(a.value) || String(a.host).localeCompare(b.host))
      .map((record) => ({
        host: record.host,
        group: record.group,
        metric: record.metric,
        value: roundForReading(record.value),
        previous: roundForReading(record.previous_day_value),
        link: linker.standing(record),
      })),
  }));
};

/** The Alert Groups the brief covered (FR-066), each with its instances, linked to the rule list when allowed. */
const alertsView = (alertGroups, linker) => (alertGroups || []).map((group) => {
  const links = linker.alertGroup(group);
  const ruleLink = (title) => {
    const rule = links ? (links.rules || []).find((r) => r.title === title) : null;
    return rule ? rule.url : null;
  };
  const importance = String(group.importance || 'medium');
  return {
    group: group.group,
    category: group.category,
    importance,
    importance_label: importance.toUpperCase(),
    summary_text: `${group.firing} firing, ${group.stale} stale, ${group.new} new since the previous run`,
    link: links ? links.group : null,
    instances: (group.instances || []).map((instance) => ({
      title: instance.title,
      host: instance.host || 'watchdog',
      since: String(instance.started_at || '').slice(0, 10),
      days_text: `${instance.days_firing}d`,
      flags: [instance.stale ? 'stale' : null, instance.new ? 'new' : null].filter(Boolean).join(', '),
      link: ruleLink(instance.title),
    })),
  };
});

const footerView = (footer, linker) => ({
  links: linker.internal,
  specs_url: footer.specs_url || null,
  config_url: footer.config_url || null,
  trace_url: footer.trace_url || null,
  trace_text: footer.trace_url ? 'recorded' : 'none',
  cost_text: `$${Number(footer.cost_usd || 0).toFixed(2)}`,
});

const buildView = ({
  brief, items, windowsByMetric, discovery, runId, standing = [], alertGroups = [], links = null,
}) => {
  if (typeof brief.headline !== 'string') {
    throw new Error('brief.headline is required to render the report');
  }
  const linker = linkBuilder({ links, items: items || [], discovery });
  const severityById = new Map((items || []).map((item) => [item.item_id, item.severity]));
  const severityOf = (id) => severityById.get(id) || null;
  const notices = [brief.expected_load_notice, brief.degradation_notice, ...(brief.notices || [])]
    .filter(Boolean)
    .map((text) => ({ text: withMarker(noticeMarker(text), text) }));
  const ranked = [...(items || [])].sort((a, b) => rankOf(a) - rankOf(b) || a.item_id.localeCompare(b.item_id));
  const nested = nestedByParent(ranked);
  const nestedIds = new Set([...nested.values()].flat().map((item) => item.item_id));
  const topLevel = ranked.filter((item) => !nestedIds.has(item.item_id));
  const standingRows = standingView(standing, linker);
  const alertRows = alertsView(alertGroups, linker);
  return {
    run_id: runId,
    date: brief.run_id ? brief.run_id.slice(0, 10) : runId,
    kind: brief.kind,
    kind_label: KIND_LABELS[brief.kind] || brief.kind,
    headline: withMarker(headlineMarker(brief), brief.headline),
    has_bullets: brief.bullets.length > 0,
    bullets: brief.bullets.map((b) => ({
      text: withMarker(bulletMarker(b, severityOf), b.text),
      has_children: Boolean(b.children && b.children.length),
      children: (b.children || []).map((child) => ({ text: child.text })),
    })),
    notices,
    checked: brief.checked,
    footer: footerView(brief.footer || {}, linker),
    has_items: topLevel.length > 0,
    items: topLevel.map((item) => itemView(item, windowsByMetric, linker, nested.get(item.item_id) || [])),
    has_standing: standingRows.length > 0,
    standing: standingRows,
    has_alerts: alertRows.length > 0,
    alerts: alertRows,
  };
};

/**
 * A code-built URL for an `href` attribute: only http(s) URLs pass, and the five characters that could break out of
 * a quoted attribute are escaped. Handlebars' default escaping would also turn `=` into an entity, which browsers
 * accept but which hides the query a reader may want to copy; the URLs here come from configuration and the run's
 * own structured references, never from model text.
 */
const hrefValue = (url) => {
  const text = String(url === undefined || url === null ? '' : url);
  if (!/^https?:\/\//i.test(text)) {
    return '';
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return new Handlebars.SafeString(escaped);
};

const compileTemplate = () => {
  const text = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  assertNoTripleStash(text);
  const handlebars = Handlebars.create();
  handlebars.registerHelper('sparkline', (samples) => sparklineSvg(samples));
  handlebars.registerHelper('href', (url) => hrefValue(url));
  return handlebars.compile(text, { strict: true });
};

/**
 * Render the report HTML for a run.
 * @param {object} options brief, items (ranked), windowsByMetric (Map or object keyed `${project_url}|${metric}` ->
 *   current-window samples), discovery, runId, standing (rollup/standing.json), alertGroups (rollup/alert-groups.json,
 *   the groups the brief covered), links ({ mode: 'internal'|'none', grafanaUrl, runStart }; without it nothing is
 *   linked)
 */
const renderReport = ({
  brief, items = [], windowsByMetric = new Map(), discovery = null, runId, standing = [], alertGroups = [],
  links = null,
}) => {
  const template = compileTemplate();
  return template(buildView({ brief, items, windowsByMetric, discovery, runId, standing, alertGroups, links }));
};

module.exports = {
  renderReport, assertNoTripleStash, sparklineSvg, windowKey, roundForReading, roundProse, nestedByParent, hrefValue,
  LINK_MODES, formatValue: roundForReading,
};

'use strict';
// The verification gate (FR-016 to FR-018): the same checks run after every model turn and before publication.
const { findingsSchema } = require('../agent/output-schema');
const { itemId } = require('../model/identity');
const { buildItemLinks } = require('../links/build');
const { dashboardRefFor } = require('../links/dashboard-ref');
const { sameMetric } = require('./metric-key');

const CHECK_NAMES = [
  'schema', 'projects_known', 'metrics_known', 'candidates_known', 'numbers_match', 'dates_match', 'relates_to',
  'links_built',
  'links_allowlisted', 'links_resolve', 'severity_rules', 'bullet_count', 'bullet_length', 'secrets_absent',
  'personal_data_absent', 'pattern_cards_known',
];

const BRIEF_CHECK_NAMES = [
  'schema', 'projects_known', 'numbers_match', 'links_built', 'links_resolve', 'bullet_count', 'bullet_length',
  'thread_order', 'secrets_absent', 'personal_data_absent',
];

const MAX_ATTEMPTS = 3;

const CHECKS = Object.fromEntries([...CHECK_NAMES, 'thread_order'].map((name) => [name, require(`./checks/${name}`)]));

const validateAttempt = (attempt) => {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new RangeError(`attempt must be between 1 and ${MAX_ATTEMPTS}, got ${attempt}`);
  }
};

/**
 * Turn the model's items into schemas.Item records; identity, links, the dashboard reference and persistence are
 * all derived by code (FR-009). `windows` are the run's collected windows: the reference comes from them, never
 * from the model, which no longer emits one (revision 18).
 */
/** The sibling's identity for a relation the analysis named by metric; null when it named none or names a stranger. */
const resolveRelation = (item, findings, project) => {
  const relation = item.relates_to;
  if (!relation || !relation.metric) {
    return null;
  }
  const sibling = (findings.items || [])
    .find((other) => other !== item && sameMetric((other.item_key || {}).metric, relation.metric));
  if (!sibling) {
    return null;
  }
  return {
    item_id: itemId(project.url, sibling.item_key.metric, sibling.item_key.pattern_card),
    metric: sibling.item_key.metric,
    relation: relation.relation,
  };
};

const normaliseItems = (findings, project, windows = [], discovery = null) => (findings.items || []).map((item) => ({
  item_id: itemId(project.url, item.item_key.metric, item.item_key.pattern_card),
  project_url: project.url,
  metric: item.item_key.metric,
  severity: item.severity,
  evidence: item.evidence,
  why_now: item.why_now,
  suggested_check: item.suggested_check,
  relates_to: resolveRelation(item, findings, project),
  dashboard_ref: dashboardRefFor({
    windows, discovery, projectUrl: project.url, metric: item.item_key.metric, evidence: item.evidence,
  }),
  confidence: item.confidence,
  persisting_days: 1,
  pattern_card: item.item_key.pattern_card,
  candidate_ids: item.candidate_ids,
  reference_urls: item.reference_urls,
  rank: null,
  placement: null,
  slot: null,
  pass_history: [],
}));

const resolveAll = async ({ resolveLinks, items, discovery, grafanaUrl, extraUrls = [] }) => {
  if (!resolveLinks) {
    return null;
  }
  const urls = new Set([...items.flatMap((item) => item.reference_urls || []), ...extraUrls]);
  if (grafanaUrl) {
    for (const url of buildItemLinks(items, discovery, grafanaUrl).values()) {
      if (url) {
        urls.add(url);
      }
    }
  }
  return resolveLinks([...urls]);
};

const runChecks = (names, ctx) => names.map((name) => CHECKS[name].check(ctx));

const outcomeOf = (checks) => (checks.every((c) => c.status === 'pass') ? 'accepted' : 'rejected');

/**
 * Verify one analysis pass.
 * @returns {Promise<{ report: object, items: object[] }>} the VerificationReport and the normalised items
 */
const verifyFindings = async ({
  findings, pass, project, discovery, changes = [], candidates = [], windows = [], toolResultUrls = new Set(),
  knownCards = [], allowlist = [], attempt = 1, resolveLinks = null, grafanaUrl = null, givenText = [],
}) => {
  validateAttempt(attempt);
  const subjectRef = `${project.slug}/pass${pass}`;
  // `givenText`: the prompts of the session and the tool results it received, whose numerals the model may quote
  // (FR-016, revision 23).
  const base = {
    mode: 'findings', findings, project, discovery, changes, candidates, windows, toolResultUrls, knownCards, allowlist,
    linkResults: null, builtLinks: null, items: [], givenText,
  };
  if (!findingsSchema.safeParse(findings).success) {
    const checks = [CHECKS.schema.check(base)];
    return { report: { subject: 'pass', subject_ref: subjectRef, attempt, checks, outcome: 'rejected' }, items: [] };
  }
  const items = normaliseItems(findings, project, windows, discovery);
  const linkResults = await resolveAll({ resolveLinks, items, discovery, grafanaUrl });
  const builtLinks = grafanaUrl ? buildItemLinks(items, discovery, grafanaUrl) : null;
  const ctx = { ...base, items, linkResults, builtLinks };
  const checks = runChecks(CHECK_NAMES, ctx);
  return { report: { subject: 'pass', subject_ref: subjectRef, attempt, checks, outcome: outcomeOf(checks) }, items };
};

/**
 * Verify a roll-up draft against the accepted items before publication. `layout` is the body layout computed by code
 * (src/rollup/layout.js): with it the draft must carry one bullet per body item, sub-bullets on one line. `extraUrls`
 * are code-built links that must resolve too (the alert-list links, FR-070).
 * @returns {Promise<{ report: object }>}
 */
const verifyBrief = async ({
  draft, items = [], discovery, changes = [], candidates = [], runId, attempt = 1, resolveLinks = null, allowlist = [],
  grafanaUrl = null, toolResultUrls = new Set(), layout = null, extraUrls = [], givenText = [], itemTexts = null,
}) => {
  validateAttempt(attempt);
  const linkResults = await resolveAll({ resolveLinks, items, discovery, grafanaUrl, extraUrls });
  // `givenText` holds the run-wide texts of the roll-up prompt and `itemTexts` each item's own entry, keyed by id, so
  // a bullet may quote what its item was given and nothing of a neighbour's (FR-016, revision 23).
  const ctx = {
    mode: 'brief', draft, items, discovery, changes, candidates, windows: [], toolResultUrls, knownCards: [], allowlist,
    linkResults, builtLinks: grafanaUrl ? buildItemLinks(items, discovery, grafanaUrl) : null, findings: null,
    project: null, runId, layout, givenText, itemTexts,
  };
  const checks = runChecks(BRIEF_CHECK_NAMES, ctx);
  const report = {
    subject: 'brief', subject_ref: `rollup/draft${attempt}`, attempt, checks, outcome: outcomeOf(checks),
  };
  return { report };
};

module.exports = { verifyFindings, verifyBrief, normaliseItems, CHECK_NAMES, BRIEF_CHECK_NAMES, MAX_ATTEMPTS };

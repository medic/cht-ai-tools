'use strict';
// The verification gate (FR-016 to FR-018): the same checks run after every model turn and before publication.
const { findingsSchema } = require('../agent/output-schema');
const { itemId } = require('../model/identity');
const { buildItemLinks } = require('../links/build');

const CHECK_NAMES = [
  'schema', 'projects_known', 'metrics_known', 'candidates_known', 'numbers_match', 'dates_match', 'links_built',
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

/** Turn the model's items into schemas.Item records; identity, links and persistence are derived by code. */
const normaliseItems = (findings, project) => (findings.items || []).map((item) => ({
  item_id: itemId(project.url, item.item_key.metric, item.item_key.pattern_card),
  project_url: project.url,
  metric: item.item_key.metric,
  severity: item.severity,
  evidence: item.evidence,
  why_now: item.why_now,
  suggested_check: item.suggested_check,
  dashboard_ref: { ...item.dashboard_ref, project_url: project.url },
  confidence: item.confidence,
  persisting_days: 1,
  pattern_card: item.item_key.pattern_card,
  candidate_ids: item.candidate_ids,
  reference_urls: item.reference_urls,
  rank: null,
  placement: null,
  pass_history: [],
}));

const resolveAll = async ({ resolveLinks, items, discovery, grafanaUrl }) => {
  if (!resolveLinks) {
    return null;
  }
  const urls = new Set(items.flatMap((item) => item.reference_urls || []));
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
  knownCards = [], allowlist = [], attempt = 1, resolveLinks = null, grafanaUrl = null,
}) => {
  validateAttempt(attempt);
  const subjectRef = `${project.slug}/pass${pass}`;
  const base = {
    mode: 'findings', findings, project, discovery, changes, candidates, windows, toolResultUrls, knownCards, allowlist,
    linkResults: null, builtLinks: null, items: [],
  };
  if (!findingsSchema.safeParse(findings).success) {
    const checks = [CHECKS.schema.check(base)];
    return { report: { subject: 'pass', subject_ref: subjectRef, attempt, checks, outcome: 'rejected' }, items: [] };
  }
  const items = normaliseItems(findings, project);
  const linkResults = await resolveAll({ resolveLinks, items, discovery, grafanaUrl });
  const builtLinks = grafanaUrl ? buildItemLinks(items, discovery, grafanaUrl) : null;
  const ctx = { ...base, items, linkResults, builtLinks };
  const checks = runChecks(CHECK_NAMES, ctx);
  return { report: { subject: 'pass', subject_ref: subjectRef, attempt, checks, outcome: outcomeOf(checks) }, items };
};

/**
 * Verify a roll-up draft against the accepted items before publication.
 * @returns {Promise<{ report: object }>}
 */
const verifyBrief = async ({
  draft, items = [], discovery, changes = [], candidates = [], runId, attempt = 1, resolveLinks = null, allowlist = [],
  grafanaUrl = null, toolResultUrls = new Set(),
}) => {
  validateAttempt(attempt);
  const linkResults = await resolveAll({ resolveLinks, items, discovery, grafanaUrl });
  const ctx = {
    mode: 'brief', draft, items, discovery, changes, candidates, windows: [], toolResultUrls, knownCards: [], allowlist,
    linkResults, builtLinks: grafanaUrl ? buildItemLinks(items, discovery, grafanaUrl) : null, findings: null,
    project: null, runId,
  };
  const checks = runChecks(BRIEF_CHECK_NAMES, ctx);
  const report = {
    subject: 'brief', subject_ref: `rollup/draft${attempt}`, attempt, checks, outcome: outcomeOf(checks),
  };
  return { report };
};

module.exports = { verifyFindings, verifyBrief, normaliseItems, CHECK_NAMES, BRIEF_CHECK_NAMES, MAX_ATTEMPTS };

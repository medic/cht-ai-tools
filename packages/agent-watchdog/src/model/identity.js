'use strict';
// Stable identities (data-model.md "Conventions" and entity rules).
const crypto = require('node:crypto');

const sha12 = (...parts) => crypto.createHash('sha256')
  .update(parts.map((p) => String(p)).join('\n'))
  .digest('hex')
  .slice(0, 12);

/** item_id: hash of project_url, metric and pattern_card (or the literal `none`); stable across days. */
const itemId = (projectUrl, metric, patternCard) => {
  const card = patternCard === null || patternCard === undefined ? 'none' : patternCard;
  return sha12(projectUrl, metric, card);
};

const candidateId = (projectUrl, metric, rule, date) => sha12(projectUrl, metric, rule, date);

const feedbackId = (sourceTs, author, kind, verdict) => {
  const v = verdict === null || verdict === undefined ? '' : verdict;
  return sha12(sourceTs, author, kind, v);
};

const runIdFor = (date, force = 0) => (force > 0 ? `${date}-f${force}` : date);

const RUN_ID = /^(\d{4}-\d{2}-\d{2})(?:-f(\d+))?$/;

const parseRunId = (runId) => {
  const match = RUN_ID.exec(runId);
  if (!match) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return { date: match[1], force: match[2] ? Number(match[2]) : 0 };
};

const projectSlug = (host) => String(host).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const projectUrlFor = (host) => `https://${host}`;

module.exports = { sha12, itemId, candidateId, feedbackId, runIdFor, parseRunId, projectSlug, projectUrlFor };

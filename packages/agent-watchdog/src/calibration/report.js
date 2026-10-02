'use strict';
const fs = require('node:fs');
const { dataPaths } = require('../store/run-dir');
// The weekly Calibration Report (US4 scenario 4, FR-058, SC-002): per project and metric, the observed
// distribution of daily changes, reviewer outcomes, the current percentage-change threshold and a suggestion
// with the effect it would have had on the last thirty days. Calibration targets the percentage-change rule;
// the deviation rule is reported in the distribution only. Everything here is computed from stored files.
const { RunDir } = require('../store/run-dir');
const { lastAcceptedFindingsFile } = require('../rollup/analysis');
const { lastRunPerDate } = require('../rollup/history');
const { readOutcomes } = require('../corpus/outcomes');
const { effectiveThresholds } = require('../analyze/thresholds');
const { normaliseHost } = require('../config/policy');
const { schemas } = require('../model/schemas');
const { weekRange, DAY_MS } = require('./week');
const { percentile, suggestThreshold } = require('./suggest');

const WINDOW_DAYS = 30;
const FEEDBACK_WINDOW_DAYS = 60;
// An outcome is recorded by the run after the one that posted the item (the feedback stage reads yesterday's
// posts), so a record is attributed to the latest posting of that item before the record's date, at most this
// many days earlier; a record dated the same day as a posting, with no earlier one, belongs to that posting.
const OUTCOME_LAG_DAYS = 7;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDays = (date, days) => isoDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);

const asArray = (doc, key) => {
  if (Array.isArray(doc)) {
    return doc;
  }
  if (doc && Array.isArray(doc[key])) {
    return doc[key];
  }
  return [];
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The thirty days that end on the week's Sunday, or today when the week is still running. */
const reportWindow = ({ week, now = new Date(), windowDays = WINDOW_DAYS }) => {
  const { sunday } = weekRange(week);
  const today = now.toISOString().slice(0, 10);
  const to = sunday < today ? sunday : today;
  return { from: shiftDays(to, -(windowDays - 1)), to };
};

const readIfExists = async (runDir, rel, key) => (runDir.exists(rel) ? asArray(await runDir.readJson(rel), key) : []);

/**
 * Every stored run in the inclusive date range, reduced to what calibration needs: per project and metric the
 * daily changes, candidates and items, and per run the pass diffs.
 * @returns {Promise<{ runs: object[], series: Map<string, object> }>}
 */
const collectObservations = async ({ dataDir, from, to, projectFilter = null }) => {
  // One run per date, the last (revision 34): a forced re-run is another attempt at the same day, not another day.
  const ids = [...lastRunPerDate(await RunDir.list(dataDir), { from, to }).values()].sort();
  const series = new Map();
  const seriesFor = (project, metric) => {
    const key = `${project.url}\n${metric}`;
    if (!series.has(key)) {
      series.set(key, {
        project_url: project.url, host: project.host, metric, pct: [], dev: [], candidates: [], items: [],
      });
    }
    return series.get(key);
  };
  const runs = [];
  for (const id of ids) {
    const runDir = RunDir.open(dataDir, id);
    if (!runDir.exists('discovery.json')) {
      continue;
    }
    const discovery = await runDir.readJson('discovery.json');
    const run = { run_id: id, date: id.slice(0, 10), sessions: [] };
    for (const project of asArray(discovery, 'projects')) {
      if (projectFilter && !projectFilter.includes(project.host)) {
        continue;
      }
      const { slug } = project;
      for (const change of await readIfExists(runDir, `${slug}/changes.json`, 'changes')) {
        const entry = seriesFor(project, change.metric);
        if (Number.isFinite(change.pct_change_vs_previous_day)) {
          entry.pct.push(Math.abs(change.pct_change_vs_previous_day));
        }
        if (Number.isFinite(change.deviation_sigma)) {
          entry.dev.push(Math.abs(change.deviation_sigma));
        }
      }
      // What the analysis set aside, from the last pass the gate accepted (FR-014a, revision 20).
      const setAside = runDir.exists(`${slug}/passes.json`)
        ? setAsideFrom(asArray(await runDir.readJson(`${slug}/passes.json`), 'passes'))
        : new Map();
      for (const candidate of await readIfExists(runDir, `${slug}/candidates.json`, 'candidates')) {
        seriesFor(project, candidate.metric).candidates.push({
          candidate_id: candidate.candidate_id, rule: candidate.rule, observed: candidate.observed, run_id: id,
          set_aside: setAside.get(candidate.candidate_id) || null,
        });
      }
      const findings = lastAcceptedFindingsFile(runDir, slug);
      const items = findings ? asArray(await runDir.readJson(findings), 'items') : [];
      for (const item of items) {
        seriesFor(project, item.metric).items.push({
          item_id: item.item_id, run_id: id, date: run.date, candidate_ids: item.candidate_ids || [],
          severity: item.severity, relates_to: item.relates_to || null,
        });
      }
      if (runDir.exists(`${slug}/passes.json`)) {
        const passes = await runDir.readJson(`${slug}/passes.json`);
        const changed = asArray(passes, 'diffs').some((d) => (
          (d.added || []).length + (d.removed || []).length + (d.changed || []).length > 0
        ));
        run.sessions.push({ project_url: project.url, passes: asArray(passes, 'passes').length, changed });
      }
    }
    runs.push(run);
  }
  return { runs, series };
};

/** Outcome per posting: each record goes to the latest posting of its item before the record's date. */
const attributeOutcomes = (items, byItem) => {
  const verdicts = new Map();
  const byId = new Map();
  for (const item of items) {
    if (!byId.has(item.item_id)) {
      byId.set(item.item_id, []);
    }
    byId.get(item.item_id).push(item);
  }
  for (const [itemId, postings] of byId) {
    postings.sort((a, b) => a.date.localeCompare(b.date));
    for (const record of byItem.get(itemId) || []) {
      const earliest = shiftDays(record.date, -OUTCOME_LAG_DAYS);
      const before = postings.filter((p) => p.date < record.date && p.date >= earliest);
      const target = before.length ? before[before.length - 1] : postings.find((p) => p.date === record.date);
      const key = target ? `${target.item_id}@${target.run_id}` : null;
      if (key && !verdicts.has(key)) {
        verdicts.set(key, record.outcome);
      }
    }
  }
  return (item) => verdicts.get(`${item.item_id}@${item.run_id}`) || 'unreviewed';
};

const distributionOf = (pct, dev) => {
  const out = { days: pct.length };
  const add = (prefix, values) => {
    if (!values.length) {
      return;
    }
    out[`${prefix}_p50`] = percentile(values, 50);
    out[`${prefix}_p90`] = percentile(values, 90);
    out[`${prefix}_p95`] = percentile(values, 95);
    out[`${prefix}_max`] = Math.max(...values);
  };
  add('pct', pct);
  add('dev', dev);
  return out;
};

const feedbackRateOf = (records, windowDays) => {
  const isDown = (r) => (r.down || 0) > 0 && (r.up || 0) === 0;
  const months = new Map();
  for (const record of records) {
    const month = String(record.date || '').slice(0, 7);
    if (!months.has(month)) {
      months.set(month, { month, items: 0, down: 0 });
    }
    const bucket = months.get(month);
    bucket.items += 1;
    bucket.down += isDown(record) ? 1 : 0;
  }
  const byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ month: m.month, rate: m.down / m.items, items: m.items }));
  const down = records.filter(isDown).length;
  return {
    window_days: windowDays,
    overall: records.length ? down / records.length : null,
    by_month: byMonth,
  };
};

/**
 * The dismissals of the last pass the gate accepted, as candidate id to reason (true where a low severity floor
 * needed no written reason). A pass the gate rejected decided nothing, so its list is not read (FR-014a).
 */
const setAsideFrom = (passes) => {
  const accepted = (passes || []).filter((p) => p && p.gate && p.gate.outcome === 'accepted');
  const last = accepted[accepted.length - 1];
  const out = new Map();
  for (const entry of (last && last.not_selected) || []) {
    if (entry && entry.candidate_id) {
      out.set(entry.candidate_id, entry.reason || true);
    }
  }
  return out;
};

/** What a rule raised for one metric, what became items and what the analysis set aside, commonest reason first. */
const selectionSummary = (candidates, items) => {
  const referenced = new Set((items || []).flatMap((item) => item.candidate_ids || []));
  const list = candidates || [];
  const counts = new Map();
  for (const candidate of list) {
    if (candidate.set_aside && typeof candidate.set_aside === 'string') {
      counts.set(candidate.set_aside, (counts.get(candidate.set_aside) || 0) + 1);
    }
  }
  return {
    raised: list.length,
    became_items: list.filter((c) => referenced.has(c.candidate_id)).length,
    set_aside: list.filter((c) => c.set_aside).length,
    reasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
};

const entryFor = ({ series: s, policy, outcomesByItem }) => {
  const annotations = policy.projects.projects;
  const annotation = annotations[s.host] || annotations[normaliseHost(s.project_url)] || null;
  const overrides = annotation && annotation.thresholds ? annotation.thresholds : null;
  const { rules } = effectiveThresholds(policy.thresholds, overrides);
  const current = rules.pct_change_vs_previous_day;
  const pctByCandidate = new Map(s.candidates.filter((c) => c.rule === 'pct_change')
    .map((c) => [c.candidate_id, Math.abs(c.observed)]));
  const outcomes = { confirmed: 0, dismissed: 0, unreviewed: 0, model_dismissed: 0 };
  const observations = [];
  const outcomeFor = attributeOutcomes(s.items, outcomesByItem);
  const judgedByPerson = new Set();
  for (const item of s.items) {
    const outcome = outcomeFor(item);
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    if (outcome === 'confirmed' || outcome === 'dismissed') {
      for (const id of item.candidate_ids) {
        judgedByPerson.add(id);
      }
    }
    const observed = item.candidate_ids.filter((id) => pctByCandidate.has(id)).map((id) => pctByCandidate.get(id));
    if (observed.length) {
      observations.push({ item_id: item.item_id, observed: Math.max(...observed), outcome });
    }
  }
  // A candidate the analysis set aside is evidence of its own, unless a person has judged it (FR-014a).
  for (const candidate of s.candidates) {
    if (!candidate.set_aside || judgedByPerson.has(candidate.candidate_id)) {
      continue;
    }
    outcomes.model_dismissed += 1;
    if (pctByCandidate.has(candidate.candidate_id)) {
      observations.push({
        candidate_id: candidate.candidate_id,
        observed: pctByCandidate.get(candidate.candidate_id),
        outcome: 'model_dismissed',
      });
    }
  }
  const suggestion = suggestThreshold({ current, observations, dailyValues: s.pct });
  return {
    project_url: s.project_url,
    metric: s.metric,
    distribution: distributionOf(s.pct, s.dev),
    outcomes,
    selection: selectionSummary(s.candidates, s.items),
    current_threshold: current,
    suggested_threshold: suggestion.suggested,
    effect_last_30d: suggestion.effect,
  };
};

/**
 * Metric pairs the analysis reported as related, commonest first (FR-009, revision 20). A pair is unordered: the
 * level and the rate of one quantity are the same pair whichever of them named the other.
 */
const relatedPairs = (series) => {
  const counts = new Map();
  for (const s of series) {
    for (const item of s.items) {
      if (!item.relates_to || !item.relates_to.metric) {
        continue;
      }
      const pair = [s.metric, item.relates_to.metric].sort();
      const key = `${pair[0]}\u0000${pair[1]}${item.relates_to.relation}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { metrics: pair, relation: item.relates_to.relation, count: 1 });
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.metrics[0].localeCompare(b.metrics[0]));
};

const passChangeRate = (runs) => {
  const sessions = runs.flatMap((run) => run.sessions).filter((s) => s.passes >= 2);
  if (!sessions.length) {
    return 0;
  }
  return sessions.filter((s) => s.changed).length / sessions.length;
};

/**
 * Build the report for a week from the stored runs and corpus outcomes.
 * @param {object} options dataDir, week, policy, config, projects (hosts or urls), windowDays,
 *   feedbackWindowDays, now
 * @returns {Promise<object>} a validated Calibration Report with an empty `proposals` list
 */
/** Every proposal still awaiting review, oldest first, with its age in days (FR-063). */
const openProposalsFor = async (dataDir, now = new Date()) => {
  const { readProposals } = require('../rollup/proposals');
  const proposalsDir = dataPaths(dataDir).proposals;
  if (!fs.existsSync(proposalsDir)) {
    return [];
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return (await readProposals(dataDir))
    .filter((proposal) => proposal.status === 'proposed')
    .map((proposal) => {
      const created = proposal.created_at ? Date.parse(proposal.created_at) : NaN;
      const since = Number.isNaN(created) ? Date.parse(`${proposal.proposal_id.slice(0, 10)}T00:00:00Z`) : created;
      return {
        proposal_id: proposal.proposal_id,
        type: proposal.type,
        age_days: Math.max(0, Math.floor((nowMs - since) / DAY_MS)),
      };
    })
    .sort((a, b) => b.age_days - a.age_days || a.proposal_id.localeCompare(b.proposal_id));
};

const buildCalibrationReport = async ({
  dataDir, week, policy, config = null, projects = null, windowDays = WINDOW_DAYS,
  feedbackWindowDays = FEEDBACK_WINDOW_DAYS, now = new Date(),
}) => {
  void config;
  const { from, to } = reportWindow({ week, now, windowDays });
  const projectFilter = projects && projects.length ? projects.map(normaliseHost) : null;
  const { runs, series } = await collectObservations({ dataDir, from, to, projectFilter });
  const outcomesByItem = new Map();
  for (const record of await readOutcomes(dataDir, { from, to: shiftDays(to, OUTCOME_LAG_DAYS) })) {
    if (!outcomesByItem.has(record.item_id)) {
      outcomesByItem.set(record.item_id, []);
    }
    outcomesByItem.get(record.item_id).push(record);
  }
  for (const records of outcomesByItem.values()) {
    records.sort((a, b) => a.date.localeCompare(b.date));
  }
  const entries = [...series.values()]
    .filter((s) => s.pct.length || s.dev.length)
    .sort((a, b) => a.project_url.localeCompare(b.project_url) || a.metric.localeCompare(b.metric))
    .map((s) => entryFor({ series: s, policy, outcomesByItem }));
  const feedbackRecords = await readOutcomes(dataDir, { from: shiftDays(to, -(feedbackWindowDays - 1)), to });
  const filteredFeedback = projectFilter
    ? feedbackRecords.filter((r) => projectFilter.includes(hostOf(r.project_url)))
    : feedbackRecords;
  return schemas.CalibrationReport.parse({
    week,
    entries,
    pass_change_rate: passChangeRate(runs),
    related_metric_pairs: relatedPairs([...series.values()]),
    feedback_rate: feedbackRateOf(filteredFeedback, feedbackWindowDays),
    proposals: [],
    open_proposals: await openProposalsFor(dataDir, now),
  });
};

module.exports = {
  buildCalibrationReport, collectObservations, reportWindow, distributionOf, feedbackRateOf, passChangeRate,
  openProposalsFor,
  WINDOW_DAYS, FEEDBACK_WINDOW_DAYS, OUTCOME_LAG_DAYS,
  selectionSummary, setAsideFrom,
};

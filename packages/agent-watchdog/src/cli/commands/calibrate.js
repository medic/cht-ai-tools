'use strict';
// Weekly calibration (US4 scenario 4, FR-058, SC-002; contracts/cli.md "calibrate"): build the Calibration
// Report from stored runs and corpus outcomes, write threshold proposals for review, ask the model for a short
// reviewer summary, and store calibration/<week>.json and .md. Nothing here contacts Grafana or Slack; the only
// external call is the summary model call, and the report stands without it.
const fs = require('node:fs');
const path = require('node:path');
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { withEgressGuard } = require('../../net/egress');
const { normaliseHost } = require('../../config/policy');
const { ensureDataLayout, dataPaths } = require('../../store/run-dir');
const atomic = require('../../store/atomic');
const { writeResult } = require('../streams');
const { createTracer, finishTraceSafely } = require('../../trace/langfuse');
const { schemas } = require('../../model/schemas');
const { buildAllowlist, allowedHosts } = require('../../links/allowlist');
const { isoWeekOf, weekRange } = require('../../calibration/week');
const { buildCalibrationReport, reportWindow, openProposalsFor } = require('../../calibration/report');
const { summariseReport, PROMPT_FILE } = require('../../calibration/summary');

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const pct = (value) => (value === null || value === undefined ? 'n/a' : `${Number(value.toFixed(1))}%`);
const share = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** A pattern-level threshold proposal: the project is named only in the structured evidence (FR-033). */
const thresholdProposal = (entry, window) => {
  const { distribution: d, effect_last_30d: effect, outcomes } = entry;
  const direction = entry.suggested_threshold > entry.current_threshold ? 'Raise' : 'Lower';
  const body = [
    '## Proposal',
    '',
    `${direction} the \`pct_change_vs_previous_day\` threshold for \`${entry.metric}\` on one project from `
      + `${pct(entry.current_threshold)} to ${pct(entry.suggested_threshold)}.`,
    '',
    `## Evidence (${window.from} to ${window.to})`,
    '',
    `- Daily absolute percentage change over ${d.days} days: median ${pct(d.pct_p50)}, 90th percentile `
      + `${pct(d.pct_p90)}, 95th percentile ${pct(d.pct_p95)}, maximum ${pct(d.pct_max)}.`,
    `- Items flagged in the window: ${outcomes.confirmed} confirmed, ${outcomes.dismissed} dismissed, `
      + `${outcomes.unreviewed} unreviewed.`,
    `- With the proposed threshold: ${effect.items_kept} items kept, ${effect.items_dropped} dropped, `
      + `${effect.confirmed_kept} of ${outcomes.confirmed} confirmed items kept.`,
    '',
    '## How to adopt',
    '',
    'Set `thresholds.pct_change_vs_previous_day` for the project in `projects.yaml` by pull request. '
      + 'This system never edits thresholds itself; the project is identified in the evidence below.',
  ].join('\n');
  return {
    type: 'threshold',
    title: `Adjust the percentage-change threshold for ${entry.metric}`,
    body,
    evidence: [{
      project_url: entry.project_url,
      metric: entry.metric,
      current_threshold: entry.current_threshold,
      suggested_threshold: entry.suggested_threshold,
      distribution: entry.distribution,
      effect_last_30d: entry.effect_last_30d,
      outcomes: entry.outcomes,
      window,
    }],
  };
};

const renderMarkdown = ({ week, report, window, summary, reason }) => {
  const rate = report.feedback_rate;
  const months = (rate.by_month || []).map((m) => `${m.month} ${share(m.rate)} (${m.items})`).join(', ');
  const lines = [
    `# Calibration ${week}`,
    '',
    `Window: ${window.from} to ${window.to}. Pass change rate: ${share(report.pass_change_rate)}. `
      + `Feedback rate over ${rate.window_days} days: ${share(rate.overall)}${months ? ` (by month: ${months})` : ''}.`,
    '',
    '## Summary',
    '',
    summary || `_Model summary unavailable (${reason})._`,
    '',
    '## Entries',
    '',
    '| Project | Metric | Days | p50 | p90 | p95 | Max | Confirmed | Dismissed | Unreviewed | Current | Suggested '
      + '| Kept | Dropped | Confirmed kept |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of report.entries) {
    const d = e.distribution;
    lines.push(`| ${hostOf(e.project_url) || e.project_url} | \`${e.metric}\` | ${d.days} | ${pct(d.pct_p50)} | `
      + `${pct(d.pct_p90)} | ${pct(d.pct_p95)} | ${pct(d.pct_max)} | ${e.outcomes.confirmed} | ${e.outcomes.dismissed} `
      + `| ${e.outcomes.unreviewed} | ${pct(e.current_threshold)} | ${pct(e.suggested_threshold)} | `
      + `${e.effect_last_30d.items_kept} | ${e.effect_last_30d.items_dropped} | ${e.effect_last_30d.confirmed_kept} |`);
  }
  if (!report.entries.length) {
    lines.push('| _no computed changes in the window_ | | | | | | | | | | | | | | |');
  }
  lines.push('', '## Proposals', '');
  lines.push(...(report.proposals.length ? report.proposals.map((id) => `- ${id}`) : ['None.']));
  // FR-063: the one place that reminds reviewers of what still awaits them, with how long it has waited.
  lines.push('', '## Open proposals', '');
  const open = report.open_proposals || [];
  if (open.length) {
    lines.push('| Proposal | Type | Age (days) |', '|---|---|---|');
    lines.push(...open.map((p) => `| ${p.proposal_id} | ${p.type} | ${p.age_days} |`));
  } else {
    lines.push('None awaiting review.');
  }
  return `${lines.join('\n')}\n`;
};

const defaultCreateEngine = ({ config, env, logger }) => {
  const { loadDefinition } = require('../../agent/definition');
  const definition = loadDefinition({ paths: config.paths, env });
  const mcpConfig = { mcpServers: {} };
  if (config.model.engine === 'cli') {
    const { createCliEngine } = require('../../agent/engine-cli');
    return createCliEngine({ config, definition, mcpConfig, env, logger });
  }
  const { createSdkEngine } = require('../../agent/engine-sdk');
  return createSdkEngine({ config, definition, mcpConfig, env, logger });
};

const engineOrNull = ({ deps, config, env, logger }) => {
  if (deps.engine) {
    return deps.engine;
  }
  try {
    return (deps.createEngine || defaultCreateEngine)({ config, env, logger });
  } catch (error) {
    logger.warn('calibrate.engine_unavailable', { error: error.message });
    return null;
  }
};

const resolveWeek = (flags, now) => {
  const week = flags.week || isoWeekOf(now);
  try {
    weekRange(week);
  } catch (error) {
    throw new codes.ExitError(codes.USAGE, `--week must be an ISO week such as 2026-W38: ${error.message}`);
  }
  return week;
};

/**
 * Build the weekly Calibration Report, write threshold proposals and print the report on stdout.
 */
module.exports = async function calibrate({
  flags = {}, env = process.env, stdout = process.stdout, logger, deps = {},
}) {
  const { config, policy } = loadConfig({ env, flags, command: 'calibrate' });
  // The summary call and the trace flush leave this process, so the command runs under the egress guard
  // (FR-083, revision 33).
  return withEgressGuard({ config, logger, deps }, (guarded) => calibrateLoaded({
    flags, env, stdout, logger, deps: guarded, config, policy,
  }));
};

const calibrateLoaded = async ({ flags, env, stdout, logger, deps, config, policy }) => {
  const now = deps.now ? deps.now() : new Date();
  const week = resolveWeek(flags, now);
  const projects = (flags.project || []).map(normaliseHost);
  const dataDir = config.storage.dataDir;
  const runId = `calibrate-${week}`;
  const log = logger.child({ run_id: runId });
  await ensureDataLayout(dataDir);
  const window = reportWindow({ week, now });
  const tracer = deps.tracer || createTracer({ config });
  await tracer.start({ runId, date: window.to, mode: 'manual', tags: ['calibrate', week] });
  const startHr = process.hrtime.bigint();
  try {
    const report = await tracer.stage('report', () => buildCalibrationReport({
      dataDir, week, policy, config, projects: projects.length ? projects : null, now,
    }));
    log.info('calibrate.report', {
      week, window, entries: report.entries.length, pass_change_rate: report.pass_change_rate,
    });

    const proposals = report.entries
      .filter((entry) => entry.suggested_threshold !== null)
      .map((entry) => thresholdProposal(entry, window));
    let written = { written: [], superseded: [] };
    if (proposals.length) {
      const writeProposals = deps.writeProposals || require('../../rollup/proposals').writeProposals;
      written = await tracer.stage('proposals', () => writeProposals({
        dataDir,
        runDir: null,
        runId,
        date: window.to,
        proposals,
        hosts: [...new Set(proposals.map((p) => hostOf(p.evidence[0].project_url)).filter(Boolean))],
        persons: [],
        allowedHosts: allowedHosts(buildAllowlist(config)),
        now: () => now,
        logger: log,
      }));
    }
    report.proposals = (written.written || []).map((w) => w.proposal_id);
    // Proposals written just now are open too; recount after writing so the weekly list is complete.
    report.open_proposals = await openProposalsFor(dataDir, now);

    const engine = engineOrNull({ deps, config, env, logger: log });
    const promptText = fs.readFileSync(path.join(config.paths.promptsDir, PROMPT_FILE), 'utf8');
    const summary = engine
      ? await tracer.stage('summary', () => summariseReport({ engine, report, config, promptText, logger: log }))
      : { summary: null, call: null, reason: 'no engine available' };
    if (!summary.summary) {
      log.warn('calibrate.summary_unavailable', { reason: summary.reason });
    }

    const validated = schemas.CalibrationReport.parse(report);
    const calibrationDir = dataPaths(dataDir).calibration;
    await atomic.writeJsonAtomic(path.join(calibrationDir, `${week}.json`), validated);
    await atomic.writeFileAtomic(
      path.join(calibrationDir, `${week}.md`),
      renderMarkdown({ week, report: validated, window, summary: summary.summary, reason: summary.reason }),
    );
    const costUsd = summary.call ? summary.call.cost_usd : 0;
    const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
    log.info('calibrate.done', {
      week, entries: validated.entries.length, proposals: validated.proposals, cost_usd: costUsd,
      duration_ms: durationMs,
    });
    // The result first, then the flush: tracing is observability, never the product (revision 35).
    writeResult(stdout, validated);
    await finishTraceSafely(tracer, log, {
      status: 'completed', entries: validated.entries.length, proposals: validated.proposals, cost_usd: costUsd,
    });
    return codes.OK;
  } catch (error) {
    log.error('calibrate.failed', { error });
    await finishTraceSafely(tracer, log, { status: 'failed', error: error.message });
    throw error;
  }
};

module.exports.thresholdProposal = thresholdProposal;
module.exports.renderMarkdown = renderMarkdown;

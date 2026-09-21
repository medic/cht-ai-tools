'use strict';
// Stage: rollup. Reads every project's last pass, ranks, composes and gates the brief, writes rollup/*.
const fs = require('node:fs');
const { requireInputs } = require('./index');
const { rankItems, matchPatternCards } = require('../../rollup/rank');
const { buildLayout, groupOfProjects } = require('../../rollup/layout');
const { buildAlertGroupLinks } = require('../../links/build');
const { housekeepingNotice, clearedEpisodes, resolvedNotice, runBudgetNotice } = require('../../rollup/notices');
const { analysisRecord } = require('../../rollup/analysis');
const { splitStanding, standingRecords, standingNotices, darkHostsOf } = require('../../analyze/standing');
const { analysedHosts, onAnalysedHosts, scopeClassified } = require('../../rollup/scope');
const { readEpisodeEvents } = require('../../alerts/episodes');
const { bareKey } = require('../../analyze/kinds');
const { updateEpisodes } = require('../../alerts/episodes');
const { RunDir } = require('../../store/run-dir');
const { previousRunIds } = require('./../../rollup/history');
const { composeBrief } = require('../../rollup/brief');
const { applyMemoryUpdate, createModelCondenser } = require('../../rollup/memory');
const { writeProposals } = require('../../rollup/proposals');
const { previousHostsFor, newProjectNotices } = require('../../rollup/new-projects');
const { allowedHosts } = require('../../links/allowlist');
const { buildFooter, round6 } = require('../../publish/footer');

const name = 'rollup';
const inputs = ['discovery.json'];

const lastFindingsFile = (runDir, slug) => {
  const dir = runDir.projectPath(slug);
  if (!fs.existsSync(dir)) {
    return null;
  }
  const passes = fs.readdirSync(dir)
    .map((file) => /^findings\.pass(\d+)\.json$/.exec(file))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  if (!passes.length) {
    return null;
  }
  return `${slug}/findings.pass${Math.max(...passes)}.json`;
};

const readIfExists = async (runDir, rel, fallback) => (runDir.exists(rel) ? runDir.readJson(rel) : fallback);

const expectedLoadNoticeFrom = (activeWindows) => {
  if (!activeWindows) {
    return null;
  }
  const entries = activeWindows instanceof Map ? [...activeWindows.values()] : Object.values(activeWindows);
  const notes = [...new Set(entries.filter(Boolean).map((window) => window.note || window.id))];
  return notes.length ? `Expected-load window active: ${notes.join('; ')}` : null;
};

const ownersOf = (policy) => {
  const projects = policy && policy.projects && policy.projects.projects;
  return projects ? Object.values(projects).map((annotation) => annotation && annotation.owner).filter(Boolean) : [];
};

// The model condenser needs an engine and the roll-up prompt; without them condensation falls back to code.
const condenserFor = (ctx, logger, calls, runId) => {
  if (!ctx.engine || !ctx.definition || !ctx.definition.rollup) {
    return null;
  }
  try {
    return createModelCondenser({
      engine: ctx.engine, definition: ctx.definition, config: ctx.config, logger, calls, runId,
    });
  } catch (error) {
    logger.warn('rollup.condenser_unavailable', { error: error.message });
    return null;
  }
};

/** The most recent earlier run's discovery, for version changes in episode correlations (FR-067). */
const previousDiscoveryFor = async (dataDir, runId) => {
  for (const id of await previousRunIds(dataDir, runId)) {
    const run = RunDir.open(dataDir, id);
    if (run.exists('discovery.json')) {
      return run.readJson('discovery.json');
    }
  }
  return null;
};

const feedbackEntries = (byItem) => {
  if (!byItem) {
    return [];
  }
  const entries = byItem instanceof Map ? [...byItem.entries()] : Object.entries(byItem);
  return entries.map(([itemId, entry]) => ({ item_id: itemId, ...entry }));
};

const run = async (ctx) => {
  const { runDir, logger } = ctx;
  requireInputs(runDir, inputs);
  const discovery = await runDir.readJson('discovery.json');

  const items = [];
  const candidates = [];
  // The candidates the sessions were handed, and the standing conditions code kept (FR-014, revision 23).
  const forModelCandidates = [];
  const standing = [];
  const groupOf = groupOfProjects(discovery);
  const changes = {};
  let referenceSourcesUnavailable = false;
  // Sessions that failed before a result (revision 13): counted and named so the brief can say so rather than
  // present an empty analysis as a quiet day.
  const passesByProject = [];
  for (const project of discovery.projects || []) {
    const { slug } = project;
    const own = await readIfExists(runDir, `${slug}/candidates.json`, []);
    candidates.push(...own);
    changes[slug] = await readIfExists(runDir, `${slug}/changes.json`, []);
    forModelCandidates.push(...splitStanding({ candidates: own, changes: changes[slug] }).forModel);
    standing.push(...standingRecords({ candidates: own, changes: changes[slug], project, groupOf }));
    const findings = lastFindingsFile(runDir, slug);
    if (findings) {
      const pass = await runDir.readJson(findings);
      items.push(...(pass.items || []));
    }
    const session = await readIfExists(runDir, `${slug}/session.json`, null);
    if (session && session.reference_sources_unavailable) {
      referenceSourcesUnavailable = true;
    }
    passesByProject.push({ url: project.url, passes: await readIfExists(runDir, `${slug}/passes.json`, null) });
  }
  // Failed sessions and sessions stopped by a bound before a result are both named in the brief (revision 13, 16).
  const analysis = analysisRecord(passesByProject);
  if (analysis.failed.length) {
    logger.warn('rollup.analysis_failures', {
      failed: analysis.failed.length, projects: analysis.projects, first_error: analysis.errors[0] || null,
    });
  }
  if (analysis.incomplete.length) {
    logger.warn('rollup.analysis_incomplete', {
      incomplete: analysis.incomplete.length,
      projects: analysis.projects,
      bounds: [...new Set(analysis.incomplete.flatMap((i) => i.bounds))],
      spent_usd: round6(analysis.incomplete.reduce((sum, i) => sum + (i.cost_usd || 0), 0)),
      hint: 'measure one project with a higher AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT, or lower AGENT_WATCHDOG_EFFORT',
    });
  }
  if (analysis.rejected.length) {
    const reasons = analysis.rejected.map((r) => r.reason);
    logger.warn('rollup.analysis_rejected', {
      rejected: analysis.rejected.length,
      projects: analysis.projects,
      reasons: [...new Set(reasons)],
      hint: 'the gate refused every attempt; the revision prompts in prompt.pass<n>.md hold each reason',
    });
  }

  // Merged pattern cards are matched by metric before ranking, so persistence and feedback key on the final id.
  const cards = ctx.deps && ctx.deps.patternCards ? ctx.deps.patternCards : null;
  const matching = matchPatternCards(items, cards);
  if (matching.matched.length) {
    logger.info('rollup.pattern_cards', { matched: matching.matched });
  }
  // Alert Groups (FR-066) take body slots of their own, ranked among the items by importance; an unavailable
  // alerting API is a notice on the brief, never a failure.
  const wholeClassified = await readIfExists(runDir, 'alerts.classified.json', null);
  // A filtered run briefs only what it analysed (FR-066): the record on disk and the episodes stay whole, so the
  // next full run sees the same newness and no other project's episode looks cleared (revision 19).
  const analysed = analysedHosts({ discovery, flags: ctx.flags || {} });
  const classified = scopeClassified(wholeClassified, analysed, {
    groupSizes: Object.fromEntries((discovery.groups || []).map((g) => [g.label, (g.hosts || []).length])),
  });
  if (analysed) {
    logger.info('rollup.scoped', {
      analysed: [...analysed], alert_groups: ((classified && classified.groups) || []).length,
    });
  }
  const alertsAvailable = Boolean(classified && classified.available);
  // When the alerts were read: the classification's time, else this run's clock (revision 16).
  const alertsObservedAt = (classified && classified.observed_at) || ctx.now || null;
  const alertGroups = alertsAvailable ? (classified.groups || []) : [];
  const staleAfterDays = (classified && classified.stale_after_days) || 14;
  const grafanaUrl = ctx.config.endpoints && ctx.config.endpoints.grafanaUrl;
  const alertLinks = grafanaUrl ? alertGroups.flatMap((group) => buildAlertGroupLinks({ grafanaUrl, group }).all) : [];

  // Items of one programme share a body slot as sub-bullets (FR-069); the layout is written for the gate and the
  // publish stage to read, so the prompt, the accepted draft and the post agree.
  // Connected users per project, from the computed changes, rank the most-used projects first (FR-081).
  const usersByUrl = new Map();
  for (const project of discovery.projects || []) {
    const users = (changes[project.slug] || []).find((c) => bareKey(c.metric) === 'cht_connected_users_count');
    if (users && users.current_value !== null && users.current_value !== undefined) {
      usersByUrl.set(project.url, users.current_value);
    }
  }
  const ranked = rankItems({
    items: matching.items, previousItemIds: ctx.previousItemIds || new Map(), feedbackByItem: ctx.feedbackByItem,
    groupOf, alertGroups, usersOf: (url) => usersByUrl.get(url) || 0,
  });
  await runDir.writeJson('rollup/items.ranked.json', ranked);
  const layout = buildLayout(ranked, { groupOf, alertGroups });
  await runDir.writeJson('rollup/layout.json', layout);
  // The groups the brief describes, so the thread replies cannot describe a different set (FR-066, revision 19).
  await runDir.writeJson('rollup/alert-groups.json', alertGroups);
  logger.info('rollup.layout', {
    slots: layout.slots.map((slot) => ({
      slot: slot.slot, kind: slot.kind, group: slot.group, items: slot.item_ids.length,
    })),
    thread: layout.thread_items.length,
  });

  const footer = buildFooter({ config: ctx.config, traceUrl: ctx.traceUrl || null, costUsd: ctx.costSoFar || 0 });
  // Projects that were not in the previous run are named in the brief (SC-008); unconfigured ones are marked.
  const dataDirForHistory = (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir;
  const previousHosts = await previousHostsFor({ dataDir: dataDirForHistory, runId: ctx.runId || runDir.runId });
  const noticeDiscovery = analysed
    ? { ...discovery, projects: (discovery.projects || []).filter((p) => analysed.has(p.host)) }
    : discovery;
  const notices = newProjectNotices({ discovery: noticeDiscovery, previousHosts });
  if (notices.length) {
    logger.info('rollup.new_projects', { notices, first_run: previousHosts === null });
  }
  if (classified && !classified.available) {
    notices.push(`Alerts unavailable: ${classified.reason || 'the alerting endpoints did not answer'}`);
  }
  // The run budget may have stopped the analysis short (FR-012): the brief says how far it got.
  const budgetNotice = runBudgetNotice(await readIfExists(runDir, 'agent.summary.json', null));
  if (budgetNotice) {
    notices.push(budgetNotice);
  }
  // Standing conditions (FR-014, revision 23): named once per rule, grouped by programme, and listed per host in the
  // report; the hosts dark today and yesterday join the housekeeping line.
  await runDir.writeJson('rollup/standing.json', standing);
  const groupSizes = Object.fromEntries((discovery.groups || []).map((g) => [g.label, (g.hosts || []).length]));
  const standingLines = standingNotices({ records: standing, groupSizes });
  if (standingLines.length) {
    logger.info('rollup.standing', { records: standing.length, notices: standingLines });
    notices.push(...standingLines);
  }
  // Old news and good news (FR-080): stale alerts on dead hosts once, and episodes that cleared since the last run.
  const housekeeping = housekeepingNotice(alertsAvailable ? classified.housekeeping || [] : [], darkHostsOf(standing));
  if (housekeeping) {
    notices.push(housekeeping);
  }
  if (alertsAvailable) {
    const firingIds = new Set((classified.instances || [])
      .filter((i) => i.state === 'firing')
      .map((i) => i.instance_id));
    const cleared = onAnalysedHosts(clearedEpisodes({
      events: await readEpisodeEvents(dataDirForHistory), firingIds,
      runStart: ctx.runStart || new Date(`${ctx.date}T06:00:00Z`), observedAt: alertsObservedAt,
      ignoredHosts: classified.ignored_hosts || [],
    }), analysed);
    const resolved = resolvedNotice(cleared);
    if (resolved) {
      notices.push(resolved);
    }
  }
  const composed = await composeBrief({
    ctx,
    items: ranked,
    discovery,
    changes,
    candidates: forModelCandidates,
    allCandidates: candidates,
    analysis,
    memory: ctx.memory || null,
    feedbackUnmatched: ctx.feedbackUnmatched || [],
    expectedLoadNotice: expectedLoadNoticeFrom(ctx.activeWindows),
    referenceSourcesUnavailable,
    footer,
    notices,
    // The day's matched feedback, keyed by item, so the memory update can reflect the notes (FR-029).
    feedback: feedbackEntries(ctx.feedbackByItem),
    feedbackBrief: ctx.feedbackBrief || null,
    layout,
    alertGroups,
    alertLinks,
    staleAfterDays,
  });

  const dataDir = (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir;
  const runId = ctx.runId || runDir.runId;
  const calls = [...(composed.calls || [])];

  // Proposals go to files for review, scrubbed of identifiers (FR-032, FR-033); nothing reviewed is edited.
  const proposals = await writeProposals({
    dataDir,
    runDir,
    runId,
    date: ctx.date,
    proposals: composed.proposals || [],
    hosts: (discovery.projects || []).map((p) => p.host),
    persons: [...(ctx.feedbackAuthors || []), ...ownersOf(ctx.policy)],
    allowedHosts: allowedHosts(ctx.allowlist || []),
    logger,
  });

  const memoryUpdate = composed.memoryUpdate || null;
  const memory = await applyMemoryUpdate({
    dataDir,
    runDir,
    runId,
    replaceWith: memoryUpdate && memoryUpdate.replace_with !== undefined ? memoryUpdate.replace_with : null,
    maxTokens: (ctx.config.behaviour && ctx.config.behaviour.memoryMaxTokens) || 4000,
    condense: condenserFor(ctx, logger, calls, runId),
    logger,
  });
  logger.info('rollup.memory', memory);

  // The footer was built before the roll-up's own model calls (drafts and any condensation); fold their cost in
  // so the post and run.json agree.
  const ownCost = calls.reduce((sum, call) => sum + (call.cost_usd || 0), 0);
  composed.brief.footer.cost_usd = round6((ctx.costSoFar || 0) + ownCost);

  for (const { attempt, draft, report } of composed.drafts) {
    await runDir.writeJson(`rollup/brief.draft${attempt}.json`, draft);
    await runDir.writeJson(`rollup/verification.draft${attempt}.json`, report);
  }
  await runDir.writeJson('rollup/brief.json', composed.brief);

  // Episodes (FR-067): opened, observed and cleared against the durable record, with the items known. Skipped when
  // alerting was unavailable, since an absent instance then means nothing.
  let episodes = { opened: [], observed: [], cleared: [] };
  if (alertsAvailable) {
    const candidatesByProject = {};
    for (const candidate of candidates) {
      (candidatesByProject[candidate.project_url] = candidatesByProject[candidate.project_url] || []).push(candidate);
    }
    episodes = await updateEpisodes({
      dataDir,
      runId,
      date: ctx.date,
      runStart: ctx.runStart || new Date(`${ctx.date}T06:00:00Z`),
      observedAt: alertsObservedAt,
      ignoredHosts: (wholeClassified && wholeClassified.ignored_hosts) || [],
      classified: wholeClassified,
      items: ranked,
      candidatesByProject,
      discovery,
      previousDiscovery: await previousDiscoveryFor(dataDir, runId),
      categories: (ctx.policy && ctx.policy.alerts && ctx.policy.alerts.categories) || {},
      logger,
    });
  }

  await runDir.writeJson('rollup/rollup-output.json', {
    memory_update: composed.memoryUpdate,
    proposals: composed.proposals,
    proposal_ids: proposals.written.map((w) => w.proposal_id),
    proposals_superseded: proposals.superseded,
    memory,
    alerts: {
      available: alertsAvailable,
      groups: alertGroups.length,
      episodes: {
        opened: episodes.opened.length, observed: episodes.observed.length, cleared: episodes.cleared.length,
      },
    },
  });
  logger.info('rollup.done', {
    kind: composed.brief.kind,
    items: ranked.length,
    bullets: composed.brief.bullets.length,
    degraded: composed.degraded,
    drafts: composed.drafts.length,
  });
  return {
    kind: composed.brief.kind,
    items: ranked.length,
    bullets: composed.brief.bullets.length,
    degraded: composed.degraded,
    calls,
    proposals: proposals.written.map((w) => w.proposal_id),
    alert_groups: alertGroups.length,
  };
};

module.exports = { name, inputs, run, lastFindingsFile };

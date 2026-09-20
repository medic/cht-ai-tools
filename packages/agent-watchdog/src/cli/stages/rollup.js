'use strict';
// Stage: rollup. Reads every project's last pass, ranks, composes and gates the brief, writes rollup/*.
const fs = require('node:fs');
const { requireInputs } = require('./index');
const { rankItems, matchPatternCards } = require('../../rollup/rank');
const { buildLayout, groupOfProjects } = require('../../rollup/layout');
const { buildAlertGroupLinks } = require('../../links/build');
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
  const changes = {};
  let referenceSourcesUnavailable = false;
  for (const project of discovery.projects || []) {
    const { slug } = project;
    candidates.push(...await readIfExists(runDir, `${slug}/candidates.json`, []));
    changes[slug] = await readIfExists(runDir, `${slug}/changes.json`, []);
    const findings = lastFindingsFile(runDir, slug);
    if (findings) {
      const pass = await runDir.readJson(findings);
      items.push(...(pass.items || []));
    }
    const session = await readIfExists(runDir, `${slug}/session.json`, null);
    if (session && session.reference_sources_unavailable) {
      referenceSourcesUnavailable = true;
    }
  }

  // Merged pattern cards are matched by metric before ranking, so persistence and feedback key on the final id.
  const cards = ctx.deps && ctx.deps.patternCards ? ctx.deps.patternCards : null;
  const matching = matchPatternCards(items, cards);
  if (matching.matched.length) {
    logger.info('rollup.pattern_cards', { matched: matching.matched });
  }
  // Alert Groups (FR-066) take body slots of their own, ranked among the items by importance; an unavailable
  // alerting API is a notice on the brief, never a failure.
  const classified = await readIfExists(runDir, 'alerts.classified.json', null);
  const alertsAvailable = Boolean(classified && classified.available);
  const alertGroups = alertsAvailable ? (classified.groups || []) : [];
  const staleAfterDays = (classified && classified.stale_after_days) || 14;
  const grafanaUrl = ctx.config.endpoints && ctx.config.endpoints.grafanaUrl;
  const alertLinks = grafanaUrl ? alertGroups.flatMap((group) => buildAlertGroupLinks({ grafanaUrl, group }).all) : [];

  // Items of one programme share a body slot as sub-bullets (FR-069); the layout is written for the gate and the
  // publish stage to read, so the prompt, the accepted draft and the post agree.
  const groupOf = groupOfProjects(discovery);
  const ranked = rankItems({
    items: matching.items, previousItemIds: ctx.previousItemIds || new Map(), feedbackByItem: ctx.feedbackByItem,
    groupOf, alertGroups,
  });
  await runDir.writeJson('rollup/items.ranked.json', ranked);
  const layout = buildLayout(ranked, { groupOf, alertGroups });
  await runDir.writeJson('rollup/layout.json', layout);
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
  const notices = newProjectNotices({ discovery, previousHosts });
  if (notices.length) {
    logger.info('rollup.new_projects', { notices, first_run: previousHosts === null });
  }
  if (classified && !classified.available) {
    notices.push(`Alerts unavailable: ${classified.reason || 'the alerting endpoints did not answer'}`);
  }
  const composed = await composeBrief({
    ctx,
    items: ranked,
    discovery,
    changes,
    candidates,
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
      classified,
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

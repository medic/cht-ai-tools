'use strict';
// Stage: rollup. Reads every project's last pass, ranks, composes and gates the brief, writes rollup/*.
const fs = require('node:fs');
const { requireInputs } = require('./index');
const { rankItems, matchPatternCards } = require('../../rollup/rank');
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
  const ranked = rankItems({
    items: matching.items, previousItemIds: ctx.previousItemIds || new Map(), feedbackByItem: ctx.feedbackByItem,
  });
  await runDir.writeJson('rollup/items.ranked.json', ranked);

  const footer = buildFooter({ config: ctx.config, traceUrl: ctx.traceUrl || null, costUsd: ctx.costSoFar || 0 });
  // Projects that were not in the previous run are named in the brief (SC-008); unconfigured ones are marked.
  const dataDirForHistory = (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir;
  const previousHosts = await previousHostsFor({ dataDir: dataDirForHistory, runId: ctx.runId || runDir.runId });
  const notices = newProjectNotices({ discovery, previousHosts });
  if (notices.length) {
    logger.info('rollup.new_projects', { notices, first_run: previousHosts === null });
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
  await runDir.writeJson('rollup/rollup-output.json', {
    memory_update: composed.memoryUpdate,
    proposals: composed.proposals,
    proposal_ids: proposals.written.map((w) => w.proposal_id),
    proposals_superseded: proposals.superseded,
    memory,
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
  };
};

module.exports = { name, inputs, run, lastFindingsFile };

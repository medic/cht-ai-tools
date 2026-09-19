'use strict';
// Stage: rollup. Reads every project's last pass, ranks, composes and gates the brief, writes rollup/*.
const fs = require('node:fs');
const { requireInputs } = require('./index');
const { rankItems } = require('../../rollup/rank');
const { composeBrief } = require('../../rollup/brief');
const { applyMemoryUpdate } = require('../../rollup/memory');

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

  const ranked = rankItems({
    items, previousItemIds: ctx.previousItemIds || new Map(), feedbackByItem: ctx.feedbackByItem,
  });
  await runDir.writeJson('rollup/items.ranked.json', ranked);

  const footer = {
    prompts_url: ctx.config.endpoints.promptsUrl,
    config_url: ctx.config.endpoints.configUrl,
    trace_url: ctx.traceUrl || null,
    cost_usd: ctx.costSoFar || 0,
  };
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
  });

  for (const { attempt, draft, report } of composed.drafts) {
    await runDir.writeJson(`rollup/brief.draft${attempt}.json`, draft);
    await runDir.writeJson(`rollup/verification.draft${attempt}.json`, report);
  }
  await runDir.writeJson('rollup/brief.json', composed.brief);
  const memoryUpdate = composed.memoryUpdate || null;
  const memory = await applyMemoryUpdate({
    dataDir: (ctx.config.storage && ctx.config.storage.dataDir) || runDir.dataDir,
    runDir,
    runId: ctx.runId || runDir.runId,
    replaceWith: memoryUpdate && memoryUpdate.replace_with !== undefined ? memoryUpdate.replace_with : null,
    maxTokens: (ctx.config.behaviour && ctx.config.behaviour.memoryMaxTokens) || 4000,
  });
  logger.info('rollup.memory', memory);
  await runDir.writeJson('rollup/rollup-output.json', {
    memory_update: composed.memoryUpdate,
    proposals: composed.proposals,
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
    calls: composed.calls,
  };
};

module.exports = { name, inputs, run };

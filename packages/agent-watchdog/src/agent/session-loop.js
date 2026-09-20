'use strict';
// The per-project session loop shared by both engines (contracts/agent-definition.md): passes as turns in
// one session, the gate between turns, convergence, bounds, and every artefact the run directory contract
// names (FR-056 to FR-058, FR-012, FR-017).
const { assembleSystemPrompt, buildPassPrompt } = require('./prompt-assembly');

const URL_PATTERN = /https?:\/\/[^\s)"'<>\]]+/g;

const roundSig = (value, digits = 3) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return value;
  }
  return Number(value.toPrecision(digits));
};

const signature = (item) => {
  const evidence = (item.evidence || []).map((e) => `${e.window}:${roundSig(e.value)}`).sort().join(',');
  return `${item.severity}|${evidence}`;
};

const diffItems = (previous, next) => {
  const before = new Map(previous.map((i) => [i.item_id, signature(i)]));
  const after = new Map(next.map((i) => [i.item_id, signature(i)]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
  };
};

const normaliseUsage = (usage = {}) => ({
  input_tokens: usage.input_tokens || 0,
  output_tokens: usage.output_tokens || 0,
  cache_read_tokens: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0,
  cache_creation_tokens: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0,
});

const addUsage = (total, usage) => {
  for (const key of Object.keys(total)) {
    total[key] += usage[key] || 0;
  }
};

const urlsIn = (value) => {
  const found = JSON.stringify(value === undefined ? null : value).match(URL_PATTERN) || [];
  return [...new Set(found.map((u) => u.replace(/\\+$/, '')))];
};

const BOUND_BY_SUBTYPE = { error_max_turns: 'turns', error_max_budget_usd: 'budget' };

/**
 * Run the analysis passes for one project inside one engine session.
 * `localTools` are served in-process as the `watchdog` server; `localServers` maps further server names to
 * tool lists (replay serves the documentation service from recordings this way).
 * @returns {Promise<object>} passes, items, converged, bounds_hit, reference_sources_unavailable, cost_usd, usage
 */
const runProjectSession = async ({
  engine, definition, project, candidates, changes, feedback = [], memory = '', activeWindow = null, config, gate,
  runDir, logger, tracer = null, now = () => new Date(), deadline = null, localTools = [], localServers = {},
  mcpConfig = null, alerts = [],
}) => {
  const slug = project.slug;
  const date = now().toISOString().slice(0, 10);
  const bounds = config.bounds;
  const passRecords = [];
  const diffs = [];
  const calls = [];
  const boundsHit = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let costUsd = 0;
  let sessionId = null;
  let referenceUnavailable = false;
  let acceptedItems = [];
  let lastAcceptedPass = 0;
  let converged = false;
  let session = null;
  const toolUrls = new Set();

  const pastDeadline = () => deadline !== null && deadline !== undefined && Date.now() > deadline;

  const recordToolCalls = async (pass, attempt, toolCalls) => {
    for (const call of toolCalls || []) {
      await runDir.appendJsonl(`${slug}/tool-calls.jsonl`, { pass, attempt, ts: new Date().toISOString(), ...call });
      for (const url of urlsIn(call.tool_response)) {
        toolUrls.add(url);
      }
    }
  };

  const takeTurn = async (pass, attempt, prompt) => {
    const promptFile = `${slug}/prompt.pass${pass}.md`;
    const header = attempt === 1 ? '' : `\n\n---\n\n# Revision ${attempt - 1}\n\n`;
    const existing = attempt === 1 ? '' : await runDir.readText(promptFile);
    await runDir.writeText(promptFile, `${existing}${header}${prompt}`);
    const turn = await session.turn(prompt);
    const result = turn.result || {};
    sessionId = result.session_id || sessionId;
    const turnUsage = normaliseUsage(result.usage);
    addUsage(usage, turnUsage);
    costUsd += result.total_cost_usd || 0;
    referenceUnavailable = referenceUnavailable || Boolean(turn.referenceUnavailable);
    calls.push({
      pass, attempt, subtype: result.subtype || null, usage: turnUsage, cost_usd: result.total_cost_usd || 0,
      num_turns: result.num_turns ?? null, duration_ms: result.duration_ms ?? null,
    });
    await recordToolCalls(pass, attempt, turn.toolCalls);
    if (tracer && typeof tracer.generation === 'function') {
      tracer.generation({
        name: `${slug} pass ${pass}${attempt > 1 ? ` revision ${attempt - 1}` : ''}`,
        model: config.model.name,
        input: prompt,
        output: turn.structuredOutput === undefined ? null : JSON.stringify(turn.structuredOutput),
        usage: turnUsage,
        costUsd: result.total_cost_usd || 0,
        durationMs: result.duration_ms ?? null,
        metadata: { project_url: project.url, pass, attempt, subtype: result.subtype || null },
      });
    }
    return turn;
  };

  const runPass = async (pass) => {
    const previous = passRecords[passRecords.length - 1];
    let prompt = buildPassPrompt({
      definition, pass, project, candidates, changes, feedback, date, alerts,
      previousItems: previous ? previous.items : [],
      notSelected: previous ? previous.not_selected : [],
    });
    let attempt = 0;
    let report = null;
    let items = [];
    let findings = null;
    let accepted = false;
    let stop = false;
    let lastTurn = null;

    while (!stop) {
      attempt += 1;
      if (pastDeadline()) {
        boundsHit.add('timeout');
        break;
      }
      try {
        lastTurn = await takeTurn(pass, attempt, prompt);
      } catch (error) {
        logger.warn('agent.turn_failed', { project_url: project.url, pass, attempt, error });
        boundsHit.add('timeout');
        break;
      }
      const subtype = (lastTurn.result && lastTurn.result.subtype) || 'success';
      const bound = BOUND_BY_SUBTYPE[subtype];
      if (bound) {
        boundsHit.add(bound);
      }
      findings = lastTurn.structuredOutput;
      let reasons;
      if (findings && typeof findings === 'object') {
        const verdict = await gate({ findings, pass, project, candidates, changes, toolResultUrls: [...toolUrls] });
        report = { ...verdict.report, attempt, subject: 'pass', subject_ref: `${slug}/pass${pass}` };
        accepted = verdict.report.outcome === 'accepted';
        items = accepted ? verdict.items : [];
        reasons = accepted ? [] : verdict.report.checks.flatMap((c) => c.reasons || []);
      } else {
        reasons = [`structured output missing or invalid (${subtype})`];
        report = {
          subject: 'pass', subject_ref: `${slug}/pass${pass}`, attempt, outcome: 'rejected',
          checks: [{ name: 'schema', status: 'fail', reasons }],
        };
      }
      if (accepted || bound) {
        stop = true;
      } else if (attempt > bounds.verifyMaxRetries) {
        stop = true;
      } else {
        prompt = buildPassPrompt({ definition, pass, project, candidates, changes, revisionReasons: reasons });
      }
    }

    const last = lastTurn && lastTurn.result ? lastTurn.result : {};
    const record = {
      pass,
      session_id: sessionId,
      items,
      not_selected: (findings && Array.isArray(findings.not_selected)) ? findings.not_selected : [],
      changes: (findings && Array.isArray(findings.changes) ? findings.changes : [])
        .map((c) => ({ pass, change: c.change, reason: c.reason })),
      converged: false,
      gate: report,
      usage: lastTurn ? normaliseUsage(last.usage) : null,
      cost_usd: lastTurn ? (last.total_cost_usd || 0) : null,
      num_turns: lastTurn ? (last.num_turns ?? null) : null,
      duration_ms: lastTurn ? (last.duration_ms ?? null) : null,
      tool_calls_path: `${slug}/tool-calls.jsonl`,
    };
    if (accepted) {
      if (lastAcceptedPass > 0) {
        const diff = diffItems(acceptedItems, items);
        diffs.push({ from: lastAcceptedPass, to: pass, ...diff });
        record.converged = diff.added.length + diff.removed.length + diff.changed.length === 0;
      }
      acceptedItems = items;
      lastAcceptedPass = pass;
    }
    passRecords.push(record);
    await runDir.writeJson(`${slug}/findings.pass${pass}.json`, record);
    if (report) {
      await runDir.writeJson(`${slug}/verification.pass${pass}.json`, report);
    }
    return { accepted, record };
  };

  const writeSummaries = async () => {
    await runDir.writeJson(`${slug}/passes.json`, {
      passes: passRecords,
      diffs,
      converged,
      bounds_hit: [...boundsHit],
      reference_sources_unavailable: referenceUnavailable,
    });
    await runDir.writeJson(`${slug}/session.json`, {
      session_id: sessionId, model: config.model.name, engine: engine.name || 'unknown', calls,
      reference_sources_unavailable: referenceUnavailable,
    });
  };

  if (pastDeadline()) {
    boundsHit.add('timeout');
    await writeSummaries();
    return {
      passes: passRecords,
      items: [],
      converged,
      bounds_hit: [...boundsHit],
      reference_sources_unavailable: referenceUnavailable,
      cost_usd: 0,
      usage,
      session_id: null,
    };
  }

  const activeWindows = activeWindow ? [activeWindow] : [];
  const systemPrompt = assembleSystemPrompt({ definition, date, memory, activeWindows });
  session = await engine.openSession({
    systemPrompt,
    outputSchema: definition.outputSchemas.findings,
    tools: definition.tools.allowed,
    localTools,
    localServers,
    mcpConfig: mcpConfig || engine.mcpConfig || null,
    bounds: { maxTurns: bounds.maxTurns, maxBudgetUsd: bounds.maxBudgetUsdProject, timeoutMs: bounds.modelTimeoutMs },
    model: config.model.name,
    effort: config.model.effort,
    sessionName: slug,
  });

  try {
    for (let pass = 1; pass <= bounds.passes; pass += 1) {
      const { record } = await runPass(pass);
      if (boundsHit.size > 0) {
        break;
      }
      if (record.converged && bounds.passConvergence !== false) {
        converged = true;
        break;
      }
    }
  } finally {
    await session.close();
  }

  logger.info('agent.session_done', {
    project_url: project.url, passes: passRecords.length, items: acceptedItems.length, converged,
    bounds_hit: [...boundsHit], reference_sources_unavailable: referenceUnavailable, cost_usd: costUsd,
  });
  await writeSummaries();
  return {
    passes: passRecords,
    items: acceptedItems,
    converged,
    bounds_hit: [...boundsHit],
    reference_sources_unavailable: referenceUnavailable,
    cost_usd: Number(costUsd.toFixed(6)),
    usage,
    session_id: sessionId,
  };
};

module.exports = { runProjectSession, diffItems, signature, roundSig, normaliseUsage, urlsIn };

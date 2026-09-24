'use strict';
// The per-project session loop shared by both engines (contracts/agent-definition.md): passes as turns in
// one session, the gate between turns, convergence, bounds, and every artefact the run directory contract
// names (FR-056 to FR-058, FR-012, FR-017).
const { assembleSystemPrompt, buildPassPrompt } = require('./prompt-assembly');
const { collectToolResultUrls } = require('../verify/tool-urls');
const { RUNTIME_TOOLS } = require('../../agent/hooks');


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

/** The URLs of one tool result, read from its texts (src/verify/tool-urls.js, revision 34). */
const urlsIn = (value) => [...collectToolResultUrls([{ tool_response: value }])];

const BOUND_BY_SUBTYPE = { error_max_turns: 'turns', error_max_budget_usd: 'budget' };

/**
 * True when a tool answered with its own error envelope. The watchdog tools return `{ error }` as the whole
 * response, so that is what is read: a documentation result quoting an error payload of its own is not a failed
 * call, and run 2026-09-20-f1 counted one because the text was searched instead (revision 19).
 */
const answeredError = (response) => {
  const text = String(response === undefined || response === null ? '' : response).trim();
  if (!text.startsWith('{')) {
    return false;
  }
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === 'object' && parsed.error !== undefined;
  } catch {
    return false;
  }
};

/**
 * How the session used its tools (FR-018, revision 19): calls by tool with the ones that answered an error, and
 * the tools the runtime refused. A tool whose contract no longer matches what the model is told shows up here
 * instead of needing the record read.
 */
const toolUsage = (calls, refused) => {
  const byTool = {};
  let failed = 0;
  for (const call of calls) {
    const name = call.tool_name || 'unknown';
    // The runtime's own structured-output mechanism is how the model answers, not a tool we gave it to read with.
    if (RUNTIME_TOOLS.includes(name)) {
      continue;
    }
    byTool[name] = byTool[name] || { calls: 0, failed: 0 };
    byTool[name].calls += 1;
    if (answeredError(call.tool_response)) {
      byTool[name].failed += 1;
      failed += 1;
    }
  }
  const counted = Object.values(byTool).reduce((sum, t) => sum + t.calls, 0);
  return {
    calls: counted,
    failed,
    refused: refused.length,
    by_tool: byTool,
    refused_tools: [...new Set(refused)].sort(),
  };
};

/**
 * Run the analysis passes for one project inside one engine session.
 * `localTools` are served in-process as the `watchdog` server; `localServers` maps further server names to
 * tool lists (replay serves the documentation service from recordings this way).
 * @returns {Promise<object>} passes, items, converged, bounds_hit, reference_sources_unavailable, cost_usd, usage
 */
const runProjectSession = async ({
  engine, definition, project, candidates, changes, feedback = [], memory = '', activeWindow = null, config, gate,
  runDir, logger, tracer = null, now = () => new Date(), deadline = null, localTools = [], localServers = {},
  mcpConfig = null, alerts = [], budgetUsd = null, date = null,
}) => {
  const slug = project.slug;
  // The run's date (revision 34): a backfill or a replay tells the model the day it analyses, not today's.
  const runDate = date || now().toISOString().slice(0, 10);
  const bounds = config.bounds;
  // What this session may spend: the stage's grant, else the project budget. A turn that ends without a runtime
  // cost figure (a timeout, the harness turn cap) is charged the rest of it, marked estimated (revision 34), so
  // the run budget never re-grants money that may already be spent.
  const grantUsd = budgetUsd === null || budgetUsd === undefined ? bounds.maxBudgetUsdProject : budgetUsd;
  let costEstimated = false;
  const chargeRemainingGrant = () => {
    if (Number.isFinite(grantUsd) && costUsd < grantUsd) {
      costUsd = grantUsd;
      costEstimated = true;
    }
  };
  const passRecords = [];
  const diffs = [];
  const calls = [];
  const boundsHit = new Set();
  const errors = [];
  const allToolCalls = [];
  const refusedTools = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let costUsd = 0;
  let sessionId = null;
  let referenceUnavailable = false;
  let acceptedItems = [];
  let lastAcceptedPass = 0;
  let converged = false;
  let session = null;
  const toolUrls = new Set();
  // Every text the model was given in this session, prompts and tool results, so the gate can tell a numeral the
  // model read from one it invented (FR-016, revision 23).
  const givenTexts = [];

  const pastDeadline = () => deadline !== null && deadline !== undefined && Date.now() > deadline;

  const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value));

  const recordToolCalls = async (pass, attempt, toolCalls) => {
    for (const call of toolCalls || []) {
      await runDir.appendJsonl(`${slug}/tool-calls.jsonl`, { pass, attempt, ts: new Date().toISOString(), ...call });
      for (const url of urlsIn(call.tool_response)) {
        toolUrls.add(url);
      }
      givenTexts.push(textOf(call.tool_response));
    }
  };

  const takeTurn = async (pass, attempt, prompt) => {
    const promptFile = `${slug}/prompt.pass${pass}.md`;
    const header = attempt === 1 ? '' : `\n\n---\n\n# Revision ${attempt - 1}\n\n`;
    const existing = attempt === 1 ? '' : await runDir.readText(promptFile);
    await runDir.writeText(promptFile, `${existing}${header}${prompt}`);
    givenTexts.push(prompt);
    const turn = await session.turn(prompt);
    const result = turn.result || {};
    sessionId = result.session_id || sessionId;
    const turnUsage = normaliseUsage(result.usage);
    addUsage(usage, turnUsage);
    costUsd += result.total_cost_usd || 0;
    if (result.cost_unknown) {
      chargeRemainingGrant();
    }
    referenceUnavailable = referenceUnavailable || Boolean(turn.referenceUnavailable);
    await recordToolCalls(pass, attempt, turn.toolCalls);
    allToolCalls.push(...(turn.toolCalls || []));
    for (const denial of (result.permission_denials || [])) {
      refusedTools.push(denial.tool_name || 'unknown');
    }
    // The tracer's observation id, when it gives one, lets a later digest link this generation (FR-085).
    let observationId = null;
    if (tracer && typeof tracer.generation === 'function') {
      const observation = tracer.generation({
        name: `${slug} pass ${pass}${attempt > 1 ? ` revision ${attempt - 1}` : ''}`,
        model: config.model.name,
        input: prompt,
        output: turn.structuredOutput === undefined ? null : JSON.stringify(turn.structuredOutput),
        usage: turnUsage,
        costUsd: result.total_cost_usd || 0,
        durationMs: result.duration_ms ?? null,
        metadata: { project_url: project.url, pass, attempt, subtype: result.subtype || null },
      });
      observationId = observation && typeof observation.id === 'string' && observation.id ? observation.id : null;
    }
    calls.push({
      pass, attempt, subtype: result.subtype || null, usage: turnUsage, cost_usd: result.total_cost_usd || 0,
      num_turns: result.num_turns ?? null, duration_ms: result.duration_ms ?? null, observation_id: observationId,
    });
    return turn;
  };

  const runPass = async (pass) => {
    const previous = passRecords[passRecords.length - 1];
    let prompt = buildPassPrompt({
      definition, pass, project, candidates, changes, feedback, date: runDate, alerts,
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
        // The runtime failed before a result (process exit, refused schema, network): an `error` bound, not a
        // timeout, with the message kept for the pass record and the brief's notice (revision 13).
        logger.warn('agent.turn_failed', { project_url: project.url, pass, attempt, error });
        const message = String(error && error.message ? error.message : error).slice(0, 500);
        const timedOut = Boolean(error) && (error.code === 'TIMEOUT' || /timed out/i.test(message));
        errors.push({ pass, attempt, message, bound: timedOut ? 'timeout' : 'error' });
        boundsHit.add(timedOut ? 'timeout' : 'error');
        if (timedOut) {
          chargeRemainingGrant();
        }
        break;
      }
      const subtype = (lastTurn.result && lastTurn.result.subtype) || 'success';
      const bound = BOUND_BY_SUBTYPE[subtype];
      if (bound) {
        boundsHit.add(bound);
      }
      // A result the runtime marks as an error (a model it cannot use, an authentication problem) is a failure
      // with the runtime's own message, not a draft to revise: a new prompt would not change it (revision 17).
      const runtimeError = Boolean(lastTurn.result && lastTurn.result.is_error) && !bound
        && subtype !== 'error_max_structured_output_retries';
      if (runtimeError) {
        const message = String(lastTurn.result.result_text || (lastTurn.result.errors || [])[0]
          || `the runtime reported ${subtype} without a result`).slice(0, 500);
        logger.warn('agent.turn_error', { project_url: project.url, pass, attempt, subtype, message });
        errors.push({ pass, attempt, message, bound: 'error' });
        boundsHit.add('error');
        break;
      }
      findings = lastTurn.structuredOutput;
      let reasons;
      if (findings && typeof findings === 'object') {
        const verdict = await gate({
          findings, pass, project, candidates, changes, toolResultUrls: [...toolUrls], givenText: [...givenTexts],
        });
        report = { ...verdict.report, attempt, subject: 'pass', subject_ref: `${slug}/pass${pass}` };
        accepted = verdict.report.outcome === 'accepted';
        items = accepted ? verdict.items : [];
        // Only the checks that failed (FR-018): a passing check's informational text is not a defect to fix.
        reasons = accepted ? [] : verdict.report.checks.filter((c) => c.status === 'fail')
          .flatMap((c) => c.reasons || []);
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
      errors,
      reference_sources_unavailable: referenceUnavailable,
      cost_usd: Number(costUsd.toFixed(6)),
      cost_estimated: costEstimated,
    });
    await runDir.writeJson(`${slug}/session.json`, {
      session_id: sessionId, model: config.model.name, engine: engine.name || 'unknown', calls,
      reference_sources_unavailable: referenceUnavailable,
    });
  };

  const summaryResult = () => ({
    passes: passRecords,
    items: acceptedItems,
    converged,
    bounds_hit: [...boundsHit],
    reference_sources_unavailable: referenceUnavailable,
    cost_usd: Number(costUsd.toFixed(6)),
    cost_estimated: costEstimated,
    usage,
    session_id: sessionId,
    errors,
  });

  if (pastDeadline()) {
    boundsHit.add('timeout');
    await writeSummaries();
    return summaryResult();
  }

  const activeWindows = activeWindow ? [activeWindow] : [];
  const systemPrompt = assembleSystemPrompt({ definition, date: runDate, memory, activeWindows });
  const open = () => engine.openSession({
    systemPrompt,
    outputSchema: definition.outputSchemas.findings,
    tools: definition.tools.allowed,
    localTools,
    localServers,
    mcpConfig: mcpConfig || engine.mcpConfig || null,
    bounds: {
      maxTurns: bounds.maxTurns,
      // The stage may grant less than the project budget when the run budget is nearly spent (FR-012).
      maxBudgetUsd: budgetUsd === null || budgetUsd === undefined ? bounds.maxBudgetUsdProject : budgetUsd,
      timeoutMs: bounds.modelTimeoutMs,
    },
    model: config.model.name,
    effort: config.model.effort,
    sessionName: slug,
  });
  try {
    session = await open();
  } catch (error) {
    // A session that cannot open (no runtime on PATH, a refused schema) is this project's error bound, recorded
    // like a failed turn, never the whole stage's failure (revision 34).
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    logger.warn('agent.session_open_failed', { project_url: project.url, error });
    errors.push({ pass: 1, attempt: 0, message, bound: 'error' });
    boundsHit.add('error');
    await writeSummaries();
    return summaryResult();
  }

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
      // Nothing to review: an accepted pass that flagged nothing gives a later pass no items to check, and on a
      // quiet project that is the common case (FR-057, revision 19).
      if (!acceptedItems.length && lastAcceptedPass === pass) {
        break;
      }
    }
  } finally {
    await session.close();
  }

  logger.info('agent.tool_usage', { project_url: project.url, ...toolUsage(allToolCalls, refusedTools) });
  logger.info('agent.session_done', {
    project_url: project.url, passes: passRecords.length, items: acceptedItems.length, converged,
    bounds_hit: [...boundsHit], reference_sources_unavailable: referenceUnavailable, cost_usd: costUsd,
  });
  await writeSummaries();
  return summaryResult();
};

module.exports = { runProjectSession, diffItems, signature, roundSig, normaliseUsage, urlsIn };

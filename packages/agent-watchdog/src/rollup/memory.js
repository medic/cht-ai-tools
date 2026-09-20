'use strict';
// The agent's curated memory (FR-031): size-capped text, every change stored as a unified diff.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');
const { fill, wrapUntrusted } = require('../agent/prompt-assembly');

const MEMORY_FILE_NAME = 'memory/memory.md';
const CAP_MARGIN = 1.1;
const CONDENSATION_HEADING = '## Memory condensation';
const CONDENSE_SCHEMA = z.toJSONSchema(z.object({ memory: z.string() }).strict(), { target: 'draft-2020-12' });
const noop = { debug() {}, info() {}, warn() {}, error() {} };

const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/** True when the text sits within the cap once the ten percent margin is applied. */
const fits = (text, maxTokens) => Math.ceil(estimateTokens(text) * CAP_MARGIN) <= maxTokens;

/** The character budget that the cap allows, for the model's guidance. */
const maxCharsFor = (maxTokens) => Math.floor((maxTokens * 4) / CAP_MARGIN);

const metaFile = (dataDir) => path.join(dataPaths(dataDir).memory, 'memory.json');

const readMemory = async (dataDir) => {
  const p = dataPaths(dataDir);
  const text = fsSync.existsSync(p.memoryFile) ? await fs.readFile(p.memoryFile, 'utf8') : '';
  let version = 0;
  if (fsSync.existsSync(metaFile(dataDir))) {
    const meta = JSON.parse(await fs.readFile(metaFile(dataDir), 'utf8'));
    version = meta.version || 0;
  }
  return { text, version };
};

const splitLines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** Longest-common-subsequence line diff: edits of { op: ' ' | '-' | '+', line }. */
const diffLines = (before, after) => {
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const edits = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      edits.push({ op: ' ', line: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      edits.push({ op: '-', line: before[i] });
      i += 1;
    } else {
      edits.push({ op: '+', line: after[j] });
      j += 1;
    }
  }
  while (i < n) {
    edits.push({ op: '-', line: before[i] });
    i += 1;
  }
  while (j < m) {
    edits.push({ op: '+', line: after[j] });
    j += 1;
  }
  return edits;
};

const rangeHeader = (sign, start, count) => (count === 0
  ? `${sign}${Math.max(0, start - 1)},0`
  : `${sign}${start},${count}`);

/** A unified diff with one hunk covering every change plus `context` lines around it. */
const unifiedDiff = (oldText, newText, fileName = MEMORY_FILE_NAME, context = 3) => {
  const edits = diffLines(splitLines(oldText), splitLines(newText));
  const changed = edits.map((edit, index) => (edit.op === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) {
    return '';
  }
  const start = Math.max(0, changed[0] - context);
  const end = Math.min(edits.length - 1, changed[changed.length - 1] + context);
  let oldStart = 1;
  let newStart = 1;
  for (let k = 0; k < start; k += 1) {
    if (edits[k].op !== '+') {
      oldStart += 1;
    }
    if (edits[k].op !== '-') {
      newStart += 1;
    }
  }
  const hunk = edits.slice(start, end + 1);
  const oldCount = hunk.filter((edit) => edit.op !== '+').length;
  const newCount = hunk.filter((edit) => edit.op !== '-').length;
  const header = `@@ ${rangeHeader('-', oldStart, oldCount)} ${rangeHeader('+', newStart, newCount)} @@`;
  const body = hunk.map((edit) => `${edit.op}${edit.line}`);
  return `${[`--- ${fileName}`, `+++ ${fileName}`, header, ...body].join('\n')}\n`;
};

const noteFor = (dropped) => `<!-- condensed by code: ${dropped} lines dropped -->`;

/**
 * Deterministic condensation: keep whole lines from the end of the text (the newest facts) that fit under the
 * cap, behind one comment line saying how many lines were dropped.
 */
const condenseByCode = (text, maxTokens) => {
  const lines = splitLines(String(text || ''));
  const n = lines.length;
  const build = (kept) => `${noteFor(n - kept)}\n${kept ? `${lines.slice(n - kept).join('\n')}\n` : ''}`;
  let best = 0;
  let chars = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    chars += lines[i].length + 1;
    if (Math.ceil(Math.ceil((noteFor(i).length + 1 + chars) / 4) * CAP_MARGIN) <= maxTokens) {
      best = n - i;
    } else {
      break;
    }
  }
  let candidate = build(best);
  while (best > 0 && !fits(candidate, maxTokens)) {
    best -= 1;
    candidate = build(best);
  }
  return candidate;
};

const extractSection = (text, heading) => {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
};

const costRecord = ({ runId, config, result }) => {
  const usage = result.usage || {};
  return {
    run_id: runId,
    project_url: null,
    stage: 'rollup',
    pass: null,
    model: config.model.name,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0,
    cost_usd: result.total_cost_usd || 0,
    num_turns: result.num_turns === undefined ? null : result.num_turns,
    duration_ms: result.duration_ms === undefined ? null : result.duration_ms,
  };
};

/**
 * A condenser backed by one bounded model call. The instructions are the "## Memory condensation" section of
 * prompts/rollup.md (everything before its {{memory}} placeholder, with the cap filled in); the memory itself is
 * the user turn, wrapped as untrusted data. Returns the new text, or null when the model gave none.
 */
const createModelCondenser = ({ engine, definition, config, logger = null, calls = null, runId = null }) => {
  const section = extractSection(definition && definition.rollup, CONDENSATION_HEADING);
  if (!section) {
    throw new Error(`prompts/rollup.md has no "${CONDENSATION_HEADING}" section; the condensation prompt is missing`);
  }
  const [instructions] = section.split('{{memory}}');
  return async (text, { maxTokens, maxChars }) => {
    const turn = await engine.singleTurn({
      systemPrompt: [fill(instructions, { max_tokens: maxTokens, max_chars: maxChars }).trim()],
      userPrompt: `The memory to condense follows as untrusted data.\n\n${wrapUntrusted('memory', text)}`,
      outputSchema: CONDENSE_SCHEMA,
      bounds: {
        maxTurns: config.bounds.maxTurns,
        maxBudgetUsd: config.bounds.maxBudgetUsdProject,
        timeoutMs: config.bounds.modelTimeoutMs,
      },
      model: config.model.name,
      effort: config.model.effort,
      name: 'memory-condense',
    });
    const result = (turn && turn.result) || {};
    if (Array.isArray(calls)) {
      calls.push(costRecord({ runId, config, result }));
    }
    (logger || noop).info('memory.condense_call', {
      subtype: result.subtype || null, cost_usd: result.total_cost_usd || 0,
    });
    const memory = turn && turn.structuredOutput ? turn.structuredOutput.memory : null;
    return typeof memory === 'string' ? memory : null;
  };
};

/**
 * Apply the roll-up's memory update and record the diff beside the run and in history. An update over the cap
 * is condensed, by the model when a condenser is given and its answer fits, otherwise by code; the run never
 * fails on the cap (FR-031, US4 scenario 2).
 */
const applyMemoryUpdate = async ({
  dataDir, runDir = null, runId, replaceWith, maxTokens = 4000, now = () => new Date(), condense = null,
  logger = null,
}) => {
  const log = logger || noop;
  const current = await readMemory(dataDir);
  const noChange = replaceWith === null || replaceWith === undefined || replaceWith === current.text;
  if (noChange) {
    const tokens = estimateTokens(current.text);
    return {
      applied: false, reason: 'no change', version: current.version, tokens, patch_path: null, condensed_by: null,
    };
  }
  let next = String(replaceWith);
  let reason = 'applied';
  let condensedBy = null;
  if (!fits(next, maxTokens)) {
    let candidate = null;
    if (condense) {
      try {
        candidate = await condense(next, { maxTokens, maxChars: maxCharsFor(maxTokens) });
      } catch (error) {
        log.warn('memory.condense_failed', { error: error.message });
      }
    }
    if (typeof candidate === 'string' && candidate.trim() && fits(candidate, maxTokens)) {
      next = candidate;
      condensedBy = 'model';
    } else {
      if (candidate !== null && candidate !== undefined) {
        log.warn('memory.condense_over_cap', { tokens: estimateTokens(candidate), max_tokens: maxTokens });
      }
      next = condenseByCode(next, maxTokens);
      condensedBy = 'code';
    }
    reason = 'condensed';
  }
  if (next === current.text) {
    const tokens = estimateTokens(current.text);
    return {
      applied: false,
      reason: 'no change',
      version: current.version,
      tokens,
      patch_path: null,
      condensed_by: condensedBy,
    };
  }
  const tokens = estimateTokens(next);
  const p = dataPaths(dataDir);
  const patch = unifiedDiff(current.text, next);
  const version = current.version + 1;
  await atomic.writeFileAtomic(p.memoryFile, next);
  await atomic.writeJsonAtomic(metaFile(dataDir), { version, updated_at: now().toISOString(), tokens });
  const patchPath = `memory/history/${runId}.patch`;
  await atomic.writeFileAtomic(path.join(dataDir, patchPath), patch);
  if (runDir) {
    await runDir.writeText('memory.patch', patch);
  }
  return { applied: true, reason, version, tokens, patch_path: patchPath, condensed_by: condensedBy };
};

module.exports = {
  readMemory, estimateTokens, applyMemoryUpdate, unifiedDiff, diffLines, condenseByCode, maxCharsFor, fits,
  createModelCondenser, extractSection, MEMORY_FILE_NAME, CONDENSATION_HEADING,
};

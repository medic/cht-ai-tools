'use strict';
// The agent's curated memory (FR-031): size-capped text, every change stored as a unified diff.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');

const MEMORY_FILE_NAME = 'memory/memory.md';
const CAP_MARGIN = 1.1;

const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

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

/**
 * Apply the roll-up's memory update within the cap and record the diff beside the run and in history.
 * Condensation at the cap arrives with User Story 4; until then an over-cap update is refused, not failed.
 */
const applyMemoryUpdate = async ({
  dataDir, runDir = null, runId, replaceWith, maxTokens = 4000, now = () => new Date(),
}) => {
  const current = await readMemory(dataDir);
  const noChange = replaceWith === null || replaceWith === undefined || replaceWith === current.text;
  if (noChange) {
    const tokens = estimateTokens(current.text);
    return { applied: false, reason: 'no change', version: current.version, tokens, patch_path: null };
  }
  const tokens = estimateTokens(replaceWith);
  if (Math.ceil(tokens * CAP_MARGIN) > maxTokens) {
    return { applied: false, reason: 'over cap', version: current.version, tokens, patch_path: null };
  }
  const p = dataPaths(dataDir);
  const patch = unifiedDiff(current.text, replaceWith);
  const version = current.version + 1;
  await atomic.writeFileAtomic(p.memoryFile, replaceWith);
  await atomic.writeJsonAtomic(metaFile(dataDir), { version, updated_at: now().toISOString(), tokens });
  const patchPath = `memory/history/${runId}.patch`;
  await atomic.writeFileAtomic(path.join(dataDir, patchPath), patch);
  if (runDir) {
    await runDir.writeText('memory.patch', patch);
  }
  return { applied: true, reason: 'applied', version, tokens, patch_path: patchPath };
};

module.exports = { readMemory, estimateTokens, applyMemoryUpdate, unifiedDiff, diffLines, MEMORY_FILE_NAME };

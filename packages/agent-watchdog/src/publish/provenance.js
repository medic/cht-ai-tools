'use strict';
// Where the feedback acted (FR-085, revision 29), read back from what the run wrote rather than stored twice: the
// item's records' lines in the feedback block of the project's pass-1 prompt, exactly as they stand there; the
// suppression the feedback caused before analysis; and the run's trace, pointing at the pass-1 generation when
// the tracer gave its id. Run files are not web-served, so the digest quotes and links instead.

/** The keys whose lines the digest quotes: what the person wrote and what code made of it. */
const QUOTED_KEYS = Object.freeze(['kind', 'verdict', 'note', 'horizon']);
const FEEDBACK_BLOCK = /<untrusted source="feedback">\n([\s\S]*?)\n<\/untrusted>/;
const KEY_LINE = /^"([a-z_]+)":/;

/** The feedback block's body, as src/agent/prompt-assembly.js wraps it, or null when the prompt carries none. */
const feedbackBlockOf = (text) => {
  const match = FEEDBACK_BLOCK.exec(String(text || ''));
  return match ? match[1] : null;
};

const recordsOf = (block) => {
  try {
    const parsed = JSON.parse(block);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// The prompt holds `JSON.stringify(records, null, 2)`, so each record's own pretty lines sit two spaces further in.
const linesOf = (record) => JSON.stringify(record, null, 2).split('\n').map((line) => `  ${line}`);

/** The quoted lines of the given records, each checked to occur in the prompt, and how many lines they took. */
const quotedLines = (text, records) => {
  const lines = [];
  let total = 0;
  for (const record of records) {
    const all = linesOf(record);
    total += all.length;
    for (const line of all) {
      const trimmed = line.trim();
      const key = KEY_LINE.exec(trimmed);
      if (key && QUOTED_KEYS.includes(key[1]) && text.includes(line)) {
        lines.push(trimmed);
      }
    }
  }
  return { lines, total };
};

const suppressionOf = async (runDir, slug, itemId) => {
  const rel = `${slug}/suppressed.json`;
  if (!runDir.exists(rel)) {
    return null;
  }
  const entries = await runDir.readJson(rel);
  const hit = (Array.isArray(entries) ? entries : []).find((entry) => entry.item_id === itemId);
  return hit ? { until: hit.horizon || null, path: rel } : null;
};

const observationOf = async (runDir, slug) => {
  const rel = `${slug}/session.json`;
  if (!runDir.exists(rel)) {
    return null;
  }
  const session = await runDir.readJson(rel);
  const call = ((session && session.calls) || [])
    .find((c) => c.pass === 1 && (c.attempt === 1 || c.attempt === undefined));
  return call && typeof call.observation_id === 'string' && call.observation_id ? call.observation_id : null;
};

const traceLink = (traceUrl, observationId) => {
  if (!traceUrl) {
    return null;
  }
  if (!observationId) {
    return traceUrl;
  }
  return `${traceUrl}${traceUrl.includes('?') ? '&' : '?'}observation=${encodeURIComponent(observationId)}`;
};

/**
 * @param {object} options
 * @param {object} options.runDir the run directory
 * @param {object} [options.run] the run record (`trace_url`)
 * @param {{ url: string, slug: string }} options.project the item's project
 * @param {string} options.itemId
 * @param {Set<string>} [options.feedbackIds] the records being acknowledged, quoted even when their item id differs
 * @returns {Promise<{ applied: 'prompt'|'suppressed'|'both'|'none', prompt_path: string|null, records: number,
 *   lines: string[], lines_total: number, trace_url: string|null, suppressed_until: string|null,
 *   suppressed_path: string|null }>}
 */
const provenanceFor = async ({ runDir, run = {}, project, itemId, feedbackIds = new Set() }) => {
  const { slug } = project;
  const promptPath = `${slug}/prompt.pass1.md`;
  let prompt = { path: null, records: 0, lines: [], total: 0 };
  if (runDir.exists(promptPath)) {
    const text = await runDir.readText(promptPath);
    const block = feedbackBlockOf(text);
    const mine = block
      ? recordsOf(block).filter((record) => record.item_id === itemId || feedbackIds.has(record.feedback_id))
      : [];
    const { lines, total } = quotedLines(text, mine);
    prompt = { path: promptPath, records: mine.length, lines, total };
  }
  const held = await suppressionOf(runDir, slug, itemId);
  const quoted = prompt.records > 0;
  let applied = 'none';
  if (quoted && held) {
    applied = 'both';
  } else if (quoted) {
    applied = 'prompt';
  } else if (held) {
    applied = 'suppressed';
  }
  return {
    applied,
    prompt_path: prompt.path,
    records: prompt.records,
    lines: prompt.lines,
    lines_total: prompt.total,
    trace_url: traceLink((run && run.trace_url) || null, await observationOf(runDir, slug)),
    suppressed_until: held ? held.until : null,
    suppressed_path: held ? held.path : null,
  };
};

module.exports = { provenanceFor, feedbackBlockOf, quotedLines, traceLink, QUOTED_KEYS };

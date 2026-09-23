'use strict';
// Feedback review (FR-061, User Story 7): reactions are tallied by code and never shown to the model; the
// unreviewed notes on one item are one bounded, schema-validated call that says where their lesson belongs, read
// together in thread order as the clarified whole (FR-085, revision 29), and every lesson becomes a proposal file
// for human review. Nothing here changes the skill, prompts or policy.
const path = require('node:path');
const YAML = require('yaml');
const { z } = require('zod');
const { enums } = require('../model/schemas');
const { fill, wrapUntrusted } = require('../agent/prompt-assembly');
const { writeProposals } = require('../rollup/proposals');
const { maskPeople } = require('../corpus/scrub');
const { updateRecords } = require('./store');
const { threadOrder } = require('./sequence');

const NOTE_HEADING = '## Notes';
const PROPOSAL_CLASSIFICATIONS = new Set(['project_annotation', 'skill', 'prompt', 'threshold', 'pattern_card']);
const ANNOTATION_KEYS = new Set(['notes', 'owner', 'host_metrics', 'thresholds', 'expected_load_windows']);

const Output = z.object({
  classification: enums.FeedbackClassification,
  title: z.string().min(1),
  // Empty for `none` and `expectation`; a proposal-producing classification needs a lesson (checked in code).
  lesson: z.string(),
  projects_yaml: z.string().nullable(),
  rationale: z.string(),
}).strict();

const OUTPUT_SCHEMA = z.toJSONSchema(Output, { target: 'draft-2020-12' });

const noop = { info() {}, warn() {}, debug() {}, error() {} };

/** The prompt file: instructions above `## Note` are the system prompt, the rest is the user-turn template. */
const splitPrompt = (text) => {
  const index = String(text).indexOf(NOTE_HEADING);
  if (index === -1) {
    throw new Error(`feedback-review prompt has no "${NOTE_HEADING}" section`);
  }
  return { system: text.slice(0, index).trim(), user: text.slice(index) };
};

/** A projects.yaml fragment is accepted only when it could be pasted under `projects:` as is. */
const validateProjectsFragment = (text) => {
  let doc;
  try {
    doc = YAML.parse(String(text || ''), { schema: 'core' });
  } catch (error) {
    return { ok: false, reason: `YAML parse error: ${error.message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'fragment is not a mapping' };
  }
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== 'projects') {
    return { ok: false, reason: 'top-level key must be projects' };
  }
  const projects = doc.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects) || !Object.keys(projects).length) {
    return { ok: false, reason: 'no hosts under projects' };
  }
  for (const [host, annotation] of Object.entries(projects)) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      return { ok: false, reason: `host ${host} has no annotation mapping` };
    }
    for (const key of Object.keys(annotation)) {
      if (!ANNOTATION_KEYS.has(key)) {
        return { ok: false, reason: `host ${host} uses unsupported key ${key}` };
      }
    }
  }
  return { ok: true, reason: null, doc };
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url || null;
  }
};

const itemDescription = (record, byItem) => {
  const entry = record.item_id ? byItem[record.item_id] : null;
  if (!record.item_id || !entry) {
    return '- no matched item (the note was left on the brief or names no item)';
  }
  const lines = [
    `- project: ${hostOf(entry.project_url) || 'unknown'}`,
    `- metric: ${entry.metric || 'unknown'}`,
    `- reactions so far: ${entry.up || 0} up, ${entry.down || 0} down (${entry.verdict || 'unreviewed'})`,
  ];
  if (entry.pattern_card) {
    lines.push(`- pattern card: ${entry.pattern_card}`);
  }
  if (entry.horizon || record.horizon) {
    lines.push(`- expectation horizon: ${record.horizon || entry.horizon}`);
  }
  return lines.join('\n');
};

const costRecord = ({ runId, projectUrl, model, result }) => {
  const usage = result.usage || {};
  return {
    run_id: runId,
    project_url: projectUrl || null,
    stage: 'feedback',
    pass: null,
    model,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0,
    cost_usd: result.total_cost_usd || 0,
    num_turns: result.num_turns === undefined ? null : result.num_turns,
    duration_ms: result.duration_ms === undefined ? null : result.duration_ms,
  };
};

/** The notes of one thread as the model reads them: one block for a single note, numbered blocks in thread order. */
const notesBlock = (records) => {
  if (records.length === 1) {
    return wrapUntrusted('feedback-note', maskPeople(records[0].note));
  }
  const count = records.length;
  return records.map((record, i) => {
    let label = '';
    if (i === 0) {
      label = ' (earliest)';
    } else if (i === count - 1) {
      label = ' (latest)';
    }
    return `Note ${i + 1} of ${count}${label}:\n${wrapUntrusted('feedback-note', maskPeople(record.note))}`;
  }).join('\n\n');
};

/** The unreviewed notes as threads: the notes on one item together in thread order, a note on no item alone. */
const threadsOf = (notes) => {
  const byItem = new Map();
  const alone = [];
  for (const record of notes) {
    if (record.item_id) {
      if (!byItem.has(record.item_id)) {
        byItem.set(record.item_id, []);
      }
      byItem.get(record.item_id).push(record);
    } else {
      alone.push([record]);
    }
  }
  return [...[...byItem.values()].map(threadOrder), ...alone];
};

/** The proposal body: the lesson, a pasteable fragment for annotations, the rationale and a source line. */
const proposalBody = ({ output, records, entry }) => {
  const parts = [output.lesson.trim()];
  if (output.classification === 'project_annotation') {
    const fragment = validateProjectsFragment(output.projects_yaml);
    if (fragment.ok) {
      parts.push(`\`\`\`yaml\n${String(output.projects_yaml).trim()}\n\`\`\``);
    } else {
      parts.push(`fragment rejected: ${fragment.reason}; write the projects.yaml change by hand from the lesson.`);
    }
  }
  if (output.rationale && output.rationale.trim()) {
    parts.push(`## Rationale\n\n${output.rationale.trim()}`);
  }
  const where = entry ? ` (${hostOf(entry.project_url) || 'unknown'}, ${entry.metric || 'unknown'})` : '';
  const [first] = records;
  const ids = records.map((record) => record.feedback_id).join(', ');
  parts.push(`Source: feedback ${ids} on item ${first.item_id || 'none'}${where}`);
  return `${parts.join('\n\n')}\n`;
};

/**
 * Review the notes among `records` that have not been classified yet: one call per item thread, whose notes all
 * receive the classification and the proposal of the clarified whole, and one call per note on no item.
 * @returns {Promise<{ classified: object[], unclassified: string[], skipped_reactions: number, calls: object[] }>}
 */
const reviewFeedback = async ({
  dataDir, runDir = null, runId, date, records, byItem = {}, engine, config, promptText, hosts = [], persons = [],
  allowedHosts = [], logger = noop, now = () => new Date(),
}) => {
  const { system, user } = splitPrompt(promptText);
  const classified = [];
  const unclassified = [];
  const calls = [];
  const reactions = records.filter((record) => record.kind === 'reaction').length;
  const unreviewed = (record) => record.classification === null || record.classification === undefined;
  const notes = records.filter((record) => record.kind === 'note' && unreviewed(record) && record.note);

  for (const thread of threadsOf(notes)) {
    const [record] = thread;
    const ids = thread.map((r) => r.feedback_id);
    const entry = record.item_id ? byItem[record.item_id] || null : null;
    const projectUrl = entry ? entry.project_url : null;
    const userPrompt = fill(user, {
      item: itemDescription(record, byItem),
      note: notesBlock(thread),
    });
    let turn;
    try {
      turn = await engine.singleTurn({
        systemPrompt: [system],
        userPrompt,
        outputSchema: OUTPUT_SCHEMA,
        bounds: {
          maxTurns: config.bounds.maxTurns,
          maxBudgetUsd: config.bounds.maxBudgetUsdProject,
          timeoutMs: config.bounds.modelTimeoutMs,
        },
        model: config.model.feedback,
        effort: config.model.effort,
        name: 'feedback-review',
      });
    } catch (error) {
      unclassified.push(...ids);
      logger.warn('feedback.review_failed', { feedback_id: ids.join(','), reason: error.message });
      continue;
    }
    const result = (turn && turn.result) || {};
    calls.push(costRecord({ runId, projectUrl, model: config.model.feedback, result }));
    const parsed = Output.safeParse(turn && turn.structuredOutput);
    const emptyLesson = parsed.success && PROPOSAL_CLASSIFICATIONS.has(parsed.data.classification)
      && !parsed.data.lesson.trim();
    if (result.subtype !== 'success' || !parsed.success || emptyLesson) {
      unclassified.push(...ids);
      let reason = 'output failed the schema';
      if (result.subtype !== 'success') {
        reason = `model result ${result.subtype || 'missing'}`;
      } else if (emptyLesson) {
        reason = `empty lesson for a ${parsed.data.classification} proposal`;
      }
      logger.warn('feedback.review_failed', { feedback_id: ids.join(','), reason });
      continue;
    }
    const output = parsed.data;
    let proposalId = null;
    let proposalPath = null;
    if (PROPOSAL_CLASSIFICATIONS.has(output.classification)) {
      const { written } = await writeProposals({
        dataDir, runDir, runId, date, hosts, persons, allowedHosts, now, logger,
        proposals: [{
          type: output.classification,
          title: output.title,
          body: proposalBody({ output, records: thread, entry }),
          evidence: thread.map((r) => ({
            feedback_id: r.feedback_id,
            item_id: r.item_id,
            project_url: projectUrl,
            metric: entry ? entry.metric : null,
            up: entry ? entry.up : 0,
            down: entry ? entry.down : 0,
          })),
        }],
      });
      if (written[0]) {
        proposalId = written[0].proposal_id;
        proposalPath = written[0].path;
      }
    }
    const wanted = new Set(ids);
    await updateRecords(dataDir, (stored) => (wanted.has(stored.feedback_id)
      ? { ...stored, classification: output.classification, proposal_id: proposalId }
      : stored));
    for (const r of thread) {
      classified.push({
        feedback_id: r.feedback_id,
        item_id: r.item_id,
        project_url: projectUrl,
        metric: entry ? entry.metric : null,
        classification: output.classification,
        proposal_id: proposalId,
        proposal_path: proposalPath,
        destination: proposalId ? output.classification : null,
      });
      logger.info('feedback.reviewed', {
        feedback_id: r.feedback_id, classification: output.classification, proposal_id: proposalId,
        thread: thread.length,
      });
    }
  }

  return { classified, unclassified, skipped_reactions: reactions, calls };
};

const promptFile = (promptsDir) => path.join(promptsDir, 'feedback-review.md');

module.exports = {
  reviewFeedback, splitPrompt, validateProjectsFragment, OUTPUT_SCHEMA, promptFile, PROPOSAL_CLASSIFICATIONS,
  threadsOf, notesBlock,
};

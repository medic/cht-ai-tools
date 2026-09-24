'use strict';
// Structured-output schemas for the analysis pass and the roll-up, defined once in zod and exported as
// JSON Schema 2020-12 (schema/findings.schema.json and schema/brief.schema.json, by `npm run schema:build`). The
// model never emits
// URLs except reference_urls; identity, links and persistence are derived by code.
const { z } = require('zod');

const SCHEMA_BASE = 'https://github.com/medic/cht-ai-tools/packages/agent-watchdog/schema';

const TEXT = {
  referenceUrls: 'Each must have appeared in a tool result during this run and be on the host allow-list.',
  changes: 'Empty on pass 1. Later passes record every addition, removal or change with a reason (FR-056).',
  relatesTo: 'Optional. Another item of these findings that this one relates to, named by that item\'s metric '
    + 'because identities are derived by code. level_of and rate_of are two views of one quantity; same_cause and '
    + 'consequence_of are causal claims. The gate rejects a metric that is not another item here.',
  notSelectedReason: 'Required where the candidate\'s severity floor is medium or high; omit it for a low floor, '
    + 'where the id alone records that the candidate was examined.',
  findings: 'Structured output of an analysis pass. Identity, links and persistence are derived by code; '
    + 'the model never emits URLs except reference_urls that appeared in tool results.',
  threadOrder: 'Every accepted item id: the body items first, in the order of the bullets, then the rest highest '
    + 'rank first.',
  bullets: 'One per body item named in the Body layout section of the prompt, in that order (checked by the gate). '
    + 'A programme\'s own line is written by code.',
  bulletText: 'At most 2 lines of at most 120 characters; numbers must match evidence; no URLs.',
  headline: 'At most 2 lines of at most 120 characters; numbers must match the items\' evidence; no URLs.',
  replaceWith: 'Full new memory text within the cap, or null for no change; code stores the diff.',
  brief: 'Structured output of the roll-up call. Bullets reference items by id; the gate checks every number '
    + 'against computed data and every structural limit before publication.',
};

const WindowName = z.enum(['current', 'previous_day', 'previous_week', 'previous_cycle', 'trailing_14d']);
const Severity = z.enum(['low', 'medium', 'high']);

const itemKey = z.object({
  metric: z.string().describe('A metric key collected this run.'),
  pattern_card: z.string().nullable().describe('Card id from the merged index, or null.'),
}).strict().meta({ id: 'item_key' });

const evidence = z.object({
  window: WindowName,
  value: z.number().describe('Must equal a computed value for this metric and window.'),
  unit: z.string(),
  note: z.string().optional(),
}).strict().meta({ id: 'evidence' });

const item = z.object({
  item_key: itemKey,
  severity: Severity,
  evidence: z.array(evidence),
  why_now: z.string(),
  suggested_check: z.string(),
  relates_to: z.object({
    metric: z.string(),
    relation: z.enum(['level_of', 'rate_of', 'same_cause', 'consequence_of']),
  }).strict().nullable().optional().describe(TEXT.relatesTo),
  confidence: z.number().describe('0 to 1; range checked by the gate, not the schema.'),
  candidate_ids: z.array(z.string()),
  reference_urls: z.array(z.string()).describe(TEXT.referenceUrls),
}).strict().meta({ id: 'item' });

const findingsSchema = z.object({
  project_url: z.string().describe('Must equal the project this session was opened for.'),
  pass: z.number().int().describe('1-based pass number.'),
  items: z.array(item),
  not_selected: z.array(z.object({
    candidate_id: z.string(),
    reason: z.string().optional().describe(TEXT.notSelectedReason),
  }).strict()),
  changes: z.array(z.object({
    item_key: itemKey,
    change: z.enum(['added', 'removed', 'changed']),
    reason: z.string(),
  }).strict()).describe(TEXT.changes),
  converged: z.boolean().describe("The model's own view; code decides convergence from the diff (FR-057)."),
  notes: z.string().describe('Observations for the roll-up that are not items; may be empty.'),
}).strict().meta({
  title: 'agent-watchdog findings (one project, one pass)',
  description: TEXT.findings,
});

const briefSchema = z.object({
  headline: z.string().describe(TEXT.headline),
  bullets: z.array(z.object({
    item_id: z.string().describe('An accepted item id from this run.'),
    text: z.string().describe(TEXT.bulletText),
  }).strict()).describe(TEXT.bullets),
  thread_order: z.array(z.string()).describe(TEXT.threadOrder),
  expected_load_notice: z.string().nullable(),
  memory_update: z.object({
    replace_with: z.string().nullable().describe(TEXT.replaceWith),
  }).strict(),
  proposals: z.array(z.object({
    type: z.enum(['skill', 'prompt', 'threshold', 'pattern_card']),
    title: z.string(),
    body: z.string().describe('Pattern-level; identifiers are masked and flagged by code (FR-033).'),
  }).strict()),
}).strict().meta({
  title: 'agent-watchdog brief draft (roll-up output)',
  description: TEXT.brief,
});

const withId = (generated, name) => {
  const { $schema, ...rest } = generated;
  return { $schema, $id: `${SCHEMA_BASE}/${name}.schema.json`, ...rest };
};

const toJsonSchemas = () => ({
  findings: withId(z.toJSONSchema(findingsSchema, { target: 'draft-2020-12' }), 'findings'),
  brief: withId(z.toJSONSchema(briefSchema, { target: 'draft-2020-12' }), 'brief'),
});

/**
 * The schema as the Claude Code runtime accepts it (research.md R-2 addendum, S-4): its validator knows the draft-07
 * dialect only and refused `$schema` 2020-12 on the first hosted run. The copy drops `$schema` and `$id`, renames
 * `$defs` to `definitions` and rewrites every `$ref`; the committed files stay 2020-12 as the documented contract.
 */
const forStructuredOutput = (schema) => {
  const convert = (node) => {
    if (Array.isArray(node)) {
      return node.map(convert);
    }
    if (!node || typeof node !== 'object') {
      return node;
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema' || key === '$id') {
        continue;
      }
      if (key === '$ref' && typeof value === 'string') {
        out.$ref = value.replace(/^#\/\$defs\//, '#/definitions/');
      } else if (key === '$defs') {
        out.definitions = { ...(out.definitions || {}), ...convert(value) };
      } else if (key === 'definitions') {
        out.definitions = { ...(out.definitions || {}), ...convert(value) };
      } else {
        out[key] = convert(value);
      }
    }
    return out;
  };
  return convert(schema);
};

module.exports = { findingsSchema, briefSchema, toJsonSchemas, forStructuredOutput, WindowName, Severity };

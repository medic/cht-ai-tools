'use strict';
// Distillation (FR-035, FR-036, US6 scenarios 1 to 3): new or changed corpus items go to a bounded model call,
// one at a time, and come back as pattern cards in the fixed structure. Code scrubs identifiers, refuses cards
// that copy the source, decides identities, writes proposed cards for review and updates the index. Merged
// cards under skill/ are never touched (constitution VII).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const { PACKAGE_PATHS } = require('../config/schema');
const { fill, wrapUntrusted } = require('../agent/prompt-assembly');
const { maskNote, scrub } = require('./scrub');
const { slugify } = require('../rollup/proposals');
const { renderCardFile, parseCardFile, loadPatternCards, CARD_FIELDS } = require('./cards');
const { scanCorpus, writeIndex, DEFAULT_MAX_BYTES } = require('./index');
const { dataPaths } = require('../store/run-dir');
const atomic = require('../store/atomic');

const PROMPT_FILE = 'distill.md';
const ITEM_HEADING = '## Item';
const DEFAULT_ALLOWED_HOSTS = ['docs.communityhealthtoolkit.org', 'forum.communityhealthtoolkit.org', 'github.com'];
const DEFAULT_MAX_PROMPT_CHARS = 60000;
const VERBATIM_MIN_WORDS = 12;
const OUTCOMES_PREFIX = 'outcomes/';
const noop = { debug() {}, info() {}, warn() {}, error() {} };

const cardOutput = z.object({
  title: z.string(),
  symptom: z.string(),
  metrics: z.array(z.object({ metric: z.string(), shape: z.string() }).strict()),
  watchdog_appearance: z.string(),
  root_cause: z.string(),
  resolution: z.string(),
  confirmation_steps: z.array(z.string()),
  false_positives: z.array(z.string()),
  matches_existing: z.string().nullable(),
}).strict();
const CARDS_SCHEMA = z.object({ cards: z.array(cardOutput), notes: z.string() }).strict();
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(CARDS_SCHEMA, { target: 'draft-2020-12' });

/** The system prompt is everything above the item heading; the user turn is everything below it. */
const splitPrompt = (text) => {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex((line) => line.trim() === ITEM_HEADING);
  if (at === -1) {
    throw new Error(`prompts/${PROMPT_FILE} has no "${ITEM_HEADING}" heading; the item template is missing`);
  }
  return { system: lines.slice(0, at).join('\n').trim(), item: lines.slice(at + 1).join('\n').trim() };
};

const readPrompt = () => fs.readFileSync(path.join(PACKAGE_PATHS.promptsDir, PROMPT_FILE), 'utf8');

const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** The first run of `minWords` consecutive words of `text` that also occurs in `raw`, or null. */
const verbatimOverlap = (raw, text, minWords = VERBATIM_MIN_WORDS) => {
  const source = words(raw);
  const candidate = words(text);
  if (source.length < minWords || candidate.length < minWords) {
    return null;
  }
  const shingles = new Set();
  for (let i = 0; i + minWords <= source.length; i += 1) {
    shingles.add(source.slice(i, i + minWords).join(' '));
  }
  for (let i = 0; i + minWords <= candidate.length; i += 1) {
    const phrase = candidate.slice(i, i + minWords).join(' ');
    if (shingles.has(phrase)) {
      return phrase;
    }
  }
  return null;
};

/** Which index items a run processes: new ones, every readable one with `all`, or the named paths. */
const chooseItems = ({ index, all = false, items = [] }) => {
  const byPath = new Map((index.items || []).map((item) => [item.relative_path, item]));
  const skippedOf = (item) => ({ relative_path: item.relative_path, reason: item.skipped_reason || 'skipped' });
  if (items.length) {
    const chosen = [];
    const skipped = [];
    for (const relativePath of items) {
      const item = byPath.get(relativePath);
      if (!item) {
        skipped.push({ relative_path: relativePath, reason: 'not in corpus' });
      } else if (item.status === 'skipped') {
        skipped.push(skippedOf(item));
      } else {
        chosen.push(item);
      }
    }
    return { chosen, skipped };
  }
  const readable = (index.items || []).filter((item) => item.status !== 'skipped');
  return {
    chosen: all ? readable : readable.filter((item) => item.status === 'new'),
    skipped: (index.items || []).filter((item) => item.status === 'skipped').map(skippedOf),
  };
};

const textFields = (card) => [
  card.title, card.symptom, card.watchdog_appearance, card.root_cause, card.resolution,
  ...(card.confirmation_steps || []), ...(card.false_positives || []), ...(card.metrics || []).map((m) => m.shape),
];

const mergeFlags = (...lists) => {
  const seen = new Set();
  const out = [];
  for (const flag of lists.flat()) {
    const key = `${flag.kind}:${flag.excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(flag);
    }
  }
  return out;
};

/** Scrub every prose field of a model card; metric names are left alone, flags are collected. */
const scrubCard = (card, options) => {
  const flags = [];
  const clean = (text) => {
    const result = scrub(text, options);
    flags.push(...result.flags);
    return result.text;
  };
  const scrubbed = {
    title: clean(card.title),
    symptom: clean(card.symptom),
    metrics: card.metrics.map((m) => ({ metric: m.metric, shape: clean(m.shape) })),
    watchdog_appearance: clean(card.watchdog_appearance),
    root_cause: clean(card.root_cause),
    resolution: clean(card.resolution),
    confirmation_steps: card.confirmation_steps.map(clean),
    false_positives: card.false_positives.map(clean),
  };
  return { card: scrubbed, flags: mergeFlags(flags) };
};

const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

const extrasOf = (frontMatter) => Object.fromEntries(
  Object.entries(frontMatter || {}).filter(([key]) => !CARD_FIELDS.includes(key)),
);

/** Cards returned for one item that share a slug collapse into one before anything is written. */
const collapse = (cards) => {
  const bySlug = new Map();
  for (const card of cards) {
    const key = card.matches_existing || slugify(card.title);
    if (!bySlug.has(key)) {
      bySlug.set(key, { ...card });
      continue;
    }
    const kept = bySlug.get(key);
    kept.confirmation_steps = union(kept.confirmation_steps, card.confirmation_steps);
    kept.false_positives = union(kept.false_positives, card.false_positives);
  }
  return [...bySlug.values()];
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

const loadProposed = (dir) => {
  const byId = new Map();
  for (const card of loadPatternCards({ skillDir: null, dir }).all) {
    byId.set(card.card_id, card);
  }
  return byId;
};

const freeId = (slug, taken) => {
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = `${slug}-${n}`;
  }
  return candidate;
};

const itemFile = ({ item, rawDir, outcomesDir }) => (item.relative_path.startsWith(OUTCOMES_PREFIX)
  ? path.join(outcomesDir, item.relative_path.slice(OUTCOMES_PREFIX.length))
  : path.join(rawDir, item.relative_path));

const truncate = (text, maxChars) => (text.length <= maxChars
  ? text
  : `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters not shown]`);

/** Write a brand-new proposed card. */
const writeNewCard = async ({ cardId, scrubbed, flags, item, proposedDir, nowIso }) => {
  const record = { card_id: cardId, ...scrubbed.card, sources: [item.content_hash], status: 'proposed' };
  const file = path.join(proposedDir, `${cardId}.md`);
  await atomic.writeFileAtomic(file, renderCardFile(record, { created_at: nowIso, flags, source_kind: item.kind }));
  return { card_id: cardId, path: file, status: 'proposed', sources: record.sources, flags, updated: false };
};

/** Fold an item's additions into an existing proposed card: sources, steps and false positives grow, title stays. */
const updateProposedCard = async ({ existing, scrubbed, flags, item, nowIso }) => {
  const { frontMatter, card } = parseCardFile(fs.readFileSync(existing.path, 'utf8'));
  const merged = {
    ...card,
    sources: union(card.sources, [item.content_hash]),
    confirmation_steps: union(card.confirmation_steps, scrubbed.card.confirmation_steps),
    false_positives: union(card.false_positives, scrubbed.card.false_positives),
  };
  const extras = { ...extrasOf(frontMatter), flags: mergeFlags(frontMatter.flags || [], flags), updated_at: nowIso };
  await atomic.writeFileAtomic(existing.path, renderCardFile(merged, extras));
  return {
    card_id: merged.card_id, path: existing.path, status: 'proposed', sources: merged.sources, flags: extras.flags,
    updated: true,
  };
};

/**
 * Distil one item. Never throws for a model problem: the caller reads `distilled` and `rejected`.
 * @returns {Promise<object>} { processed, rejected, cards, usage, cost_usd, distilled }
 */
const distillItem = async ({
  item, rawDir, outcomesDir, engine, config, prompt, existing, proposedDir, now, maxPromptChars, allowedHosts,
  logger = noop,
}) => {
  const nowIso = now().toISOString();
  const rejected = [];
  const written = [];
  const cardIds = [];
  const matchesMerged = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let costUsd = 0;
  const outcome = (distilled) => ({
    processed: {
      relative_path: item.relative_path, content_hash: item.content_hash, kind: item.kind, cards: cardIds,
      matches_merged: matchesMerged,
    },
    rejected,
    cards: written,
    usage,
    cost_usd: costUsd,
    distilled,
  });
  const reject = (title, reason) => {
    rejected.push({ relative_path: item.relative_path, title, reason });
    logger.warn('distill.rejected', { relative_path: item.relative_path, title, reason });
  };

  const rawText = await fsp.readFile(itemFile({ item, rawDir, outcomesDir }), 'utf8');
  const existingLines = [
    ...[...existing.merged.values()].map((card) => `- ${card.card_id}: ${card.title}`),
    ...[...existing.proposed.values()].map((card) => `- ${card.card_id}: ${card.title}`),
  ];
  const userPrompt = fill(prompt.item, {
    kind: item.kind,
    relative_path: item.relative_path,
    existing_cards: existingLines.length ? existingLines.join('\n') : '- none yet',
    // People, addresses and phones masked before the model reads a corpus item (revision 36).
    content: wrapUntrusted('corpus-item', truncate(maskNote(rawText), maxPromptChars)),
  });

  let turn;
  try {
    turn = await engine.singleTurn({
      systemPrompt: [prompt.system],
      userPrompt,
      outputSchema: OUTPUT_JSON_SCHEMA,
      bounds: {
        maxTurns: config.bounds.maxTurns,
        maxBudgetUsd: config.bounds.maxBudgetUsdProject,
        timeoutMs: config.bounds.modelTimeoutMs,
      },
      model: config.model.distill || config.model.name,
      effort: config.model.effort,
      name: 'distill',
    });
  } catch (error) {
    reject(null, `model call failed: ${error.message}`);
    return outcome(false);
  }
  const result = (turn && turn.result) || {};
  addUsage(usage, normaliseUsage(result.usage));
  costUsd += result.total_cost_usd || 0;
  if (result.subtype !== 'success') {
    reject(null, `model result unusable (${result.subtype || 'no result'})`);
    return outcome(false);
  }
  const parsed = CARDS_SCHEMA.safeParse(turn.structuredOutput);
  if (!parsed.success) {
    reject(null, 'output failed the schema');
    return outcome(false);
  }

  const taken = new Set([...existing.merged.keys(), ...existing.proposed.keys()]);
  for (const card of collapse(parsed.data.cards)) {
    const overlap = verbatimOverlap(rawText, textFields(card).join('\n'));
    if (overlap) {
      reject(card.title, 'reproduces raw content');
      continue;
    }
    const scrubbed = scrubCard(card, { allowedHosts });
    const match = card.matches_existing;
    if (match && existing.merged.has(match)) {
      matchesMerged.push(match);
      continue;
    }
    const update = (target) => updateProposedCard({ existing: target, scrubbed, flags: scrubbed.flags, item, nowIso });
    let entry;
    if (match && existing.proposed.has(match)) {
      entry = await update(existing.proposed.get(match));
    } else {
      const slug = slugify(scrubbed.card.title);
      const same = existing.proposed.get(slug);
      // The item that produced a card updates it when processed again, as does a same-run duplicate; a different
      // item with the same title gets a suffixed id unless the model declared the match.
      const ownCard = same && (same.written_this_run || (same.sources || []).includes(item.content_hash));
      if (ownCard) {
        entry = await update(same);
      } else {
        const cardId = freeId(slug, taken);
        entry = await writeNewCard({ cardId, scrubbed, flags: scrubbed.flags, item, proposedDir, nowIso });
        taken.add(cardId);
        existing.proposed.set(cardId, {
          card_id: cardId, title: scrubbed.card.title, path: entry.path, sources: entry.sources, written_this_run: true,
        });
      }
    }
    if (existing.proposed.has(entry.card_id)) {
      existing.proposed.get(entry.card_id).sources = entry.sources;
    }
    written.push(entry);
    if (!cardIds.includes(entry.card_id)) {
      cardIds.push(entry.card_id);
    }
  }
  const distilled = parsed.data.cards.length === 0 || cardIds.length > 0 || matchesMerged.length > 0;
  logger.info('distill.item', {
    relative_path: item.relative_path, kind: item.kind, cards: cardIds, matches_merged: matchesMerged,
    rejected: rejected.length, distilled, cost_usd: costUsd,
  });
  return outcome(distilled);
};

/**
 * Run distillation over the corpus.
 * @returns {Promise<object>} the distillation report (contracts/cli.md "distill")
 */
const distill = async ({
  dataDir, rawDir, engine, config, cards = { merged: [], index: [] }, all = false, items = [], now = () => new Date(),
  logger = null, maxBytes = DEFAULT_MAX_BYTES, maxPromptChars = DEFAULT_MAX_PROMPT_CHARS, promptText = null,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
}) => {
  const log = logger || noop;
  const paths = dataPaths(dataDir);
  await fsp.mkdir(paths.corpus, { recursive: true });
  const prompt = splitPrompt(promptText || readPrompt());
  const { index } = await scanCorpus({
    rawDir, outcomesDir: paths.corpusOutcomes, indexPath: paths.corpusIndex, now, maxBytes,
  });
  const { chosen, skipped } = chooseItems({ index, all, items });
  const existing = {
    merged: new Map((cards.merged || []).map((card) => [card.card_id, card])),
    proposed: loadProposed(paths.corpusCardsProposed),
  };
  const report = {
    processed: [],
    skipped,
    rejected: [],
    cards: [],
    cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    index_path: paths.corpusIndex,
  };
  const byPath = new Map(index.items.map((item) => [item.relative_path, item]));
  for (const item of chosen) {
    const out = await distillItem({
      item, rawDir, outcomesDir: paths.corpusOutcomes, engine, config, prompt, existing,
      proposedDir: paths.corpusCardsProposed, now, maxPromptChars, allowedHosts, logger: log,
    });
    report.rejected.push(...out.rejected);
    report.cards.push(...out.cards);
    report.cost_usd = Number((report.cost_usd + out.cost_usd).toFixed(6));
    addUsage(report.usage, out.usage);
    if (out.distilled) {
      report.processed.push(out.processed);
      const record = byPath.get(item.relative_path);
      record.status = 'distilled';
      record.distilled_at = now().toISOString();
      record.card_ids = union(record.card_ids, out.processed.cards);
    }
  }
  await writeIndex(paths.corpusIndex, { ...index, updated_at: now().toISOString() });
  log.info('distill.summary', {
    processed: report.processed.length, skipped: report.skipped.length, rejected: report.rejected.length,
    cards: report.cards.length, cost_usd: report.cost_usd,
  });
  return report;
};

module.exports = {
  distill, distillItem, chooseItems, verbatimOverlap, splitPrompt, scrubCard, collapse, CARDS_SCHEMA,
  OUTPUT_JSON_SCHEMA, DEFAULT_ALLOWED_HOSTS, DEFAULT_MAX_PROMPT_CHARS, VERBATIM_MIN_WORDS, ITEM_HEADING, PROMPT_FILE,
};

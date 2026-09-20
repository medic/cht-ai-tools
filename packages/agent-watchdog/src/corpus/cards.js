'use strict';
// Pattern-card files (data-model.md "Pattern Card", FR-035, FR-036, FR-038): YAML front matter holding the
// structured card plus a Markdown body rendered from it for reviewers. Merged cards live under
// skill/cht-watchdog/pattern-cards/<card_id>.md; proposed ones under <data>/corpus/cards.proposed/. The daily
// analysis sees only the one-line index; a full card is read through the read_pattern_card tool.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { schemas } = require('../model/schemas');

const CARD_SECTIONS = [
  'Symptom', 'Metrics and shape', 'In the watchdog', 'Root cause', 'Resolution', 'Confirmation steps',
  'Known false positives', 'Sources',
];
const CARD_FIELDS = [
  'card_id', 'title', 'symptom', 'metrics', 'watchdog_appearance', 'root_cause', 'resolution', 'confirmation_steps',
  'false_positives', 'sources', 'status',
];
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const INDEX_HEADER = [
  '# Pattern cards',
  '',
  'Merged, reviewed descriptions of recurring watchdog patterns. Read a full card with the',
  '`read_pattern_card` tool only when an item matches its symptom.',
  '',
].join('\n');

const list = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none recorded');

/** The reviewer-facing body: every fixed section, in order, from the structured fields. */
const renderBody = (card) => [
  `# ${card.title}`,
  '',
  `## ${CARD_SECTIONS[0]}`, '', card.symptom, '',
  `## ${CARD_SECTIONS[1]}`, '', list(card.metrics.map((m) => `\`${m.metric}\`: ${m.shape}`)), '',
  `## ${CARD_SECTIONS[2]}`, '', card.watchdog_appearance, '',
  `## ${CARD_SECTIONS[3]}`, '', card.root_cause, '',
  `## ${CARD_SECTIONS[4]}`, '', card.resolution, '',
  `## ${CARD_SECTIONS[5]}`, '', list(card.confirmation_steps), '',
  `## ${CARD_SECTIONS[6]}`, '', list(card.false_positives), '',
  `## ${CARD_SECTIONS[7]}`, '', list(card.sources.map((hash) => `content hash ${hash}`)), '',
].join('\n');

/**
 * @param {object} card a Pattern Card (validated here)
 * @param {object} [extra] front-matter-only fields for reviewers (created_at, flags, ...)
 */
const renderCardFile = (card, extra = {}) => {
  const valid = schemas.PatternCard.parse(card);
  const frontMatter = YAML.stringify({ ...valid, ...extra }, { lineWidth: 0 });
  return `---\n${frontMatter}---\n\n${renderBody(valid)}`;
};

/** @returns {{ frontMatter: object, card: object, body: string }} */
const parseCardFile = (text) => {
  const match = FRONT_MATTER.exec(String(text));
  if (!match) {
    throw new Error('pattern card file has no YAML front matter');
  }
  const frontMatter = YAML.parse(match[1], { schema: 'core' }) || {};
  const card = schemas.PatternCard.parse(Object.fromEntries(CARD_FIELDS.map((key) => [key, frontMatter[key]])));
  return { frontMatter, card, body: match[2] };
};

const firstSentence = (text) => {
  const trimmed = String(text || '').trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
};

/** One line per merged card: id, title, the symptom's first sentence and the metrics involved. */
const indexLine = (card) => {
  const metrics = card.metrics.map((m) => m.metric).join(', ');
  return `- ${card.card_id}: ${card.title}. ${firstSentence(card.symptom)} (metrics: ${metrics})`;
};

const buildIndex = (cards) => {
  const merged = cards.filter((card) => card.status === 'merged').sort((a, b) => a.card_id.localeCompare(b.card_id));
  const lines = merged.length ? merged.map(indexLine) : ['No merged cards yet.'];
  return `${INDEX_HEADER}\n${lines.join('\n')}\n`;
};

const baseMetric = (metric) => String(metric).replace(/\{.*$/, '').replace(/^.*\(/, '').trim();

/**
 * Load the pattern cards of a skill directory.
 * @returns {{ all, merged, index: string[], get, byMetric, read }}
 */
const loadPatternCards = ({ skillDir, dir = path.join(skillDir, 'pattern-cards') }) => {
  const all = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'index.md').sort();
    for (const name of files) {
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      const parsed = parseCardFile(text);
      all.push({ ...parsed.card, path: file, text, front_matter: parsed.frontMatter });
    }
  }
  const merged = all.filter((card) => card.status === 'merged');
  const byId = new Map(merged.map((card) => [card.card_id, card]));
  return {
    all,
    merged,
    index: merged.map((card) => card.card_id),
    get: (cardId) => byId.get(cardId) || null,
    byMetric: (metric) => merged.filter((card) => card.metrics.some((m) => (
      baseMetric(m.metric) === baseMetric(metric)
    ))),
    read: async (cardId) => (byId.has(cardId) ? byId.get(cardId).text : ''),
  };
};

module.exports = {
  renderCardFile, parseCardFile, loadPatternCards, indexLine, buildIndex, firstSentence, baseMetric, CARD_SECTIONS,
  CARD_FIELDS,
};

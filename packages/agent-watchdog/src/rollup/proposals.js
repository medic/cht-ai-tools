'use strict';
// Proposals for human review (FR-032, FR-033): skill, prompt, threshold and pattern-card suggestions written as
// Markdown files with YAML front matter under <data>/proposals/ (durable) and copied into the run directory.
// Bodies are scrubbed of identifiers, which are listed as flags for the reviewer; nothing under prompts/, skill/,
// schema/, agent/ or the policy files is ever touched (constitution VII).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const atomic = require('../store/atomic');
const { dataPaths } = require('../store/run-dir');
const { schemas } = require('../model/schemas');
const { scrub } = require('../corpus/scrub');

const TYPES = ['skill', 'prompt', 'threshold', 'pattern_card', 'project_annotation'];
const SLUG_MAX = 60;
const YAML_OPTIONS = { schema: 'core' };

const slugify = (title) => {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'proposal';
};

const dateOf = (proposalId) => String(proposalId).slice(0, 10);

const renderProposalFile = (frontMatter, body) => `---\n${YAML.stringify(frontMatter, YAML_OPTIONS)}---\n\n${body}\n`;

/** Split a proposal file into its front matter and body; a file without front matter is all body. */
const parseProposalFile = (text) => {
  const source = String(text || '');
  if (!source.startsWith('---\n')) {
    return { frontMatter: {}, body: source.replace(/\n$/, '') };
  }
  const close = source.indexOf('\n---\n', 4);
  if (close === -1) {
    return { frontMatter: {}, body: source };
  }
  const frontMatter = YAML.parse(source.slice(4, close + 1), YAML_OPTIONS) || {};
  const body = source.slice(close + 5).replace(/^\n/, '').replace(/\n$/, '');
  return { frontMatter, body };
};

/** Every proposal on the data volume, front matter fields flattened, sorted by id. */
const readProposals = async (dataDir) => {
  const dir = dataPaths(dataDir).proposals;
  if (!fs.existsSync(dir)) {
    return [];
  }
  const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  const proposals = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const { frontMatter, body } = parseProposalFile(await fsp.readFile(file, 'utf8'));
    proposals.push({ ...frontMatter, body, path: file });
  }
  return proposals.sort((a, b) => String(a.proposal_id).localeCompare(String(b.proposal_id)));
};

const mergeFlags = (...lists) => {
  const seen = new Set();
  const flags = [];
  for (const flag of lists.flat()) {
    const key = `${flag.kind}:${flag.excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      flags.push(flag);
    }
  }
  return flags;
};

const noop = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Write proposals for review.
 * @param {object} options
 * @param {string} options.dataDir
 * @param {import('../store/run-dir').RunDir} [options.runDir] receives a copy under proposals/
 * @param {string} options.runId
 * @param {string} options.date
 * @param {Array<{ type: string, title: string, body: string, evidence?: object[] }>} options.proposals
 * @param {string[]} [options.hosts] discovered hosts to mask
 * @param {string[]} [options.persons] feedback authors and owners to mask
 * @param {string[]} [options.allowedHosts] hosts that are not project identifiers
 * @returns {Promise<{ written: object[], superseded: string[] }>}
 */
const writeProposals = async ({
  dataDir, runDir = null, runId, date, proposals = [], hosts = [], persons = [], allowedHosts = [],
  now = () => new Date(), logger = null,
}) => {
  const log = logger || noop;
  const dir = dataPaths(dataDir).proposals;
  await fsp.mkdir(dir, { recursive: true });
  const existing = await readProposals(dataDir);
  const taken = new Set(existing.map((p) => p.proposal_id));
  const written = [];
  const superseded = [];
  const scrubOptions = { hosts, persons, allowedHosts };

  for (const proposal of proposals || []) {
    const type = proposal && proposal.type;
    if (!TYPES.includes(type)) {
      log.warn('proposals.skipped', { type: type === undefined ? null : type, reason: 'unknown type' });
      continue;
    }
    const title = scrub(proposal.title, scrubOptions);
    const body = scrub(proposal.body, scrubOptions);
    // Evidence is structured, reviewer-facing data: identifiers in it are flagged but kept, because a threshold
    // proposal is useless without the project it concerns (FR-033 asks for the flag). Evidence that holds a
    // secret is dropped altogether; secrets never reach the data volume.
    const evidenceIn = Array.isArray(proposal.evidence) ? proposal.evidence : [];
    const evidenceScan = scrub(JSON.stringify(evidenceIn), scrubOptions);
    const leaksSecret = evidenceScan.flags.some((flag) => flag.kind === 'secret');
    if (leaksSecret) {
      log.warn('proposals.evidence_dropped', { type, reason: 'secret pattern in evidence' });
    }
    const flags = mergeFlags(title.flags, body.flags, evidenceScan.flags);
    const slug = slugify(title.text);
    let proposalId = `${date}-${type}-${slug}`;
    for (let n = 2; taken.has(proposalId); n += 1) {
      proposalId = `${date}-${type}-${slug}-${n}`;
    }
    taken.add(proposalId);
    const record = schemas.Proposal.parse({
      proposal_id: proposalId,
      type,
      run_id: runId,
      title: title.text,
      body: body.text,
      evidence: leaksSecret ? [] : evidenceIn,
      flags,
      status: 'proposed',
    });

    for (const old of existing) {
      const earlier = old.type === type && old.status === 'proposed' && slugify(old.title) === slug
        && dateOf(old.proposal_id) < date;
      if (earlier) {
        const { body: oldBody, path: oldPath, ...frontMatter } = old;
        frontMatter.status = 'superseded';
        frontMatter.superseded_by = proposalId;
        await atomic.writeFileAtomic(oldPath, renderProposalFile(frontMatter, oldBody));
        old.status = 'superseded';
        superseded.push(old.proposal_id);
      }
    }

    const frontMatter = {
      proposal_id: proposalId,
      type,
      run_id: runId,
      title: record.title,
      status: 'proposed',
      created_at: now().toISOString(),
      flags,
      evidence: record.evidence,
    };
    const text = renderProposalFile(frontMatter, record.body);
    const file = path.join(dir, `${proposalId}.md`);
    await atomic.writeFileAtomic(file, text);
    let runPath = null;
    if (runDir) {
      await runDir.writeText(path.join('proposals', `${proposalId}.md`), text);
      runPath = runDir.path('proposals', `${proposalId}.md`);
    }
    written.push({ proposal_id: proposalId, type, path: file, run_path: runPath, flags });
    log.info('proposals.written', { proposal_id: proposalId, type, flags: flags.length });
  }
  return { written, superseded };
};

module.exports = { writeProposals, readProposals, parseProposalFile, renderProposalFile, slugify, TYPES };

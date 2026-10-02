'use strict';
// The corpus index (FR-034, FR-035, FR-037; data-model.md "Corpus Item"): one record per raw file and per run-outcome
// file, identified by content hash so distillation processes only new or changed items. The index holds metadata
// only, never content, because it may live in the public repository while the raw material does not.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const atomic = require('../store/atomic');
const { schemas } = require('../model/schemas');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SAMPLE_BYTES = 8192;
const CHAT_SAMPLE_LINES = 12;
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tgz', 'tar', '7z', 'xlsx', 'xls', 'docx',
  'doc', 'pptx', 'ppt', 'bin', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov', 'avi',
]);
const EXPORT_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xlsx', 'xls']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown']);
// A chat line: a bracketed time, a Slack mention, or a short capitalised speaker label followed by a colon.
const CHAT_LINE = /^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|<@U[A-Z0-9]+>|[A-Z][\w .'()-]{0,40}:\s)/;

const extensionOf = (name) => {
  const base = path.posix.basename(String(name)).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
};

const chatLike = (sample) => {
  const lines = String(sample || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, CHAT_SAMPLE_LINES);
  const matches = lines.filter((line) => CHAT_LINE.test(line)).length;
  return matches >= 2;
};

/**
 * Classify a corpus item by where it sits, what it is called and, for plain text, what it looks like.
 * @param {string} relativePath POSIX path relative to the raw directory
 * @param {string} sample the first bytes of the file as text
 * @param {object} [options] { outcome: true } for files read from corpus/outcomes/
 */
const classifyKind = (relativePath, sample, { outcome = false } = {}) => {
  if (outcome) {
    return 'run_outcome';
  }
  const lower = String(relativePath).replace(/\\/g, '/').toLowerCase();
  const segments = lower.split('/');
  const directories = segments.slice(0, -1);
  const ext = extensionOf(lower);
  if (directories.includes('conversations')) {
    return 'conversation';
  }
  if (directories.includes('exports') || EXPORT_EXTENSIONS.has(ext)) {
    return 'export';
  }
  if (lower.includes('incident') || lower.includes('postmortem')) {
    return 'incident';
  }
  if (lower.includes('explainer') || lower.includes('readme')) {
    return 'explainer';
  }
  if (TEXT_EXTENSIONS.has(ext) && chatLike(sample)) {
    return 'conversation';
  }
  return 'unknown';
};

/** Binary by a known extension or a NUL byte in the sample. */
const isBinary = (sample, name = '') => BINARY_EXTENSIONS.has(extensionOf(name)) || Buffer.from(sample).includes(0);

const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
});

const readSample = async (file, bytes = SAMPLE_BYTES) => {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const walk = async (dir, root = dir) => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(full, root));
    } else if (entry.isFile()) {
      out.push({ file: full, relative_path: path.relative(root, full).split(path.sep).join('/') });
    }
  }
  return out;
};

const emptyIndex = () => ({ version: 1, updated_at: null, items: [] });

const readIndex = async (indexPath) => (fs.existsSync(indexPath) ? atomic.readJson(indexPath) : emptyIndex());

const writeIndex = (indexPath, index) => atomic.writeJsonAtomic(indexPath, index);

/**
 * Scan the raw corpus and the run outcomes, reconcile with the stored index and write it back.
 * @returns {Promise<{ index: object, changes: object }>} the written index and the relative paths that were
 *   added, changed, unchanged or removed since the previous scan
 */
const scanCorpus = async ({
  rawDir, outcomesDir = null, indexPath, now = () => new Date(), maxBytes = DEFAULT_MAX_BYTES,
}) => {
  const previous = await readIndex(indexPath);
  const previousByPath = new Map((previous.items || []).map((item) => [item.relative_path, item]));
  const sources = (await walk(rawDir)).map((entry) => ({ ...entry, outcome: false }));
  if (outcomesDir && fs.existsSync(outcomesDir)) {
    const names = (await fsp.readdir(outcomesDir)).filter((name) => name.endsWith('.jsonl')).sort();
    for (const name of names) {
      sources.push({ file: path.join(outcomesDir, name), relative_path: `outcomes/${name}`, outcome: true });
    }
  }

  const changes = { added: [], changed: [], unchanged: [], removed: [] };
  const seen = new Set();
  const items = [];
  for (const source of sources) {
    const stat = await fsp.stat(source.file);
    const sample = await readSample(source.file);
    const contentHash = await hashFile(source.file);
    const binary = isBinary(sample, source.relative_path);
    const tooLarge = stat.size > maxBytes;
    const prior = previousByPath.get(source.relative_path);
    const item = {
      relative_path: source.relative_path,
      content_hash: contentHash,
      size_bytes: stat.size,
      kind: classifyKind(source.relative_path, sample.toString('utf8'), { outcome: source.outcome }),
      status: 'new',
      skipped_reason: null,
      distilled_at: null,
      card_ids: [],
    };
    if (binary || tooLarge) {
      item.status = 'skipped';
      item.skipped_reason = binary ? 'binary' : 'too_large';
    } else if (prior && prior.content_hash === contentHash && prior.status !== 'skipped') {
      item.status = prior.status;
      item.distilled_at = prior.distilled_at || null;
      item.card_ids = [...(prior.card_ids || [])];
    }
    if (!prior) {
      changes.added.push(source.relative_path);
    } else if (prior.content_hash !== contentHash) {
      changes.changed.push(source.relative_path);
    } else {
      changes.unchanged.push(source.relative_path);
    }
    seen.add(source.relative_path);
    items.push(schemas.CorpusItem.parse(item));
  }
  changes.removed = [...previousByPath.keys()].filter((relativePath) => !seen.has(relativePath)).sort();
  items.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const index = { version: 1, updated_at: now().toISOString(), items };
  await writeIndex(indexPath, index);
  return { index, changes };
};

module.exports = {
  scanCorpus, readIndex, writeIndex, classifyKind, isBinary, hashFile, chatLike, extensionOf, DEFAULT_MAX_BYTES,
  SAMPLE_BYTES,
};

'use strict';
// Secret and personal-data scan (SC-010): the gate's patterns (src/verify/patterns.js) applied to files rather than
// to a model document. Two modes: the repository (secrets and e-mail addresses; phone patterns are noise in code)
// and a run's artefacts (secrets, e-mail addresses and phone numbers). Findings never include the matched value.
const fs = require('node:fs');
const path = require('node:path');
const { SECRET_PATTERNS, EMAIL_PATTERN, phoneMatches } = require('./patterns');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', '.nyc_output', '.data', 'runs', 'runs-replay', 'knowledge-corpus',
  '.design-scratch',
]);
// Lock files carry package author addresses, not this project's data.
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
// An operator's own environment file (`.env`, `.env.local`) is ignored by git and never part of the repository; the
// committed `.env.example` is scanned like any other file.
const isLocalEnvFile = (name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.gz', '.zip', '.pdf', '.ico', '.woff', '.woff2']);
// A line that deliberately holds a sample value (a test fixture) says so, visibly to reviewers.
const ALLOW_MARKER = /scan-secrets:\s*allow/;
const MAX_BYTES = 4 * 1024 * 1024;
// A credential-shaped token shorter than this, or ending in a placeholder word, is a test value such as xoxb-test.
const MIN_SECRET_LENGTH = 24;
const PLACEHOLDER = /(test|example|placeholder|fake|dummy|replay-eval|smoke)$/i;
const EXAMPLE_DOMAIN = /@(?:[a-z0-9-]+\.)*example\.(?:org|com|net|invalid)$/i;
const HEX_ID = /^[0-9a-f]{12,64}$/;
// Files that hold text the model was given rather than text the run wrote: a documentation result may carry an
// address or a build timestamp of its own, and quoting it into a post is blocked by the gate, not by deleting the
// record of what was read (FR-016, revision 19).
const REFERENCE_FILES = Object.freeze(new Set(['tool-calls.jsonl']));
const DECIMAL = /^\d+(\.\d+)?$/;

const globalOf = (pattern) => (pattern.flags.includes('g')
  ? pattern
  : new RegExp(pattern.source, `${pattern.flags}g`));

const mask = (token) => `${token.slice(0, 6)}…(${token.length} chars)`;

/** Secret-shaped tokens in a text, with test placeholders left out. */
const secretFindings = (text) => {
  const out = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(globalOf(pattern))) {
      const token = match[0];
      if (token.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(token)) {
        continue;
      }
      out.push({ pattern: name, excerpt: mask(token) });
    }
  }
  return out;
};

/** E-mail addresses outside example domains and, when asked, phone numbers with separators and nine or more digits. */
const personalFindings = (text, { phones = false } = {}) => {
  const out = [];
  for (const match of text.matchAll(globalOf(EMAIL_PATTERN))) {
    if (!EXAMPLE_DOMAIN.test(match[0])) {
      out.push({ pattern: 'email', excerpt: mask(match[0]) });
    }
  }
  if (phones) {
    for (const token of phoneMatches(text)) {
      const separated = /[\s()+-]/.test(token);
      if (separated && !HEX_ID.test(token) && !DECIMAL.test(token)) {
        out.push({ pattern: 'phone', excerpt: mask(token) });
      }
    }
  }
  return out;
};

/** Findings in a text, each with the 1-based line it sits on. */
const scanText = (text, { phones = false } = {}) => {
  const findings = [];
  String(text).split('\n').forEach((line, index) => {
    if (ALLOW_MARKER.test(line)) {
      return;
    }
    for (const finding of [...secretFindings(line), ...personalFindings(line, { phones })]) {
      findings.push({ line: index + 1, ...finding });
    }
  });
  return findings;
};

const looksBinary = (buffer) => buffer.subarray(0, 512).includes(0);

const scanFile = (file, options = {}) => {
  const name = path.basename(file);
  if (SKIP_FILES.has(name) || isLocalEnvFile(name) || BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return [];
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) {
    return [];
  }
  const buffer = fs.readFileSync(file);
  if (looksBinary(buffer)) {
    return [];
  }
  return scanText(buffer.toString('utf8'), options);
};

/** Every finding under a directory, with paths relative to it. */
/** True when a run-directory path holds reference text the model was given rather than the run's own output. */
const isReferenceFile = (relative) => REFERENCE_FILES.has(String(relative).split('/').pop());

const scanTree = (root, { phones = false, skipDirs = SKIP_DIRS } = {}) => {
  const findings = [];
  const visit = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          visit(full);
        }
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      for (const finding of scanFile(full, { phones })) {
        findings.push({ file: rel, ...finding, reference: isReferenceFile(rel) });
      }
    }
  };
  if (fs.existsSync(root)) {
    visit(root);
  }
  return findings;
};

/** The repository: secrets and e-mail addresses in every text file outside the ignored directories. */
const scanRepository = (root) => scanTree(root, { phones: false });

/** A run directory (or a whole data volume): secrets, e-mail addresses and phone numbers in every artefact. */
const scanRunArtefacts = (root) => scanTree(root, { phones: true, skipDirs: new Set(['knowledge-corpus']) });

module.exports = {
  scanText, scanFile, scanTree, scanRepository, scanRunArtefacts, secretFindings, personalFindings, MIN_SECRET_LENGTH,
  SKIP_DIRS, SKIP_FILES, ALLOW_MARKER, REFERENCE_FILES, isReferenceFile,
};

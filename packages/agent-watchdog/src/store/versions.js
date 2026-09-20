'use strict';
// The versions stamped into every run record (data-model.md "Run", US3 scenario 4, FR-039): package, git sha,
// and hashes of the prompts, skill, schemas and policy files that produced the run.
const childProcess = require('node:child_process');

const NULL_HASHES = Object.freeze({ prompts_hash: null, skill_hash: null, schema_hash: null });

/** Short git sha of the working tree, or null when git or a repository is unavailable. */
const resolveGitSha = ({ execFile = childProcess.execFileSync, cwd = process.cwd() } = {}) => {
  try {
    const out = execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = out.toString().trim();
    return sha || null;
  } catch {
    return null;
  }
};

/** Hashes of the agent definition on disk; nulls when it cannot be loaded (a missing directory, say). */
const definitionHashes = ({ config, env = process.env, loadDefinition = null }) => {
  try {
    const load = loadDefinition || require('../agent/definition').loadDefinition;
    return { ...NULL_HASHES, ...load({ paths: config.paths, env, config }).hashes };
  } catch {
    return { ...NULL_HASHES };
  }
};

/**
 * @param {object} options
 * @param {{ version: string }} options.pkg package.json
 * @param {object} options.config configuration (paths)
 * @param {object} [options.env]
 * @param {{ hash: string }|null} options.policy loaded policy files
 * @param {object} [options.deps] test seams: gitSha, definitionHashes
 */
const collectVersions = ({ pkg, config, env = process.env, policy = null, deps = {} }) => ({
  package: pkg.version,
  git_sha: deps.gitSha !== undefined ? deps.gitSha : resolveGitSha(deps),
  ...(deps.definitionHashes || definitionHashes({ config, env })),
  config_hash: policy && policy.hash ? policy.hash : null,
});

module.exports = { collectVersions, resolveGitSha, definitionHashes, NULL_HASHES };

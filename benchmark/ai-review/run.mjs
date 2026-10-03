#!/usr/bin/env node
/**
 * Runs the two review jobs of the cht-core ai-review workflow against PRs, in a container, and saves their raw output
 * instead of posting it to the PR.
 *
 * Usage: node benchmark/ai-review/run.mjs <owner/repo#pr>...
 *
 * Requires docker, git, ANTHROPIC_API_KEY and GITHUB_TOKEN.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = resolve(HERE, '../..');
const OUT_ROOT = join(TOOLS_ROOT, 'bench-results');

// Config copied from https://github.com/medic/cht-core/blob/master/.github/workflows/ai-review.yml
const OCR_ENV = {
  OCR_LLM_MODEL: 'claude-sonnet-5',
  OCR_EXTRA_BODY: '{"output_config": {"effort": "xhigh"}}',
};
const OCR_EFFORT = 'medium';
const claudePrompt = (repo, pr) => `Use the cht-pr-review skill to review pull request
${pr} in ${repo}.
Follow that skill exactly.

Return the skill's report verbatim as \`report_markdown\`. If the skill concludes the PR's intent could not
be established, return that as the report; an inconclusive report is still the result.
`;
const CLAUDE_ARGS = [
  '--model', 'claude-opus-5',
  '--permission-mode', 'default',
  '--setting-sources', 'user',
  '--allowedTools', 'Skill,Grep,Glob,Bash(/opt/cht-ai-tools/skills/cht-pr-review/scripts/pr-context.sh*),Bash(/opt/cht-ai-tools/skills/cht-pr-review/scripts/pr-diff.sh*),mcp__plugin_cht-docs-mcp_cht-docs__ask_question,mcp__plugin_cht-docs-mcp_cht-docs__search_docs',
  '--disallowedTools', 'Edit,Write,NotebookEdit,Monitor,PowerShell,WebFetch,WebSearch',
  '--json-schema', '{"type":"object","required":["report_markdown"],"additionalProperties":false,"properties":{"report_markdown":{"type":"string","description":"The complete review report as GitHub-flavored markdown."}}}',
];

// The rest of the OCR config is set in the Dockerfile
const OCR_SCRIPT = `
set -eo pipefail
ocr config set llm.model "$OCR_LLM_MODEL"
ocr config set llm.extra_body "$OCR_EXTRA_BODY"
exec ocr review --timeout "$OCR_TASK_TIMEOUT" "$@" > /out/ocr-result.json 2> /out/ocr-stderr.log
`;

// The image already has the workflow's settings and plugins (see the Dockerfile)
const CLAUDE_SCRIPT = `
exec claude -p "$CLAUDE_PROMPT" --output-format stream-json --verbose "$@" > /out/execution.jsonl 2> /out/claude-stderr.log
`;

const IMAGE = 'cht-ai-review-bench';
const RUNNER_WORKSPACE = '/home/runner/work/workspace';

const sh = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })?.trim();
const git = (cwd, ...args) => sh('git', args, { cwd });

// Built from the repo root so the image installs the plugins from this checkout. Docker's layer cache makes this quick,
// and rebuilds from the plugin COPY onward when the skill has changed.
const buildImage = () => sh('docker', ['build', '-t', IMAGE,
  '--build-arg', `UID=${process.getuid()}`,
  '--build-arg', `GID=${process.getgid()}`,
  '-f', join(HERE, 'Dockerfile'), TOOLS_ROOT], { stdio: 'inherit' });

/**
 * Bare repo per repo, reused across runs, so each PR checkout is a cheap local clone. `init` is a no-op on an existing
 * repo, so an interrupted first fetch just resumes next time.
 */
const repoCache = (repo, pr) => {
  const dir = join(OUT_ROOT, '.cache', `${repo.replace('/', '__')}.git`);
  sh('git', ['init', '--quiet', '--bare', dir]);
  sh('git', ['-C', dir, 'fetch', `https://github.com/${repo}.git`,
    `+refs/pull/${pr}/head:refs/pull/${pr}/head`, '+refs/heads/*:refs/heads/*'], { stdio: 'inherit' });
  return dir;
};

const checkout = (cacheDir, repo, dir, sha) => {
  rmSync(dir, { recursive: true, force: true });
  sh('git', ['clone', '--quiet', '--no-checkout', cacheDir, dir]);
  git(dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`); // gh resolves the repo from origin
  git(dir, 'checkout', '--quiet', '--detach', sha);
};

const runContainer = ({ workspace, outDir, env, script, args }) => new Promise((resolvePromise, reject) => {
  spawn('docker', [
    'run', '--rm', '--init',
    '-v', `${workspace}:${RUNNER_WORKSPACE}:z`,
    '-v', `${outDir}:/out:z`,
    '-w', RUNNER_WORKSPACE,
    ...Object.keys(env).flatMap(k => ['-e', k]), // values come from our env, keeping secrets off the command line
    IMAGE, 'bash', '-c', script, 'bash', ...args,
  ], { stdio: 'inherit', env: { ...process.env, ...env } })
    .on('error', reject)
    .on('close', resolvePromise);
});

const getPull = async (repo, number) => {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`Fetching ${repo}#${number} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
};

const codeReview = async ({ repo, pull, cacheDir, outDir }) => {
  const workspace = join(outDir, 'workspace');
  // pull_request_target checks out the tip of the base branch (so its .opencodereview rules apply), and OCR reviews
  // from the merge-base to the PR head
  const baseSha = git(cacheDir, 'rev-parse', `refs/heads/${pull.base.ref}`);
  checkout(cacheDir, repo, workspace, baseSha);
  const mergeBase = git(workspace, 'merge-base', baseSha, pull.head.sha);
  const status = await runContainer({
    workspace,
    outDir,
    env: { ...OCR_ENV, OCR_LLM_TOKEN: process.env.ANTHROPIC_API_KEY },
    script: OCR_SCRIPT,
    args: ['--from', mergeBase, '--to', pull.head.sha, '--audience', 'agent', '--format', 'json',
      '--background', pull.title, '--effort', OCR_EFFORT],
  });
  rmSync(workspace, { recursive: true, force: true });
  return status;
};

const completenessReview = async ({ repo, pull, cacheDir, outDir }) => {
  const workspace = join(outDir, 'workspace');
  checkout(cacheDir, repo, workspace, pull.head.sha);
  const status = await runContainer({
    workspace,
    outDir,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GH_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      CLAUDE_CODE_ENTRYPOINT: 'claude-code-github-action',
      CLAUDE_PROMPT: claudePrompt(repo, pull.number),
    },
    script: CLAUDE_SCRIPT,
    args: CLAUDE_ARGS,
  });
  rmSync(workspace, { recursive: true, force: true });

  // Missing if the container failed to start; the last line may be cut off if Claude was killed
  const executionFile = join(outDir, 'execution.jsonl');
  const lines = existsSync(executionFile) ? readFileSync(executionFile, 'utf8').split('\n').filter(Boolean) : [];
  const result = lines
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .findLast(m => m.type === 'result');
  if (result?.structured_output?.report_markdown) {
    writeFileSync(join(outDir, 'report.md'), `${result.structured_output.report_markdown}\n`);
  }
  return status;
};

const main = async () => {
  const prs = process.argv.slice(2).map(spec => {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(spec);
    if (!match) {
      throw new Error(`Expected owner/repo#pr, got '${spec}'`);
    }
    return { repo: match[1], number: match[2] };
  });
  if (!prs.length) {
    throw new Error('Usage: node benchmark/ai-review/run.mjs <owner/repo#pr>...');
  }
  for (const name of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
    if (!process.env[name]) {
      throw new Error(`${name} is not set`);
    }
  }

  buildImage();
  const runDir = join(OUT_ROOT, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

  for (const { repo, number } of prs) {
    const pull = await getPull(repo, number);
    const cacheDir = repoCache(repo, number);
    // The jobs run in parallel in the workflow, so run them in parallel here too
    await Promise.all([['code-review', codeReview], ['completeness-review', completenessReview]].map(async ([job, review]) => {
      const outDir = join(runDir, `${repo.replace('/', '__')}__${number}`, job);
      mkdirSync(outDir, { recursive: true });
      console.error(`${repo}#${number} ${job}`);
      const started = Date.now();
      const exitCode = await review({ repo, pull, cacheDir, outDir });
      const durationMs = Date.now() - started;
      writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ exitCode, durationMs }, null, 2)}\n`);
      console.error(`${repo}#${number} ${job} exited ${exitCode} after ${Math.round(durationMs / 1000)}s`);
    }));
  }
  console.error(`Results in ${runDir}`);
};

await main();

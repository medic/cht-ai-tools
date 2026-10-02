#!/usr/bin/env node
/**
 * Runs the two review jobs of the cht-core ai-review workflow against PRs, in a container, and saves their raw output
 * instead of posting it to the PR.
 *
 * Usage: node benchmark/ai-review/run.mjs <owner/repo#pr>...
 *
 * Requires docker, git, gh (logged in) and ANTHROPIC_API_KEY.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
  '--setting-sources', 'user',
  '--allowedTools', 'Skill,Grep,Glob,Bash(/home/runner/.claude/plugins/cache/medic-cht-ai-tools/cht-pr-review/*/scripts/pr-context.sh*),Bash(/home/runner/.claude/plugins/cache/medic-cht-ai-tools/cht-pr-review/*/scripts/pr-diff.sh*),mcp__plugin_cht-docs-mcp_cht-docs__ask_question,mcp__plugin_cht-docs-mcp_cht-docs__search_docs',
  '--disallowedTools', 'Edit,Write,NotebookEdit,Monitor,PowerShell,WebFetch,WebSearch',
  '--json-schema', '{"type":"object","required":["report_markdown"],"additionalProperties":false,"properties":{"report_markdown":{"type":"string","description":"The complete review report as GitHub-flavored markdown."}}}',
];

// The rest of the OCR config is set in the Dockerfile
const OCR_SCRIPT = `
set -eo pipefail
ocr config set llm.model "$OCR_LLM_MODEL"
ocr config set llm.extra_body "$OCR_EXTRA_BODY"
ocr review --timeout "$OCR_TASK_TIMEOUT" "$@" > /out/ocr-result.json 2> /out/ocr-stderr.log
`;

// The image already has the workflow's settings and plugins (see the Dockerfile)
const CLAUDE_SCRIPT = `
claude -p "$CLAUDE_PROMPT" --output-format stream-json --verbose "$@" > /out/execution.jsonl 2> /out/claude-stderr.log
`;

const IMAGE = 'cht-ai-review-bench';
const RUNNER_WORKSPACE = '/home/runner/work/workspace';

const sh = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const git = (cwd, ...args) => sh('git', args, { cwd });

// Docker's layer cache makes this quick when the Dockerfile hasn't changed
// Built from the repo root so the image installs the plugins from this checkout. Docker's layer cache makes this quick,
// and rebuilds from the plugin COPY onward when the skill has changed.
const buildImage = () => sh('docker', ['build', '-t', IMAGE, '-f', join(HERE, 'Dockerfile'), TOOLS_ROOT], { stdio: 'inherit' });

/** Bare clone per repo, reused across runs, so each PR checkout is a cheap local clone. */
const repoCache = (repo, pr) => {
  const dir = join(OUT_ROOT, '.cache', `${repo.replace('/', '__')}.git`);
  if (!existsSync(dir)) {
    sh('git', ['clone', '--bare', `https://github.com/${repo}.git`, dir], { stdio: 'inherit' });
  }
  git(dir, 'fetch', '--quiet', 'origin', `+refs/pull/${pr}/head:refs/pull/${pr}/head`, '+refs/heads/*:refs/heads/*');
  return dir;
};

const checkout = (cacheDir, repo, dir, sha) => {
  rmSync(dir, { recursive: true, force: true });
  sh('git', ['clone', '--quiet', '--no-checkout', cacheDir, dir]);
  git(dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`); // gh resolves the repo from origin
  git(dir, 'checkout', '--quiet', '--detach', sha);
};

const runContainer = ({ workspace, outDir, env, script, args }) => {
  const result = spawnSync('docker', [
    'run', '--rm', '--init',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${workspace}:${RUNNER_WORKSPACE}:z`,
    '-v', `${outDir}:/out:z`,
    '-w', RUNNER_WORKSPACE,
    ...Object.keys(env).flatMap(k => ['-e', k]), // values come from our env, keeping secrets off the command line
    IMAGE, 'bash', '-c', script, 'bash', ...args,
  ], { stdio: 'inherit', env: { ...process.env, ...env } });
  return result.status;
};

const codeReview = ({ repo, pull, cacheDir, outDir }) => {
  const workspace = join(outDir, 'workspace');
  // pull_request_target checks out the base branch; OCR reviews from the merge-base to the PR head
  checkout(cacheDir, repo, workspace, pull.base.sha);
  const mergeBase = git(workspace, 'merge-base', pull.base.sha, pull.head.sha);
  const status = runContainer({
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

const completenessReview = ({ repo, pull, cacheDir, outDir }) => {
  const workspace = join(outDir, 'workspace');
  checkout(cacheDir, repo, workspace, pull.head.sha);
  const ghToken = process.env.GH_TOKEN || sh('gh', ['auth', 'token']);
  const status = runContainer({
    workspace,
    outDir,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GH_TOKEN: ghToken,
      GITHUB_TOKEN: ghToken,
      CLAUDE_CODE_ENTRYPOINT: 'claude-code-github-action',
      CLAUDE_PROMPT: claudePrompt(repo, pull.number),
    },
    script: CLAUDE_SCRIPT,
    args: CLAUDE_ARGS,
  });
  rmSync(workspace, { recursive: true, force: true });

  const result = readFileSync(join(outDir, 'execution.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line)).findLast(m => m.type === 'result');
  if (result?.structured_output?.report_markdown) {
    writeFileSync(join(outDir, 'report.md'), `${result.structured_output.report_markdown}\n`);
  }
  return status;
};

const main = () => {
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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  buildImage();
  const runDir = join(OUT_ROOT, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

  for (const { repo, number } of prs) {
    const pull = JSON.parse(sh('gh', ['api', `repos/${repo}/pulls/${number}`]));
    const cacheDir = repoCache(repo, number);
    for (const [job, review] of [['code-review', codeReview], ['completeness-review', completenessReview]]) {
      const outDir = join(runDir, `${repo.replace('/', '__')}__${number}`, job);
      mkdirSync(outDir, { recursive: true });
      console.error(`${repo}#${number} ${job}`);
      const status = review({ repo, pull, cacheDir, outDir });
      console.error(`${repo}#${number} ${job} exited ${status}`);
    }
  }
  console.error(`Results in ${runDir}`);
};

main();

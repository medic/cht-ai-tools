#!/usr/bin/env node
/**
 * Benchmark harness for the cht-core `ai-review` workflow (.github/workflows/ai-review.yml).
 *
 * For every PR case it reproduces, in a container, what the two review jobs do on the GitHub runner and
 * collects their raw outputs instead of posting them to the PR:
 *
 *   code-review          alibaba/open-code-review action   -> ocr-result.json, ocr-stderr.log
 *   completeness-review  anthropics/claude-code-action     -> execution.json, structured_output.json, report.md
 *
 * The step inputs (models, effort, prompt, claude_args, plugins, ...) are read from the workflow file itself, so
 * editing the workflow (or pointing --workflow at a local copy) changes what gets benchmarked.
 *
 * Run with --help for usage.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = resolve(HERE, '../..');
const RUNNER_HOME = '/home/runner';
const CONTAINER_OUT = '/out';
const CONTAINER_MARKETPLACE = '/opt/cht-ai-tools';
const OCR_ACTION = 'alibaba/open-code-review';
const CLAUDE_ACTION = 'anthropics/claude-code-action';
const JOBS = ['code-review', 'completeness-review'];

const USAGE = `Usage: node benchmark/ai-review/run.mjs [options]

Cases
  --cases <file>           JSON file of PR cases (default: benchmark/ai-review/cases.json)
  --pr <owner/repo#num>    Benchmark this PR instead of the cases file (repeatable)
  --runs <n>               Times to run every case, for variance (default: 1)
  --jobs <list>            Comma separated subset of: ${JOBS.join(',')} (default: both)

What is benchmarked
  --workflow <file>        Local ai-review.yml to read the job config from
  --workflow-repo <nwo>    Repo holding the workflow when --workflow is not given (default: medic/cht-core)
  --workflow-ref <ref>     Ref of that repo to read the workflow from (default: 11346-add-ai-review)
  --ocr-config <dir>       Local .opencodereview dir to review with. Default: the one at --workflow-ref when the case
                           is in --workflow-repo, otherwise whatever the PR's base commit has (as CI would)
  --marketplace <src>      Plugin marketplace for the completeness review: 'local' (a snapshot of this checkout,
                           including uncommitted changes), 'workflow' (the workflow's plugin_marketplaces), or a git
                           URL (default: local)
  --claude-code-version    Override the Claude Code version (default: the one pinned by the workflow's action SHA)
  --telemetry              Keep the workflow's OTEL/telemetry env (secrets are read from same-named env vars)

Execution
  --out <dir>              Results root (default: bench-results)
  --label <name>           Suffix for the run directory name
  --concurrency <n>        Jobs to run at once (default: 1)
  --engine <cmd>           Container engine: docker or podman (default: $CONTAINER_ENGINE or docker)
  --rebuild                Rebuild the container image even if it exists
  --keep-workspaces        Keep the per-job git checkouts after a job finishes
  -h, --help               Show this help

Environment
  ANTHROPIC_API_KEY        Used for secrets.ANTHROPIC_AUTH_TOKEN when that is not set itself
  <SECRET_NAME>            Any other secrets.<SECRET_NAME> the workflow references
  GH_TOKEN                 GitHub token for the reviewed repo (default: \`gh auth token\`)
`;

const log = (...args) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const run = async (cmd, args, opts = {}) => {
  const { stdout } = await exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
  return stdout.trim();
};
const git = (cwd, ...args) => run('git', args, { cwd });
const ghApi = async (path) => JSON.parse(await run('gh', ['api', path]));
const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);

const parseCli = () => {
  const { values } = parseArgs({
    options: {
      'cases': { type: 'string', default: join(HERE, 'cases.json') },
      'pr': { type: 'string', multiple: true },
      'runs': { type: 'string', default: '1' },
      'jobs': { type: 'string', default: JOBS.join(',') },
      'workflow': { type: 'string' },
      'workflow-repo': { type: 'string', default: 'medic/cht-core' },
      'workflow-ref': { type: 'string', default: '11346-add-ai-review' },
      'ocr-config': { type: 'string' },
      'marketplace': { type: 'string', default: 'local' },
      'claude-code-version': { type: 'string' },
      'telemetry': { type: 'boolean', default: false },
      'out': { type: 'string', default: join(TOOLS_ROOT, 'bench-results') },
      'label': { type: 'string' },
      'concurrency': { type: 'string', default: '1' },
      'engine': { type: 'string', default: process.env.CONTAINER_ENGINE || 'docker' },
      'rebuild': { type: 'boolean', default: false },
      'keep-workspaces': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const jobs = values.jobs.split(',').map(j => j.trim()).filter(Boolean);
  const unknown = jobs.filter(j => !JOBS.includes(j));
  if (unknown.length) {
    throw new Error(`Unknown job(s): ${unknown.join(', ')}`);
  }
  return {
    ...values,
    jobs,
    runs: Math.max(1, parseInt(values.runs, 10)),
    concurrency: Math.max(1, parseInt(values.concurrency, 10)),
    out: resolve(values.out),
    ocrConfig: values['ocr-config'] && resolve(values['ocr-config']),
  };
};

const loadCases = async (opts) => {
  const parsePr = (spec) => {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(spec);
    if (!match) {
      throw new Error(`Invalid --pr '${spec}', expected owner/repo#number`);
    }
    return { repo: match[1], pr: Number(match[2]) };
  };
  const cases = opts.pr?.length ? opts.pr.map(parsePr) : JSON.parse(await readFile(opts.cases, 'utf8')).cases;
  if (!cases?.length) {
    throw new Error('No cases to run');
  }
  return cases.map(c => ({ ...c, id: c.id || `${c.repo.replace('/', '__')}__${c.pr}` }));
};

// ---------------------------------------------------------------------------------------------------------------------
// Workflow config

const loadWorkflow = async (opts) => {
  if (opts.workflow) {
    return { source: resolve(opts.workflow), text: await readFile(opts.workflow, 'utf8') };
  }
  const path = '.github/workflows/ai-review.yml';
  const { content, sha } = await ghApi(`repos/${opts['workflow-repo']}/contents/${path}?ref=${opts['workflow-ref']}`);
  return {
    source: `${opts['workflow-repo']}@${opts['workflow-ref']}:${path}`,
    blobSha: sha,
    text: Buffer.from(content, 'base64').toString('utf8'),
  };
};

/** Finds the step that uses `action` and returns it along with its job. */
const findActionStep = (workflow, action) => {
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    const step = (job.steps || []).find(s => s.uses?.startsWith(`${action}@`));
    if (step) {
      return { jobName, job, step, actionRef: step.uses.slice(action.length + 1).split(/\s/)[0] };
    }
  }
  throw new Error(`The workflow has no step using ${action}`);
};

/**
 * Resolves the `${{ ... }}` expressions the workflow uses against a local stand-in for the GitHub context. Only plain
 * property paths are supported; anything else resolves to '' with a warning.
 */
const makeResolver = (context, warnings) => {
  const lookup = (expr) => {
    const [root, ...path] = expr.split('.');
    if (root === 'secrets') {
      const [name] = path;
      return process.env[name] ?? (name === 'ANTHROPIC_AUTH_TOKEN' ? process.env.ANTHROPIC_API_KEY : undefined);
    }
    let value = context[root];
    for (const key of path) {
      value = value?.[key];
    }
    return value;
  };
  const resolveValue = (value) => {
    if (typeof value !== 'string') {
      return value === undefined || value === null ? value : String(value);
    }
    return value.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
      const result = /^[\w.-]+$/.test(expr) ? lookup(expr) : undefined;
      if (result === undefined) {
        warnings.add(`Unresolved expression \${{ ${expr} }} (using '')`);
        return '';
      }
      return String(result);
    });
  };
  const resolveMap = (map = {}) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, resolveValue(v)]));
  return { resolveValue, resolveMap };
};

const buildContext = ({ workflow, jobName, job, prInfo, testCase, runId }) => {
  const context = {
    github: {
      repository: testCase.repo,
      job: jobName,
      run_id: runId,
      run_attempt: '1',
      event: {
        label: { name: 'ai-review' },
        sender: { login: 'ai-review-benchmark' },
        pull_request: prInfo,
      },
    },
    env: {},
  };
  // Workflow env may reference secrets/github, and job env may reference workflow env.
  const warnings = new Set();
  context.env = makeResolver(context, warnings).resolveMap(workflow.env);
  context.env = { ...context.env, ...makeResolver(context, warnings).resolveMap(job.env) };
  return { context, warnings };
};

/** The Claude Code version claude-code-action installs is hardcoded in its run entrypoint. */
const claudeCodeVersionForAction = async (actionRef) => {
  const { content } = await ghApi(`repos/${CLAUDE_ACTION}/contents/src/entrypoints/run.ts?ref=${actionRef}`);
  const version = /claudeCodeVersion\s*=\s*"([^"]+)"/.exec(Buffer.from(content, 'base64').toString('utf8'))?.[1];
  if (!version) {
    throw new Error(`Could not find the Claude Code version in ${CLAUDE_ACTION}@${actionRef}; pass --claude-code-version`);
  }
  return version;
};

// ---------------------------------------------------------------------------------------------------------------------
// Containers

const engineArgs = (opts) => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return ['--user', `${uid}:${gid}`, ...(opts.engine.endsWith('podman') ? ['--userns=keep-id'] : [])];
};

const ensureImage = async (opts, { ocrVersion, claudeCodeVersion }) => {
  const tag = `cht-ai-review-bench:ocr-${ocrVersion}-cc-${claudeCodeVersion}`;
  const exists = await run(opts.engine, ['image', 'inspect', tag]).then(() => true, () => false);
  if (exists && !opts.rebuild) {
    return tag;
  }
  log(`Building ${tag}`);
  await spawnLogged(opts.engine, [
    'build', '-t', tag,
    '--build-arg', `OCR_VERSION=${ocrVersion}`,
    '--build-arg', `CLAUDE_CODE_VERSION=${claudeCodeVersion}`,
    HERE,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  return tag;
};

const liveContainers = new Map();

const spawnLogged = (cmd, args, { stdio = 'inherit', timeoutMs, env } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(cmd, args, { stdio, env: { ...process.env, ...env } });
  const timer = timeoutMs && setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`Timed out after ${timeoutMs / 60000} minutes`));
  }, timeoutMs);
  child.on('error', reject);
  child.on('close', code => {
    clearTimeout(timer);
    return code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited with ${code}`));
  });
});

/**
 * Runs `script` with bash in the benchmark image, with the workspace mounted where the runner would have it. `env` is
 * passed by name (-e KEY) through the engine's own environment, so secrets never land on the command line.
 */
const runInContainer = async (opts, { image, name, workspace, repoName, outDir, env, script, mounts = [], timeoutMs }) => {
  const workdir = `${RUNNER_HOME}/work/${repoName}/${repoName}`;
  const args = [
    'run', '--rm', '--init', '--name', name,
    ...engineArgs(opts),
    '-v', `${workspace}:${workdir}:z`,
    '-v', `${outDir}:${CONTAINER_OUT}:z`,
    ...mounts.flatMap(m => ['-v', m]),
    '-w', workdir,
    ...Object.keys(env).flatMap(k => ['-e', k]),
    image, 'bash', '-c', script,
  ];
  liveContainers.set(name, opts.engine);
  try {
    await spawnLogged(opts.engine, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeoutMs,
      env,
    });
  } finally {
    liveContainers.delete(name);
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// Git

const repoLocks = new Map();
const withRepoLock = (key, fn) => {
  const next = (repoLocks.get(key) || Promise.resolve()).then(fn, fn);
  repoLocks.set(key, next.catch(() => {}));
  return next;
};

/**
 * A bare clone per repo, shared by every run, holding the commits the cases need. `refs` are only fetched when one of
 * `shas` is missing; `alwaysRefs` (branches that move, like the workflow ref) are fetched every time.
 */
const ensureRepoCache = (opts, repo, { refs = [], shas = [], alwaysRefs = [] }) => withRepoLock(repo, async () => {
  const cacheDir = join(opts.out, '.cache', 'repos', `${repo.replace('/', '__')}.git`);
  if (!existsSync(cacheDir)) {
    log(`Cloning ${repo} (first run only, this can take a while)`);
    await mkdir(dirname(cacheDir), { recursive: true });
    await run('git', ['clone', '--bare', '--quiet', `https://github.com/${repo}.git`, cacheDir]);
  }
  const missing = [];
  for (const sha of shas) {
    await git(cacheDir, 'cat-file', '-e', `${sha}^{commit}`).catch(() => missing.push(sha));
  }
  const toFetch = [...alwaysRefs, ...(missing.length ? [...refs, ...missing] : [])];
  if (toFetch.length) {
    await git(cacheDir, 'fetch', '--quiet', '--force', 'origin', ...toFetch);
  }
  return cacheDir;
});

/** A standalone clone (no alternates or worktree links, so it works inside the container) checked out at `sha`. */
const createWorkspace = async (cacheDir, repo, dir, sha) => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await run('git', ['clone', '--quiet', '--no-checkout', cacheDir, dir]);
  // gh resolves the repo from the origin remote
  await git(dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`);
  await git(dir, 'checkout', '--quiet', '--detach', sha);
};

// ---------------------------------------------------------------------------------------------------------------------
// code-review: mirrors the "Configure OCR" and "Run OpenCodeReview" steps of the open-code-review action

const OCR_SCRIPT = `
set -eo pipefail
ocr config unset provider
ocr config set llm.auth_token ""
ocr config set llm.extra_headers ""
ocr config set llm.retry_codes ""
ocr config set llm.url "$OCR_LLM_URL"
ocr config set llm.model "$OCR_LLM_MODEL"
ocr config set llm.use_anthropic "$OCR_USE_ANTHROPIC"
ocr config set llm.protocol "$OCR_LLM_PROTOCOL"
ocr config set llm.auth_header "$OCR_LLM_AUTH_HEADER"
ocr config set llm.auth_token_cmd 'printf "%s" "$OCR_LLM_TOKEN"'
ocr config set llm.extra_body "$OCR_EXTRA_BODY"
ocr config set language "$OCR_LANGUAGE"
ocr version > ${CONTAINER_OUT}/ocr-version.txt
eval "ARGS=($OCR_ARGS)"
set +e
ocr review "\${ARGS[@]}" > ${CONTAINER_OUT}/ocr-result.json 2> ${CONTAINER_OUT}/ocr-stderr.log
echo $? > ${CONTAINER_OUT}/exit-code
`;

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Derives the OCR env and `ocr review` args from the action inputs, applying the action's defaults and validation. */
const ocrInvocation = (inputs, { mergeBase, headSha }) => {
  const input = (name, fallback = '') => (inputs[name] ?? fallback);
  const useAnthropicInput = input('llm_use_anthropic').toLowerCase();
  let useAnthropic = ['', 'true', '1', 'yes'].includes(useAnthropicInput);
  let protocol = useAnthropic ? 'anthropic' : 'openai';
  const explicitProtocol = input('llm_protocol').toLowerCase();
  if (explicitProtocol) {
    protocol = explicitProtocol;
    useAnthropic = explicitProtocol === 'anthropic';
  }
  let extraBody = input('llm_extra_body', '{"thinking": {"type": "disabled"}}');
  const reasoningEffort = input('llm_reasoning_effort').toLowerCase();
  if (reasoningEffort) {
    if (protocol === 'anthropic') {
      throw new Error('llm_reasoning_effort is supported only with OpenAI-compatible protocols');
    }
    extraBody = JSON.stringify({ reasoning_effort: reasoningEffort, ...JSON.parse(extraBody || '{}') });
  }

  const args = ['--from', mergeBase, '--to', headSha];
  if (input('stream_progress', 'false').toLowerCase() !== 'true') {
    args.push('--audience', 'agent');
  }
  args.push('--format', 'json', '--timeout', String(parseInt(input('review_task_timeout', '15'), 10)));
  const optional = { review_concurrency: '--concurrency', background: '--background', rule: '--rule',
    effort: '--effort', max_tokens_budget: '--max-tokens-budget' };
  for (const [name, flag] of Object.entries(optional)) {
    const value = name === 'effort' ? input(name).toLowerCase() : input(name);
    if (value) {
      args.push(flag, value);
    }
  }

  return {
    version: input('ocr_version', 'latest'),
    env: {
      OCR_LLM_URL: input('llm_url'),
      OCR_LLM_TOKEN: input('llm_auth_token'),
      OCR_LLM_MODEL: input('llm_model'),
      OCR_USE_ANTHROPIC: String(useAnthropic),
      OCR_LLM_PROTOCOL: protocol,
      OCR_LLM_AUTH_HEADER: input('llm_auth_header'),
      OCR_LLM_EXTRA_HEADERS: input('llm_extra_headers'),
      OCR_LLM_TIMEOUT: input('llm_timeout', '300'),
      OCR_EXTRA_BODY: extraBody,
      OCR_LANGUAGE: input('language', 'English'),
      OCR_ARGS: args.map(shellQuote).join(' '),
    },
    args,
  };
};

const runCodeReview = async (ctx) => {
  const { opts, testCase, prInfo, cacheDir, jobDir, image, config, resolver, stepEnv } = ctx;
  const workspace = join(jobDir, 'workspace');
  // pull_request_target checks out the base branch, and reviews from the merge-base to the PR head
  await createWorkspace(cacheDir, testCase.repo, workspace, prInfo.base.sha);
  const mergeBase = await git(workspace, 'merge-base', prInfo.base.sha, prInfo.head.sha);
  const ocrConfigSource = await overlayOcrConfig(ctx, workspace);

  const inputs = resolver.resolveMap(config.ocr.step.with);
  const invocation = ocrInvocation(inputs, { mergeBase, headSha: prInfo.head.sha });
  if (!invocation.env.OCR_LLM_TOKEN) {
    throw new Error('No LLM token for OCR: set the secret its llm_auth_token references (or ANTHROPIC_API_KEY)');
  }
  await writeJson(join(jobDir, 'invocation.json'), {
    action: config.ocr.step.uses,
    ocrConfigSource,
    mergeBase,
    ocrReviewArgs: invocation.args,
    env: redact(invocation.env, ['OCR_LLM_TOKEN']),
    stepEnv: Object.keys(stepEnv),
  });

  await runInContainer(opts, {
    image,
    name: ctx.containerName,
    workspace,
    repoName: testCase.repo.split('/')[1],
    outDir: jobDir,
    env: { ...stepEnv, ...invocation.env },
    script: OCR_SCRIPT,
    timeoutMs: ctx.timeoutMs,
  });
  const exitCode = Number((await readFile(join(jobDir, 'exit-code'), 'utf8')).trim());
  const result = await readFile(join(jobDir, 'ocr-result.json'), 'utf8').then(JSON.parse, () => undefined);
  return { exitCode, ...summarizeOcrResult(result) };
};

/** Puts the .opencodereview config under test in the workspace in place of the base commit's. */
const overlayOcrConfig = async ({ opts, testCase, config }, workspace) => {
  const target = join(workspace, '.opencodereview');
  if (opts.ocrConfig) {
    await rm(target, { recursive: true, force: true });
    await cp(opts.ocrConfig, target, { recursive: true });
    return opts.ocrConfig;
  }
  if (config.workflowSha && testCase.repo === opts['workflow-repo']) {
    await rm(target, { recursive: true, force: true });
    await git(workspace, 'checkout', config.workflowSha, '--', '.opencodereview').catch(() => {});
    return `${opts['workflow-repo']}@${config.workflowSha}:.opencodereview`;
  }
  return 'base commit';
};

/** OCR's JSON shape is not pinned down here, so count whatever comment/finding lists it has. */
const summarizeOcrResult = (result) => {
  if (!result || typeof result !== 'object') {
    return { resultParsed: false };
  }
  const lists = Object.entries(result).filter(([, v]) => Array.isArray(v));
  return {
    resultParsed: true,
    topLevelKeys: Object.keys(result),
    ...Object.fromEntries(lists.map(([k, v]) => [`${k}Count`, v.length])),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// completeness-review: mirrors claude-code-action in agent mode (explicit prompt)

const CLAUDE_SCRIPT = `
set -eo pipefail
mkdir -p ~/.claude
printf '%s' "$BENCH_SETTINGS" > ~/.claude/settings.json
while IFS= read -r m; do [ -n "$m" ] && claude plugin marketplace add "$m"; done <<< "$BENCH_MARKETPLACES"
while IFS= read -r p; do [ -n "$p" ] && claude plugin install "$p"; done <<< "$BENCH_PLUGINS"
claude --version > ${CONTAINER_OUT}/claude-version.txt
set +e
eval "claude -p \\"\\$BENCH_PROMPT\\" --output-format stream-json --verbose $BENCH_CLAUDE_ARGS" \\
  > ${CONTAINER_OUT}/execution.jsonl 2> ${CONTAINER_OUT}/claude-stderr.log
echo $? > ${CONTAINER_OUT}/exit-code
`;

const splitLines = (s = '') => s.split('\n').map(l => l.trim()).filter(Boolean);

const runCompletenessReview = async (ctx) => {
  const { opts, testCase, prInfo, cacheDir, jobDir, image, config, resolver, stepEnv } = ctx;
  const workspace = join(jobDir, 'workspace');
  await createWorkspace(cacheDir, testCase.repo, workspace, prInfo.head.sha);

  const inputs = resolver.resolveMap(config.claude.step.with);
  const marketplaces = opts.marketplace === 'workflow'
    ? splitLines(inputs.plugin_marketplaces)
    : [opts.marketplace === 'local' ? CONTAINER_MARKETPLACE : opts.marketplace];
  const settings = { ...(inputs.settings ? JSON.parse(inputs.settings) : {}), enableAllProjectMcpServers: true };
  const githubToken = process.env.GH_TOKEN || await run('gh', ['auth', 'token']);
  const env = {
    ...stepEnv,
    ANTHROPIC_API_KEY: inputs.anthropic_api_key || '',
    ...(inputs.claude_code_oauth_token ? { CLAUDE_CODE_OAUTH_TOKEN: inputs.claude_code_oauth_token } : {}),
    GH_TOKEN: githubToken,
    GITHUB_TOKEN: githubToken,
    CLAUDE_CODE_ENTRYPOINT: 'claude-code-github-action',
    BENCH_SETTINGS: JSON.stringify(settings),
    BENCH_MARKETPLACES: marketplaces.join('\n'),
    BENCH_PLUGINS: splitLines(inputs.plugins).join('\n'),
    BENCH_PROMPT: inputs.prompt || `Repository: ${testCase.repo}`,
    BENCH_CLAUDE_ARGS: (inputs.claude_args || '').replace(/\s*\n\s*/g, ' ').trim(),
  };
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('No Anthropic credentials for Claude: set the secret anthropic_api_key references (or ANTHROPIC_API_KEY)');
  }
  await writeJson(join(jobDir, 'invocation.json'), {
    action: config.claude.step.uses,
    claudeCodeVersion: config.claudeCodeVersion,
    marketplaces,
    plugins: splitLines(inputs.plugins),
    prompt: env.BENCH_PROMPT,
    claudeArgs: env.BENCH_CLAUDE_ARGS,
    settings,
    env: Object.keys(env),
  });

  await runInContainer(opts, {
    image,
    name: ctx.containerName,
    workspace,
    repoName: testCase.repo.split('/')[1],
    outDir: jobDir,
    env,
    script: CLAUDE_SCRIPT,
    mounts: config.marketplaceDir ? [`${config.marketplaceDir}:${CONTAINER_MARKETPLACE}:ro,z`] : [],
    timeoutMs: ctx.timeoutMs,
  });

  const exitCode = Number((await readFile(join(jobDir, 'exit-code'), 'utf8')).trim());
  // The action's execution_file is the SDK message list as a JSON array
  const messages = splitLines(await readFile(join(jobDir, 'execution.jsonl'), 'utf8').catch(() => ''))
    .map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(Boolean);
  await writeJson(join(jobDir, 'execution.json'), messages);
  const result = messages.findLast(m => m.type === 'result');
  if (result?.structured_output) {
    await writeJson(join(jobDir, 'structured_output.json'), result.structured_output);
    if (typeof result.structured_output.report_markdown === 'string') {
      await writeFile(join(jobDir, 'report.md'), `${result.structured_output.report_markdown}\n`);
    }
  }
  return { exitCode, ...summarizeClaudeRun(messages, result) };
};

const summarizeClaudeRun = (messages, result) => {
  const toolUses = {};
  for (const m of messages) {
    for (const block of (m.type === 'assistant' && m.message?.content) || []) {
      if (block.type === 'tool_use') {
        const key = block.name === 'Bash' ? `Bash(${String(block.input?.command).split(/\s/)[0].split('/').pop()})` : block.name;
        toolUses[key] = (toolUses[key] || 0) + 1;
      }
    }
  }
  return {
    resultSubtype: result?.subtype,
    isError: result?.is_error,
    hasReport: typeof result?.structured_output?.report_markdown === 'string',
    durationMs: result?.duration_ms,
    numTurns: result?.num_turns,
    totalCostUsd: result?.total_cost_usd,
    usage: result?.usage,
    modelUsage: result?.modelUsage,
    permissionDenials: result?.permission_denials?.map(d => d.tool_name) ?? [],
    toolUses,
  };
};

const redact = (env, keys) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, keys.includes(k) && v ? '***' : v]));

/** The step's own `env`, minus telemetry (which would ship benchmark runs to the CI Langfuse project) by default. */
const stepEnvFor = (opts, resolver, step) => {
  const env = resolver.resolveMap(step.env);
  if (!opts.telemetry) {
    return Object.fromEntries(Object.entries(env).filter(([k]) => !/OTEL|TELEMETRY/.test(k)));
  }
  if (env.OTEL_RESOURCE_ATTRIBUTES) {
    env.OTEL_RESOURCE_ATTRIBUTES = env.OTEL_RESOURCE_ATTRIBUTES.replace('deployment.environment.name=ci', 'deployment.environment.name=benchmark');
  }
  return env;
};

// ---------------------------------------------------------------------------------------------------------------------

const pool = async (tasks, concurrency) => {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
};

/** Snapshots the plugin marketplace from this checkout, so edits made mid-run don't leak into later jobs. */
const MARKETPLACE_PATHS = ['.claude-plugin', '.mcp.json', 'skills', 'hooks', 'commands'];
const stageLocalMarketplace = async (runDir) => {
  const dir = join(runDir, 'marketplace');
  for (const path of MARKETPLACE_PATHS.filter(p => existsSync(join(TOOLS_ROOT, p)))) {
    await cp(join(TOOLS_ROOT, path), join(dir, path), { recursive: true });
  }
  return dir;
};

const toolsRepoState = async () => {
  const sha = await git(TOOLS_ROOT, 'rev-parse', 'HEAD').catch(() => undefined);
  const dirty = await git(TOOLS_ROOT, 'status', '--porcelain').then(s => s.split('\n').filter(Boolean), () => []);
  return { sha, dirty };
};

const main = async () => {
  const opts = parseCli();
  const cases = await loadCases(opts);
  const workflowFile = await loadWorkflow(opts);
  const workflow = parseYaml(workflowFile.text);
  const ocr = findActionStep(workflow, OCR_ACTION);
  const claude = findActionStep(workflow, CLAUDE_ACTION);
  const claudeCodeVersion = opts['claude-code-version'] || await claudeCodeVersionForAction(claude.actionRef);
  // The version input may reference env, but not PR data, so resolve it with any PR
  const ocrVersion = makeResolver(buildContext({ workflow, ...ocr, prInfo: {}, testCase: cases[0], runId: '' }).context, new Set())
    .resolveValue(ocr.step.with?.ocr_version) || 'latest';

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${opts.label ? `-${opts.label}` : ''}`;
  const runDir = join(opts.out, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'ai-review.yml'), workflowFile.text);

  const image = await ensureImage(opts, { ocrVersion, claudeCodeVersion });
  const marketplaceDir = opts.marketplace === 'local' ? await stageLocalMarketplace(runDir) : undefined;

  // Resolve every PR and make sure its commits (and the workflow ref, for the OCR rules) are in the cache
  const prepared = [];
  for (const testCase of cases) {
    const pull = await ghApi(`repos/${testCase.repo}/pulls/${testCase.pr}`);
    const prInfo = {
      number: pull.number,
      title: pull.title,
      head: { sha: testCase.head || pull.head.sha, ref: pull.head.ref },
      base: { sha: testCase.base || pull.base.sha, ref: pull.base.ref },
    };
    const needsWorkflowRef = !opts.workflow && !opts.ocrConfig && testCase.repo === opts['workflow-repo'];
    const cacheDir = await ensureRepoCache(opts, testCase.repo, {
      refs: [`+refs/pull/${prInfo.number}/head:refs/pull/${prInfo.number}/head`, `+refs/heads/${prInfo.base.ref}:refs/heads/${prInfo.base.ref}`],
      shas: [prInfo.head.sha, prInfo.base.sha],
      alwaysRefs: needsWorkflowRef ? [`+refs/heads/${opts['workflow-ref']}:refs/heads/${opts['workflow-ref']}`] : [],
    });
    // Case files may pin abbreviated SHAs
    prInfo.head.sha = await git(cacheDir, 'rev-parse', `${prInfo.head.sha}^{commit}`);
    prInfo.base.sha = await git(cacheDir, 'rev-parse', `${prInfo.base.sha}^{commit}`);
    const workflowSha = needsWorkflowRef ? await git(cacheDir, 'rev-parse', opts['workflow-ref']) : undefined;
    prepared.push({ testCase, prInfo, cacheDir, workflowSha });
  }

  const toolsRepo = await toolsRepoState();
  await writeJson(join(runDir, 'manifest.json'), {
    runId,
    startedAt: new Date().toISOString(),
    workflow: { source: workflowFile.source, blobSha: workflowFile.blobSha },
    actions: { ocr: ocr.step.uses, claude: claude.step.uses },
    versions: { ocr: ocrVersion, claudeCode: claudeCodeVersion },
    image,
    chtAiTools: toolsRepo,
    options: { ...opts, pr: undefined },
    cases: prepared.map(({ testCase, prInfo, workflowSha }) => ({ ...testCase, prInfo, ocrConfigSha: workflowSha })),
  });
  if (toolsRepo.dirty.length && opts.marketplace === 'local') {
    log(`Note: benchmarking uncommitted cht-ai-tools changes (${toolsRepo.dirty.length} file(s))`);
  }

  const tasks = [];
  for (const { testCase, prInfo, cacheDir, workflowSha } of prepared) {
    for (let r = 1; r <= opts.runs; r++) {
      for (const jobKey of opts.jobs) {
        const target = jobKey === 'code-review' ? ocr : claude;
        tasks.push(async () => {
          const jobDir = join(runDir, testCase.id, `run-${r}`, jobKey);
          await mkdir(jobDir, { recursive: true });
          const { context, warnings } = buildContext({ workflow, ...target, prInfo, testCase, runId });
          const resolver = makeResolver(context, warnings);
          const ctx = {
            opts, testCase, prInfo, cacheDir, jobDir, image, resolver,
            config: { ocr, claude, claudeCodeVersion, workflowSha, marketplaceDir },
            stepEnv: stepEnvFor(opts, resolver, target.step),
            containerName: `ai-review-bench-${runId}-${testCase.id}-${r}-${jobKey}`.replace(/[^\w.-]/g, '-').toLowerCase(),
            timeoutMs: (target.job['timeout-minutes'] || 360) * 60_000,
          };
          const label = `${testCase.repo}#${testCase.pr} run ${r} ${jobKey}`;
          log(`Start  ${label}`);
          const started = Date.now();
          let summary;
          try {
            summary = await (jobKey === 'code-review' ? runCodeReview : runCompletenessReview)(ctx);
          } catch (error) {
            summary = { error: error.message };
          }
          summary = { case: testCase.id, run: r, job: jobKey, wallMs: Date.now() - started, warnings: [...warnings], ...summary };
          await writeJson(join(jobDir, 'summary.json'), summary);
          if (!opts['keep-workspaces']) {
            await rm(join(jobDir, 'workspace'), { recursive: true, force: true });
          }
          log(`${summary.error || summary.exitCode ? 'FAIL' : 'Done'}   ${label} (${Math.round(summary.wallMs / 1000)}s)${summary.error ? `: ${summary.error}` : ''}`);
          return summary;
        });
      }
    }
  }

  const summaries = await pool(tasks, opts.concurrency);
  await writeJson(join(runDir, 'summary.json'), summaries);
  console.table(summaries.map(s => ({
    case: s.case, run: s.run, job: s.job, secs: Math.round(s.wallMs / 1000),
    ok: !s.error && s.exitCode === 0 && (s.job !== 'completeness-review' || s.hasReport),
    costUsd: s.totalCostUsd?.toFixed(2), turns: s.numTurns, denials: s.permissionDenials?.length,
  })));
  log(`Results in ${runDir}`);
};

const stopContainers = () => {
  for (const [name, engine] of liveContainers) {
    spawn(engine, ['rm', '-f', name], { stdio: 'ignore' });
  }
};
process.on('SIGINT', () => {
  stopContainers();
  process.exit(130);
});

main().catch(error => {
  stopContainers();
  console.error(error);
  process.exit(1);
});

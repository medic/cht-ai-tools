#!/usr/bin/env node
/**
 * Scores benchmark runs against the cases in cases/: an LLM judge matches each run's findings to the case's items, and
 * the score (found / failed / rejected / unmatched ids, plus metrics) is derived from those matches. See cases/README.md.
 *
 * Usage: node benchmark/ai-review/score.mjs [--case <case>]... <bench-results/run-dir>...
 *
 * Writes <run-dir>/<case>/score.json for every case the run has results for, or only for the cases named by --case: the score, in the shape of an entry in
 * baseline.json's `runs`, and each judge pass's per-finding matches and usage. The judge runs JUDGE_PASSES times and the
 * score is the first pass's. Prints a one-line summary per score, any disagreement between the passes, and any difference
 * from baseline.json's score for the same run.
 *
 * Requires ANTHROPIC_API_KEY.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, 'cases');
const BASELINE = join(HERE, 'baseline.json');

const JUDGE_MODEL = 'claude-opus-5-5';
const JUDGE_EFFORT = 'high';
const JUDGE_PASSES = 2;

const JOBS = ['code-review', 'completeness-review'];
const SCORE_FIELDS = ['found', 'failed', 'rejected', 'unmatched'];
const BUCKETS = ['Delivered', 'Not delivered', 'Pending verification'];
const SECTIONS = ['requirements', 'preconditions_to_confirm', 'undisclosed_changes', 'alternative_approaches'];

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// Read as a stream of JSON objects rather than lines, so a pretty-printed file still parses
const readJsonStream = file => {
  const text = readFileSync(file, 'utf8');
  const values = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      if (depth++ === 0) {
        start = i;
      }
    } else if (c === '}' && --depth === 0) {
      values.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return values;
};

/** The case's items as one list, each tagged with its job, report section (completeness only) and kind */
const caseItems = kase => {
  const items = [];
  const add = (list = [], job, section, kind) => list.forEach(item => items.push({ ...item, job, section, kind }));
  const cr = kase['code-review'];
  add(cr.required, 'code-review', null, 'required');
  add(cr.extra_credit, 'code-review', null, 'extra_credit');
  add(cr.rejected, 'code-review', null, 'rejected');
  const cp = kase['completeness-review'];
  add(cp.requirements.required, 'completeness-review', 'requirements', 'required');
  add(cp.requirements.preconditions_to_confirm, 'completeness-review', 'preconditions_to_confirm', 'required');
  add(cp.requirements.rejected, 'completeness-review', 'requirements', 'rejected');
  for (const section of ['undisclosed_changes', 'alternative_approaches']) {
    add(cp[section].required, 'completeness-review', section, 'required');
    add(cp[section].rejected, 'completeness-review', section, 'rejected');
  }
  return items;
};

/** The job's run.json; a job that failed has no results worth scoring */
const readRun = dir => {
  const run = readJson(join(dir, 'run.json'));
  if (run.exitCode !== 0) {
    throw new Error(`${dir}: the job exited ${run.exitCode}`);
  }
  return run;
};

/** The ids of `items` of the given kinds that are in `ids`, in the case's order */
const inOrder = (items, kinds, ids) => items.filter(i => kinds.includes(i.kind) && ids.has(i.id)).map(i => i.id);

// ---- The judge

const client = new Anthropic();

const JUDGE_SYSTEM = `You score an AI code review of one pull request against an answer key for it.

The key lists items, each with an id, a summary and a match rule. Its summaries are verified facts about the PR's code; you don't have the code, and don't need it. Required and extra-credit items are correct findings. Rejected items are known-wrong findings that reviews have made before.

For every finding you are given, list the ids of the key items it matches. A finding matches an item when it makes the item's point as the item's match rule describes, including any condition the rule sets (a reason, a bucket) and excluding the near-misses it names. Mentioning the same code, file or topic is not enough. One finding may match several items when it makes several points; many findings match one; some match none. A finding that repeats or extends a point an earlier finding made still matches that point's item: don't leave it unmatched because the item is already found. Judge what the finding says, not whether you agree with it.

Give a one-sentence reason for each decision, naming the deciding words of the finding.`;

const keyText = (items, intro) => `${intro}\n\n<key>\n${JSON.stringify(items.map(item => ({
  id: item.id,
  kind: item.kind,
  ...(item.section && { section: item.section }),
  ...(item.status && { status: item.status, acceptable: item.acceptable ?? [] }),
  summary: item.summary,
  ...(item.reason && { why_wrong: item.reason }),
  match: item.match,
})), null, 2)}\n</key>`;

/** The judge must return exactly one decision per ref it was given */
const checkRefs = (decisions, refs) => {
  const returned = decisions.map(d => d.ref).sort();
  if (JSON.stringify(returned) !== JSON.stringify([...refs].sort())) {
    throw new Error(`Judge returned decisions for ${returned.join(', ')}, expected ${refs.join(', ')}`);
  }
};

/** Schema for a list of the judge's decisions, each with `fields` plus the ids it matches and a reason */
const decisionsSchema = (listName, items, fields) => ({
  type: 'object',
  additionalProperties: false,
  required: [listName],
  properties: {
    [listName]: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...Object.keys(fields), 'matches', 'reason'],
        properties: {
          ...fields,
          matches: { type: 'array', items: { type: 'string', enum: items.map(i => i.id) } },
          reason: { type: 'string' },
        },
      },
    },
  },
});

const judge = async (items, intro, findingsText, schema) => {
  const message = await client.beta.messages.stream({
    model: JUDGE_MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: JUDGE_EFFORT, format: { type: 'json_schema', schema } },
    system: JUDGE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: keyText(items, intro) },
        { type: 'text', text: findingsText },
      ],
    }],
  }).finalMessage();
  if (message.stop_reason !== 'end_turn') {
    const details = message.stop_details ? `: ${JSON.stringify(message.stop_details)}` : '';
    throw new Error(`Judge stopped with ${message.stop_reason}${details}`);
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { output: JSON.parse(text), model: message.model, usage: message.usage };
};

// ---- Code review

const loadCodeReview = dir => {
  const run = readRun(dir);
  const ocr = readJson(join(dir, 'ocr-result.json'));
  return {
    findings: [
      ...(ocr.comments ?? []).map((comment, i) => ({ ref: `posted-${i}`, finding: comment })),
      ...(ocr.tool_calls?.failure_details ?? []).filter(f => f.tool_name === 'code_comment')
        .map((f, i) => ({ ref: `failed-${i}`, finding: f.arguments })),
    ],
    metrics: {
      total_tokens: ocr.summary.total_tokens,
      tool_calls_total: ocr.tool_calls.total,
      tool_calls_failure: ocr.tool_calls.failure,
      duration_ms: run.durationMs,
    },
  };
};

const judgeCodeReview = async (items, { findings, metrics }) => {
  if (!findings.length) {
    return { score: { found: [], failed: [], rejected: [], unmatched: 0, ...metrics }, judgment: { decisions: [] } };
  }
  const refs = findings.map(f => f.ref);
  const { output, model, usage } = await judge(
    items,
    'The review is OpenCodeReview\'s comments on the PR.',
    `<findings>\n${JSON.stringify(findings, null, 2)}\n</findings>\n\n` +
      'Return one decision per finding ref. A "failed" finding holds the raw arguments of a comment call that failed to ' +
      'post; it may contain several comments, so match every point in it.',
    decisionsSchema('decisions', items, { ref: { type: 'string', enum: refs } }),
  );
  const { decisions } = output;
  checkRefs(decisions, refs);

  // Comments that failed to post never reached the PR, so they only count as `failed`
  const posted = decisions.filter(d => d.ref.startsWith('posted-'));
  const postedIds = new Set(posted.flatMap(d => d.matches));
  const failedIds = new Set(decisions.filter(d => d.ref.startsWith('failed-')).flatMap(d => d.matches)
    .filter(id => !postedIds.has(id)));
  return {
    score: {
      found: inOrder(items, ['required', 'extra_credit'], postedIds),
      failed: inOrder(items, ['required', 'extra_credit'], failedIds),
      rejected: inOrder(items, ['rejected'], postedIds),
      unmatched: posted.filter(d => !d.matches.length).length,
      ...metrics,
    },
    judgment: { decisions, model, usage },
  };
};

// ---- Completeness review

/**
 * The report's items: every bullet except a "None", with any lines it wraps onto. Numbered here rather than by the judge,
 * so the judge can't merge or split them.
 */
const reportBullets = report => {
  const bullets = [];
  let open = false;
  for (const line of report.split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) {
      bullets.push(line.trim());
      open = true;
    } else if (!line.trim() || /^\s*#/.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line)) {
      open = false;
    } else if (open) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
  }
  return bullets.filter(b => !/^[-*]\s+None\b/.test(b)).map((text, i) => ({ ref: `item-${i}`, text }));
};

const loadCompleteness = dir => {
  const run = readRun(dir);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  const messages = readJsonStream(join(dir, 'execution.jsonl'));
  const result = messages.findLast(m => m.type === 'result');
  if (!result) {
    throw new Error(`${dir}/execution.jsonl has no result message, so the run was cut off`);
  }
  const blocks = type => messages.filter(m => m.type === type).flatMap(m => m.message?.content ?? []);
  return {
    report,
    bullets: reportBullets(report),
    metrics: {
      total_tokens: Object.values(result.modelUsage)
        .reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0),
      tool_calls_total: blocks('assistant').filter(b => b.type === 'tool_use').length,
      tool_calls_failure: blocks('user').filter(b => b.type === 'tool_result' && b.is_error === true).length,
      duration_ms: run.durationMs,
    },
  };
};

// A case keeps rejected preconditions with the requirements, so the two sections count as one
const sectionGroup = section => section === 'preconditions_to_confirm' ? 'requirements' : section;

const judgeCompleteness = async (items, notes, { report, bullets, metrics }) => {
  if (!bullets.length) {
    return { score: { found: [], rejected: [], unmatched: 0, ...metrics }, judgment: { items: [] } };
  }
  const refs = bullets.map(b => b.ref);
  const { output, model, usage } = await judge(
    items,
    'The review is a completeness report: whether the PR delivers what its description and linked issue promise. ' +
      'Each item has the report section it belongs to; a requirement also has the bucket it should land in (status) ' +
      'and other buckets that are acceptable. The key\'s notes for each section say how its items are matched, and ' +
      `which report items are trivial and not scored.\n\n<key_notes>\n${JSON.stringify(notes, null, 2)}\n</key_notes>`,
    `<report>\n${report}\n</report>\n\n<report_items>\n${JSON.stringify(bullets, null, 2)}\n</report_items>\n\n` +
      'The report items are the report\'s bullets, numbered in order. Return one decision per report item ref. Give ' +
      'each its section (the one it sits under in the report), and its bucket (for requirements; "none" otherwise). ' +
      'A report item matches a key item only in that item\'s ' +
      'section (requirements and preconditions_to_confirm count as one section), and a requirement only when its bucket is the status or an acceptable bucket and it meets the match rule. ' +
      'Set trivial to true only for a report item that matches nothing and either is one the key notes for its section ' +
      'say is not scored, or is a Delivered requirement that states a trivial change (an import, a rename, a file or ' +
      'test count); otherwise false.',
    decisionsSchema('items', items, {
      ref: { type: 'string', enum: refs },
      section: { type: 'string', enum: SECTIONS },
      bucket: { type: 'string', enum: [...BUCKETS, 'none'] },
      trivial: { type: 'boolean' },
    }),
  );
  checkRefs(output.items, refs);

  // Hold the judge to the section and bucket rules, so a match it gets wrong there doesn't count
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const counts = (reportItem, id) => {
    const item = byId[id];
    return sectionGroup(item.section) === sectionGroup(reportItem.section) &&
      (!item.status || [item.status, ...(item.acceptable ?? [])].includes(reportItem.bucket));
  };
  const textByRef = Object.fromEntries(bullets.map(b => [b.ref, b.text]));
  const reportItems = output.items
    .sort((a, b) => refs.indexOf(a.ref) - refs.indexOf(b.ref))
    .map(i => ({ ...i, text: textByRef[i.ref], counted: i.matches.filter(id => counts(i, id)) }));
  const ids = new Set(reportItems.flatMap(i => i.counted));
  return {
    score: {
      found: inOrder(items, ['required'], ids),
      rejected: inOrder(items, ['rejected'], ids),
      unmatched: reportItems.filter(i => !i.counted.length && !i.trivial).length,
      ...metrics,
    },
    judgment: { items: reportItems, model, usage },
  };
};

// ---- Scoring

const differences = (a, b) => JOBS.flatMap(job => SCORE_FIELDS
  .filter(field => JSON.stringify(a[job][field]) !== JSON.stringify(b[job][field]))
  .map(field => `${job}.${field}: ${JSON.stringify(a[job][field])} vs ${JSON.stringify(b[job][field])}`));

export const hasCase = caseName => existsSync(join(CASES_DIR, `${caseName}.json`));

export const readBaseline = () => existsSync(BASELINE) ? readJson(BASELINE) : undefined;

export const scoreCase = async (runDir, caseName, baseline) => {
  const kase = readJson(join(CASES_DIR, `${caseName}.json`));
  const items = caseItems(kase);
  const notes = Object.fromEntries(['requirements', 'undisclosed_changes', 'alternative_approaches']
    .filter(section => kase['completeness-review'][section]?.notes)
    .map(section => [section, kase['completeness-review'][section].notes]));
  const dir = join(runDir, caseName);
  const run = basename(runDir);
  const codeReview = loadCodeReview(join(dir, 'code-review'));
  const completeness = loadCompleteness(join(dir, 'completeness-review'));

  const passes = await Promise.all(Array.from({ length: JUDGE_PASSES }, async () => {
    const [cr, cp] = await Promise.all([
      judgeCodeReview(items.filter(i => i.job === 'code-review'), codeReview),
      judgeCompleteness(items.filter(i => i.job === 'completeness-review'), notes, completeness),
    ]);
    return {
      score: { case: caseName, run, 'code-review': cr.score, 'completeness-review': cp.score },
      judgments: { 'code-review': cr.judgment, 'completeness-review': cp.judgment },
    };
  }));
  const { score } = passes[0];
  const disagreements = passes.slice(1).flatMap((pass, i) => differences(score, pass.score)
    .map(d => `pass 1 vs pass ${i + 2}: ${d}`));
  const file = join(dir, 'score.json');
  writeFileSync(file, `${JSON.stringify({ score, judgments: passes.map(p => p.judgments), disagreements }, null, 2)}\n`);

  const summary = s => `found ${s.found.length}${s.failed ? `, failed ${s.failed.length}` : ''}, ` +
    `rejected ${s.rejected.length}, unmatched ${s.unmatched}`;
  console.log(`${run} ${caseName}: code-review ${summary(score['code-review'])}; ` +
    `completeness-review ${summary(score['completeness-review'])}; ` +
    `judge passes ${disagreements.length ? 'DISAGREE' : 'agree'} -> ${file}`);
  disagreements.forEach(d => console.log(`  ${d}`));
  const base = baseline?.runs.find(r => r.case === caseName && r.run === run);
  if (base) {
    differences(base, score).forEach(d => console.log(`  baseline vs scored: ${d}`));
  }
};

const main = async () => {
  const { values, positionals } = parseArgs({ options: { case: { type: 'string', multiple: true } }, allowPositionals: true });
  const runDirs = positionals.map(d => resolve(d));
  if (!runDirs.length) {
    throw new Error('Usage: node benchmark/ai-review/score.mjs [--case <case>]... <bench-results/run-dir>...');
  }
  const unknown = (values.case ?? []).filter(c => !hasCase(c));
  if (unknown.length) {
    throw new Error(`No case ${unknown.join(', ')} in ${CASES_DIR}`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  const work = runDirs.flatMap(runDir => readdirSync(runDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && hasCase(d.name) && (!values.case || values.case.includes(d.name)))
    .map(d => [runDir, d.name]));
  if (!work.length) {
    throw new Error(`No results for a case in ${CASES_DIR}`);
  }
  const baseline = readBaseline();
  // One case failing shouldn't lose the others' scores, which are already paid for
  await Promise.all(work.map(([runDir, caseName]) => scoreCase(runDir, caseName, baseline).catch(err => {
    console.error(`${basename(runDir)} ${caseName}: ${err.message}`);
    process.exitCode = 1;
  })));
};

// run.mjs imports scoreCase, to score each run as it completes
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

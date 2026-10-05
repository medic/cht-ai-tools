#!/usr/bin/env node
/**
 * Scores benchmark runs against the cases in cases/: an LLM judge matches each run's findings to the case's items, and
 * the score (found / failed / rejected / unmatched ids, plus metrics) is derived from those matches. See cases/README.md.
 *
 * Usage: node benchmark/ai-review/score.mjs <bench-results/run-dir>...
 *
 * Writes <run-dir>/<case>/score.json for every case the run has results for: the score, in the shape of an entry in
 * baseline.json's `runs`, and the judge's per-finding matches and usage. Prints a one-line summary per score, and when
 * baseline.json already holds a score for the same run, the differences, which is how the judge is checked.
 *
 * The judge runs twice per job, and any disagreement between the passes is printed; the score is the first pass's.
 * --passes <n> changes how many times it runs.
 *
 * --dry-run skips the judge: it prints each run's metrics and the findings that would be judged, at no cost.
 *
 * Requires ANTHROPIC_API_KEY (except with --dry-run).
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, 'cases');
const BASELINE = join(HERE, 'baseline.json');

const JUDGE_MODEL = 'claude-opus-5-5';
const JUDGE_EFFORT = 'high';

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
      depth++ || (start = i);
    } else if (c === '}' && !--depth) {
      values.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return values;
};

const caseItems = kase => {
  const cr = kase['code-review'];
  const cp = kase['completeness-review'];
  const items = [];
  const add = (list = [], job, section, kind) => list.forEach(item => items.push({ ...item, job, section, kind }));
  add(cr.required, 'code-review', null, 'required');
  add(cr.extra_credit, 'code-review', null, 'extra_credit');
  add(cr.rejected, 'code-review', null, 'rejected');
  add(cp.requirements.required, 'completeness-review', 'requirements', 'required');
  add(cp.requirements.preconditions_to_confirm, 'completeness-review', 'preconditions_to_confirm', 'required');
  add(cp.requirements.rejected, 'completeness-review', 'requirements', 'rejected');
  for (const section of ['undisclosed_changes', 'alternative_approaches']) {
    add(cp[section].required, 'completeness-review', section, 'required');
    add(cp[section].rejected, 'completeness-review', section, 'rejected');
  }
  return items;
};

// ---- Metrics, as defined in cases/README.md

const codeReviewMetrics = (ocr, run) => ({
  total_tokens: ocr.summary.total_tokens,
  tool_calls_total: ocr.tool_calls.total,
  tool_calls_failure: ocr.tool_calls.failure,
  duration_ms: run.durationMs,
});

const completenessMetrics = (messages, run) => {
  const result = messages.findLast(m => m.type === 'result');
  const blocks = type => messages.filter(m => m.type === type).flatMap(m => m.message?.content ?? []);
  return {
    total_tokens: Object.values(result?.modelUsage ?? {})
      .reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0),
    tool_calls_total: blocks('assistant').filter(b => b.type === 'tool_use').length,
    tool_calls_failure: blocks('user').filter(b => b.type === 'tool_result' && b.is_error === true).length,
    duration_ms: run.durationMs,
  };
};

// ---- The judge

const DRY_RUN = process.argv.includes('--dry-run');
const passesArg = process.argv.indexOf('--passes');
const PASSES = passesArg === -1 ? 2 : Number(process.argv[passesArg + 1]);
const client = DRY_RUN ? null : new Anthropic();

const JUDGE_SYSTEM = `You score an AI code review of one pull request against an answer key for it.

The key lists items, each with an id, a summary and a match rule. Its summaries are verified facts about the PR's code; you don't have the code, and don't need it. Required and extra-credit items are correct findings. Rejected items are known-wrong findings that reviews have made before.

For every finding you are given, list the ids of the key items it matches. A finding matches an item when it makes the item's point as the item's match rule describes, including any condition the rule sets (a reason, a bucket) and excluding the near-misses it names. Mentioning the same code, file or topic is not enough. One finding may match several items when it makes several points; many findings match one; some match none. Judge what the finding says, not whether you agree with it.

Give a one-sentence reason for each decision, naming the deciding words of the finding.`;

const judge = async (keyText, findingsText, schema) => {
  if (DRY_RUN) {
    return { output: null, model: null, usage: null };
  }
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
        // The key is the same for every run of a case, so cache it
        { type: 'text', text: keyText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: findingsText },
      ],
    }],
  }).finalMessage();
  if (message.stop_reason !== 'end_turn') {
    throw new Error(`Judge stopped with ${message.stop_reason}${message.stop_details ? `: ${JSON.stringify(message.stop_details)}` : ''}`);
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { output: JSON.parse(text), model: message.model, usage: message.usage };
};

const keyText = (items, intro) => `${intro}\n\n<key>\n${JSON.stringify(items.map(item => ({
  id: item.id,
  kind: item.kind,
  ...(item.section && { section: item.section }),
  ...(item.status && { status: item.status, acceptable: item.acceptable ?? [] }),
  summary: item.summary,
  ...(item.reason && { why_wrong: item.reason }),
  match: item.match,
})), null, 2)}\n</key>`;

const decisionSchema = (ids, extra) => ({
  type: 'object',
  additionalProperties: false,
  required: [...Object.keys(extra), 'matches', 'reason'],
  properties: {
    ...extra,
    matches: { type: 'array', items: { type: 'string', enum: ids } },
    reason: { type: 'string' },
  },
});

// ---- Code review

const scoreCodeReview = async (items, dir) => {
  const ocr = readJson(join(dir, 'ocr-result.json'));
  const run = readJson(join(dir, 'run.json'));
  items = items.filter(i => i.job === 'code-review');
  const findings = [
    ...(ocr.comments ?? []).map((c, i) => ({ ref: `posted-${i}`, posted: true, finding: c })),
    ...(ocr.tool_calls?.failure_details ?? []).filter(f => f.tool_name === 'code_comment')
      .map((f, i) => ({ ref: `failed-${i}`, posted: false, finding: f.arguments })),
  ];
  const refs = findings.map(f => f.ref);

  const { output, model, usage } = await judge(
    keyText(items, 'The review is OpenCodeReview\'s comments on the PR.'),
    `<findings>\n${JSON.stringify(findings.map(f => ({ ref: f.ref, finding: f.finding })), null, 2)}\n</findings>\n\n` +
      'Return one decision per finding ref. A "failed" finding holds the raw arguments of a comment call that failed to ' +
      'post; it may contain several comments, so match every point in it.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['decisions'],
      properties: {
        decisions: { type: 'array', items: decisionSchema(items.map(i => i.id), { ref: { type: 'string', enum: refs } }) },
      },
    },
  );
  if (DRY_RUN) {
    return { score: codeReviewMetrics(ocr, run), judgment: { findings } };
  }
  const decisions = output.decisions;
  const returned = decisions.map(d => d.ref).sort();
  if (JSON.stringify(returned) !== JSON.stringify([...refs].sort())) {
    throw new Error(`Judge returned decisions for ${returned.join(', ')}, expected ${refs.join(', ')}`);
  }

  const kindOf = Object.fromEntries(items.map(i => [i.id, i.kind]));
  const matched = posted => new Set(decisions
    .filter(d => findings.find(f => f.ref === d.ref).posted === posted)
    .flatMap(d => d.matches));
  const postedIds = matched(true);
  const failedIds = matched(false);
  const inOrder = (kinds, ids) => items.filter(i => kinds.includes(i.kind) && ids.has(i.id)).map(i => i.id);
  return {
    score: {
      found: inOrder(['required', 'extra_credit'], postedIds),
      failed: inOrder(['required', 'extra_credit'], new Set([...failedIds].filter(id => !postedIds.has(id)))),
      rejected: inOrder(['rejected'], postedIds),
      unmatched: decisions.filter(d => d.ref.startsWith('posted-') && !d.matches.length).length,
      ...codeReviewMetrics(ocr, run),
    },
    judgment: { decisions, model, usage },
  };
};

// ---- Completeness review

const scoreCompleteness = async (items, dir) => {
  const messages = readJsonStream(join(dir, 'execution.jsonl'));
  const run = readJson(join(dir, 'run.json'));
  const reportFile = join(dir, 'report.md');
  const report = existsSync(reportFile)
    ? readFileSync(reportFile, 'utf8')
    : messages.findLast(m => m.type === 'result')?.structured_output?.report_markdown;
  if (!report) {
    throw new Error(`No report in ${dir}`);
  }
  items = items.filter(i => i.job === 'completeness-review');

  const { output, model, usage } = await judge(
    keyText(items, 'The review is a completeness report: whether the PR delivers what its description and linked ' +
      'issue promise. Each item has the report section it belongs to; a requirement also has the bucket it should land ' +
      'in (status) and other buckets that are acceptable.'),
    `<report>\n${report}\n</report>\n\n` +
      'Split the report into its items: every bullet under Requirements, Preconditions to confirm, Undisclosed Changes ' +
      'and Alternative Approaches. Skip a section that says "None". Give each item its section, its bucket (for ' +
      'requirements; "none" otherwise), and its opening words as text. An item matches a key item only in that item\'s ' +
      'section, and a requirement only when its bucket is the status or an acceptable bucket and it meets the match rule. ' +
      'Set trivial to true only for a Delivered requirement that matches nothing and restates a trivial bullet of the PR ' +
      'description (an import, a rename, a file or test count); otherwise false.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: decisionSchema(items.map(i => i.id), {
            section: { type: 'string', enum: SECTIONS },
            bucket: { type: 'string', enum: [...BUCKETS, 'none'] },
            text: { type: 'string' },
            trivial: { type: 'boolean' },
          }),
        },
      },
    },
  );

  // Hold the judge to the section and bucket rules, so a match it gets wrong there doesn't count
  if (DRY_RUN) {
    return { score: completenessMetrics(messages, run), judgment: { report } };
  }
  // A case keeps rejected preconditions with the requirements, so the two sections count as one
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const sectionGroup = section => section === 'preconditions_to_confirm' ? 'requirements' : section;
  const valid = (item, id) => {
    const keyItem = byId[id];
    return sectionGroup(keyItem.section) === sectionGroup(item.section) &&
      (!keyItem.status || [keyItem.status, ...(keyItem.acceptable ?? [])].includes(item.bucket));
  };
  const reportItems = output.items.map(item => ({ ...item, counted: item.matches.filter(id => valid(item, id)) }));
  const ids = new Set(reportItems.flatMap(i => i.counted));
  const inOrder = kinds => items.filter(i => kinds.includes(i.kind) && ids.has(i.id)).map(i => i.id);
  return {
    score: {
      found: inOrder(['required']),
      rejected: inOrder(['rejected']),
      unmatched: reportItems.filter(i => !i.counted.length && !i.trivial).length,
      ...completenessMetrics(messages, run),
    },
    judgment: { items: reportItems, model, usage },
  };
};

// ---- Comparing scores

const SCORE_FIELDS = ['found', 'failed', 'rejected', 'unmatched'];

const differences = (a, b) => ['code-review', 'completeness-review'].flatMap(job => SCORE_FIELDS
  .filter(field => JSON.stringify(a[job]?.[field]) !== JSON.stringify(b[job]?.[field]))
  .map(field => ({ field: `${job}.${field}`, a: a[job]?.[field], b: b[job]?.[field] })));

const baselineScore = entry => existsSync(BASELINE)
  ? readJson(BASELINE).runs.find(r => r.case === entry.case && r.run === entry.run)
  : undefined;

const main = async () => {
  const runDirs = process.argv.slice(2)
    .filter((a, i, args) => a !== '--dry-run' && a !== '--passes' && args[i - 1] !== '--passes')
    .map(d => resolve(d));
  if (!runDirs.length) {
    throw new Error('Usage: node benchmark/ai-review/score.mjs <bench-results/run-dir>...');
  }
  if (!Number.isInteger(PASSES) || PASSES < 1) {
    throw new Error('--passes takes a whole number of at least 1');
  }
  if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const work = runDirs.flatMap(runDir => readdirSync(runDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(CASES_DIR, `${d.name}.json`)))
    .map(d => ({ runDir, caseName: d.name })));
  if (!work.length) {
    throw new Error(`No results for a case in ${CASES_DIR}`);
  }

  await Promise.all(work.map(async ({ runDir, caseName }) => {
    const items = caseItems(readJson(join(CASES_DIR, `${caseName}.json`)));
    const dir = join(runDir, caseName);
    const run = basename(runDir);
    console.error(`${run} ${caseName}: judging`);
    const passes = await Promise.all(Array.from({ length: DRY_RUN ? 1 : PASSES }, async () => {
      const [cr, cp] = await Promise.all([
        scoreCodeReview(items, join(dir, 'code-review')),
        scoreCompleteness(items, join(dir, 'completeness-review')),
      ]);
      return {
        score: { case: caseName, run, 'code-review': cr.score, 'completeness-review': cp.score },
        judgments: { 'code-review': cr.judgment, 'completeness-review': cp.judgment },
      };
    }));
    const [{ score, judgments }, ...otherPasses] = passes;
    if (DRY_RUN) {
      console.log(JSON.stringify({ ...score, judgments }, null, 2));
      return;
    }

    const disagreements = otherPasses.map((pass, i) => ({ pass: i + 2, differences: differences(score, pass.score) }))
      .filter(d => d.differences.length);
    const file = join(dir, 'score.json');
    writeFileSync(file, `${JSON.stringify({
      score,
      judgments,
      ...(otherPasses.length && { other_passes: otherPasses, disagreements }),
    }, null, 2)}\n`);

    const counts = s => `found ${s.found.length}${s.failed ? `, failed ${s.failed.length}` : ''}, ` +
      `rejected ${s.rejected.length}, unmatched ${s.unmatched}`;
    const agreement = otherPasses.length ? `; ${PASSES} judge passes ${disagreements.length ? 'DISAGREE' : 'agree'}` : '';
    console.log(`${run} ${caseName}: code-review ${counts(score['code-review'])}; ` +
      `completeness-review ${counts(score['completeness-review'])}${agreement} -> ${file}`);
    for (const { pass, differences: diffs } of disagreements) {
      for (const d of diffs) {
        console.error(`  ${d.field}: pass 1 ${JSON.stringify(d.a)}, pass ${pass} ${JSON.stringify(d.b)}`);
      }
    }
    const base = baselineScore(score);
    for (const d of base ? differences(base, score) : []) {
      console.error(`  ${d.field}: baseline ${JSON.stringify(d.a)}, scored ${JSON.stringify(d.b)}`);
    }
  }));
};

await main();

# ai-review benchmark cases

Each file here is the answer key for one PR: what a review of it should find, and how the reviews performed when the key was made. The key is named like the PR's results directory (`<owner>__<repo>__<pr>.json`), and runs are scored by matching their findings to its ids.

[`medic__cht-core__11263.json`](medic__cht-core__11263.json) is the worked example for everything below.

## Choosing a PR

The review has to be a fair test, so the PR must not give its findings away.

- **Closed without merging** is the easiest. Nothing lands on the base branch and nothing is fixed afterwards.
- **Merged** works, since the diff starts at the merge-base with the PR's `base.sha`. Check the PR's comments and reviews first: the completeness review reads them, and a human review, or an earlier `ai-review` run, hands it the answers.
- **Your own test PRs** belong on a fork, so nothing is posted to the real repo. The fork must contain `OCR_RULES_SHA` (see [`run.mjs`](../run.mjs)), which the code review checks out for its rules. Write the PR description and link its issue before closing it, because the completeness review reads whatever is there when the benchmark runs.

A PR with a few real defects and a linked issue makes the most useful case. It's also worth covering cases with nothing to find (to catch false positives), with a real undisclosed change, and with a real precondition such as a new environment variable.

## Producing the baseline

### 1. Run the benchmark several times

```bash
npm run bench:ai-review -- medic/cht-core#11263
```

Run it at least three times, without changing the benchmark, the skill or the image in between. Both jobs give different findings and use very different numbers of tokens from run to run, so a single run can't be a baseline. Check every run's `run.json` before using it:

- `exitCode` is 0 for both jobs.
- `versions` and `config` are the same across the runs, and `versions.chtAiTools.dirty` is `false`. If it's `true`, the runs measured uncommitted changes and can't be reproduced from the commit.

### 2. Collect the findings

The examples below are bash, with these set:

```bash
CASE=medic__cht-core__11263
RUNS="2026-10-05T14-57-09 2026-10-05T15-07-06 2026-10-05T15-21-34"
```

**Code review.** The comments OCR posted, and the ones that failed to post:

```bash
for r in $RUNS; do
  jq -r --arg r "$r" '.comments[] | "\($r)\t\(.severity)\t\(.path):\(.start_line)\n\(.content)\n"' \
    "bench-results/$r/$CASE/code-review/ocr-result.json"
done
for r in $RUNS; do
  jq -r --arg r "$r" '.tool_calls.failure_details[] | select(.tool_name == "code_comment") | "\($r)\tFAILED\t\(.file_path)\n\(.arguments)\n"' \
    "bench-results/$r/$CASE/code-review/ocr-result.json"
done
```

A comment fails to post when the model sends `code_comment` badly formed arguments, and OCR drops it after retrying. Such a finding never reaches the PR, but read it anyway: a correct one still belongs in the key (step 3).

**Completeness review.** Read each run's `completeness-review/report.md`, section by section: Requirements (with its Preconditions to confirm), Undisclosed Changes and Alternative Approaches. The headings' level varies between runs, so don't rely on it.

### 3. Verify each finding and group them

Check every finding against the code at the PR head (`commits.head` in the key), not against what the review says. Reviews are confidently wrong in details: on 11263 one OCR run said stubs overwrote `@medic/infodoc` when they were on the controller's exports. Settle each one as correct or not by reading the code, and check claims about library behaviour (e.g. that `res.json()` keeps an existing `Content-Type`) rather than trusting them.

Then group findings that make the same point. Runs word, split and place the same finding differently, so one key item usually covers several comments. Keep apart findings that sit on the same lines but make different points. On 11263, "the stubs are on the wrong object" and "the stubs are never restored" are two items, though both point at the same assignment.

### 4. Write the code-review key

- `required`: every correct finding a good review should make. Include findings whose comment failed to post in some runs. When a run is scored, only posted comments count.
- `extra_credit`: correct findings a review earns credit for, but isn't marked down for missing. These are usually right about the code but out of scope or unlikely to matter: a pre-existing problem the PR didn't cause, an input that can't realistically occur, or a disagreement with a choice the PR states. On 11263 these were `null-body-throws`, `audit-skipped-on-parse-failure` and `hardcoded-502`.
- A finding that is wrong goes in neither list.
- `severity` is OCR's own: the most common severity across the runs that reported the finding, the higher one on a tie. A finding that only ever failed to post has no severity of OCR's to use: take the one in the failed call's `arguments` if it has one, and otherwise pick one and say so in `notes`.

### 5. Write the completeness-review key

One object per report section, each with a `required` list:

- `requirements.required`: every requirement in the PR description and its linked issue, with the bucket it should land in (`status`: `Delivered`, `Not delivered` or `Pending verification`). Where another bucket is also a reasonable answer, list it in `acceptable`. Decide the buckets yourself from the code. Don't copy a run's report, since runs disagree.
- `requirements.preconditions_to_confirm`: operational facts the change depends on (secrets, environment variables, external services). Leave it empty when there are none. A precondition a run invents, such as a dependency the codebase already uses everywhere, doesn't belong here.
- `undisclosed_changes.required`: changes the PR makes but doesn't describe. Walk every changed file. Empty means the report should say "None".
- `alternative_approaches.required`: existing code in the repo that would solve the problem better, cited by path.

Runs split and merge requirements differently. Say in the section's `notes` that a report item may cover several key items.

### 6. Write `summary`, `locations` and `match` for every item

- `summary`: what the finding is, why it matters, and what makes it true, in enough detail to judge a run against it without reopening the code.
- `locations`: the `path:line`s at the PR head that show it.
- `match`: what a review must say to count as finding it, and which near-misses don't count. Write a near-miss in when a run made one, or when another item sits on the same lines, and name the other item: "Only saying they should use sinon.stub so sinon.restore() undoes them is not a match: that is infodoc-stubs-not-restored." For a requirement, say which bucket matches and why.

### 7. Record the metrics

Each job holds `min`, `max` and `average` over the baseline runs for `total_tokens`, `tool_calls_total`, `tool_calls_failure` and `duration_ms`. Averages are rounded to whole numbers.

**Code review**, from OCR's `summary.total_tokens`, `tool_calls.total` and `tool_calls.failure`, and the job's `run.json`:

```bash
STATS='def stats: {min: min, max: max, average: (add / length | round)};'
for r in $RUNS; do
  f="bench-results/$r/$CASE/code-review"
  jq -c --slurpfile run "$f/run.json" '{
    total_tokens: .summary.total_tokens,
    tool_calls_total: .tool_calls.total,
    tool_calls_failure: .tool_calls.failure,
    duration_ms: $run[0].durationMs
  }' "$f/ocr-result.json"
done | jq -s "$STATS"' {
  total_tokens: map(.total_tokens) | stats,
  tool_calls_total: map(.tool_calls_total) | stats,
  tool_calls_failure: map(.tool_calls_failure) | stats,
  duration_ms: map(.duration_ms) | stats
}'
```

**Completeness review**, from `execution.jsonl` and the job's `run.json`:

- `total_tokens` sums every model's input, output and cache tokens in the `modelUsage` of the final `result`. That includes the small Haiku calls Claude Code makes, which `usage` leaves out.
- `tool_calls_total` counts the `tool_use` blocks, including the final `StructuredOutput`.
- `tool_calls_failure` counts the `tool_result`s with `is_error`. Every run has at least one: the Bash hook blocks any command other than the skill's two scripts, and Claude usually tries a `sed` once.

The file is read with `jq -s` rather than line by line, so it still parses if an editor has pretty-printed it.

```bash
STATS='def stats: {min: min, max: max, average: (add / length | round)};'
for r in $RUNS; do
  f="bench-results/$r/$CASE/completeness-review"
  jq -s -c --slurpfile run "$f/run.json" '{
    total_tokens: (map(select(.type == "result")) | last | [.modelUsage[] | .inputTokens + .outputTokens + .cacheReadInputTokens + .cacheCreationInputTokens] | add),
    tool_calls_total: [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")] | length,
    tool_calls_failure: [.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .is_error == true)] | length,
    duration_ms: $run[0].durationMs
  }' "$f/execution.jsonl"
done | jq -s "$STATS"' {
  total_tokens: map(.total_tokens) | stats,
  tool_calls_total: map(.tool_calls_total) | stats,
  tool_calls_failure: map(.tool_calls_failure) | stats,
  duration_ms: map(.duration_ms) | stats
}'
```

### 8. Record what the baseline ran with

Copy from any of the runs' `run.json` (they're the same, per step 1):

- `baseline.runs`: the run directories the key and its metrics were drawn from.
- `baseline.versions`: the `versions` object, without `dirty`.
- Each job's `config`: its `config` object.

```bash
f="bench-results/$(echo $RUNS | cut -d' ' -f1)/$CASE"
jq '{versions: (.versions | del(.chtAiTools.dirty)), config}' "$f/code-review/run.json"
jq '{config}' "$f/completeness-review/run.json"
```

Runs made before `run.json` had `versions` (like 11263's) need these filled in by hand: the tool versions from OCR's `manifest.execution` and the `system` `init` message in `execution.jsonl`, and the cht-ai-tools commit from when the runs were made.

## Key format

```
pr, title, issue, commits {base, head}, notes
baseline           runs, versions
code-review        notes, config, <metrics>, required[], extra_credit[]
completeness-review
                   config, <metrics>,
                   requirements {notes, required[], preconditions_to_confirm[]},
                   undisclosed_changes {notes, required[]},
                   alternative_approaches {required[]}
```

- `<metrics>`: `total_tokens`, `tool_calls_total`, `tool_calls_failure` and `duration_ms`, each `{min, max, average}`.
- Every item has `id`, `summary`, `locations` and `match`. Code-review items also have `severity`. Requirement items also have `status`, and `acceptable` where more than one bucket is right.

## Updating a key

A finding in a later run that matches no item is new. Verify it against the code like any other (step 3), and add it to `required` or `extra_credit`, or leave it out if it's wrong. Rebuild the metrics and `baseline` only when the whole baseline is rerun, for example after bumping a tool version, a model or `OCR_RULES_SHA`.

# ai-review benchmark cases

Each file here is the gold standard for one PR: what a review of it should find, what earns extra credit, and what is known to be wrong. It records facts about the PR, so it doesn't change when the tools do. The file is named like the PR's results directory (`<owner>__<repo>__<pr>.json`).

How the current configuration scores against the cases is kept separately, in [`../baseline.json`](../baseline.json) (see [The baseline](#the-baseline)).

[`medic__cht-core__11263.json`](medic__cht-core__11263.json) is the worked example for everything below.

## Choosing a PR

The review has to be a fair test, so the PR must not give its findings away.

- **Closed without merging** is the easiest. Nothing lands on the base branch and nothing is fixed afterwards.
- **Merged** works, since the diff starts at the merge-base with the PR's `base.sha`. Check the PR's comments and reviews first: the completeness review reads them, and a human review, or an earlier `ai-review` run, hands it the answers.
- **Your own test PRs** belong on a fork, so nothing is posted to the real repo. The fork must contain `OCR_RULES_SHA` (see [`run.mjs`](../run.mjs)), which the code review checks out for its rules. Write the PR description and link its issue before closing it, because the completeness review reads whatever is there when the benchmark runs.

A PR with a few real defects and a linked issue makes the most useful case. It's also worth covering cases with nothing to find (to catch false positives), with a real undisclosed change, with a real precondition such as a new environment variable, and with defects outside test files (7 of 11263's 9 required code-review findings are about its tests).

The PR is read live on every run, so anyone commenting on it later changes the input. Bots kept commenting on 11263 after it closed.

## Building a case

### 1. Run the benchmark several times

```bash
npm run bench:ai-review -- medic/cht-core#11263
```

Run it at least three times, without changing the benchmark, the skill or the image in between. Both jobs give different findings from run to run, so one run shows only part of what a review can find. Check every run's `run.json` before using it:

- `exitCode` is 0 for both jobs.
- `versions` and `config` are the same across the runs, and `versions.chtAiTools.dirty` is `false`. If it's `true`, the runs measured uncommitted changes and can't be reproduced from the commit.

These runs can also become the baseline's runs for the case (see [The baseline](#the-baseline)).

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

A `code_comment` call fails when the model sends it badly formed arguments. OCR retries, and a failed call may hold several comments. Compare each failed call with the run's posted comments before treating anything in it as lost: the same comment is often retried several times (all three of 14-57-09's failures were one comment), and a retry may succeed (15-21-34's failed infodoc.spec.js call held two comments that were then posted). A finding that never posted never reaches the PR, but read it anyway: a correct one still belongs in the case (step 4).

**Completeness review.** Read each run's `completeness-review/report.md`, section by section: Requirements (with its Preconditions to confirm), Undisclosed Changes and Alternative Approaches. The headings' level varies between runs, so don't rely on it.

### 3. Verify each finding and group them

Check every finding against the code at the PR head (`commits.head`), not against what the review says. Reviews are confidently wrong in details: on 11263 one OCR run said stubs overwrote `@medic/infodoc` when they were on the controller's exports. Settle each one as correct or wrong by reading the code, and check claims about library behaviour (e.g. that `res.json()` keeps an existing `Content-Type`) rather than trusting them.

Follow each finding to its consequence, and check the PR's own story too. On 11263 no run said the misplaced stubs make the real `@medic/infodoc` call `db.sentinel`, which the unit-test environment answers with `process.exit(1)`, ending the whole test run. And the PR and issue describe the old behaviour as a hang, when it was a crash of the API process.

Then group findings that make the same point. Runs word, split and place the same finding differently, so one item usually covers several comments. Keep apart findings that sit on the same lines but make different points. On 11263, "the stubs are on the wrong object" and "the stubs are never restored" are two items, though both point at the same assignment, and one comment in 14-57-09 makes both.

If the runs will become the baseline's, keep a note of which run's findings went to which item. Scoring them later needs it.

### 4. Write the code-review section

Start with the PR's identity: `pr` (`owner/repo#number`), `title`, `issue` (from the PR description's closing keyword, e.g. "Fixed #11304"), and `commits`. `commits.base` is the merge-base the code review diffed from (`range.from` in the code-review `run.json`, or OCR's `manifest.input.resolved_base`) and `commits.head` the PR head. `notes` says why the PR is a fair test, e.g. that its comments were checked and give nothing away.

- `required`: correct findings a review should make because they show the PR is broken or doesn't do what it claims: a defect, a test that can't test what it says, a response that breaks the API's conventions. Include findings whose comment failed to post in some runs.
- `extra_credit`: correct findings a review earns credit for, but isn't marked down for missing: a pre-existing problem the PR didn't cause, an input that can't realistically occur, a true point with no real consequence, or a disagreement with a choice the PR states. On 11263 these are `null-body-throws`, `audit-skipped-on-parse-failure`, `hardcoded-502`, `infodoc-skip-on-parse-failure` (all disagreements or unlikely inputs) and `infodoc-stubs-not-restored` (true, but nothing reads the leftover property). A stated choice can still be `required` when the concern is concrete: 11263 keeps `body-preview-logged`, because a truncated response from that handler can begin with patient data. Say why in its summary.
- `rejected` (optional): findings reviews have made that are wrong, so they're recognised when they come back and needn't be judged again.
- `severity` on `required` and `extra_credit` items: the severity the finding deserves, taken from OCR's own ratings. Use the most common across the runs that reported it, the higher one on a tie. A comment that covers several items gives its severity only to the item that is its main point. A finding that only ever failed to post takes the `severity` in the failed call's `arguments`.

### 5. Write the completeness-review section

One object per report section, each with a `required` list and an optional `rejected` list:

- `requirements.required`: every requirement the PR states, with the bucket it should land in (`status`: `Delivered`, `Not delivered` or `Pending verification`). Take them from the same sources the skill does: the PR description, its linked issue, and the PR's comments and reviews. Where another bucket is also a reasonable answer, list it in `acceptable`, and say in `match` when it counts. Decide the buckets yourself from the code. Don't copy a run's report, since runs disagree.
- `requirements.preconditions_to_confirm`: operational facts the change depends on (secrets, environment variables, external services). Leave it empty when there are none.
- `undisclosed_changes.required`: changes the PR makes but doesn't describe. Walk every changed file. Empty means the report should say "None".
- `alternative_approaches.required`: existing code in the repo that would solve the problem better, cited by path.
- `rejected`, in the section where the wrong finding appeared. On 11263, an invented `@medic/logger` precondition goes in `requirements.rejected`, and the unused test declarations reported as an undisclosed change go in `undisclosed_changes.rejected`.

Don't make one requirement two items because the report usually splits it, and don't add an item that can only be met by meeting another. On 11263, "the request completes" is part of `routing-responds-502`, since the 502 is how it completes. Report items for trivial PR bullets (an import, a rename, a test count) match nothing, aren't scored, and needn't be in the case. Say so in the section's `notes`.

### 6. Write each item

Every item has an `id` and:

- `summary`: what the finding is, why it matters, and what makes it true, in enough detail to judge a run against it without reopening the code. For a `rejected` item, the wrong claim as reviews make it.
- `locations` (not on `rejected` items): the `path:line`s at the PR head that show it: the line with the problem, not the start of a comment's range.
- `reason` (`rejected` items only): why the claim is wrong.
- `match`: what a review must say to count as making this finding, and which near-misses don't count. Write a near-miss in when a run made one, or when another item sits on the same lines, and name the other item: "Only saying they should use sinon.stub so sinon.restore() undoes them is not a match: that is infodoc-stubs-not-restored." For a requirement, say which bucket matches and why. A `match` must require the item's own point. Don't let finding another item count as finding this one.

## Scoring a run

Scoring a run against a case produces one score per job:

- **`code-review`:**
  - `found`: the `required` and `extra_credit` ids its posted comments match.
  - `failed`: ids matched only by comments in `tool_calls.failure_details`. These never reached the PR, so they aren't in `found`.
  - `rejected`: the `rejected` ids its comments match.
  - `unmatched`: the number of posted comments that match nothing.
- **`completeness-review`:**
  - `found`: the `required` ids its report matches, across all sections, in an accepted bucket.
  - `rejected`: the `rejected` ids it matches.
  - `unmatched`: the number of report items that match nothing and claim something. That means a requirement in an unaccepted bucket, or a precondition, undisclosed change or alternative the case doesn't list. Trivial Delivered items aren't counted.
- **Both jobs:** the metrics `total_tokens`, `tool_calls_total`, `tool_calls_failure` and `duration_ms`.

Matching rules:
- A finding matches an item when it meets the item's `match`. One finding may match several items (e.g. a comment making two points), and an item is found when any finding matches it.
- When a report puts one requirement in two buckets, the accepted one counts.
- A finding needn't cite the item's `locations`. The run's severity isn't compared with the case's.
- Unmatched findings are for a human to judge. A correct one is added to the case's `required` or `extra_credit`, a wrong one to `rejected`.
- When an LLM judge does the matching, check it first: on the baseline's runs it should reproduce their `found`, `failed` and `rejected` lists.

### Metrics

**Code review**, from OCR's `summary.total_tokens`, `tool_calls.total` and `tool_calls.failure`, and the job's `run.json`. `tool_calls_failure` counts failed tool calls, retries included, not lost comments.

```bash
f="bench-results/$r/$CASE/code-review"
jq -c --slurpfile run "$f/run.json" '{
  total_tokens: .summary.total_tokens,
  tool_calls_total: .tool_calls.total,
  tool_calls_failure: .tool_calls.failure,
  duration_ms: $run[0].durationMs
}' "$f/ocr-result.json"
```

**Completeness review**, from `execution.jsonl` and the job's `run.json`:

- `total_tokens` sums every model's input, output and cache tokens in the `modelUsage` of the final `result`. That includes the small Haiku calls Claude Code makes, which `usage` leaves out.
- `tool_calls_total` counts the `tool_use` blocks, including the final `StructuredOutput`.
- `tool_calls_failure` counts the `tool_result`s with `is_error`. Every 11263 run has at least one from the Bash hook, which blocks any command other than the skill's two scripts as written: two runs piped `pr-diff.sh` into `head`, one tried `sed`. So the count mostly reflects the harness, not the review.

The file is read with `jq -s` rather than line by line, so it still parses if an editor has pretty-printed it.

```bash
f="bench-results/$r/$CASE/completeness-review"
jq -s -c --slurpfile run "$f/run.json" '{
  total_tokens: (map(select(.type == "result")) | last | [.modelUsage[] | .inputTokens + .outputTokens + .cacheReadInputTokens + .cacheCreationInputTokens] | add),
  tool_calls_total: [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")] | length,
  tool_calls_failure: [.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .is_error == true)] | length,
  duration_ms: $run[0].durationMs
}' "$f/execution.jsonl"
```

## The baseline

[`../baseline.json`](../baseline.json) holds the scores of the current configuration: what it ran with, and one entry per scored run.

```
notes
versions           ocr, claudeCode, chtAiTools {commit}
config             code-review {model, extraBody, effort, rulesSha}, completeness-review {model}
runs[]             case, run,
                   code-review          {found[], failed[], rejected[], unmatched, <metrics>}
                   completeness-review  {found[], rejected[], unmatched, <metrics>}
```

It's committed. When a change is deliberately adopted (a new skill version, model, tool version or `OCR_RULES_SHA`), score fresh runs of every case with the new configuration and replace the file. Git history keeps the old one.

### Recording it

Score at least three runs per case with the configuration, as in [Scoring a run](#scoring-a-run). Copy `versions` (without `dirty`) and each job's `config` from any of the runs' `run.json`; they're the same across runs, per step 1:

```bash
f="bench-results/$(echo $RUNS | cut -d' ' -f1)/$CASE"
jq '{versions: (.versions | del(.chtAiTools.dirty)), config}' "$f/code-review/run.json"
jq '{config}' "$f/completeness-review/run.json"
```

For runs made before `run.json` had `versions`, like 11263's, these commands print `null`. Fill the values in by hand from:
- **OCR version:** `manifest.execution.ocr_version` in `ocr-result.json`. Copy it as written, e.g. `v1.12.9`.
- **Claude Code version:** `claude_code_version` in the `system` `init` message of `execution.jsonl`.
- **cht-ai-tools commit:** the commit from when the runs were made.

Say in `notes` that whether the tree was dirty is unknown.

### Comparing against it

Score the same number of runs per case with the candidate configuration, and compare:

- **Per item:** how many runs found it (e.g. 3/3 in the baseline, 0/3 now).
- **Per run:** how many `required` and `extra_credit` items were found, and the `rejected` and `unmatched` counts.
- **Metrics:** each against the baseline runs' spread.

A `required` item the baseline found in every run dropping to none, or `rejected`/`unmatched` rising, is a signal. One run's total moving by one or two isn't: with three runs, a new run often lands outside the baseline's range by chance. Findings come first. Tokens, tool calls and duration are secondary.

## Case format

```
pr, title, issue, commits {base, head}, notes
code-review        notes, required[], extra_credit[], rejected[]?
completeness-review
                   requirements {notes, required[], preconditions_to_confirm[], rejected[]?},
                   undisclosed_changes {notes, required[], rejected[]?},
                   alternative_approaches {required[], rejected[]?}
```

- `required` and `extra_credit` items have `id`, `summary`, `locations` and `match`. Code-review ones also have `severity`. Requirement ones also have `status`, and `acceptable` where more than one bucket is right.
- `rejected` items have `id`, `summary`, `reason` and `match`.

## Updating a case

A finding in a later run that matches no item is new. Verify it against the code like any other (step 3), and add it to `required`, `extra_credit` or `rejected`. Adding to `required` changes what every run is scored against. Rescore the baseline's runs, so the baseline and later runs are scored against the same case.

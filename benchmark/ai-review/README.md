# ai-review benchmark

Runs the two review jobs of the cht-core [`ai-review` workflow](https://github.com/medic/cht-core/pull/11427) locally, against a set of PRs, and collects their raw output instead of posting it to the PR. Use it to compare changes to the `cht-pr-review` skill, the workflow config, or the `.opencodereview` rules.

| Workflow job          | Action                          | What the benchmark runs                                                                                                                                |
|-----------------------|---------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `code-review`         | `alibaba/open-code-review`      | The action's `ocr config set …` and `ocr review …` commands, with its input defaults, on a checkout of the PR's base commit                            |
| `completeness-review` | `anthropics/claude-code-action` | `claude plugin marketplace add` / `plugin install`, then `claude -p <prompt> <claude_args>` in agent mode, on a checkout of the PR head                 |

The step inputs (models, effort, prompt, `claude_args`, plugins, …) come from the workflow file itself. By default that is `ai-review.yml` on the `11346-add-ai-review` branch of `medic/cht-core`. The tool versions come from the workflow too: `ocr_version`, and the Claude Code version that the pinned `claude-code-action` SHA installs. Both tools run in a container image built from [`Dockerfile`](Dockerfile), with `HOME=/home/runner` so the plugin cache paths in `--allowedTools` resolve the same way they do on the runner.

## Requirements

- Node 18+, `git`, and `gh` (logged in; `gh auth token` supplies `GH_TOKEN`)
- `docker` or `podman`
- `ANTHROPIC_API_KEY` (or whatever secret names the workflow references, e.g. `ANTHROPIC_AUTH_TOKEN`)

## Usage

```bash
npm install
export ANTHROPIC_API_KEY=...

# Every case in cases.json, once
npm run bench:ai-review

# One PR, three times each, to measure variance
npm run bench:ai-review -- --pr medic/cht-core#11427 --runs 3 --label baseline

# Only the completeness review, against the skill as it is in this checkout (the default)
npm run bench:ai-review -- --jobs completeness-review --label skill-tweak

# A local edit of the workflow and of the OCR rules
npm run bench:ai-review -- --workflow ../cht-core/.github/workflows/ai-review.yml --ocr-config ../cht-core/.opencodereview
```

Run `node benchmark/ai-review/run.mjs --help` for all options.

### Cases

[`cases.json`](cases.json) lists the PRs to review. Each case can pin `head` and `base` SHAs so repeated benchmarks review exactly the same diff. Otherwise they come from the PR's current `head.sha` and `base.sha`. The PR description, comments, and linked issues are always read live from GitHub by the skill.

```json
{ "cases": [{ "repo": "medic/cht-core", "pr": 11427, "head": "<sha>", "base": "<sha>", "notes": "…" }] }
```

## Output

```
bench-results/
  .cache/repos/            bare clones shared across runs
  <timestamp>[-label]/
    manifest.json          workflow source, action/tool versions, cht-ai-tools SHA + dirty files, options, resolved PRs
    ai-review.yml          the workflow that was benchmarked
    marketplace/           snapshot of the plugins that were installed (for --marketplace local)
    summary.json           one entry per case × run × job
    <case>/run-<n>/
      code-review/         invocation.json, ocr-result.json, ocr-stderr.log, ocr-version.txt, summary.json
      completeness-review/ invocation.json, execution.json (the action's execution_file), execution.jsonl,
                           structured_output.json, report.md, claude-stderr.log, summary.json
```

The completeness `summary.json` records cost, turns, token usage, tool-use counts, and any `permission_denials`. A denial usually means the workflow's `--allowedTools` no longer matches what the skill calls.

## Differences from CI

- Nothing is posted to GitHub. The `post-review` job, and the OCR action's step that turns `ocr-result.json` into PR comments, are not run.
- The OCR action checks out the base branch tip when the label is added. The benchmark checks out the PR's `base.sha` instead, so results are reproducible. The `.opencodereview` config is replaced with the one at `--workflow-ref` (or `--ocr-config`), because the rules under test are usually not on the base branch yet.
- `claude-code-action` drives Claude Code through the Agent SDK. The benchmark calls the same Claude Code version through the CLI (`-p --output-format stream-json`), which uses the same default system prompt and setting sources.
- `GH_TOKEN` is your own token, not the job's scoped `GITHUB_TOKEN`.
- Telemetry env (`OTEL_*`, `*_TELEMETRY`) is dropped unless you pass `--telemetry`. With `--telemetry`, the secrets it references are read from same-named env vars, and `deployment.environment.name` is set to `benchmark`.

# ai-review benchmark

Runs the two review jobs of the cht-core [`ai-review` workflow](https://github.com/medic/cht-core/blob/master/.github/workflows/ai-review.yml) against PRs and saves their raw output, instead of posting it to the PR.

- `code-review`: OpenCodeReview, configured and invoked the way the `alibaba/open-code-review` action does it. The workflow checks out the base branch only for its `.opencodereview` rules (OCR reads the code itself at the PR head), so the benchmark checks out a pinned cht-core commit instead (`OCR_RULES_SHA` in `run.mjs`), keeping the rules the same across runs and PRs. The diff starts at the merge-base with the PR's `base.sha`, so closed and merged PRs work too.
- `completeness-review`: Claude Code with the `cht-pr-review` and `cht-docs-mcp` plugins, using the workflow's prompt, settings and `claude_args`, on the PR head. The image installs the plugins from this checkout, so local changes to the skill are what gets run.

The config is copied by hand from the workflow on `master`. The tool versions, fixed OCR settings, Claude settings ([`claude-settings.json`](claude-settings.json)) and plugins are baked into the image by the [`Dockerfile`](Dockerfile). The models, prompt and per-run options are at the top of [`run.mjs`](run.mjs). The image is built from the repo root on every run, which is quick when nothing has changed. The plugins load from `/opt/cht-ai-tools` rather than the plugin cache, so the script paths in `--allowedTools` and the settings' Bash hook point there instead of where the workflow points them.

## Usage

Requires `docker`, `git`, `ANTHROPIC_API_KEY`, and `GITHUB_TOKEN` (used to read the PR, and by the skill's `gh` calls in the container; a read-only token matches CI).

```bash
ANTHROPIC_API_KEY=$(op read "op://Private/platform.claude.com/password") GITHUB_TOKEN=$(op read "op://Private/GitHub/medic_token_readonly") npm run bench:ai-review -- medic/cht-core#10757

```

Output goes to `bench-results/<timestamp>/`:

```
<owner>__<repo>__<pr>/
  code-review/               run.json, ocr-result.json, ocr-stderr.log
  completeness-review/       run.json, execution.jsonl, claude-stderr.log, report.md
```

`run.json` holds each job's exit code, wall-clock duration (`durationMs`), what it ran against (`versions`: the OCR and Claude Code versions, and the cht-ai-tools commit with whether the tree was `dirty`), its model and options (`config`), and the commits it reviewed (`range` for OCR, `head` for Claude).

## Cases

[`cases/`](cases) holds the gold standard per benchmarked PR: the findings a review of it should make. [`baseline.json`](baseline.json) holds the scores of the current configuration against those cases, to compare later runs with. The [cases README](cases/README.md) describes both, how to build a case from a set of benchmark results, and how to score a run.

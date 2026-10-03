# ai-review benchmark

Runs the two review jobs of the cht-core [`ai-review` workflow](https://github.com/medic/cht-core/blob/master/.github/workflows/ai-review.yml) against PRs and saves their raw output, instead of posting it to the PR.

- `code-review`: OpenCodeReview, configured and invoked the way the `alibaba/open-code-review` action does it, on the tip of the PR's base branch.
- `completeness-review`: Claude Code with the `cht-pr-review` and `cht-docs-mcp` plugins, using the workflow's prompt, settings and `claude_args`, on the PR head. The image installs the plugins from this checkout, so local changes to the skill are what gets run.

The config is copied by hand from the workflow on `master`. The tool versions, fixed OCR settings, Claude settings ([`claude-settings.json`](claude-settings.json)) and plugins are baked into the image by the [`Dockerfile`](Dockerfile). The models, prompt and per-run options are at the top of [`run.mjs`](run.mjs). The image is built from the repo root on every run, which is quick when nothing has changed. The plugins load from `/opt/cht-ai-tools` rather than the plugin cache, so the script paths in `--allowedTools` and the settings' Bash hook point there instead of where the workflow points them.

## Usage

Requires `docker`, `git`, `gh` (logged in) and `ANTHROPIC_API_KEY`.

```bash
ANTHROPIC_API_KEY=... npm run bench:ai-review -- medic/cht-core#11427
```

Output goes to `bench-results/<timestamp>/`:

```
<owner>__<repo>__<pr>/
  code-review/               run.json, ocr-result.json, ocr-stderr.log
  completeness-review/       run.json, execution.jsonl, claude-stderr.log, report.md
```

`run.json` holds each job's exit code and wall-clock duration (`durationMs`).

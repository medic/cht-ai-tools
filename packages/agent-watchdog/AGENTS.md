# AGENTS.md

Operational quick reference for coding agents working in `packages/agent-watchdog`. The
constitution at `.specify/memory/constitution.md` is the authority when this file and it disagree;
correct this file in the same PR as any constitution amendment.

## What this is

A scheduled Node 22 CommonJS command that turns CHT Watchdog metrics into a daily Slack brief. It
flags, it never acts. Read `specs/001-watchdog-slack-loop/plan.md` before changing structure.

## Rules that are not negotiable

- JavaScript, CommonJS, Node 22. No TypeScript. `@medic/eslint-config`; `npm run lint` must report
  zero warnings.
- Tests first: mocha, chai, chai-as-promised, sinon, nyc. `test/` mirrors `src/`. No test reaches
  the network; `test/setup.js` makes `fetch` throw.
- Prompts, skill, schemas and the agent definition under `prompts/`, `skill/`, `schema/`, `agent/`
  are code: change by PR with the replay diff attached. A run never writes to them.
- Everything the model produces is untrusted until `src/verify/` accepts it. The model composes no
  URLs; `src/links/` builds them. Numbers in text must match computed data.
- The model's tools are the enumerated list in `agent/tools.json`. No shell, web or file tools.
- Secrets never appear in prompts, logs, posts, run records or this repository. `scripts/scan-secrets.js`
  checks the repository in CI and every run scans its own artefacts at the end (SC-010); a deliberate
  sample value in a test carries `// scan-secrets:allow` on its line.
- Commits: `type(#issue): subject` with `type` in `build feat fix perf refactor test chore docs`.

## Layout

`bin/agent-watchdog.js` → `src/cli/index.js` → `src/cli/commands/<command>.js` → stage runners in
`src/cli/stages/` (`purge`, `feedback`, `collect`, `analyze`, `agent`, `rollup`, `render`,
`publish`). Each stage reads the previous stage's files under the run directory and writes its own
(`specs/001-watchdog-slack-loop/contracts/run-directory.md`). Shared modules: `src/config/`,
`src/log/`, `src/store/`, `src/model/`, `src/trace/`.

## Commands and exit codes

`run [--date --project --stage --engine --dry-run --force --since]`, `replay`, `distill`,
`calibrate`, `check <cht-url>`, `purge [--dry-run]`, `tools-server`. Exit codes: 0 ok, 1 failed, 64 usage,
65 missing stage input, 69 metrics source unavailable, 74 Slack unavailable, 75 duplicate date,
78 configuration invalid. Logs are JSON lines on stderr; results go to stdout. `purge` applies
retention (raw 14 days, kept 30, durable never) and runs implicitly as the first stage of every `run`.

## Configuration

Environment variables per `.env.example` and `contracts/environment.md`; policy files
`projects.yaml` (annotations, programme `groups` by host glob, `ignore` list), `dashboards.yaml`,
`thresholds.yaml`, `alerts.yaml` (category and importance per alert rule title, staleness, category metrics)
under `AGENT_WATCHDOG_CONFIG_DIR` with defaults in `config/defaults/`. Safety rails and hard caps are code.

## Working locally

```sh
npm ci && npm run lint && npm test
node --env-file=.env bin/agent-watchdog.js run --dry-run --date 2026-09-18            # preview, posts nothing
node --env-file=.env bin/agent-watchdog.js run --date 2026-09-18 --stage collect      # one stage at a time
node --env-file=.env bin/agent-watchdog.js replay --date 2026-09-18 --prompts ./p2    # offline, prints the diff
AGENT_WATCHDOG_ENGINE=cli node --env-file=.env bin/agent-watchdog.js run --dry-run --date 2026-09-18
npm run replay:eval                                                                  # fixture regression gate
node --env-file=.env bin/agent-watchdog.js calibrate --week 2026-W38                # weekly threshold report
node --env-file=.env bin/agent-watchdog.js distill                                  # corpus → proposed cards
npm run cards:index                                                                 # after merging a card
node bin/agent-watchdog.js purge --dry-run                                          # retention preview, no credentials
node scripts/scan-secrets.js .                                                      # SC-010 repository scan, exit 1 on findings
node smoke/render.js && node smoke/container.js                                     # browser and image contract (Docker)
```

Before opening a PR, work through the repository template (`.github/pull_request_template.md`): lint
and coverage, `AGENTS.md` and `README.md` updated, new dependencies justified in the README table,
and for a prompt, skill, schema or analysis change the replay diff attached and `npm run replay:eval`
passing.

A prompt, skill or schema change attaches the `replay` comparison to its PR and must keep `npm run
replay:eval` green. Replay never contacts Grafana or Slack: tool results come from the stored run's
`tool-calls.jsonl`, and anything unrecorded is answered `unavailable` and counted in the comparison.

Learning is review-gated: the roll-up and `calibrate` write proposals under `<data>/proposals/` with
hostnames and personal identifiers masked and flagged; a run never writes to `prompts/`, `skill/`,
`schema/`, `agent/` or the policy files. Memory (`<data>/memory/memory.md`) is capped, condensed within the
cap by a bounded model call with a deterministic fallback, and every change is a diff under `memory/history/`.

Pattern cards: merged cards live under `skill/cht-watchdog/pattern-cards/<card_id>.md` with the index
`index.md` generated by `npm run cards:index` (CI can run it with `--check`). Only the index is in the
system prompt; `read_pattern_card` serves a full merged card. `distill` writes proposed cards to the data
volume, never to `skill/`; raw corpus material stays under `AGENT_WATCHDOG_CORPUS_RAW_DIR`.

Body layout: five bullets of two lines, a programme's items as up to eight one-line sub-bullets, "Other" never
collapsed, computed in `src/rollup/layout.js` before the roll-up call and written to `rollup/layout.json`. The
model writes item lines only; group lines are code; `bullet_count`, `bullet_length` and `thread_order` check the
draft against the layout. Ignored hosts never enter `discovery.projects`.

Alerts: `collect` reads Grafana-managed rules and instances into `alerts.json` (unavailable is a fact, not a
failure); `analyze` classifies them from `alerts.yaml` into `alerts.classified.json`; the roll-up places alert
groups as code-built `alerts` bullets, the model never writes them; `publish` posts one reply per alert group
(`agent_watchdog.alerts`) with links the gate resolved against the collected data; episodes are append-only events
in `alerts/episodes.jsonl` (durable), cleared ones also in `corpus/outcomes/` as `alert_episode`.

Feedback: `feedback.jsonl` is permanent (never purged); `AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` bounds
how long a record adjusts ranking. Each run reviews new notes with one bounded call each, writes proposals
for their destination, and posts one digest reply per run in the brief or heartbeat thread, acknowledging
every record once (`acknowledged_run_id`) and reacting `eyes` on notes; nothing is acknowledged or reacted
to in preview. The digest names no person.

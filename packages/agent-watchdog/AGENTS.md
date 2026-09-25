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
  URLs; `src/links/` builds them. Numbers in text and in evidence must match computed data, dates must
  fall within the run's windows, and the headline and the notice are checked like the bullets; the
  resolver contacts a model-written URL only after the allow-list and tool-result checks pass.
- The committed schemas under `schema/` are JSON Schema 2020-12; the runtime receives them through
  `forStructuredOutput` (no `$schema`/`$id`, `definitions` for `$defs`) because its validator knows
  draft-07 only. A model session that fails before a result is an `error` bound with its message on
  the pass record, and a run whose sessions all failed publishes the degraded brief naming the
  failure, never "nothing to flag". A tracing flush failure is logged and never changes the exit code.
- The model's tools are the enumerated list in `agent/tools.json`. No shell, web or file tools. The
  runtime's own `StructuredOutput` tool is the one exception, approved by `agent/hooks.js` so the model
  can hand its findings back; it is never recorded as a tool call.
- Budgets are enforced in code: the project budget by the runtime, the run budget across sessions by
  `src/cli/stages/agent.js`, which names the projects it could not analyse.
- Secrets never appear in prompts, logs, posts, run records or this repository. `scripts/scan-secrets.js`
  checks the repository in CI and every run scans its own artefacts at the end (SC-010); a deliberate
  sample value in a test carries `// scan-secrets:allow` on its line.
- Commits: `type(#issue): subject` with `type` in `build feat fix perf refactor test chore docs`. The founding
  branch predates its issues and keeps `type: subject`; the deviation and its expiry are in plan.md's Complexity
  Tracking, and commitlint makes the scope mandatory once it merges.

## Layout

`bin/agent-watchdog.js` → `src/cli/index.js` → `src/cli/commands/<command>.js` → stage runners in
`src/cli/stages/` (`purge`, `feedback`, `collect`, `analyze`, `agent`, `rollup`, `render`,
`publish`). Each stage reads the previous stage's files under the run directory and writes its own
(`specs/001-watchdog-slack-loop/contracts/run-directory.md`). Shared modules: `src/config/`,
`src/log/`, `src/store/`, `src/model/`, `src/trace/`, `src/net/` (the egress allow-list and the guard every
`fetch` of a run passes, FR-083).

## Commands and exit codes

`run [--date --project --stage --engine --dry-run --force --since]`, `replay`, `distill`,
`calibrate`, `check <cht-url>`, `purge [--dry-run]`, `egress [--format json|hosts]`, `tools-server`.
Exit codes: 0 ok, 1 failed, 64 usage,
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
AGENT_WATCHDOG_ENGINE=cli node --env-file=.env bin/agent-watchdog.js run --dry-run --date 2026-09-18  # blank key: your claude login
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

Body layout (revision 28): two body slots, each a programme or a single project, a programme's slot naming up to
three projects on lines of two lines each with a count of the rest; every further programme with two or more
flagged projects gets a thread reply of its own in the same form, and the remaining projects share one "Other"
reply, all computed in `src/rollup/layout.js` before the roll-up call and written to `rollup/layout.json`. The
model writes the item lines, the headline and, on a window day, the expected-load notice (the notice code built
from the window's note is the fallback and the text the model is told to copy); group lines are code;
`bullet_count`, `bullet_length` and `thread_order` check the draft against the layout, and the headline and the
notice are checked like the lines. Ignored hosts never enter `discovery.projects`.

Collection: a panel expression is scoped to the project and its dashboard variables are resolved by code before
it is sent (`src/collect/variables.js`; `$interval` to the dashboard's value, Grafana's built-in time variables to
the window); a variable with no single value makes the metric unavailable and is named in
`collect.unresolved_variable`. The trailing baseline uses the subquery form for anything but a bare selector.
The fake Grafana answers 400 like Prometheus for an unsubstituted variable or a range on a non-selector.
A run fetches only what the data volume lacks (`src/collect/history.js`): the current window always, the
previous-day and previous-week windows from the stored runs one and seven days earlier when their bounds match
exactly, the trailing baseline from `history/<slug>.json` (one daily maximum per metric) once it holds fourteen
days; every window carries its `source`. Range queries have their own timeout
(`AGENT_WATCHDOG_QUERY_TIMEOUT_MS`), one retry, and fail only their window; a 4xx or a 500 is that
expression's problem and neither counts nor resets, three consecutive queries with no answer (a timeout, a
connection failure, a 502, 503 or 504) or a connection failure make the source unreachable (exit 69), and
when half or more of the queries a run sent failed the brief carries a `Collection incomplete` notice
(`collect.summary.json`). Projects are collected concurrently within
`AGENT_WATCHDOG_PROJECT_CONCURRENCY`. A per-project metric is one series per project: panels grouped by route,
code or database, or ranked with `topk`, are listed in `discovery.json` (`breakdown`) and never queried, and a
query that answers several series fails only its window, naming the labels that differ (FR-075).
Alerts: `src/alerts/patterns.js` finds one rule firing across a programme, classification attaches the metric
behind each alert and marks stale alerts on dead hosts as housekeeping, `src/rollup/notices.js` writes the
housekeeping and resolved lines, and `src/rollup/markers.js` is the only source of emoji, added when the payload
and the report render (FR-078 to FR-082).

Alerts: `collect` reads Grafana-managed rules and instances into `alerts.json` (unavailable is a fact, not a
failure); `analyze` classifies them from `alerts.yaml` into `alerts.classified.json`; the roll-up counts alert
groups per programme and takes no body slot for them; `publish` posts one alerts reply per run
(`agent_watchdog.alerts`) with the counts per programme, a link to each programme's filtered alert list and one to
every firing alert, fitted line by line and never cut inside a link, plus the alert-derived notices; the report
lists every instance; episodes are append-only events in `alerts/episodes.jsonl` (durable), cleared ones also in
`corpus/outcomes/` as `alert_episode`.

Feedback: `feedback.jsonl` is permanent (never purged); `AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` bounds
how long a record adjusts ranking. A note's record keeps what its parse found (`expected_max`, `observed_value`,
`horizon_source`); a failed model parse is retried by the next run with a model, and a note whose review
failed stays unacknowledged for up to three runs (revision 34). Each run reviews new notes with one bounded call each, writes proposals
for their destination, and posts one digest reply per run in the brief or heartbeat thread, acknowledging
every record once (`acknowledged_run_id`) and reacting `eyes` on notes; nothing is acknowledged or reacted
to in preview. The digest names no person.

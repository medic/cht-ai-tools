# Quickstart: Watchdog Slack Loop

**Feature**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md)

How to run the pipeline and prove each user story end to end. Commands and flags follow
[contracts/cli.md](./contracts/cli.md); exit codes follow [contracts/exit-codes.md](./contracts/exit-codes.md);
artefact paths follow [contracts/run-directory.md](./contracts/run-directory.md). Nothing here posts
to Slack unless the step says so.

## Prerequisites

- Node 22 (`nvm use` reads `.nvmrc`); `npm ci` from `packages/agent-watchdog`.
- No browser: the report is HTML and nothing renders an image.
- Credentials in `.env` (copy `.env.example`): `ANTHROPIC_API_KEY` (or, with
  `AGENT_WATCHDOG_ENGINE=cli`, a `claude` login and the key left blank); a Grafana service-account
  token with the Viewer role on the watchdog you point at (`AGENT_WATCHDOG_GRAFANA_TOKEN`,
  `AGENT_WATCHDOG_GRAFANA_URL`, `AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID`); Langfuse keys and
  `LANGFUSE_BASE_URL`. `SLACK_BOT_TOKEN` and `AGENT_WATCHDOG_SLACK_CHANNEL_ID` are needed only for
  the steps that post or read Slack.
- Local paths: `AGENT_WATCHDOG_DATA_DIR=./.data` and `AGENT_WATCHDOG_CONFIG_DIR=./config/local`
  (copy `config/defaults/` and edit `projects.yaml`).

Every command below is `node --env-file=.env bin/agent-watchdog.js …`, abbreviated to
`agent-watchdog …`.

## 1. Lint and unit tests (no network, no credentials)

```sh
npm run lint          # zero warnings
npm test              # mocha + nyc; test/ mirrors src/
```

Expected: both exit 0; coverage is printed and compared against `main` in CI.

## 2. Deterministic analysis on recorded fixtures (User Story 1)

```sh
npm run replay:eval
```

Runs every recorded fixture run under `test/fixtures/runs/` through the analysis and gate without
the model, then compares with the stored expectations.

Expected: the seeded-anomaly day yields exactly one candidate on the seeded project and metric
with the FR-014 rule that fired; the quiet day yields no candidates and a `heartbeat` brief; the
labelled feedback set shows no regression; exit 0.

## 3. Preview run against a real watchdog (User Story 3, scenario 5)

```sh
agent-watchdog run --dry-run --date "$(date -u -d yesterday +%F)" > payload.json
```

Expected: exit 0; `payload.json` is the exact Slack payload (parent, replies, report share)
with `slack_file_id: null`; under `.data/runs/<date>/` every artefact of a real run exists,
including `rollup/report.html` and `run.json` with `status: previewed`; the
footer contains the trace link and the cost in USD; nothing was posted. The log carries no
`collect.query_failed` warning: derived expressions use the trailing subquery form and the
dashboards' `$interval` is resolved (FR-071); a `collect.unresolved_variable` warning names any
panel left unavailable for a variable with no single value, and `discovery.json` shows what each
dashboard variable resolved to. Each `collect.project` line reports `fetched`, `reused` and
`queries`: on the first run everything is fetched; run the same command for the next date and the
previous-day and trailing windows are reused, so `queries` drops to two per metric, and to one from
the eighth consecutive day (FR-072). A single slow query shows as one `collect.query_failed` line
with the metric and window, and the run continues (FR-073). `discovery.breakdown_panels` names the
panels grouped by route or code that are shown on the dashboard but not analysed (FR-075). In the
payload, alert group replies open with a `Programme-wide:` paragraph when one rule fires across a
programme, alert lines carry the metric behind them, a `Housekeeping:` notice lists stale alerts on
dead hosts and a `Resolved` notice what cleared since the previous run; every rendered line starts
with its code-placed marker (FR-078 to FR-082).

## 4. One stage at a time (User Story 3, scenario 6)

```sh
agent-watchdog run --date <date> --stage collect
agent-watchdog run --date <date> --stage analyze
agent-watchdog run --date <date> --stage agent --project <host>
agent-watchdog run --date <date> --stage rollup
agent-watchdog run --date <date> --stage render
```

Expected: each stage reads the previous stage's files and writes its own; deleting
`changes.json` and re-running `--stage agent` exits 65 with the missing file named; re-running a
stage overwrites its outputs atomically.

## 5. Replay with a changed prompt (User Story 3, scenario 3)

```sh
cp -r prompts prompts-experiment && $EDITOR prompts-experiment/pass-first.md
agent-watchdog replay --date <date> --prompts ./prompts-experiment --label experiment > diff.json
```

Expected: findings are regenerated under `.data/runs-replay/<date>/experiment/`; `diff.json` lists
items added, removed and changed; the log contains no request to the Grafana or Slack hosts (only
the model API and recorded tool results were used); exit 0. This is the diff attached to a prompt
PR.

## 6. Engine parity (User Story 3, scenario 7)

```sh
AGENT_WATCHDOG_ENGINE=cli agent-watchdog run --dry-run --date <date> --project <host>
# with ANTHROPIC_API_KEY blank the cli engine runs on your claude login; agent.cli_auth in the log names the mode
node smoke/agent-parity.js --date <date> --project <host>
```

Expected: the CLI engine drives `claude -p` with the same skill, tools, prompts and schema; the
parity script reports identical `findings.pass<n>.json` after gate normalisation and identical
gate verdicts, and exits non-zero on any difference.

## 7. Feedback loop (User Story 2)

Unit level: `npm test -- --grep feedback` exercises recorded thread and reaction payloads under
`test/fixtures/slack/`.

Live, in a test channel: post once with `agent-watchdog run --date <date>` (needs the Slack
token), add a thumbs-down and a thread note such as "known migration, expected until 1 October"
to one reply, then run `agent-watchdog run --dry-run --date <next date>`.

Expected: `feedback.jsonl` gains records with the item id, verdict, note, author and a parsed
horizon; `memory/history/<run_id>.patch` shows the note entering memory; the next preview does not
flag the same pattern before the horizon unless it exceeds the noted expectation.

## 8. Readiness check (User Story 5)

```sh
agent-watchdog check https://<cht-host>
agent-watchdog check https://<host-below-3.12>
```

Expected: the first prints each prerequisite as met and exits 0; the second reports the unmet
version prerequisite in plain language and exits 1; an unreachable host exits 69.

## 9. Corpus distillation (User Story 6)

```sh
cp test/fixtures/corpus/* .data/knowledge-corpus/raw/
agent-watchdog distill
agent-watchdog distill        # second run
```

Expected: the first run writes one proposed card per distinct pattern under
`.data/corpus/cards.proposed/` with sources cited and identifiers scrubbed or flagged, and updates
`.data/corpus/index.json`; the second run processes nothing because hashes are unchanged.

## 10. Container contract

```sh
docker build -t agent-watchdog:dev .
docker run --rm --read-only --tmpfs /tmp -v "$PWD/.data:/data" -v "$PWD/config/local:/etc/agent-watchdog:ro" \
  --env-file .env --user 10001:10001 agent-watchdog:dev run --dry-run --date <date>
```

Expected: the run behaves as in step 3 inside the image with a read-only root filesystem; the
image runs as the fixed non-root user; `docker run --rm agent-watchdog:dev --version` prints the
package version. `node smoke/container.js` runs the credential-free part of this step in one go: the
build, `--version`, `check https://example.invalid` exiting 69, and the report rendering with
`--read-only --tmpfs /tmp`.

## 11. Publishing for real (operators only)

```sh
agent-watchdog run --date <date>
```

Only against the configured channel (`AGENT_WATCHDOG_SLACK_CHANNEL_ID`) with `AGENT_WATCHDOG_DRY_RUN=false`.
Expected: one parent message from `agent-watchdog` with the headline, at most two programme bullets and the
footer; the report shared into the thread, one reply per further programme with two or more flagged
projects, one `Other` reply and one alerts reply; `publication.json` holds `ts` and permalinks; exit 0. A
second run for the same date exits 75 unless `--force` is given, and a forced run links the superseded post,
a heartbeat too.

## 12. Feedback acknowledged (User Story 7)

Continue from step 7: after adding the thumbs-down and the note, run
`agent-watchdog run --dry-run --date <next date> > payload.json`.

Expected: `payload.digest` names the item, its effect today (confidence lowered, or suppressed
until the noted horizon), the proposal written from the note with its destination and path, and a
sentence stating that the records are kept permanently in `feedback.jsonl` and adjust ranking for
the configured number of days; no person is named; nothing was posted and no record is marked
acknowledged. A real run then posts the digest in the brief's or heartbeat's thread, adds an
`eyes` reaction to the note, and sets `acknowledged_run_id` on the records; a second run
acknowledges nothing again. `agent-watchdog purge --dry-run` with a clock a year later lists no
feedback records, because they are never purged.

## 13. Grouped bullets (User Story 9) and alerts (User Story 8)

`npx mocha test/e2e/us9.spec.js` replays the seeded day across aliased hosts: two programmes declared
by host pattern, one `.dev` host ignored. For a preview against a real watchdog, put `groups` and
`ignore` in the `projects.yaml` under `AGENT_WATCHDOG_CONFIG_DIR` (contracts/config-files.md) and run
`agent-watchdog run --dry-run --date <date> > payload.json`.

Expected: `rollup/layout.json` holds at most two slots; a programme with several flagged projects is
one `group` bullet ("North Programme: 3 projects with issues") whose project lines are the model's words
behind the project code writes, rendered in the parent's section as indented `◦` lines and as a nested list
in the report; `discovery.json` lists ignored hosts under `ignored` and
they appear nowhere else; the gate report shows `bullet_count`, `bullet_length` and `thread_order`
passing against the layout. `node smoke/grafana.js --hosts` prints every discovered host with its
group, which is how the placeholder patterns in `projects.yaml` get replaced; `node smoke/slack.js --yes`
posts a brief with a group bullet for S-16.

Alerts (User Story 8): `npx mocha test/e2e/us8.spec.js` replays the recorded alert day
(`test/fixtures/runs/alerts-day`: the seeded series plus eleven rules and sixteen firing instances) over two
days. Expected: `alerts.json` holds the rules and instances as collected with the development host dropped;
`alerts.classified.json` carries category, importance, three stale instances and the unknown rule as
uncategorised; the brief's first bullet reads "North Programme alerts: 11 firing, 3 stale for more than 14 days" with
one sub-bullet per category; every alert group has a thread reply carrying `agent_watchdog.alerts` metadata and
links under the Grafana host; `alerts/episodes.jsonl` opens one episode per instance with its correlations and,
on day two, observes fifteen, clears one (also written to `corpus/outcomes/`) and opens one. Against a real
watchdog, `node smoke/grafana.js --alerts` lists the rules and instances the Viewer token can read with their
states and paging (S-14) and prints the alert-list links to open (S-15); `agent-watchdog run --dry-run` with the
alerting endpoints unreachable posts nothing but leaves an "Alerts unavailable" notice in the payload.

## 14. What the gate refuses

Every draft, of a finding and of the brief, passes the same deterministic checks before anything is kept
or posted (`src/verify/`). Numbers: every numeral in prose must equal a computed value of the item's metric,
a value the model was given in its session, or a difference, ratio or percentage of two values it may quote;
each evidence entry must match its own window's values, or the metric's values in its unit family when it is
a percentage, multiple, sigma or hours; a day-month phrase is a date, not a numeral, unless its month is a
lowercase "may" or its day is one the month cannot hold. Dates: every date the model writes must fall
within the run's windows unless the run gave it, in a prompt, a tool result, the system prompt's window notes
and memory, or the brief's feedback and memory; a yearless date is read as the run read it. Links: only
links code built and references on the allow-list that appeared in a tool result are requested, and one
outside the egress list is recorded as not requested. Personal data: a Slack id, an e-mail address or a
phone number on the published surface is refused, and notes are masked before they reach a prompt. A brief
that fails every attempt degrades to the deterministic one, whose notice names the refusing checks in words
and never their reasons. To see the reasons on a stored run: `verification.pass<n>.json` under the project
and `rollup/verification.draft<n>.json`.

## 15. What a run records and posts

Collection: a panel Prometheus refuses fails its own windows and nothing else; the source is unreachable
only when queries get no answer three times running; when half or more of the queries a run sent failed,
the brief carries `Collection incomplete` with a warning marker (`collect.summary.json` holds the counts).
The heartbeat says how many candidates were assessed; a session a bound stopped is an incomplete analysis
the brief names, and an estimated charge reads `up to $X spent`; `run.json` carries the run's cost, the
feedback stage's calls included, and `run --stage rollup` carries the recorded spend. Publish:
`rollup/publication.json` appears as soon as the parent is posted (`partial: true`), before its permalink
is known, for heartbeats too; a second `--stage publish` on that run exits 75 without rewriting anything;
a preview of a posted run writes `rollup/payload.preview.json` beside the record; a forced run links the
post it supersedes. The alerts reply drops whole programme lines before it would cut a link and gives up
its notices last. Feedback: a note's record keeps its horizon and figures; a note whose review failed stays
unacknowledged for up to three runs; the digest lists unmatched notes with their identities, addresses and
numbers masked; memory keeps byte counts, ranges and dates. Tools: a tool's error answer never repeats what
the model passed. Flags: `run --stage ''` and `run --date 2026-13-01` exit 64 before a run directory exists;
`--engine` is accepted by `distill` and `calibrate`. A run from the released image names the image's
version and revision in `run.json`, in `replay` and in `egress`.

## 16. The container, on the platform and on your machine

`node --env-file=.env bin/agent-watchdog.js egress` prints every destination a run contacts, host and port
with its purpose; `--format hosts` prints one host per line for a network policy. Nothing else is contacted:
a stage that tried would fail the run with exit 69 and an `egress.refused` log line naming the host and port,
and a redirect off the origin carries no credentials. With Docker, `node smoke/container.js` builds the
image and runs it as the platform will: root filesystem read-only, every capability dropped, no privilege
escalation, user `10001:10001`, no network for the checks that need none; the reference manifests under
`deploy/` show the CronJob's security context, mounts, limits and deadline and an egress policy whose names
are that list, and `npm test` keeps them in step with the contract.

`docker compose build` builds the image as CI does, on x64 and arm64 alike; `docker compose run --rm
agent-watchdog --version` runs it as the CronJob will: user 10001, read-only root, no capabilities, `/tmp` a
tmpfs, `/data` a named volume. Your `.env` supplies secrets and endpoints (comments on their own lines, as in
`.env.example`) and `config/local` the policy files. `docker compose run --rm agent-watchdog run --dry-run
--date <date> > payload.json` previews without posting; without `--dry-run` it posts. `docker compose
--profile offline run --rm offline run --dry-run --stage analyze --date <date>` runs a stage that needs no
network with none at all. Read an artefact back with `docker compose run --rm --entrypoint cat
agent-watchdog /data/runs/<id>/rollup/report.html`.

For individual use on a Claude subscription instead of an API key: `docker compose --profile login run --rm
login` runs `claude auth login` and keeps the login in the named volume `agent-watchdog-login`; then run
with `-e AGENT_WATCHDOG_ENGINE=cli -e ANTHROPIC_API_KEY=` and the log's `agent.cli_auth` line says
`mode: login`. `docker compose --profile login run --rm login auth status` shows the login and
`auth logout` removes it. A key in `.env` wins over the login, so leave it blank for this mode.

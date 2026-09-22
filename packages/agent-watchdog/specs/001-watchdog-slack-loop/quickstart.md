# Quickstart: Watchdog Slack Loop

**Feature**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md)

How to run the pipeline and prove each user story end to end. Commands and flags follow
[contracts/cli.md](./contracts/cli.md); exit codes follow [contracts/exit-codes.md](./contracts/exit-codes.md);
artefact paths follow [contracts/run-directory.md](./contracts/run-directory.md). Nothing here posts
to Slack unless the step says so.

## Prerequisites

- Node 22 (`nvm use` reads `.nvmrc`); `npm ci` from `packages/agent-watchdog`.
- No browser is needed since revision 24; `npx playwright-core install chromium-headless-shell` only for `smoke/render.js --png`, or set
  `AGENT_WATCHDOG_CHROMIUM_PATH` to a system Chromium.
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
including `rollup/report.html` and `run.json` with `status: previewed` (no image since revision 24); the
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

Only against the configured `#agents` channel with `AGENT_WATCHDOG_DRY_RUN=false`. Expected: one
parent message from `agent-watchdog` with at most five bullets and the footer; the report shared into
the thread and one threaded reply per high item and alert group (revisions 24 and 25); `publication.json` holds `ts` and permalinks; exit 0. A second run for the
same date exits 75 unless `--force` is given, and a forced run links the superseded post.

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

Expected: `rollup/layout.json` holds at most five slots; a programme with several flagged projects is
one `group` bullet ("North Programme: 3 projects with issues") whose sub-bullets are the model's one-line
words behind the project code writes (revision 26), rendered in the parent's section as indented `◦` lines and as a nested list in the report;
every high project item still has a thread reply (revision 25); `discovery.json` lists ignored hosts under `ignored` and
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

## 14. Thread economy and the report (revision 23)

Preview a recorded day with many items (the alerts-day fixture, or a hosted preview) and open
`rollup/payload.json`: `replies` held one entry per body item until revision 25, now one per high item (section 16; at most
twenty-five) and one per alert group, `report` names `rollup/report.html` with a code-built
`initial_comment`, and the parent's footer counts the items that are only in the report. Open
`rollup/report.html`: every item is numbered by rank with its id, related items sit under the item they
relate to, and standing conditions are listed per host. Then run the feedback stage against the Slack
fixtures: a note "#2 :-1: expected until 1 October" is recorded on the item ranked 2 with verdict `down`
and the horizon, and a note that is only a thumbs is recorded as unmatched.

## 15. One programme, links and rounding (revision 24)

Preview one programme: `agent-watchdog run --dry-run --group "North Programme"` (a `projects.yaml` group
label; `--project` still names single hosts). `discovery.json` still lists every project, but only the
programme's projects have a directory, the brief's bullets, standing and housekeeping lines cover only
them, and `alerts.classified.json` stays whole. Open `rollup/report.html`: items are numbered by rank
with the host and metric first (the labelled meta line of revision 24 was replaced by the original header in revision 25, section 16);
each item, standing host and alert group links its hosted panel or alert list; the footer links the
specification (the prompts until revision 25), the configuration and the trace and repeats the citation line; evidence shows at most three
decimals. Run the same preview with `AGENT_WATCHDOG_REPORT_LINKS=none` and the report carries no
link. `rollup/brief.png` is no longer written and the payload's `image` is null.

## 16. One footer, threads for what needs a person, a notice in words (revision 25)

Preview a run (`agent-watchdog run --dry-run`) with `AGENT_WATCHDOG_SPECS_URL` set (it replaced
`AGENT_WATCHDOG_PROMPTS_URL`; the run refuses to start without it). The post's footer reads `specs ·
configuration · trace · cost $X · run <id> · N more items in the report (thread)`, and the report's footer
is the same line with the citation sentence under it. `rollup/payload.json` carries one reply per high
item and one per alert group and none for a medium or low item; the report share's comment counts them.
Open `rollup/report.html`: the original design, each item headed `#N SEV host · metric · new today` with
its id set apart and `confidence NN%` on the next line, window names as recorded (`previous_day`), the
panel, standing and alert links of revision 24, evidence notes rounded. Restrict the run with `--group`
and the checked line counts the programme's projects, not every project discovered. When a project's
analysis was refused on every attempt the notice reads `Analysis incomplete: no findings for 1 of 3
projects (host): the verification gate refused the model's analysis on every attempt, mostly for digits
that looked like a phone number`.

## 17. The project first on every body line (revision 26)

Preview a run whose programme has several flagged projects. Every sub-bullet under the programme
bullet reads `north-a: <the change in words>` and a single-project bullet reads
`alpha.example.org: <the change in words>`; the host is written by code, the words are the model's,
and neither carries a metric key. `rollup/prompt.md` shows the layout the model received with a
`prefix` and a `budget` for every body item. A draft whose line would exceed 120 characters with the
prefix is refused by the gate with the prefix named in the reason.

## 18. A failure notice that quotes nothing it should not (revision 27)

Make a run fail after startup with an error whose message carries a token, for example by pointing
`AGENT_WATCHDOG_GRAFANA_URL` at a host that answers with an error page quoting the request. The failure
notice in Slack reads `agent-watchdog run <id> failed at stage <stage>: ...` with every secret, e-mail
address and phone-shaped run replaced by `[redacted]`; the same message is in the log untouched by the
gate but with secret-named keys redacted.

# agent-watchdog

Daily analysis of the CHT projects monitored by Medic's hosted [CHT Watchdog](https://docs.communityhealthtoolkit.org/hosting/monitoring/),
posted to Slack as a short brief that flags what a human should look into. It reads metrics
through Grafana, computes changes deterministically, asks a bounded Claude Agent SDK session to
interpret them with read-only tools, verifies every number and link in code, and posts one
message of at most two programme bullets, with the full report shared into its thread followed by one
reply per remaining programme, one for the other projects and one for the alerts; every item is numbered
in the report so a note can cite it (`#7`, or its host and metric, with a thumbs as the verdict).
Reactions and thread notes shape the next day's brief and are acknowledged in it, and what the agent
learns arrives as proposal files for human review, never as changes to its own prompts, skill or
thresholds.

It flags; it never acts. Paging stays with the existing monitoring stack.

Specification, plan and contracts live under [`specs/001-watchdog-slack-loop/`](specs/001-watchdog-slack-loop/);
the constitution under [`.specify/memory/constitution.md`](.specify/memory/constitution.md) is the
authority for how this package is built. `AGENTS.md` is the quick reference for coding agents.

## Quickstart

See [`specs/001-watchdog-slack-loop/quickstart.md`](specs/001-watchdog-slack-loop/quickstart.md).
In short:

```sh
nvm use                      # Node 22
npm ci
cp .env.example .env         # fill in credentials
npm run lint && npm test
node --env-file=.env bin/agent-watchdog.js run --dry-run --date 2026-09-18 > payload.json
```

## Commands

`run`, `replay`, `distill`, `calibrate`, `check <cht-url>`, `purge [--dry-run]`, `tools-server`.
A run is the stages `purge, feedback, collect, analyze, agent, rollup, render, publish`, in that
order; `--stage <name>` runs one of them against the previous stage's files. Exit codes: 0 ok,
1 failed, 64 usage, 65 missing stage input, 69 metrics source unavailable, 74 Slack unavailable,
75 duplicate date, 78 configuration invalid. Logs are JSON lines on stderr; results go to stdout.
Flags, streams and exit codes in full: [`contracts/cli.md`](specs/001-watchdog-slack-loop/contracts/cli.md),
[`contracts/exit-codes.md`](specs/001-watchdog-slack-loop/contracts/exit-codes.md).

### Running it yourself

Every stage reads the previous stage's files under `AGENT_WATCHDOG_DATA_DIR/runs/<date>/` and writes
its own, so a contributor can run the pipeline in preview, one stage at a time, or replay a stored run
against changed prompts without posting anything or contacting Grafana or Slack
([`contracts/run-directory.md`](specs/001-watchdog-slack-loop/contracts/run-directory.md)):

```sh
agent-watchdog run --dry-run --date 2026-09-18 > payload.json     # every artefact, exact payload, nothing posted
agent-watchdog run --date 2026-09-18 --stage collect              # then analyze, agent, rollup, render, publish
agent-watchdog replay --date 2026-09-18 --prompts ./prompts-experiment --label experiment > diff.json
agent-watchdog replay --from 2026-08-20 --to 2026-09-18 --prompts ./prompts-experiment > summary.json
AGENT_WATCHDOG_ENGINE=cli agent-watchdog run --dry-run --date 2026-09-18 --project cht.example.org
agent-watchdog calibrate --week 2026-W38 > calibration.json                   # weekly threshold evidence
agent-watchdog check https://cht.example.org                                  # readiness: 0 met, 1 unmet, 69 unreachable
agent-watchdog distill [--all] [--item <relative-path>]                       # corpus items → proposed pattern cards
agent-watchdog purge --dry-run                                                # what retention would remove; runs first in every run
```

Your own policy files go under `config/local/`, which git ignores: point `AGENT_WATCHDOG_CONFIG_DIR`
at it and any file you leave out falls back to `config/defaults/`. A `projects.yaml` there with your
real programme groups and ignore list is what makes a preview run against the hosted watchdog read
like the real brief.

The `cli` engine drives the same agent definition through `claude -p` (set
`AGENT_WATCHDOG_CLAUDE_PATH` when `claude` is not on your PATH) and serves the read-only tools to it
through `agent-watchdog tools-server` over stdio. With `ANTHROPIC_API_KEY` set it runs in bare mode;
leave the key blank and it runs on your own `claude` login (run `claude` and `/login` once), loading
none of your settings, rules, CLAUDE.md or memory. The log line `agent.cli_auth` names the mode. Costs
reported in login mode are the runtime's estimates and count against your plan's usage limits; the
scheduled container run always uses the key. Replay serves recorded tool results from the stored
run, prints a JSON comparison of items before and after, and is the diff a prompt change attaches to its
PR. `npm run replay:eval` runs the fixture runs through analysis and the gate and fails on a regression
against `test/fixtures/runs/*/expected.json` and `test/fixtures/feedback-labels.json`.

### Budgets

`AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT` caps one project's session and `AGENT_WATCHDOG_MAX_BUDGET_USD_RUN`
the whole run. The run cap is enforced across sessions: a session is granted at most what the run
has left after finished and running sessions, no session opens with less than $0.25, and the brief's
notices say how many projects were analysed before the budget ran out and how many were left out.
The runtime hands structured output back through a tool of its own, `StructuredOutput`, which the
hooks and both engines always allow; nothing else outside `agent/tools.json` is.

### When the analysis cannot run

A model session that fails before producing a result, because the runtime exited, refused the
schema or lost the network, is recorded on the project's `passes.json` with its message as an
`error` bound, distinct from a timeout. The roll-up counts these: with items from other projects
the brief carries a notice naming how many sessions failed and why; with no items and candidates
present it publishes the degraded brief built from the computed candidates, with the failure in its
notice. A run never says "no metric changes to flag" because the analysis did not run. Tracing
failures at the end of a run are logged and leave the exit code alone.

### What the brief says beyond the alerts

One alert rule firing on most of a programme's projects within two days is one event: the report's
alerts section names the rule and the count and lists the projects once, with the metric behind each
alert and its current and previous-day values. The thread's single alerts reply gives per programme the
firing count, its categories, the new and stale counts and a link to the filtered alert list, and one
link to every firing alert. Stale alerts on hosts with no data are old news, moved to one
housekeeping notice that suggests removing the host or silencing the rule; alerts that cleared since
the previous run get a resolved notice. Items of the most-used projects, by connected users, rank
first within a severity. A small fixed set of emoji, placed by code and never by the model, marks
status and severity in Slack and in the report.

### What a run fetches

Collection is incremental. Every run fetches each metric's current window; the previous-day and
previous-week windows are reused from the stored runs one and seven days earlier when their bounds
match exactly, and the fourteen-day baseline is built from a per-project ledger of daily maxima
(`history/<slug>.json` in the data volume) once it holds fourteen days. What the volume lacks is
fetched, so the first day costs four range queries per metric, the second two, and from the eighth
consecutive day one. Each `collect.project` log line reports `fetched`, `reused` and `queries`, and
every stored window carries its `source`. A slow or failed query is retried once and then makes only
its window unavailable; the source counts as unreachable, and the run fails, only on a connection
failure or three consecutive failed queries. Projects are collected concurrently within
`AGENT_WATCHDOG_PROJECT_CONCURRENCY`. Panels that break a metric down by route, code or database, or
rank a top five, are one series per label value rather than one per project: they stay on the
dashboard, are listed in `discovery.json` and are not analysed. Their aggregate siblings, such as the
request rate and the error share, are.

### Learning under review

The roll-up may propose skill, prompt or threshold changes; `calibrate` proposes threshold changes backed
by the last thirty days of stored runs and feedback. Proposals are Markdown files with YAML front matter
under `AGENT_WATCHDOG_DATA_DIR/proposals/` (copied beside the run that produced them). Project hostnames
and personal identifiers are masked in the text and listed under `flags` for the reviewer; nothing about
the agent changes until a human opens a pull request. Memory is capped and condensed within the cap when
it overflows, and every memory change is stored as a diff under `memory/history/`.

### Feedback, acknowledged and permanent

Every reaction and thread note is stored permanently in `feedback.jsonl` on the data volume; no retention
setting removes it. Its effect on ranking is bounded instead: a record adjusts confidence for
`AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` (30 by default), while a horizon stated in a note holds until its
date. The next run reviews what it read: reactions and the thumbs written in notes are tallied in code, a note
citing `#7` lands on the item ranked 7 of that post, each note is classified once by a
bounded model call into the place its lesson belongs (the skill, a prompt, a `projects.yaml` annotation, a
threshold or a pattern card) and becomes a proposal file. One code-built digest reply per run, in that
day's brief or heartbeat thread, names each item's effect, the proposals written and where the records
live; each acknowledged note gets an `eyes` reaction (bot scope `reactions:write`). The weekly calibration
report lists proposals still awaiting review with their age.

### Programmes, ignored hosts and the body layout

`projects.yaml` declares programme groups by host glob (`groups`, first match wins) and an ignore list
(`ignore`, development instances). Hosts matching no group belong to `Other`; ignored hosts are listed in
`discovery.json` and are never analysed, charged or named. The post body holds the two highest-ranked programmes:
a programme with several flagged projects becomes one code-written line ("North Programme: 3 projects with 5
issues") with one line per project for its three highest-ranked projects, each covering every issue of that
project, and a count of the rest; every other programme with two or more flagged projects is a thread reply in the
same form, the remaining projects share one "Other" reply, and every item lives in the report shared into the thread
(standing conditions such as a backlog above zero since yesterday or a host dark for a fortnight are named by code
and open no session). The layout is computed by code before the roll-up call (`rollup/layout.json`), the model
writes only the project lines and the headline, and the gate rejects a draft whose lines differ from the layout. `npm run smoke:grafana -- --hosts` prints
every discovered host with its group, which is how the placeholder patterns in `config/defaults/projects.yaml`
get replaced.

### Alerts in the brief

Each run reads the Grafana-managed alert rules and their firing instances from the hosted watchdog with the same
read-only token as the metrics (`GET /api/prometheus/grafana/api/v1/rules`, following `groupNextToken`, with the
`/alerts` endpoint as a fallback) and stores them as collected in `alerts.json`. Code classifies them from the
reviewed `alerts.yaml` (category and importance per rule title, unknown titles uncategorised and medium, stale after
14 days by default), marks what is new since the previous run, and groups them per programme and category. The
post carries no alert bullet: one alerts reply in the thread gives per programme the firing count with its categories,
the new and stale counts and a code-built link to the filtered alert list, plus one link to every firing alert, and
the report's alerts section lists every instance; the gate resolves the links against the collected rules and
instances. Every firing instance has a durable episode in `alerts/episodes.jsonl` (opened, observed, cleared)
with correlations computed by code and the explanation an accepted item gives; cleared episodes reach the corpus
outcomes. The analysis sees its project's firing alerts as untrusted context. An unavailable alerting API is a
notice on the brief, never a failure. `npm run smoke:grafana -- --alerts` lists what the Viewer token can read.

### Knowledge corpus

Maintainers drop raw material (conversations, data exports, incident write-ups, component explainers)
under `AGENT_WATCHDOG_CORPUS_RAW_DIR`, outside the repository. `distill` indexes the corpus by content
hash (`corpus/index.json`, which never holds content), processes only new or changed items, and writes one
proposed pattern card per distinct pattern under `corpus/cards.proposed/` with sources cited as content
hashes, identifiers scrubbed or flagged, and no raw text copied. Binary or oversized items are skipped
with a note in the report. A reviewer merges a card by moving it into `skill/cht-watchdog/pattern-cards/`
with `status: merged` and running `npm run cards:index`; the daily analysis then sees one index line per
card, reads a full card only through the `read_pattern_card` tool, and an item on a matching metric names
the card and uses its confirmation steps as the suggested check.

## Contracts for deployment

Deployment manifests live in `medic-infrastructure`. Everything this package promises to the outside
is written down under [`specs/001-watchdog-slack-loop/contracts/`](specs/001-watchdog-slack-loop/contracts):

| Contract | Covers |
|---|---|
| [`environment.md`](specs/001-watchdog-slack-loop/contracts/environment.md) | environment variables; `.env.example` is the source of truth |
| [`config-files.md`](specs/001-watchdog-slack-loop/contracts/config-files.md) | the mounted policy files `projects.yaml`, `dashboards.yaml`, `thresholds.yaml`, `alerts.yaml` |
| [`container.md`](specs/001-watchdog-slack-loop/contracts/container.md) | the image: fixed non-root user, read-only root filesystem, writable `/tmp` and `/data`, entrypoint |
| [`cli.md`](specs/001-watchdog-slack-loop/contracts/cli.md), [`exit-codes.md`](specs/001-watchdog-slack-loop/contracts/exit-codes.md) | commands, flags, streams and exit codes |
| [`run-directory.md`](specs/001-watchdog-slack-loop/contracts/run-directory.md) | every file a run writes, which stage reads it, and what retention removes |
| [`slack-payload.md`](specs/001-watchdog-slack-loop/contracts/slack-payload.md) | the exact Slack payload: parent, thread replies, metadata events |
| [`agent-definition.md`](specs/001-watchdog-slack-loop/contracts/agent-definition.md) | the agent definition both engines run, its tools and structured outputs |
| [`brief.schema.json`](specs/001-watchdog-slack-loop/contracts/brief.schema.json), [`findings.schema.json`](specs/001-watchdog-slack-loop/contracts/findings.schema.json) | the JSON Schemas of the model's two outputs |

## Dependencies

Every runtime dependency carries a one-line justification (constitution V):

| Package | Why |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | The analysis engine: bounded sessions, MCP tools, hooks, structured output (ESM-only, loaded with dynamic `import()`). |
| `@modelcontextprotocol/sdk` | Serves the local read-only tools over stdio to the `claude` CLI engine; already a dependency of the Agent SDK. |
| `@slack/web-api` | Posting, threaded replies, file upload, reading reactions and replies. |
| `zod` | Startup validation of configuration, entity schemas, and the source of the structured-output JSON schemas. |
| `yaml` | The three policy files are YAML; Node has no parser. |
| `handlebars` | Escaping templates for the report and Slack text; untrusted text is never concatenated. |
| `playwright-core` | Retained for the container's browser and the `--png` check of `smoke/render.js`; a run renders no image since revision 24 (the brief image was a capture of the Slack message). |
| `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@opentelemetry/sdk-node` | One trace per run with a span per stage and usage per model call; the classic `langfuse` package describes itself as a deprecated v3 client. |

## Smoke tests

Scripts under `smoke/` are not part of `npm test`; each confirms a behaviour only a live system shows
([`research.md`](specs/001-watchdog-slack-loop/research.md), S-1 to S-16). Run them with
`node --env-file=.env smoke/<name>.js`.

| Script | Needs | Confirms |
|---|---|---|
| `render.js [--out <html>] [--png]` | nothing; `--png` needs a browser: Playwright's, or `AGENT_WATCHDOG_CHROMIUM_PATH` | S-11: the report renders with its links, writing under `TMPDIR` only |
| `container.js [--no-build] [--image <tag>]` | Docker | `contracts/container.md`: the image builds, `--version` prints the package version, `check` of an unreachable host exits 69, the report renders with `--read-only --tmpfs /tmp` |
| `langfuse.js` | Langfuse credentials | S-9: one trace with a stage span and a generation, `getTraceUrl`, `forceFlush` completing before exit |
| `grafana.js [--project <host>] [--hosts] [--alerts]` | a Viewer token for the hosted watchdog | S-6, S-7: datasource proxy queries and dashboards; `--hosts` host discovery, `--alerts` the alert rules endpoint |
| `slack.js [--yes]` | the Slack app | S-8: a private file upload, metadata and read-back; `--yes` posts a brief with a group bullet and its sub-bullets (S-16) |
| `agent-sdk.js` | model credentials | S-1, S-2, S-4, S-5: structured output on every turn, the Stop hook per turn, the committed schemas, hooks |
| `agent-parity.js --date <date> --project <host>` | a stored run and model credentials | S-3, S-10: both engines agree on items and gate verdicts |

## Releasing

[`.github/workflows/agent-watchdog-release.yml`](../../.github/workflows/agent-watchdog-release.yml)
runs semantic-release from this directory on a push to `main` that touches the package.
`release.config.js` extends `semantic-release-monorepo`, which scopes the commit analysis to this
package; tags are `agent-watchdog-v<version>`, `@semantic-release/exec` builds and pushes the container
image, and the changelog, git and github plugins do the rest. The repository's root `release.yml`
releases the root package and is not involved.

The dry run recorded on 2026-09-20 (research.md R-12) ran against a local bare clone carrying the
feature branch, because semantic-release insists that the release branch exist on the remote:

```sh
git clone --bare <repo> /tmp/remote.git && git clone -b <branch> /tmp/remote.git /tmp/work
cd /tmp/work/packages/agent-watchdog && ln -s <repo>/packages/agent-watchdog/node_modules node_modules
npx semantic-release --dry-run --no-ci --repository-url file:///tmp/remote.git --branches <branch> \
  --plugins @semantic-release/commit-analyzer,@semantic-release/release-notes-generator
```

Result: `Found 25 commits for package @medic/agent-watchdog since last release`, ten `feat` commits
analysed as a minor release, next version 1.0.0, tag `agent-watchdog-v1.0.0`, release notes listing this
package's commits only. The scoping works, so the R-12 fallback (plain semantic-release behind a
`paths:` filter) is not needed; the workflow keeps a `paths:` filter only to avoid no-op runs. The
changelog, exec, git and github plugins need `GITHUB_TOKEN`, Docker and a push to `main`, so they were
not part of the dry run.

## License

AGPL-3.0, like the other CHT tools.

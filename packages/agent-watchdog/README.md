# agent-watchdog

Daily analysis of the CHT projects monitored by Medic's hosted [CHT Watchdog](https://docs.communityhealthtoolkit.org/hosting/monitoring/),
posted to Slack as a short brief that flags what a human should look into. It reads metrics
through Grafana, computes changes deterministically, asks a bounded Claude Agent SDK session to
interpret them with read-only tools, verifies every number and link in code, and posts one
message with one threaded reply per item. Reactions and thread notes shape the next day's brief
and are acknowledged in it, and what the agent learns arrives as proposal files for human review,
never as changes to its own prompts, skill or thresholds.

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

`run`, `replay`, `distill`, `calibrate`, `check <cht-url>`, `purge`, `tools-server`.
Flags, streams and exit codes: [`contracts/cli.md`](specs/001-watchdog-slack-loop/contracts/cli.md),
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
```

The `cli` engine drives the same agent definition through `claude -p --bare` (set
`AGENT_WATCHDOG_CLAUDE_PATH` when `claude` is not on your PATH) and serves the read-only tools to it
through `agent-watchdog tools-server` over stdio. Replay serves recorded tool results from the stored
run, prints a JSON comparison of items before and after, and is the diff a prompt change attaches to its
PR. `npm run replay:eval` runs the fixture runs through analysis and the gate and fails on a regression
against `test/fixtures/runs/*/expected.json` and `test/fixtures/feedback-labels.json`.

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
date. The next run reviews what it read: reactions are tallied in code, each note is classified once by a
bounded model call into the place its lesson belongs (the skill, a prompt, a `projects.yaml` annotation, a
threshold or a pattern card) and becomes a proposal file. One code-built digest reply per run, in that
day's brief or heartbeat thread, names each item's effect, the proposals written and where the records
live; each acknowledged note gets an `eyes` reaction (bot scope `reactions:write`). The weekly calibration
report lists proposals still awaiting review with their age.

### Programmes, ignored hosts and the body layout

`projects.yaml` declares programme groups by host glob (`groups`, first match wins) and an ignore list
(`ignore`, development instances). Hosts matching no group belong to `Other`; ignored hosts are listed in
`discovery.json` and are never analysed, charged or named. The post body holds at most five bullets of two
lines: a programme with several flagged projects becomes one code-written line ("MoH Nepal: 3 projects with
issues") with one one-line sub-bullet per project, and every project item keeps its own thread reply. The
layout is computed by code before the roll-up call (`rollup/layout.json`), the model writes only item text,
and the gate rejects a draft whose bullets differ from the layout. `npm run smoke:grafana -- --hosts` prints
every discovered host with its group, which is how the placeholder patterns in `config/defaults/projects.yaml`
get replaced.

### Alerts in the brief

Each run reads the Grafana-managed alert rules and their firing instances from the hosted watchdog with the same
read-only token as the metrics (`GET /api/prometheus/grafana/api/v1/rules`, following `groupNextToken`, with the
`/alerts` endpoint as a fallback) and stores them as collected in `alerts.json`. Code classifies them from the
reviewed `alerts.yaml` (category and importance per rule title, unknown titles uncategorised and medium, stale after
14 days by default), marks what is new since the previous run, and groups them per programme and category. The
body gets one code-written bullet per programme ("MoH Nepal alerts: 15 firing, 3 stale for more than 14 days") with
a sub-bullet per category, ranked among the items by importance; each alert group gets its own thread reply with
its instances and code-built links to the filtered alert list, which the gate resolves against the collected rules
and instances. Every firing instance has a durable episode in `alerts/episodes.jsonl` (opened, observed, cleared)
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

Deployment manifests live in `medic-infrastructure`. This package exposes:
[environment variables](specs/001-watchdog-slack-loop/contracts/environment.md) (`.env.example` is
the source of truth), [mounted configuration files](specs/001-watchdog-slack-loop/contracts/config-files.md),
the [container image](specs/001-watchdog-slack-loop/contracts/container.md) and
[exit codes](specs/001-watchdog-slack-loop/contracts/exit-codes.md).

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
| `playwright-core` | Renders the brief image from the same report as the text, with network and scripting disabled. |
| `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@opentelemetry/sdk-node` | One trace per run with a span per stage and usage per model call; the classic `langfuse` package describes itself as a deprecated v3 client. |

## Smoke tests

Scripts under `smoke/` need real credentials and are not part of `npm test`; see the quickstart.
`smoke/agent-parity.js --date <date> --project <host>` replays one stored project through both engines
and fails on any difference in items or gate verdicts.

## Releasing

semantic-release from this directory with tags `agent-watchdog-v<version>`; the release builds and
publishes the container image. See `release.config.js`.

## License

AGPL-3.0, like the other CHT tools.

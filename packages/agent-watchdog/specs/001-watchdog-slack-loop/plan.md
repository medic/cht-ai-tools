# Implementation Plan: Watchdog Slack Loop

**Branch**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-watchdog-slack-loop/spec.md`

## Summary

A scheduled Node 22 CommonJS command, `agent-watchdog run`, discovers the CHT projects scraped by
Medic's hosted CHT Watchdog through its Grafana, collects metric windows through Grafana's
datasource proxy, computes changes and candidates deterministically, then opens one bounded
Claude Agent SDK session per project with candidates: two passes in one session, read-only MCP
tools only, schema-validated structured output, and a verification gate that runs in code between
turns and again before publication. The roll-up posts one Slack message with at most five bullets
and a rendered image, one threaded reply per item, and a footer with prompts, configuration, trace
and cost links. The next run reads reactions and notes, updates capped memory by diff, and writes
proposals that humans adopt by pull request. Every stage writes files the next stage reads, so any
run replays offline and any contributor can run the pipeline in preview mode. Deployment manifests
live in `medic-infrastructure`; this package exposes the contracts under `contracts/`.

The technical decisions in the spec's "Notes for `/speckit.plan`" are adopted as written; two are
adjusted on verified evidence and recorded in the table at the end of the Constitution Check.

## Technical Context

**Language/Version**: JavaScript, CommonJS modules, Node.js 22 LTS (`.nvmrc`: `22`). Verified on
22.18.0 that every chosen package loads with `require()`, and that the ESM-only Agent SDK loads
through dynamic `import()` as the Notes prescribe (research.md R-1).

**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk` 0.3.x (ships the native Claude Code
runtime 2.1.x as a platform package, about 224 MB on linux-x64), `@slack/web-api` 8.x, `zod` 4.x
(validation and `z.toJSONSchema()` for the findings schema), `handlebars` 4.7.x, `playwright-core`
1.6x driving the image's Chromium, `@langfuse/tracing`, `@langfuse/otel` and `@langfuse/client` with `@opentelemetry/sdk-node` (the
classic `langfuse` package describes itself as a deprecated v3 client; research.md R-8), `yaml`
2.x (policy files are YAML; justified below), `@modelcontextprotocol/sdk` (already a dependency of
the Agent SDK; used directly for the stdio tool server the CLI engine needs). Development:
`mocha`, `chai`, `chai-as-promised`, `sinon`, `nyc`, `eslint` with `@medic/eslint-config`,
`semantic-release` (research.md R-9 fixes the eslint and chai major versions to match cht-core).

**Storage**: plain files on the persistent volume at `AGENT_WATCHDOG_DATA_DIR`: JSON, JSONL and
Markdown, gzip-compressed raw series; layout in
[contracts/run-directory.md](./contracts/run-directory.md). No database.

**Testing**: mocha with chai and chai-as-promised, sinon stubs and recorded fixtures under
`test/fixtures/`, nyc coverage; `test/` mirrors `src/`. Model-touching code has `smoke/` scripts
that need credentials. Replay evaluation runs the stored fixture runs through `agent-watchdog
replay` and diffs items; the labelled feedback set under `test/fixtures/feedback-labels.json`
must not regress (constitution II). No unit test reaches the network.

**Target Platform**: Linux x64 container (Node 22, non-root, read-only root filesystem) scheduled
as a Kubernetes CronJob in EKS by `medic-infrastructure`; also a contributor's Linux or macOS
machine with their own credentials. Contract in [contracts/container.md](./contracts/container.md).

**Project Type**: single CLI package, `packages/agent-watchdog` in the `cht-ai-tools` monorepo.

**Performance Goals**: a run over fifty projects completes within the proposed
`AGENT_WATCHDOG_RUN_TIMEOUT_MS` of 60 minutes with three concurrent project sessions; a project
without candidates costs no model usage (FR-013); one analysis call is bounded at 15 minutes; the
brief is posted by 06:20 UTC on a normal day. These figures are the plan's answer to the
unquantified "time budget" in the spec's Edge Cases and are recorded as configuration with hard
caps in code.

**Constraints**: read-only credentials everywhere; the model has no shell, web, or file tools;
every published number and link is verified in code; secrets never reach prompts, logs or run
records; 10 Gi volume; retention 14 days raw and 30 days otherwise; one Slack channel; UTC dates;
CommonJS-compatible dependencies only.

**Scale/Scope**: 10 to 50 projects, up to 10 dashboards and roughly 200 panel expressions per
project, one post per day with at most five body bullets of up to eight sub-bullets each, up to
500 firing alert instances, seven runs of feedback look-back, a knowledge corpus of hundreds of
files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| **I. CHT Conventions Are Not Optional** | PASS | CommonJS JavaScript, no TypeScript in this package (the SDK is consumed from JavaScript). Node 22 pinned in `.nvmrc` and the image. `@medic/eslint-config` extended through `@eslint/eslintrc` FlatCompat in `eslint.config.js`, as cht-core does; `npm run lint` with zero warnings is a CI gate. mocha, chai with chai-as-promised, sinon, nyc; `test/` mirrors `src/`. Conventional Commits `type(#issue): subject` enforced by commitlint; PRs target `main`. semantic-release publishes the container image on release. AGPL-3.0 `LICENSE`. The exact eslint and chai majors follow cht-core (research.md R-9). |
| **II. Test-First and Replayable** | PASS | Red-green-refactor per module. External systems sit behind small modules (`src/collect/grafana.js`, `src/publish/slack.js`, `src/agent/engine-sdk.js`, `src/agent/engine-cli.js`, `src/trace/langfuse.js`, `src/render/browser.js`) stubbed with sinon and driven by recorded fixtures. Every run persists inputs, changes, candidates, prompts and tool results (run-directory contract); `agent-watchdog replay` regenerates findings offline. Prompt, skill and model-parameter changes must pass `npm run replay:eval` and attach the replay diff to the PR (quality gate 3). |
| **III. Deterministic Before Generative** | PASS | `src/analyze/` computes percentage change, deviation, monotonic rise, baselines and expected-load adjustments with unit tests; `src/analyze/candidates.js` applies thresholds. The model runs at most `AGENT_WATCHDOG_PASSES` passes (hard cap 4) of at most `AGENT_WATCHDOG_MAX_TURNS` turns (hard cap 50) under `maxBudgetUsd`, returning schema-validated structured output; later passes review earlier ones and stop on an empty diff. Every model stage has a degraded path (`src/rollup/deterministic-brief.js`) that labels itself. The gate (`src/verify/`) checks schema, known projects and metrics, number matching, dates, link construction and allow-list, structure limits, secrets; failures return to the model at most twice, then degrade. The model composes no URLs: links are built by `src/links/build.js` from `dashboard_ref`, and `reference_urls` must have appeared in tool results. |
| **IV. Least Privilege and Explicit Trust Boundaries** | PASS | Credentials: Grafana service-account token with Viewer role; Slack bot token with post, upload, read and reaction scopes on one channel (`reactions:write` added by User Story 7 for the "seen" reaction; still the single configured channel, still no write to any deployment); Langfuse write keys. Nothing grants write access to a CHT deployment or to this package. The model's tools are `tools: []` plus an enumerated MCP allow-list (agent-definition contract). Fetched text is wrapped in labelled `<untrusted>` delimiters in prompts and rendered only through Handlebars escaping. The agent writes only its memory (capped, stored as diffs) and proposal files; prompts, tools and skill are read-only paths. Secrets are redacted by key in logs and the effective configuration; Slack user ids never leave `feedback.jsonl`. Partner-facing output is out of scope here; the hostname scan already runs on proposals (FR-033). |
| **V. Simple, Observable, Boring** | PASS | One process and one entrypoint, `bin/agent-watchdog.js`; the daily CronJob runs `run`, and the weekly `calibrate` and on-demand `distill` are subcommands of the same image, not services. One agent definition consumed by both engines. JSON logs on stderr bound to `run_id` with monotonic timestamps at every stage boundary; one Langfuse trace per run with a span per stage; token usage and cost per run in the footer. Idempotent per date with an explicit `--force`. Loud failure: failure notice plus non-zero exit codes (exit-codes contract). Node built-ins first: `fetch`, `node:util` `parseArgs`, `node:crypto`, `node:fs/promises`, `node:zlib`. Each new dependency is justified in Complexity Tracking and CommonJS-compatible (verified). Twelve-factor configuration validated by zod at startup; the redacted effective configuration is written to the run. |
| **VI. Flag, Don't Act** | PASS | No credential can change a deployment; the code has no remediation, restart, reconfigure or ticketing path; the post says where to look. Paging stays with the existing monitoring stack (Out of Scope). |
| **VII. Learn Only Through Review** | PASS | Memory changes automatically within `AGENT_WATCHDOG_MEMORY_MAX_TOKENS`, every change a diff. Prompts, tools, skill, priorities, calendar and thresholds change only by PR in `cht-ai-tools` or `medic-infrastructure`. Proposals (skill, prompt, threshold, pattern card) are files for review, never merges. Raw corpus stays under `AGENT_WATCHDOG_CORPUS_RAW_DIR` outside the repository; only scrubbed cards and the content-hash index are public. |
| **VIII. One Audience per Output** | PASS | Every `render` and `publish` function takes `audience` as an explicit argument; this feature passes `internal` everywhere and may link internal tooling and name any project. The partner audience (feature 002) adds a value and its own scoping rules without inference from context. |
| **Security Requirements** | PASS | Secrets arrive from the cluster secret manager as environment variables; none in the image or repository. The container contract requires non-root, read-only root filesystem with writable `/data` and `/tmp`, dropped capabilities, CPU and memory limits, and egress restricted to Grafana, Slack, Anthropic, Langfuse and the documentation service. Dependabot keeps dependencies current and CI fails on `npm audit --audit-level=high`. Model output is schema-validated and escaped before display. Run records live on the encrypted volume; retention is configuration. |
| **Development Workflow and Quality Gates** | PASS | CI jobs: `lint` (zero warnings), `test` with nyc coverage compared against `main`, `replay:eval` when files under `prompts/`, `skill/`, `schema/` or `src/analyze/` change, `audit`, commitlint. PR template asks for dependency justification and confirms `AGENTS.md` and `README.md` reflect changed behaviour. Releases by semantic-release; the image tag is bumped in `medic-infrastructure` by PR. |

**Gate result: PASS.** No principle is violated. Five dependency choices and one evidence-based
adjustment to the Notes are justified in Complexity Tracking.

### Notes for `/speckit.plan`: adoption record

| Note | Plan | Status |
|---|---|---|
| Engine: Agent SDK in production, `claude -p` as the identical local face, one configuration source, bare-mode semantics | `src/agent/engine-sdk.js` and `src/agent/engine-cli.js` consume the same `agent/` definition; isolation via `settingSources: []`, `tools: []`, `permissionMode: 'dontAsk'`, `--bare`, `--tools ""`, `--strict-mcp-config` | Adopted |
| Model `claude-fable-5-1` at maximum effort from the environment; per-stage overrides; SDK budget option; prompt caching by static prefix | `AGENT_WATCHDOG_MODEL`, `AGENT_WATCHDOG_EFFORT`, `_FEEDBACK`, `_CALIBRATION`, `_DISTILL`; `maxBudgetUsd`; system prompt split at the runtime's dynamic-boundary marker so the skill, index and memory are cached across the run's sessions | Adopted |
| Passes: one SDK session per project driven as a multi-turn conversation; pass prompts in `prompts/`; each pass ends with the Stop hook and writes `findings.pass<N>.json`; harness diffs passes | Streaming-input session per project; pass prompts as user turns; findings arrive as `structured_output` on each result and the harness writes `findings.pass<N>.json`; the Stop hook runs the gate as a second line of defence | Adopted; the file is written by the harness because structured output makes a model-side file write unnecessary |
| Configuration: `AGENT_WATCHDOG_` variables, vendor names for vendor credentials, committed `.env.example`, `--env-file`, ConfigMap and External Secrets, zod validation, redacted effective config | environment and config-files contracts; `src/config/` | Adopted |
| Verification: implemented once under `src/verify/`, wired as the SDK Stop hook and a PostToolUse hook on the findings write, called again before publish; the CLI path loads the same checks through `--settings` | `src/verify/` is called by the harness after every turn on both engines and before publish; the SDK additionally runs it in the Stop hook; PostToolUse records tool calls for replay | Adjusted: `claude --bare` skips hooks (verified in the 2.1.278 help text), so the CLI cannot load the checks through `--settings`; the harness-driven gate gives both engines identical behaviour with the same code (research.md R-3) |
| Reference sources: cht-docs-mcp via `mcpServers` and `--mcp-config`, watchdog repository indexed, search tools allowed, synthesised-answer tool off by default | `cht-docs` HTTP server with per-tool policies: `search_docs` and `get_sources` allowed, `ask_question` denied; the watchdog repository is already among the service's sources (verified) | Adopted |
| Metrics through the hosted Grafana's datasource proxy | `src/collect/grafana.js` uses the proxy for PromQL and the Grafana API for dashboards, targets and annotations (research.md R-5) | Adopted |
| Rendering: screenshot of the report's summary element in a headless browser with network disabled; template filled, never generated; designed once with the design skill | `templates/report.hbs` + `src/render/browser.js` with `playwright-core`, `page.route` aborting every request; Chromium provisioning per research.md R-7 | Adopted |
| Storage: 10 Gi volume under `runs/<date>/<project>/`, memory, feedback, proposals, corpus index beside them; raw corpus outside the repository; retention per FR-040 | run-directory contract; raw series gzip-compressed to fit fifty projects for 14 days | Adopted |
| CommonJS on Node 22; SDK through dynamic import if ESM-only | The SDK is ESM-only (`exports` has no `require` condition); loaded with `await import()` inside `src/agent/engine-sdk.js` | Adopted |

## Project Structure

### Documentation (this feature)

```text
specs/001-watchdog-slack-loop/
├── plan.md                  # This file
├── research.md              # Phase 0: verified decisions R-1 to R-14 with sources
├── data-model.md            # Phase 1: entities, identity, validation, state machine
├── quickstart.md            # Phase 1: run and validate locally
├── contracts/
│   ├── environment.md       # Environment variables the deployment supplies
│   ├── config-files.md      # Mounted policy files and the package-shipped definition
│   ├── container.md         # Image, filesystem, user, egress, resources
│   ├── exit-codes.md        # Exit codes and what each means for the scheduler
│   ├── cli.md               # Commands, flags, streams
│   ├── run-directory.md     # Stage inputs and outputs on disk
│   ├── agent-definition.md  # One definition, two engines
│   ├── slack-payload.md     # Message, thread and image shapes; scopes
│   ├── findings.schema.json # Structured output of an analysis pass
│   └── brief.schema.json    # Structured output of the roll-up
└── tasks.md                 # Phase 2 output (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
packages/agent-watchdog/
├── bin/
│   └── agent-watchdog.js          # entrypoint: parseArgs, command dispatch, exit codes
├── src/
│   ├── cli/                       # index.js (parseArgs, dispatch), exit-codes.js, streams.js,
│   │                              # commands/ (run, replay, distill, calibrate, check, purge, tools-server),
│   │                              # stages/ (feedback, collect, analyze, agent, rollup, render, publish)
│   ├── model/                     # identity.js (item_id, run_id, candidate_id, feedback_id), schemas.js (zod)
│   ├── config/                    # zod schemas, env + files + flags precedence, redaction, hard caps
│   ├── log/                       # JSON logger bound to run_id, monotonic stage timestamps
│   ├── store/                     # run directory, atomic writes, gzip, retention purge
│   ├── collect/                   # grafana.js (proxy + API + alerting), discovery.js (groups, ignore), windows.js,
│   │                              # targets.js, alerts.js (Grafana-managed rules and firing instances, US8)
│   ├── alerts/                    # classify.js (alerts.yaml policy, staleness, newness), group.js (per programme and
│   │                              # category), episodes.js (durable episode events and correlations) (US8)
│   ├── analyze/                   # changes.js, baselines.js, calendar.js, candidates.js, thresholds.js
│   ├── feedback/                  # ingest.js (Slack reads), match.js, parse-notes.js, store.js, review.js (US7)
│   ├── agent/                     # definition.js, prompt-assembly.js, engine-sdk.js, engine-cli.js,
│   │                              # session-loop.js, hooks.js, tools/ (watchdog MCP tools, replay shim,
│   │                              # stdio server)
│   ├── verify/                    # gate.js, format.js, checks/ (one module per check)
│   ├── rollup/                    # rank.js, layout.js (five slots, sub-bullets, alert bullets; US9),
│   │                              # brief.js, deterministic-brief.js, memory.js, proposals.js
│   ├── links/                     # build.js (dashboard deep links, alert-list links), allowlist.js, resolve.js
│   ├── render/                    # report.js (Handlebars), browser.js (playwright-core screenshot)
│   ├── publish/                   # slack.js (post, thread, upload, permalink, reactions), payload.js, digest.js, audience.js
│   ├── corpus/                    # index.js, distill.js, scrub.js
│   ├── calibration/               # report.js, suggest.js
│   ├── trace/                     # langfuse.js, cost.js (reconciliation)
│   └── readiness/                 # check.js (CHT URL prerequisites)
├── agent/                         # mcp.template.json, tools.json, hooks.js
├── prompts/                       # system.md, pass-first.md, pass-review.md, rollup.md, feedback-parse.md,
│                                  # calibration.md, distill.md
├── skill/cht-watchdog/            # SKILL.md, references/, pattern-cards/index.md, pattern-cards/*.md
├── schema/                        # findings.schema.json, brief.schema.json (generated from zod, committed)
├── templates/                     # report.hbs, slack/*.hbs
├── config/defaults/               # thresholds.yaml, dashboards.yaml, projects.yaml (groups, ignore), alerts.yaml
├── scripts/                       # build-schema.js, replay-eval.js, record-fixtures.js, build-card-index.js,
│                                  # scan-secrets.js
├── test/                          # mirrors src/ for unit tests; fixtures/ (recorded, scrubbed runs, labels);
│                                  # helpers/; e2e/ (one spec per story); perf/ (fifty projects, thirty-day replay)
├── smoke/                         # credential-needing scripts: grafana, slack, agent-parity, render
├── Dockerfile
├── .env.example  .nvmrc  package.json  eslint.config.js  .mocharc.yml  .nycrc  release.config.js
├── commitlint.config.js
└── AGENTS.md  README.md  LICENSE
```

**Structure Decision**: a single package with one entrypoint and stage modules named after the
pipeline stages in the run-directory contract, so a stage name maps to one directory under `src/`
and one under `test/`. The agent definition (`agent/`, `prompts/`, `skill/`, `schema/`,
`templates/`) sits beside `src/` because it is reviewed code, not configuration; deployment policy
never lives in this tree. Deployment manifests are not in this package.

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `yaml` dependency | Policy files (`projects.yaml`, `dashboards.yaml`, `thresholds.yaml`) are YAML per the Notes and the `.env.example`, and Node has no YAML parser | JSON policy files would be simpler but were decided against in the Notes; `yaml` 2.x is CommonJS, dependency-free and verified to load |
| `@modelcontextprotocol/sdk` as a direct dependency | The CLI engine needs the local read-only tools served over stdio; the Agent SDK's in-process server cannot be reached from a separate `claude` process | It is already installed transitively by the Agent SDK at the same major, so the direct dependency adds no weight and pins the API we call |
| Chromium in the container image | FR-022 and FR-023 require a rendered image that cannot diverge from the report; playwright-core needs a browser binary | Server-side chart images without a browser would duplicate the HTML report's layout in a second renderer, exactly the divergence the spec forbids |
| Langfuse v5 as four packages (`@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@opentelemetry/sdk-node`) instead of the single `langfuse` package | The classic package's own npm description calls it a deprecated v3 client and directs new work to these packages; all four load from CommonJS | One dependency instead of four would be simpler, but it builds a new system on a client the vendor has retired |
| Native Claude Code runtime in the image (about 224 MB) | Inherent to the Agent SDK decision in the Notes; the SDK spawns the platform binary | Calling the Messages API directly would remove the runtime but discard the MCP, hooks, session and structured-output machinery the design relies on |
| Harness-driven verification instead of `--settings` hooks on the CLI engine | `claude --bare` skips hooks by design (verified), so the CLI cannot run the gate as a hook | Running the CLI without `--bare` restores hooks but re-opens filesystem settings discovery; the harness-driven gate keeps both engines on the same code path |

## Post-design Constitution re-check

Re-evaluated after the Phase 1 artefacts were written: the data model introduces no entity the
model can write without validation; every contract keeps credentials read-only and every tool
enumerated; no always-on component was added; the run stays idempotent per date. Result: PASS,
unchanged.

### Revision 8 delta: User Story 7, feedback acknowledged and made permanent

Re-checked on 2026-09-19 for the spec amendment (FR-028, FR-029, FR-040 amended; FR-059 to
FR-063 added).

- **II, III**: the digest is built by code from structured fields (per-item effect, proposals,
  retention statement) and rendered through the escaping templates; note classification is one
  bounded, schema-validated call per note, reactions never reach the model, and a failed call
  degrades to "not yet classified" without failing the run. The roll-up prompt now receives the
  day's matched feedback with author ids removed, and `prompts/rollup.md` is filled rather than
  sent with literal placeholders.
- **IV**: one new scope, `reactions:write`, on the same single channel; the digest names no
  person; author ids stay raw Slack ids on the private volume, never rendered.
- **V**: no new process; review runs inside the feedback stage and the digest inside publish. The
  influence window is configuration with a hard cap in code; permanence of `feedback.jsonl` is a
  retention-class change, not a code path the environment can alter.
- **VII**: every lesson from a note becomes a proposal file for one of five destinations, now
  including a `project_annotation` proposal that carries a ready-to-paste `projects.yaml`
  fragment; nothing is applied automatically; open proposals are listed weekly with their age.
- **Complexity**: no new dependency; `reactions.add` is in the Slack client already used.
  Result: PASS.

### Revision 9 delta: User Stories 8 and 9, alerts and grouped briefing

Re-checked on 2026-09-19 for the spec amendment (FR-010, FR-015, FR-019 amended; FR-064 to FR-070
added; the body limit is five bullets of two lines with eight one-line sub-bullets).

- **I**: no new dependency. Host patterns are two-wildcard globs converted to anchored regular
  expressions in code; `alerts.yaml` follows the existing policy-file pattern (`yaml`, zod, hashed
  into `config_hash`).
- **II**: the fake Grafana gains the two alerting endpoints and a recorded alert day
  (`test/fixtures/runs/alerts-day`), so every new path replays offline; the gate's new limits and
  the layout rule have fixture-driven tests before the constants change; the alerting endpoints,
  the link form and the sub-bullet rendering are smoke tests S-14 to S-16 (research.md R-14).
- **III**: alert collection, classification, staleness, newness, grouping, counts, the alert-list
  link, the body layout and every `group` and `alerts` bullet are code; the model writes only item
  bullet text, and the gate rejects a draft whose item ids differ from the layout. Episode
  correlations are computed; the model's only contribution to an episode is an explanation copied
  from a gate-accepted item.
- **IV**: the same Viewer token reads the alerting endpoints, whose read actions the Viewer role
  holds (R-14); no new credential, no new Slack scope, one new registered metadata event type.
  Rule titles, labels, annotations and values are untrusted data: stored verbatim, wrapped when a
  project's firing alerts reach the analysis prompt, escaped on render, and placed in bullet text
  only through code-built count lines. Ignored hosts are never analysed and never named.
- **V**: no new process or stage; alerts flow collect, analyze, rollup, publish through files in
  the run directory, and "alerts unavailable" is a notice while the run completes.
- **VI**: the brief reports alerts and groups; it silences, acknowledges or changes nothing in
  Grafana.
- **VII**: `alerts.yaml` and the group patterns change only by pull request; an unknown rule is
  reported as uncategorised rather than guessed; the run writes `alerts.classified.json` and
  episode events, never policy.
- **VIII**: still one internal audience; group labels and alert counts add nothing partner-facing.
- **Complexity**: sub-bullets render as indented lines inside a bullet's `section` because Slack
  `mrkdwn` has no nested lists; the layout rule replaces the fixed three slots with five slots that
  can hold sub-bullets, which is the smallest change that gives "Nepal: 5 projects with issues"
  its own line. Result: PASS.

### Revision 10 delta: valid queries for every panel expression (FR-071)

Re-checked on 2026-09-20 after the first preview run against the hosted watchdog answered 400 for
every derived metric's trailing baseline and for every expression using the dashboards' `$interval`
variable (research.md R-15).

- **I**: no new dependency; variable resolution and the subquery form are a few lines of code in
  `src/collect/`.
- **II**: the fake Grafana now rejects what Prometheus rejects (an unsubstituted variable, a range on
  anything but a selector) with the same 400 envelope, so the two failures replay offline and cannot
  return; the hosted check is smoke test S-17 in `smoke/grafana.js`.
- **III**: resolution is deterministic and recorded: each dashboard's variables and each panel's
  unresolved ones are written to `discovery.json`; a metric that cannot be resolved is unavailable,
  never guessed.
- **IV**: the same Viewer token; the resolved values come from the dashboard documents already read.
- **V**: no new stage; the Grafana client's error message now carries the response detail, so the
  next such failure is legible from the log alone.
- **VI to VIII**: unchanged. Result: PASS.

### Revision 11 delta: collection at a hundred projects (FR-072 to FR-074)

Re-checked on 2026-09-20 after the first hosted run: 95 projects, 364 range queries and about
65 seconds per project, one query timeout failing the run (research.md R-16).

- **I**: no new dependency; the ledger is a JSON file per project under the data volume, written
  atomically like every other artefact; one new environment variable
  (`AGENT_WATCHDOG_QUERY_TIMEOUT_MS`) with a hard cap.
- **II**: the reuse of stored windows, the ledger, the retry and the consecutive-failure rule are
  unit-tested against a temporary data volume and a fake client; the fifty-project performance
  test counts queries on a cold and a warm day; the hosted numbers are smoke test S-18.
- **III**: what is reused is decided by exact bounds, step and metric, never by proximity; every
  window records its source; a fetched trailing window fills the ledger rather than the ledger
  guessing a day.
- **IV**: the same Viewer token, fewer requests; nothing new is stored beyond one number per metric
  per day, and the ledger is compacted by the existing purge.
- **V**: no new stage and no database; the collect stage gains a bounded worker pool with the
  concurrency setting the analysis stage already honours; per-project logs name fetched and reused
  counts, and every failed query names its metric and window.
- **VI**: a slow query degrades one window, and the brief says which metrics were unavailable, as
  before; nothing is retried more than once.
- **VII**: unchanged.
- **VIII**: unchanged.
- **Complexity**: reuse adds one module (`src/collect/history.js`) and one field (`source`) to the
  Metric Window; it removes the trailing subqueries from the daily path, which were the slow and
  fragile part. Result: PASS.

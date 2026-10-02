# Implementation Plan: Watchdog Slack Loop

**Branch**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-watchdog-slack-loop/spec.md`

## Summary

A scheduled Node 22 CommonJS command, `agent-watchdog run`, discovers the CHT projects scraped by
Medic's hosted CHT Watchdog through its Grafana, collects metric windows through Grafana's
datasource proxy, computes changes and candidates deterministically, then opens one bounded
Claude Agent SDK session per project with candidates: two passes in one session, read-only MCP
tools only, schema-validated structured output, and a verification gate that runs in code between
turns and again before publication. The roll-up posts one Slack message with at most two programme
bullets of up to three project lines, the report shared into the thread, one reply per further
programme with two or more flagged projects, one "Other" reply, one alerts reply, and a footer with
specification, configuration, trace and cost links. The next run reads reactions and notes, updates capped memory by diff, and writes
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
1.6x (retained for the smoke test's browser check only since revision 24 retired the image), `@langfuse/tracing`, `@langfuse/otel` and `@langfuse/client` with `@opentelemetry/sdk-node` (the
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

**Scale/Scope**: up to about a hundred projects, up to 10 dashboards and roughly 200 panel expressions
per project, one post per day with at most two programme bullets of up to three project lines each, up to
500 firing alert instances, seven runs of feedback look-back, a knowledge corpus of hundreds of
files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| **I. CHT Conventions Are Not Optional** | PASS | CommonJS JavaScript, no TypeScript in this package (the SDK is consumed from JavaScript). Node 22 pinned in `.nvmrc` and the image. `@medic/eslint-config` extended through `@eslint/eslintrc` FlatCompat in `eslint.config.js`, as cht-core does; `npm run lint` with zero warnings is a CI gate. mocha, chai with chai-as-promised, sinon, nyc; `test/` mirrors `src/`. Conventional Commits `type(#issue): subject`, enforced by commitlint with the scope optional until this founding branch merges (Complexity Tracking); PRs target `main`. semantic-release publishes the container image on release. AGPL-3.0 `LICENSE`. The exact eslint and chai majors follow cht-core (research.md R-9). |
| **II. Test-First and Replayable** | PASS | Red-green-refactor per module. External systems sit behind small modules (`src/collect/grafana.js`, `src/publish/slack.js`, `src/agent/engine-sdk.js`, `src/agent/engine-cli.js`, `src/trace/langfuse.js`) stubbed with sinon and driven by recorded fixtures. Every run persists inputs, changes, candidates, prompts and tool results (run-directory contract); `agent-watchdog replay` regenerates findings offline. Prompt, skill and model-parameter changes must pass `npm run replay:eval` and attach the replay diff to the PR (quality gate 3). |
| **III. Deterministic Before Generative** | PASS | `src/analyze/` computes percentage change, deviation, monotonic rise, baselines and expected-load adjustments with unit tests; `src/analyze/candidates.js` applies thresholds. The model runs at most `AGENT_WATCHDOG_PASSES` passes (hard cap 4) of at most `AGENT_WATCHDOG_MAX_TURNS` turns (hard cap 50) under `maxBudgetUsd`, returning schema-validated structured output; later passes review earlier ones and stop on an empty diff. Every model stage has a degraded path (`src/rollup/deterministic-brief.js`) that labels itself. The gate (`src/verify/`) checks schema, known projects and metrics, number matching, dates, link construction and allow-list, structure limits, secrets; failures return to the model at most twice, then degrade. The model composes no URLs: links are built by `src/links/build.js` from `dashboard_ref`, and `reference_urls` must have appeared in tool results. |
| **IV. Least Privilege and Explicit Trust Boundaries** | PASS | Credentials: Grafana service-account token with Viewer role; Slack bot token with post, upload, read and reaction scopes on one channel (`reactions:write` added by User Story 7 for the "seen" reaction; still the single configured channel, still no write to any deployment); Langfuse write keys. Nothing grants write access to a CHT deployment or to this package. The model's tools are `tools: []` plus an enumerated MCP allow-list (agent-definition contract). Fetched text is wrapped in labelled `<untrusted>` delimiters in prompts and rendered only through Handlebars escaping. The agent writes only its memory (capped, stored as diffs) and proposal files; prompts, tools and skill are read-only paths. Secrets are redacted by key in logs and the effective configuration; Slack user ids never leave `feedback.jsonl`. Partner-facing output is out of scope here; the hostname scan already runs on proposals (FR-033). |
| **V. Simple, Observable, Boring** | PASS | One process and one entrypoint, `bin/agent-watchdog.js`; the daily CronJob runs `run`, and the weekly `calibrate` and on-demand `distill` are subcommands of the same image, not services. One agent definition consumed by both engines. JSON logs on stderr bound to `run_id` with monotonic timestamps at every stage boundary; one Langfuse trace per run with a span per stage; token usage and cost per run in the footer. Idempotent per date with an explicit `--force`. Loud failure: failure notice plus non-zero exit codes (exit-codes contract). Node built-ins first: `fetch`, `node:util` `parseArgs`, `node:crypto`, `node:fs/promises`, `node:zlib`. Each new dependency is justified in Complexity Tracking and CommonJS-compatible (verified). Twelve-factor configuration validated by zod at startup; the redacted effective configuration is written to the run. |
| **VI. Flag, Don't Act** | PASS | No credential can change a deployment; the code has no remediation, restart, reconfigure or ticketing path; the post says where to look. Paging stays with the existing monitoring stack (Out of Scope). |
| **VII. Learn Only Through Review** | PASS | Memory changes automatically within `AGENT_WATCHDOG_MEMORY_MAX_TOKENS`, every change a diff. Prompts, tools, skill, priorities, calendar and thresholds change only by PR in `cht-ai-tools` or `medic-infrastructure`. Proposals (skill, prompt, threshold, pattern card) are files for review, never merges. Raw corpus stays under `AGENT_WATCHDOG_CORPUS_RAW_DIR` outside the repository; only scrubbed cards and the content-hash index are public. |
| **VIII. One Audience per Output** | PASS | Every `render` and `publish` function takes `audience` as an explicit argument; this feature passes `internal` everywhere and may link internal tooling and name any project. The partner audience (feature 002) adds a value and its own scoping rules without inference from context. |
| **Security Requirements** | PASS | Secrets arrive from the cluster secret manager as environment variables; none in the image or repository. The container contract requires non-root, read-only root filesystem with writable `/data` and `/tmp`, dropped capabilities, CPU and memory limits, and egress restricted to Grafana, Slack, Anthropic, Langfuse and the documentation service; since revision 30 FR-086 states these as requirements, the image is checked under them in CI, the package emits the egress list for the platform's policy and guards its own requests in process (FR-083). Dependabot keeps dependencies current and CI fails on `npm audit --audit-level=high`. Model output is schema-validated and escaped before display. Run records live on the encrypted volume; retention is configuration. |
| **Development Workflow and Quality Gates** | PASS | CI jobs: `lint` (zero warnings), `test` with nyc coverage compared against `main`, `replay:eval` when files under `prompts/`, `skill/`, `schema/` or `src/analyze/` change, `audit`, commitlint. PR template asks for dependency justification and confirms `AGENTS.md` and `README.md` reflect changed behaviour. Releases by semantic-release; the image tag is bumped in `medic-infrastructure` by PR. |

**Gate result: PASS.** No principle is violated. Five dependency choices and one evidence-based
adjustment to the Notes are justified in Complexity Tracking.

### Notes for `/speckit.plan`: adoption record

| Note | Plan | Status |
|---|---|---|
| Engine: Agent SDK in production, `claude -p` as the identical local face, one configuration source, bare-mode semantics | `src/agent/engine-sdk.js` and `src/agent/engine-cli.js` consume the same `agent/` definition; isolation via `settingSources: []`, `tools: []`, `permissionMode: 'dontAsk'`, `--bare`, `--tools ""`, `--strict-mcp-config` | Adopted |
| Model `claude-sonnet-5` at high effort, the shipped default, overridable from the environment; per-stage overrides; SDK budget option; prompt caching by static prefix | `AGENT_WATCHDOG_MODEL`, `AGENT_WATCHDOG_EFFORT`, `_FEEDBACK`, `_CALIBRATION`, `_DISTILL`; `maxBudgetUsd`; system prompt split at the runtime's dynamic-boundary marker so the skill, index and memory are cached across the run's sessions | Adopted |
| Passes: one SDK session per project driven as a multi-turn conversation; pass prompts in `prompts/`; each pass ends with the Stop hook and writes `findings.pass<N>.json`; harness diffs passes | Streaming-input session per project; pass prompts as user turns; findings arrive as `structured_output` on each result and the harness writes `findings.pass<N>.json`; the Stop hook runs the gate as a second line of defence | Adopted; the file is written by the harness because structured output makes a model-side file write unnecessary |
| Configuration: `AGENT_WATCHDOG_` variables, vendor names for vendor credentials, committed `.env.example`, `--env-file`, ConfigMap and External Secrets, zod validation, redacted effective config | environment and config-files contracts; `src/config/` | Adopted |
| Verification: implemented once under `src/verify/`, wired as the SDK Stop hook and a PostToolUse hook on the findings write, called again before publish; the CLI path loads the same checks through `--settings` | `src/verify/` is called by the harness after every turn on both engines and before publish; the SDK additionally runs it in the Stop hook; PostToolUse records tool calls for replay | Adjusted: `claude --bare` skips hooks (verified in the 2.1.278 help text), so the CLI cannot load the checks through `--settings`; the harness-driven gate gives both engines identical behaviour with the same code (research.md R-3) |
| Reference sources: cht-docs-mcp via `mcpServers` and `--mcp-config`, watchdog repository indexed, search tools allowed, synthesised-answer tool off by default | `cht-docs` HTTP server with per-tool policies: `search_docs` and `get_sources` allowed, `ask_question` denied; the watchdog repository is already among the service's sources (verified) | Adopted |
| Metrics through the hosted Grafana's datasource proxy | `src/collect/grafana.js` uses the proxy for PromQL and the Grafana API for dashboards, targets and annotations (research.md R-5) | Adopted |
| Rendering: the report template filled, never generated, in its original design (a design-skill redesign was tried in revision 24 and set aside in 25); no browser in a run since revision 24 retired the image; the browser renderer and its Chromium path left with the image in revision 30 | `templates/report.hbs` + `src/render/report.js`; Chromium provisioning per research.md R-7, removal pending the container revision | Adopted |
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
│   ├── slack-payload.md     # Message and thread shapes; scopes
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
│   ├── rollup/                    # rank.js, layout.js (two slots of three project lines; US9),
│   │                              # brief.js, deterministic-brief.js, memory.js, proposals.js
│   ├── links/                     # build.js (dashboard deep links, alert-list links), allowlist.js, resolve.js
│   ├── render/                    # report.js (Handlebars); browser.js retained for the smoke test only
│   ├── publish/                   # slack.js (post, thread, upload, permalink, reactions), payload.js, digest.js, audience.js
│   ├── corpus/                    # index.js, distill.js, scrub.js
│   ├── calibration/               # report.js, suggest.js
│   ├── trace/                     # langfuse.js
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
| Chromium in the container image | Removed in revision 30 (FR-086): nothing in a run had used it since revision 24, and `playwright-core` left the dependencies with it | An unused browser in a hardened image widened its attack surface and its size for nothing a reader used (research.md R-35) |
| Langfuse v5 as four packages (`@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@opentelemetry/sdk-node`) instead of the single `langfuse` package | The classic package's own npm description calls it a deprecated v3 client and directs new work to these packages; all four load from CommonJS | One dependency instead of four would be simpler, but it builds a new system on a client the vendor has retired |
| Native Claude Code runtime in the image (about 224 MB) | Inherent to the Agent SDK decision in the Notes; the SDK spawns the platform binary | Calling the Messages API directly would remove the runtime but discard the MCP, hooks, session and structured-output machinery the design relies on |
| Plain `type: subject` commit headers on this founding branch (constitution I asks for `type(#issue): subject` and an issue) | The branch predates its issues and none will be opened for it; every later change references its issue. Expires when this branch merges: the commitlint scope becomes mandatory then (revision 37). | Opening one issue after the fact would give every commit a reference that says nothing about the work. |
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
  can hold sub-bullets, which is the smallest change that gives "North Programme: 5 projects with issues"
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

### Revision 14 delta: User Stories 10 and 11 planned (FR-076 to FR-082)

Checked on 2026-09-20 when the two stories proposed in revision 13 were accepted.

- **I**: no new dependency. Metric kinds are a list in `thresholds.yaml` with the stock CHT metrics as
  the code default; emoji are Unicode characters placed by code; the container image gains the Noto
  colour emoji font so the rendered image shows them.
- **II**: kinds, increases, restarts, deduplication, patterns, housekeeping, resolved lines, ranking
  and markers are all unit-tested; the fake watchdog accumulates a counter so the fixture days keep
  their recorded candidates; the fixtures use placeholder programme names and hosts, never the
  hosted watchdog's.
- **III**: which metrics are counters, which alerts form a pattern, which are housekeeping and how
  items rank are all decided by code from the policy and the data; the model still writes only
  item text.
- **IV**: nothing new is read or stored; the ledger and the run directory carry the same data.
- **V**: no new stage; the roll-up gains notice builders and the payload gains markers.
- **VI**: housekeeping suggests removing or silencing a stale alert; the watchdog changes nothing.
- **VII**: `metric_kinds` and the alert categories change by pull request; a metric absent from the
  lists is a gauge, never guessed.
- **VIII**: one audience; markers are status and severity only (FR-015). Result: PASS.

### Revision 12 delta: one series per project (FR-075)

Re-checked on 2026-09-20 after the second hosted run: the per-route p90 panel timed out and hit
Prometheus's sample limit as a trailing subquery, and ten API panels group by route or code
(research.md R-17).

- **I**: no new dependency; a regular expression over the panel expression and a series count at
  collection.
- **II**: unit tests for the grouping forms (`by`, `without`, `topk`, `bottomk`, `by (le)` alone) and
  for a query answering several series; no fixture changes, since the fixture dashboards group by
  `le` only.
- **III**: what is analysed is decided from the expression and the result, never by picking one
  series; the reason names the differing labels.
- **IV** and **V**: fewer queries, no new stage; the skipped panels are named once per dashboard in
  the log and in `discovery.json`.
- **VI to VIII**: unchanged. The breakdown story is recorded as Out of Scope rather than half-built.
  Result: PASS.

### Revision 15 delta: the command-line engine on the operator's login (FR-050)

Re-checked on 2026-09-20 after a contributor's preview run with `AGENT_WATCHDOG_ENGINE=cli` and no
API key exited 78: `claude` was logged in on a Team plan, and `--bare` never reads a login
(research.md R-3, login mode).

- **I**: no new dependency; the key's requirement depends on the engine, and the engine drops
  `--bare` for `--setting-sources ""` when no key is configured.
- **II**: tests first in `test/config/load.spec.js` and `test/agent/engine-cli.spec.js`; the fake
  `claude` records the environment it starts with, so both modes are asserted without the network.
- **III**: unchanged; authentication is not analysis.
- **IV**: nothing new is stored; auto memory is switched off in both modes so a run leaves nothing in
  the operator's memory directory, and no session is persisted.
- **V**: the same engine and the same argument list apart from the isolation flags; the mode is
  logged once per engine as `agent.cli_auth`.
- **VI**: unchanged.
- **VII**: no settings file, rule or instruction file of the operator's reaches the prompt in either
  mode; managed settings still apply, as the runtime documents.
- **VIII**: unchanged. Result: PASS.

### Revision 16 delta: live alert snapshots on a re-run, and sessions stopped before a result

Re-checked on 2026-09-20 after the first single-project run on the operator's login: the roll-up
threw on a negative episode duration, and the only session was stopped by its budget before a first
result while the brief would have read "alerts only" (research.md R-21).

- **I**: no new dependency; the run's clock reaches the stages as `ctx.now` and one pure module,
  `src/rollup/analysis.js`, derives the analysis record from the pass files.
- **II**: tests first: episode times from the observation time and the clamp, `days_firing` from
  `fetched_at`, the analysis record, the cut-off notice and the degraded brief; the e2e alert day
  now expects the clock time on the cleared episode.
- **III**: what counts as "stopped before a result" is decided by code from the pass file's bounds
  and items; the brief text is fixed wording with counts and the spend.
- **IV**: `alerts.classified.json` gains `observed_at`; nothing else is stored.
- **V**: no new stage; the roll-up reads the same files.
- **VI**: unchanged.
- **VII**: unchanged.
- **VIII**: one audience; the log carries the operator hint (which variable to raise), the brief only
  the fact and the spend. Result: PASS.

### Revision 17 delta: a run that read as quiet, and four defects in the same output

Re-checked on 2026-09-20 after a single-project preview exited 0 at $0.00 with "Alerts only": the
model id was a typo the runtime reported as an error result, which the harness took for a turn
without structured output (research.md R-22). The same payload showed a reply cut mid-link, two
hosts misgrouped by a scrape port, a resolved line on an ignored host, and stale alerts on dead
hosts not treated as housekeeping in a preview.

- **I**: no new dependency; a regular expression on model ids, two fields on the mapped result, a
  fitting loop over the reply's parts, and links without the host filter from the same builder.
- **II**: tests first for each: the mapper's `is_error`, the session loop's error bound without
  retries, the model id rejection, the reply fitting (43 and 140 hosts), the port strip, ignored
  hosts on episodes and the resolved notice, dead hosts from discovery.
- **III**: what fails, what fits and what is dead are all decided by code from the runtime's own
  message, the block limit and discovery's target health.
- **IV**: `alerts.classified.json` gains `ignored_hosts`; nothing else is stored.
- **V**: no new stage.
- **VI**: unchanged.
- **VII**: the model id is configuration, validated where the rest is; no prompt changes.
- **VIII**: one audience; the reply keeps its links whole because they are what the reader clicks.
  Result: PASS.

### Revision 18 delta: the gate must not ask the model for what the run computed (FR-009, FR-018)

Re-checked on 2026-09-20 after the first complete single-project run: it cost $2.28, of which $2.00
bought nothing. Four of five model turns were rejected, every one of them on `dates_match` against
`dashboard_ref`, and pass 1 was never accepted so its items were discarded (research.md R-23).

- **I**: no new dependency. One new pure module, `src/links/dashboard-ref.js`, beside the builder
  that already turns a reference into a URL.
- **II**: tests first for each of the three: the reference built from the collected windows and its
  fallbacks; the revision request carrying only failing reasons; the two gate false positives. The
  recorded findings fixtures lose the field with them, so replay proves the contract.
- **III**: the correction itself. The dashboard, the panel and the window bounds are all recorded by
  collection; asking the model to restate them was asking it to compute what code holds. The model
  keeps what it is for: which window matters, named through the evidence it cites.
- **IV**: nothing new is stored. `dashboard_ref` keeps its shape on the Item, so the run record, the
  payload and the link builder are unchanged.
- **V**: no new stage; the gate's own output is what changed.
- **VI**: unchanged.
- **VII**: the model-facing output schema is code, changed here by pull request with its prompt.
- **VIII**: unchanged. Result: PASS.

### Revision 19 delta: a filtered brief, honest tool contracts, first cost levers (FR-016, FR-066)

Re-checked on 2026-09-20 after the run that converged for the first time. It was correct and
expensive, and it showed three separable problems (research.md R-24).

- **I**: no new dependency. One pure module for the tool-call summary; the rest is existing code.
- **II**: tests first for each: the roll-up scoped to the analysed projects while the episode
  record stays whole; a refused tool that was never allowed; the metric tool accepting a collected
  key; a date that is not a phone number and reference findings counted apart; the skipped review
  pass; the review-model override.
- **III**: what the brief covers, which refusals matter, which metric keys are valid and when a
  review pass is pointless are all decided by code from the run's own record. The `not_selected`
  change asks the model for less prose; it does not let code write the reasons.
- **IV**: nothing new is stored. `alerts.classified.json` and `alerts/episodes.jsonl` deliberately
  stay whole on a filtered run, so a narrow preview cannot corrupt the next full run's newness or
  make another project's episode look cleared.
- **V**: no new stage. The roll-up regroups from the classified instances it already reads.
- **VI**: unchanged; the watchdog still only reports.
- **VII**: the prompts and the output schema change by pull request with their tests. Pricing the
  review passes separately was dropped on inspection: the model is bound when the session opens, so
  it would cost the shared session FR-057 requires.
- **VIII**: one audience. A brief that names projects the run never looked at is the audience rule
  failing in practice, and this is the fix. Result: PASS.

### Revision 20 delta: the analysis's own judgements become data (FR-009, FR-014a, FR-058)

Planned on 2026-09-21 after reading what the converged runs already record and never use
(research.md R-25). Both deltas take a judgement the analysis already makes and keep it, rather
than asking it for anything new.

- **I**: no new dependency. One pure module for the selection summary; the relation is a field.
- **II**: tests first: the dismissal evidence and its ranking below a human verdict, the report's
  per-rule counts and commonest reasons, the relation resolved from a metric to an item identity,
  and verification rejecting a metric that is not a sibling item.
- **III**: the arithmetic stays code's. A dismissal is an input datum and a relation is a claim;
  the counting, the ranking and the resolution from metric to identity are all deterministic, and
  nothing is proposed automatically (FR-032).
- **IV**: nothing new is collected. `not_selected` and the relation both live in files the run
  already writes, and the weekly report is the only new reader.
- **V**: no new stage. The calibration command gains a reader; the gate gains a check.
- **VI**: unchanged. The report proposes and a person decides, and a dismissal by the analysis is
  explicitly ranked below a dismissal by a person.
- **VII**: the findings schema and the prompts change by pull request with their tests.
- **VIII**: unchanged. The relation is within one project's items, so nothing crosses an audience.
  Result: PASS.

Deliberately not planned: analysing one project and reusing the conclusion on others. A shared
judgement reaches every brief at once, and the reviewed pattern card already carries a lesson from
one project to all of them with a person in the loop (research.md R-25, Rejected).

### Revision 21 delta: a streak counted in dates, not in runs (FR-009)

Planned on 2026-09-20 after three forced re-runs of one date published "persisting 3 days" for one
day of movement (research.md R-26). The fix is a unit change, not a feature: `persisting_days`
counts consecutive preceding analysed dates, the latest run of a date is the authoritative one, and
the specification's own contradiction between FR-009's "days" and the data model's "prior runs" is
resolved in favour of days, because days are what the brief publishes to a person.

- **I**: no new dependency. The date of a run is the first ten characters of its id.
- **II**: tests first: two forced runs of one date reporting the same streak, the next date
  reporting one more, a missing ranked-items file on the authoritative run ending the streak, and a
  re-run of an older date counting only dates before it.
- **III**: the arithmetic stays code's, and moves further into code's hands. The analysis is never
  asked for the streak; it reads the value the roll-up computed.
- **IV**: nothing new is stored. No first-seen date, no index: the grouping is derived from run ids
  the store already guarantees the shape of (`RUN_ID_PATTERN`).
- **V**: no new stage. One roll-up helper changes its key and `rankItems` keeps its signature.
- **VI**: unchanged. Nothing acts on the number; it is shown and it orders items (FR-081).
- **VII**: no prompt or schema change. The model neither emits nor is asked for this field.
- **VIII**: unchanged, and slightly better served: the number the brief shows a person now means
  what its label says.
  Result: PASS.

`previousRunIds` stays run-keyed. Its three other callers — the previous discovery for episode
correlation, the previous classified alerts for newness, the previously discovered hosts — all mean
the most recent earlier *run* that wrote a given file, and alert newness is measured against the
immediately preceding snapshot by design (FR-065). Only the persistence streak changes unit.

Deliberately not planned: reporting a first-seen date or a total number of sightings alongside the
streak. Both are new numbers for a reader to interpret and neither was asked for; the streak with an
honest unit is the whole of this revision (research.md R-26, Also considered).

### Revision 22 delta: the gate stops rejecting the run's own numbers, one pass by default (FR-016, FR-017, FR-018, FR-056, FR-057)

Planned on 2026-09-21 after a ninety-project run on Sonnet 5 whose session ledger showed 100 gate retries
on 157 first attempts, 70 of them caused only by two checks refusing the run's own identifiers and
values, and whose review passes cost 45% of the run while changing nothing in 26 of 40 cases
(research.md R-27). Four deltas, all measured, none adding a store or a stage.

- **I**: no new dependency. Three exemption sets are built from the discovery the run already holds.
- **II**: tests first for all four: the three exemption classes and the still-caught telephone number;
  the rejected-on-every-attempt project named with its commonest failing check; the review prompt
  without the candidates, changes and alerts and with the previous items; the history tool keyed on
  analysed dates.
- **III**: the arithmetic moves further into code. The gate stops asking the model to avoid the run's
  own window names, expression numerals and panel ids, and the history tool stops presenting run-keyed
  entries as time.
- **IV**: nothing new is stored. The pass record's `gate` and the run ids already carry what the
  roll-up and the tool need; rejected attempts' reports stay where the revision prompts already keep
  their reasons.
- **V**: no new stage. The gate changes two checks, the roll-up reads a field it already stores.
- **VI**: unchanged. The brief flags a fully rejected project; nothing acts on it.
- **VII**: the review template and the two checks change by pull request with their tests.
- **VIII**: unchanged.
  Result: PASS.

The default number of passes becomes one. The within-pass revision loop (FR-017) is untouched and
remains how a gate failure is corrected; the review pass stays available through the environment for
calibration periods. The pass-loop skip condition that let a fully rejected first pass fall through to
a review pass is deliberately unchanged (research.md R-27).

Deliberately not planned: storing every rejected attempt's report; the deterministic high-severity
rules, dark-host sessions and near-identical backlog items of the same run, which need a decision about
what code hands the model at all; and panel screenshots in the brief, which the Clarifications answer
with No.

### Revision 23 delta: a thread a person can read, a gate that trusts its own text, a roll-up that recovers, and what code hands the model (FR-009, FR-013, FR-014, FR-016, FR-017, FR-020, FR-022, FR-027, FR-075, FR-080)

Planned on 2026-09-21 after the first ninety-project run to complete on one pass (Sonnet 5, $39.41):
150 items became 159 thread replies under one post, 78 of 90 sessions still retried because the
gate refused numerals the model had read in its own session, the roll-up was rejected three times
on one or two bullets each and degraded, 48 of the 56 high items were one deterministic rule that
already held the day before, eight sessions described hosts dark for weeks, and six reference-line
targets produced 161 of 1,189 candidates (research.md R-28). Six deltas, all measured.

- **I**: no new dependency. The report share uses the `files.uploadV2` the image already uses; the
  roll-up session uses the `openSession` the project sessions use.
- **II**: tests first for all six: the body-only replies, the cap and the report share; `#rank` and
  inline thumbs in `matchNote` and the ingester; the given-text exemption scoped per bullet and the
  two-decimal phone match; the roll-up's single session, its merged draft and its prompt record;
  standing conditions withheld from sessions and named by code; reference lines classified out of
  collection; related items nested in the report and named in a reply.
- **III**: more judgement moves into code. Standing conditions and reference lines are decided
  from fields the run already computes; the gate stops asking the model not to quote its input; a
  retry mends only the failing bullets; presentation of related items follows a field the analysis
  already fills.
- **IV**: four derived artefacts are added and named here, nothing the model wrote is stored anew:
  `reference_line` on a panel record (as `breakdown` is), `rollup/prompt.md` (as `prompt.pass<n>.md`
  is), `rollup/standing.json` (as `layout.json` is, so the report can list hosts) and the report
  share's file id and `ts` on the payload and `publication.json` (as the image's id is). A note's
  verdict fills a field that was null for notes.
- **V**: no new stage. Analyze classifies, agent withholds, rollup names, render lists, publish
  shares; each in the stage that owns it.
- **VI**: unchanged. Standing conditions and dark hosts are flagged once; nothing acts on them.
- **VII**: `prompts/pass-first.md` gains one sentence (name another item's metric, never the item's
  own) and the roll-up's revision text changes, both by pull request with tests.
- **VIII**: unchanged; the report and the thread address the same internal audience.
  Result: PASS.

Deliberately not planned: a configurable reply cap; a report link on the parent to a private file;
exempting every numeral of the items JSON for the brief; a layout change for related items;
reclassifying the clock-skew gauge; deduplicating backlog items against firing alerts; storing
rejected draft texts beyond `brief.draft<n>.json` (research.md R-28).

### Revision 24 delta: the report becomes the document, the standing rule stops leaking, the gate verifies the model's arithmetic (FR-009, FR-014, FR-015, FR-016, FR-019, FR-022, FR-023, FR-025, FR-066, FR-075, FR-082)

Planned on 2026-09-21 from the first run on revision 23 (research.md R-29): 20 replies instead of 159
and a recovered roll-up, but 42 of 43 high items still the chronic backlog through the metric's
`monotonic` candidates, reference lines excluded from discovery yet still fetched, three projects
rejected on a signed decimal read as a phone number, and 67 of 83 sessions retried on arithmetic the
model did correctly. The operator's additions: retire the brief image now that the report is shared,
make the report the readable document (links where the reader can follow them, a footer with the
run's links, numbers rounded for reading, a redesign under the plan's design skill), and run one
programme at a time. Where each lands:

| Change | Story | Requirements |
|---|---|---|
| Standing metric floor, `monotonic` withheld on a standing metric, system prompt sentence | US1 | FR-014 |
| Reference lines never collected; analysis over `discovery.metrics` only | US1 | FR-075 |
| Signed decimals are values; derived values accepted; self-`relates_to` dropped by code | US1 | FR-016, FR-009 |
| Brief image retired | US1 | FR-019, FR-023 (retired), FR-025, FR-082 |
| Report links (setting `AGENT_WATCHDOG_REPORT_LINKS`), footer links, rounding, redesign | US1, groundwork for the recipients story (Out of Scope) | FR-015, FR-019, FR-022 |
| `--group` filter | US3 | FR-066, contracts/cli.md |

- **I**: no new dependency. The redesign uses system font stacks and CSS in the template; links reuse
  `src/links/build.js`; the group filter reuses discovery's groups.
- **II**: tests first for every delta: candidate floors and the withheld `monotonic`; the query list
  without reference lines and changes only for collected metrics; signed decimals; derived values and
  the dropped self-relation; a payload and publisher without an image; report links in both modes,
  the footer, rounding and the sections; the group filter in every stage and the scope.
- **III**: the gate verifies the model's arithmetic instead of forbidding it; floors and withholding
  are decided from the computed change; links are built from structured references; rounding is
  render-time formatting of stored values.
- **IV**: less is stored (no `brief.png`); one derived field is added, `panel_ref` on a standing
  record, so the report can link the host's panel without re-deriving it. A setting is configuration,
  not storage.
- **V**: no new stage. Collect, analyze, agent, rollup, render and publish each change in their own
  file.
- **VI**: unchanged.
- **VII**: `prompts/system.md`'s severity sentence and the report template change by pull request
  with tests; the template's design read is recorded in its header.
- **VIII**: one audience per output. The report is still the internal report; the link setting
  prepares the same document for readers without watchdog access without splitting the audience of
  this run.
  Result: PASS.

Deliberately not planned: the backlog threshold from the panel's reference line (research.md R-29);
removing Chromium from the container; a per-programme channel or recipient; rounding inside Slack
replies; dropping FR-082's markers from the report.

### Revision 25 delta: the original report design with its links, one footer for post and report, threads for what needs a person, a gate that reads what it was given (FR-015, FR-016, FR-019, FR-020, FR-022, FR-056, FR-066)

Planned on 2026-09-21 from the first run on revision 24, one programme of 30 projects (research.md
R-30): the links, the rounding, the standing floor and the group filter all did what was asked, and the
operator set the redesign aside in favour of the original report and post, asked for one footer on both
with the specification linked instead of the prompts, a cleaner item header, thread replies for high
items and alert groups only, and a notice that says in words what "rejected by the gate (commonest
reason: personal_data_absent)" means. The run's 50 gate refusals were traced one by one; every class has
a deterministic cause and a code fix. Where each lands:

| Change | Story | Requirements |
|---|---|---|
| Report returns to the original design, keeping links, the alerts section and rounding; header without "rank N", confidence on its own line; evidence notes rounded | US1 | FR-015, FR-022 |
| One footer: specs, configuration, trace, cost, run id (Slack adds the count of items only in the report); `AGENT_WATCHDOG_SPECS_URL` replaces `AGENT_WATCHDOG_PROMPTS_URL` | US1 | FR-019, FR-022, contracts/environment.md, contracts/slack-payload.md |
| Thread replies for high items and alert groups only | US1 | FR-020 |
| The incomplete-analysis notice names hosts and says what was refused in words | US1 | FR-056 |
| The gate: comma rule in the tokeniser, phone check with the given-text exemption and the digits in its reason, roundings of given numerals, percent by magnitude, unit words and `_seconds` metrics, range literals, candidates for the brief's gate | US1 | FR-016 |
| Checked counts of a restricted run cover the analysed projects | US3 | FR-066 |

- **I**: no new dependency. The template is the revision-23 file with links and the alerts card
  added; the tokeniser change is a regular expression.
- **II**: tests first for every delta: the header, footer and window names of the report; the Slack
  footer and the renamed setting; the replies rule; the notice text; each tokeniser and gate rule on
  the refused strings of the run; the checked counts under a filter.
- **III**: more arithmetic and parsing move into code: the gate reads JSON numbers as numbers, unit
  words as units, roundings as roundings, so the model stops copying sixteen-digit decimals to pass.
- **IV**: nothing new stored. The footer key is renamed (`specs_url`); no artefact is added.
- **V**: no new stage.
- **VI**: the brief still flags, and now says what it flags in words a reader can act on.
- **VII**: the template, the payload templates and the checks change by pull request with their tests;
  no prompt changes.
- **VIII**: one audience per output, unchanged. The post and the report share one footer.
  Result: PASS.

Deliberately not planned (research.md R-30): programme-wide metric patterns detected by code (the
run's memory-growth finding on 16 of 30 projects is the evidence for a delta of its own); a minimum
magnitude for the `monotonic` rule; a reply-severity setting; the one-programme layout; the model's
missing `relates_to` between a count and its rate.

### Revision 26 delta: the project first on every body line, written by code (FR-015, FR-069)

Planned on 2026-09-22 from the first full run on revision 25 (research.md R-31): the programme
bullet "North Programme: 6 projects with 8 issues" carried eight sub-bullets that began with metric
expressions and named no project, where the run before had begun each with "North-a:". Nothing in
code decided that; the prompt asks for metric names and a single line, and after the gate refused ten
over-long sub-bullets the model cut the host to fit. One delta, the operator's request for a demo:
code writes the project in front of every body line and the model describes the change in words.
The programme thread reply the operator also asked for is the next revision.

| Change | Story | Requirements |
|---|---|---|
| Sub-bullets and item bullets start with the project written by code; the model writes words, not metric keys; the prompt gives the prefix and the budget; the length check counts the prefix; a host the model wrote anyway is not doubled | US1, US9 | FR-015, FR-069 |

- **I**: no new dependency.
- **II**: tests first: the assembled bullets, the prefixes and the collision rule, the length budget,
  the prompt text and the composed brief.
- **III**: the project name moves from the model's discretion into code.
- **IV**: nothing new stored; the stored bullet text now carries the prefix code wrote.
- **V**: no new stage.
- **VI**, **VIII**: unchanged.
- **VII**: `prompts/rollup.md` changes by pull request with its test.
  Result: PASS.

Deliberately not planned (research.md R-31): the programme thread reply (next revision); unit scaling
in the gate (`827 MB` for 826,957,824 bytes); an alert reply per programme rather than per category.

### Revision 27 delta: the security requirements catch up with the code (FR-002, FR-008, FR-016, FR-024, FR-044, FR-045, FR-046, FR-054, FR-083, FR-084, SC-004)

Planned on 2026-09-22 from a reviewer's pass over the security checklist generated on 2026-09-19
(research.md R-32). Twenty-one of its thirty-four items found the requirement missing, ambiguous or
in conflict, and in every case but one the code already behaved as the reviewer wanted: the gap was
in the spec's words, and the checklist had not been revisited through twenty-four revisions. One
delta, almost entirely spec text, with one code change.

| Change | Story | Requirements |
|---|---|---|
| FR-002 scoped to CHT systems and the metrics store; FR-046 rewritten so the model has no write tool and the seven tools are named; FR-054 counts the hard caps as rails | US1, US3 | FR-002, FR-046, FR-054 |
| Memory is untrusted when read back; delimiter text stripped before wrapping; proposals and the preview need no template escaping | US1, US4 | FR-008, FR-044 |
| Closed lists of checks, patterns and allowed hosts named; link timeouts and redirects specified; personal data defined once; the scan covers every published text whatever its source | US1 | FR-016 |
| Run records and logs named as surfaces of the secret rule | US3 | FR-045 |
| The failure notice is code text outside the gate with its error message redacted (the one code change: `src/publish/redact.js`) | US1 | FR-024 |
| Egress and Slack scopes promoted from plan and dependencies to requirements | US3 | FR-083, FR-084 |
| The replay evaluation and a manual sample named as the gate's independent oracle | US1 | SC-004 |
| User Story 1's duplicated scenario 6 renumbered; ten checklist items appended for the surfaces revisions 24 to 26 added | | |

- **I**: no new dependency. **II**: the redaction has its tests first. **III**, **IV**, **V**: unchanged;
  nothing new is stored or computed. **VI**: unchanged. **VII**: no prompt changes. **VIII**: unchanged.
  Result: PASS.

Deliberately not planned: enforcing egress and the container hardening (the container revision, which
FR-083 now anchors); a startup check of the bot's channel membership (it would need `channels:read`
scopes the app does not hold; the post's own refusal is the loud failure).

### Revision 28 delta: a post a person reads in one glance, a thread of three replies (FR-010, FR-015, FR-019, FR-020, FR-066, FR-069, FR-078, FR-079, FR-080, FR-085)

Planned on 2026-09-22 from the operator's reading of the first full run on revision 25 (research.md R-33):
the post's headline was cut at Slack's 150-character header limit, its body carried alert bullets that
repeat the monitoring stack's own notifications, its sub-bullets named one metric per line so one project
appeared several times, and its thread held one item reply and eleven alert-group replies. Four choices
were put to the operator through `/speckit-clarify` and answered: two programmes in the body, a reply of
its own for every programme with two or more flagged projects, one combined line per project, and a trace
link with quoted lines for feedback provenance. Where each lands:

| Change | Story | Requirements |
|---|---|---|
| Headline in a bold section, never truncated; gate holds it to two lines | US1 | FR-019, FR-015 |
| Body: two programme bullets, three project lines each, a count of the rest; alerts out of the body | US1, US9 | FR-010, FR-069 |
| One line per project covering all its items; the layout names the items a line covers; the gate allows all their values | US9 | FR-069, FR-016 |
| Thread: report share, programme replies, one Other reply, one alerts reply; item and alert-group replies retired | US1, US8 | FR-020, FR-066, FR-078, FR-079, FR-080 |
| Feedback sequencing and provenance specified for revision 29 | US2 | FR-085 |

- **I**: no new dependency. **II**: tests first for the layout, the checks, the payload and the brief.
- **III**: the layout, the prefixes, the counts and the alerts summary are code; the model writes only the
  project lines and the headline. **IV**: nothing new stored; `brief.json` gains `thread`, the layout its
  `entries` and `replies`. **V**: no new stage. **VI**, **VIII**: unchanged. **VII**: `prompts/rollup.md`
  and the templates change by pull request with their tests.
  Result: PASS.

Deliberately not planned: the feedback sequencing and provenance (revision 29, FR-085); the report's
summary keeps the body bullets only.

### Revision 29 delta: feedback read as one conversation, and a digest that shows where it acted (FR-029, FR-061, FR-062, FR-085)

Planned on 2026-09-23 from the operator's request recorded in research.md R-33 and the clarification
answered with revision 28 ("trace link plus quoted lines"): when several people write about one item in
sequence, the later note clarifies or corrects the earlier one, and the people who wrote should see the
next day how their words were used. Where each lands:

| Change | Story | Requirements |
|---|---|---|
| The horizon applied to an item is the last one its thread states; one horizon per item, never a superseded one; a note without a date reaches the model with its thread's earlier notes as context | US2 | FR-029, FR-085 |
| The unreviewed notes of one item are reviewed together in thread order, one call, one classification, at most one proposal whose evidence names every note | US7 | FR-061, FR-085 |
| The digest says per item how the feedback was used: the exact lines quoted from the project's `prompt.pass1.md` with the run's trace link, or the suppression it caused, or that it was not used | US7 | FR-062, FR-085 |
| The session record keeps the tracer's observation id per call, so the trace link can point at the pass-1 generation | US7 | FR-049, FR-085 |

- **I**: no new dependency. **II**: tests first for the sequence rule, the ingester, the parser, the review,
  the provenance reader, the digest, the publish stage, the session record and User Story 7 end to end.
- **III**: the clarified whole is code (last stated wins); the model only reads a dateless note with its
  context and classifies the thread. **IV**: nothing new stored; `feedback.digest.json` items gain
  `provenance`, `session.json` calls gain `observation_id`. **V**: no new stage. **VI**: the review still
  writes proposals for a person; nothing is applied. **VII**: `prompts/feedback-parse.md`,
  `prompts/feedback-review.md` and `templates/slack/feedback-digest.hbs` change by pull request with their
  tests. **VIII**: the digest stays one audience, the thread's authors.
  Result: PASS.

Deliberately not planned: retracting a proposal when a later thread corrects the note that produced it (the
proposal file is a person's to close); a horizon cancelled by a dateless "resolved" note (the parser returns
null, the earlier horizon stands until its date); serving run files over the web (the trace link and the
quoted lines are the operator's chosen answer).

### Revision 30 delta: the container locked down, and egress the package can name and refuse (FR-083, FR-086)

Planned on 2026-09-23 from the operator's roadmap and the security checklist's CHK031, CHK041 and CHK042
(research.md R-32, R-35): the container contract described the hardening as expectations of the platform,
the browser retired in revision 24 was still in the image, and nothing in the package could name or refuse
the destinations a run contacts. Where each lands:

| Change | Story | Requirements |
|---|---|---|
| Container hardening stated as requirements: fixed non-root user, read-only root, `/data` and `/tmp` the only writable paths, no browser, lockfile-only install without lifecycle scripts, no port; dropped capabilities, no privilege escalation, default seccomp, no service-account token, limits, no concurrency, deadline | US3 | FR-086 |
| The image rebuilt without Playwright and Chromium, `playwright-core` and `AGENT_WATCHDOG_CHROMIUM_PATH` removed, OCI version and revision labels from build arguments | US3 | FR-086 |
| `src/net/egress.js`: the allow-list from the fixed destinations and the configured endpoints, an in-process guard on every `fetch` of the run, a refusal that fails closed with exit 69 naming host and port | US3 | FR-083 |
| `agent-watchdog egress [--format json\|hosts]`: the list for the platform's policy, from the effective configuration, without secrets | US3 | FR-083 |
| Reference manifests under `deploy/` (CronJob with its security context, mounts, limits and deadline; a default-deny egress policy with DNS; a Cilium FQDN policy) checked by tests against FR-086 and the egress list | US3 | FR-086 |
| `smoke/container.js` runs the built image under the platform's constraints in CI (SC-017) | US3 | FR-086 |

- **I**: no new dependency; one removed. **II**: tests first for the egress module, the command, the run's
  guard, the image definition and the manifests. **III**: the allow-list is code plus configuration, never a
  model output. **IV**: nothing new stored. **V**: no new stage; one new read-only command. **VI**: a refused
  request fails the run, nothing is retried around the policy. **VII**: unchanged. **VIII**: unchanged.
  Result: PASS.

Deliberately not planned: wrapping the Slack SDK's transport or the agent runtime's subprocess (the platform
policy covers them; the guard is the package's own belt); a per-request proxy inside the image; a
distroless base (the runtime binary needs glibc and the image needs no shell change for a CronJob today);
signing the image (a release concern in `medic-infrastructure`).

### Revision 31 delta: the same container on a contributor's machine (FR-086)

Planned on 2026-09-23 from the operator's request after revision 30: a local Compose setup that runs the image
the way the CronJob does. `compose.yaml` at the package root builds the image with the version and revision
arguments and runs it as user `10001:10001`, root read-only, every capability dropped, `no-new-privileges`, a
`/tmp` tmpfs, a PID limit, `init`, the CPU and memory limits of the contract, secrets and endpoints from the
operator's `.env`, the container paths pinned, the data volume named like the claim (a bind mount by choice),
the policy files from `config/local` read-only; it previews by default and has an `offline` profile with no
network for the stages that need none (revision 32 corrected the profile's example: `replay` still calls the model). `test/container/compose.spec.js` pins every setting and that no secret or
real host is in the file (FR-086, US3 scenario 5). Compose's `env_file` reader keeps text after `#` on a value
line as part of the value where Node's `--env-file` drops it, so `.env.example` now keeps every comment on its
own line and `test/config/env-example.spec.js` holds the format (research.md R-36). **I** no dependency, **II** tests first, **III** to **VIII**
unchanged. Result: PASS. Not planned: a local stand-in for the cluster's network policy (Docker filters no
destination by name; the package's own guard applies), and a local Grafana or Slack.

### Revision 32 delta: a contributor's own Claude login in the local container (FR-050, FR-086)

Planned on 2026-09-23 from the operator's request: run the container locally on a Claude subscription (Team
plan) rather than an API key, logging in once inside the container with the login kept in a volume, the way
`cht-agent`'s seeder does (research.md R-37). The Agent SDK already ships the Claude Code runtime as a native
binary, so the image symlinks it onto PATH as `claude` and installs nothing; `compose.yaml` gains a named
volume `agent-watchdog-login` at the runtime user's home, mounted by every service with `CLAUDE_CONFIG_DIR`
inside it, and a `login` profile that runs `claude auth login` interactively (also `auth status`, `auth
logout`). A run with `AGENT_WATCHDOG_ENGINE=cli` and no key is the CLI engine's existing login mode. The
`offline` profile's example is corrected: `replay` calls the model, so the profile is for `purge`, `analyze`,
`render` and a preview `publish`. **I** no dependency, **II** tests first (compose, image, smoke), **III** to
**VIII** unchanged; the scheduled deployment keeps the API key and never carries a login. Result: PASS. Not
planned: a `CLAUDE_CODE_OAUTH_TOKEN` path for the SDK engine (the CLI engine already has login mode, and a
subscription token is a person's, not a service's); mounting the host's `~/.claude` (it would expose the
contributor's whole configuration and sessions to the container).

### Revision 33 delta: the gate holds the whole surface (FR-016, FR-029, FR-044, FR-073, FR-083)

Planned on 2026-09-24 from the branch review (research.md R-38, findings #42, #2, #23, #55, #35, #46, #7,
#34, #3), the first of three revisions in the reviewer's order. The gate checked the bullets and trusted the
rest: an item's evidence seeded the numbers its prose could quote, the headline and the expected-load notice
went to Slack with no number, link or host check, and the notice itself was blank on every window day because
the run handed the roll-up window ids where it read window objects. Dates the model wrote were checked nowhere.
And two trust boundaries leaked: the resolver fetched model-written URLs before the allow-list and tool-result
checks ran, and a Slack mention inside a note reached the model and the memory file verbatim. This revision:
`numbers_match` checks every evidence value against the computed values of its metric and the collected values
of its named window, and no longer seeds prose from evidence; the headline and the notice are checked for
numbers (against every item's values), URLs, length and hosts; the notice is built at roll-up time from the
window objects of the run directory (so a stage-only roll-up has it too); `dates_match` checks the dates the
model writes (ISO and day-month forms) against the run's windows, exempting dates it was given; `resolveAll`
resolves only code-built links and model links that are allow-listed and appeared in a tool result, and an
egress refusal propagates (exit 69) instead of reading as a broken link; Slack ids are masked in every note
before it reaches a prompt (analysis feedback block, parse, review) and `personal_data_absent` refuses them on
the published surface; the memory update is masked of people, e-mail addresses and phone numbers before it is
stored, and the check's comment says what code does; the egress guard follows a redirect only to a listed
destination and is installed in tools-server, calibrate, distill and replay; a failed query of any status counts
toward consecutive failures and only a success resets them. **I** no dependency; **II** tests first for every
change; **III** the notice and the checks are code; **IV** nothing new stored; **V** unchanged; **VI** the gate
refuses, the masking flags; **VII** prompts unchanged; **VIII** unchanged. Result: PASS. Not planned here:
revisions 34 (the brief says what happened) and 35 (pre-PR hygiene), listed in R-38 with each finding's
disposition; the commit-history repair, which is the operator's call.

### Revision 34 delta: the brief says what happened (FR-009, FR-012, FR-016, FR-018, FR-029, FR-030, FR-043, FR-049, FR-058, FR-073)

Planned on 2026-09-24 from the branch review (research.md R-38, findings #1, #6, #9, #22, #58, #20, #15, #27,
#49, #10, #11, #18, #13, #19, #25, #0, #5, #16, #14, #4, #8, #56, #37, #12, #28, #32, #50), the second of three
revisions in the reviewer's order: every place where the brief, the digest, the report or a record could read
quieter, cheaper or more certain than the run was. Analysis: a session the run deadline cut off is a shortfall
the brief names (the `timeout` bound joins `budget` and `turns`); the heartbeat headline says how many candidates
were assessed and none flagged instead of "no candidates"; the degraded notice counts the drafts it refused; the
roll-up, calibration and replay read the last pass the gate accepted, never a rejected later one; a session that
cannot open is that project's `error` bound, not the stage's failure; the prompt's run date is the run's date; a
session the harness killed or a turn that timed out is charged its remaining grant with `cost_estimated` on the
record, so the run budget never re-grants money already spent; the run's cost includes the feedback stage's calls
and a stage-only roll-up reads the agent's spend; two items with one identity are refused. Feedback: a note's
`expected_max`, `observed_value` and `horizon_source` are stored on the record, so a horizon holds its size from the
second day and a failed model parse is logged and retried; a horizon resolves against the note's own date; a note
whose review failed stays unacknowledged and is reviewed again, up to three attempts, then acknowledged as
unclassified; a reaction re-added after a recorded retraction is recorded again; outcomes are appended only for
items whose feedback changed this run. Collection and tools: the standing test reads yesterday from the Computed
Change; the live `query_metric` refuses several series, carries the panel's unit and knows the active window;
`get_windows` resolves a loose key to the collected one; the stdio tools server serves the merged pattern cards;
one host's failed discovery query leaves that project without a version and history, not the run without a brief;
the worker pool stops starting projects after a failure; tool-result URLs are read from each text, never from a
JSON encoding. Publish and render: the alerts reply is fitted line by line and never cut inside a link; the report
nests a relation chain at any depth; the publication record is written as soon as the parent is posted and a
stage-only publish refuses to post a second parent; calibration reads one run per date; a stage-only roll-up
resolves links. **I** no dependency; **II** tests first; **III** the wording and the fitting are code; **IV** three
fields on the Feedback record (`expected_max`, `observed_value`, `horizon_source`, `review_attempts`), each stated in
data-model.md; **V** unchanged; **VI** the gate refuses, code flags; **VII** the heartbeat and degraded wording are
templates changed here by PR; **VIII** unchanged. Result: PASS. Deferred to revision 35: the hygiene items of R-38.

### Revision 35 delta: the hygiene before the pull request (FR-039, FR-040, FR-043, FR-048, FR-049, FR-083, FR-086)

Planned on 2026-09-24 from the branch review (research.md R-38, findings #38, #40, #21, #52, #41, #53, #61, #17,
#26, #29, #30, #31, #33, #51), the last of three revisions in the reviewer's order: what a reviewer of the pull
request would trip over. The image symlinks the runtime package of its own architecture, so an arm64 build works,
and bakes its version and revision into the environment, so a run record from the image names them instead of
`0.0.0-development` and a null sha; the CLI engine creates its runtime directory with the synchronous call it
meant to use; `AGENTS.md` describes the two-slot body and the one alerts reply; the deploy notes say the reference
Cilium policy pins 443 and where the ports are; the entity schema's caps match the layout (two slots, four
children) and the model-facing descriptions no longer speak of one-line sub-bullets; misplaced and stale comments
are set right; the dead module and the exports used by nothing or by tests alone are removed, and FR-049 is
reworded to what the run records; retention purges replay directories like runs; a bad `--stage`,
`--date` or `--since` is refused before a run directory exists; each command refuses the flags that are not its
own, so `replay --stage` exits 64 as the contract says; `--log-level` and `--log-format` apply; the trace flush of
replay, distill and calibrate is logged and never changes the exit code, and each prints its result first; `check`
refuses an `http://` target in words rather than probing `https://` silently; the commit header pattern accepts
the `!` breaking-change marker. **I** no dependency; **II** tests first; **III** to **VI** unchanged; **VII** the
brief schema's descriptions are model-facing text, rebuilt into `schema/brief.schema.json` with the replay diff
attached to the pull request; **VIII** unchanged. Result: PASS. Not done here: rewriting the eighteen commit
messages that fail commitlint (#48), which rewrites local history and is the operator's decision (R-40).

### Revision 36 delta: the re-review, and the four rules revision 33 tightened too far (FR-003, FR-012, FR-016, FR-029, FR-042, FR-043, FR-073, FR-083)

Planned on 2026-09-25 from the second review of the branch (research.md R-41), which re-checked every finding of
the first and found 38 fixed, 8 partly fixed and 4 whose fix caused a new problem, plus 52 new findings, one of
them scored 80. The four regressions share one cause: revision 33 applied a stricter rule than the finding asked
for, and its tests encoded the stricter rule instead of the day the spec protects. This revision (1) masks a note
on every remaining path to a prompt: the roll-up's feedback text and unmatched notes, the item-history tool, the
outcome files distill reads, with e-mail addresses and phone numbers masked beside Slack ids, and cuts the memory
masking back to the same identifiers so byte counts, decimals, dates and owner names survive; (2) undoes the
over-strict rules: a 4xx or 500 query neither counts toward "unreachable" nor resets the count, and a collection
in which most windows failed their query is a notice on the brief, never a refused heartbeat; a yearless date is
exempt when any reading of it was given and is otherwise read nearest the run; timestamps count as dates; the
system prompt, the roll-up's feedback and the memory are given text for dates; the brief's span carries the
previous cycle on window days; day-month phrases are not numerals; the run's own notice is wrapped to the line
budget; the resolver records a destination outside the egress list as not requested instead of failing the run;
the live query tool keeps collection's single-series fallback; (3) strips Authorization, Proxy-Authorization and
Cookie when a redirect changes origin and refuses a downgrade to http; (4) the partial fixes and the small items
of R-41 in the reviewer's order: the heartbeat's early publication record written before its permalink, the
exit-75 guard before any write, retraction ids per verdict, the date validation without a RangeError and an empty
`--stage` refused, `--engine` for distill and calibrate, the release analyzer reading `!`, safe card loading in the
tools server, "up to" for an estimated spend, the alerts reply that drops a programme's oversized link before its
notices, replay and the egress document naming the image, a digest that carries a note awaiting its review, one
helper for a run's recorded spend, the notice's schema description, verified evidence quotable in prose and
checked per window, tool errors that echo no argument, the layout caps derived in one place, the two missing
tests, the stale documents and the dead code. **I** no dependency; **II** tests first, and for every rule loosened
here a second test that proves the normal day still works; **III** to **VI** unchanged; **VII** the brief schema's
notice description is rebuilt with the replay diff; **VIII** unchanged. Result: PASS. The commit convention keeps
the plain `type: subject` form for this founding branch, which references no issue; new work references its
issue (constitution I), and the eighteen earlier commit messages are rewrapped to the lint's limits in a
message-only rewrite of the unpushed history (R-41).

### Revision 37 delta: the third review, and what the second's fixes missed in production (FR-016, FR-029, FR-042, FR-062, FR-073, FR-075, FR-083)

Planned on 2026-09-25 from the third review of the branch (research.md R-42): 43 of 66 open findings fixed,
30 new ones, the top five caused by revision 36. Two of them were tested through spies and never reached
production: the analysis gate adapter dropped the texts given for dates and built its resolver without the
egress list. This revision (1) repairs the release pipeline, which revision 36 broke by putting the
conventionalcommits preset on plugins whose changelog writer cannot render it: both keep their default preset
and read the CHT headers through parser options, proven by a test that runs the installed analyzer and
notes generator; (2) forwards the date-only texts and the egress list through the analysis gate adapter,
tested through the adapter with the real verification module; (3) measures the collection notice over the
queries sent, so a warm volume whose every query failed is never a quiet heartbeat, and marks the notice;
(4) closes the "N may" hole with one date matcher shared by the date and number checks, and matches evidence
within unit families so a relabelled sigma licenses no multiple; the day's restart count is a level of the
current window again; (5) refuses several series of which none carries the project's instance label instead
of taking the first; (6) widens the phone rule to any run starting with a plus or a zero and narrows it away
from ranges, bracketed pairs and dotted dates, masks the digest's unmatched notes like a prompt's, and names
the refusing checks in words on a degraded brief; (7) the smaller items: the longest active cycle in the
brief's span, a preview beside a posted record, the supersedes link on a forced heartbeat with the permalink
looked up from the ts, a message of its own for query_metric, the check's line limit under its own name, the
alerts reply that gives up its notices last, one trace flush on the failure path; (8) the documents: the
quickstart cut to what an operator runs, the stale file references and the channel name removed, the
contradictions the review listed set right, and the commit-convention deviation recorded above with its
expiry. **I** no dependency; **II** tests first, every production-path fix tested through the adapter or the
command it runs in; **III** to **VI** unchanged; **VII** no model-facing text changed; **VIII** unchanged.
Result: PASS.

### Revision 38 delta: the stories read as the brief is, and the build passes its audit

Made on 2026-09-26 before the pull request. The eleven user stories keep every number, title, priority and
scenario count, which tasks, tests, contracts and the security checklist cite; their prose no longer describes
the five-bullet brief of before revision 28, and the history asides and the one run figure inside them are
gone, since the plan deltas and research.md hold that history. A note under the section heading says why the
numbering is stable. mocha moved from 11 to 12 (Node 22.12 or later, which `.nvmrc` pins) because the CI
audit job fails on a high advisory in mocha 11's serialize-javascript (GHSA-5c6j-r48x-rmvq); every preview
payload written beside the package (`payload*.json`) is ignored; and README and AGENTS.md say how a
contributor installs Spec Kit's Claude skills, points it at the feature directory and runs the workflow.
**I** to **VIII** unchanged. Result: PASS.

### Revision 39 delta: the artefacts say what the code does (`/speckit-analyze`)

Made on 2026-09-26 from the analysis run over the artefacts: no critical finding, four high ones, all stale
statements of the layout from before revision 28. SC-015, the Brief and Thread Reply entities, one edge case
and this plan's summary, scale line and tree comment now state the two-programme-bullet brief; the plan's
Constitution Check names the tracked commit-header deviation instead of claiming enforcement; "sub-bullet" is
"project line" in FR-010, FR-015, FR-069, the data model and the run-directory contract, as the code and
AGENTS.md say; Computed Change, Pass, Bullet and Alert Pattern join the Key Entities, which the data model
already defined; the open validation task T111 names the quickstart sections that exist. Every story,
scenario and requirement number is unchanged. **I** to **VIII** unchanged. Result: PASS.

### Revision 40 delta: one statement of the layout, and the restricted run in a requirement of its own (FR-010, FR-015, FR-020, FR-066, FR-069, FR-087)

Made on 2026-09-26 from the two remaining medium findings of the analysis run (research.md R-43). FR-010 is now
the one statement of the body's shape: two programme bullets, a group line with three project lines and the
count of the rest, two lines of 120 per line, alerts in no bullet, the thread in the same form. FR-015 keeps
the audience and style, FR-020 the thread order, FR-069 the project line's content and code-written prefix,
each referring to FR-010 for the shape. The run-restriction rules that FR-066 had gathered in revisions 19, 24
and 25 (`--project`, `--group`, one helper, the brief covers what it analysed, what was checked counts the
analysed projects) are FR-087, appended at the end of the requirements; the code, tests and the CLI contract
that cited FR-066 for them cite FR-087, and two stale alert comments in the roll-up stage and the brief say
what the code does since revision 28. No number was reused or renumbered. **I** to **VIII** unchanged.
Result: PASS.

### Revision 41 delta: the model in use, and a full pass in Docker first

Made on 2026-09-26. The design notes in spec.md and this plan name the model the deployment sets,
`claude-sonnet-5` at high effort, read from the environment as before, and the shipped default in
`src/config/schema.js`, `.env.example` and contracts/environment.md follows it in a second commit, with the
configuration test asserting the new default. The quickstart opens with a full pass in Docker: the Slack bot token from the
team's vault or a new Slack app, the channel id from the channel's details or a direct message with the bot,
the files, the build, the preview and the real post; the checkout prerequisites and the numbered sections
follow unchanged. **I** to **VIII** unchanged. Result: PASS.

### Revision 42 delta: one tag for x64 and arm64 (FR-086)

Planned on 2026-09-27 (research.md R-44). Revision 35 made the image build on either architecture; the release
still built and pushed the x64 runner's image alone, so an arm64 server or an Apple silicon machine pulling the
tag ran it under emulation or not at all. The release now runs one `docker buildx build` for `linux/amd64` and
`linux/arm64`, the second under QEMU on the runner, and pushes a multi-platform manifest under the same tag; the
pull-request workflow builds both platforms too and runs the smoke on the loaded amd64 image, since a
multi-platform build cannot be loaded into the daemon. The Dockerfile is unchanged: the runtime binary already
follows `process.arch`. **I** no dependency (two GitHub actions in the workflows); **II** the test covers the
release command and both workflows, written first; **III** to **VIII** unchanged. Result: PASS.

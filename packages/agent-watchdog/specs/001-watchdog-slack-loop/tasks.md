# Tasks: Watchdog Slack Loop

**Input**: Design documents from `/specs/001-watchdog-slack-loop/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED. Constitution principle II mandates red, green, refactor: every module's test
task precedes its implementation task and must fail before the implementation is written. No test
may reach the network; external systems are stubbed with sinon and recorded fixtures under
`test/fixtures/`. Model-touching behaviour is covered by `smoke/` scripts that need credentials
(research.md, "Smoke tests" S-1 to S-12) and by replay evaluation over fixtures.

**Organization**: Tasks are grouped by user story so each story is an independently testable
increment. Paths are relative to `packages/agent-watchdog/` unless they start with `.github/`,
which is the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1 to US6)
- Every task names the exact file or directory it creates or changes

## Path Conventions

Single package: `bin/`, `src/<stage>/`, `test/<stage>/` mirroring `src/`, `agent/`, `prompts/`,
`skill/cht-watchdog/`, `schema/`, `templates/`, `config/defaults/`, `smoke/`, `scripts/`, as laid
out in plan.md "Source Code". Contracts referenced below live in `specs/001-watchdog-slack-loop/contracts/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Package skeleton, tooling and policy defaults, all per plan.md and research.md R-1, R-9, R-12.

- [X] T001 Create the package skeleton: `package.json` (`"type": "commonjs"`, `"private": true`, `engines.node ">=22.15.0"`, `bin.agent-watchdog` → `bin/agent-watchdog.js`, `license AGPL-3.0`), `.nvmrc` containing `22`, `LICENSE` (AGPL-3.0), and empty directories `bin/`, `src/{cli,cli/commands,cli/stages,config,log,store,model,collect,analyze,feedback,agent,agent/tools,verify,verify/checks,rollup,links,render,publish,corpus,calibration,trace,readiness}/`, `test/` mirroring `src/`, `test/fixtures/`, `agent/`, `prompts/`, `skill/cht-watchdog/{references,pattern-cards}/`, `schema/`, `templates/slack/`, `config/defaults/`, `smoke/`, `scripts/`
- [X] T002 Add runtime dependencies to `package.json` with a one-line justification comment per dependency in `README.md` "Dependencies": `@anthropic-ai/claude-agent-sdk` ^0.3, `@slack/web-api` ^8, `zod` ^4, `handlebars` ^4.7, `playwright-core` ^1.63, `yaml` ^2, `@modelcontextprotocol/sdk` ^1.29, `@langfuse/tracing` ^5, `@langfuse/otel` ^5, `@langfuse/client` ^5, `@opentelemetry/sdk-node` (research.md R-1, R-8)
- [X] T003 [P] Add dev dependencies and tooling matching cht-core (research.md R-9): `eslint` ^9, `@eslint/eslintrc`, `@medic/eslint-config` ^1.2 wired through `FlatCompat` in `eslint.config.js`; `mocha` ^11 with `.mocharc.yml` (`spec: test/**/*.spec.js`, `require: test/setup.js`); `chai` ^4.5, `chai-as-promised` ^7.1, `sinon` ^21, `sinon-chai` ^3.7; `nyc` ^17 with `.nycrc` (`check-coverage: true`, reporters text and lcov); npm scripts `lint`, `test`, `test:coverage`, `replay:eval`, `schema:build`, `smoke:*`
- [X] T004 [P] Add `commitlint.config.js` extending `@commitlint/config-conventional` with a header parser that accepts both `type(#issue): subject` and `type: subject` and restricts `type` to `build feat fix perf refactor test chore docs` (constitution I)
- [X] T005 [P] Add `release.config.js` for semantic-release: `tagFormat: 'agent-watchdog-v${version}'`, plugins commit-analyzer, release-notes-generator, changelog, git, github, `@semantic-release/exec` building and pushing the image tagged with the released version, and `semantic-release-monorepo` for path scoping (research.md R-12)
- [X] T006 [P] Write `Dockerfile` and `.dockerignore` per `contracts/container.md`: base `node:22-bookworm-slim`, `npm ci --omit=dev`, `npx playwright-core install --with-deps chromium-headless-shell` into `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, user `10001:10001`, baked `ENV` (`NODE_ENV`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`, `TMPDIR=/tmp`), OCI labels, entrypoint `node bin/agent-watchdog.js`
- [X] T007 [P] Add CI workflow `.github/workflows/agent-watchdog.yml` filtered on `packages/agent-watchdog/**`: jobs `lint` (zero warnings), `test` (nyc, coverage compared with `main`), `audit` (`npm audit --audit-level=high`), `commitlint` on the PR range, `replay-eval` when `prompts/`, `skill/`, `schema/` or `src/analyze/` change, `docker-build`; plus `.github/dependabot.yml` entry for `/packages/agent-watchdog` (constitution Security Requirements, Quality Gates)
- [X] T008 [P] Write policy defaults per `contracts/config-files.md`: `config/defaults/thresholds.yaml` (pct_change_vs_previous_day 50, deviation_sigma_vs_trailing 2.5, monotonic_rise_hours 6, trailing_days 14, high rules for `up{job="cht"}` down, `cht_outbound_push_backlog_count` > 0, `cht_sentinel_backlog_count` > 3 × baseline), `config/defaults/dashboards.yaml` (uids `oa2OfL-Vk`, `hkQUbyfVk`, `3J_78b6Zz`, `d4f05050-804e-4ea4-9642-4d088cc39a1b`), `config/defaults/projects.yaml` (`defaults.expected_load_windows` month-end example)
- [X] T009 [P] Write initial `README.md` (purpose, quickstart pointer, contracts index, dependency justifications) and `AGENTS.md` (operational quick reference that mirrors `.specify/memory/constitution.md` and names the stage modules, commands and exit codes)
- [X] T010 [P] Create `test/setup.js` (chai plugins, sinon sandbox restore, a global `fetch` guard that throws unless a test opts in) and `test/helpers/fixtures.js` (load JSON fixtures, create a temporary data directory, fake clock)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Configuration, logging, storage, identity, CLI dispatch, tracing and output schemas that every story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T011 Write failing tests `test/config/load.spec.js` and `test/config/policy.spec.js`: precedence flag, then environment, then file default; every variable in `contracts/environment.md` with its type and default; hard caps in code (budget project 10.00, run 100.00, turns 50, passes 4, concurrency 8, model timeout 1800000, HTTP timeout 60000); invalid or missing value exits 78 naming the key with the value redacted; policy files parsed with `yaml`, hosts normalised (lowercase, strip scheme, `www.`, trailing slash), only the three FR-014 high rules accepted under `high_when`
- [X] T012 Implement `src/config/schema.js` (zod), `src/config/load.js` (environment, flags, defaults, redacted effective configuration object) and `src/config/policy.js` (`projects.yaml`, `dashboards.yaml`, `thresholds.yaml` with `config/defaults/` fallback and SHA-256 `config_hash`)
- [X] T013 [P] Write failing tests `test/log/logger.spec.js`: JSON lines on stderr with `service: "agent-watchdog"`, `run_id`, `stage`, `event`, `ts`, `mono_ns`; secret values redacted by key; `pretty` format; level filtering
- [X] T014 [P] Implement `src/log/logger.js` on `process.stderr` with `time.monotonic`-equivalent `process.hrtime.bigint()` for `mono_ns`
- [X] T015 [P] Write failing tests `test/store/run-dir.spec.js` and `test/store/retention.spec.js`: layout from `contracts/run-directory.md`; atomic writes (`<name>.tmp` then rename); gzip for `inputs/windows.json.gz`; `run.json` updated at every stage boundary; retention classes raw (14 days), kept (30 days), durable (never); `feedback.jsonl` compacted only after outcomes exist under `corpus/outcomes/`
- [X] T016 [P] Implement `src/store/run-dir.js`, `src/store/atomic.js`, `src/store/retention.js`
- [X] T017 [P] Write failing tests `test/model/identity.spec.js` and `test/model/schemas.spec.js`: `item_id` is the first 12 hex characters of SHA-256 over `project_url`, `metric` and `pattern_card` or the literal `none` joined by newlines; `run_id` is `YYYY-MM-DD` or `YYYY-MM-DD-f<n>`; `candidate_id` hashes project, metric, rule, date; `feedback_id` hashes `source_ts`, `author`, `kind`, `verdict`; every enumeration in data-model.md rejects unknown values
- [X] T018 [P] Implement `src/model/identity.js` and `src/model/schemas.js` (zod schemas for Project, Run, Metric Window, Computed Change, Candidate, Item, Pass, Verification Report, Brief, Thread Reply, Feedback, Memory, Proposal, Corpus Item, Pattern Card, Calibration Report, Expected-Load Window, Priority List, Cost Record)
- [X] T019 Write failing tests `test/cli/parse.spec.js` and `test/cli/exit-codes.spec.js`: commands and flags from `contracts/cli.md`; unknown flag exits 64; logs on stderr and results on stdout; exit-code constants 0, 1, 64, 65, 69, 74, 75, 78 with a `run.exit` log line
- [X] T020 Implement `bin/agent-watchdog.js`, `src/cli/index.js` (`node:util` `parseArgs` strict, command dispatch, global flags `--config-dir`, `--data-dir`, `--log-level`, `--log-format`), `src/cli/exit-codes.js`, `src/cli/streams.js`
- [X] T021 [P] Write failing tests `test/trace/langfuse.spec.js` and `test/trace/cost.spec.js` (stubbed SDK): one root observation per run with `sessionId = run_id`, one span per stage, one `generation` per model call with `usageDetails` (input, output, cache read, cache creation) and `costDetails`; `forceFlush` then `shutdown` on exit; Cost Records summed and reconciled against the runtime's `total_cost_usd`
- [X] T022 [P] Implement `src/trace/langfuse.js` (`NodeSDK` with `LangfuseSpanProcessor({ exportMode: 'immediate' })`, `propagateAttributes`, `getTraceUrl`) and `src/trace/cost.js` (research.md R-8)
- [X] T023 [P] Write failing test `test/agent/output-schema.spec.js` asserting `schema/findings.schema.json` and `schema/brief.schema.json` equal `z.toJSONSchema()` of the zod definitions and that fixtures under `test/fixtures/findings/` validate; implement `src/agent/output-schema.js` and `scripts/build-schema.js` (`npm run schema:build`) starting from `contracts/findings.schema.json` and `contracts/brief.schema.json`
- [X] T024 [P] Create the synthetic, scrubbed fixture set: `test/fixtures/runs/quiet-day/` and `test/fixtures/runs/seeded-anomaly/` (Prometheus proxy JSON per metric using the R-6 metric names, `up` targets, dashboard JSON with the real uids and panel ids, annotations), `test/fixtures/slack/` (replies, reactions, history payloads), `test/fixtures/corpus/` (one conversation, one data export), `test/fixtures/findings/`, `test/fixtures/feedback-labels.json`, and `test/fixtures/README.md` describing how `scripts/record-fixtures.js` refreshes them from a real watchdog with hosts scrubbed

**Checkpoint**: Foundation ready. `npm test` passes, `npm run lint` is clean, and `agent-watchdog --version` prints the package version.

---

## Phase 3: User Story 1 - Daily brief for the on-call engineer (Priority: P1) 🎯 MVP

**Goal**: One scheduled run collects metrics from the hosted watchdog, computes candidates deterministically, runs bounded two-pass analysis with the SDK engine, verifies every draft in code, renders the report and image, and posts the brief, heartbeat or degraded brief to `#agents` with one threaded reply per item.

**Independent Test**: `npm run replay:eval` on the seeded-anomaly and quiet-day fixtures, then `agent-watchdog run --dry-run --date <yesterday>` against a real watchdog (quickstart steps 2 and 3).

### Tests for User Story 1

- [X] T025 [P] [US1] Write failing tests `test/collect/grafana.spec.js`: bearer header and `AGENT_WATCHDOG_HTTP_TIMEOUT_MS`; proxy paths `/api/datasources/proxy/uid/<uid>/api/v1/{query_range,query,series,targets}`; `GET /api/search?type=dash-db&limit=5000`; `GET /api/dashboards/uid/:uid`; `GET /api/annotations`; Prometheus envelope parsing with quoted sample values; timeouts and connection errors classified as unavailable (exit 69); datasource uid cross-check against `targets[].datasource.uid` exits 78 (research.md R-5)
- [X] T026 [P] [US1] Write failing tests `test/collect/discovery.spec.js`: projects from `instance` labels of `up{job="cht"}`; `configured` flag from `projects.yaml`; `cht_version` labels `app`, `node`, `couchdb`; `history_days`; panel expressions extracted from dashboards including panels nested in `row` panels; per-dashboard map of duplicate panel ids
- [X] T027 [P] [US1] Write failing tests `test/collect/windows.spec.js`: `current` is the 24 hours ending at run start; `previous_day`, `previous_week`, `previous_cycle` (only when a window is active); `trailing_14d` as daily `max_over_time(<expr>[1d])` at step 86400; 24-hour windows at step 300; `instance=~"$cht_instance"` rewritten to `instance="<host>"`; `available: false` with `unavailable_reason` below 14 daily points
- [X] T028 [P] [US1] Write failing tests `test/analyze/changes.spec.js`, `test/analyze/calendar.spec.js`, `test/analyze/candidates.spec.js`: `pct_change_vs_previous_day = (current - previous_day) / abs(previous_day) * 100` and null when previous is 0 or unavailable; `deviation_sigma` null when stddev is 0; `monotonic_rise_hours` as the longest non-decreasing run ending at the last sample; `baseline` becomes `previous_cycle` inside an active window with the window's timezone; rules `pct_change` at 50, `deviation` at 2.5, `monotonic` at 6, `target_down`, `backlog_absolute`; threshold source `default`, `global` or `project`; `severity_floor: high` only for scrape target down, outbound push backlog above zero, sentinel backlog above three times its baseline
- [X] T029 [P] [US1] Write failing tests `test/agent/prompt-assembly.spec.js` and `test/agent/definition.spec.js`: static prefix is `prompts/system.md`, then `skill/cht-watchdog/SKILL.md`, then `skill/cht-watchdog/pattern-cards/index.md`, then the runtime's dynamic-boundary marker, then date, memory and active windows; materialised to `runs/<id>/agent/system-prompt.md`; `agent/mcp.template.json` rendered with environment values and the bearer header omitted when the token is unset; `agent/tools.json` lists only the allow-listed names
- [X] T030 [P] [US1] Write failing tests `test/agent/tools/watchdog-tools.spec.js`: `get_windows`, `query_metric` (templated `metric{instance="<host>"}` only, discovered metric names only, five named windows, 20 calls per session), `read_pattern_card` (index ids only), `get_item_history` (authors replaced by role labels); replay mode answers from `tool-calls.jsonl` by tool name and argument hash and returns `{ unavailable: true, reason: 'not recorded' }` otherwise
- [X] T031 [P] [US1] Write failing tests `test/agent/session-loop.spec.js` with a fake engine: pass 1, gate, revision turn on rejection at most `AGENT_WATCHDOG_VERIFY_MAX_RETRIES` times, pass 2 review with `changes[]` reasons, convergence when identities, severities and evidence match within display rounding, early stop, bounds for turns, budget and timeout recorded in `bounds_hit`; files `findings.pass<n>.json`, `verification.pass<n>.json`, `passes.json`, `session.json`, `tool-calls.jsonl`
- [X] T032 [P] [US1] Write failing tests `test/verify/gate.spec.js` and one file per check under `test/verify/checks/`: `schema`, `projects_known`, `metrics_known`, `candidates_known`, `numbers_match` (integers with thousands separators, three significant figures otherwise, percentages with one decimal and `%`, durations `Nh` or `Nd`; numerals inside backtick code spans exempt, and each code span must equal a collected panel expression or metric name verbatim), `dates_match`, `links_built`, `links_allowlisted`, `links_resolve`, `severity_rules` (high needs a referenced candidate with `severity_floor: high`), `bullet_count` at most 3, `bullet_length` at most 2 lines of at most 120 characters, `secrets_absent` (`xox[abp]-`, `sk-ant-`, `glsa_`, bearer strings), `personal_data_absent` (e-mail, phone), `pattern_cards_known`; attempts 1 to 3; report shape from data-model.md
- [X] T033 [P] [US1] Write failing tests `test/links/build.spec.js`, `test/links/allowlist.spec.js`, `test/links/resolve.spec.js`: `/d/<uid>/<slug>?orgId=1&from=<ms>&to=<ms>&timezone=utc&var-cht_instance=<host>` plus `&viewPanel=panel-<id>` only when the id is unique on that dashboard; allow-list hosts from data-model.md; Grafana links resolved against collected dashboard JSON, other links by HTTP 2xx or 3xx within the timeout
- [X] T034 [P] [US1] Write failing tests `test/rollup/rank.spec.js`, `test/rollup/brief.spec.js`, `test/rollup/deterministic-brief.spec.js`: ranking by severity, confidence and `persisting_days`; `placement: body` for ranks 1 to 3 and `thread` otherwise; heartbeat with `checked` counts when no items; degraded brief built from candidates only with `degradation_notice` after three rejected drafts or unusable model output; `expected_load_notice` when a window is active
- [X] T035 [P] [US1] Write failing tests `test/render/report.spec.js` and `test/render/browser.spec.js` (stubbed playwright-core): Handlebars compiled with `strict: true`, escaping of untrusted text, a test that fails if any template contains `{{{`; inline SVG charts drawn from `changes.json`; summary element `#brief-summary`; browser launched headless with `javaScriptEnabled: false`, `offline: true`, every request aborted, `setContent` then `locator.screenshot({ type: 'png' })`
- [X] T036 [P] [US1] Write failing tests `test/publish/slack.spec.js` and `test/publish/payload.spec.js` (stubbed `WebClient`): `files.uploadV2` without `channel_id` and the id read from `result.files[0].files[0].id`; parent `chat.postMessage` with `text` fallback under 4,000 characters, `blocks` (header, one section per bullet, `image` with `slack_file.id`, context notices, context footer), `unfurl_links: false`, metadata `agent_watchdog.brief`; one threaded reply per item with metadata `agent_watchdog.item`; `chat.getPermalink` per message; pacing one message per second; heartbeat and failure notices; Slack failure after retries marks the run `unposted` and exits 74; `payload.json` shape from `contracts/slack-payload.md`; `audience` is an explicit argument
- [X] T037 [P] [US1] Write failing tests `test/cli/run.spec.js`: state machine from data-model.md (`created`, `collected`, `analysed`, `drafted`, `verified`, `degraded`, `rendered`, `published`, `heartbeat`, `previewed`, `unposted`, `failed`, `refused`); duplicate date without `--force` exits 75; metrics source unavailable posts a failure notice and exits 69; unexpected error posts a notice and exits 1; degraded exits 0 with `status: degraded`; projects without candidates incur no engine call; `AGENT_WATCHDOG_RUN_TIMEOUT_MS` ends the run with what it has

### Implementation for User Story 1

- [X] T038 [US1] Implement `src/collect/grafana.js` (`fetch`, bearer header, timeout, proxy and API helpers, envelope parsing, uid cross-check)
- [X] T039 [US1] Implement `src/collect/discovery.js` and `src/collect/targets.js`
- [X] T040 [US1] Implement `src/collect/windows.js` and the stage runner `src/cli/stages/collect.js` writing `discovery.json` and `<project>/inputs/windows.json.gz`
- [X] T041 [P] [US1] Implement `src/analyze/changes.js` and `src/analyze/baselines.js`
- [X] T042 [P] [US1] Implement `src/analyze/calendar.js` (month_end, dates, weekly kinds with IANA timezone and `cycle_days`)
- [X] T043 [US1] Implement `src/analyze/thresholds.js`, `src/analyze/candidates.js` and the stage runner `src/cli/stages/analyze.js` writing `changes.json` and `candidates.json`
- [X] T044 [P] [US1] Write `prompts/system.md`, `prompts/pass-first.md`, `prompts/pass-review.md` and `prompts/rollup.md` with labelled untrusted-text delimiters, the structured-output instructions and the "compose no URLs" rule; write the initial `skill/cht-watchdog/SKILL.md`, `skill/cht-watchdog/references/metrics.md` (the R-6 catalogue) and an empty `skill/cht-watchdog/pattern-cards/index.md`
- [X] T045 [P] [US1] Write `agent/mcp.template.json` (server `cht-docs` of type `http` with per-tool policies allowing `search_docs` and `get_sources` and denying `ask_question`; server `watchdog` placeholder), `agent/tools.json` and `agent/hooks.js` (`PreToolUse` deny-by-default, `PostToolUse` recorder, `Stop` gate) per `contracts/agent-definition.md`
- [X] T046 [US1] Implement `src/agent/definition.js` and `src/agent/prompt-assembly.js`
- [X] T047 [US1] Implement `src/agent/tools/watchdog-tools.js` (SDK `tool()` definitions with zod shapes), `src/agent/tools/sdk-server.js` (`createSdkMcpServer`) and `src/agent/tools/replay-shim.js`
- [X] T048 [US1] Implement `src/agent/session-loop.js` (engine-agnostic pass and revision loop, convergence, bounds, artefact writes)
- [X] T049 [US1] Implement `src/agent/engine-sdk.js`: dynamic `import()` of the SDK; `query()` with a streaming-input generator; options `settingSources: []`, `tools: []`, `allowedTools`, `permissionMode: 'dontAsk'`, `strictMcpConfig: true`, `persistSession: false`, `outputFormat`, `maxTurns`, `maxBudgetUsd`, `model`, `effort`, `hooks`, `env` spread from `process.env` with `CLAUDE_CONFIG_DIR`; result mapping for every `subtype`, `usage`, `total_cost_usd`, `structured_output` (research.md R-2)
- [X] T050 [US1] Implement the stage runner `src/cli/stages/agent.js` with `AGENT_WATCHDOG_PROJECT_CONCURRENCY`, skipping projects without candidates (FR-013), per-call timeout and the run-level timeout
- [X] T051 [US1] Implement `src/verify/gate.js`, `src/verify/format.js` and `src/verify/checks/*.js` (one module per check listed in T032)
- [X] T052 [US1] Implement `src/links/build.js`, `src/links/allowlist.js`, `src/links/resolve.js`
- [X] T053 [US1] Implement `src/rollup/rank.js`, `src/rollup/brief.js` (roll-up model call with `schema/brief.schema.json` and the gate, at most three drafts), `src/rollup/deterministic-brief.js` and the stage runner `src/cli/stages/rollup.js`
- [X] T054 [US1] Design `templates/report.hbs` once (record the design read in the template header) and implement `src/render/report.js`
- [X] T055 [US1] Implement `src/render/browser.js` and the stage runner `src/cli/stages/render.js` writing `rollup/report.html` and `rollup/brief.png`
- [X] T056 [P] [US1] Write `templates/slack/parent.hbs`, `templates/slack/reply.hbs`, `templates/slack/heartbeat.hbs`, `templates/slack/failure.hbs` and implement `src/publish/payload.js` and `src/publish/audience.js`
- [X] T057 [US1] Implement `src/publish/slack.js` and the stage runner `src/cli/stages/publish.js` writing `payload.json`, `publication.json` and the final `run.json`
- [X] T058 [US1] Implement `src/cli/commands/run.js`: stage order `purge`, `feedback` (a pass-through that writes an empty `feedback.ingested.json` until US2), `collect`, `analyze`, `agent`, `rollup`, `render`, `publish`; state transitions, failure notice, exit codes, `--date`, `--project`, `--force`, idempotency
- [X] T059 [US1] Write the fixture end-to-end test `test/e2e/us1.spec.js` covering all seven US1 acceptance scenarios with recorded findings standing in for the model
- [X] T060 [US1] Write `smoke/grafana.js` (S-6, S-7), `smoke/slack.js` (S-8) and `smoke/agent-sdk.js` (S-1, S-2, S-4, S-5) with usage notes in `README.md`
- [X] T112 [P] [US1] Write failing tests `test/agent/reference-sources.spec.js` and extend `test/rollup/brief.spec.js`: a failed MCP connection to `cht-docs`, a `search_docs` tool error, or a permission denial during a session sets `reference_sources_unavailable: true` in `session.json`; analysis proceeds with skill and memory only; the roll-up adds the notice "reference sources were unavailable" to the brief (Edge Cases)
- [X] T113 [US1] Implement detection in `src/agent/session-loop.js` (tool result errors, `permission_denials` on the result message, MCP server status on the init message), the flag in `session.json`, and the notice in `src/rollup/brief.js` and `templates/slack/parent.hbs`

**Checkpoint**: `agent-watchdog run --dry-run` produces every artefact and the payload against a real watchdog; the fixture suite proves the seeded anomaly and the quiet day.

---

## Phase 4: User Story 2 - Feedback that changes tomorrow's brief (Priority: P2)

**Goal**: The next run reads reactions and thread notes on the previous N posts, records them against stable item identities, honours stated horizons, adjusts ranking, updates capped memory by diff, and appends outcomes to the corpus.

**Independent Test**: `test/e2e/us2.spec.js` on recorded Slack fixtures, then the live check in quickstart step 7.

### Tests for User Story 2

- [X] T061 [P] [US2] Write failing tests `test/feedback/ingest.spec.js`: `conversations.replies` per stored parent `ts` with `include_all_metadata`, paging by `cursor`; `reactions.get` with `full: true` per bot message; `+1` and `thumbsup` map to `up`, `-1` and `thumbsdown` to `down`; a previously recorded reaction now absent is `retracted`; a reaction on the parent targets the brief; bot messages identified by `bot_id` or `agent_watchdog.item` metadata; fallback to `conversations.history` when `publication.json` is missing; `--since` overrides the look-back
- [X] T062 [P] [US2] Write failing tests `test/feedback/match.spec.js` and `test/feedback/parse-notes.spec.js`: notes matched by explicit reference (item id, metric name, project host); unmatched notes recorded with `matched: false` and surfaced in the next brief's thread; `horizon` parsed from notes such as "expected until 1 October" through the feedback-parse model call with a deterministic date-parsing fallback
- [X] T063 [P] [US2] Write failing tests `test/feedback/store.spec.js`: `feedback.jsonl` append with `feedback_id` de-duplication and the fields `date`, `run_id`, `target`, `item_id`, `kind`, `verdict`, `note`, `horizon`, `author`, `matched`, `source_ts`
- [X] T064 [P] [US2] Write failing tests `test/rollup/feedback-influence.spec.js` and `test/analyze/horizon.spec.js`: repeatedly dismissed patterns rank lower and confirmed ones higher; a pattern with a stated horizon is not flagged before the horizon unless it exceeds the noted expectation; two thumbs-up raise confidence in memory
- [X] T065 [P] [US2] Write failing tests `test/rollup/memory.spec.js`: `memory_update.replace_with` accepted only within `ceil(chars / 4) * 1.1 <= AGENT_WATCHDOG_MEMORY_MAX_TOKENS`; every change written as a unified diff to `memory/history/<run_id>.patch` and copied to `runs/<run_id>/memory.patch`; `version` incremented
- [X] T066 [P] [US2] Write failing tests `test/corpus/outcomes.spec.js`: confirmed and dismissed items with notes appended to `corpus/outcomes/<date>.jsonl` (FR-030); compaction of `feedback.jsonl` refuses to drop records whose outcomes are not yet appended

### Implementation for User Story 2

- [X] T067 [US2] Implement `src/feedback/ingest.js`, `src/feedback/match.js`, `src/feedback/parse-notes.js` (uses `AGENT_WATCHDOG_MODEL_FEEDBACK` and `prompts/feedback-parse.md`), `src/feedback/store.js` and the stage runner `src/cli/stages/feedback.js`
- [X] T068 [US2] Add feedback influence to `src/rollup/rank.js` and horizon suppression to `src/analyze/candidates.js`
- [X] T069 [US2] Implement `src/rollup/memory.js` and wire the roll-up's `memory_update` into `src/cli/stages/rollup.js`
- [X] T070 [US2] Implement `src/corpus/outcomes.js` and wire it into `src/cli/commands/run.js` after feedback ingestion
- [X] T071 [US2] Write `test/e2e/us2.spec.js` covering the five US2 acceptance scenarios on `test/fixtures/slack/`

**Checkpoint**: Feedback left on day N changes day N+1's ranking and memory in replay (SC-003).

---

## Phase 5: User Story 3 - Steering, auditing and running it yourself (Priority: P2)

**Goal**: Footer links lead to prompts (the specification since revision 25), configuration and trace with cost; the priority list steers analysis; every run is versioned and replayable offline; contributors run stages, preview mode and the CLI engine on their own machines.

**Independent Test**: quickstart steps 3 to 6 plus `test/e2e/us3.spec.js`.

### Tests for User Story 3

- [X] T072 [P] [US3] Write failing tests `test/publish/footer.spec.js` and `test/collect/priority.spec.js`: footer carries `AGENT_WATCHDOG_PROMPTS_URL`, `AGENT_WATCHDOG_CONFIG_URL`, the trace URL and `cost_usd` in currency; reordering `dashboards.yaml` changes analysis order and adding a dashboard adds its panels; `query_metric` still reaches metrics beyond the list
- [X] T073 [P] [US3] Write failing tests `test/store/versions.spec.js`: `run.json.versions` holds `package`, `git_sha`, `prompts_hash`, `skill_hash`, `schema_hash`, `config_hash`
- [X] T074 [P] [US3] Write failing tests `test/cli/replay.spec.js`: reads a stored run, writes `runs-replay/<run_id>/<label>/` with the same layout, honours `--prompts` and `--skill`, serves recorded tool results through the replay shim, never calls the Grafana or Slack hosts (the `fetch` guard fails the test otherwise), prints the items comparison JSON on stdout
- [X] T075 [P] [US3] Write failing tests `test/cli/dry-run.spec.js` and `test/cli/stage.spec.js`: preview writes every artefact and `payload.json`, prints the payload on stdout, posts nothing and sets `status: previewed`; `--stage <name>` reads only the previous stage's files, exits 65 naming a missing input, overwrites its outputs atomically
- [X] T076 [P] [US3] Write failing tests `test/agent/engine-cli.spec.js` with a fake `claude` script: arguments `-p --bare --no-session-persistence --input-format stream-json --output-format stream-json --system-prompt-file … --tools "" --allowed-tools … --permission-mode dontAsk --mcp-config … --strict-mcp-config --json-schema … --model … --effort … --max-budget-usd …`; user turns written to stdin after each `result` event; `tool_use` and `tool_result` events recorded to `tool-calls.jsonl`; harness turn cap closes stdin and terminates; timeout kill; result mapping identical to the SDK engine (research.md R-3)

### Implementation for User Story 3

- [X] T077 [US3] Implement `src/store/versions.js` and stamp versions in `src/cli/commands/run.js`; add the footer to `src/publish/payload.js`
- [X] T078 [US3] Implement `src/cli/commands/replay.js`
- [X] T079 [US3] Implement preview mode (`--dry-run`, `AGENT_WATCHDOG_DRY_RUN`) and `--stage` handling in `src/cli/commands/run.js` and `src/cli/stages/index.js`
- [X] T080 [US3] Implement `src/agent/engine-cli.js` and `src/agent/tools/stdio-server.js` with the `tools-server` command in `src/cli/commands/tools-server.js`
- [X] T081 [US3] Implement `scripts/replay-eval.js` (`npm run replay:eval`): runs the fixture runs through analysis, gate and recorded findings, compares with `test/fixtures/runs/*/expected.json` and `test/fixtures/feedback-labels.json`, exits non-zero on regression
- [X] T082 [US3] Write `smoke/agent-parity.js` (S-3, S-10) diffing both engines' `findings.pass<n>.json` and gate verdicts for one recorded project
- [X] T083 [US3] Write `test/e2e/us3.spec.js` covering the seven US3 acceptance scenarios
- [X] T114 [P] [US3] Write failing tests `test/cli/replay-range.spec.js` and `test/perf/replay-thirty-days.spec.js`: `replay --from <date> --to <date>` replays every stored run in the inclusive range with concurrency bounded by `AGENT_WATCHDOG_PROJECT_CONCURRENCY`, writes one comparison per run and a summary on stdout, and thirty fixture runs with recorded model outputs complete in under ten minutes (SC-006)
- [X] T115 [US3] Implement the range flags and summary in `src/cli/commands/replay.js`

**Checkpoint**: A contributor can run every stage, the full pipeline in preview, and the analysis through `claude -p`, obtaining the same artefacts (SC-006, SC-007, SC-011).

---

## Phase 6: User Story 4 - Self-improvement under review (Priority: P3)

**Goal**: The agent writes pattern and threshold proposals with evidence, flags identifiers for the reviewer, condenses memory within its cap, and a weekly calibration report backs threshold suggestions with replayed effects.

**Independent Test**: `test/e2e/us4.spec.js` on recorded days with a recurring pattern and a noisy metric; assert no prompt, skill or threshold file changed.

### Tests for User Story 4

- [X] T084 [P] [US4] Write failing tests `test/rollup/proposals.spec.js` and `test/corpus/scrub.spec.js`: proposal files `proposals/<date>-<type>-<slug>.md` with `type` in `skill`, `prompt`, `threshold`, `pattern_card`; pattern-level bodies; identifiers (discovered hostnames, e-mail addresses, Slack user ids, feedback author names) masked in the body and listed under `flags` with `kind` in `hostname`, `person`, `address`, `secret`; `status` `proposed` or `superseded`; a guard test asserting `prompts/`, `skill/`, `schema/`, `agent/` and the policy files are never written by a run
- [X] T085 [P] [US4] Write failing tests `test/calibration/report.spec.js` and `test/calibration/suggest.spec.js`: per project and metric `distribution` percentiles of daily percentage change and deviation, `outcomes` counts, `current_threshold`, `suggested_threshold`, `effect_last_30d` with `items_kept`, `items_dropped`, `confirmed_kept`; `pass_change_rate` (FR-058); `week` as `YYYY-Www`; threshold proposals written from the report; `feedback_rate` over the last sixty days from `corpus/outcomes/`: the share of items that received a thumbs-down and no thumbs-up, overall and by month (SC-002)
- [X] T086 [P] [US4] Write failing tests `test/rollup/memory-condense.spec.js`: at the cap the agent condenses within the cap, the change is stored as a diff, and the run does not fail

### Implementation for User Story 4

- [X] T087 [US4] Implement `src/rollup/proposals.js` and `src/corpus/scrub.js`; wire proposal writing into `src/cli/stages/rollup.js`
- [X] T088 [US4] Implement `src/calibration/report.js`, `src/calibration/suggest.js`, `prompts/calibration.md` (summary with `AGENT_WATCHDOG_MODEL_CALIBRATION`) and the command `src/cli/commands/calibrate.js` (`--week`, `--project`), including `feedback_rate` computed from `src/corpus/outcomes.js`
- [X] T089 [US4] Implement memory condensation in `src/rollup/memory.js` with a condensation prompt in `prompts/rollup.md`
- [X] T090 [US4] Write `test/e2e/us4.spec.js` covering the four US4 acceptance scenarios

**Checkpoint**: Proposals and a calibration report exist for the recorded days, and every reviewed file is byte-identical after the run.

---

## Phase 7: User Story 5 - New projects and readiness (Priority: P3)

**Goal**: A project added to the hosted watchdog is analysed on the next run and named as new; operators can check a CHT deployment's readiness for monitoring.

**Independent Test**: `test/e2e/us5.spec.js` plus quickstart step 8.

### Tests for User Story 5

- [X] T091 [P] [US5] Write failing tests `test/collect/new-project.spec.js`: a host present in `up{job="cht"}` with no `projects.yaml` entry is analysed like any other and the brief carries a "new, unconfigured project" note; a project with fewer than 14 daily points has history comparisons marked unavailable and never computed from partial data
- [X] T092 [P] [US5] Write failing tests `test/readiness/check.spec.js`: `GET https://<host>/api/v2/monitoring` parsed for `version.app`; below 3.12.0 reports the unmet prerequisite in plain language and exits 1; 4.3.0 (API metrics) and 4.11.0 (CouchDB size metrics) reported as informational; unreachable host exits 69; `https://<host>:8443/metrics` probed only when `projects.yaml` sets `host_metrics: true` (research.md R-6)

### Implementation for User Story 5

- [X] T093 [US5] Add the new-project note to `src/rollup/brief.js` and `templates/slack/parent.hbs`; confirm `src/collect/discovery.js` and `src/collect/windows.js` satisfy the history rule
- [X] T094 [US5] Implement `src/readiness/check.js` and the command `src/cli/commands/check.js`
- [X] T095 [US5] Write `test/e2e/us5.spec.js` covering the three US5 acceptance scenarios

**Checkpoint**: A newly added project appears in the next brief (SC-008) and `agent-watchdog check` reports readiness with the documented exit codes.

---

## Phase 8: User Story 6 - Learning from the knowledge corpus (Priority: P3)

**Goal**: Maintainers drop raw material into the corpus; distillation produces scrubbed, reviewable pattern cards; merged cards are indexed for the daily analysis and read in full only when relevant.

**Independent Test**: `test/e2e/us6.spec.js` and quickstart step 9.

### Tests for User Story 6

- [X] T096 [P] [US6] Write failing tests `test/corpus/index.spec.js`: `corpus/index.json` records `relative_path`, `content_hash` (full SHA-256), `size_bytes`, `kind` in `conversation`, `export`, `incident`, `explainer`, `run_outcome`, `unknown`, `status` in `new`, `distilled`, `skipped`, `skipped_reason` (`binary`, `too_large`), `distilled_at`, `card_ids`; a changed hash resets `status` to `new`; the index never contains content
- [X] T097 [P] [US6] Write failing tests `test/corpus/distill.spec.js`: only `new` items processed unless `--all` or `--item`; one card per distinct pattern with `symptom`, `metrics` and shape, `watchdog_appearance`, `root_cause`, `resolution`, `confirmation_steps`, `false_positives`, `sources` (content hashes); identifiers removed or flagged; raw content never copied; cards written under `corpus/cards.proposed/<card_id>.md` with `status: proposed`; enormous or binary items skipped with a note in the distillation report
- [X] T098 [P] [US6] Write failing tests `test/agent/pattern-index.spec.js`: only `skill/cht-watchdog/pattern-cards/index.md` is in the static prefix; a full card is read only through `read_pattern_card`; an item matching a merged card names it in `pattern_card` and uses the card's `confirmation_steps` as `suggested_check`

### Implementation for User Story 6

- [X] T099 [US6] Implement `src/corpus/index.js`
- [X] T100 [US6] Implement `src/corpus/distill.js`, `prompts/distill.md` (with `AGENT_WATCHDOG_MODEL_DISTILL`) and the command `src/cli/commands/distill.js` (`--all`, `--item`), printing the distillation report on stdout
- [X] T101 [US6] Implement `scripts/build-card-index.js` generating `skill/cht-watchdog/pattern-cards/index.md` from merged cards, and wire card matching into `src/rollup/rank.js`
- [X] T102 [US6] Write `test/e2e/us6.spec.js` covering the five US6 acceptance scenarios on `test/fixtures/corpus/`

**Checkpoint**: A new corpus item becomes a proposed card in one distillation, and a merged card is named by the next matching item (SC-009).

---

## Phase 9: User Story 7 - Feedback acknowledged and made permanent (Priority: P3)

**Goal**: Feedback records are permanent while their ranking influence is bounded; the run reviews the day's feedback, turns notes into proposals for the right destination, and acknowledges everything once with a code-built digest reply and a "seen" reaction; the roll-up finally sees the day's matched feedback so memory can reflect it.

**Independent Test**: `test/e2e/us7.spec.js` plus quickstart step 12.

### Tests for User Story 7

- [X] T116 [P] [US7] Write failing tests extending `test/rollup/brief.spec.js`: the roll-up user prompt carries the day's matched feedback (verdicts, notes, horizons) per item inside `<untrusted source="feedback">` with author identifiers removed, and the system prompt built from `prompts/rollup.md` contains no literal `{{…}}` placeholder (FR-029 correction, US2 scenario 1)
- [X] T117 [P] [US7] Write failing tests `test/feedback/influence.spec.js`, extending `test/store/retention.spec.js` and `test/config/load.spec.js`: `classify('feedback.jsonl')` is `durable` and `purge` dated 365 days later leaves every record byte-identical; `by_item` tallies count only records dated within `AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` (default 30, hard cap 365, validated at startup) while a horizon holds until its date; `get_item_history` and the outcomes are unaffected (FR-059, FR-060)
- [X] T118 [P] [US7] Write failing tests `test/feedback/review.spec.js`: reactions never reach the model; each unreviewed note gets one schema-validated call whose output is one of `expectation | project_annotation | skill | prompt | threshold | pattern_card | none`; every classification except `expectation` and `none` writes a proposal through `writeProposals` naming its destination, a `project_annotation` proposal carrying a fenced `projects.yaml` fragment plus rationale and the host flagged; a failed call leaves `classification` null for the next run; records gain `classification` and `proposal_id` (FR-061)
- [X] T119 [P] [US7] Write failing tests `test/publish/digest.spec.js` and extend `test/publish/slack.spec.js` and `test/feedback/store.spec.js`: the digest is built by code from `rollup/feedback.digest.json` fields (per item effect `confidence_up | confidence_down | suppressed (until) | none`, proposals with destination and path, the retention sentence with the records path and influence days), names no person, is `payload.digest` in preview and null when nothing is new, lists unmatched notes in place of the separate unmatched-notes reply; it is posted once as a thread reply under the brief or heartbeat with metadata `agent_watchdog.feedback_digest`; `reactions.add({ channel, timestamp, name: 'eyes' })` runs per acknowledged note with `already_reacted` tolerated and other failures logged; `acknowledged_run_id` is set once and never in preview (FR-062)
- [X] T120 [P] [US7] Write failing tests extending `test/calibration/report.spec.js` and `test/cli/calibrate.spec.js`: `open_proposals` lists every proposal still `proposed` with `proposal_id`, `type` and `age_days`, and the weekly markdown shows them (FR-063)

### Implementation for User Story 7

- [X] T121 [US7] Fill `prompts/rollup.md` properly and pass the day's matched feedback into the roll-up prompt in `src/rollup/brief.js` and `src/cli/stages/rollup.js` (FR-029)
- [X] T122 [US7] Make feedback permanent and bound its influence: `src/store/retention.js` (`feedback.jsonl` durable, compaction removed), `src/config/schema.js` (`AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS`, hard cap), `src/feedback/ingest.js` (windowed tallies), `.env.example` and `contracts/environment.md`
- [X] T123 [US7] Implement `src/feedback/review.js` with `prompts/feedback-review.md` (`AGENT_WATCHDOG_MODEL_FEEDBACK`), add `project_annotation` to the Proposal type in `src/model/schemas.js` and `src/rollup/proposals.js`, add the nullable `classification`, `proposal_id` and `acknowledged_run_id` fields to `schemas.Feedback` in `src/model/schemas.js` and store them through `src/feedback/store.js`, and wire review into `src/cli/stages/feedback.js` after ingestion
- [X] T124 [US7] Implement `src/publish/digest.js` and `templates/slack/feedback-digest.hbs`, the digest field in `src/publish/payload.js` (retiring the separate unmatched-notes reply and `templates/slack/unmatched.hbs`), posting and `reactions.add` in `src/publish/slack.js`, acknowledgement in `src/feedback/store.js`, `rollup/feedback.digest.json`, and the wiring in `src/cli/stages/publish.js` and `src/cli/commands/run.js`; register the metadata event in `contracts/slack-payload.md` app checklist
- [X] T125 [US7] Add `open_proposals` to `schemas.CalibrationReport` in `src/model/schemas.js`, to `src/calibration/report.js` and to the weekly markdown in `src/cli/commands/calibrate.js`
- [X] T126 [US7] Write `test/e2e/us7.spec.js` covering the seven US7 acceptance scenarios on the Slack fixtures (a two-day loop: post, react and note, next run's digest, second run acknowledges nothing, purge a year later)
- [X] T127 [US7] Update `README.md` and `AGENTS.md` (digest, `reactions:write` scope, permanent feedback, influence window) and add smoke test S-13 to `smoke/slack.js`

**Checkpoint**: Feedback left on day N is acknowledged once on day N+1 with its effect and proposals (SC-012), and the records are still on disk a year later (SC-013).

---

## Phase 10: User Story 9 - Grouped briefing for programmes (Priority: P2)

**Goal**: `projects.yaml` declares programme groups by host pattern and an ignore list; ignored hosts are discovered and counted but never analysed, charged or named; the body holds five top-level bullets of at most two lines with up to eight one-line sub-bullets, a programme with several flagged projects collapsing into one group bullet; the layout is computed by code, the model writes only item text, the gate enforces the new limits, Slack renders sub-bullets, and a smoke listing shows every discovered host with its group so the placeholder patterns can be replaced. Implemented before User Story 8 because alert groups are laid out per programme.

**Independent Test**: `test/e2e/us9.spec.js` plus quickstart step 13.

### Tests for User Story 9

- [X] T128 [P] [US9] Write failing tests extending `test/config/policy.spec.js`: `projects.yaml` accepts `groups` (`label` unique, at most 40 characters, never `Other` or `Watchdog`; `host_patterns` lowercase globs using only `*` and `?`) and `ignore` (globs); a pattern with a scheme or `www.` is rejected; the package default carries the two placeholder groups (`North Programme`, `South Programme`) and the ignore patterns `*.dev.*` and `*-dev.*` (FR-068)
- [X] T129 [P] [US9] Write failing tests extending `test/collect/discovery.spec.js`, `test/model/schemas.spec.js` and `test/analyze/pipeline.spec.js`: every Project gets `group` (first matching group in file order, else `Other`) and `ignored`; `discovery.json` lists `groups` with their hosts and the `ignored` hosts; an ignored host gets no project directory, no windows, no candidates, no pass and no cost record, and `notices` never names it (FR-068)
- [X] T130 [P] [US9] Write failing tests `test/rollup/layout.spec.js` and extend `test/rollup/rank.spec.js`: the layout rule quoted from data-model.md Bullet (five slots; an entry joins its Project Group's slot while the slot holds fewer than eight; one Item is an `item` bullet, two or more a `group` bullet with children in rank order; the rest go to the thread); `slot` 1 to 5 or null on every Item; `BODY_SLOTS` is 5; `rollup/layout.json` shape (FR-010, FR-069)
- [X] T131 [P] [US9] Write failing tests extending `test/verify/checks/bullet_count.spec.js`, `test/verify/checks/bullet_length.spec.js`, `test/verify/checks/thread_order.spec.js` and `test/verify/gate.spec.js`: at most five bullets and eight children per bullet; children one line of at most 120 characters, bullets two lines; a draft whose item ids differ from the layout's body items is rejected with a reason; `thread_order` begins with the body items in layout order (FR-015, FR-069)
- [X] T132 [P] [US9] Write failing tests extending `test/rollup/brief.spec.js`, `test/rollup/deterministic-brief.spec.js`, `test/publish/payload.spec.js`, `test/render/report.spec.js` and `test/model/schemas.spec.js`: the roll-up user prompt names the items that are sub-bullets and must be one line; `briefFromDraft` assembles `Bullet { kind: 'item' | 'group' | 'alerts', item_id, group, text, children, alert_key }` from the draft and the layout with the code-built group text "<label>: <n> projects with issues"; `schemas.Brief.bullets` has at most 5 entries and `children` at most 8; the parent has one `section` per top-level bullet with sub-bullets as indented `◦` lines and the fallback text lists them; the report template renders sub-bullets; the degraded brief obeys the same limits (FR-010, FR-015, FR-069)
- [X] T133 [P] [US9] Extend `test/e2e/helpers.js` and `test/helpers/fake-grafana.js` so the fake watchdog serves hosts across two groups and one `.dev` host, and write failing `test/e2e/us9.spec.js` covering the four US9 acceptance scenarios

### Implementation for User Story 9

- [X] T134 [US9] Add `groups` and `ignore` to the `projects.yaml` schema in `src/config/policy.js` (glob validation, reserved labels) and to `config/defaults/projects.yaml` (placeholder groups, ignore patterns); update `contracts/config-files.md` if the loaded shape differs
- [X] T135 [US9] Implement group and ignore matching in `src/collect/discovery.js` (glob to anchored regular expression, first match wins, `group` and `ignored` on each Project, `groups` and `ignored` in `discovery.json`), skip ignored projects in `src/cli/stages/collect.js`, `src/cli/stages/analyze.js`, `src/cli/stages/agent.js` and `src/rollup/new-projects.js`, and add `group` and `ignored` to `schemas.Project` in `src/model/schemas.js`
- [X] T136 [US9] Implement `src/rollup/layout.js` (layout rule, `rollup/layout.json`), `slot` and `BODY_SLOTS = 5` in `src/rollup/rank.js`, and in `src/model/schemas.js` the `Bullet` fields `kind`, `group`, `children`, `alert_key`, `bullets.max(5)` and `Item.slot`
- [X] T137 [US9] Raise the gate: `MAX_BULLETS = 5` and `MAX_CHILDREN = 8` in `src/verify/checks/bullet_count.js`, one-line children in `src/verify/checks/bullet_length.js`, layout agreement in `src/verify/checks/thread_order.js` with a `layout` argument to `verifyBrief` in `src/verify/gate.js` and `src/cli/gate.js`; update the limits in `src/agent/output-schema.js` descriptions and regenerate `schema/brief.schema.json` with `npm run schema:build`
- [X] T138 [US9] Assemble bullets from draft plus layout in `src/rollup/brief.js` (`briefFromDraft`, a prompt section naming the one-line items) and `src/rollup/deterministic-brief.js`, write `layout.json` from `src/cli/stages/rollup.js`, and change the rules in `prompts/rollup.md` to five bullets with one-line sub-bullets
- [X] T139 [US9] Render sub-bullets in `templates/slack/parent.hbs` and `src/publish/payload.js` (`parentBlocks`: one section per top-level bullet, children as indented `◦` lines; fallback text) and in `templates/report.hbs` with `src/render/report.js` for the image
- [X] T140 [US9] Add `--hosts` to `smoke/grafana.js` (every discovered host with its group and ignored flag) and a sub-bullet post to `smoke/slack.js` (S-16); make `test/e2e/us9.spec.js` pass; update `README.md` and `AGENTS.md` (groups, ignore list, five bullets with sub-bullets)

**Checkpoint**: a programme with several flagged projects reads as one bullet with one sub-bullet per project, ignored hosts appear nowhere in the post, and no published body exceeds five bullets, two lines or eight sub-bullets (SC-015).

---

## Phase 11: User Story 8 - Alerts in the brief (Priority: P2)

**Goal**: each run reads the Grafana-managed alert rules and firing instances with the Viewer token, classifies them from `alerts.yaml`, marks new and stale instances, groups them per programme and category into code-built bullets with links, posts one thread reply per alert group, gives the analysis the project's firing alerts as context, keeps durable episodes with correlations and the analysis's explanation, and says so when alerting is unavailable.

**Independent Test**: `test/e2e/us8.spec.js` plus quickstart step 13.

### Tests for User Story 8

- [X] T141 [P] [US8] Write failing tests extending `test/config/policy.spec.js` and `test/store/versions.spec.js`: `alerts.yaml` (`stale_after_days` an integer from 1 to 365; `rules` keyed by title with `category` a lowercase slug and `importance` one of `critical`, `high`, `medium`, `low`; `categories` listing metric keys with every used category present); the package default carries the FR-065 mapping; `config_hash` covers the four policy files (FR-065)
- [X] T142 [P] [US8] Write failing tests `test/collect/alerts.spec.js` and extend `test/collect/grafana.spec.js` and `test/helpers/fake-grafana.js`: `GET /api/prometheus/grafana/api/v1/rules` (following `groupNextToken`) and the `/alerts` fallback are read with the bearer token and timeout; rules and instances are normalised (`state` compared case-insensitively with `alerting` mapped to `firing`; `instance` label to host as in R-6; dashboard uid and panel id from the `__dashboardUid__` and `__panelId__` annotations; instances on ignored hosts dropped and counted); a 401, 403, 5xx or timeout yields `available: false` with a reason in `alerts.json` and the run continues (FR-064)
- [X] T143 [P] [US8] Write failing tests `test/alerts/classify.spec.js` and `test/alerts/group.spec.js`: category and importance by title, an unknown title is `uncategorised`, `medium`, `known: false`; `started_at` from `activeAt` else the first observing run; `days_firing`, `stale` at exactly `stale_after_days`, `new` against the previous run's `alerts.classified.json`; Alert Groups per `group` and `category` with `firing`, `new`, `stale`, `oldest_started_at`, highest `importance`, `rule_uids`, `instance_ids`; instances without a host fall under `Watchdog`; only `firing` instances are counted (FR-065, FR-066)
- [X] T144 [P] [US8] Write failing tests `test/alerts/episodes.spec.js` and extend `test/store/retention.spec.js` and `test/corpus/outcomes.spec.js`: `opened`, `observed` and `cleared` events appended to `alerts/episodes.jsonl` with `duration_hours` on clear; correlations (active expected-load window, a `cht_version` change across `started_at`, related candidates and items whose metric is listed under the category within one day); `explanation` copied from an accepted Item of the same project and category; a cleared episode appended to `corpus/outcomes/<date>.jsonl` as `kind: alert_episode`; `classify('alerts/episodes.jsonl')` is `durable` (FR-067)
- [X] T145 [P] [US8] Write failing tests extending `test/rollup/layout.spec.js`, `test/rollup/brief.spec.js`, `test/rollup/deterministic-brief.spec.js`, `test/links/build.spec.js`, `test/links/resolve.spec.js`, `test/verify/checks/links_resolve.spec.js`, `test/publish/payload.spec.js` and `test/publish/slack.spec.js`: Alert Groups rank among Items by importance (critical before every item, otherwise after items of the same severity) and share one `alerts` bullet per programme with one child per category, code-built text "<label> alerts: <n> firing, <m> stale for more than <d> days" and no URL; `buildAlertListLink` emits `<grafana>/alerting/list?search=<encoded terms>` from `namespace:CHT`, `state:firing`, `rule:"<title>"` and `label:instance=~"^(<hosts>)$"` and resolves by checking every title and host against the collected rules and instances; one reply per Alert Group with `agent_watchdog.alerts` metadata from `templates/slack/alert-group.hbs` (at most fifty instances, the count of the rest, one link per rule and one for the group) in body order; a day without items but with firing alerts posts the alert bullets rather than a heartbeat; an unavailable alerting API adds a notice (FR-066, FR-070)
- [X] T146 [P] [US8] Write failing tests extending `test/agent/prompt-assembly.spec.js`, `test/agent/stage-agent.spec.js`, `test/feedback/ingest.spec.js`, `test/feedback/match.spec.js` and `test/publish/digest.spec.js`: the project's firing alerts reach the pass prompt inside `<untrusted source="alerts">`; bot replies carrying `agent_watchdog.alerts` metadata are alert groups, and reactions or notes on them are recorded with `target: alert_group` and `alert_key`, acknowledged in the digest, and never change ranking (FR-066, FR-067)
- [X] T147 [P] [US8] Record the fixture day `test/fixtures/runs/alerts-day` with `test/fixtures/generate.js` (nine rules, fifteen firing instances across two programmes including three firing for more than 14 days and one unknown rule title, one instance on a `.dev` host, one rule without an `instance` label) and write failing `test/e2e/us8.spec.js` covering the six US8 acceptance scenarios over two consecutive days (an instance clears on day two)

### Implementation for User Story 8

- [X] T148 [US8] Load `alerts.yaml` in `src/config/policy.js` (schema, defaults from `config/defaults/alerts.yaml`, inclusion in the policy hash used by `src/store/versions.js`) and add `AlertRule`, `AlertInstance`, `AlertGroup` and `AlertEpisode` to `src/model/schemas.js` with the enumerations from data-model.md
- [X] T149 [US8] Implement `src/collect/alerts.js` and the `alertRules()` and `alertInstances()` methods of `createGrafanaClient` in `src/collect/grafana.js`; write `alerts.json` from `src/cli/stages/collect.js` with `available` and `reason`; serve both endpoints from fixtures in `test/helpers/fake-grafana.js`
- [X] T150 [US8] Implement `src/alerts/classify.js` and `src/alerts/group.js` and write `alerts.classified.json` from `src/cli/stages/analyze.js`, reading the previous run's file for `new`
- [X] T151 [US8] Implement `src/alerts/episodes.js` (events, correlations, explanation), the `durable` class for `alerts/episodes.jsonl` in `src/store/retention.js`, the `alert_episode` outcome in `src/corpus/outcomes.js`, and the wiring in `src/cli/stages/rollup.js` after ranking
- [X] T152 [US8] Place Alert Groups in `src/rollup/layout.js`, build `alerts` bullets in `src/rollup/brief.js` and `src/rollup/deterministic-brief.js`, and add the alerts-unavailable notice to the Brief `notices`
- [X] T153 [US8] Implement `buildAlertListLink` in `src/links/build.js` and its resolution in `src/links/resolve.js` and `src/verify/checks/links_resolve.js`; write `templates/slack/alert-group.hbs`; add alert-group replies with `agent_watchdog.alerts` metadata to `src/publish/payload.js` and their posting to `src/publish/slack.js` and `src/cli/stages/publish.js`
- [X] T154 [US8] Pass the project's firing alerts into the analysis prompt in `src/agent/prompt-assembly.js` and `src/cli/stages/agent.js`, with a section in `prompts/pass-first.md` and `prompts/pass-review.md` explaining that an item may explain an alert
- [X] T155 [US8] Record feedback on alert-group replies in `src/feedback/ingest.js` and `src/feedback/match.js` (`target: alert_group`, `alert_key`), extend `schemas.Feedback` in `src/model/schemas.js`, and show it in `src/publish/digest.js` and `templates/slack/feedback-digest.hbs`
- [X] T156 [US8] Add `--alerts` to `smoke/grafana.js` (S-14, and printing the links for S-15); make `test/e2e/us8.spec.js` pass; update `README.md` and `AGENTS.md` (alerts in the brief, `alerts.yaml`, episodes)

**Checkpoint**: every alert firing at run time appears grouped in the body or thread with a link that resolves (SC-014); an unavailable alerting API is a notice, not a failure; episodes accumulate on disk.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Operations commands, performance, security, container proof, release tooling and documentation.

- [X] T103 [P] Implement the `purge` command in `src/cli/commands/purge.js` (`--dry-run` lists removals) on `src/store/retention.js`, and run it implicitly at the start of `run`
- [X] T104 [P] Write `test/perf/fifty-projects.spec.js`: a synthetic fifty-project run with recorded findings completes within `AGENT_WATCHDOG_RUN_TIMEOUT_MS` at concurrency 3 and projects without candidates make no engine call (Edge Cases, FR-013)
- [X] T105 [P] Write `scripts/scan-secrets.js` and `test/scripts/scan-secrets.spec.js` applying the gate's secret and personal-data patterns to the repository and to every run's artefacts, and add it to `.github/workflows/agent-watchdog.yml` and to the end of `src/cli/commands/run.js` (SC-010)
- [X] T106 [P] Write `smoke/render.js` (S-11) and `smoke/container.js`: `docker run --read-only --tmpfs /tmp` renders a fixture report, `--version` prints the version, `check https://example.invalid` exits 69
- [X] T107 [P] Write `smoke/langfuse.js` (S-9) confirming `getTraceUrl` opens the run's trace and `forceFlush` completes before exit
- [X] T108 [P] Run `semantic-release --dry-run` from the package directory and record the result in `README.md` "Releasing"; if path scoping fails, switch `release.config.js` to the workflow-filtered fallback from research.md R-12 (S-12)
- [X] T109 [P] Add `.github/pull_request_template.md` items for dependency justification, replay diff on prompt or skill changes, and `AGENTS.md` and `README.md` updates (constitution Quality Gates)
- [X] T110 Update `README.md` and `AGENTS.md` with the final commands, stage list, exit codes, contracts index and smoke-test instructions; confirm `AGENTS.md` agrees with `.specify/memory/constitution.md`
- [ ] T111 Run quickstart.md sections 1 to 18 against a real watchdog in preview mode, fix what fails, and confirm `npm run lint` reports zero warnings and coverage is at or above `main`

---

## Phase 13: Live preview fixes (2026-09-20)

**Purpose**: The first preview run against the hosted watchdog (quickstart step 3) answered 400 for every
derived metric's trailing baseline and for every expression using the dashboards' `$interval` variable
(FR-071, research.md R-15). Tests first: the fake Grafana learns to reject what Prometheus rejects.

- [X] T157 [P] Add `test/collect/variables.spec.js`, extend `test/collect/windows.spec.js`, `test/collect/discovery.spec.js`, `test/collect/grafana.spec.js`, `test/collect/query-window.spec.js` and add `test/helpers/fake-grafana.spec.js` for the subquery form, variable resolution, the error detail and the fake's 400s
- [X] T158 Build the trailing baseline as `max_over_time((<expr>)[1d:5m])` for anything but a bare selector and scope the first selector of an unscoped expression in `src/collect/windows.js`
- [X] T159 Resolve dashboard variables and Grafana's built-in time variables in `src/collect/variables.js`; record `variables` per dashboard and `unresolved` per panel in `src/collect/discovery.js`; skip and name unresolved metrics in `src/collect/windows.js`; resolve through the run's `discovery.json` in `src/collect/query-window.js`, `src/cli/commands/run.js` and `src/cli/commands/tools-server.js`
- [X] T160 Put the response detail in the Grafana client's error message in `src/collect/grafana.js`; make `test/helpers/fake-grafana.js` answer 400 with the Prometheus envelope for an unsubstituted variable or a range on a non-selector
- [X] T161 Add smoke check S-17 to `smoke/grafana.js`; amend spec.md (FR-071, edge case, revision 10), plan.md (revision 10 delta), research.md (R-15, S-17), data-model.md, contracts/run-directory.md and quickstart.md step 3

**Checkpoint**: `npm test` and `npm run replay:eval` pass with the validating fake; S-17 against the hosted watchdog.

## Phase 14: Collection at a hundred projects (revision 11, 2026-09-20)

**Purpose**: The first hosted run re-collected four windows per metric for 95 projects and one slow query failed
the run (FR-072 to FR-074, SC-016, research.md R-16). Tests first.

- [X] T162 [P] Add `test/collect/history.spec.js` (stored windows by exact bounds from the latest run of an earlier date, ledger build, record, backfill, save) and `test/collect/concurrency.spec.js`
- [X] T163 [P] Extend `test/collect/grafana.spec.js` for the query timeout, one retry on timeout and 5xx, `query failed` after the second failure, unreachable after three consecutive failures, and `test/collect/windows.spec.js` for `source` per window, reuse and fallback
- [X] T164 [P] Extend `test/store/retention.spec.js` for ledger compaction and `test/perf/fifty-projects.spec.js` for query counts on a cold and a warm day
- [X] T165 Add `src/collect/history.js` (Daily Maxima Ledger under `history/<slug>.json`, stored-window lookup) and `source` to `MetricWindow` in `src/model/schemas.js`; `dataPaths.history` and `ensureDataLayout` in `src/store/run-dir.js`
- [X] T166 Reuse stored windows and the ledger in `src/collect/windows.js`, fetching only what the volume lacks and marking every window's `source`
- [X] T167 `AGENT_WATCHDOG_QUERY_TIMEOUT_MS` in `src/config/schema.js`, `.env.example`, `contracts/environment.md`; query timeout, one retry, consecutive-failure rule and `grafana.query_retry` log in `src/collect/grafana.js`; pass it from `src/cli/stages/collect.js`, `src/cli/commands/run.js`, `src/cli/commands/tools-server.js`, `smoke/grafana.js`
- [X] T168 Worker pool `src/collect/concurrency.js`; concurrent projects, per-project `fetched`/`reused`/`queries` and a `collect.done` total in `src/cli/stages/collect.js`; ledger compaction in `src/store/retention.js`
- [X] T169 Smoke S-18 note in `smoke/grafana.js` output; README, AGENTS, quickstart step 3; spec revision 11, plan delta, research R-16 and S-18, data model, run-directory and environment contracts

- [X] T170 One series per project (FR-075, revision 12): `breakdownOf` and `panel.breakdown` in `src/collect/discovery.js` with the `discovery.breakdown_panels` log, breakdown panels left out of `metricSpecs` and several series refused with the differing labels named in `src/collect/windows.js`; tests in `test/collect/discovery.spec.js` and `test/collect/windows.spec.js`; spec FR-075, edge cases, Out of Scope and clarification; plan delta; research R-17; data model; quickstart

**Checkpoint**: `npm test`, lint and `npm run replay:eval` pass; the perf spec shows 4 queries per metric on day one and 2 on day two with no trailing query; S-18 on the hosted watchdog.

## Phase 15: First complete hosted run fixes (revision 13, 2026-09-20)

**Purpose**: The first complete run lost every model session to the runtime's schema validator, mislabelled the
failures as timeouts, published "no metric changes to flag" over 2,058 candidates, and exited 1 on a tracing 401.

- [X] T171 [P] Tests first: `test/agent/structured-output-schema.spec.js` (dialect and identifier keywords removed, `$defs` renamed, refs rewritten, input untouched); engine specs expect the converted schema; `test/agent/session-loop.spec.js` for the `error` bound and the recorded message; `test/rollup/brief.spec.js` for the degraded brief and the notice when sessions failed; `test/cli/run.spec.js` for a failing trace flush; scan and personal-data specs for version strings
- [X] T172 `forStructuredOutput` in `src/agent/output-schema.js`, applied in `src/agent/engine-sdk.js` and `src/agent/engine-cli.js`
- [X] T173 `error` bound and `errors` on the pass record in `src/agent/session-loop.js`; the roll-up stage reads them and `composeBrief` degrades with the failure named (`src/cli/stages/rollup.js`, `src/rollup/brief.js`)
- [X] T174 Guard the success-path trace flush in `src/cli/commands/run.js`; skip phone matches inside tokens with letters in `src/verify/patterns.js`, `src/verify/scan.js`, `src/verify/checks/personal_data_absent.js`; categorise `Message Delivery (2h)` and `Low Disk Space - 80% Full` in `config/defaults/alerts.yaml`
- [X] T175 Spec revision 13 (edge cases, clarification, proposed User Stories 10 and 11), research R-2 addendum and S-4 result, data model, run-directory contract, README, AGENTS

## Phase 16: User Story 10, metrics that mean something (revision 14)

**Purpose**: Analyse each metric by its kind (FR-076) and merge display duplicates (FR-077), so the candidate list
stops being two thirds counters and clocks rising as they always do.

- [X] T176 [P] [US10] Tests first: `test/analyze/kinds.spec.js`; `test/analyze/changes.spec.js` for counter increases, resets, uptime restarts and excluded clocks; `test/analyze/candidates.spec.js` for the `restart` rule, the clock exclusion and increase evidence; `test/collect/discovery.spec.js` for the `>= 0` key
- [X] T177 [US10] `src/analyze/kinds.js` (`metricKind`, `increaseOver`, `dailyIncreases`, `restartsIn`); `kind`, `aggregate`, `restarts_24h` on the Computed Change and `restart` on the Candidate rule in `src/model/schemas.js`
- [X] T178 [US10] `metric_kinds` in `src/config/policy.js` with the stock CHT metrics as the default and in `config/defaults/thresholds.yaml`; kinds threaded through `src/analyze/changes.js`, `src/analyze/candidates.js`, `src/cli/stages/analyze.js`; increase and restart wording in `src/rollup/deterministic-brief.js`; the aggregate explained in `prompts/pass-first.md`
- [X] T179 [US10] Display comparison stripped from the metric key in `src/collect/discovery.js`
- [X] T180 [US10] The fake watchdog accumulates `kind: counter` series and answers rate-wrapped counters like a gauge (`test/helpers/fake-grafana.js`); `cht_couchdb_doc_total` marked a counter in `test/fixtures/generate.js`, fixtures regenerated; spec FR-076 and FR-077, plan delta, research R-18, data model, config-files contract

**Checkpoint**: `npm run replay:eval` unchanged on the three fixture days; the hosted run's candidate count falls with
the counters and clocks gone.

## Phase 17: User Story 11, correlation and consolidation (revision 14)

**Purpose**: One message a senior engineer would write: programme-wide patterns as one event, the metric next to
every alert, old news in a housekeeping line, good news in a resolved line, the most-used projects first, and status
markers by code (FR-078 to FR-082).

- [X] T181 [P] [US11] Tests first: `test/alerts/patterns.spec.js`, `test/rollup/markers.spec.js`, `test/rollup/notices.spec.js`; `test/alerts/group.spec.js` and `test/alerts/classify.spec.js` for patterns, evidence and housekeeping; `test/rollup/layout.spec.js` for the pattern line; `test/rollup/rank.spec.js` for users; `test/publish/payload.spec.js` and `test/render/report.spec.js` for markers, pattern paragraphs, evidence and item alert lines
- [X] T182 [US11] `src/alerts/patterns.js`; patterns, housekeeping exclusion and member evidence in `src/alerts/group.js`; evidence, housekeeping and group sizes in `src/alerts/classify.js`; changes per project, dead hosts and group sizes from `src/cli/stages/analyze.js`; schema fields in `src/model/schemas.js`
- [X] T183 [US11] Pattern category lines in `src/rollup/layout.js`; `src/rollup/notices.js` (housekeeping, cleared episodes, resolved) and connected users in `src/cli/stages/rollup.js` and `src/rollup/rank.js`
- [X] T184 [US11] `src/rollup/markers.js`; markers, pattern paragraphs, evidence and item alert lines in `src/publish/payload.js`, `templates/slack/alert-group.hbs`, `templates/slack/reply.hbs`, `src/cli/stages/publish.js`; markers in `src/render/report.js`; `fonts-noto-color-emoji` in the `Dockerfile`
- [X] T185 [US11] Spec FR-078 to FR-082 and scenario 6, research R-19, data model, slack-payload and run-directory contracts, quickstart, README, AGENTS

**Checkpoint**: the second hosted run shows one line for a programme-wide alert, metrics next to alerts, housekeeping
and resolved notices, and markers in Slack and in the image.

## Phase 18: Structured-output tool and run budget (revision 14, 2026-09-20)

**Purpose**: The second complete hosted run denied the runtime's `StructuredOutput` tool in every session and
spent the full project budget each time; the run budget was declared but never enforced (research.md R-20).

- [X] T186 [P] Tests first: `test/agent/hooks.spec.js` (runtime tool approved, not recorded), `test/agent/engine-sdk.spec.js` and `test/agent/engine-cli.spec.js` (allowed tools), `test/agent/stage-agent.spec.js` (run budget stops sessions, grants the remainder), `test/rollup/notices.spec.js` (budget notice)
- [X] T187 `RUNTIME_TOOLS` in `agent/hooks.js`, allowed in `src/agent/engine-sdk.js` and `src/agent/engine-cli.js`
- [X] T188 Run budget across sessions in `src/cli/stages/agent.js` with `budgetUsd` on `src/agent/session-loop.js`; `run_budget` in the agent summary; `runBudgetNotice` in `src/rollup/notices.js` read by `src/cli/stages/rollup.js`; environment contract, `.env.example`, spec edge case, research R-20, README, AGENTS

## Phase 19: The command-line engine on the operator's login (revision 15, 2026-09-20)

**Purpose**: A contributor's preview with `AGENT_WATCHDOG_ENGINE=cli` and no API key exited 78 although `claude`
was logged in; bare mode never reads a login (research.md R-3, login mode).

- [X] T189 [P] Tests first: `test/config/load.spec.js` (key optional for model commands on the cli engine, required with the sdk engine, the message names the alternative), `test/agent/engine-cli.spec.js` (login mode without `--bare`, `--setting-sources ""`, no config-dir override, blank key removed; key mode unchanged and the key handed to the child; `agent.cli_auth` and `agent.cli_login_missing`); `test/helpers/fake-claude.js` records its environment
- [X] T190 `forSdkModel` and the hint on `ANTHROPIC_API_KEY` in `src/config/schema.js`; `engine` in the loader context and the hint in the message in `src/config/load.js`
- [X] T191 Login mode in `src/agent/engine-cli.js` (`buildArgs` `login`, `subprocessEnv` `apiKey`, `claudeConfigDir`, the auth log lines); environment, agent-definition and cli contracts; `.env.example`; README; AGENTS; quickstart; spec FR-050, edge case and clarification; plan revision 15 delta; research R-3 login mode and smoke S-19

## Phase 20: Live alert snapshots and sessions stopped before a result (revision 16, 2026-09-20)

**Purpose**: The first single-project run on the operator's login crashed the roll-up on a negative episode duration
and would have read "alerts only" while its one session was stopped by the budget before a result (research.md R-21).

- [X] T192 [P] Tests first: `test/alerts/episodes.spec.js` (observation time, clamp and warning), `test/alerts/classify.spec.js` (`days_firing` from `fetched_at`, `observed_at`), `test/rollup/analysis.spec.js` (the analysis record), `test/rollup/brief.spec.js` (cut-off notice and degraded brief), `test/e2e/us8.spec.js` (clock time on the cleared episode)
- [X] T193 `ctx.now` in `src/cli/commands/run.js`; the clock on the alert snapshot in `src/cli/stages/collect.js`; `observedAt` and `observed_at` in `src/alerts/classify.js`; `observedAt`, the clamp and `alerts.episode_duration_clamped` in `src/alerts/episodes.js`; `observedAt` on `clearedEpisodes` in `src/rollup/notices.js`
- [X] T194 `src/rollup/analysis.js` (`analysisRecord`, `INCOMPLETE_BOUNDS`) used by `src/cli/stages/rollup.js` with `rollup.analysis_incomplete`; the cut-off notice and reason in `src/rollup/brief.js`; spec edge cases, FR-067 and clarification (revision 16); data-model Alert Instance and Alert Episode rows; run-directory contract; plan revision 16 delta; research R-21 and smoke S-20

## Phase 21: An error result read as a quiet day, and four payload defects (revision 17, 2026-09-20)

**Purpose**: A single-project preview exited 0 at $0.00 with "Alerts only" because the model id was a typo the
runtime reported as an error result; the same payload cut a reply mid-link, misgrouped ported hosts, resolved an
ignored host and missed housekeeping in a preview (research.md R-22).

- [X] T195 [P] Tests first: `test/agent/turn-mapper.spec.js` (`is_error`, `result_text`), `test/agent/session-loop.spec.js` (error bound without retries, budget stop keeps its bound), `test/config/load.spec.js` (model id format), `test/publish/payload.spec.js` (fitting at 43 and 140 hosts, fewer than fifty instances when needed), `test/links/build.spec.js` (`short` links), `test/collect/alerts.spec.js` (port strip), `test/alerts/classify.spec.js` (`ignored_hosts`, `deadHostsFromDiscovery`), `test/alerts/episodes.spec.js` and `test/rollup/notices.spec.js` (ignored hosts)
- [X] T196 `is_error` and `result_text` in `src/agent/turn-mapper.js`; the error bound in `src/agent/session-loop.js` (`agent.turn_error`); `modelId` in `src/config/schema.js`
- [X] T197 Reply fitting in `src/publish/payload.js` (`INSTANCE_STEPS`, `MAX_PATTERN_HOSTS`, `hostList`); `short` links in `src/links/build.js`; `hostOfLabels` port strip in `src/collect/alerts.js`
- [X] T198 `ignored_hosts` and `deadHostsFromDiscovery` in `src/alerts/classify.js`; `ignoredHosts` on `src/alerts/episodes.js` and `src/rollup/notices.js`, threaded by `src/cli/stages/rollup.js`; discovery dead hosts in `src/cli/stages/analyze.js`; spec edge cases, FR-066 and clarification (revision 17); data-model; environment, slack-payload and run-directory contracts; `.env.example`; plan revision 17 delta; research R-22 and smoke S-21

## Phase 22: The gate must not ask the model for what the run computed (revision 18, 2026-09-20)

**Purpose**: The first complete single-project run spent $2.00 of $2.28 on four rejected turns, all on the dashboard
reference window, and pass 1 was never accepted so its items were discarded (research.md R-23).

- [X] T199 [P] Tests first: `test/links/dashboard-ref.spec.js` (panel from the metric's windows, bounds from the leading evidence window, `current` and full-span fallbacks, null when the metric has no window), `test/verify/gate.spec.js` (`normaliseItems` builds the reference and ignores anything the model sent), `test/agent/session-loop.spec.js` (a revision request carries only failing checks' reasons), `test/verify/checks/numbers_match.spec.js` (a window identifier is not an invented number), `test/verify/patterns.spec.js` (a plain decimal is not a phone number)
- [X] T200 `src/links/dashboard-ref.js` (`dashboardRefFor`); `normaliseItems` in `src/verify/gate.js` takes the run's windows; `dashboard_ref` removed from `src/agent/output-schema.js`, regenerated into `schema/` by `scripts/build-schema.js` and copied to `contracts/findings.schema.json`; the instruction dropped from `prompts/pass-first.md` and `prompts/system.md`; recorded findings fixtures updated. A metric whose recorded panel is on no priority dashboard (scrape-target health) links the first priority dashboard with `panel_id: null` rather than an unrelated panel, so `DashboardRef.panel_id` is nullable and `links_built` skips the panel check for it
- [X] T201 Failing checks only in `src/agent/session-loop.js`; the plain-decimal exemption in `src/verify/patterns.js`; the window-name exemption in `src/verify/checks/numbers_match.js`; spec US1 scenario 6, FR-009, FR-018, FR-058, edge cases and clarification (revision 18); data-model Item row; agent-definition contract; plan revision 18 delta; research R-23 and smoke S-22

## Phase 23: A filtered brief, honest tool contracts and the first cost levers (revision 19, 2026-09-20)

**Purpose**: The run that converged for the first time was correct and expensive. Its brief carried fifty alerts from
projects it never analysed, it declared its reference sources unavailable while citing documentation it had just read,
its first tool call was refused for a metric it went on to publish, and a third pass cost $0.649 and changed nothing
(research.md R-24).

- [X] T202 [P] Tests first: `test/rollup/scope.spec.js` (the analysed set from the project flag, alert instances and notices narrowed, an empty result stated for the analysed projects), `test/cli/stage.spec.js` (a filtered roll-up leaves `alerts.classified.json` and `alerts/episodes.jsonl` whole), `test/agent/turn-mapper.spec.js` (a refusal of a tool outside the allow-list is not an unavailable source, a refusal of an allowed one still is), `test/agent/tools/watchdog-tools.spec.js` (`get_windows` accepts a collected key with functions and label matchers, `query_metric` still refuses one), `test/verify/patterns.spec.js` and `test/verify/scan.spec.js` (a date is not a phone number; findings in recorded tool results counted apart from the run's own output), `test/agent/session-loop.spec.js` (no review pass after an accepted pass with no items; `agent.tool_usage` logged; the review model used from pass two), no review-model test: the lever was dropped on inspection (research.md R-24, Dropped on inspection)
- [X] T203 `src/rollup/scope.js` (`analysedHosts`, `onAnalysedHosts`, `scopeClassified`) used by `src/cli/stages/rollup.js` with a `rollup.scoped` log line, regrouping from `alerts.classified.json`'s instances with `src/alerts/group.js`; the classified record, the episode update and collection stay whole; spec FR-066 and the `--project` row in `contracts/cli.md`
- [X] T204 `src/agent/turn-mapper.js` counts a refusal as unavailable only for a tool on the allow-list; `METRIC_NAME` replaced by the gate's key forms for `get_windows` in `src/agent/tools/watchdog-tools.js` while `query_metric` keeps its bare name; the permitted reference tools named in `prompts/system.md`
- [X] T205 A date excluded from the phone pattern in `src/verify/patterns.js`; findings in recorded tool results counted apart in `src/verify/scan.js` and reported as their own count by `src/cli/commands/run.js`; `agent.tool_usage` per project and per run from `src/agent/session-loop.js` and `src/cli/stages/agent.js`
- [X] T206 A written `not_selected` reason only at a medium or high severity floor in `prompts/pass-first.md`, `prompts/system.md` and the schema in `src/agent/output-schema.js` (regenerated into `schema/` and `contracts/findings.schema.json`); no review pass after an accepted pass with no items in `src/agent/session-loop.js`; plan revision 19 delta, research R-24 with the dropped review-model lever, and smoke S-23, S-24

## Phase 24: The analysis's own judgements become data (revision 20, 2026-09-21)

**Purpose**: Each converged run writes thirty-odd reasons for setting a candidate aside and decides in prose that one
item explains another, and the run then forgets both. A threshold only moves when a person reacted in Slack
(research.md R-25). Cross-project sharing of an analysis is recorded there as rejected and is not in this phase.

- [X] T207 [P] [US4] Tests first: `test/calibration/report.spec.js` (the last accepted pass's `not_selected` becomes `model_dismissed` observations with their reasons; a person's verdict on the same candidate wins; the entry's `selection` counts `raised`, `became_items`, `set_aside` and the commonest `reasons`), `test/calibration/suggest.spec.js` (a suggestion may rest on the analysis's own dismissals only where no person judged, and its reason says so; human dismissals alone behave exactly as before), `test/verify/checks/relates_to.spec.js` (a metric that is another item of the same findings passes; the item's own metric, an unknown metric and an unknown relation fail), `test/verify/gate.spec.js` (`relates_to` resolved from the sibling's metric to its item id, or null when the analysis named none), `test/agent/prompt-assembly.spec.js` (the roll-up prompt carries the relation), `test/model/schemas.spec.js` and `test/agent/structured-output-schema.spec.js` (the field and its four relations)
- [X] T208 [US4] `model_dismissed` observations and the `selection` summary in `src/calibration/report.js`, read from the last accepted `findings.pass<n>.json` of each project; the ranking and the stated reason in `src/calibration/suggest.js`; the report shape in `data-model.md`
- [X] T209 [US4] `relates_to` on the model's item in `src/agent/output-schema.js` (sibling `metric` plus `relation` of `level_of`, `rate_of`, `same_cause` or `consequence_of`), regenerated into `schema/` by `scripts/build-schema.js` and copied to `contracts/findings.schema.json`; the resolved `{ item_id, metric, relation }` on the Item in `src/model/schemas.js`; resolution from metric to identity in `src/verify/gate.js`
- [X] T210 [US4] The `relates_to` gate check in `src/verify/checks/relates_to.js`, registered in `CHECK_NAMES` in `src/verify/gate.js`: the named metric must be another item of the same findings and never the item's own, and the relation must be one of the four
- [X] T211 [US4] The relation into the roll-up prompt in `src/agent/prompt-assembly.js` and the instruction in `prompts/pass-first.md` and `prompts/system.md`; metric pairs counted in `src/calibration/report.js`; spec FR-009, FR-014a, FR-058 and User Story 4 scenario 5 (revision 20), plan revision 20 delta, research R-25 and smoke S-25

## Phase 25: A streak counted in dates, not in runs (revision 21, 2026-09-20)

**Purpose**: Three forced re-runs of one date reported `persisting_days` of 1, then 2, then 3 for the same item, so the
third published "climb for third consecutive day" and "persisting 3 days" about one day of movement, and the analysis
read the inflated streak back as prose (research.md R-26). The count walked run ids; the label says days. FR-009 now
counts analysed dates and the latest run of a date speaks for it. Nothing new is stored: the date is the first ten
characters of a run id, whose shape `RUN_ID_PATTERN` in src/store/run-dir.js already guarantees.

- [X] T212 [P] [US1] Tests first: extend `test/rollup/history.spec.js` (two forced runs of one date report the same streak for an item both contain; the first run of the next date reports one more; a date whose latest run wrote no `rollup/items.ranked.json` ends the streak; a re-run of an older date counts only dates strictly before its own; a date whose latest run dropped the item breaks the streak even though an earlier run of that same date carried it; `previousRunIds` stays run-keyed and ordered) and `test/rollup/rank.spec.js` (`persisting_days` is one plus the date-keyed count, and is still 1 with no history)
- [X] T213 [US1] Date-keyed `previousItemCounts` in `src/rollup/history.js`: group run ids by their date (the first ten characters), take the latest run of each date as the one that speaks for it, and walk dates descending from the one immediately before this run's own date, intersecting the ranked item ids and stopping at the first date whose authoritative run has no `rollup/items.ranked.json`. The run's own date contributes nothing and the signature stays `(dataDir, runId)`, so the call site `ctx.previousItemIds = await previousItemCounts(dataDir, runId)` in `src/cli/commands/run.js` is unchanged
- [X] T214 [US1] Keep `previousRunIds` run-keyed in `src/rollup/history.js` and leave its three callers alone — `previousDiscoveryFor` in `src/cli/stages/rollup.js`, `previousClassified` in `src/cli/stages/analyze.js` and `previousHostsFor` in `src/rollup/new-projects.js` — because each wants the most recent earlier run that wrote a given file, and alert newness is measured against the immediately preceding snapshot by design (FR-065); update the module comment in `src/rollup/history.js` and the `previousItemIds` parameter doc in `src/rollup/rank.js` so each says which unit it counts
- [X] T215 [US1] Record the revision: spec.md FR-009's persistence clause and the Edge Case "An item persists for many days", the `persisting_days` row and the Item Lifecycle line in data-model.md, the plan.md revision 21 delta, research.md R-26 and smoke test S-26. The agent stage's `persisting_days: 1` placeholder in `src/verify/gate.js` stays as it is: persistence is a roll-up concern the agent stage cannot know, and R-26 records that placeholder as correct

## Phase 26: The gate stops rejecting the run's own numbers, one pass by default (revision 22, 2026-09-21)

**Purpose**: A ninety-project run on Sonnet 5 showed the gate retrying 100 of 157 first attempts, 70 of them only
because two checks refused the run's own identifiers and values (the numeral of a window name, the numerals inside a
collected expression, a panel id, a nine-plus digit count read as a phone number), and review passes costing 45% of
the run while changing nothing in 26 of 40 cases and adding no item (research.md R-27). Four measured deltas: exempt
the run's own tokens, default to one pass and name a fully rejected first pass, stop re-sending what the shared
session holds, and key the history tool on analysed dates. Nothing new is stored and no stage is added.

- [X] T216 [P] [US1] Tests first for the gate: extend `test/verify/checks/numbers_match.spec.js` (the numeral `14` alone passes in "over the trailing 14 days" and "a 14-day baseline"; numerals inside a collected expression written in prose pass, such as `60`, `60` and `24` from `rate(cht_sentinel_backlog_count[24h]) * 60 * 60 * 24` once that expression is a collected panel expr in the context; a collected panel id passes in "open panel 3"; a numeral that is none of these and matches no computed value still fails; the exported exemption sets hold `14` and `14d`, the expression numerals and the panel ids) and `test/verify/checks/personal_data_absent.spec.js` (a nine-plus digit count equal to an evidence value or to a computed change for the item's metric passes; the existing bare telephone number `254712345678` is still caught; a nine-plus digit run that matches nothing computed is still caught; a digit run outside `items[]` keeps the current rule)
- [X] T217 [P] [US1] Tests first for one pass and the rejected project: `test/config/load.spec.js` (the passes default is 1, the hard cap stays 4), `test/rollup/analysis.spec.js` (a project with no error, no stopping bound and no items whose every pass carries `gate.outcome` `rejected` is listed under `rejected` with its commonest failing check; a project with items is never rejected; a rejected pass followed by an accepted one is not), `test/rollup/brief.spec.js` (the incomplete-analysis notice reads "model findings were rejected by the gate on N of M projects (commonest reason: <check>)" and the degraded reason says the same), and `test/agent/session-loop.spec.js` pinning that a pass rejected on every attempt writes `gate.outcome` `rejected` on its pass record
- [X] T218 [P] [US1] Tests first for the review prompt and the history tool: `test/agent/prompt-assembly.spec.js` (the review prompt contains the previous items and the unselected candidates and contains neither the candidates JSON, the changes JSON nor the alerts block; the assertion that the review prompt wraps alerts as untrusted is inverted; the first pass is unchanged) and a new `test/cli/agent-history.spec.js` for `itemHistoryFor` (two forced runs of one date give one entry, from the later run; the run's own date's earlier re-runs are excluded; the last run of a date is chosen by its forced number read as a number, so `-f10` beats `-f2`; the depth counts dates, not runs)
- [X] T219 [US1] Exempt the run's own tokens in `src/verify/checks/numbers_match.js`: replace `WINDOW_NAME_TOKENS` with a set holding every `extractNumbers` form of each window name with and without its unit letter (`14` and `14d`), and add two sets built from `ctx.discovery` per check run, the numerals of every collected metric key and panel expression (`ctx.discovery.metrics`, `flatPanels` over `ctx.discovery.dashboards`, through `keyForms`) and every collected panel `id`; a token in any set skips matching; the code-span rule is unchanged; export the set builders for tests
- [X] T220 [US1] In `src/verify/checks/personal_data_absent.js`, treat a run of nine or more digits as a number, not a phone number, when it equals as an integer a value that `allowedValues` from `src/verify/checks/numbers_match.js` returns for the item the walked path (`$.items[i]...`) belongs to; text outside `items[]` keeps the current rule; touch `src/verify/patterns.js` only if `phoneMatches` must expose the digit runs it matched
- [X] T221 [US1] One pass by default: `src/config/schema.js` default for `AGENT_WATCHDOG_PASSES` from 2 to 1 and `.env.example` line `AGENT_WATCHDOG_PASSES=2` to 1; the hard cap and `verifyMaxRetries` are unchanged, and the pass-loop skip condition in `src/agent/session-loop.js` is deliberately left alone (research.md R-27)
- [X] T222 [US1] Name a fully rejected first pass: `analysisRecord` in `src/rollup/analysis.js` gains `rejected` (projects with no error, no stopping bound and no items whose every pass record carries `gate.outcome === 'rejected'`, each with the commonest failing check name from those reports); `shortfalls` in `src/rollup/brief.js` gains a third entry in the shape of the failure and cut-off ones, notice "model findings were rejected by the gate on N of M projects (commonest reason: <check>)" and the same for the degraded reason; `src/cli/stages/rollup.js` logs `rollup.analysis_rejected` beside the two existing warnings
- [X] T223 [US1] The review prompt stops re-sending what the session holds: `prompts/pass-review.md` drops its `## Candidates`, `## Computed changes` and `## Firing alerts for this project` sections and gains one sentence saying the candidates, computed changes and firing alerts are in the first turn of this session; `buildPassPrompt` in `src/agent/prompt-assembly.js` fills `candidates`, `changes` and `alerts` only for pass 1 and fills `previous_items` and `not_selected` for a review pass
- [X] T224 [US1] The history tool answers in analysed dates: `itemHistoryFor` in `src/cli/stages/agent.js` returns one entry per analysed date, from the last run of that date, over the `HISTORY_RUNS` most recent analysed dates strictly before the current run's date, using `analysedDatesBefore` and `runDate` from `src/rollup/history.js`; the entry shape (`run_id`, `item_id`, `severity`, `confidence`, `feedback`) is unchanged
- [X] T225 [US1] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md FR-016, FR-056, FR-057 and the two revision-18 Edge Cases; data-model.md "Number matching", "Secrets and personal data" and the Pass `gate` row; contracts/environment.md and contracts/agent-definition.md; plan.md revision 22 delta; research.md R-27 and smoke tests S-27 to S-30

## Phase 27: A thread a person can read, a gate that trusts its own text, a roll-up that recovers, and what code hands the model (revision 23, 2026-09-21)

**Purpose**: The first ninety-project run to complete on one pass turned 150 items into 159 thread replies, retried the
gate on 78 of 90 sessions over numerals the model had read in its own session, lost the roll-up to three rejections of
one or two bullets each, spent 48 of 56 high items on one deterministic rule that already held the day before, opened
eight sessions on hosts dark for weeks, and raised 161 of 1,189 candidates on six reference-line targets (research.md
R-28). Six measured deltas: replies for body items only with the report shared into the thread and cited by rank,
the gate exempting the text the model was given, a roll-up session that mends only the failing bullets, standing
conditions and dark hosts named by code and handed to no session, reference lines classified out of collection, and
related items presented under the item they relate to. No new stage; four derived artefacts named in the plan.

- [X] T226 [P] [US1] Tests first for the thread and the report: `test/publish/payload.spec.js` (replies are built only for the layout's `body_items`, highest rank first and at most `MAX_ITEM_REPLIES` = 25, exported, then the alert-group replies; a `report` entry with `filename` `report-<run_id>.html`, `path`, `title`, `items`, `replied` and a code-built `initial_comment` naming the item count, how many have replies and how to cite one (`#<rank>`, or host and metric, a thumbs as the verdict); the parent's footer counts the items only in the report; heartbeat and failure payloads carry `report: null`; a body item's reply names each lower-ranked item whose `relates_to.item_id` is that item, with the relation and rank), `test/publish/slack.spec.js` (after the parent is posted, `files.uploadV2` is called once more with `channel_id`, `thread_ts` equal to the parent `ts`, `initial_comment`, `filename` and `title`, the image upload stays private, and the publication records `report: { file_id, ts, permalink }`; no share when `report` is null; a failed share is an `IOERR` like a failed image upload), `test/publish/stage.spec.js` (preview records `report.path` and uploads nothing; a real publish writes `report` on `publication.json` and `brief.report.slack_file_id`), `test/render/report.spec.js` (every item shows `#<rank>` and its `item_id`; a line says how to cite an item; an item related to a higher-ranked item is nested under it; a standing-conditions section lists rule, host and values when `standing` is given and is absent otherwise)
- [X] T227 [P] [US2] Tests first for feedback by rank and inline verdicts: `test/feedback/match.spec.js` (`#2` resolves to the item whose `rank` is 2 with `how: 'rank'`, before the item id, host and metric; `#99` with no such rank falls through to the other references; `noteVerdict` reads `:-1:`, `:thumbsdown:` and 👎 as `down`, `:+1:`, `:thumbsup:` and 👍 as `up`, none or both as null), `test/feedback/ingest.spec.js` with a new note in `test/fixtures/slack/replies-page2.json` (a note "#2 :-1: expected until 1 October" is recorded on the item ranked 2 of the source run with `kind` `note`, `verdict` `down`, the horizon, `matched` true, and counts in that item's `down` tally; a note that is only a thumbs is recorded unmatched with its verdict and counts in no tally)
- [X] T228 [P] [US1] Tests first for the gate: `test/verify/checks/numbers_match.spec.js` (findings: a numeral in `ctx.givenText`, such as `74` from an alerts block or `41` from a tool result, passes as `74d`, `74` or `41`; `24h` passes when the given text holds `[24h]`; a numeral in neither the given text nor the computed values still fails; brief: a bullet's numeral present in `ctx.itemTexts` for its own item passes while another item's evidence value does not, and a numeral in the run-wide `givenText` passes), `test/verify/checks/personal_data_absent.spec.js` ("0.00465 (0.01858 yesterday)" passes; `254712345678` and "555 123 4567" are still caught; a date followed by a time passes), `test/verify/checks/projects_known.spec.js` (the leading two labels of a discovered host pass; the bare domain of a discovered host and a host of another domain still fail), `test/agent/session-loop.spec.js` (the gate receives `givenText` holding every prompt sent in the session and every tool result text), `test/cli/gate.spec.js` (the wrapper forwards `givenText`), `test/rollup/brief.spec.js` (`verifyBrief` receives `givenText` with the layout and checked texts and `itemTexts` keyed by item id)
- [X] T229 [P] [US1] Tests first for the roll-up session: `test/rollup/brief.spec.js` (the engine's `openSession` is called once with no tools and closed at the end; each attempt is a `turn`; the second turn names only the bullets the gate rejected, by index and item id, with their reasons, and asks for the full draft with every other bullet copied verbatim; the draft verified and stored as `brief.draft2.json` keeps attempt 1's text for every bullet the gate did not name even when the model changed it; `rollup/prompt.md` is written through `ctx.runDir` with a `# Revision 1` header for the second turn; a cost record reads `cache_read_tokens` and `cache_read_input_tokens` alike; three rejections still degrade; a quiet day opens no session), and the existing `singleTurn` stubs of that file move to an `openSession` stub whose `turn` answers in order
- [X] T230 [P] [US1] Tests first for standing conditions and dark hosts: new `test/analyze/standing.spec.js` (`splitStanding`: a `backlog_absolute` candidate whose previous-day evidence is above zero is standing, one with zero or no previous-day evidence is not; a `target_down` candidate is standing when the project's scrape-target change has `previous_day_value` 0 and `trailing_mean` 0, not when it was up yesterday, up for most of the fortnight, or unknown; every other rule goes to the model; `standingRecords` carry rule, project, host, group, value and previous-day value; `standingNotices` writes one line per rule, grouped by programme with the count out of the programme's size and the largest host and value, plural forms right), `test/rollup/notices.spec.js` (`housekeepingNotice` names dark hosts with no stale alert, and both together, once each), `test/rollup/stage.spec.js` (the stage writes `rollup/standing.json`, appends the standing notice, and the degraded brief's bullets hold no standing candidate while `checked.candidates` counts every candidate), new `test/cli/agent-plan.spec.js` for the exported `planFor` of `src/cli/stages/agent.js` (a project whose candidates are all standing is skipped with reason `standing conditions only`; a project with one ordinary candidate keeps only that candidate for the session; a project with no candidates keeps the existing skip)
- [X] T231 [P] [US1] Tests first for reference lines and the hosted rule: `test/collect/discovery.spec.js` (`referenceLineOf`: a second target `cht_connected_users_count{...} / 10` beside a first target on another metric is `{ subject: <first target's metric key>, source: 'cht_connected_users_count' }`, likewise `x * 0.003 + 2` and `rate(y{...}[30d]) * 60 * 60 + 500`; a first target with an arithmetic tail is never one; a single-target panel never; a second target without a constant tail is not; a second target on the first target's own metric is not; `panelRecords` sets `reference_line` and `discover` leaves such targets out of `metrics` and logs `discovery.reference_line_panels`), and in `test/alerts/classify.spec.js` or the policy tests: the default `alerts.yaml` classifies `Sentinel Backlog >50` as `backlog` at `medium`
- [X] T232 [US1] Replies for body items only, the report shared into the thread: `src/publish/payload.js` (`MAX_ITEM_REPLIES`, a `layout` argument whose `body_items` select the replies in rank order, `reportEntry` with the code-built comment, the footer's further-items count, related lines on a body item's reply), `templates/slack/reply.hbs` (the related lines), `src/publish/slack.js` (`shareReport` after the parent through `files.uploadV2` with `channel_id`, `thread_ts` and `initial_comment`; `publication.report`), `src/cli/stages/publish.js` (pass the layout and the report path; write `brief.report`), `src/cli/stages/render.js` (set `brief.report = { path, slack_file_id: null, ts: null }` beside `brief.image`), `src/model/schemas.js` (Brief `report`, nullable, default null), `src/render/report.js` and `templates/report.hbs` (rank number and id per item, the cite line, related items nested, the standing section from `rollup/standing.json` read by the render stage)
- [X] T233 [US2] Feedback by rank and inline verdicts: `src/feedback/match.js` (`#<rank>` resolved against the items' `rank` first, `how: 'rank'`; `noteVerdict`), `src/feedback/ingest.js` (a note's verdict recorded; `applyRecord` counts a matched note's verdict like a reaction; an unmatched thumbs stays unmatched and uncounted), the fixture note in `test/fixtures/slack/replies-page2.json`
- [X] T234 [US1] The gate trusts the text it was given: `src/verify/checks/numbers_match.js` (`givenNumerals(texts)` on bare values; findings check `ctx.givenText`; brief check `ctx.givenText` plus `ctx.itemTexts.get(item_id)`; exported for tests), `src/verify/patterns.js` (`phoneMatches` skips a match whose whitespace- or bracket-separated parts are each a decimal, a date or a time), `src/verify/checks/projects_known.js` (a token that is the leading two or more labels of a discovered host is exempt), `src/verify/gate.js` (`verifyFindings` takes `givenText`, `verifyBrief` takes `givenText` and `itemTexts`), `src/agent/session-loop.js` (collects every prompt sent and every tool result text into `givenText` for the gate), `src/cli/gate.js` (forwards it), `src/rollup/brief.js` (hands `verifyBrief` the layout and checked texts and the per-item prompt entries)
- [X] T235 [US1] The roll-up recovers instead of restarting: `src/rollup/brief.js` (`composeBrief` opens one `engine.openSession({ tools: [] })` and takes a `turn` per attempt; `failingBullets(report, draft)` from the `bullets[i]` reasons; `revisionPrompt` naming only those with their reasons; `mergeDraft(previous, next, failing)` keeping every unnamed bullet's text from the previous attempt; the merged draft is what the gate verifies and what `brief.draft<n>.json` stores; `rollup/prompt.md` written with `# Revision n` headers when `ctx.runDir` is present; `costRecord` through `normaliseUsage` from `src/agent/turn-mapper.js`; the session closed on every path), `src/cli/stages/rollup.js` (nothing but the prompt file's presence)
- [X] T236 [US1] Standing conditions and dark hosts by code: new `src/analyze/standing.js` (`STANDING_RULES`, `splitStanding({ candidates, changes, scrapeTarget })`, `standingRecords`, `standingNotices({ records, groupSizes })`, `darkHostsOf(records)`), `src/cli/stages/agent.js` (exported `planFor`; standing candidates withheld from the session; skip reason `standing conditions only`; `projects_skipped` unchanged in shape), `src/cli/stages/rollup.js` (split every project's candidates, write `rollup/standing.json`, append the standing notices, extend the housekeeping line with the dark hosts, hand the degraded brief the non-standing candidates while the counts keep all), `src/rollup/notices.js` (`housekeepingNotice(housekeeping, darkHosts = [])`), `src/rollup/markers.js` (`Standing:` lines take the pattern marker)
- [X] T237 [US1] Reference lines out of collection, the hosted rule categorised: `src/collect/discovery.js` (`referenceLineOf(target, first)`: strip trailing `<op> <number>` terms and compare bare metric names; the panel record's `reference_line`; `isAnalysable` excludes it; `discovery.reference_line_panels` logged like breakdowns), `config/defaults/alerts.yaml` (`Sentinel Backlog >50: { category: backlog, importance: medium }`)
- [X] T238 [US1] Related items named, and the prompt sentence: `prompts/pass-first.md` (relate an item by naming the other item's metric, never this item's own; nine of one run's revisions were the model relating an item to itself), the related lines and nesting delivered by T232
- [X] T239 [US1] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md header revision 23, US1 scenario 3, US2 scenario 6, FR-009, FR-013, FR-014, FR-016, FR-017, FR-020, FR-022, FR-027, FR-075, FR-080 and the five Edge Cases; data-model.md Item `relates_to`, the Standing condition paragraph, Brief `report` and `notices`, Thread Reply, Feedback `verdict`, Cost Record, the panel record's `reference_line`, "Number matching" and "Secrets and personal data"; contracts/slack-payload.md, contracts/run-directory.md, contracts/config-files.md and contracts/agent-definition.md; quickstart.md section 14; plan.md revision 23 delta; research.md R-28 and smoke tests S-31 to S-36; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Phase 28: The report becomes the document, the standing rule stops leaking, the gate verifies arithmetic (revision 24, 2026-09-21)

**Purpose**: The first run on revision 23 posted 20 replies instead of 159 and recovered its roll-up, but 42 of 43 high
items were still the chronic backlog through its `monotonic` candidates, reference lines left discovery and not
collection, a signed decimal read as a phone number rejected three projects, and 67 of 83 sessions retried on arithmetic
the model did correctly (research.md R-29). The operator's additions: retire the brief image, make the report the
readable document (configurable links, a footer with the run's links, rounding, a redesign under the plan's design
skill) and run one programme at a time. Six deltas across US1 and US3; no new stage, no new dependency.

- [X] T240 [P] [US1] Tests first for the standing metric floor: `test/analyze/candidates.spec.js` (a backlog above zero today and yesterday raises `backlog_absolute` with `severity_floor` high as today, but the metric's `deviation` and `pct_change` candidates carry `low`/`medium` as if the backlog rule had not fired and no `monotonic` candidate is raised on it; a backlog new today keeps high on every rule and its `monotonic`; a dark host standing for the fortnight likewise sets no floor for the `up` metric's other rules), `test/analyze/standing.spec.js` (`standingRecords` carry `panel_ref`), `test/agent/prompt-assembly.spec.js` or the system-prompt test (the severity sentence says a backlog or dark host that already stood yesterday is reported by code)
- [X] T241 [P] [US1] Tests first for collection without reference lines: `test/collect/windows.spec.js` (`metricSpecs` skips a panel record with `reference_line`; a reference-line metric present only in a stored window is not queried), `test/analyze/changes.spec.js` or `test/analyze/pipeline.spec.js` (`computeChanges` ignores a stored window whose metric is not in `discovery.metrics` when the list is given)
- [X] T242 [P] [US1] Tests first for the gate: `test/verify/checks/personal_data_absent.spec.js` (`+0.2748442279996993` and `-12.5` pass; `254712345678` still fails), `test/verify/checks/numbers_match.spec.js` (`+27` passes for evidence 845 and 818; `3x` and `304%` pass for 912 against 300; `-56%` passes for a fall; a numeral no pair produces still fails; `derivedValues` exported and bounded), `test/verify/gate.spec.js` or `test/verify/checks/relates_to.spec.js` (`normaliseItems` drops a `relates_to` that names the item's own metric and the check no longer reports it; a relation to a stranger metric is still rejected)
- [X] T243 [P] [US1] Tests first for the retired image: `test/publish/payload.spec.js` (`image` is null on every payload; no `image` block even when a brief carries a stale `image` field; the report share and footer count are unchanged), `test/publish/slack.spec.js` (`publish` never calls `files.uploadV2` before the parent; the report share is the only upload; `publication.slack_file_id` is null), `test/publish/stage.spec.js` (no image path is read), `test/render/stage.spec.js` (the stage writes `report.html` only, never launches a browser, sets `brief.image` null and `brief.report` as before), `test/e2e/us1.spec.js` and `test/e2e/us3.spec.js` (no `brief.png`, one upload, no image block)
- [X] T244 [P] [US1] Tests first for the report as the document: `test/render/report.spec.js` (with `links: { mode: 'internal', grafanaUrl }` each item's header links its panel, each standing host its panel and each alert group its alert list, and the footer links the prompts, configuration and trace with the cost, run id and citation line; with `mode: 'none'` the same report has no `href`; evidence `1234.56789` renders `1234.568`, `0.0008130081300813008` renders `0.000813`, and a long decimal inside `why_now` is rounded while the stored item is untouched; an alerts section lists the groups with instance counts; the item header carries rank, severity, host and metric and a separate labelled meta line with persistence, confidence and id; the page still has no external asset, script or `{{{`), `test/config/load.spec.js` (`AGENT_WATCHDOG_REPORT_LINKS` defaults to `internal`, accepts `none`, rejects anything else with exit 78), `test/render/stage.spec.js` (the stage passes the link mode, the Grafana URL, the alert groups and the standing records to the renderer)
- [X] T245 [P] [US3] Tests first for the group filter: new `test/config/filter.spec.js` (`selectProjects(projects, flags)`: `--group` selects every project of the label, case-insensitive, exact; `--project` still selects hosts; both combine as a union; no flag returns every project; an unknown label selects nothing and is reported), `test/rollup/scope.spec.js` (`analysedHosts` honours `--group`), `test/cli/parse.spec.js` or `test/cli/run.spec.js` (`--group` is parsed, repeatable, and named in the usage text)
- [X] T246 [US1] Standing metric floor: `src/analyze/candidates.js` (the standing test of each high rule computed from the change: a backlog with a previous-day value above zero, a scrape target with previous day zero and trailing mean zero; a standing rule sets no floor and `monotonic` raises no candidate on that metric), `src/analyze/standing.js` (`standingRecords` gain `panel_ref`), `prompts/system.md` (the severity sentence)
- [X] T247 [US1] Reference lines never collected: `src/collect/windows.js` (`metricSpecs` skips `reference_line` records), `src/analyze/changes.js` and `src/cli/stages/analyze.js` (changes only for `discovery.metrics`, the scrape-target metric included)
- [X] T248 [US1] The gate verifies arithmetic: `src/verify/patterns.js` (signed `DECIMAL_PATTERN`), `src/verify/checks/numbers_match.js` (`derivedValues(allowed)`: differences, ratios and percent changes of every pair, bounded to the first 60 allowed values, matched like computed values by unit suffix), `src/verify/gate.js` (`resolveRelation` returns null for the item's own metric), `src/verify/checks/relates_to.js` (self-reference no longer a reason)
- [X] T249 [US1] Retire the image: `src/cli/stages/render.js` (write `report.html` only; `brief.image = null`; no browser), `src/publish/payload.js` (`image: null`; `withImageBlock` and `imageBlock` removed), `src/publish/slack.js` (no `uploadImage`; `slack_file_id: null` kept on the publication for the record's shape), `src/cli/stages/publish.js` (no image path), `README.md` and `smoke/render.js` wording (the smoke renders the report, not an image)
- [X] T250 [US1] The report as the document: `src/config/schema.js` (`AGENT_WATCHDOG_REPORT_LINKS`, path `publish.reportLinks`, enum `internal|none`, default `internal`), `.env.example`, `src/render/report.js` (`links` option with mode and Grafana URL; item links through `buildItemLinks`, standing links through `buildDashboardLink` from the record's `panel_ref` and the run's window, alert links through `buildAlertGroupLinks`; footer with prompts, configuration and trace links, cost, run id and the citation line; `roundForReading` on evidence, standing values and long decimals in prose; an alerts section), `src/cli/stages/render.js` (reads `rollup/alert-groups.json`, passes links and mode), `templates/report.hbs` (redesign under the minimalist and redesign variants of the plan's design skill: warm monochrome canvas, 1 px `#EAEAEA` rules instead of boxed cards, a system sans-serif stack with character, a monospace with tabular figures for metrics, identities and numbers, muted pastel severity chips, sentence case, an item header in two rows with a labelled meta line; design read and dials recorded in the template header; markers per FR-082 kept; no external asset)
- [X] T251 [US3] The group filter: new `src/config/filter.js` (`selectProjects(projects, flags)` and `filterIsActive(flags)`), used by `src/cli/stages/collect.js`, `src/cli/stages/analyze.js`, `src/cli/stages/agent.js` and `src/rollup/scope.js`; `src/cli/index.js` (`group` option, usage line); `specs/001-watchdog-slack-loop/contracts/cli.md` row already written
- [X] T252 [US1] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md header revision 24, US1 narrative, US3 scenario 5, US1 scenario 6, FR-009, FR-014, FR-015, FR-016, FR-019, FR-022, FR-023, FR-025, FR-066, FR-075, FR-082, retention wording, Key Entities, Clarifications, Edge Cases and Out of Scope; data-model.md Brief `image`, the Report paragraph, Run rows, the Standing paragraph, Item `relates_to`, "Number matching", "Secrets and personal data" and the panel record; contracts/environment.md, cli.md, run-directory.md, container.md and slack-payload.md; quickstart.md section 15; plan.md revision 24 delta; research.md R-29 and smoke tests S-37 to S-42; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Phase 29: The original design with its links, one footer, threads for what needs a person, a gate that reads what it was given (revision 25, 2026-09-21)

**Purpose**: Apply the operator's reading of the first revision-24 run (research.md R-30): the report returns to its original design keeping the links, the alerts section and the rounding; post and report share one footer that links the specification; thread replies are for high items and alert groups only; the incomplete-analysis notice names hosts and speaks plainly; and the gate stops refusing numerals the model read in tool results or in the candidates, roundings of given numerals, unit words and range literals, with the brief's gate handed the candidates. Checked counts follow the analysed set. Tests first (constitution II); tokenising and arithmetic in code (III); nothing new stored (IV).

- [X] T253 [P] [US1] Tests first for the report's return: `test/render/report.spec.js` (an item header carries `#1`, the severity chip, the host, the metric, the persistence text and the item id and never the words `rank 1`; a `confidence 85%` line follows the header on its own element; evidence windows read `previous_day` and `trailing_14d` as recorded; there is no `Items by rank` heading and no labelled meta line; the item, standing and alert links of revision 24 still render under `internal` and none under `none`; evidence notes are rounded (`stddev 3.2031234756093934` renders `3.203`); the summary keeps `id="brief-summary"`, the standing card and the alerts card; no script, external asset or triple-stash), `test/render/stage.spec.js` (the footer link expectations follow the specification link)
- [X] T254 [P] [US1] Tests first for the one footer: `test/publish/footer.spec.js` (`buildFooter` yields `specs_url` from `config.endpoints.specsUrl`; `footerText` reads `<specs_url|specs> · <config_url|configuration> · <trace_url|trace> · cost $0.12 · run 2026-09-18` and appends `N more items in the report (thread)` when given), `test/publish/payload.spec.js` (the parent's last context block is that line), `test/model/schemas.spec.js` (`Brief.footer.specs_url` required, `prompts_url` rejected), `test/config/load.spec.js` (`AGENT_WATCHDOG_SPECS_URL` required for a run, read into `endpoints.specsUrl`; `AGENT_WATCHDOG_PROMPTS_URL` is unknown), `test/links/allowlist.spec.js` or the allowlist test that exists (the specification host is allowed), `test/render/report.spec.js` (the report footer links `specs` to `specs_url`)
- [X] T255 [P] [US1] Tests first for the notice: `test/rollup/brief.spec.js` (the rejected-analysis notice reads `Analysis incomplete: no findings for 1 of 3 projects (alpha.example.org): the verification gate refused the model's analysis on every attempt, mostly for digits that looked like a phone number` for `personal_data_absent`, `a number that matched no computed value` for `numbers_match`; four rejected projects list three hosts and `and 1 more`; the degraded reason carries the same text; an unknown check name is spelt as itself)
- [X] T256 [P] [US1] Tests first for the gate: `test/verify/format.spec.js` (`extractNumbersEverywhere('[1789538400,390778880]')` yields both numbers; `1,604,078,240` stays one; `extractNumbers('up for 7.5 days and 24 hours')` yields `7.5d` and `24h`), `test/verify/checks/numbers_match.spec.js` (`390778880` written in prose passes when a tool result held `[1789538400,390778880]`; `2.48` passes for a given `2.484518611472874` and `+32.7%` for a given `32.656142204706285`, while `2.6` for a given `2.48` fails; `63.8%` passes for a computed `-63.79` percent; `7.5 days` passes for an uptime change of `645829` on a metric named `cht_date_uptime_seconds`; a bare `24h` passes when a collected expression reads `rate(x[24h])` and `36h` fails; in brief mode a bullet quoting a cited candidate's observed value passes when the candidates are given), `test/verify/checks/personal_data_absent.spec.js` (`22408192000` in `why_now` passes when the given text holds it and fails when it does not; the reason reads `phone number 254712345678 at $.items[0].why_now`), `test/verify/gate.spec.js` or `test/rollup/brief.spec.js` (`verifyBrief` receives `candidates` from the roll-up)
- [X] T257 [P] [US3] Tests first for the counts: `test/rollup/deterministic-brief.spec.js` (`checkedCounts(discovery, 4, 2)` gives `projects: 2`; without the third argument every discovered project as before; the heartbeat headline counts the analysed projects), `test/rollup/brief.spec.js` (`composeBrief({ analysedProjects: 2 })` puts `projects: 2` on the brief), `test/rollup/stage.spec.js` (a `--group` run passes the analysed count)
- [X] T258 [P] [US1] Tests first for the replies: `test/publish/payload.spec.js` (replies for the high items only, highest rank first, capped at twenty-five, none for a medium body item; alert-group replies follow; the footer count is every item without a reply; the report comment's `replied` count matches), `test/e2e/us1.spec.js` (the seeded run's replies are its high items, not its body items)
- [X] T259 [US1] The report's return: `templates/report.hbs` (the revision-23 template from `ebb97f5` with the `href` links of revision 24 on the item metric, the related items, the standing hosts and the alert groups, an alerts card in the standing card's style, the footer line and the citation line, the header `#N SEV host · metric · persistence  id` with the confidence on a `div.confidence` beneath it, no `rank N`, no `Items by rank` heading, no labels), `src/render/report.js` (the view keeps `link`, `roundProse` on evidence notes, raw window names; the design-read header comment records the return)
- [X] T260 [US1] One footer: `src/config/schema.js` (`AGENT_WATCHDOG_SPECS_URL` at `endpoints.specsUrl`, required for a run, replacing the prompts row), `src/publish/footer.js` (`specs_url`; `footerText` moves here or stays in `payload.js` with the run id and the optional count), `src/publish/payload.js` (the parent footer reads specs · configuration · trace · cost · run id · N more items), `src/model/schemas.js` (footer `specs_url`), `src/links/allowlist.js` (`specsUrl`), `templates/report.hbs` (footer `specs`), `.env.example`, `README.md`, `smoke/render.js`, `smoke/slack.js`, `scripts/replay-eval.js`, test helpers (`test/e2e/helpers.js`, `test/cli/helpers.js`, `test/verify/helpers/context.js`, `test/rollup/factories.js`)
- [X] T261 [US1] Threads for what needs a person: `src/publish/payload.js` (`replied` is the high items in rank order, at most `MAX_ITEM_REPLIES`; `furtherItems` is the rest; the layout still drives the bullets)
- [X] T262 [US1] The notice in words: `src/rollup/brief.js` (`analysisRejected` returns the hosts; `shortfalls` builds `no findings for N of M projects (hosts, then "and K more"): the verification gate refused the model's analysis on every attempt, mostly for <phrase>` with a `CHECK_PHRASES` map for every gate check name, the check name itself when unmapped; the degraded reason is the same text)
- [X] T263 [US1] The gate reads what it was given: `src/verify/format.js` (the comma rule in one place used by `extractNumbers` and `extractNumbersEverywhere`; unit words `days`/`day`/`hours`/`hour` attach `d`/`h`), `src/verify/checks/numbers_match.js` (`allowedValues` gives changes of a `_seconds` metric the unit `s`; `rangeTokens(ctx)` from every collected expression joins the exemptions; `matches` accepts a percent by magnitude; `checkText` accepts a decimal or percent token that rounds a given numeral within its own decimals), `src/verify/checks/personal_data_absent.js` (given numerals exempt, digits in the reason), `src/rollup/brief.js` (`verifyBrief({ candidates: allCandidates })`)
- [X] T264 [US3] Counts of the analysed set: `src/rollup/deterministic-brief.js` (`checkedCounts(discovery, candidatesCount, analysedProjects = null)`; the heartbeat headline uses it), `src/rollup/brief.js` (`composeBrief` and its builders take `analysedProjects`), `src/cli/stages/rollup.js` (passes `analysed ? analysed.size : null`)
- [X] T265 [US1] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md header revision 25, FR-015, FR-016, FR-019, FR-020, FR-022, FR-056, FR-066 and the two Clarifications entries; data-model.md the Report paragraph, the footer row, the notices row, "Number matching" and "Secrets and personal data"; contracts/environment.md, slack-payload.md, config-files.md and container.md; quickstart.md section 16; plan.md revision 25 delta; research.md R-30 and smoke tests S-43 to S-46; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Phase 30: The project first on every body line, written by code (revision 26, 2026-09-22)

**Purpose**: Apply research.md R-31: code writes the project in front of every body line (a programme's sub-bullets by short host, a single-project bullet by full host), the model describes the change in words without metric keys, the prompt gives the prefix and the budget, the gate counts the prefix, and a host the model wrote anyway is not doubled. Tests first (constitution II); the project name moves into code (III); nothing new stored (IV).

- [X] T266 [P] [US9] Tests first: `test/rollup/layout.spec.js` (`childPrefixes(layout, hostFor)` gives `north-a: ` and `north-b: ` for a group slot's members, `cht.north: ` and `cht.south: ` when two members share the first label, `alpha.example.org: ` for an item slot; `assembleBullets({ prefixHosts: true })` prefixes each child and item bullet and strips a host the text already starts with, in either form and any case; without the flag the texts are unchanged), `test/verify/checks/bullet_length.spec.js` (a one-line bullet's budget is 120 minus its prefix and the reason names the prefix; an item bullet's first line likewise; no layout or items leaves the limits as they were), `test/rollup/brief.spec.js` (a composed brief's group children start with `north-a: ` and `north-b: `, the prompt carries `"prefix": "north-a: "` and the budget, and a model line that repeats the host is not doubled), a test that `prompts/rollup.md` tells the model the project is written for it and to describe the change in words without metric keys
- [X] T267 [US9] `src/rollup/layout.js`: `shortHostLabel`, `childPrefixes(layoutDocument, hostFor)`, `stripLeadingHost`, and `assembleBullets({ ..., prefixHosts })`
- [X] T268 [US9] `src/rollup/brief.js` (`bulletsFromDraft` passes `prefixHosts: true`; `layoutText` lists each body item's `prefix` and `budget` and says the project is written by code) and `prompts/rollup.md` (the instruction)
- [X] T269 [US1] `src/verify/checks/bullet_length.js`: the first line's budget is 120 minus the item's prefix, computed from `ctx.layout` and `ctx.items` through `childPrefixes`; the reason names the prefix
- [X] T270 [US9] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md header revision 26, FR-015 and FR-069; data-model.md the Bullet `text` and `children` rows; contracts/slack-payload.md; quickstart.md section 17; plan.md revision 26 delta; research.md R-31 and smoke test S-47; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Phase 31: The security requirements catch up with the code (revision 27, 2026-09-22)

**Purpose**: Apply research.md R-32: the requirements say what the code does at the trust boundaries, egress and Slack scopes become requirements, the failure notice redacts the error it quotes, the duplicated scenario is renumbered and the checklist gains items for the surfaces added since it was written. Tests first for the one code change (constitution II).

- [X] T271 [P] [US1] Tests first: new `test/publish/redact.spec.js` (`redactText` replaces Slack, Anthropic and Grafana tokens, bearer strings, e-mail addresses and phone-shaped runs with `[redacted]` and leaves hosts, versions, counts and timestamps; empty input gives an empty string), `test/cli/run.spec.js` (a failure whose message quotes a token and an address posts a notice with `[redacted]` and neither value)
- [X] T272 [US1] `src/publish/redact.js` (`redactText` over `SECRET_PATTERNS`, `EMAIL_PATTERN` and `phoneMatches` from `src/verify/patterns.js`) and `src/cli/commands/run.js` (the failure notice text passes through it)
- [X] T273 [US1] Spec: header revision 27; FR-002, FR-008, FR-016, FR-024, FR-044, FR-045, FR-046, FR-054 amended; FR-083 and FR-084 added; SC-004 and the patient-data assumption amended; User Story 1 scenarios 6 and 7 renumbered 7 and 8
- [X] T274 [US1] `specs/001-watchdog-slack-loop/checklists/security.md`: CHK035 to CHK044 appended, unchecked, for the surfaces of revisions 24 to 26; `contracts/slack-payload.md` scopes row; data-model.md "Secrets and personal data"
- [X] T275 [US1] Record the revision (plan.md revision 27 delta, research.md R-32, quickstart.md section 18), then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`; the reviewer ticks the checklist, never the agent

## Phase 32: A post read in one glance, a thread of three (revision 28, 2026-09-22)

**Purpose**: Apply research.md R-33 and the four answered clarifications: the headline shown whole, two programme bullets of three project lines with alerts out of the body, one line per project covering all its items, and a thread of the report share, programme replies, one Other reply and one alerts reply. Tests first (constitution II); the layout, prefixes, counts and alerts summary are code (III); nothing new stored beyond `brief.thread` and the layout's `entries` (IV).

- [X] T276 [P] [US9] Tests first for the layout: `test/rollup/layout.spec.js` (programmes ranked by their best item, the two highest fill the body; a programme of one project is an `item` bullet, of several a `group` with at most three entries and `more_projects`; every project's items in rank order under one entry with the lead first; an ungrouped project is a unit of one for the body; programmes not in the body with two or more projects become `programme` replies, the rest one `other` reply; `entries` carry `item_ids`, `host`, `prefix`, `budget`, `where`; `thread_items` are the items no body entry covers; alerts take no slot and fill `thread_alerts`; `assembleBullets` and `assembleThread` build the body and thread bullets with the code-written prefixes and the count line), `test/rollup/rank.spec.js` (placement `body` for every item a body entry covers)
- [X] T277 [P] [US1] Tests first for the gate: `test/verify/checks/bullet_count.spec.js` (at most two slots, three entries each, exactly one bullet per body and reply entry), `test/verify/checks/thread_order.spec.js` (bullets equal the body then reply leads), `test/verify/checks/bullet_length.spec.js` (every entry line at most two lines with the first line's budget minus the entry's prefix; the headline at most two lines of 120), `test/verify/checks/numbers_match.spec.js` and `personal_data_absent.spec.js` (a bullet may quote any value of every item its entry covers, and its item texts)
- [X] T278 [P] [US1] Tests first for the payload: `test/publish/payload.spec.js` (the headline is a bold `section`, never a `header`, never truncated; the body has at most two bullet sections with the project lines and the count line; alert-derived notices leave the parent; `replies` are the programme replies, the Other reply and one alerts reply with per-programme counts and two link kinds, in that order, each with `kind`, `group`, `metadata`; the report comment counts items only; the footer counts the items outside the body), `test/publish/slack.spec.js` and `test/publish/stage.spec.js` (the replies post in order with their metadata; the stage builds the per-programme alert links from the groups' hosts), `test/model/schemas.spec.js` (`Bullet.item_ids`, `Child.item_ids`, `Brief.thread`, `ThreadReply.kind`)
- [X] T279 [P] [US1] Tests first for the roll-up: `test/rollup/brief.spec.js` (the prompt lists every entry with the items it covers, its prefix and budget, body then replies; a composed brief carries `bullets` from the slots and `thread` from the replies; an alerts-only day has no bullets and its alerts reply is the thread; the deterministic brief follows the same layout), `test/e2e/us1.spec.js`, `us8.spec.js`, `us9.spec.js`, `test/perf/fifty-projects.spec.js` (the scripted engine writes one line per entry; the thread shape), `us2.spec.js`, `us6.spec.js`, `us7.spec.js` (with no item replies, feedback on an item is a thread note citing its number or host and metric, its thumbs its verdict, FR-027), `test/cli/dry-run.spec.js`, `test/verify/gate.spec.js`, `test/rollup/rank.spec.js`, `test/rollup/deterministic-brief.spec.js`
- [X] T280 [US9] `src/rollup/layout.js` (programmes, units, entries, `buildLayout`, `toLayoutDocument`, `slotByKey`, `childPrefixes` from entries, `assembleBullets`, `assembleThread`, `replyKindOf` (a thread bullet's reply is `other` for the Other bucket, `programme` otherwise), constants `BODY_SLOTS = 2`, `MAX_PROJECTS = 3`, `OWN_REPLY_MIN_PROJECTS = 2`), `src/rollup/rank.js` (placement from the entries)
- [X] T281 [US1] `src/model/schemas.js` (`Bullet.item_ids`, `Child.item_ids`, `Brief.thread`, `ThreadReply.kind` and `group`), `src/verify/checks/bullet_count.js`, `thread_order.js`, `bullet_length.js` (entries, headline), `numbers_match.js` and `personal_data_absent.js` (covered items)
- [X] T282 [US1] `src/rollup/brief.js` (`layoutText` with slots, replies and entries; `bulletsFromDraft` returning `bullets` and `thread`; `briefFromDraft` with `thread`; `alertsOnlyBrief` with no bullets; item texts per entry), `src/rollup/deterministic-brief.js` (the same layout), `prompts/rollup.md` and `BUILT_IN_TEMPLATE` (one text per entry covering its items, two lines, the headline's limit)
- [X] T283 [US1] `src/publish/payload.js` (headline section; parent notices without the alert-derived ones; programme, Other and alerts replies; report comment; footer count), `templates/slack/programme.hbs` and `alerts.hbs` (`reply.hbs` and `alert-group.hbs` removed), `src/cli/stages/publish.js` (per-programme alert links from the groups' hosts), `src/publish/slack.js` (reply `kind` and `group` on the publication), `test/e2e/helpers.js` (the scripted engine writes one line per entry), `README.md`
- [X] T284 [US1] Record the revision, verifying rather than rewriting what /speckit-plan wrote: spec.md header revision 28, US1 scenario 3, US8 scenarios 1, 3 and 4, US9 scenarios 1 and 4, FR-010, FR-015, FR-019, FR-020, FR-066, FR-069, FR-078, FR-079, FR-080, FR-085 and the four Clarifications; data-model.md the Layout rule, Bullet, Brief `thread` and Thread Reply; contracts/slack-payload.md and run-directory.md; quickstart.md section 19; plan.md revision 28 delta; research.md R-33 and smoke test S-48; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T001 first, then T002 to T010 in parallel.
- **Foundational (Phase 2)**: Depends on Setup. Blocks every user story. T011 and T012 first (configuration is used by everything); the T013 to T024 pairs are parallel across modules, each test before its implementation.
- **User Stories (Phases 3 to 11)**: All depend on Phase 2. US1 is the MVP and should complete first because US2, US3, US4 and US5 extend its stages; US6 depends only on Phase 2 and the pattern-card hooks in US1's prompt assembly; US7 depends on US2 (feedback records) and US4 (proposals, calibration report); US9 (Phase 10) changes US1's ranking, gate and payload; US8 (Phase 11) depends on US9's groups and layout.
- **Polish (Phase 12)**: Depends on the stories being delivered; T103 to T109 are parallel, T110 and T111 last.

### User Story Dependencies

- **US1 (P1)**: Foundational only. Delivers the full daily run with the SDK engine.
- **US2 (P2)**: Extends US1's feedback stage, ranking, roll-up memory and run command. Independently testable on Slack fixtures.
- **US3 (P2)**: Extends US1's payload, run command and agent engines; adds replay and the CLI engine. Independently testable with the fake `claude` script and stored runs.
- **US4 (P3)**: Uses US1's roll-up and US2's feedback records for calibration. Independently testable on recorded days.
- **US5 (P3)**: Uses US1's discovery and brief; the readiness command is standalone.
- **US6 (P3)**: Corpus and distillation are standalone; card matching touches US1's ranking.
- **US7 (P3)**: Extends US2's feedback stage and store, US1's roll-up prompt and publish stage, and US4's proposals and calibration report. Independently testable on the Slack fixtures with a scripted classification model.
- **US9 (P2, added in spec revision 9)**: Extends US1's discovery, ranking, gate, roll-up and payload with groups, the ignore list, five slots and sub-bullets. Independently testable on the fake Grafana with grouped hosts.
- **US8 (P2, added in spec revision 9)**: Depends on US9 (groups and layout) and extends collect, analyze, roll-up, publish, the agent prompt and US2's feedback matching. Independently testable on the recorded alert day.

### Within Each User Story

- Tests are written first and fail before implementation (constitution II).
- Collect before analyze, analyze before agent, agent before roll-up, roll-up before render and publish.
- Story complete, with its end-to-end fixture test green, before the next priority.

### Parallel Opportunities

- Phase 1: T002 to T010 after T001.
- Phase 2: the module pairs T013/T014, T015/T016, T017/T018, T021/T022, T023, T024 in parallel after T012.
- US1: all test tasks T025 to T037 in parallel; then T038 to T040 (collect), T041 to T043 (analyze), T044 to T047 (agent definition and tools), T051 (verify), T052 (links), T054 (report template), T056 (Slack templates) can proceed on separate files while T048 to T050 wait for T046 and T047.
- US2 to US6: every story's test tasks in parallel, then implementations; US6 can run alongside US4 and US5.
- US7: T116 to T120 in parallel; then T121 and T122 (independent files), T123, T124, T125, T126, T127.
- US9: T128 to T133 in parallel; then T134 and T135 (policy, discovery), T136 and T137 (layout, gate), T138, T139, T140.
- US8: T141 to T147 in parallel; then T148, T149 and T150 (policy, collect, classify), T151 and T152, T153, T154, T155, T156.

---

## Parallel Example: User Story 1

```bash
# Write all User Story 1 tests together (all must fail first):
Task: "test/collect/grafana.spec.js, test/collect/discovery.spec.js, test/collect/windows.spec.js"
Task: "test/analyze/changes.spec.js, test/analyze/calendar.spec.js, test/analyze/candidates.spec.js"
Task: "test/verify/gate.spec.js and test/verify/checks/*.spec.js"
Task: "test/publish/slack.spec.js, test/render/report.spec.js, test/rollup/rank.spec.js"

# Then implement independent modules in parallel:
Task: "src/collect/grafana.js"
Task: "src/analyze/changes.js and src/analyze/baselines.js"
Task: "src/verify/gate.js and src/verify/checks/*.js"
Task: "templates/report.hbs and src/render/report.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phases 1 and 2.
2. Phase 3 (US1) with the SDK engine, one channel, the deterministic degraded path and the
   heartbeat. The feedback stage is a pass-through.
3. **STOP and VALIDATE**: `npm run replay:eval`, then `agent-watchdog run --dry-run` against the
   hosted watchdog, then one real post to `#agents`.

### Incremental Delivery

1. US1 → the daily brief exists and is trustworthy (SC-001, SC-004, SC-005 visibility).
2. US2 → feedback shapes the next day (SC-002 measurement, SC-003).
3. US3 → replay, preview, versions and the CLI engine make it steerable and reproducible (SC-006,
   SC-007, SC-011).
4. US4 and US5 → proposals, calibration, readiness, new projects (SC-008).
5. US6 → corpus distillation and pattern cards (SC-009).
6. US7 → feedback acknowledged once, permanent records, lessons as proposals (SC-012, SC-013).
7. US9 → programme groups, ignored development hosts, five bullets with sub-bullets (SC-015).
8. US8 → alerts grouped in the brief with links and durable episodes (SC-014).
9. Phase 12 → container proof, release tooling, security scan (SC-010).

### Parallel Team Strategy

With two contributors after Phase 2: one takes collect, analyze and verify; the other takes agent
definition, tools and engines; both converge on roll-up, render and publish. After US1, US2 and
US3 can proceed in parallel, then US4, US5 and US6.

---

## Notes

- Every task names its files; `test/` mirrors `src/` (`src/analyze/changes.js` →
  `test/analyze/changes.spec.js`).
- Constraints quoted from data-model.md are normative: bullet limits, identity hashes, high-severity
  rules, retention classes and enumerations are not implementation-time choices.
- Anything the model produces is untrusted until the gate accepts it; nothing under `prompts/`,
  `skill/`, `schema/`, `agent/` or the policy files is ever written by a run.
- Commit after each task or each coherent group with `type(#issue): subject`.
- T112 to T115 were added by `/speckit-analyze` remediation on 2026-09-19; their ids are allocation
  order and they execute within the phase where they sit (T112 and T113 in Phase 3, T114 and T115
  in Phase 5).
- T116 to T127 (Phase 9, User Story 7) were added with spec revision 8 on 2026-09-19; the former
  Phase 9 (Polish) is now Phase 10.
- T128 to T156 (Phase 10, User Story 9; Phase 11, User Story 8) were added with spec revision 9 on
  2026-09-19; Polish is now Phase 12. The body limits quoted in T032 and T034 (three bullets,
  ranks 1 to 3) describe what User Story 1 built; T130, T131 and T137 raise them to five bullets
  with eight sub-bullets, and the data-model.md Bullet section is normative from revision 9.
- User Story 9 decisions (2026-09-19): ignored hosts never enter `discovery.projects` (they are listed under
  `discovery.ignored` with the matching pattern), so no downstream stage had to learn to skip them and T135's
  stage changes reduced to logging; the reserved `Other` group never collapses into a group bullet; the ninth
  member of a programme goes to the thread rather than opening a second slot for the same programme; the draft
  the model returns carries one `{ item_id, text }` per body item and code assembles the Bullet entities from
  it and `rollup/layout.json`.
- User Story 8 decisions (2026-09-20): the collector reads the rules endpoint and falls back to the alerts
  endpoint alone (no rule uids, instances keyed by title) before recording `available: false`; pending, no-data
  and error instances are stored but never counted, grouped or posted; alert groups are ordered by importance
  then group and category in code-point order; alert-list links resolve offline against the collected rule
  titles and instance hosts, and a link that fails resolution rejects the draft like any other link; episodes
  are not updated when alerting was unavailable, since an absent instance then means nothing; feedback on an
  alert-group reply is tallied for the digest only; `readOutcomes` leaves `alert_episode` records out so the
  calibration report is unchanged; the fixture generator preserves the recorded gate and item expectations a
  committed `expected.json` already carries.
- Polish decisions (2026-09-20): the secret scan (`src/verify/scan.js`, `scripts/scan-secrets.js`) reuses the gate's
  patterns; a credential-shaped token shorter than 24 characters or ending in a placeholder word (`xoxb-test`) is a
  test value, lock files are skipped, and a deliberate sample in a test carries `// scan-secrets:allow` on its line;
  the repository scan looks for secrets and e-mail addresses, the run-artefact scan also for phone numbers; the
  end of every `run` scans its own artefacts and logs `run.scan_findings` (file, line, pattern, masked excerpt,
  never the value) without failing the run (constitution VI); no new run-directory file was added for it. The
  fifty-project perf spec asserts the FR-013 property per project (a session exists exactly when candidates do)
  rather than a fixed quiet count, because the fake Grafana seeds per-host noise and a few quiet mirrors cross the
  deviation rule by chance. The PR template lives at the repository root (`.github/pull_request_template.md`, the
  only place GitHub reads it) with a package-specific section. The semantic-release dry run (T108) succeeded
  against a local bare clone (README "Releasing"); it also showed the root `release.yml` releases the root package
  from the repository root, so `.github/workflows/agent-watchdog-release.yml` was added to run semantic-release
  from this directory. The container smoke exposed a committed `package-lock.json` that
  lacked the Agent SDK's peer dependencies (`@anthropic-ai/sdk` and its tree), so `npm ci` failed in the image and
  on a clean checkout, which CI would have hit too; the lock was regenerated with `npm install --package-lock-only`
  and a clean install from it verified. T111 remains open for its live part: quickstart steps 1 and 2 pass here (lint zero warnings,
  780 tests, `replay:eval` ok) and so does the credential-free part of step 10 through `smoke/container.js`
  (image builds at 1.38 GB, `--version`, `check` exit 69, S-11 render with a read-only root); steps 3 to 9 and the
  preview run of step 10 need the hosted watchdog, Slack, model and Langfuse credentials, and `main` carries no
  agent-watchdog coverage yet to compare against (CI will).
- Live preview fixes (2026-09-20, Phase 13): `$interval` resolves to the dashboard's current value (`10m` on the API
  dashboard) rather than the query step, because the dashboard author chose it and the value is in the document
  already read; `$__rate_interval` uses the watchdog's real 5-minute scrape interval (`20m`), not the data source's
  `timeInterval: 1m`, which would give a window too short for `rate()`; `$__range` is `1d` in every window because
  each window compares a day against a day; a variable with no single value (a query variable's selection, a
  multi-value list) makes the metric unavailable rather than guessed, and the panel still counts as checked; the
  fake Grafana validates only the two shapes that failed live, not full PromQL; the metric key keeps the variable
  text (`sum(rate(x[$interval]))`) as its identity, so stored runs and feedback stay comparable.
- Collection at a hundred projects (2026-09-20, Phase 14, revision 11): the comparison windows are reused only on an
  exact match of bounds, step and metric from the latest run of the earlier date (forced runs supersede plain ones);
  the ledger records the maximum of the current window's samples and is filled from a fetched trailing window only
  for days it lacks, so a recorded day is never overwritten; a trailing window is built from the ledger only with
  fourteen or more of its days present; the query timeout defaults to 30 s because Grafana's data proxy gives up at
  30 s, and a longer client timeout alone would change nothing; only timeouts and 502/503/504 count as query
  failures for the three-consecutive rule (a 400 is the query's fault, not the source's); connection failures stay
  unreachable after one retry; the fake Grafana's daily values are the day's level without jitter while the ledger
  records the maximum of jittered samples, a small upward bias accepted for the second-day tests since no
  expectation compares exact trailing numbers across days; `purge --dry-run` reports ledger entries it would compact
  in `compacted`.
- One series per project (2026-09-20, revision 12): grouping by `le` alone is not a breakdown, since the histogram
  quantile consumes it; `without` is always a breakdown; `topk`/`bottomk` are breakdowns even without `by`; a
  breakdown panel is left out of the metric list rather than collected and discarded, so it costs no query; a
  query that still answers several series (a plain selector with an unpinned label) fails only that window and
  names the differing labels, with `__name__`, `instance` and `job` never counted as differing; the aggregate
  siblings (request rate, request count, error share) remain, and the missing aggregate latency panel is a
  recommendation to cht-watchdog recorded in R-17.
- First complete hosted run (2026-09-20, Phase 15, revision 13): the committed schema files stay JSON Schema 2020-12
  as the documented contract and the engines convert a copy at the boundary, so the schema build and the contracts
  do not change; a turn that fails with a timeout error (code `TIMEOUT` or "timed out" in the message) stays a
  `timeout` bound and every other failure is an `error` bound, both with the message on the pass record; the
  degraded brief is used only when no item came out and candidates exist, otherwise the notice suffices and the
  alerts-only or heartbeat brief still names the failure; the notice keeps the first error message truncated to
  160 characters; `Message Delivery (2h)` is categorised as messaging/high and `Low Disk Space - 80% Full` under a
  new `capacity` category with no related metrics, since node exporter disk metrics are not on the dashboards; the
  phone pattern skips a match whose surrounding token carries letters, in the scan and in the gate alike; User
  Stories 10 and 11 are proposed in the spec and await approval before planning.
- User Story 10 decisions (2026-09-20): kinds are declared, not inferred from names or data, because the stock CHT
  gauges end in `_count` and one gauge ends in `_total`; a rate-wrapped counter is a gauge because the dashboard
  author derived it; `sum(counter)` keeps the counter kind since a sum of counters is a counter; a restart needs a
  fall below half the previous sample so scrape jitter never counts; `restart` has a medium floor on its own;
  `cht_messaging_outgoing_total` stays a gauge by default because its statuses mix cumulative and current counts;
  the `>= 0` display comparison is stripped from the metric key while `> 0` stays, since that one filters.
- User Story 11 decisions (2026-09-20): a pattern needs three hosts, half the programme and first occurrences within
  two days, with the programme's size from discovery and the hosts seen standing in when it is unknown; the pattern
  paragraph replaces the member lines only for the instances it covers; a dead host is one whose scrape target read
  zero for the whole current window, and only a stale alert there is housekeeping; the resolved line reads the
  durable episode record before the run appends its own events; connected users enter ranking as an order of
  magnitude so confidence still decides among peers; markers are added at render time and never stored, so
  feedback matching, replay and the gate see plain text; the image alt text stays plain for screen readers.
- Structured-output tool and run budget (2026-09-20, Phase 18): the runtime tool is approved in the hook and the
  engines rather than added to `agent/tools.json`, which stays the list of tools the model may reach for; the
  hand-off is not recorded in `tool-calls.jsonl` since replay serves recorded MCP results, not the runtime's own
  mechanics; the minimum session budget is $0.25 because a pass over a project's candidates cannot finish below
  it; the budget reserved for running sessions counts against the run budget so concurrency cannot overshoot it.

- Phase 25 decisions (2026-09-20, revision 21): the streak counts dates that were analysed, so a date with no run at
  all neither counts nor breaks it, which preserves the old behaviour across a day the watchdog did not run; the run
  that speaks for a date is chosen by its forced number read as a number, not by code point, because
  `RunDir.nextForcedId` allocates `-f10` after `-f9` and `2026-09-20-f10` sorts before `2026-09-20-f2` by code point;
  `test/rollup/rank.spec.js` needed no new case, since it already pins `persisting_days` as one more than the count it
  is given and 1 with no history, and the unit lives entirely in `src/rollup/history.js`; the two pre-existing history
  tests passed unchanged because each used one run per date, which is exactly why the defect survived to a forced
  re-run. Adjacent and deliberately NOT fixed, for an explicit follow-up: `previousRunIds` orders by code point, so
  once a date has ten or more forced re-runs its "most recent first" is wrong (`-f9` before `-f10`), which would give
  `previousDiscoveryFor`, `previousClassified` and `previousHostsFor` the second-newest run; 2026-09-19 already
  carries `-f8`, so this is reachable, and it is a separate change with its own tests and three affected callers.
- Phase 26 decisions (2026-09-21, revision 22): the gate exempts the run's own identifiers by removing them from the
  prose before its numbers are extracted, not by exempting their numerals everywhere: a collected expression written
  out and a reference to a collected panel ("panel 34") are stripped, so `24` inside such an expression passes while
  a bare `24` elsewhere is still a figure to justify, and a panel id the run did not collect stays a number; window
  numerals (`14`, `14d`) alone are exempt everywhere, since the spec names the bare numeral an identifier. The phone
  check compares each nine-plus digit run, as an integer, with the same allowed values the number check uses for the
  item the walked path belongs to (`$.items[i]` in findings, the bullet's item in a brief); outside an item nothing is
  exempt. `passes.json` records a rejected pass with its `gate` verdict, so the roll-up needs no new field; the file
  has no top-level `items`, so `analysisRecord` now reads items from the pass records, which also corrects the
  pre-existing incomplete-analysis test for a bound hit after a pass produced items (it had only ever seen fixtures
  with a top-level `items`). Adjacent and deliberately NOT changed: the pass-loop skip condition that lets a fully
  rejected first pass fall through to a review pass (research.md R-27); `previousRunIds` code-point ordering (Phase
  25 note); and the retry count.
- Phase 27 decisions (2026-09-21, revision 23): replies are selected by the layout's `body_items`, so the payload
  builder takes the layout rather than re-deriving placement; the cap of twenty-five is a code constant beside the
  fifty alert instances. The report is shared into the thread with `files.uploadV2` given `channel_id` and `thread_ts`
  because a private upload's permalink is readable by the bot alone (research.md R-28). The gate's given-text
  exemption is scoped: a session's prompts and tool results for findings, an item's own prompt entry plus the run-wide
  counts for a brief bullet, since every small integer appears somewhere in 150 items' JSON. The roll-up keeps every
  unnamed bullet's previous text when it merges a retry, whatever the model returned for it, so a retry can only mend.
  A standing condition is derived from fields the candidate and its change already carry and is never stored on the
  candidate; `rollup/standing.json` exists so the render stage need not re-derive it. A reference line is decided by
  comparing bare metric names after stripping trailing constant terms, on the panel's own targets, so the rule needs
  no list of expressions. Adjacent and deliberately NOT changed: the five-slot layout for related items (revision 20);
  the clock-skew gauge's kind (FR-076; `metricKind` cannot name an expression yet); the pass-loop skip condition and
  `previousRunIds` ordering (Phases 25 and 26).
- Phase 28 decisions (2026-09-21, revision 24): a standing rule is decided inside `computeCandidates` from the change it
  already has (previous-day value, trailing mean), so the floor and the withheld `monotonic` follow from one place and
  `splitStanding` keeps withholding the standing candidate itself; nothing new is stored on a candidate. Derived values
  are verified by code over pairs of the values an item may quote, bounded to sixty values, because forbidding the
  model's subtraction cost 67 retries in one run and every refused numeral was correct. The image is retired rather
  than made optional: an optional artefact nobody opens is still rendered, uploaded and retained. Report links are one
  setting with two modes, not a per-link policy, because the reader either has the hosted watchdog or does not. The
  group filter lives in one helper so the four stages and the scope cannot disagree. Adjacent and deliberately NOT
  changed: the backlog rule's threshold (research.md R-29 sketches the reference-line threshold); Chromium in the
  container; FR-082's markers in the report; the wording of items; a per-programme channel.

## Phase 33: Feedback read as one conversation, a digest that shows where it acted (revision 29, 2026-09-23)

**Purpose**: Implement FR-085 as research.md R-34 decides: the horizon applied to an item is the last one its thread states, the notes of one item are reviewed together as the clarified whole, and the digest says per item how the feedback was used, quoting the exact lines from the project's prompt with the run's trace link or naming the suppression it caused. Tests first (constitution II); the sequence rule and the provenance reader are code (III); nothing new stored beyond `provenance` on the digest's items and `observation_id` on the session record's calls (IV).

- [X] T285 [P] [US2] Tests first for the sequence rule and the ingester: `test/feedback/sequence.spec.js` (thread order by run date then `source_ts`; the last stated horizon and expected maximum win; a later note without a date keeps the earlier horizon; authors counted; empty input gives nulls), `test/feedback/ingest.spec.js` (two new notes on one item in one thread give one `horizons` entry with the corrected date and `author_count` 2 while each record keeps its own `horizon`; `by_item[].horizon` is the thread's last statement; a stored earlier note with a longer horizon is not pushed once a later stored note corrected it; a dateless note reaches the model with the earlier notes of its thread as untrusted context), `test/feedback/parse-notes.spec.js` (`earlierNotes` in the model prompt, each wrapped; the deterministic path ignores them)
- [X] T286 [P] [US7] Tests first for the review: `test/feedback/review.spec.js` (the unreviewed notes of one item are one call with every note wrapped in thread order and numbered; every record of the thread gets the classification and the one proposal id; the proposal's evidence and source line name every note; a note matched to no item is one call of its own; the prompt file's `## Notes` section)
- [X] T287 [P] [US7] Tests first for the provenance and the digest: `test/publish/provenance.spec.js` (the item's records' `kind`, `verdict`, `note` and `horizon` lines quoted exactly from the feedback block of `<slug>/prompt.pass1.md`, each present in the file, with the counts; nothing quoted when the file or the block is missing; the suppression read from `<slug>/suppressed.json`; the trace link from `run.json` with the pass-1 generation's observation id from `session.json` when there is one), `test/publish/digest.spec.js` (per item the provenance line in text and blocks: quoted lines with the trace link, the suppression, or "not used today"; `provenance` on the entity; proposals listed once when notes share one), `test/publish/stage.spec.js` (the stage reads the prompt, the suppression, the run record and the session record and hands the digest each item's provenance), `test/agent/session-loop.spec.js` (`observation_id` per call from the tracer's generation, null when the tracer gives none), `test/e2e/us7.spec.js` (scenario 8: a corrected horizon suppresses until the corrected date only, the thread is one review call with one proposal, the digest quotes the analysed project's prompt lines with the trace link and names the suppression for the project held back), `test/e2e/helpers.js` (the scripted reviewer reads every note of a thread)
- [X] T288 [US2] `src/feedback/sequence.js` (`threadOrder`, `clarifiedWhole`), `src/feedback/ingest.js` (notes grouped by item in thread order; one horizon per item thread, the clarified whole; `by_item[].horizon` and the stored-note horizons by the same rule; earlier notes handed to the parser), `src/feedback/parse-notes.js` and `prompts/feedback-parse.md` (`earlierNotes` as untrusted context and the rule to read the note as a clarification)
- [X] T289 [US7] `src/feedback/review.js` and `prompts/feedback-review.md` (one call per item thread under `## Notes`; the classification and proposal shared; evidence and source line per note)
- [X] T290 [US7] `src/publish/provenance.js` (`provenanceFor`), `src/publish/digest.js` and `templates/slack/feedback-digest.hbs` (the provenance line and quoted lines per item, proposals once), `src/cli/stages/publish.js` (provenance per digest item from the run directory), `src/agent/session-loop.js` (`observation_id` on each call)
- [X] T291 [US7] Placeholders only in every tracked file: the remaining real programme names and hosts in `.env.example`, `specs/001-watchdog-slack-loop/research.md`, `spec.md`, `plan.md`, `data-model.md`, `test/rollup/scope.spec.js`, `test/rollup/layout.spec.js`, `test/collect/alerts.spec.js`, `test/config/policy.spec.js`, `test/alerts/episodes.spec.js` and `test/corpus/scrub.spec.js` replaced, the checklist untouched
- [X] T292 [US7] Record the revision: spec.md header revision 29, FR-029, FR-061, FR-062, FR-085 and User Story 7 scenario 8; data-model.md the Feedback Digest `items` and `proposals` rows, the Feedback `horizon`, `classification` and `proposal_id` rows and the thread-order paragraph; contracts/slack-payload.md and run-directory.md; quickstart.md section 20; plan.md revision 29 delta; research.md R-34 and smoke test S-49; README; then run lint, tests, coverage, `npm run replay:eval` and `node scripts/scan-secrets.js`

## Phase 34: The container locked down, and egress the package can name and refuse (revision 30, 2026-09-23)

**Purpose**: Implement FR-086 and the enforcement of FR-083 as research.md R-35 decides: the image without a browser, hardened and checked under the platform's constraints; the egress allow-list built by code, printed for the platform's policy and enforced in process for every `fetch` of a run; reference manifests kept in step with the requirements and the list by tests. Tests first (constitution II); the list and the guard are code (III); nothing new stored (IV); no new dependency, one removed (I).

- [X] T293 [P] [US3] Tests first for egress: `test/net/egress.spec.js` (the fixed destinations and the configured endpoints once each with host, port, purposes and sources, sorted; an endpoint with a port kept; unset endpoints left out; `isEgressAllowed` by host and port, case-insensitive, refusing another port, another host and a non-URL; `guardFetch` calling through with the same arguments for a string, a URL and a Request-like object and refusing before the call with an `ExitError` of code 69 naming host and port, the log carrying host and port and never the path; `installEgressGuard` replacing and restoring the global `fetch`, idempotent; `egressDocument` with `inbound: none`, the exempt command and no secret), `test/cli/egress.spec.js` (JSON from the effective configuration without secrets, the fixed destinations alone without endpoints, `--format hosts`, an unknown format as usage error), `test/cli/parse.spec.js` (the command and its usage line), `test/cli/run.spec.js` (a stage's request outside the list fails the run with 69 naming host and port, the URL nowhere in the log, an allowed request passing through, `fetch` restored after the run)
- [X] T294 [P] [US3] Tests first for the image and the manifests: `test/container/dockerfile.spec.js` (two stages from the pinned base, `npm ci --omit=dev --ignore-scripts`, no browser and no package manager at run time, the baked environment, the fixed user, `/data` owned by it, no `EXPOSE`, the entrypoint, only the runtime files copied, the OCI labels from build arguments, `.dockerignore` excluding tests, specs, secrets, data and the manifests, no `playwright-core` dependency, no `src/render/browser.js`), `test/container/deploy.spec.js` (the CronJob's security context, mounts, limits, concurrency and deadline; the egress policies: default deny with DNS, and FQDNs equal to `buildEgress` of the manifest's configuration on 443; placeholders only)
- [X] T295 [US3] `src/net/egress.js` (`FIXED_ENDPOINTS`, `CONFIGURED_ENDPOINTS`, `originOf`, `buildEgress`, `isEgressAllowed`, `EgressRefusedError`, `guardFetch`, `installEgressGuard`, `egressDocument`), `src/cli/commands/egress.js`, `src/cli/index.js` (the command, `--format`, the usage line), `src/cli/commands/run.js` (the guard installed for the run, the stages' `fetch` guarded, restored in `finally`), `src/agent/engine-sdk.js` and `engine-cli.js` (the runtime's configuration directory created under `/tmp` at start)
- [X] T296 [US3] The browser leaves: `src/render/browser.js`, `test/render/browser.spec.js`, the `--png` path of `smoke/render.js`, the fake launcher of `test/e2e/helpers.js` and `test/render/stage.spec.js`, `AGENT_WATCHDOG_CHROMIUM_PATH` in `src/config/schema.js`, `.env.example` and the contracts, `playwright-core` in `package.json` and `package-lock.json`
- [X] T297 [US3] `Dockerfile` (two stages, `--ignore-scripts`, no browser, `HOME` and `TMPDIR` under the writable paths, the fixed user owning `/data`, OCI labels from `VERSION` and `REVISION` build arguments), `.dockerignore`, `release.config.js` (the build arguments), `.github/workflows/agent-watchdog.yml` (the built image loaded and `smoke/container.js` run against it), `smoke/container.js` (the checks under `--read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001`, and `--network none` where no network is needed)
- [X] T298 [US3] `deploy/README.md`, `deploy/cronjob.example.yaml` (ConfigMap and CronJob), `deploy/networkpolicy.example.yaml` (default-deny egress with DNS, Cilium FQDN policy), placeholders only, reference for `medic-infrastructure`
- [X] T299 [US3] Checklist items CHK045 to CHK050 appended for the reviewer (markers untouched)
- [X] T300 [US3] Record the revision: spec.md header revision 30, FR-083, FR-086, SC-017, User Story 3 scenario 8 and the Dependencies; plan.md the security row, the dependency table and the revision 30 delta; research.md R-35 and smoke tests S-11, S-50, S-51; contracts/container.md, environment.md, cli.md and exit-codes.md; quickstart.md section 21; README and AGENTS; then run lint, tests, coverage, `npm run replay:eval`, `node scripts/scan-secrets.js` and `smoke/container.js` where Docker is available

## Phase 35: The same container on a contributor's machine (revision 31, 2026-09-23)

**Purpose**: A local Compose setup that runs the image as the CronJob does (research.md R-36, FR-086), previewing by default, with the operator's own `.env` and policy files and nothing secret in the repository.

- [X] T301 [P] [US3] Tests first: `test/container/compose.spec.js` (the build with its arguments, the hardened service settings, the named data volume and the read-only policy mount, the limits, `.env` as the only source of secrets with the container paths pinned, the preview default, the `offline` profile with no network, the file kept out of the image)
- [X] T302 [US3] `compose.yaml` (the anchored service, the `offline` profile, the named volume), `.dockerignore`
- [X] T303 [US3] One `.env` for both readers: `test/config/env-example.spec.js` (comments on their own lines, every schema variable named and nothing else), `.env.example` reformatted, the format stated in contracts/environment.md
- [X] T304 [US3] Record the revision: spec.md header revision 31 and FR-086; contracts/container.md; quickstart.md section 22; README; plan.md revision 31 delta; research.md R-36; verified with `docker compose config`, `build`, `--version`, `egress`, `check` (exit 69), the `offline` profile and a preview `purge` stage against the named volume

## Phase 36: A contributor's own Claude login in the local container (revision 32, 2026-09-23)

**Purpose**: Run the local container on a Claude subscription for individual use (research.md R-37, FR-050, FR-086): the Agent SDK's Claude Code binary on PATH as `claude`, a login volume every service mounts, a `login` profile, and the `offline` profile's example corrected.

- [X] T305 [P] [US3] Tests first: `test/container/compose.spec.js` (the login volume on every service with `CLAUDE_CONFIG_DIR` inside it, the `login` profile with a TTY, the `claude auth login` entrypoint and the same hardening, the volume never a bind mount, the `offline` command a stage that needs no network and no `replay` example), `test/container/dockerfile.spec.js` (the `test -x` and the symlink of the SDK's binary, no second runtime installed, the home created for the volume), `smoke/container.js` (`claude --version` answers as the bundled runtime)
- [X] T306 [US3] `Dockerfile` (the symlink and the home), `compose.yaml` (the `login` volume and profile, `CLAUDE_CONFIG_DIR`, the corrected `offline` service and header), verified with a rebuilt image: `claude --version`, `auth status` in the login service writing only into the volume, `auth login --help`
- [X] T307 [US3] Record the revision: spec.md header revision 32 and FR-086; contracts/container.md (individual use on a subscription; the offline profile said right), environment.md, agent-definition.md; quickstart.md sections 22 and 23; README; plan.md revision 32 delta and the revision 31 correction; research.md R-37 and smoke test S-52; checklist item CHK051 appended for the reviewer

## Phase 37: The gate holds the whole surface (revision 33, 2026-09-24)

**Purpose**: Answer the review's gate and trust-boundary findings (research.md R-38: #42, #2, #23, #55, #35, #46, #7, #34, #3) so everything the model writes is checked and nothing it wrote reaches the network or the store unchecked.

- [X] T308 [P] [US3] Tests first, the gate: `test/verify/checks/numbers_match.spec.js` (an evidence value that matches no computed or collected value of its window is refused naming `items[i].evidence[j]`; a prose numeral that only an invented evidence entry would explain is refused; the headline is checked against every item's values and the notice against its given text; both refuse an uncomputed numeral), `bullet_length.spec.js` (a URL or three lines in the headline or the notice), `projects_known.spec.js` (an undiscovered host in the notice), `personal_data_absent.spec.js` (a Slack mention or bare user id anywhere on the surface; a hex item id is not one), `dates_match.spec.js` rewritten (prose dates in `why_now`, `suggested_check`, bullets, headline and notice against the run's windows; day-month forms resolved; given dates exempt; the unreachable evidence branch gone)
- [X] T309 [P] [US3] Tests first, the boundaries: `test/verify/gate.spec.js` (the resolver never receives a model URL off the allow-list or unseen in a tool result; code-built links and the alert links always; brief mode resolves the accepted items' allow-listed links), `test/links/resolve.spec.js` (an egress refusal is rethrown), `test/net/egress.spec.js` (a redirect to an unlisted host is refused after the first hop; a listed one is followed with the right method; a caller's `redirect: 'manual'` is honoured; a hop cap; `withEgressGuard`), `test/cli/{tools-server,calibrate,distill,replay}.spec.js` (the guard is installed while the command runs), `test/agent/prompt-assembly.spec.js` and `test/feedback/parse-notes.spec.js` (mentions and bare ids masked before wrapping), `test/rollup/stage.spec.js` (the notice from window objects in a full and a stage-only run; the memory update masked and logged), `test/collect/grafana.spec.js` (422, 500 and 400 count as consecutive failures; a success resets)
- [X] T310 [US3] `src/verify/checks/numbers_match.js` (evidence rule, headline and notice), `bullet_length.js`, `projects_known.js`, `personal_data_absent.js` (Slack ids), `dates_match.js` (prose dates), `src/rollup/brief.js` (the code notice in `givenText`)
- [X] T311 [US3] `src/verify/gate.js` (`resolveAll` order), `src/links/resolve.js` (refusal propagates), `src/net/egress.js` (redirects, `withEgressGuard`), the four commands guarded, `src/agent/prompt-assembly.js` and `src/feedback/parse-notes.js` (masking), `src/cli/stages/rollup.js` (notice from window objects; memory masked), `src/cli/commands/run.js` (`activeWindowsFrom` removed), `src/collect/grafana.js` (the counter)
- [X] T312 [US3] Record the revision: spec.md header revision 33, FR-016, FR-029, FR-044, FR-073, FR-083, US3 scenario 9, US4 scenario 6; data-model.md (number and date matching); contracts/container.md (the guard on redirects and in every command); README and AGENTS.md gate lines; quickstart.md section 24; plan.md revision 33 delta; research.md R-38 and S-53; checklist items CHK052 to CHK055 appended for the reviewer; the full gate green

## Phase 38: The brief says what happened (revision 34, 2026-09-24)

**Purpose**: Answer the review's truthfulness findings (research.md R-38: #1, #6, #9, #22, #58, #20, #15, #27, #49, #10, #11, #18, #13, #19, #25, #0, #5, #16, #14, #4, #8, #56, #37, #12, #28, #32, #50) so nothing the run publishes or records reads quieter, cheaper or more certain than the run was.

- [X] T313 [P] [US1] Tests first, the analysis: `test/rollup/analysis.spec.js` (the timeout bound is a shortfall), `deterministic-brief.spec.js` and `payload.spec.js` (the heartbeat names assessed candidates), `brief.spec.js` (the degraded notice counts its drafts), `rollup/stage.spec.js` (items from the last accepted pass; a rejected later pass drops nothing), `agent/session-loop.spec.js` (an unopened session is an error bound; the prompt's date is the run's; a killed or timed-out turn is charged its remaining grant and marked estimated), `cli/run.spec.js` (feedback calls in the cost; a stage-only roll-up reads the agent's spend; the resolver exists for a stage-only roll-up), `verify/checks/metrics_known.spec.js` (one item per identity)
- [X] T314 [P] [US2] Tests first, the feedback: `feedback/ingest.spec.js` (the record carries `expected_max`, `observed_value` and `horizon_source`; a stored horizon keeps its size; the horizon resolves against the note's own date; a failed model parse is logged and retried next run; a re-added reaction counts again), `publish/digest.spec.js` and `publish/stage.spec.js` (unclassified notes stay unacknowledged until the third attempt), `corpus/outcomes.spec.js` and `cli/run.spec.js` (outcomes for this run's fresh records only)
- [X] T315 [P] [US1] Tests first, collection and tools: `analyze/standing.spec.js` (yesterday from the change), `collect/query-window.spec.js` (several series refused; the unit; the active window), `agent/tools/watchdog-tools.spec.js` (a loose key resolved, an ambiguous one refused), `cli/tools-server.spec.js` (merged cards served; the active window), `collect/discovery.spec.js` (one host's failed query), `collect/concurrency.spec.js` (no new item after a failure), `verify/tool-urls.spec.js` and `agent/session-loop.spec.js` (URLs from text leaves of a structured tool result)
- [X] T316 [P] [US1] Tests first, publish and render: `publish/payload.spec.js` (the alerts reply fitted line by line, links whole), `render/report.spec.js` (a two-level relation chain rendered), `publish/slack.spec.js` and `publish/stage.spec.js` (the partial publication record after the parent; a stage-only publish refuses a second parent), `calibration/report.spec.js` (one run per date)
- [X] T317 [US1] The code: `src/rollup/analysis.js`, `deterministic-brief.js`, `brief.js`, `src/cli/stages/{rollup,agent,publish,feedback}.js`, `src/cli/commands/{run,replay}.js`, `src/agent/session-loop.js`, `src/verify/checks/metrics_known.js`, `src/feedback/{ingest,parse-notes,store}.js`, `src/model/schemas.js`, `src/publish/{digest,payload,slack}.js`, `src/corpus/outcomes.js`, `src/analyze/standing.js`, `src/collect/{query-window,discovery,concurrency}.js`, `src/agent/tools/watchdog-tools.js`, `src/cli/commands/tools-server.js`, `src/verify/tool-urls.js`, `src/render/report.js`, `src/calibration/report.js`, `src/rollup/history.js`, `templates/slack/alerts.hbs`, `templates/report.hbs`
- [X] T318 [US1] Record the revision: spec.md header revision 34 and the requirements named in the plan delta; data-model.md (Feedback fields, passes, publication); contracts/run-directory.md and cli.md; quickstart.md section 25; README and AGENTS.md; plan.md revision 34 delta; the full gate green

## Phase 39: The hygiene before the pull request (revision 35, 2026-09-24)

**Purpose**: Answer the review's hygiene findings (research.md R-38: #38, #40, #21, #52, #41, #53, #61, #17, #26, #29, #30, #31, #33, #51) so the pull request presents an image that builds on either architecture and names its version, a CLI that refuses what is not its own, records that name what produced them, and no dead code or stale text.

- [X] T319 [P] [US3] Tests first: `test/container/dockerfile.spec.js` (the runtime package chosen by architecture; version and revision in the environment), `test/store/versions.spec.js` and `test/cli/parse.spec.js` (the image's version and revision win over the development defaults; `--version` says so; `--log-level` and `--log-format` apply and a bad value is a usage error; a flag foreign to a command is refused with 64, `replay --stage` first), `test/agent/engine-cli.spec.js` (the runtime directory is created), `test/store/retention.spec.js` (replay directories purged like runs), `test/cli/run.spec.js` (a bad `--stage`, `--date` or `--since` exits 64 before any run directory exists), `test/cli/{distill,calibrate,replay}.spec.js` (a rejected trace flush is logged, the result printed, the exit code kept), `test/cli/check.spec.js` (`http://` refused in words), `test/model/schemas.spec.js` (the caps), `test/scripts/commitlint.spec.js` (the header pattern with `!`)
- [X] T320 [US3] `Dockerfile`, `src/store/versions.js`, `src/cli/index.js`, `src/agent/engine-cli.js`, `src/store/retention.js`, `src/cli/commands/{run,distill,calibrate,replay,check}.js`, `src/model/schemas.js`, `src/agent/output-schema.js` and `schema/brief.schema.json` rebuilt, `commitlint.config.js`, the misplaced and stale comments (`gate.js`, `session-loop.js`, `scan.js`, `slack.js`, `deterministic-brief.js`, `output-schema.js`), the dead code removed (`src/trace/cost.js`, `fileIdOf`, `toLayoutDocument`, `materialize`, `readByItem`, `readAlertEpisodes`) with their tests
- [X] T321 [US3] Record the revision: spec.md header revision 35, FR-039, FR-040, FR-043, FR-048, FR-049, FR-083, FR-086; contracts cli.md, exit-codes.md, environment.md, container.md; deploy/README.md and the policy's comment; AGENTS.md layout and alerts paragraphs; quickstart.md section 26; README; plan.md revision 35 delta; research.md R-40 with the commit-history decision left to the operator; the full gate green

## Phase 40: The re-review answered (revision 36, 2026-09-25)

**Purpose**: Answer the second review (research.md R-41): mask notes on every path to a prompt, undo the four rules revision 33 tightened too far, strip credentials on a cross-origin redirect, and close the partial fixes and small items.

- [X] T322 [P] [US2] Tests first, masking: `test/corpus/scrub.spec.js` (`maskNote`, `maskPersonalData` keeping numbers, dates and owner words), `test/agent/prompt-assembly.spec.js` (phones and e-mails masked in the feedback block), `test/rollup/brief.spec.js` (the roll-up's feedback text and unmatched notes carry no id, author, phone or e-mail), `test/cli/agent-history.spec.js` (the history tool's notes masked), `test/corpus/outcomes.spec.js` and `test/cli/distill.spec.js` (outcome notes masked on write and on read), `test/rollup/stage.spec.js` (memory masking keeps a byte count, a decimal, a date range and an owner's word)
- [X] T323 [P] [US1] Tests first, the loosened rules: `test/collect/grafana.spec.js` (a 4xx or 500 neither counts nor resets), `test/collect/windows.spec.js` (one panel answering 422 leaves its windows unavailable and the run alive), `test/rollup/notices.spec.js` and `test/rollup/stage.spec.js` (the collection notice), `test/verify/checks/dates_match.spec.js` (yearless dates, timestamps, the extra given text, the previous cycle), `test/verify/checks/numbers_match.spec.js` (day-month phrases, verified evidence quotable, evidence per window), `test/rollup/stage.spec.js` (the notice wrapped), `test/links/resolve.spec.js` and `test/verify/gate.spec.js` (a destination outside the egress list is not requested and fails no run), `test/collect/query-window.spec.js` (the single-series fallback)
- [X] T324 [P] [US3] Tests first, the redirect and the rest: `test/net/egress.spec.js` (credentials stripped cross-origin, kept same-origin, a downgrade refused), `test/publish/slack.spec.js` and `test/publish/stage.spec.js` (the heartbeat's early record, the record before its permalink, the guard before any write), `test/feedback/ingest.spec.js` (retraction ids per verdict; the review-attempt counter), `test/cli/run.spec.js` (out-of-range dates, an empty stage, the stage-only spend with feedback calls, the outcomes test that can fail), `test/cli/parse.spec.js` (`--engine` for distill and calibrate), `test/scripts/commitlint.spec.js` (the release analyzer reads `!`), `test/cli/tools-server.spec.js` (a malformed card), `test/rollup/analysis.spec.js` and `test/rollup/brief.spec.js` ("up to" for an estimated spend), `test/publish/payload.spec.js` (an oversized programme link dropped before the notices), `test/cli/replay.spec.js` and `test/cli/egress.spec.js` (the image's version), `test/publish/digest.spec.js` (a digest for a note awaiting its review), `test/agent/tools/watchdog-tools.spec.js` (errors echo no argument), `test/model/schemas.spec.js` (the derived cap)
- [X] T325 [US1] The code: `src/corpus/{scrub,outcomes,distill}.js`, `src/agent/prompt-assembly.js`, `src/rollup/{brief,analysis,notices,history,layout}.js`, `src/cli/stages/{agent,rollup,publish,collect,feedback}.js`, `src/collect/{grafana,windows,query-window}.js`, `src/verify/checks/{dates_match,numbers_match}.js`, `src/verify/{gate,tool-urls}.js`, `src/links/resolve.js`, `src/net/egress.js`, `src/publish/{slack,payload,digest}.js`, `src/feedback/{ingest,parse-notes,review}.js`, `src/cli/commands/{run,replay,egress,tools-server,distill,calibrate}.js`, `src/cli/index.js`, `src/agent/session-loop.js`, `src/agent/tools/watchdog-tools.js`, `src/model/schemas.js`, `src/agent/output-schema.js` and `schema/brief.schema.json` rebuilt, `src/trace/langfuse.js`, `src/analyze/calendar.js`, `src/store/versions.js`, `release.config.js`, `commitlint.config.js`, `templates/slack/alerts.hbs`
- [X] T326 [US3] Record the revision: spec.md header revision 36 and the requirements named in the plan delta; data-model.md (evidence per window, the caps, the cost row, the notice); contracts cli.md, container.md, environment.md, run-directory.md, slack-payload.md; the contracts' stale schema copies removed and README pointed at `schema/`; AGENTS.md; quickstart.md section 27; plan.md revision 36 delta and the corrected revision 35 wording; research.md R-41; checklist items CHK056 and CHK057 appended for the reviewer; the full gate green; then the message-only rewrite of the eighteen earlier commits and a commitlint pass over the whole branch

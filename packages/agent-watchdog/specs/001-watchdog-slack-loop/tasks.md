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

- [ ] T001 Create the package skeleton: `package.json` (`"type": "commonjs"`, `"private": true`, `engines.node ">=22.15.0"`, `bin.agent-watchdog` → `bin/agent-watchdog.js`, `license AGPL-3.0`), `.nvmrc` containing `22`, `LICENSE` (AGPL-3.0), and empty directories `bin/`, `src/{cli,cli/commands,cli/stages,config,log,store,model,collect,analyze,feedback,agent,agent/tools,verify,verify/checks,rollup,links,render,publish,corpus,calibration,trace,readiness}/`, `test/` mirroring `src/`, `test/fixtures/`, `agent/`, `prompts/`, `skill/cht-watchdog/{references,pattern-cards}/`, `schema/`, `templates/slack/`, `config/defaults/`, `smoke/`, `scripts/`
- [ ] T002 Add runtime dependencies to `package.json` with a one-line justification comment per dependency in `README.md` "Dependencies": `@anthropic-ai/claude-agent-sdk` ^0.3, `@slack/web-api` ^8, `zod` ^4, `handlebars` ^4.7, `playwright-core` ^1.63, `yaml` ^2, `@modelcontextprotocol/sdk` ^1.29, `@langfuse/tracing` ^5, `@langfuse/otel` ^5, `@langfuse/client` ^5, `@opentelemetry/sdk-node` (research.md R-1, R-8)
- [ ] T003 [P] Add dev dependencies and tooling matching cht-core (research.md R-9): `eslint` ^9, `@eslint/eslintrc`, `@medic/eslint-config` ^1.2 wired through `FlatCompat` in `eslint.config.js`; `mocha` ^11 with `.mocharc.yml` (`spec: test/**/*.spec.js`, `require: test/setup.js`); `chai` ^4.5, `chai-as-promised` ^7.1, `sinon` ^21, `sinon-chai` ^3.7; `nyc` ^17 with `.nycrc` (`check-coverage: true`, reporters text and lcov); npm scripts `lint`, `test`, `test:coverage`, `replay:eval`, `schema:build`, `smoke:*`
- [ ] T004 [P] Add `commitlint.config.js` extending `@commitlint/config-conventional` with a header parser that accepts both `type(#issue): subject` and `type: subject` and restricts `type` to `build feat fix perf refactor test chore docs` (constitution I)
- [ ] T005 [P] Add `release.config.js` for semantic-release: `tagFormat: 'agent-watchdog-v${version}'`, plugins commit-analyzer, release-notes-generator, changelog, git, github, `@semantic-release/exec` building and pushing the image tagged with the released version, and `semantic-release-monorepo` for path scoping (research.md R-12)
- [ ] T006 [P] Write `Dockerfile` and `.dockerignore` per `contracts/container.md`: base `node:22-bookworm-slim`, `npm ci --omit=dev`, `npx playwright-core install --with-deps chromium-headless-shell` into `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, user `10001:10001`, baked `ENV` (`NODE_ENV`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`, `TMPDIR=/tmp`), OCI labels, entrypoint `node bin/agent-watchdog.js`
- [ ] T007 [P] Add CI workflow `.github/workflows/agent-watchdog.yml` filtered on `packages/agent-watchdog/**`: jobs `lint` (zero warnings), `test` (nyc, coverage compared with `main`), `audit` (`npm audit --audit-level=high`), `commitlint` on the PR range, `replay-eval` when `prompts/`, `skill/`, `schema/` or `src/analyze/` change, `docker-build`; plus `.github/dependabot.yml` entry for `/packages/agent-watchdog` (constitution Security Requirements, Quality Gates)
- [ ] T008 [P] Write policy defaults per `contracts/config-files.md`: `config/defaults/thresholds.yaml` (pct_change_vs_previous_day 50, deviation_sigma_vs_trailing 2.5, monotonic_rise_hours 6, trailing_days 14, high rules for `up{job="cht"}` down, `cht_outbound_push_backlog_count` > 0, `cht_sentinel_backlog_count` > 3 × baseline), `config/defaults/dashboards.yaml` (uids `oa2OfL-Vk`, `hkQUbyfVk`, `3J_78b6Zz`, `d4f05050-804e-4ea4-9642-4d088cc39a1b`), `config/defaults/projects.yaml` (`defaults.expected_load_windows` month-end example)
- [ ] T009 [P] Write initial `README.md` (purpose, quickstart pointer, contracts index, dependency justifications) and `AGENTS.md` (operational quick reference that mirrors `.specify/memory/constitution.md` and names the stage modules, commands and exit codes)
- [ ] T010 [P] Create `test/setup.js` (chai plugins, sinon sandbox restore, a global `fetch` guard that throws unless a test opts in) and `test/helpers/fixtures.js` (load JSON fixtures, create a temporary data directory, fake clock)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Configuration, logging, storage, identity, CLI dispatch, tracing and output schemas that every story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T011 Write failing tests `test/config/load.spec.js` and `test/config/policy.spec.js`: precedence flag, then environment, then file default; every variable in `contracts/environment.md` with its type and default; hard caps in code (budget project 10.00, run 100.00, turns 50, passes 4, concurrency 8, model timeout 1800000, HTTP timeout 60000); invalid or missing value exits 78 naming the key with the value redacted; policy files parsed with `yaml`, hosts normalised (lowercase, strip scheme, `www.`, trailing slash), only the three FR-014 high rules accepted under `high_when`
- [ ] T012 Implement `src/config/schema.js` (zod), `src/config/load.js` (environment, flags, defaults, redacted effective configuration object) and `src/config/policy.js` (`projects.yaml`, `dashboards.yaml`, `thresholds.yaml` with `config/defaults/` fallback and SHA-256 `config_hash`)
- [ ] T013 [P] Write failing tests `test/log/logger.spec.js`: JSON lines on stderr with `service: "agent-watchdog"`, `run_id`, `stage`, `event`, `ts`, `mono_ns`; secret values redacted by key; `pretty` format; level filtering
- [ ] T014 [P] Implement `src/log/logger.js` on `process.stderr` with `time.monotonic`-equivalent `process.hrtime.bigint()` for `mono_ns`
- [ ] T015 [P] Write failing tests `test/store/run-dir.spec.js` and `test/store/retention.spec.js`: layout from `contracts/run-directory.md`; atomic writes (`<name>.tmp` then rename); gzip for `inputs/windows.json.gz`; `run.json` updated at every stage boundary; retention classes raw (14 days), kept (30 days), durable (never); `feedback.jsonl` compacted only after outcomes exist under `corpus/outcomes/`
- [ ] T016 [P] Implement `src/store/run-dir.js`, `src/store/atomic.js`, `src/store/retention.js`
- [ ] T017 [P] Write failing tests `test/model/identity.spec.js` and `test/model/schemas.spec.js`: `item_id` is the first 12 hex characters of SHA-256 over `project_url`, `metric` and `pattern_card` or the literal `none` joined by newlines; `run_id` is `YYYY-MM-DD` or `YYYY-MM-DD-f<n>`; `candidate_id` hashes project, metric, rule, date; `feedback_id` hashes `source_ts`, `author`, `kind`, `verdict`; every enumeration in data-model.md rejects unknown values
- [ ] T018 [P] Implement `src/model/identity.js` and `src/model/schemas.js` (zod schemas for Project, Run, Metric Window, Computed Change, Candidate, Item, Pass, Verification Report, Brief, Thread Reply, Feedback, Memory, Proposal, Corpus Item, Pattern Card, Calibration Report, Expected-Load Window, Priority List, Cost Record)
- [ ] T019 Write failing tests `test/cli/parse.spec.js` and `test/cli/exit-codes.spec.js`: commands and flags from `contracts/cli.md`; unknown flag exits 64; logs on stderr and results on stdout; exit-code constants 0, 1, 64, 65, 69, 74, 75, 78 with a `run.exit` log line
- [ ] T020 Implement `bin/agent-watchdog.js`, `src/cli/index.js` (`node:util` `parseArgs` strict, command dispatch, global flags `--config-dir`, `--data-dir`, `--log-level`, `--log-format`), `src/cli/exit-codes.js`, `src/cli/streams.js`
- [ ] T021 [P] Write failing tests `test/trace/langfuse.spec.js` and `test/trace/cost.spec.js` (stubbed SDK): one root observation per run with `sessionId = run_id`, one span per stage, one `generation` per model call with `usageDetails` (input, output, cache read, cache creation) and `costDetails`; `forceFlush` then `shutdown` on exit; Cost Records summed and reconciled against the runtime's `total_cost_usd`
- [ ] T022 [P] Implement `src/trace/langfuse.js` (`NodeSDK` with `LangfuseSpanProcessor({ exportMode: 'immediate' })`, `propagateAttributes`, `getTraceUrl`) and `src/trace/cost.js` (research.md R-8)
- [ ] T023 [P] Write failing test `test/agent/output-schema.spec.js` asserting `schema/findings.schema.json` and `schema/brief.schema.json` equal `z.toJSONSchema()` of the zod definitions and that fixtures under `test/fixtures/findings/` validate; implement `src/agent/output-schema.js` and `scripts/build-schema.js` (`npm run schema:build`) starting from `contracts/findings.schema.json` and `contracts/brief.schema.json`
- [ ] T024 [P] Create the synthetic, scrubbed fixture set: `test/fixtures/runs/quiet-day/` and `test/fixtures/runs/seeded-anomaly/` (Prometheus proxy JSON per metric using the R-6 metric names, `up` targets, dashboard JSON with the real uids and panel ids, annotations), `test/fixtures/slack/` (replies, reactions, history payloads), `test/fixtures/corpus/` (one conversation, one data export), `test/fixtures/findings/`, `test/fixtures/feedback-labels.json`, and `test/fixtures/README.md` describing how `scripts/record-fixtures.js` refreshes them from a real watchdog with hosts scrubbed

**Checkpoint**: Foundation ready. `npm test` passes, `npm run lint` is clean, and `agent-watchdog --version` prints the package version.

---

## Phase 3: User Story 1 - Daily brief for the on-call engineer (Priority: P1) 🎯 MVP

**Goal**: One scheduled run collects metrics from the hosted watchdog, computes candidates deterministically, runs bounded two-pass analysis with the SDK engine, verifies every draft in code, renders the report and image, and posts the brief, heartbeat or degraded brief to `#agents` with one threaded reply per item.

**Independent Test**: `npm run replay:eval` on the seeded-anomaly and quiet-day fixtures, then `agent-watchdog run --dry-run --date <yesterday>` against a real watchdog (quickstart steps 2 and 3).

### Tests for User Story 1

- [ ] T025 [P] [US1] Write failing tests `test/collect/grafana.spec.js`: bearer header and `AGENT_WATCHDOG_HTTP_TIMEOUT_MS`; proxy paths `/api/datasources/proxy/uid/<uid>/api/v1/{query_range,query,series,targets}`; `GET /api/search?type=dash-db&limit=5000`; `GET /api/dashboards/uid/:uid`; `GET /api/annotations`; Prometheus envelope parsing with quoted sample values; timeouts and connection errors classified as unavailable (exit 69); datasource uid cross-check against `targets[].datasource.uid` exits 78 (research.md R-5)
- [ ] T026 [P] [US1] Write failing tests `test/collect/discovery.spec.js`: projects from `instance` labels of `up{job="cht"}`; `configured` flag from `projects.yaml`; `cht_version` labels `app`, `node`, `couchdb`; `history_days`; panel expressions extracted from dashboards including panels nested in `row` panels; per-dashboard map of duplicate panel ids
- [ ] T027 [P] [US1] Write failing tests `test/collect/windows.spec.js`: `current` is the 24 hours ending at run start; `previous_day`, `previous_week`, `previous_cycle` (only when a window is active); `trailing_14d` as daily `max_over_time(<expr>[1d])` at step 86400; 24-hour windows at step 300; `instance=~"$cht_instance"` rewritten to `instance="<host>"`; `available: false` with `unavailable_reason` below 14 daily points
- [ ] T028 [P] [US1] Write failing tests `test/analyze/changes.spec.js`, `test/analyze/calendar.spec.js`, `test/analyze/candidates.spec.js`: `pct_change_vs_previous_day = (current - previous_day) / abs(previous_day) * 100` and null when previous is 0 or unavailable; `deviation_sigma` null when stddev is 0; `monotonic_rise_hours` as the longest non-decreasing run ending at the last sample; `baseline` becomes `previous_cycle` inside an active window with the window's timezone; rules `pct_change` at 50, `deviation` at 2.5, `monotonic` at 6, `target_down`, `backlog_absolute`; threshold source `default`, `global` or `project`; `severity_floor: high` only for scrape target down, outbound push backlog above zero, sentinel backlog above three times its baseline
- [ ] T029 [P] [US1] Write failing tests `test/agent/prompt-assembly.spec.js` and `test/agent/definition.spec.js`: static prefix is `prompts/system.md`, then `skill/cht-watchdog/SKILL.md`, then `skill/cht-watchdog/pattern-cards/index.md`, then the runtime's dynamic-boundary marker, then date, memory and active windows; materialised to `runs/<id>/agent/system-prompt.md`; `agent/mcp.template.json` rendered with environment values and the bearer header omitted when the token is unset; `agent/tools.json` lists only the allow-listed names
- [ ] T030 [P] [US1] Write failing tests `test/agent/tools/watchdog-tools.spec.js`: `get_windows`, `query_metric` (templated `metric{instance="<host>"}` only, discovered metric names only, five named windows, 20 calls per session), `read_pattern_card` (index ids only), `get_item_history` (authors replaced by role labels); replay mode answers from `tool-calls.jsonl` by tool name and argument hash and returns `{ unavailable: true, reason: 'not recorded' }` otherwise
- [ ] T031 [P] [US1] Write failing tests `test/agent/session-loop.spec.js` with a fake engine: pass 1, gate, revision turn on rejection at most `AGENT_WATCHDOG_VERIFY_MAX_RETRIES` times, pass 2 review with `changes[]` reasons, convergence when identities, severities and evidence match within display rounding, early stop, bounds for turns, budget and timeout recorded in `bounds_hit`; files `findings.pass<n>.json`, `verification.pass<n>.json`, `passes.json`, `session.json`, `tool-calls.jsonl`
- [ ] T032 [P] [US1] Write failing tests `test/verify/gate.spec.js` and one file per check under `test/verify/checks/`: `schema`, `projects_known`, `metrics_known`, `candidates_known`, `numbers_match` (integers with thousands separators, three significant figures otherwise, percentages with one decimal and `%`, durations `Nh` or `Nd`), `dates_match`, `links_built`, `links_allowlisted`, `links_resolve`, `severity_rules` (high needs a referenced candidate with `severity_floor: high`), `bullet_count` at most 3, `bullet_length` at most 2 lines of at most 120 characters, `secrets_absent` (`xox[abp]-`, `sk-ant-`, `glsa_`, bearer strings), `personal_data_absent` (e-mail, phone), `pattern_cards_known`; attempts 1 to 3; report shape from data-model.md
- [ ] T033 [P] [US1] Write failing tests `test/links/build.spec.js`, `test/links/allowlist.spec.js`, `test/links/resolve.spec.js`: `/d/<uid>/<slug>?orgId=1&from=<ms>&to=<ms>&timezone=utc&var-cht_instance=<host>` plus `&viewPanel=panel-<id>` only when the id is unique on that dashboard; allow-list hosts from data-model.md; Grafana links resolved against collected dashboard JSON, other links by HTTP 2xx or 3xx within the timeout
- [ ] T034 [P] [US1] Write failing tests `test/rollup/rank.spec.js`, `test/rollup/brief.spec.js`, `test/rollup/deterministic-brief.spec.js`: ranking by severity, confidence and `persisting_days`; `placement: body` for ranks 1 to 3 and `thread` otherwise; heartbeat with `checked` counts when no items; degraded brief built from candidates only with `degradation_notice` after three rejected drafts or unusable model output; `expected_load_notice` when a window is active
- [ ] T035 [P] [US1] Write failing tests `test/render/report.spec.js` and `test/render/browser.spec.js` (stubbed playwright-core): Handlebars compiled with `strict: true`, escaping of untrusted text, a test that fails if any template contains `{{{`; inline SVG charts drawn from `changes.json`; summary element `#brief-summary`; browser launched headless with `javaScriptEnabled: false`, `offline: true`, every request aborted, `setContent` then `locator.screenshot({ type: 'png' })`
- [ ] T036 [P] [US1] Write failing tests `test/publish/slack.spec.js` and `test/publish/payload.spec.js` (stubbed `WebClient`): `files.uploadV2` without `channel_id` and the id read from `result.files[0].files[0].id`; parent `chat.postMessage` with `text` fallback under 4,000 characters, `blocks` (header, one section per bullet, `image` with `slack_file.id`, context notices, context footer), `unfurl_links: false`, metadata `agent_watchdog.brief`; one threaded reply per item with metadata `agent_watchdog.item`; `chat.getPermalink` per message; pacing one message per second; heartbeat and failure notices; Slack failure after retries marks the run `unposted` and exits 74; `payload.json` shape from `contracts/slack-payload.md`; `audience` is an explicit argument
- [ ] T037 [P] [US1] Write failing tests `test/cli/run.spec.js`: state machine from data-model.md (`created`, `collected`, `analysed`, `drafted`, `verified`, `degraded`, `rendered`, `published`, `heartbeat`, `previewed`, `unposted`, `failed`, `refused`); duplicate date without `--force` exits 75; metrics source unavailable posts a failure notice and exits 69; unexpected error posts a notice and exits 1; degraded exits 0 with `status: degraded`; projects without candidates incur no engine call; `AGENT_WATCHDOG_RUN_TIMEOUT_MS` ends the run with what it has

### Implementation for User Story 1

- [ ] T038 [US1] Implement `src/collect/grafana.js` (`fetch`, bearer header, timeout, proxy and API helpers, envelope parsing, uid cross-check)
- [ ] T039 [US1] Implement `src/collect/discovery.js` and `src/collect/targets.js`
- [ ] T040 [US1] Implement `src/collect/windows.js` and the stage runner `src/cli/stages/collect.js` writing `discovery.json` and `<project>/inputs/windows.json.gz`
- [ ] T041 [P] [US1] Implement `src/analyze/changes.js` and `src/analyze/baselines.js`
- [ ] T042 [P] [US1] Implement `src/analyze/calendar.js` (month_end, dates, weekly kinds with IANA timezone and `cycle_days`)
- [ ] T043 [US1] Implement `src/analyze/thresholds.js`, `src/analyze/candidates.js` and the stage runner `src/cli/stages/analyze.js` writing `changes.json` and `candidates.json`
- [ ] T044 [P] [US1] Write `prompts/system.md`, `prompts/pass-first.md`, `prompts/pass-review.md` and `prompts/rollup.md` with labelled untrusted-text delimiters, the structured-output instructions and the "compose no URLs" rule; write the initial `skill/cht-watchdog/SKILL.md`, `skill/cht-watchdog/references/metrics.md` (the R-6 catalogue) and an empty `skill/cht-watchdog/pattern-cards/index.md`
- [ ] T045 [P] [US1] Write `agent/mcp.template.json` (server `cht-docs` of type `http` with per-tool policies allowing `search_docs` and `get_sources` and denying `ask_question`; server `watchdog` placeholder), `agent/tools.json` and `agent/hooks.js` (`PreToolUse` deny-by-default, `PostToolUse` recorder, `Stop` gate) per `contracts/agent-definition.md`
- [ ] T046 [US1] Implement `src/agent/definition.js` and `src/agent/prompt-assembly.js`
- [ ] T047 [US1] Implement `src/agent/tools/watchdog-tools.js` (SDK `tool()` definitions with zod shapes), `src/agent/tools/sdk-server.js` (`createSdkMcpServer`) and `src/agent/tools/replay-shim.js`
- [ ] T048 [US1] Implement `src/agent/session-loop.js` (engine-agnostic pass and revision loop, convergence, bounds, artefact writes)
- [ ] T049 [US1] Implement `src/agent/engine-sdk.js`: dynamic `import()` of the SDK; `query()` with a streaming-input generator; options `settingSources: []`, `tools: []`, `allowedTools`, `permissionMode: 'dontAsk'`, `strictMcpConfig: true`, `persistSession: false`, `outputFormat`, `maxTurns`, `maxBudgetUsd`, `model`, `effort`, `hooks`, `env` spread from `process.env` with `CLAUDE_CONFIG_DIR`; result mapping for every `subtype`, `usage`, `total_cost_usd`, `structured_output` (research.md R-2)
- [ ] T050 [US1] Implement the stage runner `src/cli/stages/agent.js` with `AGENT_WATCHDOG_PROJECT_CONCURRENCY`, skipping projects without candidates (FR-013), per-call timeout and the run-level timeout
- [ ] T051 [US1] Implement `src/verify/gate.js`, `src/verify/format.js` and `src/verify/checks/*.js` (one module per check listed in T032)
- [ ] T052 [US1] Implement `src/links/build.js`, `src/links/allowlist.js`, `src/links/resolve.js`
- [ ] T053 [US1] Implement `src/rollup/rank.js`, `src/rollup/brief.js` (roll-up model call with `schema/brief.schema.json` and the gate, at most three drafts), `src/rollup/deterministic-brief.js` and the stage runner `src/cli/stages/rollup.js`
- [ ] T054 [US1] Design `templates/report.hbs` once (record the design read in the template header) and implement `src/render/report.js`
- [ ] T055 [US1] Implement `src/render/browser.js` and the stage runner `src/cli/stages/render.js` writing `rollup/report.html` and `rollup/brief.png`
- [ ] T056 [P] [US1] Write `templates/slack/parent.hbs`, `templates/slack/reply.hbs`, `templates/slack/heartbeat.hbs`, `templates/slack/failure.hbs` and implement `src/publish/payload.js` and `src/publish/audience.js`
- [ ] T057 [US1] Implement `src/publish/slack.js` and the stage runner `src/cli/stages/publish.js` writing `payload.json`, `publication.json` and the final `run.json`
- [ ] T058 [US1] Implement `src/cli/commands/run.js`: stage order `purge`, `feedback` (a pass-through that writes an empty `feedback.ingested.json` until US2), `collect`, `analyze`, `agent`, `rollup`, `render`, `publish`; state transitions, failure notice, exit codes, `--date`, `--project`, `--force`, idempotency
- [ ] T059 [US1] Write the fixture end-to-end test `test/e2e/us1.spec.js` covering all seven US1 acceptance scenarios with recorded findings standing in for the model
- [ ] T060 [US1] Write `smoke/grafana.js` (S-6, S-7), `smoke/slack.js` (S-8) and `smoke/agent-sdk.js` (S-1, S-2, S-4, S-5) with usage notes in `README.md`

**Checkpoint**: `agent-watchdog run --dry-run` produces every artefact and the payload against a real watchdog; the fixture suite proves the seeded anomaly and the quiet day.

---

## Phase 4: User Story 2 - Feedback that changes tomorrow's brief (Priority: P2)

**Goal**: The next run reads reactions and thread notes on the previous N posts, records them against stable item identities, honours stated horizons, adjusts ranking, updates capped memory by diff, and appends outcomes to the corpus.

**Independent Test**: `test/e2e/us2.spec.js` on recorded Slack fixtures, then the live check in quickstart step 7.

### Tests for User Story 2

- [ ] T061 [P] [US2] Write failing tests `test/feedback/ingest.spec.js`: `conversations.replies` per stored parent `ts` with `include_all_metadata`, paging by `cursor`; `reactions.get` with `full: true` per bot message; `+1` and `thumbsup` map to `up`, `-1` and `thumbsdown` to `down`; a previously recorded reaction now absent is `retracted`; a reaction on the parent targets the brief; bot messages identified by `bot_id` or `agent_watchdog.item` metadata; fallback to `conversations.history` when `publication.json` is missing; `--since` overrides the look-back
- [ ] T062 [P] [US2] Write failing tests `test/feedback/match.spec.js` and `test/feedback/parse-notes.spec.js`: notes matched by explicit reference (item id, metric name, project host); unmatched notes recorded with `matched: false` and surfaced in the next brief's thread; `horizon` parsed from notes such as "expected until 1 October" through the feedback-parse model call with a deterministic date-parsing fallback
- [ ] T063 [P] [US2] Write failing tests `test/feedback/store.spec.js`: `feedback.jsonl` append with `feedback_id` de-duplication and the fields `date`, `run_id`, `target`, `item_id`, `kind`, `verdict`, `note`, `horizon`, `author`, `matched`, `source_ts`
- [ ] T064 [P] [US2] Write failing tests `test/rollup/feedback-influence.spec.js` and `test/analyze/horizon.spec.js`: repeatedly dismissed patterns rank lower and confirmed ones higher; a pattern with a stated horizon is not flagged before the horizon unless it exceeds the noted expectation; two thumbs-up raise confidence in memory
- [ ] T065 [P] [US2] Write failing tests `test/rollup/memory.spec.js`: `memory_update.replace_with` accepted only within `ceil(chars / 4) * 1.1 <= AGENT_WATCHDOG_MEMORY_MAX_TOKENS`; every change written as a unified diff to `memory/history/<run_id>.patch` and copied to `runs/<run_id>/memory.patch`; `version` incremented
- [ ] T066 [P] [US2] Write failing tests `test/corpus/outcomes.spec.js`: confirmed and dismissed items with notes appended to `corpus/outcomes/<date>.jsonl` (FR-030); compaction of `feedback.jsonl` refuses to drop records whose outcomes are not yet appended

### Implementation for User Story 2

- [ ] T067 [US2] Implement `src/feedback/ingest.js`, `src/feedback/match.js`, `src/feedback/parse-notes.js` (uses `AGENT_WATCHDOG_MODEL_FEEDBACK` and `prompts/feedback-parse.md`), `src/feedback/store.js` and the stage runner `src/cli/stages/feedback.js`
- [ ] T068 [US2] Add feedback influence to `src/rollup/rank.js` and horizon suppression to `src/analyze/candidates.js`
- [ ] T069 [US2] Implement `src/rollup/memory.js` and wire the roll-up's `memory_update` into `src/cli/stages/rollup.js`
- [ ] T070 [US2] Implement `src/corpus/outcomes.js` and wire it into `src/cli/commands/run.js` after feedback ingestion
- [ ] T071 [US2] Write `test/e2e/us2.spec.js` covering the five US2 acceptance scenarios on `test/fixtures/slack/`

**Checkpoint**: Feedback left on day N changes day N+1's ranking and memory in replay (SC-003).

---

## Phase 5: User Story 3 - Steering, auditing and running it yourself (Priority: P2)

**Goal**: Footer links lead to prompts, configuration and trace with cost; the priority list steers analysis; every run is versioned and replayable offline; contributors run stages, preview mode and the CLI engine on their own machines.

**Independent Test**: quickstart steps 3 to 6 plus `test/e2e/us3.spec.js`.

### Tests for User Story 3

- [ ] T072 [P] [US3] Write failing tests `test/publish/footer.spec.js` and `test/collect/priority.spec.js`: footer carries `AGENT_WATCHDOG_PROMPTS_URL`, `AGENT_WATCHDOG_CONFIG_URL`, the trace URL and `cost_usd` in currency; reordering `dashboards.yaml` changes analysis order and adding a dashboard adds its panels; `query_metric` still reaches metrics beyond the list
- [ ] T073 [P] [US3] Write failing tests `test/store/versions.spec.js`: `run.json.versions` holds `package`, `git_sha`, `prompts_hash`, `skill_hash`, `schema_hash`, `config_hash`
- [ ] T074 [P] [US3] Write failing tests `test/cli/replay.spec.js`: reads a stored run, writes `runs-replay/<run_id>/<label>/` with the same layout, honours `--prompts` and `--skill`, serves recorded tool results through the replay shim, never calls the Grafana or Slack hosts (the `fetch` guard fails the test otherwise), prints the items comparison JSON on stdout
- [ ] T075 [P] [US3] Write failing tests `test/cli/dry-run.spec.js` and `test/cli/stage.spec.js`: preview writes every artefact and `payload.json`, prints the payload on stdout, posts nothing and sets `status: previewed`; `--stage <name>` reads only the previous stage's files, exits 65 naming a missing input, overwrites its outputs atomically
- [ ] T076 [P] [US3] Write failing tests `test/agent/engine-cli.spec.js` with a fake `claude` script: arguments `-p --bare --no-session-persistence --input-format stream-json --output-format stream-json --system-prompt-file … --tools "" --allowed-tools … --permission-mode dontAsk --mcp-config … --strict-mcp-config --json-schema … --model … --effort … --max-budget-usd …`; user turns written to stdin after each `result` event; `tool_use` and `tool_result` events recorded to `tool-calls.jsonl`; harness turn cap closes stdin and terminates; timeout kill; result mapping identical to the SDK engine (research.md R-3)

### Implementation for User Story 3

- [ ] T077 [US3] Implement `src/store/versions.js` and stamp versions in `src/cli/commands/run.js`; add the footer to `src/publish/payload.js`
- [ ] T078 [US3] Implement `src/cli/commands/replay.js`
- [ ] T079 [US3] Implement preview mode (`--dry-run`, `AGENT_WATCHDOG_DRY_RUN`) and `--stage` handling in `src/cli/commands/run.js` and `src/cli/stages/index.js`
- [ ] T080 [US3] Implement `src/agent/engine-cli.js` and `src/agent/tools/stdio-server.js` with the `tools-server` command in `src/cli/commands/tools-server.js`
- [ ] T081 [US3] Implement `scripts/replay-eval.js` (`npm run replay:eval`): runs the fixture runs through analysis, gate and recorded findings, compares with `test/fixtures/runs/*/expected.json` and `test/fixtures/feedback-labels.json`, exits non-zero on regression
- [ ] T082 [US3] Write `smoke/agent-parity.js` (S-3, S-10) diffing both engines' `findings.pass<n>.json` and gate verdicts for one recorded project
- [ ] T083 [US3] Write `test/e2e/us3.spec.js` covering the seven US3 acceptance scenarios

**Checkpoint**: A contributor can run every stage, the full pipeline in preview, and the analysis through `claude -p`, obtaining the same artefacts (SC-006, SC-007, SC-011).

---

## Phase 6: User Story 4 - Self-improvement under review (Priority: P3)

**Goal**: The agent writes pattern and threshold proposals with evidence, flags identifiers for the reviewer, condenses memory within its cap, and a weekly calibration report backs threshold suggestions with replayed effects.

**Independent Test**: `test/e2e/us4.spec.js` on recorded days with a recurring pattern and a noisy metric; assert no prompt, skill or threshold file changed.

### Tests for User Story 4

- [ ] T084 [P] [US4] Write failing tests `test/rollup/proposals.spec.js` and `test/corpus/scrub.spec.js`: proposal files `proposals/<date>-<type>-<slug>.md` with `type` in `skill`, `prompt`, `threshold`, `pattern_card`; pattern-level bodies; identifiers (discovered hostnames, e-mail addresses, Slack user ids, feedback author names) masked in the body and listed under `flags` with `kind` in `hostname`, `person`, `address`, `secret`; `status` `proposed` or `superseded`; a guard test asserting `prompts/`, `skill/`, `schema/`, `agent/` and the policy files are never written by a run
- [ ] T085 [P] [US4] Write failing tests `test/calibration/report.spec.js` and `test/calibration/suggest.spec.js`: per project and metric `distribution` percentiles of daily percentage change and deviation, `outcomes` counts, `current_threshold`, `suggested_threshold`, `effect_last_30d` with `items_kept`, `items_dropped`, `confirmed_kept`; `pass_change_rate` (FR-058); `week` as `YYYY-Www`; threshold proposals written from the report
- [ ] T086 [P] [US4] Write failing tests `test/rollup/memory-condense.spec.js`: at the cap the agent condenses within the cap, the change is stored as a diff, and the run does not fail

### Implementation for User Story 4

- [ ] T087 [US4] Implement `src/rollup/proposals.js` and `src/corpus/scrub.js`; wire proposal writing into `src/cli/stages/rollup.js`
- [ ] T088 [US4] Implement `src/calibration/report.js`, `src/calibration/suggest.js`, `prompts/calibration.md` (summary with `AGENT_WATCHDOG_MODEL_CALIBRATION`) and the command `src/cli/commands/calibrate.js` (`--week`, `--project`)
- [ ] T089 [US4] Implement memory condensation in `src/rollup/memory.js` with a condensation prompt in `prompts/rollup.md`
- [ ] T090 [US4] Write `test/e2e/us4.spec.js` covering the four US4 acceptance scenarios

**Checkpoint**: Proposals and a calibration report exist for the recorded days, and every reviewed file is byte-identical after the run.

---

## Phase 7: User Story 5 - New projects and readiness (Priority: P3)

**Goal**: A project added to the hosted watchdog is analysed on the next run and named as new; operators can check a CHT deployment's readiness for monitoring.

**Independent Test**: `test/e2e/us5.spec.js` plus quickstart step 8.

### Tests for User Story 5

- [ ] T091 [P] [US5] Write failing tests `test/collect/new-project.spec.js`: a host present in `up{job="cht"}` with no `projects.yaml` entry is analysed like any other and the brief carries a "new, unconfigured project" note; a project with fewer than 14 daily points has history comparisons marked unavailable and never computed from partial data
- [ ] T092 [P] [US5] Write failing tests `test/readiness/check.spec.js`: `GET https://<host>/api/v2/monitoring` parsed for `version.app`; below 3.12.0 reports the unmet prerequisite in plain language and exits 1; 4.3.0 (API metrics) and 4.11.0 (CouchDB size metrics) reported as informational; unreachable host exits 69; `https://<host>:8443/metrics` probed only when `projects.yaml` sets `host_metrics: true` (research.md R-6)

### Implementation for User Story 5

- [ ] T093 [US5] Add the new-project note to `src/rollup/brief.js` and `templates/slack/parent.hbs`; confirm `src/collect/discovery.js` and `src/collect/windows.js` satisfy the history rule
- [ ] T094 [US5] Implement `src/readiness/check.js` and the command `src/cli/commands/check.js`
- [ ] T095 [US5] Write `test/e2e/us5.spec.js` covering the three US5 acceptance scenarios

**Checkpoint**: A newly added project appears in the next brief (SC-008) and `agent-watchdog check` reports readiness with the documented exit codes.

---

## Phase 8: User Story 6 - Learning from the knowledge corpus (Priority: P3)

**Goal**: Maintainers drop raw material into the corpus; distillation produces scrubbed, reviewable pattern cards; merged cards are indexed for the daily analysis and read in full only when relevant.

**Independent Test**: `test/e2e/us6.spec.js` and quickstart step 9.

### Tests for User Story 6

- [ ] T096 [P] [US6] Write failing tests `test/corpus/index.spec.js`: `corpus/index.json` records `relative_path`, `content_hash` (full SHA-256), `size_bytes`, `kind` in `conversation`, `export`, `incident`, `explainer`, `run_outcome`, `unknown`, `status` in `new`, `distilled`, `skipped`, `skipped_reason` (`binary`, `too_large`), `distilled_at`, `card_ids`; a changed hash resets `status` to `new`; the index never contains content
- [ ] T097 [P] [US6] Write failing tests `test/corpus/distill.spec.js`: only `new` items processed unless `--all` or `--item`; one card per distinct pattern with `symptom`, `metrics` and shape, `watchdog_appearance`, `root_cause`, `resolution`, `confirmation_steps`, `false_positives`, `sources` (content hashes); identifiers removed or flagged; raw content never copied; cards written under `corpus/cards.proposed/<card_id>.md` with `status: proposed`; enormous or binary items skipped with a note in the distillation report
- [ ] T098 [P] [US6] Write failing tests `test/agent/pattern-index.spec.js`: only `skill/cht-watchdog/pattern-cards/index.md` is in the static prefix; a full card is read only through `read_pattern_card`; an item matching a merged card names it in `pattern_card` and uses the card's `confirmation_steps` as `suggested_check`

### Implementation for User Story 6

- [ ] T099 [US6] Implement `src/corpus/index.js`
- [ ] T100 [US6] Implement `src/corpus/distill.js`, `prompts/distill.md` (with `AGENT_WATCHDOG_MODEL_DISTILL`) and the command `src/cli/commands/distill.js` (`--all`, `--item`), printing the distillation report on stdout
- [ ] T101 [US6] Implement `scripts/build-card-index.js` generating `skill/cht-watchdog/pattern-cards/index.md` from merged cards, and wire card matching into `src/rollup/rank.js`
- [ ] T102 [US6] Write `test/e2e/us6.spec.js` covering the five US6 acceptance scenarios on `test/fixtures/corpus/`

**Checkpoint**: A new corpus item becomes a proposed card in one distillation, and a merged card is named by the next matching item (SC-009).

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Operations commands, performance, security, container proof, release tooling and documentation.

- [ ] T103 [P] Implement the `purge` command in `src/cli/commands/purge.js` (`--dry-run` lists removals) on `src/store/retention.js`, and run it implicitly at the start of `run`
- [ ] T104 [P] Write `test/perf/fifty-projects.spec.js`: a synthetic fifty-project run with recorded findings completes within `AGENT_WATCHDOG_RUN_TIMEOUT_MS` at concurrency 3 and projects without candidates make no engine call (Edge Cases, FR-013)
- [ ] T105 [P] Write `scripts/scan-secrets.js` and `test/scripts/scan-secrets.spec.js` applying the gate's secret and personal-data patterns to the repository and to every run's artefacts, and add it to `.github/workflows/agent-watchdog.yml` and to the end of `src/cli/commands/run.js` (SC-010)
- [ ] T106 [P] Write `smoke/render.js` (S-11) and `smoke/container.js`: `docker run --read-only --tmpfs /tmp` renders a fixture report, `--version` prints the version, `check https://example.invalid` exits 69
- [ ] T107 [P] Write `smoke/langfuse.js` (S-9) confirming `getTraceUrl` opens the run's trace and `forceFlush` completes before exit
- [ ] T108 [P] Run `semantic-release --dry-run` from the package directory and record the result in `README.md` "Releasing"; if path scoping fails, switch `release.config.js` to the workflow-filtered fallback from research.md R-12 (S-12)
- [ ] T109 [P] Add `.github/pull_request_template.md` items for dependency justification, replay diff on prompt or skill changes, and `AGENTS.md` and `README.md` updates (constitution Quality Gates)
- [ ] T110 Update `README.md` and `AGENTS.md` with the final commands, stage list, exit codes, contracts index and smoke-test instructions; confirm `AGENTS.md` agrees with `.specify/memory/constitution.md`
- [ ] T111 Run quickstart.md steps 1 to 10 against a real watchdog in preview mode, fix what fails, and confirm `npm run lint` reports zero warnings and coverage is at or above `main`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T001 first, then T002 to T010 in parallel.
- **Foundational (Phase 2)**: Depends on Setup. Blocks every user story. T011 and T012 first (configuration is used by everything); the T013 to T024 pairs are parallel across modules, each test before its implementation.
- **User Stories (Phases 3 to 8)**: All depend on Phase 2. US1 is the MVP and should complete first because US2, US3, US4 and US5 extend its stages; US6 depends only on Phase 2 and the pattern-card hooks in US1's prompt assembly.
- **Polish (Phase 9)**: Depends on the stories being delivered; T103 to T109 are parallel, T110 and T111 last.

### User Story Dependencies

- **US1 (P1)**: Foundational only. Delivers the full daily run with the SDK engine.
- **US2 (P2)**: Extends US1's feedback stage, ranking, roll-up memory and run command. Independently testable on Slack fixtures.
- **US3 (P2)**: Extends US1's payload, run command and agent engines; adds replay and the CLI engine. Independently testable with the fake `claude` script and stored runs.
- **US4 (P3)**: Uses US1's roll-up and US2's feedback records for calibration. Independently testable on recorded days.
- **US5 (P3)**: Uses US1's discovery and brief; the readiness command is standalone.
- **US6 (P3)**: Corpus and distillation are standalone; card matching touches US1's ranking.

### Within Each User Story

- Tests are written first and fail before implementation (constitution II).
- Collect before analyze, analyze before agent, agent before roll-up, roll-up before render and publish.
- Story complete, with its end-to-end fixture test green, before the next priority.

### Parallel Opportunities

- Phase 1: T002 to T010 after T001.
- Phase 2: the module pairs T013/T014, T015/T016, T017/T018, T021/T022, T023, T024 in parallel after T012.
- US1: all test tasks T025 to T037 in parallel; then T038 to T040 (collect), T041 to T043 (analyze), T044 to T047 (agent definition and tools), T051 (verify), T052 (links), T054 (report template), T056 (Slack templates) can proceed on separate files while T048 to T050 wait for T046 and T047.
- US2 to US6: every story's test tasks in parallel, then implementations; US6 can run alongside US4 and US5.

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
6. Phase 9 → container proof, release tooling, security scan (SC-010).

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

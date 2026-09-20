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

**Goal**: Footer links lead to prompts, configuration and trace with cost; the priority list steers analysis; every run is versioned and replayable offline; contributors run stages, preview mode and the CLI engine on their own machines.

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

- [X] T128 [P] [US9] Write failing tests extending `test/config/policy.spec.js`: `projects.yaml` accepts `groups` (`label` unique, at most 40 characters, never `Other` or `Watchdog`; `host_patterns` lowercase globs using only `*` and `?`) and `ignore` (globs); a pattern with a scheme or `www.` is rejected; the package default carries the two placeholder groups (`MoH Nepal`, `eCHIS Kenya`) and the ignore patterns `*.dev.*` and `*-dev.*` (FR-068)
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

- [ ] T141 [P] [US8] Write failing tests extending `test/config/policy.spec.js` and `test/store/versions.spec.js`: `alerts.yaml` (`stale_after_days` an integer from 1 to 365; `rules` keyed by title with `category` a lowercase slug and `importance` one of `critical`, `high`, `medium`, `low`; `categories` listing metric keys with every used category present); the package default carries the FR-065 mapping; `config_hash` covers the four policy files (FR-065)
- [ ] T142 [P] [US8] Write failing tests `test/collect/alerts.spec.js` and extend `test/collect/grafana.spec.js` and `test/helpers/fake-grafana.js`: `GET /api/prometheus/grafana/api/v1/rules` (following `groupNextToken`) and the `/alerts` fallback are read with the bearer token and timeout; rules and instances are normalised (`state` compared case-insensitively with `alerting` mapped to `firing`; `instance` label to host as in R-6; dashboard uid and panel id from the `__dashboardUid__` and `__panelId__` annotations; instances on ignored hosts dropped and counted); a 401, 403, 5xx or timeout yields `available: false` with a reason in `alerts.json` and the run continues (FR-064)
- [ ] T143 [P] [US8] Write failing tests `test/alerts/classify.spec.js` and `test/alerts/group.spec.js`: category and importance by title, an unknown title is `uncategorised`, `medium`, `known: false`; `started_at` from `activeAt` else the first observing run; `days_firing`, `stale` at exactly `stale_after_days`, `new` against the previous run's `alerts.classified.json`; Alert Groups per `group` and `category` with `firing`, `new`, `stale`, `oldest_started_at`, highest `importance`, `rule_uids`, `instance_ids`; instances without a host fall under `Watchdog`; only `firing` instances are counted (FR-065, FR-066)
- [ ] T144 [P] [US8] Write failing tests `test/alerts/episodes.spec.js` and extend `test/store/retention.spec.js` and `test/corpus/outcomes.spec.js`: `opened`, `observed` and `cleared` events appended to `alerts/episodes.jsonl` with `duration_hours` on clear; correlations (active expected-load window, a `cht_version` change across `started_at`, related candidates and items whose metric is listed under the category within one day); `explanation` copied from an accepted Item of the same project and category; a cleared episode appended to `corpus/outcomes/<date>.jsonl` as `kind: alert_episode`; `classify('alerts/episodes.jsonl')` is `durable` (FR-067)
- [ ] T145 [P] [US8] Write failing tests extending `test/rollup/layout.spec.js`, `test/rollup/brief.spec.js`, `test/rollup/deterministic-brief.spec.js`, `test/links/build.spec.js`, `test/links/resolve.spec.js`, `test/verify/checks/links_resolve.spec.js`, `test/publish/payload.spec.js` and `test/publish/slack.spec.js`: Alert Groups rank among Items by importance (critical before every item, otherwise after items of the same severity) and share one `alerts` bullet per programme with one child per category, code-built text "<label> alerts: <n> firing, <m> stale for more than <d> days" and no URL; `buildAlertListLink` emits `<grafana>/alerting/list?search=<encoded terms>` from `namespace:CHT`, `state:firing`, `rule:"<title>"` and `label:instance=~"^(<hosts>)$"` and resolves by checking every title and host against the collected rules and instances; one reply per Alert Group with `agent_watchdog.alerts` metadata from `templates/slack/alert-group.hbs` (at most fifty instances, the count of the rest, one link per rule and one for the group) in body order; a day without items but with firing alerts posts the alert bullets rather than a heartbeat; an unavailable alerting API adds a notice (FR-066, FR-070)
- [ ] T146 [P] [US8] Write failing tests extending `test/agent/prompt-assembly.spec.js`, `test/agent/stage-agent.spec.js`, `test/feedback/ingest.spec.js`, `test/feedback/match.spec.js` and `test/publish/digest.spec.js`: the project's firing alerts reach the pass prompt inside `<untrusted source="alerts">`; bot replies carrying `agent_watchdog.alerts` metadata are alert groups, and reactions or notes on them are recorded with `target: alert_group` and `alert_key`, acknowledged in the digest, and never change ranking (FR-066, FR-067)
- [ ] T147 [P] [US8] Record the fixture day `test/fixtures/runs/alerts-day` with `test/fixtures/generate.js` (nine rules, fifteen firing instances across two programmes including three firing for more than 14 days and one unknown rule title, one instance on a `.dev` host, one rule without an `instance` label) and write failing `test/e2e/us8.spec.js` covering the six US8 acceptance scenarios over two consecutive days (an instance clears on day two)

### Implementation for User Story 8

- [ ] T148 [US8] Load `alerts.yaml` in `src/config/policy.js` (schema, defaults from `config/defaults/alerts.yaml`, inclusion in the policy hash used by `src/store/versions.js`) and add `AlertRule`, `AlertInstance`, `AlertGroup` and `AlertEpisode` to `src/model/schemas.js` with the enumerations from data-model.md
- [ ] T149 [US8] Implement `src/collect/alerts.js` and the `alertRules()` and `alertInstances()` methods of `createGrafanaClient` in `src/collect/grafana.js`; write `alerts.json` from `src/cli/stages/collect.js` with `available` and `reason`; serve both endpoints from fixtures in `test/helpers/fake-grafana.js`
- [ ] T150 [US8] Implement `src/alerts/classify.js` and `src/alerts/group.js` and write `alerts.classified.json` from `src/cli/stages/analyze.js`, reading the previous run's file for `new`
- [ ] T151 [US8] Implement `src/alerts/episodes.js` (events, correlations, explanation), the `durable` class for `alerts/episodes.jsonl` in `src/store/retention.js`, the `alert_episode` outcome in `src/corpus/outcomes.js`, and the wiring in `src/cli/stages/rollup.js` after ranking
- [ ] T152 [US8] Place Alert Groups in `src/rollup/layout.js`, build `alerts` bullets in `src/rollup/brief.js` and `src/rollup/deterministic-brief.js`, and add the alerts-unavailable notice to the Brief `notices`
- [ ] T153 [US8] Implement `buildAlertListLink` in `src/links/build.js` and its resolution in `src/links/resolve.js` and `src/verify/checks/links_resolve.js`; write `templates/slack/alert-group.hbs`; add alert-group replies with `agent_watchdog.alerts` metadata to `src/publish/payload.js` and their posting to `src/publish/slack.js` and `src/cli/stages/publish.js`
- [ ] T154 [US8] Pass the project's firing alerts into the analysis prompt in `src/agent/prompt-assembly.js` and `src/cli/stages/agent.js`, with a section in `prompts/pass-first.md` and `prompts/pass-review.md` explaining that an item may explain an alert
- [ ] T155 [US8] Record feedback on alert-group replies in `src/feedback/ingest.js` and `src/feedback/match.js` (`target: alert_group`, `alert_key`), extend `schemas.Feedback` in `src/model/schemas.js`, and show it in `src/publish/digest.js` and `templates/slack/feedback-digest.hbs`
- [ ] T156 [US8] Add `--alerts` to `smoke/grafana.js` (S-14, and printing the links for S-15); make `test/e2e/us8.spec.js` pass; update `README.md` and `AGENTS.md` (alerts in the brief, `alerts.yaml`, episodes)

**Checkpoint**: every alert firing at run time appears grouped in the body or thread with a link that resolves (SC-014); an unavailable alerting API is a notice, not a failure; episodes accumulate on disk.

---

## Phase 12: Polish & Cross-Cutting Concerns

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

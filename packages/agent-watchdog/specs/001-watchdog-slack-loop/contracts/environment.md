# Contract: Environment Variables

The deployment (in `medic-infrastructure`) supplies these through a ConfigMap `envFrom` for
non-secrets and an External Secrets-managed Secret `envFrom` for secrets. Locally, `.env.example`
is copied to `.env` and loaded with `node --env-file=.env`. Every value is validated at startup by
a zod schema; a bad or missing required value exits 78 naming the key with its value redacted
(FR-051, FR-052, FR-055). Precedence: flag, environment, configuration-file default.

`.env.example` in the package root is the source of truth for names and defaults; this table adds
type, requiredness and consumer.

## Secrets (environment only, never in files or run records)

| Variable | Required | Consumer | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | agent runtime | Read by the Claude Code runtime the SDK launches. |
| `SLACK_BOT_TOKEN` | yes unless `--dry-run` | publish, feedback | Bot token of the `agent-watchdog` Slack app. Scopes in [slack-payload.md](./slack-payload.md). |
| `AGENT_WATCHDOG_GRAFANA_TOKEN` | yes | collect | Service-account token, Viewer role, on the hosted watchdog Grafana. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | yes | trace | Tracing is not optional: the footer needs the trace link (FR-019, FR-049). |
| `AGENT_WATCHDOG_DOCS_MCP_TOKEN` | no | agent | Sent as a bearer header to the documentation service only if set. |

## Model and engine

| Variable | Type | Default | Notes |
|---|---|---|---|
| `AGENT_WATCHDOG_MODEL` | string | `claude-fable-5-1` | Analysis and roll-up. |
| `AGENT_WATCHDOG_EFFORT` | enum `low\|medium\|high\|xhigh\|max` | `max` | Passed to the runtime as the effort option. |
| `AGENT_WATCHDOG_MODEL_FEEDBACK` | string | value of `MODEL` | Feedback-note parsing. |
| `AGENT_WATCHDOG_MODEL_CALIBRATION` | string | value of `MODEL` | Weekly calibration summary. |
| `AGENT_WATCHDOG_MODEL_DISTILL` | string | value of `MODEL` | Corpus distillation. |
| `AGENT_WATCHDOG_ENGINE` | enum `sdk\|cli` | `sdk` | `cli` shells out to `claude -p`; same agent definition (FR-050). |

## Bounds (every model interaction is capped; hard caps live in code)

| Variable | Type | Default | Hard cap in code | Notes |
|---|---|---|---|---|
| `AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT` | number | 2.00 | 10.00 | Per-project session budget, passed as `maxBudgetUsd`. |
| `AGENT_WATCHDOG_MAX_BUDGET_USD_RUN` | number | 25.00 | 100.00 | Whole run: projects, roll-up, feedback parsing. Enforced by the harness before each call. |
| `AGENT_WATCHDOG_MAX_TURNS` | integer | 20 | 50 | Passed as `maxTurns` per pass. |
| `AGENT_WATCHDOG_MODEL_TIMEOUT_MS` | integer | 900000 | 1800000 | Abort one analysis call after 15 minutes. |
| `AGENT_WATCHDOG_HTTP_TIMEOUT_MS` | integer | 15000 | 60000 | Grafana, Slack and link-resolution requests. |
| `AGENT_WATCHDOG_VERIFY_MAX_RETRIES` | integer | 2 | 2 | Gate failures returned to the model before degrading (FR-017). |
| `AGENT_WATCHDOG_PASSES` | integer | 2 | 4 | Analysis passes per project; minimum 1 (FR-056). |
| `AGENT_WATCHDOG_PASS_CONVERGENCE` | boolean | `true` | | Stop early when a pass changes nothing material (FR-057). |
| `AGENT_WATCHDOG_RUN_TIMEOUT_MS` | integer | 3600000 | 7200000 | Whole-run wall clock; on expiry the run finishes with what it has and says so (Edge Cases). |
| `AGENT_WATCHDOG_PROJECT_CONCURRENCY` | integer | 3 | 8 | Concurrent project sessions; keeps fifty projects inside the run budget. |

## Endpoints and identifiers

| Variable | Type | Notes |
|---|---|---|
| `AGENT_WATCHDOG_GRAFANA_URL` | URL | Hosted watchdog Grafana; also the host allow-listed for dashboard links. |
| `AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID` | string | Prometheus datasource proxied through Grafana. Required because a Viewer token may not list datasources; stock watchdog installs derive `PBFA97CFB590B2093` from the datasource name, and startup cross-checks the value against the dashboards' targets (research.md R-5). |
| `AGENT_WATCHDOG_SLACK_CHANNEL_ID` | string | Channel id of `#agents` (FR-047). One channel only (Out of Scope). |
| `AGENT_WATCHDOG_DOCS_MCP_URL` | URL | The documentation search service endpoint. |
| `LANGFUSE_BASE_URL` | URL | Tracing backend. The Langfuse v5 SDK reads this name; the earlier `LANGFUSE_HOST` was never read by any Langfuse SDK (research.md R-8). |
| `AGENT_WATCHDOG_PROMPTS_URL` | URL | Footer link to prompts in `cht-ai-tools`. |
| `AGENT_WATCHDOG_CONFIG_URL` | URL | Footer link to deployment configuration in `medic-infrastructure`. |

## Storage and retention

| Variable | Type | Default | Notes |
|---|---|---|---|
| `AGENT_WATCHDOG_DATA_DIR` | path | `/data` | Writable volume; layout in [run-directory.md](./run-directory.md). |
| `AGENT_WATCHDOG_CONFIG_DIR` | path | `/etc/agent-watchdog` | Read-only mount; files in [config-files.md](./config-files.md). |
| `AGENT_WATCHDOG_CORPUS_RAW_DIR` | path | `/data/knowledge-corpus/raw` | Raw corpus, outside the public repository (FR-037). |
| `AGENT_WATCHDOG_RETENTION_RAW_DAYS` | integer | 14 | Raw series and rendered images (FR-040). |
| `AGENT_WATCHDOG_RETENTION_DAYS` | integer | 30 | Everything else (FR-040). |

## Behaviour

| Variable | Type | Default | Notes |
|---|---|---|---|
| `AGENT_WATCHDOG_FEEDBACK_LOOKBACK_RUNS` | integer | 7 | N in FR-026. |
| `AGENT_WATCHDOG_MEMORY_MAX_TOKENS` | integer | 4000 | Memory cap (FR-031). |
| `AGENT_WATCHDOG_DRY_RUN` | boolean | `false` | Same as `--dry-run` (FR-025). |
| `AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` | integer | 30 | Days a feedback record adjusts ranking; hard cap 365 in code (FR-060). Records themselves are kept permanently (FR-059). |

## Logging, tracing, runtime

| Variable | Type | Default | Notes |
|---|---|---|---|
| `AGENT_WATCHDOG_LOG_LEVEL` | enum `trace\|debug\|info\|warn\|error` | `info` | |
| `AGENT_WATCHDOG_LOG_FORMAT` | enum `json\|pretty` | `json` | JSON lines on stderr. |
| `MCP_TIMEOUT` | integer ms | 30000 | Read by the agent runtime: MCP server startup wait. |
| `AGENT_WATCHDOG_CHROMIUM_PATH` | path | unset | Explicit Chromium executable for rendering; when unset the image's Playwright browser registry resolves it. |
| `AGENT_WATCHDOG_CLAUDE_PATH` | path | unset | Explicit `claude` executable for `AGENT_WATCHDOG_ENGINE=cli`; when unset, `claude` is resolved on PATH. |

## Set by the container image, not by the deployment

These are baked into the image as `ENV` and documented here so the deployment does not need to
repeat them: `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`
(writable scratch for the agent runtime; sessions are not persisted to it because the SDK is run
with `persistSession: false`), `NODE_ENV=production`. See [container.md](./container.md).

## Deliberately not configurable

The tool allow-list, disabled shell and web tools, permission handling, the verification gate,
the hard caps above, the link host allow-list and the secret patterns are code (constitution IV,
V; FR-054). No environment variable turns them off.

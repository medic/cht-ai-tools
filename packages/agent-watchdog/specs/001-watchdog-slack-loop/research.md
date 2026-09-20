# Research: Watchdog Slack Loop

**Feature**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md)

Every decision below was checked against current documentation or the installed artefacts on
2026-09-19, not from memory. Evidence classes: **installed** (the package or binary on this
machine), **live** (a call made to the service), **docs** (a documentation page fetched today),
**repo** (a source file fetched from GitHub today). Where documentation and installed artefacts
disagreed, the installed artefact of the version this plan targets wins and the disagreement is
noted. Items that can only be confirmed by running the model are listed under "Smoke tests" at
the end and become tasks.

## R-1. CommonJS package with ES-module dependencies

**Decision**: the package is CommonJS (`"type": "commonjs"`). `@anthropic-ai/claude-agent-sdk` is
loaded with `await import()` inside `src/agent/engine-sdk.js`; every other runtime dependency is
loaded with `require()`.

**Rationale**: the constitution (I) requires CommonJS like cht-core and cht-conf, and the Notes
already chose dynamic import for the SDK. Verified on Node 22.18.0 (installed) by installing each
candidate and loading it:

| Package | Version | Module type | `require()` | Note |
|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.278 | ESM-only: `exports["."].default = "./sdk.mjs"`, no `require` condition | works on 22.18 via Node's `require(esm)`; `import()` works | dynamic import is used, see below |
| `@slack/web-api` | 8.1.1 | CommonJS | ok | engines `>= 20` |
| `zod` | 4.6.5 | dual | ok; `z.toJSONSchema` is a function | |
| `handlebars` | 4.7.9 | CommonJS | ok | |
| `playwright-core` | 1.63.0 | CommonJS | ok | engines `>= 20`; no browser download |
| `yaml` | 2.9.1 | CommonJS | ok | dependency-free |
| `langfuse` | 3.39.2 | CommonJS | ok | see R-8 for the package line |
| `@langfuse/tracing`, `@langfuse/otel` | 5.11.1 | ESM (`type: module`) | ok on 22.18 | see R-8 |
| `chai` | 6.2.2 (4.x also tested) | 6 is ESM; 4 is CommonJS | both ok on 22.18 | see R-9 |
| `chai-as-promised` | 8.0.2 (7.x also tested) | 8 is ESM; 7 is CommonJS | both ok | see R-9 |
| `sinon` | 22.1.0 | ESM (`type: module`) | ok on 22.18 | |
| `mocha` | 12.0.2 | ESM (`type: module`), CLI | n/a | engines `^20.19 \|\| >=22.12` |
| `nyc` | 18.0.0 | CommonJS | ok | engines `20 \|\| >=22` |
| `eslint` | 10.11.0 | CommonJS | ok | flat config only; see R-9 |
| `@medic/eslint-config` | 1.2.0 | CommonJS; exports an eslintrc-style object (`extends: 'eslint:recommended'`, `env`, `rules`, `overrides`) | ok | peer `eslint >= 3`; see R-9 |

`process.features.require_module` is `true` on 22.18.0 and no warning was printed, so
`require()` of an ES module works on the target runtime. The SDK is still loaded with `import()`
because `require(esm)` throws for modules that use top-level `await` and is gated on Node minor
versions, while `import()` is stable on every Node 22 release.

**Alternatives considered**: converting the package to ESM (rejected: constitution I); relying on
`require(esm)` for the SDK (rejected: version-gated behaviour for a production dependency).

## R-2. Claude Agent SDK facts for the SDK engine

**Evidence**: installed `@anthropic-ai/claude-agent-sdk@0.3.278` (`sdk.d.ts`, `README.md`,
`manifest.json`, `package.json`) and its documentation at
https://code.claude.com/docs/en/agent-sdk/typescript (also served under
https://platform.claude.com/docs/en/agent-sdk/overview, which the package README links to).
Documentation pages consulted by the research agent: `/agent-sdk/sessions`,
`/agent-sdk/streaming-vs-single-mode`, `/agent-sdk/hooks`, `/agent-sdk/mcp`,
`/agent-sdk/cost-tracking`, `/agent-sdk/permissions`, `/agent-sdk/modifying-system-prompts`.

**Runtime packaging**: the SDK spawns a native Claude Code binary (runtime 2.1.278, matching the
SDK version's `manifest.json`) shipped as optional platform packages
`@anthropic-ai/claude-agent-sdk-{linux-x64,linux-arm64,linux-x64-musl,darwin-*,win32-*}`; the
linux-x64 package is 224 MB installed. `pathToClaudeCodeExecutable` overrides the lookup.
Runtime dependencies: `zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk ^1.29`.
Authentication in headless use is `ANTHROPIC_API_KEY` in the subprocess environment.

**Options verified in the type definitions** (names exact):

| Need | Option | Verified behaviour |
|---|---|---|
| No built-in tools | `tools: []` | "`[]` (empty array) - Disable all built-in tools"; `{ type: 'preset', preset: 'claude_code' }` is the full set |
| Enumerated tools | `allowedTools: string[]`, `disallowedTools: string[]` | MCP tools are named `mcp__<server>__<tool>`; `mcp__<server>__*` allows a whole server |
| Per-server tool policy | `mcpServers.<name>.tools: [{ name, permission_policy: 'always_allow' \| 'always_ask' \| 'always_deny' }]` | also `timeout` (ms, per call) and `alwaysLoad` |
| Remote MCP server | `mcpServers.<name> = { type: 'http', url, headers? }` | `sse` and `stdio` (`{ command, args, env }`) also exist; in-process servers via `createSdkMcpServer({ name, version, tools })` and `tool(name, description, zodRawShape, handler)` |
| Filesystem isolation | `settingSources: []` | "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include `'project'` to load CLAUDE.md files." |
| Permission handling | `permissionMode: 'dontAsk'` | values: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto` |
| Bounds | `maxTurns`, `maxBudgetUsd` | budget overrun returns a result with `subtype: 'error_max_budget_usd'` |
| Structured output | `outputFormat: { type: 'json_schema', schema }` | result carries `structured_output`; runtime retries invalid output and reports `error_max_structured_output_retries` |
| Multi-turn in one session | `query({ prompt: AsyncIterable<SDKUserMessage>, options })` | streaming input mode: the generator yields the next `{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }` after each `result`; `resume`, `continue`, `forkSession`, `resumeSessionAt` exist for persisted sessions |
| No session files | `persistSession: false` | default `true` writes to `CLAUDE_CONFIG_DIR/projects/` |
| Hooks | `hooks: { <HookEvent>: [{ matcher?, hooks: [callback], timeout? }] }` | callback `(input, toolUseID, { signal }) => Promise<HookJSONOutput>`; output fields `decision: 'approve' \| 'block'`, `reason`, `continue`, `stopReason`, `systemMessage`, `hookSpecificOutput` (`PostToolUse` → `additionalContext`; `PreToolUse` → `permissionDecision`, `updatedInput`); `StopHookInput.last_assistant_message` carries the final text; events include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit` and others |
| Subprocess environment | `env` | replaces the subprocess environment entirely; `process.env` must be spread in |
| Model, effort, thinking | `model`, `effort: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, `thinking`, `maxThinkingTokens` | effort values match `AGENT_WATCHDOG_EFFORT` |
| Prompt caching | `systemPrompt: string \| string[]` with the exported `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker | content before the marker gets global cache scope, content after is session-specific; the same marker line works in a `--system-prompt` string |
| Result message | `type: 'result'` | `subtype: 'success' \| 'error_during_execution' \| 'error_max_turns' \| 'error_max_budget_usd' \| 'error_max_structured_output_retries'`; fields `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage` (input, output, cache creation, cache read tokens), `session_id`, `result`, `structured_output`, `permission_denials`, `stop_reason`, `errors[]` on failures |
| Control | `Query.interrupt()`, `abortController` | used for the wall-clock bound |

**Decision**: the SDK engine opens one streaming-input `query()` per project with
`settingSources: []`, `tools: []`, `allowedTools` from `agent/tools.json`, `permissionMode:
'dontAsk'`, `strictMcpConfig: true`, `persistSession: false`, `outputFormat` from the findings
schema, `maxTurns`, `maxBudgetUsd`, `model`, `effort`, hooks from `agent/hooks.js`, and `env`
spread from `process.env` with `CLAUDE_CONFIG_DIR` pointing at writable scratch. Passes and gate
revisions are user turns on that one session ([contracts/agent-definition.md](./contracts/agent-definition.md)).

**Where documentation and artefacts disagreed**: the research agent, reading the docs, reported
`tools` as "not an SDK option" and could not find the default for `settingSources`; both are
present with doc comments in the installed `sdk.d.ts` and are used as stated above.

**Alternatives considered**: `resume` per pass with persisted sessions (rejected: writes session
files and needs a writable config directory for every pass; streaming input keeps the session in
memory); calling the Messages API directly (rejected in the Notes).

## R-3. The CLI face and the verification-hook adjustment

**Evidence**: `claude --help` of the installed `claude` 2.1.278 (installed), the version the SDK
bundles; CLI reference at https://code.claude.com/docs/en/cli-reference (docs).

**Verified flags**: `--bare` ("Minimal mode: skip hooks, LSP, plugin sync, attribution,
auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets
`CLAUDE_CODE_SIMPLE=1`. Anthropic auth is strictly `ANTHROPIC_API_KEY` … Explicitly provide
context via: `--system-prompt[-file]`, `--append-system-prompt[-file]`, `--add-dir`,
`--mcp-config`, `--settings`, `--agents`, `--plugin-dir`"); `--tools <tools...>` ("Use "" to
disable all tools"); `--allowed-tools` and `--disallowed-tools` (both spellings, camel and kebab);
`--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`);
`--json-schema <schema>` (inline JSON Schema for structured output); `--max-budget-usd`;
`--mcp-config <configs...>` and `--strict-mcp-config`; `--setting-sources <user,project,local>`;
`--no-session-persistence` (print mode only); `--input-format text|stream-json` and
`--output-format text|json|stream-json`; `--system-prompt`, `--system-prompt-snapshot`,
`--exclude-dynamic-system-prompt-sections`; `--resume`, `--continue`, `--fork-session`,
`--session-id`; `--model`, `--effort`; `--restricted` (removes command, code and web tools,
ignores user, project and local settings files while `--settings` still applies).
**Absent**: `--max-turns` does not exist in 2.1.278.

**Decision**: the CLI engine runs
`claude -p --bare --verbose --no-session-persistence --input-format stream-json --output-format stream-json
--system-prompt-file … --tools "" --allowed-tools … --permission-mode dontAsk --mcp-config …
--strict-mcp-config --json-schema … --model … --effort … --max-budget-usd …`, feeding pass and
revision turns over stdin so one process holds one session. The verification gate is called by
the harness after every `result` event on both engines, and again before publication; the SDK
engine also runs it inside the `Stop` hook. Turn caps on the CLI are enforced by the harness from
the event stream.

**Rationale**: the Notes asked for the CLI to load the same checks through `--settings`, but
`--bare` skips hooks by design, and the SDK's own type documentation confirms that under
`--bare`/`CLAUDE_CODE_SIMPLE` "settings-file, flag, policy, and plugin hooks never fire". A
harness-driven gate uses the same `src/verify/` code on both engines and removes the dependency on
hook surfaces altogether, which satisfies FR-018 and constitution V (one engine).

**Alternatives considered**: `--restricted` without `--bare`, with command hooks supplied through
`--settings` (viable: `--settings` still applies in restricted mode; rejected because it needs a
shell command hook per event and keeps a second, engine-specific gate path); dropping the CLI face
(rejected: FR-050 and US3 scenario 7).

**Correction recorded during implementation (2026-09-19)**: a live probe of the installed CLI 2.1.278
(`printf '' | claude -p --bare --no-session-persistence --input-format stream-json --output-format stream-json
--tools "" --permission-mode dontAsk --strict-mcp-config`) exited with "Error: When using --print,
--output-format=stream-json requires --verbose", a rule the help text does not state. The CLI engine
(`src/agent/engine-cli.js`) therefore always passes `--verbose`; the test fake (`test/helpers/fake-claude.js`)
enforces the same rule so the argument contract cannot regress. `--verbose` only widens what the stream
carries; the harness ignores everything but the message types the SDK engine already handles.

**Where documentation and artefacts disagreed**: the research agent reported `--disallowed-tools`,
`--setting-sources` and `--strict-mcp-config` as not found and `--no-session-persistence` as
SDK-only; all four are in the installed CLI's help. It reported `--max-turns` as present; it is
not in 2.1.278.

## R-4. cht-docs-mcp tool names and result shape

**Evidence**: live calls from this session to the CHT documentation MCP service on 2026-09-19.

| Tool | Input | Result (single Markdown text block) |
|---|---|---|
| `search_docs` | `{ query: string, maxResults?: integer }` | Repeated sections: a bold `**<Page title>\|<Section>**` line, a breadcrumb heading block (`# Hosting` / `## …`), the section text, then `Source: <url>` and a `---` separator |
| `ask_question` | `{ question: string, threadId?: string }` | A synthesised Markdown answer with inline citations `[[Title](url)]`, a `**Sources:**` list of `[Title](url)` links, then `**Thread ID:**` and `**Question Answer ID:**` |
| `get_sources` | `{}` | A Markdown list `- <type>: <name>`; types seen: `github_files`, `github_issues`, `github_pull_requests`, `github_discussions`, `discourse` (Community Forum), `scrape` (Documentation), `custom_qa` (Corrected Responses) |

The source list already includes `cht-watchdog` files, issues and pull requests, so the spec's
assumption that Medic is adding the watchdog repository is satisfied today. Under the SDK the
tools are `mcp__cht-docs__search_docs`, `mcp__cht-docs__get_sources` and
`mcp__cht-docs__ask_question` when the server is registered as `cht-docs`.

**Decision**: allow `search_docs` and `get_sources`; deny `ask_question` through the per-server
tool policy so provenance stays first-hand (the Notes). The gate's `links_allowlisted` check
collects candidate URLs from tool results with two patterns, `Source: <url>` lines and Markdown
`](url)` links, and an item's `reference_urls` must be a subset of that set.

**Content confirmed through the service** (docs at https://docs.communityhealthtoolkit.org/hosting/monitoring/setup/
and https://docs.communityhealthtoolkit.org/hosting/monitoring/introduction/): CHT Watchdog is
supported on CHT 3.12 and later including 4.x and 5.x; its json_exporter probes each instance at
`/api/v2/monitoring?connected_user_interval=30` without authentication; instances are listed in
`cht-instances.yml` as a Prometheus file-discovery document (`- targets: [<urls>]`); the
documentation includes a "CHT Watchdog Dashboards & Metrics Reference" page at
https://docs.communityhealthtoolkit.org/hosting/monitoring/dashboards/. Metric names are settled
in R-6.

**Alternatives considered**: allowing `ask_question` (rejected: synthesised answers hide which
source said what, and the gate cannot verify a paraphrase).

## R-5. Reading the hosted watchdog through Grafana

**Evidence**: Grafana HTTP API documentation (legacy API pages for data sources, search,
annotations, authentication, service accounts, roles and permissions), Grafana source at tag
v12.3.3 (the version cht-watchdog pins) and `main`, Prometheus HTTP API documentation and source,
and the `grafana/scenes` source for URL parameters (docs, repo). Not exercised against a live
Grafana with a Viewer token; `smoke/grafana.js` does that and is a task.

**Findings**:
- Grafana labels every `/api` endpoint legacy from Grafana 13 in favour of `/apis`, while stating
  they "remain fully accessible and operative"; the hosted watchdog pins Grafana OSS 12.3.3.
- The datasource proxy `ANY /api/datasources/proxy/uid/:uid/<path>` forwards method, query string
  and body to the datasource and requires the `datasources:query` action. The numeric-id proxy
  form is deprecated (gated behind a default-off feature flag on `main`) and is not used.
- `POST /api/ds/query` also needs `datasources:query`; its body is `{ from, to, queries: [{ refId,
  datasource: { type: 'prometheus', uid }, expr, range | instant, intervalMs, maxDataPoints,
  legendFormat }] }` and it answers with data frames (`schema.fields`, `data.values`, millisecond
  timestamps). Prometheus-only endpoints (`/api/v1/targets`, `/series`, `/labels`,
  `/label/<name>/values`) are reachable only through the proxy.
- Prometheus API through the proxy: envelope `{ status, data, errorType, error, warnings }`;
  `GET /api/v1/query_range?query&start&end&step` with RFC 3339 or Unix-second timestamps, `step` as
  a duration or seconds, `start` and `end` inclusive; `GET /api/v1/query?query&time`;
  `GET /api/v1/series?match[]=`; `GET /api/v1/label/<name>/values`; `GET /api/v1/targets?state=active`
  returning `data.activeTargets[] { labels, scrapePool, scrapeUrl, lastError, lastScrape,
  lastScrapeDuration, health }` with `health` in `up`, `down`, `unknown`. Sample values are quoted
  strings; a matrix result is `[{ metric, values: [[unix_seconds, "value"], …] }]`.
- Dashboards: `GET /api/search?type=dash-db&limit=5000` returns `{ uid, title, url, type, tags,
  folderUid, folderTitle }`; `GET /api/dashboards/uid/:uid` (route present in 12.3.3 and `main`
  although its legacy documentation page has been removed; needs `dashboards:read`) returns
  `{ meta, dashboard }` where `dashboard.panels[]` carry `id`, `type`, `title`, `gridPos`,
  `datasource: { type, uid }`, `targets: [{ refId, expr, legendFormat, datasource }]` and nested
  `panels` inside `row` panels, and `dashboard.templating.list[]` carry `name`, `type`, `label`,
  `query`, `current`, `regex`, `multi`, `includeAll`, `hide`. `/api/dashboards/db/:slug` no longer
  exists.
- Annotations: `GET /api/annotations?from=<ms>&to=<ms>&dashboardUID=&panelId=&tags=&type=&limit=`
  (needs `annotations:read`, which the Viewer basic role has) returns `{ id, dashboardUID,
  panelId, time, timeEnd, text, tags, userName }`.
- Datasources: `GET /api/datasources` needs `datasources:read`; on OSS Grafana every provisioned
  datasource grants the Viewer role query and read permissions, so a Viewer token should list
  them, but that is inferred from source and not live-tested. The stock watchdog provisioning
  gives the Prometheus datasource no explicit uid, so Grafana derives `PBFA97CFB590B2093` from the
  name "Prometheus", which is also the uid hard-coded in every provisioned dashboard's targets.
- Authentication: `Authorization: Bearer <service-account token>`; optional `X-Grafana-Org-Id`.
  Service accounts are created in the UI or with `POST /api/serviceaccounts { name, role:
  'Viewer' }` and `POST /api/serviceaccounts/:id/tokens { name, secondsToLive }`; a token can
  introspect itself with `GET /api/access-control/user/permissions`. Viewer can view dashboards,
  query datasources directly and read annotations, and cannot manage datasources.
- Deep links: `/d/<uid>/<slug>?orgId=1&from=<ms|now-24h>&to=<ms|now>&timezone=utc&var-<name>=<value>`
  is documented (`var-` prefix, repeated `var-x=` for several values, `from`, `to`, `timezone`);
  `viewPanel` and `kiosk` are not documented as URL parameters, but the 12.3.3 source resolves
  both `viewPanel=panel-<id>` and the legacy `viewPanel=<id>`, and `kiosk` or `kiosk=1` enters
  full kiosk mode. The watchdog's `cht_instance` variable is single-valued. The "CHT Admin
  Details" dashboard contains four panels that share `id: 2`, so a panel link there is ambiguous.

**Decision**: `src/collect/grafana.js` talks to Grafana only. PromQL and Prometheus endpoints go
through the datasource proxy with the uid from `AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID`
(documented default for stock installs `PBFA97CFB590B2093`; startup cross-checks it against the
`targets[].datasource.uid` of the priority-list dashboards and exits 78 on mismatch); the
priority list and panel expressions come from `GET /api/search` and `GET /api/dashboards/uid/:uid`;
dashboard annotations in the window come from `GET /api/annotations`; scrape-target health comes
from `/api/v1/targets` through the proxy. Requests use `fetch` with the bearer header and
`AGENT_WATCHDOG_HTTP_TIMEOUT_MS`. The link builder emits
`/d/<uid>/<slug>?orgId=1&from=<ms>&to=<ms>&timezone=utc&var-cht_instance=<host>` and appends
`&viewPanel=panel-<id>` only when the panel id is unique on that dashboard; the gate resolves a
Grafana link by confirming the dashboard uid and panel id exist in the collected dashboard JSON
rather than by fetching the UI page, which would redirect to login. Raw Prometheus JSON is what the
fixtures record.

**Alternatives considered**: `POST /api/ds/query` (rejected: cannot reach targets, series or
labels, and its frames would need converting before analysis and in every fixture); talking to
Prometheus directly (rejected in the Notes: it is not exposed).

## R-6. The cht-watchdog metric catalogue and readiness facts

**Evidence**: `medic/cht-watchdog` `main` (commit `831abfe7`, 2026-08-22; latest tag 1.23.1):
`docker-compose.yml`, `.env.example`, `cht-instances.example.yml`,
`exporters/json/config/scrape_config.yml`, `exporters/json/config/cht.yml`,
`prometheus/config/prometheus.yml`, `grafana/provisioning/datasources/cht.yml`,
`grafana/provisioning/dashboards/CHT/*.json`, `grafana/provisioning/alerting/cht.yml`;
`prometheus-community/json_exporter` v0.7.0; `medic/cht-core` `master` routing and monitoring
controller; CHT docs pages under https://docs.communityhealthtoolkit.org/hosting/monitoring/
(repo, docs).

**Findings**:
- Components: Prometheus v3.9.1, Grafana OSS 12.3.3, json_exporter v0.7.0; optional sql_exporter
  and `cht-user-management` metrics. Prometheus retention defaults to 60 days. Global scrape
  interval is 5 minutes (since watchdog 1.21.0); the Grafana datasource declares `timeInterval: 1m`.
- Instances are the `- targets:` list in `cht-instances.yml`. The `cht` job probes json_exporter
  with `target=<url>/api/v2/monitoring?connected_user_interval=30` and rewrites the `instance`
  label to the bare host (scheme, `www.` and trailing slash stripped), so `instance` is
  `gamma.dev.medicmobile.org`, not a URL. A second job, `cht-express-metrics`, scrapes
  `https://<host>/api/v1/express-metrics` for the `cht_api_*` metrics (CHT 4.3.0 or later).
- `up{job="cht", instance="<host>"}` is 0 when json_exporter cannot fetch the monitoring endpoint
  (it answers HTTP 503), so it is the scrape-target-down signal; the watchdog's own provisioned
  alert "API Server Down" is `up{job="cht"}` for 30 minutes.
- Metrics emitted by the `cht` job (every series also carries `instance` and `job`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `cht_version` | gauge (1) | `app`, `node`, `couchdb` | Versions as labels |
| `cht_conflict_count` | gauge | | Doc conflicts needing manual resolution |
| `cht_connected_users_count` | gauge | | Connected users in the interval |
| `cht_couchdb_doc_total`, `cht_couchdb_doc_del_total` | counter | `db` in `medic`, `sentinel`, `medic-users-meta`, `_users` | Documents and deletions |
| `cht_couchdb_fragmentation` | gauge | `db` | |
| `cht_couchdb_size_bytes` | gauge | `db`, `type` in `active`, `file` | CHT 4.11.0 or later |
| `cht_couchdb_update_sequence` | counter | `db` | |
| `cht_couchdb_view_index_size_bytes` | gauge | `db`, `view_index`, `type` | CHT 4.11.0 or later |
| `cht_couchdb_nouveau_index_size_bytes` | gauge | `db`, `nouveau_index`, `type` | |
| `cht_date_current_millis`, `cht_date_uptime_seconds` | counter | | Server time and uptime |
| `cht_feedback_total` | counter | | Feedback docs, usually client-side errors |
| `cht_messaging_outgoing_last_hundred` | gauge | `group`, `status` | Recent outgoing messages by state |
| `cht_messaging_outgoing_total` | counter | `status` in `due`, `scheduled`, `muted`, `failed`, `delivered` | |
| `cht_outbound_push_backlog_count` | gauge | | Changes not yet processed by Outbound Push |
| `cht_replication_limit_count` | gauge | | Users over the replication limit |
| `cht_sentinel_backlog_count` | gauge | | Changes not yet processed by Sentinel |
| `up` | gauge | `job`, `instance` | Scrape health per job |

- Provisioned dashboards (folder "CHT", not editable in the UI) and their uids: "CHT Admin
  Overview" `oa2OfL-Vk` (panels include 2 Outbound Push Backlog, 3 Sentinel Backlog, 7 DB
  Conflicts Rate, 8 DB Growth Rate, 12 CHT Version Info, 13 DB Fragmentation, 14 Client
  Feedback/Error Rate, 16 CHT Uptime, 19 Server Time Accurate, 21 Users Over Replication Limit,
  23 Monthly Active Users, 27 Message Delivery Rate, 50 CHT Sync Backlog, 47 Alerts); "CHT Admin
  Details" `hkQUbyfVk`; "CHT API Server" `3J_78b6Zz` (CHT 4.3+); "CHT Replication"
  `d4f05050-804e-4ea4-9642-4d088cc39a1b` (CHT 4.3+); "UMT Server" `eeflt877fb9j4a` (a different
  instance variable). The four CHT dashboards select an instance with the single-valued variable
  `cht_instance`, populated from `query_result(up{job=~"cht"})`, and filter every expression with
  `instance=~"$cht_instance"`.
- Provisioned alert rules cover fragmentation, outbound push backlog, sentinel backlog, server
  time, replication limit, API server down, feedback rate, conflicts rate and message delivery,
  all pointing at `oa2OfL-Vk`; this is the "existing monitoring stack" that keeps paging.
- Version facts for readiness: the monitoring API v1 exists since CHT 3.9.0 and is deprecated in
  cht-core in favour of v2; v2 exists since 3.12.0 and needs no authentication; the docs state
  watchdog support for CHT 3.12 and later including 4.x and 5.x; `cht_api_*` needs 4.3.0;
  CouchDB size metrics need 4.11.0. The repository ships no host-metrics exporter; the docs
  describe cAdvisor on the CHT host behind Caddy on port 8443, scraped by an extra compose file
  and visualised with Grafana dashboard 193.

**Decisions**:
- Project identity is the `instance` label value, a bare host; the canonical URL is
  `https://<host>` (the production docs require TLS). `projects.yaml` is keyed by host.
- Threshold metric roles: `scrape_target` is `up{job="cht"}`; `outbound_push_backlog` is
  `cht_outbound_push_backlog_count`; `sentinel_backlog` is `cht_sentinel_backlog_count`.
- The default priority list (`config/defaults/dashboards.yaml`) is `oa2OfL-Vk`, `hkQUbyfVk`,
  `3J_78b6Zz`, `d4f05050-804e-4ea4-9642-4d088cc39a1b`, in that order; the UMT dashboard is
  excluded because it does not select by `cht_instance`.
- Window queries use a 300-second step for the 24-hour windows to match the scrape interval, and
  the trailing 14-day window is queried as daily aggregates with `max_over_time(<expr>[1d])` at
  an 86400-second step; a project has "fewer than fourteen days of history" when the trailing
  query returns fewer than 14 daily points.
- CHT version per project (FR-005) is read from the `app`, `node` and `couchdb` labels of
  `cht_version`.
- The readiness check (FR-048) fetches `https://<host>/api/v2/monitoring`, reads `version.app`,
  requires 3.12.0 or later, reports 4.3.0 (API metrics) and 4.11.0 (CouchDB size metrics) as
  informational, and probes `https://<host>:8443/metrics` only when `projects.yaml` marks the
  project `host_metrics: true`.

**Alternatives considered**: keying projects by full URL (rejected: the metrics store records the
host, and the spec's "URL as recorded in the metrics store" resolves to it); using
`cht-express-metrics` as the scrape-target signal (rejected: only present on CHT 4.3+ and not
the endpoint the watchdog's own alert watches).

## R-7. Rendering the brief image with playwright-core

**Evidence**: `playwright-core` 1.63.0 tarball and https://playwright.dev/docs/library,
https://playwright.dev/docs/api/class-browsertype, https://playwright.dev/docs/api/class-locator,
https://playwright.dev/docs/docker and the `Dockerfile.noble` source (docs, repo).

**Decision**: install Chromium headless shell at image build with
`npx playwright-core install --with-deps chromium-headless-shell` into
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`; launch `chromium.launch({ headless: true })`, or with
`executablePath: process.env.AGENT_WATCHDOG_CHROMIUM_PATH` when a contributor points at a system
browser; create the context with `javaScriptEnabled: false` and `offline: true`; abort every
request with `page.route('**/*', route => route.abort())`; load the filled template with
`page.setContent(html, { waitUntil: 'load' })`; capture `page.locator('#brief-summary').screenshot({
type: 'png' })`. `TMPDIR` must be writable (Playwright creates `playwright-artifacts-*` and a
profile directory under `os.tmpdir()`).

**Rationale**: `playwright-core` has no install scripts and downloads no browser, so the browser
must be provisioned explicitly; installing it through Playwright's own installer keeps browser and
library versions in lockstep, which the Playwright docs treat as the supported configuration.
Playwright passes `--no-sandbox` unless `chromiumSandbox: true` and `--disable-dev-shm-usage` by
default, which suits a non-root container with a small `/dev/shm`. JavaScript is not needed by the
template, and disabling it plus aborting all requests makes the rendered page inert even though it
contains escaped untrusted text.

**Alternatives considered**: the official `mcr.microsoft.com/playwright:v1.63.0-noble` image
(rejected: it defaults to Node 24 and the constitution pins Node 22); Debian's `chromium` package
(rejected: its version drifts independently of Playwright's supported build); a server-side chart
library without a browser (rejected in the Notes: the image must come from the same report).

## R-8. Tracing with Langfuse

**Evidence**: npm registry metadata and tarballs for `langfuse` 3.39.2, `@langfuse/tracing`,
`@langfuse/otel`, `@langfuse/client` 5.11.1; https://langfuse.com/docs/observability/sdk/typescript/overview,
`/setup`, `/instrumentation`, and the upgrade guides `/upgrade-path/js-v3-to-v4` and
`/upgrade-path/js-v4-to-v5` (docs).

**Finding**: the classic `langfuse` package (v3) is still published, but its own npm description
reads "NOT the latest Langfuse JS/TS SDK. Deprecated v3 client … For new work: npm install
@langfuse/tracing @langfuse/otel @opentelemetry/sdk-node". The current line is v5, built on
OpenTelemetry; all v5 packages expose a `require` entry and load from CommonJS on Node 22 (verified
empirically). Neither line reads `LANGFUSE_HOST`: v3 reads `LANGFUSE_BASEURL`, v5 reads
`LANGFUSE_BASE_URL` (and falls back to the old spelling).

**Decision**: use the v5 packages `@langfuse/tracing`, `@langfuse/otel` and
`@opentelemetry/sdk-node`, with `@langfuse/client` only for `getTraceUrl(traceId)`. One
`LangfuseSpanProcessor({ exportMode: 'immediate' })` in a `NodeSDK`; the run is a root observation
under `propagateAttributes({ traceName: 'daily-brief', sessionId: run_id, tags, metadata })`; one
child span per stage; one `generation` observation per model call carrying `model`,
`modelParameters`, `usageDetails` (input, output, cache read, cache creation tokens) and
`costDetails` (USD) taken from the runtime's result message; `forceFlush()` and `shutdown()` before
exit. The footer link is the value of `getTraceUrl(traceId)`, fetched once per run. The
environment variable is `LANGFUSE_BASE_URL`; `.env.example` currently names `LANGFUSE_HOST` and
must be corrected.

**Rationale**: building new code on a client that calls itself deprecated fails the constitution's
"boring" test; the v5 packages are CommonJS-compatible, current, and their span processor is
designed for short-lived processes. The user's stack list named `langfuse`; this decision keeps
the vendor and changes only the package line, on the vendor's own instruction.

**Alternatives considered**: `langfuse` v3 (rejected: self-described deprecated client, though it
would have been the smaller dependency); `@langfuse/tracing` v4 (rejected: superseded, documented
only as a snapshot).

## R-9. Lint and test tooling versions

**Evidence**: `medic/cht-core` `master` `package.json` and `eslint.config.js`; `medic/cht-conf`
`main` `package.json` and `.eslintrc`; `medic/eslint-config` `master` sources; npm registry (repo,
docs).

**Findings**: `@medic/eslint-config` 1.2.0 exports a legacy eslintrc-format object (`extends:
'eslint:recommended'`, `env`, `rules`, `overrides`) with peer `eslint >= 3`; cht-core uses ESLint 9
flat config and wraps it with `@eslint/eslintrc`'s `FlatCompat` (`compat.extends('@medic')`);
cht-conf still uses ESLint 8 with a legacy `.eslintrc`. Pinned test tooling: cht-core `chai ^4.3.8`,
`chai-as-promised ^7.1.1`, `mocha ^11.7.4`, `sinon ^21.0.1`, `sinon-chai ^3.7.0`, `nyc ^17.1.0`,
engines `node >=22.15.0`; cht-conf `chai ^4.5.0`, `chai-as-promised ^7.1.2`, `mocha ^11.7.5`,
`sinon ^21.0.0`, `sinon-chai ^3.7.0`, `nyc ^17.1.0`. chai 5 and later, chai-as-promised 8 and
sinon-chai 4 are ES-module-only; they load from CommonJS only through Node's `require(esm)` (no
flag from 22.12, no warning from 22.13).

**Decision**: follow cht-core. `eslint ^9` with `eslint.config.js` (CommonJS) wrapping
`@medic/eslint-config` through `@eslint/eslintrc` `FlatCompat`, plus the `max-len` 120 and
`no-console` rules the shared config already sets. `chai ^4.5`, `chai-as-promised ^7.1`,
`sinon-chai ^3.7`, `sinon ^21`, `mocha ^11`, `nyc ^17`, all CommonJS-native, so the test suite does
not depend on `require(esm)`. `engines.node >=22.15.0` and `.nvmrc` `22`.

**Rationale**: constitution I asks for the package to be indistinguishable from cht-core and
cht-conf; cht-core is the newer of the two configurations and already solves the flat-config
wrapping. Staying on CommonJS-native test libraries avoids a dependency on Node's `require(esm)`
semantics in the test runner.

**Alternatives considered**: ESLint 10 (rejected: cht-core is on 9; 10 removes the eslintrc
compatibility path entirely); chai 6 through `require(esm)` (rejected: works on 22.18 but not on
the cht-core baseline of 22.15 without a warning-free guarantee); `.eslintrc` with ESLint 8 like
cht-conf (rejected: older line).

## R-10. Slack publishing: upload, image block, message, metadata

**Evidence**: https://docs.slack.dev/tools/node-slack-sdk/web-api/, the `@slack/web-api` 8.1.1
source (`WebClient.ts`, `file-upload.ts`),
https://docs.slack.dev/reference/methods/files.getUploadURLExternal,
https://docs.slack.dev/reference/methods/files.completeUploadExternal,
https://docs.slack.dev/reference/methods/files.upload,
https://docs.slack.dev/reference/block-kit/blocks/image-block,
https://docs.slack.dev/reference/block-kit/composition-objects/slack-file-object,
https://slack.com/blog/developers/uploading-private-images-blockkit,
https://docs.slack.dev/reference/methods/chat.postMessage,
https://docs.slack.dev/reference/methods/chat.getPermalink,
https://docs.slack.dev/messaging/message-metadata/ (docs).

**Findings**: `files.uploadV2` wraps `files.getUploadURLExternal`, the upload, and
`files.completeUploadExternal`; single-file parameters are `channel_id`, `file` (path, Buffer or
stream), `filename`, `title`, `alt_text`, `initial_comment`, `thread_ts`; the result nests one
completion per channel or thread, so the file id is `result.files[0].files[0].id`. `files.upload`
was sunset on 12 November 2025. The `image` block accepts `slack_file: { id }` or `{ url }` (not
both), `alt_text` is required, only png, jpg, jpeg and gif are supported, and "the user posting
these blocks must have access to this file"; files uploaded without `channel_id` are private to
the token holder, which is sufficient when the same bot token posts the message. `chat.postMessage`
accepts `blocks` (up to 50), `text` as fallback, `thread_ts`, `unfurl_links`, `unfurl_media` and
`metadata` (`event_type`, `event_payload`), but metadata schemas must be registered in the app
manifest or Slack ignores them with a warning. Per-message `username` needs `chat:write.customize`.
`chat.getPermalink` needs no scope.

**Decision**: upload the image privately with the bot token and reference it by id in an `image`
block; post the parent with a fallback `text`, `unfurl_links: false`, and registered
`agent_watchdog.brief` metadata; post one threaded reply per item with `agent_watchdog.item`
metadata carrying the stable `item_id`; record permalinks. The bot display name `agent-watchdog` is
set once in the app configuration, so `chat:write.customize` is not requested. Details in
[contracts/slack-payload.md](./contracts/slack-payload.md).

**Alternatives considered**: sharing the upload into the channel with `channel_id` (rejected:
creates a second file message beside the brief); hosting the image elsewhere and using `image_url`
(rejected: no hosting exists yet, Out of Scope); identifying items by parsing reply text instead of
metadata (kept only as the fallback).

## R-11. Slack reading: replies, reactions, rate limits, scopes

**Evidence**: https://docs.slack.dev/reference/methods/reactions.get,
https://docs.slack.dev/reference/methods/conversations.replies,
https://docs.slack.dev/reference/methods/conversations.history,
https://docs.slack.dev/apis/web-api/rate-limits,
https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps,
https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity (docs).

**Findings**: `reactions.get({ channel, timestamp, full: true })` returns
`message.reactions[] { name, users[], count }` and `full` forces the complete list; `users` may
otherwise be incomplete while `count` is always right. `conversations.replies({ channel, ts,
cursor, limit, include_all_metadata })` returns the parent first, then replies with `thread_ts`
and `parent_user_id`, paginated by `response_metadata.next_cursor`. `conversations.history`
carries `reactions[]` on reacted messages and `bot_id`, `app_id` and `metadata` with
`include_all_metadata=true`. The May 2025 rate-limit change (one request per minute, `limit`
capped at 15) applies to newly created non-Marketplace apps that are commercially distributed;
internal customer-built apps keep Tier 3 (50+ per minute) and the normal limits. Scopes: `chat:write`,
`files:write`, `reactions:read`, `channels:history` (`groups:history` for private channels); no
`files:read`, `channels:read` or `groups:read` is needed for this flow; posting and reading require
channel membership.

**Decision**: drive reads from the `ts` values stored in each run's `publication.json`: one
`conversations.replies` call (paged) per previous parent, one `reactions.get` with `full: true` per
bot message, `conversations.history` only as the fallback when a publication record is missing.
Map `+1`/`thumbsup` to `up`, `-1`/`thumbsdown` to `down`, absent-but-previously-recorded reactions
to `retracted`. Request the four scopes above and invite the bot to `#agents`.

**Alternatives considered**: scanning `conversations.history` every run (rejected: unnecessary
calls and dependence on message ordering); trusting embedded `reactions[]` without `reactions.get`
(rejected: user lists may be incomplete and FR-028 needs the author).

## R-12. Releasing from a monorepo package

**Evidence**: npm registry for `semantic-release` 25.0.9; https://semantic-release.org/support/faq/
(no monorepo entry); https://github.com/semantic-release/npm (`pkgRoot`); `medic/cht-conf`
`.releaserc.json` and `medic/eslint-config` `release.config.js` (repo, docs).

**Findings**: official semantic-release documentation has no monorepo guidance; the only official
lever is `@semantic-release/npm`'s `pkgRoot`. cht-conf and eslint-config are single-package repos
using commit-analyzer, release-notes-generator, changelog, git and github plugins.

**Decision**: run semantic-release from `packages/agent-watchdog` with `tagFormat:
'agent-watchdog-v${version}'`, the cht-conf plugin set minus npm publishing (the artefact is a
container image), and `@semantic-release/exec` to build and push the image tagged with the
released version. Commit scoping to the package path is done with the widely used
`semantic-release-monorepo` plugin. Because that plugin is third-party and not covered by official
documentation, the first implementation task for releases is a dry-run spike (`semantic-release
--dry-run`) that confirms only commits under the package path are analysed; if it fails, the
fallback is a GitHub Actions workflow filtered on `paths: packages/agent-watchdog/**` that runs
plain semantic-release with the custom tag format.

**Alternatives considered**: `multi-semantic-release` (rejected: designed for releasing several
packages together, which the repository does not need yet); manual tags (rejected by constitution I).

## Smoke tests: behaviours only a live run can confirm

Each item becomes a `smoke/` script and a task. None runs in the unit-test suite.

| Id | What to confirm | Why it cannot be read from types or docs |
|---|---|---|
| S-1 | With `outputFormat` set, a streaming-input SDK session yields `structured_output` on the `result` message of every turn, not only the last | Multi-turn structured output is not stated in the type definitions |
| S-2 | The `Stop` hook fires per turn in streaming-input mode and `last_assistant_message` carries the structured JSON | Hook timing in multi-turn sessions is undocumented |
| S-3 | `claude -p --bare --input-format stream-json --output-format stream-json --json-schema …` accepts several user messages on stdin and emits one `result` event per turn with structured output | CLI multi-turn structured output is undocumented |
| S-4 | The Anthropic structured-output implementation accepts `findings.schema.json` and `brief.schema.json` as written (`$ref`, `$defs`, `enum`, nullable unions) | The supported JSON Schema subset was not verified this session |
| S-5 | SDK hooks still fire when the subprocess environment sets `CLAUDE_CODE_SIMPLE=1`; if not, bare semantics are obtained from `settingSources: []` and `tools: []` alone | The type documentation says "session hooks still run" under bare mode but does not define session hooks |
| S-6 | A Viewer service-account token on the hosted watchdog can call the datasource proxy (`query_range`, `targets`), `GET /api/search`, `GET /api/dashboards/uid/:uid`, `GET /api/annotations`, and whether it can call `GET /api/datasources` | Permission behaviour was inferred from source |
| S-7 | `viewPanel=panel-<id>` opens the panel on Grafana 12.3.3 and the link resolves with `var-cht_instance` | Parameter is undocumented |
| S-8 | A file uploaded privately with `files.uploadV2` renders in `#agents` through an `image` block with `slack_file.id`, and registered metadata round-trips through `conversations.replies` with `include_all_metadata` | Rendering and metadata registration are only observable live |
| S-9 | Langfuse v5 `getTraceUrl(traceId)` returns a link that opens the run's trace, and `forceFlush` completes before exit in the container | Network behaviour |
| S-10 | `smoke/agent-parity.js`: one recorded project through both engines produces identical `findings.pass<n>.json` after gate normalisation | The whole point of FR-050 |
| S-11 | `smoke/render.js` inside the image with a read-only root filesystem and writable `/tmp` and `/data` only | Playwright's writable-directory needs beyond `TMPDIR` are undocumented |
| S-12 | `semantic-release --dry-run` from the package directory analyses only commits under `packages/agent-watchdog` | Third-party plugin behaviour |
| S-13 | `reactions.add` with `name: eyes` under the `reactions:write` scope: the reaction appears, a repeat reports `already_reacted` without failing, and a token lacking the scope logs `missing_scope` while the digest still posts (R-13) | Scope and error names not re-fetched from the Slack reference in this session |
| S-14 | A Viewer service-account token on the hosted watchdog reads `GET /api/prometheus/grafana/api/v1/rules` and `/alerts`; the instance `state` strings and the paging parameters behind `groupNextToken` match R-14 | Grant and response casing read from source, not exercised live |
| S-15 | An alert-list link `<grafana>/alerting/list?search=…` built by code opens the rule list filtered by `rule:` and `label:instance=~` terms | Page path and parameter behaviour read from front-end source, not documented |
| S-16 | Sub-bullets rendered as indented `◦` lines inside a bullet's `section` block display legibly in Slack desktop and mobile | Leading whitespace in `mrkdwn` is undocumented |
| S-17 | `smoke/grafana.js --project <host>` collects every window of every per-project panel of the hosted dashboards without one `query failed` window: derived expressions in the trailing subquery form and `$interval` resolved to the dashboard's value | The first preview run showed the fake accepted queries Prometheus rejects; only the hosted proxy proves the resolved forms |
| S-18 | On the hosted watchdog, from the eighth consecutive daily run, `collect.project` reports `fetched` equal to the metric count, `reused` three times that, no trailing query, and the collect stage under fifteen minutes in `run.json` | Reuse depends on the real run cadence, retention and proxy timings |

## Corrections this research makes to files outside `specs/`

- `.env.example` (applied 2026-09-19): `LANGFUSE_HOST` renamed to `LANGFUSE_BASE_URL` (R-8);
  `AGENT_WATCHDOG_RUN_TIMEOUT_MS`, `AGENT_WATCHDOG_PROJECT_CONCURRENCY` and the optional
  `AGENT_WATCHDOG_CHROMIUM_PATH` added; `AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT` and
  `AGENT_WATCHDOG_MAX_BUDGET_USD_RUN` given their documented defaults (2.00 and 25.00).
- Spec "Notes for `/speckit.plan`": the verification note's CLI wording (checks loaded through
  `--settings`) is superseded by R-3; the note is otherwise adopted.

## R-13. Slack reactions as the "seen" signal (User Story 7)

**Evidence**: the installed `@slack/web-api` 8.x type definitions
(`dist/types/request/reactions.d.ts`: `ReactionsAddArguments extends MessageArgument,
TokenOverridable, ReactionName`, so the call is `reactions.add({ channel, timestamp, name })`);
the Slack method reference for `reactions.add` as previously consulted for R-11 (docs). The scope
name `reactions:write` and the `already_reacted` error name are from that reference and were
not re-fetched in this session; they are confirmed by smoke test S-13 below before the scope is
requested in production.

**Decision**: after the digest is posted, one `reactions.add` per acknowledged note with
`name: 'eyes'`; `already_reacted` is treated as success, any other error is logged and never
fails the run; nothing is reacted to in preview mode. The bot token gains `reactions:write`.

**Rationale**: the digest is the record; the reaction is a cheap per-note signal the author sees
without opening the thread, chosen over a reply per note, which would flood the channel and cost
one message per reaction.

**Alternatives considered**: a reply per note (rejected: noise and rate limits); no per-note
signal (the default recommendation, overridden by the operator's decision recorded in the spec's
clarifications).

- **S-13**: in the test channel, acknowledge a note and confirm the `eyes` reaction appears, a
  repeated run reports `already_reacted` without failing, and a token without `reactions:write`
  yields a logged `missing_scope` while the digest still posts.

## R-14. Grafana-managed alerting on the hosted watchdog (User Stories 8 and 9)

**Evidence**: cht-watchdog `grafana/provisioning/alerting/cht.yml` on `main` (fetched 2026-09-19);
Grafana source at tag v12.3.3: `pkg/services/ngalert/api/authorization.go` (route evaluators),
`pkg/services/ngalert/accesscontrol.go` (fixed roles and their grants),
`pkg/services/ngalert/api/tooling/definitions/prom.go` (response types),
`public/app/features/alerting/unified/hooks/useFilteredRules.ts` and
`public/app/features/alerting/unified/search/rulesSearchParser.ts` (list-page URL state and filter
grammar); Grafana documentation "View alert rules" and "Configure alert state history" (`latest`).
Not exercised against the hosted Grafana; smoke tests S-14 and S-15 do that.

**Findings**:
- The provisioning file declares nine Grafana-managed rules in folder `CHT`, every one with
  `__dashboardUid__: oa2OfL-Vk` and a `__panelId__` annotation, a `description` annotation that
  interpolates `{{ $labels.instance }}`, no `labels` (so there is no severity label to read), and no
  contact points or notification policies. Group `10m` (interval 10m, `for: 1h`): DB Fragmentation
  (`ot6lYCYVz`, panel 13), Outbound Push Backlog (`KgP8PjY4k`, 2), Sentinel Backlog (`FzCrECYVk`,
  3), Server Time Accurate (`hURoyjYVk`, 19), Users Over Replication Limit (`ttAeECYVz`, 21).
  Group `1m` (interval 1m): API Server Down (`Q1A-BjL4k`, panel 16, `for: 30m`,
  `noDataState: Alerting`), Client Feedback/Error Rate (`nBTZsCY4k`, 14), DB Conflicts Rate
  (`gli1YjL4k`, 7), Message Delivery Rate (`0R-OsCYVz`, 27), each `for: 1m`. Every rule
  evaluates per `instance` (the CHT host), so an instance maps to a project; DB Fragmentation also
  carries a `db` label.
- Routes and permissions (v12.3.3): `GET /api/prometheus/grafana/api/v1/rules` and
  `GET /api/ruler/grafana/api/v1/rules` require `ActionAlertingRuleRead`;
  `GET /api/prometheus/grafana/api/v1/alerts`, `GET /api/alertmanager/grafana/api/v2/alerts` and
  `/alerts/groups` require `ActionAlertingInstanceRead`; `GET /api/v1/rules/history` requires
  `ActionAlertingRuleRead`; `GET /api/v1/provisioning/alert-rules` accepts any of the provisioning
  read actions or `ActionAlertingRuleRead` together with `ActionFoldersRead`. The fixed role
  `alertingReaderRole` (rules reader with `ScopeFoldersAll`, instances reader and notifications
  reader) is granted to `RoleViewer`, so a Viewer service-account token holds both read actions the
  design needs; the provisioning roles are granted to `RoleAdmin` only, and the provisioning API is
  not used.
- Response shape of `/api/prometheus/grafana/api/v1/rules`: `{ status, errorType?, error?, data: {
  groups: [{ name, file, folderUid, interval, lastEvaluation, evaluationTime, totals?, rules: [{
  uid, name, folderUid, query, labels, health, lastError?, type, lastEvaluation, evaluationTime,
  isPaused, state: 'firing' | 'pending' | 'inactive', duration?, keepFiringFor?, activeAt?,
  alerts?: [{ labels, annotations, state, activeAt?, value }], totals?, totalsFiltered? }] }],
  groupNextToken?, totals? } }`; `/alerts` answers `{ data: { alerts: [...] } }` with the same
  instance objects. Instance `state` strings are Grafana's state names, listed in the source as
  `alerting`, `pending`, `nodata`, `error` and `normal`; code compares case-insensitively in case
  the API capitalises them, and maps `alerting` to `firing`. `groupNextToken` signals paging; the
  request parameters that drive it are confirmed in S-14.
- Alert state history: the documented backends are Loki, Prometheus and both; no backend is
  configured by default and no HTTP API is documented. cht-watchdog configures none, so no history
  is available to read; the `GET /api/v1/rules/history` route exists in source but is not relied on.
- The alert rule list page reads its filter from the `search` query parameter (the legacy
  `dataSource`, `alertState`, `ruleType` and `queryString` parameters are migrated into it). The
  grammar is `key:value` terms with keys `datasource`, `namespace`, `label`, `group`, `rule`,
  `state`, `type`, `health`, `dashboard`, `plugins`, `contactPoint` and `source`, plus free text
  matched against rule names; `label` accepts Prometheus matchers (`=`, `!=`, `=~`, `!~`); values
  with spaces are quoted (`rule:"High CPU usage"`). The page path (`/alerting/list`) and a
  `view=list` parameter were not confirmed from source; S-15 checks the built link.

**Decision**: `src/collect/alerts.js` reads `GET /api/prometheus/grafana/api/v1/rules` (rules with
their instances in one call, following `groupNextToken` when present) through
`createGrafanaClient` with the existing bearer token and timeout, and falls back to
`GET /api/prometheus/grafana/api/v1/alerts` for instances alone when the rules call fails; the
alertmanager and provisioning endpoints are not used. The raw response is stored in `alerts.json`
as recorded data; classification, staleness, newness and grouping are code under `src/alerts/`
against `alerts.yaml`. Episodes are built from the run's own daily observations plus `activeAt`,
never from state history. The link builder emits
`<AGENT_WATCHDOG_GRAFANA_URL>/alerting/list?search=<encoded terms>` with `namespace:CHT`,
`state:firing`, `label:instance=~"^(<hosts>)$"` and, for a single-rule link, `rule:"<title>"`; the
thread reply carries one link per rule title in the group and one for the whole group. The gate
resolves an alert link by confirming every title and host it names exists in the collected rules
and instances, as dashboard links are resolved against collected dashboards (R-5). The fake
Grafana under `test/helpers/fake-grafana.js` serves both endpoints from recorded fixtures.

**Alternatives considered**: the provisioning API (rejected: Admin-granted roles, and it returns
definitions without instance state); the alertmanager API (rejected: instances without their rule
uids and folders, redundant with the rules endpoint); Grafana's alert state history (rejected: not
configured on cht-watchdog and undocumented as an API); a `dashboard:` term in the link (rejected:
every rule shares one dashboard, so it filters nothing).

- **S-14**: with the Viewer token, `node smoke/grafana.js --alerts` lists the nine rules from
  `/api/prometheus/grafana/api/v1/rules` with their firing instances, the paging parameters that
  accompany `groupNextToken`, and the instance `state` strings as returned.
- **S-15**: an alert-list link built from a recorded group opens the filtered list in the hosted
  Grafana and the `search` value round-trips (rule titles with spaces, the instance regex matcher).
- **S-16**: a parent post whose bullet carries sub-bullets renders the indented `◦` lines legibly
  in Slack desktop and mobile, since leading spaces in `mrkdwn` sections are not documented.
- **S-17**: with the Viewer token, `node smoke/grafana.js --project <host>` reports "no panel query
  rejected by Prometheus" for a host with API metrics, and names any panel left unavailable for a
  variable with no single value.
- **S-18**: on the hosted watchdog, the second daily run's `collect.project` lines show `reused`
  for the previous-day and trailing windows and the eighth run's show `fetched` equal to the metric
  count; `run.json` puts the collect stage under fifteen minutes at the default concurrency.

## R-15. Dashboard variables and the trailing baseline query (FR-071)

**Evidence**: the first preview run against the hosted watchdog on 2026-09-20 (`collect.query_failed`,
HTTP 400 from `/api/datasources/proxy/uid/<uid>/api/v1/query_range` for every derived metric's
`trailing_14d` window and for every window of the `$interval` expressions); `medic/cht-watchdog`
`main` `grafana/provisioning/dashboards/CHT/*.json` fetched 2026-09-20 (templating lists and panel
targets); https://prometheus.io/docs/prometheus/latest/querying/basics/ (range vector selectors,
subqueries); https://grafana.com/docs/grafana/latest/datasources/prometheus/template-variables/
(variable syntax, `$__interval`, `$__range`, "How `$__rate_interval` is calculated") (docs, repo).

**Findings**:
- A range `[1d]` may follow a series selector only. `max_over_time(sum(x)[1d])` is a parse error
  ("ranges only allowed for vector selectors"); the subquery form
  `max_over_time((sum(x))[1d:5m])` evaluates any instant expression at a resolution over the
  range. Of the hosted dashboards' per-project panels, most are derived expressions: `rate(...) * 60`,
  `sum(...)`, `floor(abs(...))`, ratios, and every `... >= 0` panel, which is a comparison, not a
  selector.
- The datasource proxy passes queries to Prometheus untouched: Grafana substitutes variables in the
  browser only. The `CHT API Server` dashboard (`3J_78b6Zz`) defines `interval` (type `interval`,
  options `2m,10m,30m,1h,6h,12h,1d,7d,14d,30d`, current `10m`) and uses `[$interval]` in seven of its
  thirty-six expressions; `cht_partnerships_replication` defines `interval` (`12h`) and uses
  `$__range`; `cht_admin_details` defines `db_name` (a query variable with a multi-value selection)
  but uses it in titles only; `umt_server` scopes by `$umt_instance`, so none of its panels is
  per-project. Grafana's variable syntaxes are `$name`, `${name}` (optionally `${name:format}`) and the
  legacy `[[name]]`.
- Grafana's built-ins: `$__interval` is the panel's calculated step, `$__interval_ms` the same in
  milliseconds, `$__range` the dashboard time range (`$__range_s`, `$__range_ms`), and
  `$__rate_interval = max($__interval + scrape_interval, 4 * scrape_interval)` where
  `scrape_interval` is the data source's "Scrape interval" setting. cht-watchdog provisions that
  setting as `timeInterval: 1m` while Prometheus scrapes every 5 minutes (R-6), so Grafana's own
  `$__rate_interval` on the hosted dashboards is `4m` at narrow ranges, too short for a 5-minute scrape;
  the watchdog resolves it from the real scrape interval.

**Decision**:
- `trailingQuery` keeps `max_over_time(<selector>[1d])` for a bare selector and wraps anything else
  as `max_over_time((<expr>)[1d:5m])`, the resolution being the comparison windows' step.
- Discovery records, per dashboard, what each templating variable resolves to (`variables`): an
  `interval` variable to its current duration (or `5m` when set to auto); a `constant`, `custom` or
  `textbox` variable to its single current value; a `query`, `datasource` or multi-value variable to
  `null`. Per panel it records the variables used and the `unresolved` ones. `cht_instance` stays the
  scoping variable handled by `withInstance`.
- `collect` substitutes, after scoping, the dashboard variables and the built-ins for the watchdog's
  windows: `$__interval` `5m`, `$__interval_ms` `300000`, `$__rate_interval`
  `max(5m + scrape, 4 × scrape)` with the watchdog's 5-minute scrape (`20m`), `$__range` `1d`
  (`$__range_s` `86400`, `$__range_ms` `86400000`), since every window compares a day against a day.
  A metric whose expression still contains a variable is recorded as unavailable with the reason
  `unresolved variable $name`, logged once per project as `collect.unresolved_variable`, and never
  sent. The model's `query_metric` tool resolves through the same spec, from the run's
  `discovery.json`.
- The Grafana client puts the response detail (Prometheus's `errorType: error`, Grafana's `message`,
  or the first 300 characters of text) in the error message, so `collect.query_failed` says why.
- The fake Grafana answers 400 with the Prometheus envelope for an unsubstituted variable or a range
  on a non-selector, and the collect specs assert that no fixture query is rejected; S-17 confirms
  the hosted proxy accepts every resolved form.

**Alternatives considered**: substituting `$interval` with the query step (rejected: the dashboard
author chose `10m` for these rates, and the value is in the document already read); skipping
panels with variables (rejected: the API request rate, CPU and GC panels are the ones that carry
`$interval`); `[1d:]` with Prometheus's default resolution (rejected: the default evaluation
interval is not the watchdog's to know, and `5m` matches the other windows); adding the datasource
proxy's own variable substitution (none exists: the proxy forwards the query string as sent).

## R-16. Collection at a hundred projects: reuse, ledger, retries, concurrency (FR-072 to FR-074)

**Evidence**: the hosted preview run of 2026-09-20 (`run_id 2026-09-19-f2`: 95 analysed projects,
24 ignored, 91 metrics, 364 range queries per project, `collect.project` at 63 to 67 seconds per
project, one `TimeoutError` on `query_range` after the default 15-second HTTP timeout ending the
run with exit 69); https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/
(`[dataproxy] timeout`: "How long the data proxy should wait before timing out. Default is 30
seconds"); Node 22 `AbortSignal.timeout()` rejecting `fetch` with a `TimeoutError`; the retention
classes of R-6 and contracts/run-directory.md (raw 14 days, kept 30 days) (docs, run record).

**Findings**:
- Sequential collection of 95 projects at 65 seconds each is about 104 minutes, longer than the
  default run budget of 60 minutes, and the deadline is taken before collection starts, so the
  analysis stage would begin already out of time.
- Three of the four windows are data an earlier run fetched: today's previous-day window is
  yesterday's current window with identical bounds, since every run starts at 06:00 UTC of its date;
  the previous-week window is the current window of the run seven days earlier; nineteen of the
  twenty trailing daily maxima were fetched yesterday, and the twentieth is the maximum of today's
  current window.
- Grafana's data proxy gives up after 30 seconds by default, so a longer client timeout alone
  changes nothing: the proxy answers 502 or 504 first. A heavy trailing subquery over twenty days
  of a `sum(rate(...))` expression can exceed that.
- Every fetch failure, timeout included, was classified as "metrics source unreachable" and ended
  the run, although the source answered 1,092 queries in the three minutes before.

**Decision**:
- `src/collect/history.js`: per project, `storedWindow(metric, bound)` returns the current window of
  the run `daysBack` days earlier (the latest run of that date, forced runs included) when its
  `start`, `end`, `step_s` and metric match exactly and it was available; `ledgerWindow` builds the
  trailing window from `history/<slug>.json`, a Daily Maxima Ledger with one number per metric per
  day, when it holds at least fourteen of the days; `recordCurrent` writes today's maximum from the
  current window; `backfill` fills the ledger from a fetched trailing window. The ledger is written
  atomically once per project per run and purge compacts entries older than the kept period.
- `collectWindows` fetches the current window always, reuses the comparison windows when stored,
  builds the trailing window from the ledger when it can and fetches otherwise, and marks every
  window with `source`: `fetched`, `stored:<run_id>` or `ledger`. Reuse is by exact bounds only.
- The Grafana client gets `AGENT_WATCHDOG_QUERY_TIMEOUT_MS` (default 30000, the proxy's own
  default; hard cap 300000) for range and instant queries. A query that times out or receives 502,
  503 or 504 is retried once; a second failure is a `query failed` window, logged with metric and
  window. Three consecutive query failures, or a connection failure that a retry does not clear,
  are "metrics source unreachable" (exit 69) as before. Grafana API calls keep the HTTP timeout.
- The collect stage runs projects through a worker pool of `AGENT_WATCHDOG_PROJECT_CONCURRENCY`
  (default 3) and logs `fetched`, `reused` and `queries` per project and in total.
- Cold day: 4 queries per metric; second day: 2 (current and previous week); from the eighth day: 1.
  For 95 projects and 91 metrics that is 8,645 queries a day, about nine minutes at concurrency 3.

**Alternatives considered**: a database (rejected: Prometheus is the time-series store, the run
directory already holds the windows, and the ledger is a few kilobytes per project); querying
Grafana for deltas (rejected: the proxy holds no results, so cost is the query count, which reuse
removes); Prometheus recording rules for the derived API expressions (deferred: they live in
cht-watchdog and would make even the fallback cheap); a longer client timeout alone (rejected: the
proxy cuts at 30 seconds); skipping the trailing baseline for derived metrics (rejected: the
deviation rule would stay blind on them).

## R-17. Breakdown panels: one series per project (FR-075)

**Evidence**: hosted run `2026-09-19-f3` on 2026-09-20: `collect.query_failed` for
`histogram_quantile(0.90, sum(rate(cht_api_http_request_duration_seconds_bucket[$interval])) by (le,route))`
in `trailing_14d` on the eCHIS Kenya hosts (timeout after two 30-second attempts) and on the Mali host
(HTTP 422, "query processing would load too many samples into memory in query execution", Prometheus's
`--query.max-samples` guard); the run's `discovery.json` (101 per-project panels, ten grouping by
`route` or `code`: requests per second by code, p90 latency by route, code count, response size by
route, request count by route, four "Top 5" `topk` panels, replication rate by code);
`grafana/provisioning/dashboards/CHT/cht_coredev_api_express.json` (no aggregate latency panel: every
`histogram_quantile` groups by `route`); `grafana/grafana.example.ini` (no `[dataproxy]` section, so the
proxy timeout is Grafana's 30-second default) (run record, repo).

**Findings**:
- A `by (route)` or `by (code)` expression returns one series per label value; `topk(5, …)` returns up
  to five. `pickSeries` kept the first series with the project's instance label, so the "metric" the
  analysis saw for these panels was an arbitrary route or code. A plain selector without the label
  pinned (`cht_couchdb_fragmentation{instance=~"$cht_instance"}`, one series per database) has the same
  shape and the same defect.
- The per-route p90 as a twenty-day subquery evaluates a per-route histogram quantile about six
  thousand times per host; it exceeds the proxy timeout on hosts with many routes and Prometheus's
  sample limit on the busiest. No client setting can make it pass: the proxy caps at 30 seconds and the
  sample limit is Prometheus's own.
- The aggregate panels stay: request rate (`QPS`), request count, the error share
  `(4xx+5xx)/all`, garbage collection, CPU and memory. Latency has no aggregate panel on the dashboard.

**Decision**: `breakdownOf(expr)` at discovery marks `by`/`without` groupings (minus `le`) and
`topk`/`bottomk` as breakdowns; such panels are recorded in `discovery.json` with kind and labels,
logged once per dashboard as `discovery.breakdown_panels`, and excluded from the metric list and from
collection. At collection, a query answering several series for the project makes the window
unavailable with `N series, not one per project (labels: …)`, naming the labels whose values differ.
Breakdown analysis is recorded as Out of Scope: a later story would collect grouped panels per series
under a cardinality bound and raise items that name the route or code. Recommended to cht-watchdog: an
aggregate latency panel, `histogram_quantile(0.9, sum(rate(…_bucket[$interval])) by (le))`, which the
watchdog would pick up unchanged.

**Alternatives considered**: keeping the first series (rejected: arbitrary and misleading); the
maximum across series (rejected: mixes routes into one number nobody can act on); a coarser trailing
resolution for heavy expressions (rejected: the value would still be a single route's, and the
current windows would disagree with the baseline); recording rules for the per-route quantile
(deferred: cht-watchdog change, and the breakdown story would need them anyway).


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

**Addendum 2026-09-20 (S-4 on the hosted run)**: every session of the first complete run failed
with `Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON
Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. The runtime
validates the schema with a validator that knows the draft-07 dialect only, and our files declare
`$schema` 2020-12 (zod's `target: 'draft-2020-12'`). Decision: the committed schema files stay
2020-12 as the documented contract; both engines hand the runtime a copy without `$schema` and
`$id`, with `$defs` renamed to `definitions` and every `$ref` rewritten, which every dialect accepts
(`forStructuredOutput` in `src/agent/output-schema.js`). The remaining S-4 question, whether the
runtime's structured-output retries accept `enum` and nullable unions, is confirmed by the next
hosted run.

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

**Login mode (added 2026-09-20)**. A contributor's run with `AGENT_WATCHDOG_ENGINE=cli` and
`ANTHROPIC_API_KEY` left blank exited 78, because the key was required for every model command and
the engine always passed `--bare`. Evidence: the installed help (installed) says of `--bare`
"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are
never read)"; the headless guide (docs, https://code.claude.com/docs/en/headless) says "bare mode
doesn't use your subscription login" and that without `--bare` a `-p` session "loads the same context
an interactive session would, including anything configured in the working directory or
`~/.claude`"; the environment reference (docs, https://code.claude.com/docs/en/env-vars) says of
`ANTHROPIC_API_KEY` "In non-interactive mode (`-p`), the key is always used when present", so a blank
key must be removed from the child environment; the memory guide (docs,
https://code.claude.com/docs/en/memory) says project rules "are skipped if you exclude `project` from
`--setting-sources`" and "To disable auto memory via environment variable, set
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`"; the installed SDK's type documentation (installed,
`@anthropic-ai/claude-agent-sdk/sdk.d.ts`) says `settingSources` "Must include `'project'` to load
CLAUDE.md files" and the SDK passes `--setting-sources=` (empty) for `[]`. A probe of the installed
2.1.278 with empty stdin accepted `-p --verbose --no-session-persistence --setting-sources "" --settings
'{"autoMemoryEnabled":false}' --input-format stream-json --output-format stream-json --tools ""
--permission-mode dontAsk --strict-mcp-config` and exited 0 without a model call (installed). Precedent:
cht-agent's `claude-cli` provider (repo, `src/llm/providers/claude-cli.ts` on `memory/draft-verification`)
runs `claude -p` on the operator's login by inheriting the environment and passing no `--bare`.

**Decision**: the key is required for model commands only when the engine is `sdk`. The CLI engine
has two modes chosen by whether a key is configured: key mode keeps `--bare` and the private
`CLAUDE_CONFIG_DIR`, and puts the configured key in the child environment itself; login mode drops
`--bare`, passes `--setting-sources ""`, removes the blank key from the child environment, leaves
`CLAUDE_CONFIG_DIR` where the login is (`~/.claude` unless set) and reports `agent.cli_auth`
(`mode`, `config_dir`, `credentials_found`), warning once when no `.credentials.json` is there (macOS
may keep the login in the keychain). `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is exported in both modes.
`--tools ""`, `--strict-mcp-config`, `--permission-mode dontAsk` and `--no-session-persistence` are
unchanged. The scheduled container run keeps the key: the image has no login and its
`CLAUDE_CONFIG_DIR` is scratch. Not adopted: `--restricted` (it keeps Bash, file and web tools unless
removed and adds nothing over `--tools ""` plus `--setting-sources ""`), and an `apiKeyHelper` that
reads the login's token (fragile, and it would route a subscription login through the key path).

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

**Alternatives considered**: allowing `ask_question` (rejected: the gate cannot verify a paraphrase).

**Rationale corrected (2026-09-21)**: half of the reason above was wrong, and a live call made while
reviewing run 2026-09-20-f1 shows why. `ask_question` does not hide which source said what: it
attaches an inline citation to each claim (`[[Metrics Reference](url)]` after the sentence it
supports) and ends with a fourteen-entry `**Sources:**` list, every URL of which is already on this
package's allow-list (`docs.communityhealthtoolkit.org`, `forum.communityhealthtoolkit.org`,
`github.com/medic/`). The reason that does hold is the second one: `search_docs` hands the model the
section text itself, so the run record holds the words the item's prose is grounded in, while
`ask_question` hands it someone else's summary and the record holds only the summary. The gate can
check that a cited URL was seen and resolves; it cannot check that a paraphrase is faithful to the
page. The decision therefore stands on provenance, not on citation.

**Also recorded**: the service's own documentation page
(https://docs.communityhealthtoolkit.org/ai/mcp-servers/cht-docs-mcp-server/, read 2026-09-21)
states a rate limit of 10 requests a minute per address and 50 a minute globally. Nothing in this
package handles a refusal for rate, so at ninety projects a day the documentation calls need either
a budget per run or a retry, whichever a measured run shows is necessary. Not addressed here.

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
| S-4 | The Anthropic structured-output implementation accepts `findings.schema.json` and `brief.schema.json` as written (`$ref`, `$defs`, `enum`, nullable unions) | The supported JSON Schema subset was not verified this session. **Result 2026-09-20**: the runtime refused the files as written, `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`; see the R-2 addendum |
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
| S-19 | With `AGENT_WATCHDOG_ENGINE=cli` and `ANTHROPIC_API_KEY` blank on a machine where `claude` is logged in, the first pass completes with no authentication error, `agent.cli_auth` reports `mode: login`, and the run leaves no new directory under `~/.claude/projects/` | Whether print mode accepts the subscription login with `--setting-sources ""`, and whether the auto-memory switch holds there, only a live run shows |
| S-20 | A forced re-run of the previous date (`--force --date <yesterday>`) completes the roll-up, its `alerts.classified.json` carries `observed_at` at the clock time, and every cleared episode has a duration of zero or more | Only the hosted alert state has instances that started after the analysed date |
| S-21 | With a valid model id, a single-project preview on the operator's login completes at least one session with `cost_usd` above zero and either accepted items or a converged empty result, and `agent.turn_error` never appears | Only the hosted runtime shows whether the model is available to the plan |
| S-22 | With the dashboard reference built by code, a single-project run accepts pass 1 on its first attempt (`verification.pass1.json` outcome `accepted`, attempt 1) and the project's cost falls to roughly the two first attempts | Only a hosted run shows what the model does when it is no longer asked to guess the bounds |
| S-23 | A one-project run's brief names only that project's alerts, and the next full run reports the same newness and no spurious resolution | Only consecutive hosted runs show that a filtered preview left the durable record alone |
| S-24 | On the hosted watchdog a quiet project completes in one pass, and a project with items logs `agent.tool_usage` with no failures and no refusals | Tool contracts and pass skipping only show their worth against the real alert and metric mix |
| S-25 | After a week of hosted runs the weekly report names at least one rule whose candidates the analysis set aside on most days, with a commonest reason, and any suggestion resting on those says so | Only a week of real runs produces enough dismissals to separate a noisy rule from a quiet week |

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
in `trailing_14d` on the hosts of one programme (timeout after two 30-second attempts) and on a busy host
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

## R-18. Metric kinds: which CHT metrics are levels, counters, uptimes or clocks (FR-076)

**Evidence**: `medic/cht-watchdog` `main` `exporters/json/config/cht.yml` (fetched 2026-09-20): the
metric names and their `help` texts, the source of what each number means; the first complete hosted
run's `candidates.json` files (1,431 of 2,058 candidates from the sustained-rise rule, almost all on
totals, sequences, uptime and the clock); Prometheus `increase()` semantics for counter resets
(repo, run record, docs).

**Findings**:
- The json exporter maps `/api/v2/monitoring` fields to metrics whose names do not follow Prometheus
  naming conventions: `cht_sentinel_backlog_count`, `cht_outbound_push_backlog_count`,
  `cht_connected_users_count`, `cht_replication_limit_count` and `cht_conflict_count` are gauges
  despite `_count`; `cht_api_nodejs_active_handles_total` is a gauge despite `_total`. A suffix
  heuristic would misclassify the most important gauges, so the kind is declared per metric.
- Cumulative quantities: `cht_couchdb_doc_total` ("the number of docs in the db"),
  `cht_couchdb_doc_del_total`, `cht_couchdb_update_sequence` ("the number of changes in the db"),
  `cht_feedback_total` ("feedback docs created"), and the API's `_count`, `_sum` and
  `cpu_seconds_total` series. Their level is history; the signal is the increase per day.
- `cht_date_uptime_seconds` ("how long API has been running") rises until a restart resets it; the
  reset is the signal. `cht_date_current_millis` is the server clock; the dashboards derive skew from
  it, and the derived expression is a gauge in its own right.
- `cht_messaging_outgoing_total` mixes cumulative statuses (`delivered`, `failed`) with current ones
  (`due`, `scheduled`, `muted`); the dashboards already show `rate()` panels for the cumulative ones,
  so the totals stay gauges in the default policy and a deployment may pin `name{status="delivered"}`
  as a counter.

**Decision**: `metric_kinds` in `thresholds.yaml`, lists of metric names or `name{labels}` selectors
under `clock`, `uptime` and `counter`, with the stock CHT metrics above as the code default when the
file carries no lists. The kind is looked up on the bare key after a display comparison and a plain
`sum()` wrapper are stripped; anything else is a gauge. A counter's change uses `increase()`
semantics (a reset counts from zero) over each window and daily increases from the trailing maxima;
an uptime's change counts samples below half their predecessor as restarts (noise on the hosted
series is well under that) and raises a medium `restart` candidate; a clock raises nothing. A panel
whose expression is another panel's plus ` >= 0` shares its metric key (FR-077). The fake watchdog
accumulates a counter's per-day level and answers a rate-wrapped counter like a gauge, as Prometheus
would.

**Alternatives considered**: a name-suffix heuristic (rejected above); learning kinds from the data
(a series that never decreases) (rejected: a slowly growing gauge such as connected users would be
mistaken, and the operator could not review the decision); dropping counters from the dashboards
(rejected: docs per day and feedback per day are useful signals once read as increases).

## R-19. Correlation and consolidation in the brief (FR-078 to FR-082)

**Evidence**: the first complete hosted run's payload (`rollup/payload.json`, 2026-09-20): one alert
category listing 45 near-identical lines, all started within three days, on most of one programme's
projects; seven "API Server Down" alerts stale for 72 days on hosts with no metric in any window;
every alert line without its metric; every item and alert on the first run marked "new"; the
reader's question whether the result differed from a Grafana notification. The spec's FR-015 already
permits emoji as status and severity markers. Slack `mrkdwn` renders Unicode emoji in section and
context blocks; the header block is plain text with `emoji: true`. Debian bookworm ships
`fonts-noto-color-emoji`, which the Chromium headless shell uses for emoji glyphs in the rendered
image (docs, run record).

**Decision**:
- Patterns (`src/alerts/patterns.js`): per programme and rule, the firing hosts, the programme's size
  from discovery (the hosts seen when unknown), and the span of first occurrences; a pattern needs
  three hosts, half the programme and a two-day span. Groups carry their patterns; a pattern that
  covers a whole category is the category line; the thread shows one paragraph per pattern and lists
  the other instances as before.
- Evidence: classification looks up, per firing instance, the computed change of a metric the
  category names for that project (`alerts.yaml` categories), preferring the bare metric; the thread
  line shows `metric value now (yesterday value)`, `/day` for counters. An item's reply names the
  firing alert whose category covers its metric.
- Housekeeping: an instance that is stale and whose host's scrape target read zero for the whole
  current window is housekeeping: out of the groups and counts, into one notice naming the hosts and
  the remedy. Resolved: episodes open in `alerts/episodes.jsonl` whose instance no longer fires make
  one notice, oldest first, three named.
- Ranking: connected users per project, from the computed changes, enter the order as an order of
  magnitude after severity and before confidence, so a busy project's item comes first without
  letting user counts override confidence among peers.
- Markers (`src/rollup/markers.js`): a fixed vocabulary added at render time by the payload builder
  and the report view, never stored and never written by the model; the image alt text stays plain.
  The container image installs `fonts-noto-color-emoji`.

**Alternatives considered**: markers written by the model (rejected: constitution III, and the gate
would have to police them); markers stored in `brief.json` (rejected: feedback matching and the
replay comparison work on plain text); a threshold per rule for patterns (rejected: the share and the
window generalise; a rule-specific knob can come with feedback); ranking by absolute user counts
(rejected: a project with 1,200 users would always beat one with 400 whatever the confidence).

## R-20. The runtime's structured-output tool, and the run budget (S-4 continued)

**Evidence**: hosted run `2026-09-19-f5` on 2026-09-20: every session logged
`agent.tool_denied` for `tool_name: StructuredOutput`, ended with `bounds_hit: ["budget"]` and cost
$2.07 to $2.35 with zero items; `src/config/schema.js` declared `AGENT_WATCHDOG_MAX_BUDGET_USD_RUN`
but no code read it (run record, repo).

**Findings**: with `outputFormat` set, the Claude Code runtime delivers structured output through a
tool of its own named `StructuredOutput`. Our PreToolUse hook and the `allowedTools` list denied
every tool not in `agent/tools.json`, so the model could never hand its findings back and spent the
whole per-project budget on retries. The per-project budget held; the run budget existed only on
paper, so ninety projects would have cost about $190.

**Decision**: `agent/hooks.js` approves `StructuredOutput` always and never records it as a tool
call; both engines add it to the allowed tools whenever an output schema is set. The agent stage
enforces the run budget across sessions: a session is granted `min(project budget, run budget minus
what finished sessions spent minus what running sessions may still spend)`, no session opens under
$0.25, and the projects left out are listed in `agent.summary.json` (`run_budget`) and named in the
brief's `Analysis incomplete` notice. Measure before tuning: with the tool approved, the next run
gives the first real per-project cost; until then a lower per-project budget and a cheaper model
for the per-project passes are the safe settings.

## R-21. Live alert snapshots on a backdated re-run, and a session stopped before a result

**Evidence** (live, 2026-09-20, the first single-project run on the operator's `claude` login,
`run --dry-run --force --date 2026-09-19 --project <host>` at 17:56 UTC): the roll-up failed with
`ZodError … "path": ["duration_hours"] … "Too small: expected number to be >=0"` from
`updateEpisodes`; before that, `agent.session_done` reported `passes: 1, items: 0, converged: false,
bounds_hit: ["budget"], cost_usd: 0.84874` against `budget_usd: 0.75` for 22 candidates, and the
layout held only alert slots.

**Cause**: the run's reference time was the analysed date at 06:00 UTC, while alerts are read live.
Earlier forced runs of the same date had opened episodes for alerts that started after that time;
when one stopped firing, its duration measured to 06:00 of the previous day was negative.
`classifyAlerts` already clamped `days_firing` at zero, which is why the analyze stage passed. The
budget stop is not a defect: it is the first measurement of a real per-project cost, and it says the
first pass of a project with 22 candidates costs more than $0.75 at the configured model and effort.
The defect is that the brief would have presented the day as "Alerts only: … no metric changes to
flag" with 22 computed candidates unassessed (User Story 10).

**Decision**: alerts are measured from when they were read. The run's clock (`deps.now`, injectable)
reaches the stages as `ctx.now`; the collect stage stamps `alerts.json` `fetched_at` with it; the
classification measures `days_firing` from `fetched_at` (an explicit `observedAt` first, the run start
last) and records `observed_at`; episodes take `observedAt` for `at`, `cleared_at` and
`duration_hours`, clamp a negative duration to zero and log `alerts.episode_duration_clamped`; the
resolved notice uses the same time. The roll-up derives an analysis record from every `passes.json`
(`src/rollup/analysis.js`): sessions with errors or the error bound are failed (revision 13); sessions
stopped by the budget or the turn cap with no accepted items are incomplete, and the brief carries
`Analysis incomplete: model sessions were stopped by the session budget on N of M projects before a
result ($X spent)` and degrades to the candidates when nothing else exists. The log line
`rollup.analysis_incomplete` carries the operator hint. Budget tuning waits for one complete session
measured with a higher per-project budget (constitution: measurement before tuning).

## R-22. A result the runtime marks as an error, and four defects seen in one payload

**Evidence** (live, 2026-09-20): the single-project preview after R-21 exited 0 with `cost_usd: 0`,
`items: 0` and the headline "Alerts only: 67 firing across 61 projects, no metric changes to flag".
Its `passes.json` held two passes of three attempts each, every attempt `subtype: success`, zero
usage, `duration_ms` under 500, and the gate reason "structured output missing or invalid (success)".
A probe of the installed CLI 2.1.278 with the configured id (`claude -p --output-format json --model
claude-opus-4.8 …`) answered in 464 ms with `{ type: 'result', subtype: 'success', is_error: true,
total_cost_usd: 0, result: "There's an issue with the selected model (claude-opus-4.8). It may not
exist or you may not have access to it. Run --model to pick a different model." }`. The headless
guide (docs) states the rule: "When a failure happens inside the run, such as missing authentication,
Claude Code prints the failure as the result on stdout." The same payload showed: the eCHIS Kenya
client-errors reply at 3,999 characters cut to 2,999 with an ellipsis inside the second link; `Low
Disk Space` instances on `samburu.echis.go.ke:9100` and `interop.echis.go.ke:9100` under "Other"
because the port defeated the `*.echis.go.ke` pattern; "Resolved since the previous run: Message
Delivery (2h) on training-3.echis.go.ke" for a host the ignore list drops; and seven `API Server
Down` alerts stale for 74 days on hosts with `cht_version: null` counted as alerts, not housekeeping,
because dead hosts were derived only from the analysed project's changes.

**Decision**: the turn mapper carries `is_error` and the first 500 characters of the runtime's
`result` text; a result marked as an error that is not a budget or turn stop (nor the structured-output
retry exhaustion, which stays a rejected draft) ends the project's analysis as an `error` bound with
that message, without revision turns, so the brief degrades and names it (revision 13 path). Model ids
(`AGENT_WATCHDOG_MODEL` and the per-stage overrides) must match `^[a-z0-9][a-z0-9-]*$`; the
configuration error names the form the API uses. Alert replies are fitted into one section without
cutting a link: instance counts 50, 40, 30, 20, 15, 10, 5, 0; for each, the filtered links, then the
group link alone, then the links without the host filter (`short` from `buildAlertGroupLinks`, also
resolved by the gate); within each, every pattern host, then twelve with the count of the rest; a body
that still does not fit is cut in front of whole links. `hostOfLabels` strips a trailing `:port`.
The classification lists `ignored_hosts`; episodes on them are neither observed nor cleared and the
resolved notice skips them. Dead hosts for housekeeping are the union of the analysed projects' scrape
metric at zero and discovery's `scrape_targets` health `down` for the policy's scrape job. The correct
ids for the models discussed are `claude-opus-4-8` and `claude-opus-5`; the measured cost of a complete
session is still to be taken (S-21).

## R-23. Four of five turns rejected on a value the run already held

**Evidence** (live, 2026-09-20, run `2026-09-19-f8`, one project, 22 candidates, Opus 4.8 at high
effort on the operator's login). Per-turn, from `session.json`:

| turn | cost | turns | outcome |
|---|---|---|---|
| pass 1, attempt 1 | $0.829 | 7 | rejected |
| pass 1, attempt 2 | $0.235 | 2 | rejected |
| pass 1, attempt 3 | $0.326 | 2 | rejected, pass 1 discarded |
| pass 2, attempt 1 | $0.614 | 2 | rejected |
| pass 2, attempt 2 | $0.275 | 2 | accepted |

`verification.pass1.json` records `outcome: rejected` on the last attempt with every check passing
except `dates_match`; `verification.pass2.json` records `accepted` on attempt 2. `passes.json` holds
`converged: false` and `diffs: []`, because a diff is only recorded once a pass has been accepted:
the two-pass design silently degraded to one pass. The rejection reasons, from the Langfuse traces of
the same turns, were `items[0..2].dashboard_ref 2026-09-19T00:00:00Z to 2026-09-20T00:00:00Z is
outside the run's windows` on pass 1 and `... 2026-09-20T00:00:00Z to 2026-09-20T12:00:00Z ...` on
pass 2. The collected windows for those metrics run `2026-09-18T06:00:00.000Z` to
`2026-09-19T06:00:00.000Z` (`inputs/windows.json.gz`), and each window already carries
`panel_ref: { dashboard_uid, panel_id, panel_title, ref_id }`. `prompts/pass-first.md` says only "Set
`dashboard_ref` to the dashboard uid and panel id the metric came from, with the window you want the
reader to see" and states no bounds anywhere, so the model was guessing. It passed on the fifth turn
by reverse-engineering the bound from tool results, and says so in its own `notes`: "the dashboard
link window was corrected to sit within the run's collected data, which ends near the current server
timestamp ~2026-09-19T05:57Z".

Two further defects surfaced in the same traces. The revision request carried the lines `not
applicable to findings` twice, because `src/agent/session-loop.js` builds the reasons as
`verdict.report.checks.flatMap((c) => c.reasons || [])` over every check, and the brief-only checks
`bullet_count` and `bullet_length` pass while emitting that informational reason. And pass 1 attempt
1 was told `phone number at $.items[0].why_now`: the prose carried the unrounded trailing daily mean
`26.263157894736842`, which holds 17 digits and a dot, so `PHONE_PATTERN` matched it at
`PHONE_MIN_DIGITS`. Separately the roll-up's first draft was rejected for `bullets[0] contains 14d,
which matches no computed value`; `14d` is the run's own name for the `trailing_14d` window.

**Decision**: the model no longer emits `dashboard_ref`; it is removed from the findings output
schema and from the prompt. `src/links/dashboard-ref.js` builds it from the item's metric and the
collected windows: the panel reference of any window for that metric, and the bounds of the window
the item's leading evidence cites, falling back to `current` and then to the full collected span.
The gate's `normaliseItems` applies it, so the Item keeps its shape and nothing downstream changes. Two details the
run exposed: `sameMetric` also matches on the base metric name, so `cht_couchdb_doc_total{db="medic"}` answers to
twenty windows of its family and the item's own key has to decide which panel it came from; and scrape-target health
is collected under a pseudo panel reference (`{ dashboard_uid: 'targets', panel_id: 0 }`) that no dashboard holds,
which the old prompt worked around by telling the model to point at some real panel instead. Code links the first
priority dashboard with no panel there, so `DashboardRef.panel_id` is nullable and `src/links/build.js` renders a
dashboard-level link scoped to the project and window. Checked against the run itself: the reference built from
`2026-09-19-f8`'s own windows lands on the same three panels the model reached on its fifth turn, with the run's
bounds.
The revision request carries only the reasons of checks whose status is `fail`. `phoneMatches` skips
a match that is a plain decimal number. `numbers_match` exempts tokens that appear in the run's own
window names.

**Alternatives considered**: raising the retry cap (rejected: it multiplies a cost that buys nothing,
and the check was unpassable by design); stating the bounds in the prompt (rejected: it still spends
model tokens restating a computed fact, and drifts the moment the window policy changes); keeping
`dashboard_ref` in the schema as optional and overwriting it (rejected: it leaves a field a reader
would believe the model sets).

## R-24. A correct run that was too wide, too trusting of its own refusals, and too expensive

**Evidence** (live, 2026-09-20, run `2026-09-20`, one project, 33 candidates, Opus 4.8 at high
effort, `AGENT_WATCHDOG_PASSES=3`). The revision-18 fixes held: no `dates_match` failure, pass 1
accepted, pass 2 accepted, pass 3 accepted and identical, `converged: true`, and `diffs` recorded
for the first time. Per turn, from `session.json`:

| pass | attempt | cost | output tokens | cache read | cache write | turns |
|---|---|---|---|---|---|---|
| 1 | 1 | $0.841 | 10,264 | 43,651 | 56,246 | 5 |
| 1 | 2 | $0.244 | 6,126 | 56,246 | 6,249 | 2 |
| 2 | 1 | $1.085 | 10,056 | 286,241 | 69,001 | 6 |
| 3 | 1 | $0.649 | 3,723 | 131,496 | 48,980 | 2 |

Total $2.818 for the project and $0.106 for the roll-up. Prompt caching is already effective:
517,634 cached reads against 180,476 writes across the session. The third pass changed nothing
(`diffs` 2 to 3 empty) for $0.649, which is what `AGENT_WATCHDOG_PASSES` exists to control.
`findings.pass1.json` carried 2 items and 27 `not_selected` entries whose reasons ran to 2,722
characters, and `not_selected` is read: `src/agent/prompt-assembly.js` feeds it into
`prompts/pass-review.md`, so it cannot be dropped, only asked for more sparingly.

**Three problems, from the run's own record.** First, the brief carried five alert bullets covering
eCHIS Kenya (50 firing), Mali and eCHIS Uganda, plus a housekeeping line for seven hosts and a
resolved line for another project, while the run had analysed one project. `contracts/cli.md`
defines `--project` as restricting analysis with discovery still running, so this is the contract
working as written and the contract being wrong for a reader.

Second, `reference_sources_unavailable` was true while the brief's own item cites CHT documentation
on managing database conflicts. `tool-calls.jsonl` shows why: the model called
`mcp__cht-docs__ask_question` twice and was refused ("Permission to use … has been denied because
Claude Code is running in don't ask mode"), then fell back to `mcp__cht-docs__search_docs`, which
returned the documentation. `agent/mcp.template.json` sets `ask_question` to `always_deny` and
`agent/tools.json` does not list it among the allowed tools, so the refusal is this package's own
design; but `src/agent/turn-mapper.js` counts any refusal of a `cht-docs` tool as the sources being
unavailable. The false clause reached the headline, where it consumed more than half of the
150-character limit, and added a warning notice to the brief.

Third, the session's first tool call failed: `mcp__watchdog__get_windows` answered
`{"error":"unknown metric: rate(cht_messaging_outgoing_total{status=\"delivered\"}[24h])"}` for the
very metric of the item the model went on to publish. `METRIC_NAME` in
`src/agent/tools/watchdog-tools.js` is `/^[a-zA-Z_:][a-zA-Z0-9_:]*$/`, a bare metric name, while the
tool's own schema describes the argument as the "metric key as it appears in the candidates or
computed changes", and those keys are panel expressions. Separately the secret scan reported the
same three findings it reports every run, all from documentation text inside `tool-calls.jsonl`: an
address in a CHT release note and the dates `2024-07-16` and `2025-08-20` read as phone numbers.

**Decision**. The roll-up presents only the analysed projects when the run was filtered, regrouping
from `alerts.classified.json`'s instances rather than its stored groups, and scoping the
housekeeping, resolved and new-project notices the same way; collection, the classified record and
`alerts/episodes.jsonl` stay whole, so a narrow preview cannot make another project's open episode
look cleared or break the next run's newness. A refusal counts as the sources being unavailable
only when the refused tool was on the allow-list, and the permitted reference tools are named in
the prompt so a turn is not spent discovering the refusal. `get_windows` accepts any key that
matches a collected metric under the gate's own key forms, keeping a length and character guard;
`query_metric` stays a bare name, which is what it queries with. The scan excludes a date from the
phone pattern and counts findings in recorded tool results apart from findings in what the run
produced. Each run logs `agent.tool_usage` per project and per run with calls by tool, failures and
refusals. For cost: a written `not_selected` reason is asked for only where the candidate's severity
floor is medium or high, and no review pass runs when the pass before it produced no items.

**Dropped on inspection**: pricing the review passes on a cheaper model. Both engines bind the model
when the session opens, the CLI as a `--model` process argument and the SDK as a `query()` option,
and `session.turn()` takes none; so a second model means a second session, and FR-057 requires the
passes to share one so earlier tool results stay available to later ones. Trading that for cost is a
design decision of its own, not a knob, and it is not made here.

**Alternatives considered**: filtering the classified record or the episode update as well
(rejected: it corrupts the next full run, as above); keeping the whole programme's alert group on a
filtered run so the reader sees programme context (rejected: the reader asked about one project, and
the group's counts would then describe projects the run never analysed); dropping `not_selected`
(rejected on evidence: the review pass reads it); lowering the default pass count (rejected: that is
the operator's setting and this run had it at three deliberately); re-seeding a cheaper second
session with the first pass's items and computed data so the review could run on another model
(rejected here: it gives up the shared tool results and doubles the cached prefix, so it needs
measuring against a run that keeps one session, which is what this revision leaves in place).

## R-25. Two judgements the analysis already makes and the run then forgets

**Evidence** (the run records of 2026-09-20 and 2026-09-20-f1, read on 2026-09-21).

`findings.pass1.json` of 2026-09-20 carries 2 items and 27 `not_selected` entries whose reasons run
to 2,722 characters, each naming why a computed candidate was examined and set aside: a low, noisy
base; a near-zero previous day making a percentage meaningless; a progress counter rising because it
is a progress counter. A grep of the tree shows the only reader outside the review pass of the same
run is nothing at all. Meanwhile `src/calibration/report.js` builds its observations from
`candidates.json` and attributes an outcome through `attributeOutcomes`, which maps *feedback*
records onto item postings, so a candidate that never became an item is `unreviewed` and
`src/calibration/suggest.js` answers `no dismissed items`. A threshold therefore only moves when a
person reacted in Slack to a posted item, and the analysis's own daily judgement on thirty-odd
candidates a project is discarded.

The second judgement is in the prose. In 2026-09-20-f1 the analysis reported
`rate(cht_conflict_count[24h]) * 60 * 60 * 24` and `cht_conflict_count` as two items and wrote of
the second that it "is the standing level behind today's conflict-rate burst"; the two items cite
overlapping candidate ids (`03485e41bd02`, `dc9dd6f9a0bd` against `ac922c77ed5a`, `153a7f454f46`)
and both point at conflicts on the same project in the same window. The relationship is real, the
analysis found it, and it survives only inside a sentence.

**Decision**. A candidate in the last accepted pass's `not_selected` becomes a calibration
observation of its own kind, with the reason kept. A person's verdict on the same candidate always
decides; the analysis's dismissals are used only where no person has judged, and any suggestion that
rests on them says so in its reason. The weekly report gains, per project and metric, what each rule
raised, what became an item, what the analysis set aside and its commonest reasons. Nothing is
applied: the report proposes and a person merges (FR-032). Separately an item may carry
`relates_to`, naming a sibling by its metric and the kind of relation; code resolves the metric to
that sibling's item id, verification rejects a metric that is not another item of the same findings
or is the item's own, the roll-up prompt receives the relation, and the weekly report counts which
metric pairs are reported together. The five-slot layout is untouched.

**Rejected: sharing an analysis between projects.** The idea is that where many projects show the
same numbers one analysis could serve them all, which at ninety projects a day is the largest cost
lever left. It is rejected here on two grounds. A judgement shared live reaches every brief at once,
so one wrong conclusion becomes ninety wrong bullets, and nothing in the run would catch it: the
gate checks a number against the project's own computed data, not whether the reasoning transferred.
And the sanctioned path already exists and is gated: a pattern card distilled from one project's
outcomes is reviewed in a pull request and then matches by metric across every project (FR-036,
`cardFor` in `src/rollup/rank.js`). The cheap and safe form of the idea, analysing one representative
of a cluster and naming the others, is a consolidation story of its own, closer to the programme-wide
alert rule of FR-078 than to a new sharing mechanism, and it should be measured against a full
ninety-project run before it is built.

**Also considered**: weighting a dismissal by the confidence the analysis stated (rejected for now:
confidence is never scored against what happened, so its weight is unknown, and scoring it is its
own piece of work); and letting the analysis name a relation by item id (rejected: identities are
derived by code from the project, metric and card, so the analysis cannot know them, which is why
the metric is the handle).

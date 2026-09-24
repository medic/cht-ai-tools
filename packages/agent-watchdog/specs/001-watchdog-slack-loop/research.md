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
  `gamma.dev.example.org`, not a URL. A second job, `cht-express-metrics`, scrapes
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
metadata carrying the stable `item_id` (until revision 28, which replaced the item replies with the
programme, Other and alerts replies of R-33); record permalinks. The bot display name `agent-watchdog` is
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
| S-11 | `smoke/render.js` inside the image with a read-only root filesystem and writable `/tmp` only (no browser since revision 30; `smoke/container.js` runs it) | Which paths a render touches is only seen with the root filesystem read-only |
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
| S-26 | An item present in two forced runs of one date is reported with the same `persisting_days` in both, and one higher in the first run of the next date | Only consecutive hosted runs, one of them forced, show the streak counting dates rather than runs |
| S-27 | On a full hosted run the retry count taken from `session.json` calls (attempts above 1) is at most a quarter of first attempts, and no revision prompt names a window numeral, a panel id or a numeral from a collected expression as an unmatched figure | The false positives only show against the real metric names, panel ids and prose the model writes at scale; `verification.pass<n>.json` holds the final attempt only, so the ledger is the source for retry counts |
| S-28 | With `AGENT_WATCHDOG_PASSES` unset, a hosted run records one pass per project with items and the review pass never opens; a project whose first pass was rejected on every attempt is named in the brief's incomplete-analysis notice with the commonest failing check | Only a hosted run has projects whose prose exhausts the retries |
| S-29 | With `AGENT_WATCHDOG_PASSES=2`, `prompt.pass2.md` carries the previous items and the unselected candidates and no `## Candidates`, `## Computed changes` or `## Firing alerts` section, and pass-2 cache-creation tokens fall well below pass 1's | The saving is only visible against a real candidate set and a real session |
| S-30 | After two forced runs of one date, `get_item_history` for an item both carried returns one entry for that date, from the later run, and none for the current run's own date | Only the hosted volume has same-date re-runs with accepted items |
| S-31 | `files.uploadV2` with `channel_id`, `thread_ts` and `initial_comment` shares `report.html` as the first reply of the brief's thread, readable by channel members, and the result carries the share's `ts` and file id | The share's rendering of an HTML file and the shape of the completed-upload result are not stated in the typings |
| S-32 | A thread note `#7 :-1: expected until 1 October` under a hosted post is recorded on the item ranked 7 of that run with verdict `down` and the horizon, and a note `:+1:` alone is recorded unmatched | Slack's delivered text for the thumbs (shortcode or emoji) and the ranked items of a real run are only seen in the channel |
| S-33 | On a hosted run whose first roll-up draft is rejected, the second turn's cache-read tokens are at least the first turn's cache-creation tokens and only the failing bullets change between `brief.draft1.json` and `brief.draft2.json` | Prefix caching across turns of one session is only measurable on the runtime |
| S-34 | On a full hosted run the sessions that retry are at most a quarter of those that ran, no revision prompt names a numeral present in that project's `prompt.pass1.md` or `tool-calls.jsonl` as unmatched, and no revision names two decimals side by side as a phone number | The given-text rule only shows against the volume of prose the model writes at scale |
| S-35 | On the hosted watchdog a run opens no session for a project whose only candidates are standing conditions, names them in one notice per rule with the programme counts, folds the dark hosts into the housekeeping line, and lists them per host in `report.html` | Only the hosted volume has programme-wide chronic conditions |
| S-36 | On the hosted dashboards `discovery.json` records the six reference-line targets with `reference_line.subject` and `source`, `metrics` shrinks accordingly, and `Sentinel Backlog >50` is classified `backlog` at medium | The stock dashboards' second targets are only seen against the live Grafana documents |
| S-37 | The report shared into a hosted brief's thread opens for a channel member and its item, standing and alert links open the hosted dashboard panels and alert lists; with `AGENT_WATCHDOG_REPORT_LINKS=none` the same report carries no `href` at all | Slack's rendering of a shared HTML file and Grafana's acceptance of the built URLs are only seen live |
| S-38 | A hosted run with `--group <programme>` collects, analyses and briefs only that programme's projects, the standing and housekeeping lines cover only them, and the classified alert record and episodes stay whole | Only the hosted volume has programmes of several projects |
| S-39 | On the hosted watchdog the high items of a run are no longer the chronic outbound-push backlog: the standing line names it once, the metric's `monotonic` candidates are withheld, and a chronic backlog that jumped 50% in a day reaches the model at medium | Only the hosted data has 45 chronic backlogs in one programme |
| S-40 | On the hosted watchdog the current windows fetched equal `discovery.metrics` (69, not 74) and the candidate count falls by the reference-line candidates (about 140 of 1,189) | The leak only shows against the live dashboards' second targets |
| S-41 | On a full hosted run the sessions that retry are at most a quarter of those that ran, no revision prompt refuses a numeral that is a difference, ratio or percent change of two computed values, no revision names a signed decimal as a phone number, and no pass is rejected for a `relates_to` naming its own metric | The derived values the model writes only show at scale |
| S-42 | A hosted brief posts without an image block and without a private file upload before the parent, and the thread's first reply is the report share | The absence of the upload is only observed against the Slack app |
| S-43 | A hosted post's footer reads `specs · configuration · trace · cost · run <id> · N more items in the report (thread)` with the specification link opening the feature's `specs/` directory, and the shared report opens in the original design with its panel, standing and alert links working | The rendering of the footer and of a shared HTML file is only seen in Slack |
| S-44 | On a hosted run no revision prompt refuses a numeral that appears in a `get_windows` result or in the candidates the model was given, every phone-number reason names the digits it refused, and no project is rejected on all attempts for a byte count | The refused strings only occur at scale against the live data |
| S-45 | A hosted `--group` brief and report say "Checked 30 projects" for a programme of thirty, and the heartbeat headline counts the same | Only the hosted volume has programmes |
| S-46 | A hosted brief threads a reply for each high item and each alert group and none for a medium or low item, and the report share's comment counts the replies | Only the live thread shows the count |
| S-47 | On a hosted brief every sub-bullet of a programme starts with its project's short host and every single-project bullet with its full host, none repeats the host, and the model's lines describe the change without metric keys | The model's wording under the new instruction only shows live |
| S-48 | A hosted post shows its whole headline, at most two programme bullets of at most three project lines, no alert bullet, and its thread holds the report share, one reply per remaining programme with two or more flagged projects, one Other reply and one alerts reply whose links open the filtered alert lists | The thread's shape and Slack's rendering of a bold section headline are only seen live |
| S-49 | After two people write in sequence about one item under a hosted post, the next day's digest shows the item suppressed until the corrected horizon or quotes the lines from the project's `prompt.pass1.md`, and its trace link opens the run in Langfuse at the pass-1 generation | Langfuse's `?observation=` deep link and the SDK's observation id are only verified against the hosted instance |
| S-50 | The built image passes `smoke/container.js` under `--read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001` and `--network none` where no network is needed: `--version`, `egress --format hosts`, `check` of an unreachable host exiting 69, the report rendering under `/tmp` | Whether the runtime's start-up writes stay under `/tmp` and `/data` is only seen with the root filesystem read-only |
| S-51 | With the deployment's egress policy applied, a scheduled run completes and a deliberate request to a host outside the list from inside the pod is refused at the network | The policy engine and its FQDN handling are the platform's |
| S-52 | In the local Compose setup, `claude auth login` completes inside the `login` service, `auth status` then shows the account, and a `run --dry-run` with the CLI engine and no key logs `agent.cli_auth` with `mode: login` and `credentials_found: true` and analyses a project on the subscription | The OAuth flow needs a person's browser and account; only the wiring is verifiable without them |
| S-53 | Under the CLI engine, the stdio tools server answers a `query_metric` whose Grafana proxy answers a redirect off the egress list with a refusal (exit 69 in its log), never a connection to the redirect target | The tools server is a separate process; only a live run shows the guard installed in it |

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
Claude Code prints the failure as the result on stdout." The same payload showed: one programme's
client-errors reply at 3,999 characters cut to 2,999 with an ellipsis inside the second link; `Low
Disk Space` instances on `a.south.example.org:9100` and `b.south.example.org:9100` under "Other"
because the port defeated the `*.south.example.org` pattern; "Resolved since the previous run: Message
Delivery (2h) on training.south.example.org" for a host the ignore list drops; and seven `API Server
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
the largest programme (50 firing) and two smaller ones, plus a housekeeping line for seven hosts and a
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

## R-26. A published number that counted runs and called them days

**Evidence** (the run records of 2026-09-20, 2026-09-20-f1 and 2026-09-20-f2, read on 2026-09-20).

All three runs analysed the same date. Their `rollup/items.ranked.json` files carry the same item,
`cht_conflict_count` on one project, with `persisting_days` of 1, then 2, then 3. The third run
therefore published the headline "document conflicts climb for third consecutive day" and a thread
line reading "persisting 3 days" about a metric that had risen on one date and been looked at three
times. The analysis then read the inflated streak back out of its own item history and wrote that
the burst was "first observed yesterday", so a wrong number became wrong prose.

The count is produced by `previousItemCounts` in `src/rollup/history.js`, which walks run ids from
`RunDir.list` and stops at the first run without a ranked-items file, and applied in
`src/rollup/rank.js` as `persisting_days: 1 + (previousItemIds.get(item.item_id) || 0)`. Both
`src/publish/payload.js` and `src/render/report.js` render it as `persisting ${n} days`. Under the
06:00 schedule there is one run per date and the two readings agree, which is why this survived to
here; `--force` separates them and the published number is then wrong by the number of re-runs.

**The root cause is a contradiction in the specification, not a coding mistake.** FR-009 asks an
item to carry "the number of days it has persisted" and the Edge Case promises the reader
"persisting N days", while the Item table in data-model.md defined the field as "Consecutive prior
runs whose accepted items contained this `item_id`, plus one" and the Lifecycle line said "next runs
increment `persisting_days`". The implementation followed the data model faithfully. One of the two
readings had to give.

**Decision: days win, and a date is the unit.** The number is published to a person as days, and how
many times an operator re-ran a date is an implementation detail of the operator's afternoon.
Persistence counts consecutive immediately preceding analysed dates whose ranked items contained the
item id, plus one. Within one date the authoritative run is the latest, because that is the run whose
output was published; earlier forced re-runs of that date are the same date and add nothing. A date
whose authoritative run has no ranked-items file ends the streak, which keeps today's behaviour at
that boundary. The run's own date contributes nothing, so a re-run of a date reports what the first
run of that date reported.

Nothing new is stored (constitution IV). `RUN_ID_PATTERN` in `src/store/run-dir.js` is
`/^\d{4}-\d{2}-\d{2}(-f\d+)?$/`, so the analysed date is the first ten characters of an id the code
already has, and the grouping is derived rather than recorded.

`previousRunIds` stays run-keyed and keeps its three other callers, which genuinely mean runs: the
previous discovery for episode correlation in `src/cli/stages/rollup.js`, the previous classified
alerts for newness in `src/cli/stages/analyze.js`, and the previously discovered hosts in
`src/rollup/new-projects.js` all want the most recent earlier run that got far enough to write a
file. Alert newness in particular is measured against the immediately preceding snapshot by design,
so lifting it to dates would change behaviour that is correct.

**Not a defect, recorded so it is not "fixed" later.** The agent stage's own item carries
`persisting_days: 1` in `src/verify/gate.js`. Persistence is a roll-up concern that the agent stage
cannot know, and the first analysis of this run wrongly read that placeholder as a second bug
disagreeing with the rendered 3. The placeholder is correct and stays; only the roll-up computes the
real value, which is constitution III working as intended.

**Also considered**: counting calendar days between the first and last sighting rather than
consecutive dates (rejected: it would report a gap of a week as "persisting 8 days" when the item was
absent for six of them, which is a different and less useful claim than a streak); and storing a
first-seen date on the item (rejected: it stores something new to answer a question the run ids
already answer, against constitution IV).


## R-27. A gate that rejected the run's own numbers, and review passes that mostly confirmed

**Evidence** (the run record of 2026-09-20-f4, Sonnet 5, 90 projects, read on 2026-09-21). The account's
session limit stopped 35 sessions; 55 completed; the run cost $47.84, of which the 35 failures cost about
$1.19 in partial work.

**The gate.** `verification.pass<n>.json` holds only a pass's final attempt, so a first reading counted 8
rejections. The session ledgers (`session.json` `calls`, one entry per model call) show 157 first attempts
and 100 retries, agreeing exactly with the 100 `# Revision` headers the harness appends to
`prompt.pass<n>.md`. 49 of 90 sessions needed at least one retry; retries cost $8.62, 18% of the run. The
100 revision prompts carry 365 reasons: `numbers_match` 272 (in 72 of the 100 revisions), the phone
pattern of `personal_data_absent` 39 (31), reference URLs not seen in tool results 33 (20), `relates_to`
11, dates 2, other 8. 70 of the 100 retries were caused only by `numbers_match` and the phone pattern
($5.79 direct); 19 more mixed those with a real reason; at most 11 had a legitimate cause alone. The
review pass then spent turns dodging the same checks: pass-2 change reasons read, verbatim, "Reworded
why_now to remove raw byte-count figures that the verification gate misread as phone numbers" and
"Removed the long-precision sigma figure from why_now for the same reason".

Each mechanism was confirmed by running the code. `WINDOW_NAME_TOKENS` in
`src/verify/checks/numbers_match.js` is the set `{"14d"}`: `extractNumbers("trailing_14d")` yields
nothing and `extractNumbers("trailing 14d")` yields `14d`, so "over the trailing 14 days" or "a 14-day
baseline" yields the token `14`, refused 61 times, the single commonest rejection. Only backtick code
spans are matched against collected expressions, so a metric expression written in prose leaks its
numerals: `rate(cht_conflict_count[24h]) * 60 * 60 * 24` yields `24h`, `60`, `60`, `24` and
`cht_date_current_millis / 1000` yields `1000`. A panel named in prose ("open panel 34") yields `34`,
refused 7 times, with `2` and `7` likewise. `phoneMatches` in `src/verify/patterns.js` flags any bare run
of nine or more digits, so document and byte counts such as 9532463080, 1795907584, 980205568 and
903880600 were refused as phone numbers, while the same figures with thousands separators pass, which is
why the final items carry commas the model learned to insert.

**Decision on the gate.** A numeral is not an invented figure when it spells a numeric part of a window
name (every `extractNumbers` form of each window name, with and without the unit letter, so `14` and
`14d` alike), or appears inside any metric key or panel expression the run collected, or is the id of a
collected dashboard panel. Those three sets are built from the run's own discovery in code and their
tokens are exempt before matching; the code-span rule is unchanged. A run of nine or more digits that
equals a computed value allowed for the item, under the same allowed values `numbers_match` uses and
compared as an integer, is a number, not a phone number; a digit run matching no computed value stays a
phone number, so a bare twelve-digit telephone number is still caught. Storing every rejected attempt's
report was considered and rejected: the revision prompts already preserve every reason, so nothing is
lost, and the ledger is the source for retry counts (S-27).

**The passes.** The run was configured with `AGENT_WATCHDOG_PASSES=3`. Of the 55 completed sessions 10
ran one pass, 26 two and 19 three; 42 converged. By the ledger, pass 1 cost $26.22 (55%), pass 2 $16.15
(34%) and pass 3 $5.47 (11%): review passes were 45% of model spend. Of 40 pass-1-to-pass-2 diffs, 26
were empty and 14 changed something, adding no item, removing one and changing fourteen; the model's own
`changes` lists across pass 2 hold 47 changed, 4 added and 1 removed, and the sampled reasons are wording
and evidence edits ("Enriched suggested_check", "Attempted to downgrade severity") plus the gate-dodging
edits above. Of 18 pass-2-to-pass-3 diffs, 16 were empty.

**Decision on the passes.** The default number of passes becomes one. The within-pass revision loop
(FR-017) is unchanged and remains how a gate failure is corrected; the review pass stays available by
configuration for calibration periods. Six projects had pass 1 rejected on all three attempts, and five
recovered only because a review pass ran anyway: the skip condition in `src/agent/session-loop.js`
(`!acceptedItems.length && lastAcceptedPass === pass`) does not fire while `lastAcceptedPass` is still
zero, so pass 2 opened as a review of an empty list and acted as a fresh attempt. With one pass those
projects end with no items, and `analysisRecord` in `src/rollup/analysis.js` named only failed sessions
and sessions a bound stopped, so a fully rejected project would pass as quiet. The record therefore gains
`rejected`, read from the `gate` each pass already stores, with the commonest failing check, and the
brief's incomplete-analysis notice names it. The skip condition is deliberately left alone: with one pass
by default the question is moot, and removing a behaviour that helped five projects needs its own
decision.

**The review prompt.** For one project `prompt.pass1.md` is 85,364 bytes and `prompt.pass2.md` 89,471;
the `## Candidates` heading appears in both and 37 of the 39 candidate ids in pass 2 are the ids of pass
1; pass-2 cache writes averaged 27,043 tokens per session against 13,167 for pass 1. FR-057 exists so
that earlier turns remain available to later passes, and the first turn already carries the candidates,
the computed changes and the firing alerts. The review template drops those three sections and says they
are in the first turn.

**The history tool.** `itemHistoryFor` in `src/cli/stages/agent.js` took the last thirty run ids
excluding only the current one, so forced re-runs of one date each appeared as a history entry. The
analysis wrote, verbatim, that a conflict item "matches history of this metric firing at medium severity
across today's earlier passes, indicating a persistent conflict-generation event rather than a
single-scrape spike": three re-runs of one date read back as persistence, the defect revision 21 fixed
for `persisting_days`, in another place. The tool now returns one entry per analysed date, from the last
run of that date, over the thirty most recent analysed dates strictly before the run's own, reusing
`analysedDatesBefore` from `src/rollup/history.js`; the entry shape is unchanged because `run_id`
already carries the date.

**Rejected or deferred here**: storing rejected attempts' reports (above); changing the pass-loop skip
condition (above); any change to the deterministic high-severity rules, the dark-host sessions or the 28
near-identical outbound-backlog items of this run, which belong to a separate decision about what code
hands the model at all; and Grafana panel screenshots in the brief, which the Clarifications already
answer with No and which would be a new story.

## R-28. A thread nobody would read, a gate that refused what it had said, and a roll-up that started over

**Evidence** (the run record of 2026-09-20-f5, Sonnet 5 at high effort on the command-line engine, one
pass, concurrency 5, 90 projects, read on 2026-09-21). Every session completed; the run cost $39.41, of
which the project sessions $37.45 and the roll-up $1.96; collection took 660 s, the sessions 3,049 s and
the roll-up 615 s.

**The thread.** 150 ranked items (56 high, 48 medium, 46 low). The five-slot layout placed 21 items in
the body (20 of them as one-line sub-bullets) and 129 in the thread, beside 9 alert groups, and the
payload carried 159 thread replies: one per item, as FR-020 then required, plus one per alert group. A
reader cannot use 159 replies, and every reply is a reaction target nobody will reach. Of the 150 items,
14 carry `relates_to` (13 `same_cause`, 1 `consequence_of`), each resolving to an item of the same run,
none in the body; the roll-up prompt carries the relation and nothing downstream presents it.

**Decision on the thread.** Only body items get a reply, highest rank first, at most twenty-five (a
constant in code beside the fifty alert instances, not a setting), then the alert groups as before. The
one-page report (FR-022) is shared into the thread as its first reply through `files.uploadV2` with the
channel and the parent's `thread_ts`: a file uploaded without a channel is readable by the bot alone, so
the earlier private upload could not be linked for readers, while a share in the thread is. Its
code-built comment says how many items the report holds, how many have replies, and how to cite an item
in a note: `#<rank>`, or the host and metric, with a thumbs as the verdict. The report numbers every item
by rank, shows its identity, nests an item under the higher-ranked item it relates to, and lists the
standing conditions below. The parent's footer counts the items that are only in the report. Feedback
follows: `matchNote` resolves `#<rank>` against the ranked items of the run whose post the note sits
under, before the item id, host and metric; a thumbs written in a note (`:+1:`, `:thumbsup:`, `:-1:`,
`:thumbsdown:` or the emoji) is that note's verdict, counted like a reaction; a thumbs citing nothing
stays unmatched and is surfaced as today. Reactions on body-item replies map exactly as before. A
related item beyond the body takes no reply, like every thread item now; the higher item's reply names it
with the relation and rank, and a related body item keeps the reply its bullet needs.

**The gate.** The sessions retried on 78 of 90 projects (90 revisions, $7.72 against $29.73 for first
attempts). The revision prompts carry 301 refused numerals; the commonest were `24h` (16), `5` (10),
`41` (10), `2` (9), `48h` (9), `7`, `34`, `60`, `74` (8 each) and `24` (7). Checked against the text the
model had been given, 183 of the 301 appear in the pass-1 prompt (alert `days_firing`, the `[24h]` of an
expression, a panel id, a history count) and 111 more only in a tool result the session received
(windows, item history); 7 appear in neither (`48h` five times, `1500x`, `5.9h`: durations and ratios the
model derived). 48 of the 90 revisions carried no reason other than such numerals and the phone pattern
(8 reasons, one of them two decimals side by side, "0.00465 (0.01858", spanned by the phone pattern
because `DECIMAL_PATTERN` requires the whole match to be one decimal); the other 42 had a real cause:
reference URLs the tools never returned (22), `relates_to` naming the item's own metric (9), code spans
that are not collected expressions (6), and the derived durations. The revision-22 exemptions did remove
the classes they targeted (no window numeral, no panel id and no phone-shaped count among the 301), but
the model quotes far more of its input than the run's identifiers.

**Decision on the gate.** A numeral present in the text the model was given in its session, its prompts
and the results its tools returned, is not a figure it invented. The session loop hands the gate that
text (`givenText`); `numbers_match` exempts a token whose bare value (separators and unit letter
dropped) appears in it, after the computed values are tried. For a brief bullet the given text is the
item's own prompt entry and the run-wide counts, never another item's, so a bullet cannot borrow a
neighbour's number; without that scoping every small integer would pass against 150 items' ranks. A
numeral in neither set still fails: the 7 derived durations stay refused, and that is the check working.
The phone pattern learns that a match whose whitespace- or bracket-separated parts are each a decimal, a
date or a time is a list of values. Together these would have removed 48 of the 90 revisions (S-34
measures the hosted effect). Noted, not changed: `close()` accepts an integer token within ±0.5 of any
allowed value, so `2` matches 2.4 while the formatter would have written `2.4`; a looseness in the
model's favour, left as is.

**The roll-up.** Three drafts were rejected in turn, each on one or two of twenty-one bullets: draft 1 on
`projects_known` (a host written as its first three labels, a label-boundary prefix of a discovered
five-label host, three times, to fit a bullet) and on `21`; draft 2 on the phone pattern in one bullet;
draft 3 on `2`. Each attempt re-sent the whole prompt of 150 items in a fresh single-turn session and
asked for a whole new draft, so bullets that had passed were rewritten and could fail anew; after the
third the run published the deterministic degraded brief. The roll-up's cost records carried zero cache
tokens because `costRecord` read one spelling of the counters while the runtime's result carries the
other; `normaliseUsage` in `src/agent/turn-mapper.js` already reads both. The exact roll-up prompt is
not stored, unlike `prompt.pass<n>.md`, which made this reading harder than the sessions'.

**Decision on the roll-up.** Recover, do not restart. The brief is drafted in one session on the same
engine (`openSession` with no tools), so the items are sent once and the prefix is cached; a turn after a
rejection carries only the failing bullets with their reasons and asks for the full draft with every
other bullet copied verbatim; code then assembles the draft it verifies from the accepted bullets of the
previous attempt and the rewrites, so a retry can only mend what was wrong. `rollup/prompt.md` records
the turns with `# Revision n` headers. `costRecord` normalises usage. `projects_known` accepts a host
written as the leading two or more labels of a discovered host, since it names that project; a bare
domain or a single label still names nothing.

**What code hands the model.** 48 of the 56 high items are the outbound-push-backlog rule: 49
`backlog_absolute` candidates, every one with a previous-day value above zero, 45 of them on one
programme of 47 projects and the rest on three others; 14 sessions produced nothing but that item
($4.71), and the Grafana rule for the same condition was read firing on 83 instances. Eight hosts read a
scrape target of zero for the whole window and the day before; their eight sessions ($1.73) produced nine
items, all "target down", and seven of the hosts already carried the classified housekeeping instance
"API Server Down", stale for 74 days. Of 1,189 candidates, 324 come from expression metrics and 161 of
those from six targets: `cht_connected_users_count * 0.003 + 2` (34) and `cht_connected_users_count / 10`
(34), and three lines drawn from `rate(cht_couchdb_update_sequence{db="medic"}[30d])` scaled and offset
(`* 60 * 60 * 24 * 0.25 + 10`, `* 60 * 60 * 0.05 + 5`, `* 60 * 60 + 500`; 24 each), which are each the
second target on a panel whose first target is the panel's own series (a users threshold beside the
replication-limit count, an expected rate beside the conflicts, backlogs and feedback rates), and the
clock skew `floor(abs(cht_date_current_millis / 1000 - time()))` (21), the single target of its panel. The
model made two low items of the 140 reference-line candidates and one of the 21 skew candidates. The
hosted watchdog also fires a rule titled `Sentinel Backlog >50`, read on 83 instances, which
`alerts.yaml` lacks, so it was classified uncategorised at medium importance and formed a group of its
own.

**Decisions on what code hands the model.** (1) A **standing condition** is a high-rule candidate whose
condition already held before today: a `backlog_absolute` candidate whose previous-day evidence is
above zero, or a `target_down` candidate on a project whose scrape target read zero the previous day and
throughout the trailing fortnight (its trailing mean is zero). The fortnight matters: a gauge's previous-day
value is the last sample of yesterday's window, so a target that went down twenty-four hours ago already
"read zero yesterday", and an outage in its second day is news the model should weigh, while the eight
hosts of this run had been dark for 74 days. It is computed and recorded as today (thresholds, proposals and replay are untouched), derived by
code from fields the candidate and its change already carry, and withheld from the session; a project
with nothing else opens no session (FR-013). The roll-up names standing conditions once per rule as a
notice grouped by programme with the count out of the programme's size and the largest value, folds
dark hosts into the housekeeping notice (FR-080), writes `rollup/standing.json` so the report can list
them per host, and leaves them out of the degraded brief's bullets. A condition new today keeps its high
floor and goes to the model: that is news. Deduplicating against firing alerts was rejected, since what
the model sees would then depend on the alerting API answering. (2) A **reference line**, a target
after the first on a multi-target panel whose expression is another series adjusted only by constant
arithmetic, is recorded in discovery with its subject and source, like a breakdown (FR-075), and is
neither collected nor analysed. The clock skew is not one: it is its panel's only target and FR-076
makes a derived expression a gauge; its 21 candidates (16 `monotonic`, 5 `deviation`) are deferred to a
`metric_kinds` decision, since `metricKind` cannot yet name an expression. (3) `alerts.yaml` gains
`Sentinel Backlog >50: { category: backlog, importance: medium }`: medium because it fires on 83 of 90
projects on an ordinary day and the high sentinel rule already exists; a pull request, as FR-065 wants.

**Rejected or deferred here**: a configurable reply cap (a code constant, like the fifty alert
instances); linking a private report file from the parent (unreadable to anyone but the bot); exempting
every numeral of the items JSON for the brief (see above); changing the five-slot layout for related
items (revision 20 decided it does not); reclassifying the clock skew (above); storing a rejected draft's
text beyond `brief.draft<n>.json`, which already holds it; and the 22 reference-URL refusals, which are
the gate doing its job on URLs the model did not retrieve.

## R-29. The first run on one pass with a readable thread, and what still leaked through

**Evidence** (the run record of 2026-09-20-f6, the first run on revision 23: Sonnet 5 at high effort on the
command-line engine, one pass, concurrency 5, preview mode, read on 2026-09-21). Cost $35.57 (sessions
$34.93, roll-up $0.65) against $39.41 the day before; 63 minutes (collection 659 s, sessions 2,882 s,
roll-up 225 s against 615 s). 143 items (43 high, 60 medium, 40 low) from 83 sessions; 7 projects opened
no session as standing conditions only.

**What revision 23 delivered, measured.** The payload carried 20 thread replies (12 body items, 8 alert
groups) where the previous day had 159, a `report` entry of 143 items with "12 with a reply … e.g. #9",
and a footer counting 131 items only in the report. The roll-up's first draft was rejected on
`bullets[5] contains 19` and `bullets[8]` at 152 characters; the second turn changed exactly bullets 5
and 8, kept the headline, cost $0.085 and read 100,250 cached tokens, exactly the first turn's cache
creation (S-33 confirmed). `rollup/standing.json` held 49 backlog and 7 dark-host records; the standing
line and the housekeeping line with the dark hosts folded in both rendered. `Sentinel Backlog >50` was
classified `backlog` on all 82 instances and no uncategorised group remained. Three projects rejected on
every attempt were named in the incomplete-analysis notice.

**Defect 1: the standing rule leaked through the metric's other candidates.** 42 of the 43 high items
were still `cht_outbound_push_backlog_count`. `computeCandidates` gives every rule that fired on a metric
the metric's floor, and the floor is high when `backlog_absolute` fired, so withholding that one candidate
left the `monotonic` (42) and `deviation` (5) candidates on the same metric carrying `severity_floor:
high`; the model wrote the same item from them and cited "the fixed high-severity rule" the system prompt
states. The body became eight backlog sub-bullets and one backlog item, the standing line said the same
thing under them, and the alert group said it a third time, while a scrape target flapping all day (rank 9)
and a ten-million-document daily increase sat in the thread. **Decision:** a standing rule does not set
the metric's floor; on a standing metric the `monotonic` candidate is withheld too, since a queue that
never drains rises by definition, and `deviation` and `pct_change` keep candidates at the floor they earn
without the standing rule (medium for two rules, low for one), so a chronic backlog that jumps 7% in a
day still reaches the model at medium. The system prompt's severity sentence says that a backlog or a
dark host that already stood yesterday is reported by code, not raised as high.

**Defect 2: reference lines left discovery but not collection.** `discovery.metrics` fell from 74 to 69
and nine panel records carry `reference_line`, but `metricSpecs` in `src/collect/windows.js` builds the
query list from panel records with `per_project && !breakdown` and never looked at `reference_line`, so
all 74 current windows were fetched, candidates stayed at 1,189 (140 on the five lines) and one
reference-line item survived, which explained the backlog alert by the fall of its own threshold line.
**Decision:** the query list skips `reference_line` records, and the analysis computes changes only for
`discovery.metrics`, so a reused stored window for a metric no longer collected cannot re-enter.

**Defect 3: a signed decimal is a phone number.** All three fully rejected projects failed only on
`personal_data_absent`; the surviving text shows `+0.2748442279996993`, and `DECIMAL_PATTERN` allows no
leading sign. 27 phone reasons in the revisions, about $1.40 of sessions that produced nothing, and the
same string was both of the run's own `run.scan_findings`. **Decision:** a decimal may carry a sign; the
parts rule likewise.

**Defect 4: the retries are now the model's own arithmetic.** 67 of 83 sessions retried ($6.48, 19% of
the sessions' cost). The revisions carry 145 `numbers_match` reasons; of the 127 refused numerals that
parse, **127** equal a difference, a ratio or a percent change between two computed values of that
project, within display rounding ("+27 jump" is 845 − 818). The given-text rule of revision 23 removed the
identifiers; what remains is correct subtraction. The other reasons: 22 reference URLs the tools never
returned, 21 `relates_to` naming the item's own metric (the sentence added to the prompt in revision 23
changed nothing), 8 code spans, one high item without a qualifying candidate. **Decision:** `numbers_match`
accepts a **derived value**: a numeral equal, within display rounding, to `a − b`, `a / b` or
`(a − b) / b × 100` for two values the item may quote; code verifies the arithmetic instead of asking the
model not to do it. A `relates_to` that names the item's own metric is dropped by code when the items are
normalised, since the relation is empty rather than wrong, and the gate keeps rejecting a relation to a
metric that is not another item. The reference URLs stay refused: FR-016 wants a link the run built or
retrieved, and a URL recalled from training is neither.

**The image.** The brief image is a screenshot of the report's summary, rendered by a headless browser
and uploaded privately so the parent can show it as an image block: a picture of the message it sits
under. Since revision 23 the report itself is shared into the thread, readable and searchable, so the
image adds a Chromium render, an upload and 600 KB a day for nothing a reader uses. **Decision:** the
image is retired: the render stage writes `report.html` only, the payload carries `image: null`, the
publisher uploads nothing before the parent, and the Slack sequence loses its first step. Dashboard or
panel captures, which is what the image was once imagined to be, remain a later story (Clarifications);
`src/render/browser.js`, `AGENT_WATCHDOG_CHROMIUM_PATH` and the container's Chromium stay in place for it
and can be removed if that story is declined, which would also lower the container's memory ceiling.

**The report as the document.** With the report the artefact people open, three things follow. (1)
Every reference in it becomes a link when the reader can follow it: each item links its dashboard panel
(the same code-built link the thread reply carries), each standing host links its panel, each alert group
its filtered alert list, and the footer links the prompts, the configuration and the trace, beside the
cost and the line that says how to cite an item. Whether links appear is a setting,
`AGENT_WATCHDOG_REPORT_LINKS` (`internal`, the default, or `none`), because the next story after this one
is a per-project or per-programme report sent to people who have no credentials for the hosted watchdog:
a link they cannot open is worse than a name. Links to the hosted Grafana are built by code from the same
structured references as today (FR-009, FR-016), never by the model. (2) Numbers the report renders are
rounded for reading: values with more than three decimals show three, values below one show three
significant figures, and the same rounding is applied at render time to long decimals inside an item's
prose, which the stored item keeps in full and the gate verified in full. (3) The template is redesigned
under the design skill the plan already names (`design-taste-frontend`, here its minimalist and redesign
variants, read on 2026-09-21): a document-style editorial layout at a data density of about 6 of 10, a
warm monochrome canvas with 1 px `#EAEAEA` rules instead of boxed cards, a system sans-serif stack with
character and a monospace with tabular figures for metrics, identities and numbers, colour only for
severity as muted pastels, sentence case, and an item header in two rows: rank, severity, host and metric
first; persistence, confidence and identity as a labelled muted line under it, which is the confusion the
operator reported ("confidence, new today, id number" in one run of text). The skill bans emoji; FR-082
places status markers by code on the headline, bullets and notices and is kept, since the markers are
semantic and the same in Slack and the report. The wording of items is the model's and is not touched.

**One programme at a time.** `--project` already restricts a run to named hosts and FR-066 (revision 19)
makes the brief cover only what was analysed, so a tailored brief for one programme is possible today by
listing its hosts. **Decision:** a `--group` flag, repeatable, selects every discovered project of a
programme label, resolved by the one helper every stage and the presentation scope use, so collect,
analyze, agent and the roll-up agree on the set. The post still goes to the one configured channel
(Out of Scope), which is the second half of the per-programme story.

**Rejected or deferred here**: the backlog rule's threshold taken from the panel's own reference line,
which would make the rule agree with the tuned Grafana alert (1 firing of 82 instances) but needs the
reference line collected as a threshold rather than a signal, a design of its own once the standing rule
has shown its effect; removing Chromium from the container (above); posting a programme's brief to a
channel or recipient of its own (Out of Scope, the next story); rounding numbers inside Slack replies
(the reply quotes the model's text as the gate verified it); and dropping FR-082's markers from the report
for the skill's emoji ban.

**Implementation notes (2026-09-21).** Three things the tests decided while the code was written. (1) The
derived values pair counts only: with every allowed value paired, a level against a ratio (300 / 3.04)
produced 98.7 and the revision-22 test that "panel 99" is refused failed, so a ratio, a percentage or a
duration derives nothing; with counts alone the seeded fixture yields 60 derived values and the test
holds. (2) A code-built URL in the report goes through an `href` helper that escapes the five characters
that could break out of a quoted attribute and admits `http(s)` URLs only: Handlebars' default escaping
also turns `=` into `&#x3D;`, which browsers accept but which hides the query a reader may want to copy,
and the URLs come from configuration and the run's structured references, never from model text. (3) A
renderer given no link setting links nothing; the stage always passes the configured mode, so the default
of `internal` lives in the configuration alone and the older tests that expect no `href` stay true.

## R-30. The first run on one programme, and the operator's reading of it

**Evidence** (the run record of 2026-09-20-f7, `--group` on one programme of thirty projects, the first run on revision 24, read
on 2026-09-21). 30 projects selected of 90 discovered; 2 dark hosts skipped as standing and named in the
housekeeping line; 28 sessions, 29 items (16 medium, 13 low, no high), $8.55, 24 minutes (collect 3,
sessions 17, roll-up 3 with two drafts). Reference lines were not fetched (69 metrics, 276 windows per
project). The report linked all 29 items to their panels, 13 alert lists and the two standing hosts, and
rounded `4.308294733275791` to `4.308` in prose while an evidence note still read `stddev
3.2031234756093934`. The brief's checked line read "Checked 90 projects" over a run of 30. The layout
filled two of five slots (one alerts bullet, one group bullet of eight) and put 21 of 29 items in the
thread; the thread carried 8 item replies and 2 alert replies. 16 of 30 projects raised a memory-growth
candidate on the API process (7 with heap-used jumps of +130% to +242% day over day), 10 ended with an
item, 27 of the 30 run CHT 5.1.0, and the roll-up's headline named "6+ sites" because the per-project
sessions cannot see breadth.

**The gate, traced one refusal at a time.** 16 of 28 sessions were revised, 20 revision prompts, 50
reasons: 34 numbers, 9 phone, 4 reference URLs, 3 code spans. (1) Five byte counts (`390778880`,
`451162112`, `491905024`, `731226112`, `810487808`) and `1,604,078,240` were refused although every one
appeared in a `get_windows` result the model had read: the result's `[1789538400,390778880]` is
tokenised as one numeral because the comma reads as a thousands separator, so the given set held a
merged number and not the value. (2) Nine phone-number reasons, two projects rejected on all three
attempts ($1.10, 13% of spend): the model quoted the byte counts of related memory metrics from the
candidates it was given; the phone check knows the item's own allowed values but not the given text,
and its reason names a path and no digits, so the model could not tell what to remove. (3) Rounded and
signed values of related metrics (`+32.7%`, `2.48`, `63.8%` for a computed `-63.79`) were refused
because a related candidate's value counts only when cited; the model's learned repair is to copy the
full-precision figure, which is why the accepted texts carry sixteen-digit decimals. (4) `7.5` was
refused five times: an uptime of 645,829 seconds written as "7.5 days"; a unit word is not read as a
unit, and the uptime metric's values carry the unit `count`. (5) The brief's first draft was refused for
`+198.0%`, a cited candidate's `197.9758` that the brief's gate never sees because the roll-up hands it
no candidates, and for a bare `24h`, the range literal of every rate expression. **Decisions:** the
tokeniser reads a comma as a separator only in thousands groups; the phone check applies the given-text
exemption and names the digits; a decimal or percent token that rounds a given numeral within its own
decimals is that numeral, and a percentage matches by magnitude; `days` and `hours` after a numeral are
its unit and a `_seconds` metric holds seconds; range literals of collected expressions join the
identifier sets; the roll-up hands its candidates to the brief's gate. Each is a code rule with a test
on the run's own refused strings.

**The operator's reading.** The revision-24 redesign was set aside: the original report and post are
kept, with the links, the alerts section and the rounding retained (the design skill was used once and
plays no further part); the report's footer becomes the one footer of post and report, linking the
specification rather than the prompts (`AGENT_WATCHDOG_SPECS_URL` replaces `AGENT_WATCHDOG_PROMPTS_URL`;
Slack keeps its count of items only in the report); an item's header drops "rank N" beside "#N" and
moves the confidence to a line of its own under the rank; thread replies are for high items and alert
groups only (this run would have threaded 2 replies instead of 10); and the notice "model findings were
rejected by the gate on 2 of 28 projects (commonest reason: personal_data_absent)" is rewritten to name
the hosts and say in words what was refused. The notice had appeared on every hosted brief since
revision 22 because the gate defects above rejected a project or three on every run; the fixes should
make it rare, and when it appears a reader will know what it means.

**Rejected or deferred here**: programme-wide metric patterns detected by code, on the model of the
alert patterns, so a memory rise on sixteen projects of one programme is one line and one cause rather
than sixteen sessions (a delta of its own, with this run as its evidence); a minimum magnitude for the
`monotonic` rule (a clock skew flat at 217 seconds for a week read as a 10.7-hour rise from a one-second
tick); a reply-severity setting (one line when a calibration period wants medium replies); the layout of
a one-programme run (two bullets, three empty slots; the per-programme story's concern); and the model's
missing `relates_to` between a conflict count and its rate on one host (a prompt matter, if it recurs).

## R-31. Sub-bullets that named no project

**Evidence** (the run record of 2026-09-20-f8, the first full run on revision 25, read on 2026-09-22).
90 projects, 125 items (1 high, 78 medium, 46 low), $23.29, thread of 1 item reply and 11 alert-group
replies. The programme bullet "North Programme: 6 projects with 8 issues" carried sub-bullets such as
`up{job="cht"}=0 (target_down); same state as previous_day and previous_week` and two lines beginning
`cht_couchdb_doc_total{db="sentinel"}` from two different projects, none naming a project; the
single-project bullet for another programme began `cht_outbound_push_backlog_count at 4669` with no
host either. The run before (f7) had begun each sub-bullet with "North-a:", "North-b:". Nothing
in code decides this: `prompts/rollup.md` asks for "metric names as recorded" and a single line, FR-069
asks for "one sub-bullet per project item" without saying the project must be named, and the first
draft of f8 was refused for ten sub-bullets over 120 characters, so the second draft cut words to fit
while keeping the metric key the prompt demands. The host was what went. **Decision:** the project is
written by code, in front of every body line: the host's first label for a sub-bullet (`north-a: `), two
labels when two projects of the group share the first, the full host for a single-project bullet; the
layout text tells the model the prefix and the characters it has left, and asks for the change in words
without metric keys or PromQL, which the thread reply and the report already carry; the length check
counts the prefix; a host the model writes anyway at the start of its line is stripped, not doubled.
The deterministic brief's lines already carry the host and are left alone.

**Rejected or deferred here**: one thread reply per programme bullet, a code-built ticket with the
group's counts, a line for members that share a metric and one section per member without a reply of
its own (the operator asked for it; the next revision); unit scaling in the gate (`827 MB` for
826,957,824 bytes, which f8's first draft was refused for as `826,957`); one alert reply per programme
rather than per category (f8's thread was 11 alert replies to 1 item reply).

## R-32. The security checklist, re-read against the code

**Evidence** (a reviewer's pass over `checklists/security.md` on 2026-09-22; the checklist dates from
2026-09-19, revision 2). Of 34 items, 13 were satisfied and 21 found a gap, an ambiguity or a conflict.
Read against the code: the model has never had a write tool (`contracts/agent-definition.md` lists the
seven read-only tools; FR-046's "file writes only into the current run's directory" described the
system's writes but read as the model's); memory is wrapped as untrusted in all three places it is fed
back (`prompt-assembly.js`, `brief.js`, `memory.js`); link resolution fails closed on a timeout or an
error and follows a redirect only inside the allow-list (`links/resolve.js`); the untrusted delimiter is
stripped from content before wrapping; logs redact secret-named keys; the PR scan and the end-of-run
scan import the gate's own patterns. The one real gap was the failure notice: it quoted `error.message`
verbatim, which a Slack or Grafana error could fill with a token or an address. The reviewer also found
User Story 1 carrying two scenarios numbered 6, added in revision 24. **Decisions:** the requirements
say what the code does (FR-002, FR-008, FR-016, FR-024, FR-044, FR-045, FR-046, FR-054, SC-004);
egress and Slack scopes become requirements (FR-083, FR-084); the failure notice's error message passes
through the gate's patterns with matches redacted; the scenarios are renumbered; ten checklist items
are appended for the report link setting, the group filter, the direct-message test, the thread rule,
the failure notice, egress, the container, the scan's surfaces and the personal-data definition, left
unchecked for the reviewer. Browser isolation items are moot since revision 24 retired the image.

**The first `/speckit-analyze` pass** (run the same day, read-only, by a subagent over spec, plan,
tasks, data model, contracts and quickstart) found no duplicate requirement ids and no open marker,
but 33 stale statements, 7 of them in acceptance scenarios, contracts and the data model: replies
described as one per body item (revision 23) where revision 25 made them one per high item, the
footer's prompts link where revision 25 linked the specification, the brief image and its browser
where revision 24 retired them, the labelled item header where revision 25 restored the original,
and FR-046 naming `ask_question` as available where the contract denies it. All are corrected in this
revision; the historical task texts keep their wording as a record. The pass also noted that tasks
are tagged by user story and not by requirement id, so 38 requirements cannot be traced to a task by
id; the story tags are the intended traceability and no change is made.

**Rejected or deferred here**: a startup membership check of the configured conversation (needs read
scopes the app does not hold; the refused post already fails loudly); container enforcement of FR-083
(the container revision); adding "database names" as a personal-data category (none appears in any
published surface; a label value that carried one would be a hostname-like or free-text token the
existing checks already see).

## R-33. A post read in one glance, and a thread of three

**Evidence** (the run record of 2026-09-20-f8, read with the operator on 2026-09-22). The headline, 145
characters, was cut mid-word at Slack's 150-character `header` limit once its marker was added, while the
report showed it whole. The body's first bullet was six alert lines for one programme; the alerts are the
monitoring stack's own notifications, and the reader can see them in Grafana. The programme bullet's eight
sub-bullets named one metric each, so one project appeared on three lines and the reader had to reassemble
it. The thread held one item reply (the day's only high item) and eleven alert-group replies, one per
programme and category. **Decisions**, four of them put to the operator as clarifications and answered: the
headline is a bold section, never a header block, and the gate holds it to two lines of 120 characters;
the body holds the two highest-ranked programmes, each with at most three project lines and a count of the
rest, and no alert bullet; a project with several issues is one line of at most two lines covering all of
them, the project written by code, the words the model's, the layout naming every item the line must cover
so the gate allows their values; the thread is the report share, one reply per programme not in the body
with two or more flagged projects, one Other reply for the remaining projects and one alerts reply with
per-programme counts and links and the alert-derived notices; item replies and alert-group replies are
retired, so a note cites an item by its rank in the report. Programme-wide alert patterns and the metric
beside an alert move to the report's alerts section, which lists every instance.

**Feedback provenance** (FR-085, specified here, implemented in revision 29): several notes on one item are
read together in thread order so a later clarification is applied as the clarified whole, and the next
day's digest quotes the lines the feedback put into the project's prompt and links the session's trace,
because run files are not web-served (the operator chose this over sharing the prompt file or a report
section).

**Rejected or deferred here**: a report summary that mirrors the thread bullets (the report lists every
item already); a configurable count of body programmes (two is the answer until a run argues otherwise);
reactions on a programme reply as a verdict (ambiguous across its projects; the digest lists them as
unmatched, as it does for the parent).

## R-34. Feedback read as one conversation, and a digest that shows where it acted

**Evidence**: the operator's request recorded with R-33: several people comment on one item in sequence,
the later note clarifying the earlier one, and they want to know the following day how the feedback was
incorporated, with a link to the prompt that carried it. Until revision 28 each note was parsed and reviewed
alone: two notes on one item that stated two horizons pushed two `horizons` entries and the earlier, longer
one kept suppressing after a correction shortened it; two notes with one lesson produced two proposals; and
the digest named the effect ("suppressed until", "confidence raised") but not where the words went.

**Decisions**. The clarified whole is a code rule, not a model judgement: the notes of one item, in thread
order, are one sequence; the last note that states a horizon sets it, the last that states an expected
maximum sets that; the ingester writes one horizon per item and never a superseded one, `by_item[].horizon`
follows the same rule over every stored note, and each record keeps its own parse for audit. A note that
states no date reaches the model with the earlier notes of its thread as context, so "make that the 25th"
can be read. The review takes the unreviewed notes of one item together in one call and classifies the
whole; every note of the thread gets the classification and the one proposal, whose evidence and source line
name every note, so a correction never yields a second, contradicting proposal. Provenance is read back from
what the run wrote, not stored twice: the digest quotes, for each item, the `kind`, `verdict`, `note` and
`horizon` lines of that item's records exactly as they stand in the feedback block of the project's
`prompt.pass1.md` (each quoted line is checked to occur in the file; at most eight are shown, then the count
of the rest), and links the run's trace, pointing at the project's pass-1 generation when the tracer
returned its observation id, which the session record now keeps per call; when the project was not analysed
because the horizon held its candidates back, the digest names the suppression and its file; otherwise it
says the feedback was not used today. The trace link and the quoted lines are the operator's chosen answer,
because run files are not web-served.

**Rejected or deferred**: one classification per note with the thread as context (two calls can still write
two contradicting proposals, and neither call knows what the other produced); retracting an earlier
proposal when a later note corrects it (a proposal is a person's to close); a leaner feedback block in the
analysis prompt (would change what every analysis reads, out of scope here); cancelling a horizon on a
dateless "resolved" note (the parser returns null and the earlier horizon stands until its date).

## R-35. The container locked down, and egress the package can name and refuse

**Evidence**. The image built for revision 29 still installed Playwright's Chromium headless shell (about
150 MB and a `fonts-noto-color-emoji` apt install) for a render no run had made since revision 24
(R-29); the container contract stated the hardening (non-root, read-only root, dropped capabilities,
limits, egress) as expectations of the platform, with no test and no artefact the platform could apply;
FR-083 enumerated the egress destinations but nothing in the package could list them for a policy or
refuse a request outside them; and the security checklist's CHK031, CHK041 and CHK042 (R-32) asked for
exactly that. A scan of the production dependency tree (191 packages) found one `postinstall` script,
`protobufjs`'s version-scheme warning, and `prepare` scripts that npm never runs for installed packages, so
`npm ci --ignore-scripts` costs nothing. Node's `fetch` is undici's, so a guard wrapping `globalThis.fetch`
sees the package's own requests and any library that calls the global `fetch` at call time; the Slack SDK
uses its own HTTP transport and the agent runtime is a subprocess, so neither passes the guard.

**Decisions**. The hardening becomes a requirement (FR-086) and the image follows it: two stages from
`node:22-bookworm-slim`, production dependencies from the lockfile with `--ignore-scripts`, no browser, no
`apt-get`, the application owned by root and read-only to the fixed user `10001:10001`, `HOME`, `TMPDIR`
and the runtime's configuration directory under `/tmp`, no `EXPOSE`, OCI version and revision labels from
build arguments the release passes. Egress becomes something the package can state and refuse:
`src/net/egress.js` builds the allow-list from the fixed destinations (Slack, its file host, the model API,
the three reference-link hosts) and the configured endpoints (Grafana, Langfuse, the documentation service,
the specification and configuration links), host and port with the purpose of each; `agent-watchdog egress`
prints it as JSON or one host per line for the policy; and the run installs a guard on `globalThis.fetch`
and on the `fetch` it hands its stages, which refuses a destination outside the list before any connection,
as an `ExitError` with the unavailable-source code (69) naming host and port and never the URL, and restores
the original `fetch` when the run ends. The platform policy stays the enforcement of record; reference
manifests under `deploy/` (a CronJob with the security context, the three mounts, requests and limits,
`concurrencyPolicy: Forbid` and an `activeDeadlineSeconds` ten minutes past the run timeout; a default-deny
egress `NetworkPolicy` that allows DNS; a `CiliumNetworkPolicy` whose FQDNs are the egress list) are checked
by tests against FR-086 and against `buildEgress` of the manifest's own configuration, so the two cannot
drift. `smoke/container.js` runs the built image under the constraints in CI (S-50).

**Rejected or deferred**: a distroless or Alpine base (the runtime's native binary is built for glibc, and
the slim Debian image already has no browser or package use at run time); wrapping the Slack SDK's transport
(fixed hosts, covered by the policy); an in-image proxy (a second process to harden); refusing `http:`
Grafana for a contributor's local watchdog (the configured origin is allowed whatever its scheme, so a local
`http://127.0.0.1:3000` works); a plain Kubernetes `NetworkPolicy` for FQDNs (it selects CIDRs only, so the
FQDN example is Cilium's and the platform substitutes its own engine).

## R-36. The same container on a contributor's machine

**Evidence**: the operator asked, after revision 30, for a local Compose setup "in a similar type of setup".
Docker Compose v2 applies `deploy.resources.limits` (CPU, memory and PIDs; the legacy `pids_limit` key
cannot stand beside it) to `run` and `up`, honours `read_only`, `cap_drop`, `security_opt`, `tmpfs`, `init`
and `user`, and interpolates `${VAR:-default}` in volume
specifications, so one file can name a volume by default and bind a host directory when asked. A bind mount
keeps the host's ownership, so a `./data` owned by the contributor is not writable by uid 10001 without a
`chown`; a fresh named volume is initialised from the image's `/data`, which the image owns for that user.
`environment` entries override `env_file`, so the container paths can be pinned while the operator's `.env`
keeps its local ones. One difference bit at once: Compose's `env_file` reader keeps text after `#` on a value
line as part of the value (`AGENT_WATCHDOG_MODEL_FEEDBACK=   # optional …` read as the comment text and failed the
model-id validation with exit 78), while Node's `--env-file` drops it, so the same `.env` gave the two readers
different values. Verified locally on 2026-09-23 with Docker Compose 2.39, once the comments moved to their own
lines: `docker compose config`, `build`, `--version`, `egress --format hosts` (nine hosts), `check
https://example.invalid` (exit 69), the `offline` profile, and `run --dry-run --stage purge` writing the run
directory into the named volume as the fixed user under the read-only root.

**Decisions**: `compose.yaml` at the package root, one anchored service definition used twice, `agent-watchdog`
previewing by default and `offline` with `network_mode: none`; a named volume `agent-watchdog-data` by default
and `AGENT_WATCHDOG_COMPOSE_DATA` for a bind; `config/local` (or `AGENT_WATCHDOG_COMPOSE_CONFIG_DIR`) mounted
read-only at `/etc/agent-watchdog`, a missing file falling back to the package default as `loadPolicy` already
does; secrets only through `env_file: .env`; `compose.yaml` in `.dockerignore`; `.env.example` reformatted with every
comment on its own line and a test (`test/config/env-example.spec.js`) that holds the format and that the file
names exactly the variables the schema reads, so Compose and Node read one `.env` alike. **Rejected**: a local stand-in
for the network policy (Docker filters no destination by name, and an `internal` network would block the model
API too); a compose-managed Grafana or Slack; running as the host user (it would let a run write to the
application files a real deployment keeps read-only).

## R-37. A contributor's own Claude login in the local container

**Evidence**: the operator wants the local container to run `claude -p` (the CLI engine) on the Team plan for
individual use, logging in once inside the container with the login kept in a volume, as `cht-agent`'s seeder
already does (`docker exec -it cht-seeder claude` for a one-time OAuth login into a named volume mounted at the
runtime user's `~/.claude`; that image installs `@anthropic-ai/claude-code` globally). Here the Agent SDK already
ships the Claude Code runtime: `@anthropic-ai/claude-agent-sdk-linux-x64/claude` is an executable native binary
(234 MB, `2.1.278 (Claude Code)`) with `-p/--print`, `auth login [--claudeai|--console|--sso]`, `auth status`,
`auth logout` and `setup-token`; its OAuth authorize and token endpoints are on `platform.claude.com` (read from
the binary's strings), which the scheduled run's egress list does not carry because that run never logs in. The CLI engine resolves `claude` on PATH (or `AGENT_WATCHDOG_CLAUDE_PATH`) and,
with no key configured, runs in login mode reading the credentials file under `CLAUDE_CONFIG_DIR` (R-3). The
image bakes `CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime`, a tmpfs in the local setup, so a login there would
not outlive the container; and the root filesystem is read-only, so the runtime's home has to be a mount.

**Decisions**: symlink the SDK's binary to `/usr/local/bin/claude` at build time (`test -x` first, so a build
without the platform package fails loudly) and install nothing else, keeping the runtime version the SDK's own;
a named volume `agent-watchdog-login` mounted at `/home/watchdog`, the runtime user's home (created in the image,
so a fresh volume takes its ownership), with `CLAUDE_CONFIG_DIR=/home/watchdog/.claude` set by Compose for every
service, so the runtime's `.claude/` and `.claude.json` both land in the volume whatever the version writes; a
`login` profile running `claude auth login` under the same hardening with a TTY; login mode chosen by
`AGENT_WATCHDOG_ENGINE=cli` with `ANTHROPIC_API_KEY` blank (a key wins, key mode with `--bare` never reads a
login); the volume documented as holding an OAuth token: named, never bound into the repository or the image,
read-write because the runtime refreshes the token, cleared with `auth logout`. The `offline` profile's example
is corrected: `replay` regenerates findings with the model, so only `purge`, `analyze`, `render` and a preview
`publish` run with no network. Verified locally on 2026-09-23: the rebuilt image answers `claude --version`
as the bundled runtime under the hardened flags; `claude auth status` in the login service reports the volume's
configuration directory and writes only there; the in-container `auth login --help` offers the subscription
flow. The login itself is the operator's to complete (S-52).

**Rejected or deferred**: installing `@anthropic-ai/claude-code` in the image (a second copy of the runtime,
another version to drift, another 200 MB); a `CLAUDE_CODE_OAUTH_TOKEN` path for the SDK engine (the CLI engine
already has login mode, and a subscription token is a person's, not a scheduled service's); binding the host's
`~/.claude` into the container (it would expose the contributor's whole configuration, sessions and memory).

## R-38. The branch review: fifty-two findings verified, three revisions to answer them

**Evidence**: on 2026-09-24 the operator brought a code review and a PR review of the branch by another agent
(sixty-three findings, fifty-two distinct after duplicates, three scored 80 or above). Every finding was
re-verified here against the code before anything was planned; the table records what was found and where it
is answered. Scores are the reviewer's. "Held" means the code does what the finding says.

| # | Score | Finding (short) | Held? | Answered in |
|---|---|---|---|---|
| 42 | 85 | `numbers_match` seeds its allowed values from the item's own `evidence`, so an invented evidence value lets the same numeral through in prose | yes: `allowedValues` maps `item.evidence` first | revision 33 |
| 2 | 80 | the brief gate checks numbers and URLs in bullets only; the headline and `expected_load_notice` are published unchecked for numbers, URLs and hosts | yes: `numbers_match` brief branch walks bullets; `bullet_length` URL rule on bullets; `projects_known` skips the notice | revision 33 |
| 23 | 80 | `run.js` stores window ids where the roll-up's notice builder expects window objects, so the notice is blank on every window day | yes: `activeWindowsFrom` stores `expected_load_window_id`; `expectedLoadNoticeFrom` reads `window.note \|\| window.id` | revision 33 |
| 10 | 75 | a stored horizon loses `expected_max` and `observed_value`, so from the second day it suppresses every candidate whatever its size | yes: `expected_max` only from `parsedToday`; the Feedback record has no such field | revision 34 |
| 56 | 75 | the session loop extracts URLs from `JSON.stringify(tool_response)`, mangling multi-line results; `verify/tool-urls.js` is unused | yes: `urlsIn` stringifies; the escaped newline is not a URL boundary | revision 34 |
| 1 | 70 | a session cut off by the run deadline is neither failed nor incomplete, so the brief reads "All quiet" | yes: `INCOMPLETE_BOUNDS` is `budget`, `turns`; the deadline path adds `timeout` | revision 34 |
| 25 | 70 | every run re-appends each confirmed or dismissed item of the influence window to that day's outcome file | yes: `appendOutcomes` dedupes within one day's file only | revision 34 |
| 38 | 70 | the Dockerfile hard-codes the `linux-x64` runtime package, so a build on arm64 fails | yes | revision 35 |
| 46 | 70 | Slack user ids in note text reach the model; `personal_data_absent` has no rule for them | yes: `sanitiseData` drops identity keys, not mentions inside text; parse wraps the raw note | revision 33 |
| 13 | 65 | the digest acknowledges notes whose review failed and says the next run will review them; acknowledged notes are never reviewed again | yes: `acknowledged: records.map(...)` | revision 34 |
| 17 | 65 | retention never purges `runs-replay/` | yes | revision 35 |
| 48 | 65 | eighteen branch commits fail commitlint (headers to 173 characters, body lines over 100) | yes, checked with commitlint | operator decision (history rewrite) |
| 52 | 65 | AGENTS.md describes the five-bullet layout and per-alert-group replies | yes | revision 35 |
| 0 | 60 | the standing-backlog test falls back to the previous-cycle evidence as "yesterday" | yes: `previousDayValue` reads `previous_day ?? previous_cycle` evidence | revision 34 |
| 5 | 60 | live `query_metric` returns `series[0]` of several, labels every result `count`, never gets `activeWindowFor` | yes | revision 34 |
| 22 | 60 | the roll-up reads the highest-numbered pass file even when the gate rejected it | yes: `lastFindingsFile` takes the max pass; also `calibration/report.js` and `replay.js` | revision 34 |
| 37 | 60 | the alerts reply is `truncate`d at 3000 characters and can be cut mid-link | yes | revision 34 |
| 6 | 55 | the heartbeat headline says "no candidates" with `checked.candidates` above zero | yes | revision 34 |
| 11 | 55 | note horizons resolve against the run date, not the note's own date | yes: `noteDate: observedDate` | revision 34 |
| 12 | 55 | the report drops an item whose relation chain is two levels deep | yes: `itemView(other, ...)` passes no `related`; grandchildren are in `nestedIds` | revision 34 |
| 14 | 55 | the stdio tools server loads no pattern cards, so the CLI engine can never read one | yes: `patternCards: deps.patternCards \|\| { index: [] }` | revision 34 |
| 15 | 55 | a session ended by the harness turn cap or a timeout records $0 | yes: `synthesizeResult` `total_cost_usd: 0`; a rejected turn adds nothing | revision 34 |
| 27 | 55 | run cost leaves out the feedback stage's calls; a stage-only roll-up leaves out the agent's spend | yes: `costSoFar` sums agent and roll-up only | revision 34 |
| 30 | 55 | `--log-level` and `--log-format` are parsed and never applied | yes: the logger reads the environment only | revision 35 |
| 40 | 55 | run records from the image name `0.0.0-development` and `git_sha: null` | yes: version and revision are image labels only | revision 35 |
| 55 | 55 | `dates_match` checks nothing the model writes; its evidence branch cannot run under the strict schema | yes | revision 33 |
| 4 | 50 | one project's discovery query failing aborts the run | yes: `queryInstant`/`queryRange` per host, uncaught | revision 34 |
| 20 | 50 | the analysis prompt's date is the wall clock, not the run date | yes: `now().toISOString()` | revision 34 |
| 34 | 50 | the egress guard checks the first URL only; a redirect connects anywhere; tools-server, calibrate, distill and replay have no guard | yes | revision 33 |
| 58 | 50 | a session that fails to open fails the whole stage | yes: `openSession` is outside the try | revision 34 |
| 3 | 45 | a 4xx or 500 query failure resets the consecutive-failure counter | yes | revision 33 |
| 8 | 45 | the worker pool's other workers keep starting items after the first rejection | yes | revision 34 |
| 16 | 45 | `get_windows` accepts loose key forms and looks up by exact string | yes | revision 34 |
| 28 | 45 | a Slack failure after the parent post loses the publication record | yes: written after the digest | revision 34 |
| 32 | 45 | calibration counts forced re-runs as separate days | yes | revision 34 |
| 35 | 45 | the gate fetches model-supplied URLs before the allow-list and tool-result checks and swallows an egress refusal | yes: `resolveAll` runs before `runChecks`; the resolver's catch returns a reason | revision 33 |
| 50 | 45 | a stage-only roll-up never resolves links and `links_resolve` passes as "offline" | yes: `ctx.resolveLinks` is set after `collect` only | revision 34 |
| 7 | 40 | the personal-data check exempts the memory update because "code masks it", but `memory.js` stores it verbatim | yes | revision 33 |
| 9 | 40 | the degraded notice always says "three drafts" | yes | revision 34 |
| 18 | 40 | a failed model parse of a dateless note is silent and the missing horizon is stored for good | yes | revision 34 |
| 21 | 40 | the CLI engine calls `mkdirSync` on `fs/promises` and swallows the TypeError | yes (revision 30's own defect) | revision 35 |
| 26 | 40 | a bad `--stage` or `--date` creates the run directory before validation | yes | revision 35 |
| 31 | 40 | no per-command flag validation; `replay --stage` runs a full replay | yes; the effect is harmless, the contract says 64 | revision 35 |
| 61 | 40 | dead modules and exports (`trace/cost.js`, `verify/tool-urls.js`, `fileIdOf`, `toLayoutDocument`, `materialize`, `readByItem`, `readAlertEpisodes`) | yes; `tool-urls.js` becomes the extractor in revision 34 | revision 35 |
| 29 | 35 | `tracer.finish` is unguarded in replay, distill and calibrate | yes | revision 35 |
| 41 | 35 | `egress --format hosts` drops ports | yes | revision 35 |
| 49 | 35 | two items with one identity pass the gate and collapse in the pass diff | yes | revision 34 |
| 51 | 35 | the commit header pattern rejects `!` | yes | revision 35 |
| 53 | 35 | stale caps and descriptions (`max(5)`, `max(8)`, slot `max(5)`, one-line sub-bullets, "contracts/*.json") | yes | revision 35 |
| 19 | 30 | a reaction re-added after a stored retraction is never counted again | yes; needs a run between the removal and the re-add | revision 34 |
| 33 | 30 | `check` accepts `http://` and probes `https://` | yes | revision 35 |
| 62 | 25 | duplicated cost-record, usage and host helpers | yes | deferred (below) |

**Decisions**: three revisions in the reviewer's order, each its own plan delta, tasks phase, gate and commit.
Revision 33 closes the gate and the trust boundaries (everything the model writes is checked, nothing it wrote
reaches the network or the store unchecked): the evidence values, the headline and the notice, the notice built
from window objects, prose dates, the resolver's order, Slack ids before the model, the memory update masked, the
guard on redirects and in every command, the failure counter. Revision 34 makes the brief say what happened
(the timeout bound, the heartbeat wording, the horizons' size and date, unclassified notes, the accepted pass,
tool-result URLs, outcomes once, standing from the computed change, the live query tool, the alerts reply
fitting, the report's nesting, pattern cards in the tools server, the cost of a killed session and of the
feedback stage, discovery per host, the worker pool, the run date, an unopened session, the degraded wording,
the partial publication, calibration per date, duplicate identities, the resolver in a stage-only roll-up, the
re-added reaction). Revision 35 is the pre-PR hygiene (the arm64 build, versions in the image, the CLI engine's
directory, AGENTS.md, ports in the hosts format, stale caps and comments, dead code, replay retention, flag
validation before the run directory, the trace flush, the log flags, the `check` scheme, `!` in the header
pattern). The commit-message repair (#48) rewrites local history that was never pushed; it is the operator's
decision and is proposed, not done. Every fix is verified by a test written first (constitution II); the
security checklist is the reviewer's and gains items, never ticks.

**Rejected or deferred**: #62, the shared cost-record, usage and host helpers, is a refactor with no behaviour
change across nine modules; it is deferred to its own change after this branch lands, so the review's fixes
stay readable one by one. The reviewer's suggestion for #15 to charge a killed session its whole grant is taken
only for the run budget's accounting, with the cost marked as estimated, so the footer never presents an
estimate as a measurement (revision 34). For #55, the dates the model writes are checked against the run's
windows, but a month named without a day ("since August") is not a date token and stays unchecked; the number
check already ignores date-shaped tokens by design, so no numeral is counted twice.

## R-39. Decisions taken while making the brief say what happened (revision 34)

**Evidence**: the findings answered are R-38's second group. Four rules needed a choice the review did not make.
A note's date: the Slack `ts` is the note's own day, but the recorded fixtures carry timestamps a year behind the
dates of the runs they belong to, and a reply can never be older than the post it answers, so the date a horizon is
read against is the `ts` day held between the source run's date and the day it was read. A failed review: a note
whose classification call failed is worth retrying, but not forever at one call per run, so the record counts the
attempts and the third failure acknowledges it unclassified, in words. A killed session: the runtime reports a cost
only on its `result` message, so a harness turn cap or a timeout leaves no figure at all; charging nothing let the
run budget re-grant money that may have been spent (#15), and charging the whole grant is the only bound the code
has, so it charges the rest of the grant and marks every record it touches `cost_estimated`, an upper bound the
footer still prints as the cost. A loose metric key: `get_windows` resolves a request in tiers (the key itself, the
key without its instance matcher, the base metric name) against the collected keys only, a tie within a tier being
ambiguous and said so, because the bare names the query tool accepts are not collected keys.

**Decisions**: the alerts reply is fitted by dropping whole programme lines from the end with a count of the rest,
then the notices, then the link to every alert, and truncated only when even the summary line and one programme
do not fit, so a link is never cut; the publication record is written twice, partial at the parent post and whole
at the end, and a stage-only publish that finds a parent already recorded exits 75 rather than posting a second
brief; calibration takes the last run of each date, as item persistence has since revision 22; discovery's per-host
queries fail their project alone unless the client has already declared the source unreachable; the worker pool
starts nothing after a failure and lets the running items settle. Verified by the tests of Phase 38 and the full
gate; the next revision (35) is R-38's hygiene group.

**Rejected or deferred**: a footer that prints "≤" for an estimated cost (the record carries the flag; the wording
of the footer is a template change with its own replay diff, left for the operator to ask for); re-parsing every
stored note against its own date (the horizon a note stated was fixed when first read, revision 29, and moving it
would change what a reader was told); a per-date dedupe of outcomes across files (the fresh-record rule removes the
daily re-append without reading the whole corpus).

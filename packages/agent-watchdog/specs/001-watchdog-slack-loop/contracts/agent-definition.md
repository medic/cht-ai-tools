# Contract: One Agent Definition, Two Engines

The same agent definition runs under the Claude Agent SDK in production and under the `claude`
command line on a contributor's machine, and produces the same artefacts (FR-050, constitution V).
This contract names the files that make up the definition, how each engine consumes them, and the
per-project session loop both engines follow. Facts about the runtime were verified against the
installed SDK 0.3.278 type definitions and the `claude` 2.1.278 help text on 2026-09-19; see
[research.md](../research.md) for citations.

## The definition

| File | Content | SDK (`engine=sdk`) | CLI (`engine=cli`) |
|---|---|---|---|
| `prompts/system.md`, `skill/cht-watchdog/SKILL.md`, `skill/cht-watchdog/pattern-cards/index.md` | Static prefix, concatenated in this order by the harness into `runs/<id>/agent/system-prompt.<project_slug>.md` (one file per project session, so concurrent sessions do not overwrite each other; `system-prompt.md` for a session without a project), followed by the runtime's dynamic-boundary marker line, then the per-run dynamic suffix (date, memory, active expected-load windows). | `systemPrompt: [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]` | `--system-prompt-file runs/<id>/agent/system-prompt.<project_slug>.md` (the marker line splits the same way) |
| `agent/mcp.template.json` | MCP servers with `${ENV}` placeholders. The CLI engine renders it with secrets resolved into a private temporary file (mode 0600, deleted when the session closes) and writes a redacted copy (`Bearer [redacted]`) to `runs/<id>/agent/mcp.<project_slug>.json`, so the run record never carries the documentation-service token (constitution IV). | `mcpServers` object; the local tool server is attached in-process through `createSdkMcpServer` | `--mcp-config <private rendered file> --strict-mcp-config`; the local tool server runs as a stdio child (`agent-watchdog tools-server --run-dir … --data-dir … --project <slug>`), and under replay every local server is answered from `recorded-tool-calls.jsonl` (`--replay`, `--server cht-docs` for the documentation tools) |
| `agent/tools.json` | The enumerated allow-list of tool names and the empty built-in set. | `tools: []`, `allowedTools: [...]` | `--tools "" --allowed-tools <names>` |
| `schema/findings.schema.json`, `schema/brief.schema.json` | Structured-output schemas ([findings](./findings.schema.json), [brief](./brief.schema.json)), generated from `src/agent/output-schema.js` by `scripts/build-schema.js`. An item carries no `dashboard_ref`: the dashboard, panel and window are recorded by collection and built by code (FR-009, revision 18). | `outputFormat: { type: 'json_schema', schema }` | `--json-schema "$(cat schema/findings.schema.json)"` |
| `agent/hooks.js` | In-process hook callbacks: `PreToolUse` guard, `PostToolUse` recorder, `Stop` gate. | `hooks: { PreToolUse: [...], PostToolUse: [...], Stop: [...] }` | Not loaded: `--bare` skips hook surfaces (verified). The harness performs the same three functions from the `stream-json` event stream and the result event; see Parity below. |
| `prompts/pass-first.md`, `prompts/pass-review.md` | User-turn templates. Pass 1 is filled with the project's candidates, computed changes, feedback and firing alerts; a review pass is filled with the previous pass's items and the candidates it did not select only, since the shared session's first turn already carries the rest (FR-057, revision 22). | Yielded as `SDKUserMessage` turns on one streaming-input query | Written to the process's stdin as `stream-json` user messages |

Everything above is versioned with the code; hashes of the prompts, skill and schemas are stamped
into `run.json` (`versions`). No file under `agent/` or `prompts/` is ever written by the agent.

## Isolation and bounds (both engines)

| Concern | SDK option | CLI flag | Value |
|---|---|---|---|
| No filesystem settings, no CLAUDE.md | `settingSources: []` (omitting it loads all sources) | key mode: `--bare` (skips CLAUDE.md auto-discovery, hooks, plugin sync, keychain); login mode: `--setting-sources ""` (no settings files, rules or CLAUDE.md; managed settings still apply) | fixed in code |
| No built-in tools | `tools: []` | `--tools ""` | fixed in code |
| Only enumerated MCP tools | `allowedTools`, plus per-server `tools: [{ name, permission_policy }]` policies in the MCP config | `--allowed-tools`, same policies in `mcp.json` | fixed in code |
| No permission prompts, deny by default | `permissionMode: 'dontAsk'` | `--permission-mode dontAsk` | fixed in code |
| Cost cap per project session | `maxBudgetUsd` | `--max-budget-usd` | `AGENT_WATCHDOG_MAX_BUDGET_USD_PROJECT`, hard cap in code |
| Turn cap per pass | `maxTurns` | not available in CLI 2.1.278 (no `--max-turns`); the harness counts assistant turns in the event stream and interrupts | `AGENT_WATCHDOG_MAX_TURNS`, hard cap in code |
| Wall clock per analysis call | `abortController` + timer | process kill after timer | `AGENT_WATCHDOG_MODEL_TIMEOUT_MS` |
| Model, effort | `model`, `effort` | `--model`, `--effort` | `AGENT_WATCHDOG_MODEL`, `AGENT_WATCHDOG_EFFORT` |
| No session files on disk | `persistSession: false` | `--no-session-persistence` (print mode only) | fixed in code |
| Subprocess environment | `env: { ...process.env, CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }` (the option replaces the environment, so it is spread explicitly) | same variables exported plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; `CLAUDE_CONFIG_DIR` is redirected in key mode only | image `ENV` |
| Authentication | `ANTHROPIC_API_KEY` in the subprocess environment | key mode: the configured key in the environment, and `--bare` reads only that; login mode (no key configured): the operator's `claude` login under `CLAUDE_CONFIG_DIR` or `~/.claude`, the blank key removed from the environment, no `--bare` (bare mode never reads a login) | secret |
| Structured output retries | runtime-internal; result `subtype: 'error_max_structured_output_retries'` is treated as a gate failure | same via the result event | |

## MCP servers

`cht-docs` (remote, HTTP): `{ "type": "http", "url": "${AGENT_WATCHDOG_DOCS_MCP_URL}",
"headers": { "Authorization": "Bearer ${AGENT_WATCHDOG_DOCS_MCP_TOKEN}" }, "tools": [
{ "name": "search_docs", "permission_policy": "always_allow" },
{ "name": "get_sources", "permission_policy": "always_allow" },
{ "name": "ask_question", "permission_policy": "always_deny" } ] }`. The header is omitted when
the token is unset. `ask_question` is denied so provenance stays first-hand: `search_docs` results
carry `Source: <url>` lines the gate can check (verified result shape in research.md).

`watchdog` (local, read-only, enumerated), the same module served two ways:

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `mcp__watchdog__get_windows` | `{ metric }` | The project's collected Metric Windows and Computed Change for that metric | From `inputs/windows.json.gz` and `changes.json`; no network. |
| `mcp__watchdog__query_metric` | `{ metric, window }` | A Metric Window for a metric not in the collected set | Templated PromQL `metric{instance="<project>"}` only; metric must exist in the discovered metric names; window is one of the five named windows; capped at 20 calls per session. |
| `mcp__watchdog__read_pattern_card` | `{ card_id }` | Full text of a merged pattern card | Ids from the index only (FR-038). |
| `mcp__watchdog__get_item_history` | `{ metric, pattern_card }` | Past accepted items and Feedback for that identity within retention: one entry per analysed date, from the last run of that date, over the thirty most recent analysed dates strictly before the current run's date; earlier runs of the run's own date are not history (revision 22) | Author ids are replaced by role labels before return. |

Under `replay`, the same server answers from `tool-calls.jsonl` keyed by tool name and argument
hash, and returns `{ "unavailable": true, "reason": "not recorded" }` for anything new, so replay
never contacts Grafana. `cht-docs` is likewise replaced by recorded results in replay.

Tool names in `allowedTools` use the `mcp__<server>__<tool>` form (verified).

## The per-project session loop (identical in both engines)

```text
open session (system prompt, tools, schema, bounds)
turn 1: pass-first prompt (candidates, changes, feedback for this project)
  → result: structured findings, usage, cost
  → gate (src/verify): schema, metrics_known, candidates_known, numbers_match,
    severity_rules, pattern_cards_known, links_allowlisted (reference_urls), secrets_absent
  → rejected? send a revision turn with the reasons (at most VERIFY_MAX_RETRIES per pass)
turn 2..N: pass-review prompt (previous items + unselected candidates only; candidates, changes and alerts stay in turn 1) while N ≤ PASSES,
  same gate; stop early when the diff is empty (converged) or a bound is hit
record: findings.pass<n>.json, verification.pass<n>.json, passes.json, session.json
```

- SDK: one `query({ prompt: asyncGenerator, options })`; the generator yields the next
  `SDKUserMessage` after each `result` message is consumed, so every turn shares the session and
  earlier tool results stay in context (FR-057). The `Stop` hook also runs the gate and returns
  `{ decision: 'block', reason }` when it fails, which is a second line of defence; the harness
  decision is authoritative because it also sees `structured_output` on the result message.
- CLI: one `claude -p --verbose --input-format stream-json --output-format stream-json` process per
  project, with `--bare` in key mode and `--setting-sources ""` in login mode (print mode refuses
  stream-json output without `--verbose`, verified against 2.1.278); the harness writes user messages
  to stdin after each `result` event, so the session is likewise shared without persisting anything to
  disk.
- Both: `tool_use` and `tool_result` events are appended to `tool-calls.jsonl` (SDK: `PostToolUse`
  hook plus the message stream; CLI: the `stream-json` events). `PreToolUse` (SDK) denies any tool
  not on the list even if the runtime would allow it; the CLI relies on `--tools ""` and
  `--allowed-tools`.

## Parity gaps to record in every run

| Gap | Effect | Mitigation |
|---|---|---|
| CLI has no `--max-turns` | Turn cap is harness-enforced on the CLI | The harness closes stdin and terminates the process when the count is exceeded; recorded as `bounds_hit: ['turns']`. |
| CLI hooks never fire (`--bare` in key mode, no settings loaded in login mode) | No in-process guard on the CLI | Same checks run in the harness; the allow-list is enforced by `--tools ""` and `--allowed-tools`. |
| Structured output per turn in `stream-json` mode | Must hold for the multi-turn loop on both engines | Smoke test `smoke/agent-parity.js` runs one recorded project through both engines and diffs the artefacts; a difference fails the build. |

## What the model never receives

Secrets, Slack user ids, raw corpus material, other projects' data during a project session, and
any tool that writes or executes. The whole allow-list is code; no configuration adds a tool
(constitution IV, FR-046, FR-054).

## The roll-up session (revision 23)

The brief is drafted in one session opened with `openSession({ tools: [] })` on the same engine as the
project sessions. Turn 1 carries the ranked items, the layout and the day's context (the data sections of
`prompts/rollup.md`); a turn after a rejection carries only the failing bullets with their reasons and
asks for the full draft with every other bullet copied verbatim, and code assembles the draft it verifies
from the accepted bullets of the previous attempt and the rewrites, so the items are sent once, the prefix
is cached and a retry can only mend what was wrong (FR-017). The turns are written to `rollup/prompt.md`
with `# Revision n` headers, as `prompt.pass<n>.md` is for a project. `singleTurn` remains for the memory
condenser and the note parser.

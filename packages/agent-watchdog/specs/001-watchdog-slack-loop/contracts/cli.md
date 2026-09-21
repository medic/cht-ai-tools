# Contract: Command-Line Interface

Entry point: `bin/agent-watchdog.js`, invoked as `agent-watchdog <command> [flags]`. Flags are
parsed with `node:util` `parseArgs` (strict; unknown flags exit 64). Precedence is flag, then
environment variable, then configuration-file default (FR-055).

## Streams

- **stderr**: structured JSON logs, one object per line, every line carrying `service:
  "agent-watchdog"`, `run_id`, `stage`, `event`, `ts` (ISO) and `mono_ns` (monotonic).
  `AGENT_WATCHDOG_LOG_FORMAT=pretty` renders the same events for a terminal.
- **stdout**: the command's result only, so it can be piped: the preview payload JSON, the replay
  comparison JSON, the readiness report, or nothing.
- Secrets never appear on either stream (FR-045); the redaction list is the set of secret keys
  in the configuration schema.

## Commands

### `run`

The daily pipeline: `purge`, `feedback`, `collect`, `analyze`, `agent`, `rollup`, `render`,
`publish`, in that order.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--date` | `YYYY-MM-DD` | today, UTC | Date to analyse; also the run directory name. |
| `--project` | URL, repeatable | all discovered | Restrict analysis to these projects; discovery still runs, and so do collection, the classified alert record and the durable episodes, so a filtered run leaves the next full run's newness and episodes intact. The brief covers only the projects analysed: alerts, patterns and notices for the rest are left out (FR-066, revision 19). |
| `--stage` | stage name | none | Run only this stage from the previous stage's files (FR-043). Exit 65 when inputs are missing. |
| `--engine` | `sdk` \| `cli` | `AGENT_WATCHDOG_ENGINE` | Which face of the same agent definition runs the passes (FR-050). `cli` runs `claude -p --verbose … --input-format stream-json --output-format stream-json` (print mode requires `--verbose` for stream-json output), with `--bare` when `ANTHROPIC_API_KEY` is set and, without a key, on the operator's `claude` login with `--setting-sources ""` instead; it serves the local tools through `tools-server`. |
| `--dry-run` | flag | `AGENT_WATCHDOG_DRY_RUN` | Preview mode: every artefact, `payload.json`, nothing posted (FR-025). |
| `--force` | flag | off | Allow a second run for the same date; the new run supersedes and links the earlier post (FR-042). |
| `--since` | `YYYY-MM-DD` | derived from `AGENT_WATCHDOG_FEEDBACK_LOOKBACK_RUNS` | Read feedback from posts on or after this date instead of the last N runs (FR-026). |

Exit codes: see [exit-codes.md](./exit-codes.md). Stdout: in preview mode, the exact payload
object; otherwise empty.

### `replay`

Regenerate findings for a stored run from its retained inputs, without contacting the metrics
source or Slack (FR-041, US3 scenario 3).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--date` | `YYYY-MM-DD` or `run_id` | required | Stored run to replay. |
| `--project` | URL, repeatable | all in the run | Restrict replay. |
| `--prompts` | directory | package `prompts/` | Alternative prompt set under test. |
| `--skill` | directory | package `skill/cht-watchdog/` | Alternative skill under test. |
| `--label` | string | timestamp | Output under `runs-replay/<run_id>/<label>/`. |
| `--compare` | flag | on | Print a JSON comparison of items before and after to stdout. |
| `--from`, `--to` | `YYYY-MM-DD` | none | Replay every stored run in the inclusive range with bounded concurrency; one comparison per run plus a summary (SC-006). Mutually exclusive with `--date`. |

Recorded tool results are served to the model from `tool-calls.jsonl`; a query with no recording
returns an explicit `unavailable` result and is counted in the comparison.

### `distill`

Process new or changed corpus items into proposed pattern cards (FR-035, FR-036).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--all` | flag | off | Re-process every item regardless of index status. |
| `--item` | relative path, repeatable | none | Process only these items. |

Stdout: a JSON distillation report listing processed, skipped (with reason) and produced cards.

### `calibrate`

Build the weekly Calibration Report and write threshold proposals (US4 scenario 4, FR-058).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--week` | `YYYY-Www` | current ISO week | Week to report on. |
| `--project` | URL, repeatable | all | Restrict. |

### `check <cht-url>`

Readiness check for a CHT deployment (FR-048). Reports each unmet prerequisite in plain language
on stdout and exits 1 when any is unmet, 0 when all are met, 69 when the URL is unreachable.
Prerequisites: reachable monitoring endpoint, CHT version at or above the minimum the watchdog
supports, host-metrics exporter present when the project has opted in.

### `tools-server`

Serves the enumerated read-only tools over stdio to the `claude` command-line engine; launched by the
engine itself from the MCP configuration it writes, not by operators.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--run-dir` | path | required | The run directory whose `discovery.json`, changes and windows the tools read. |
| `--data-dir` | path | `AGENT_WATCHDOG_DATA_DIR` | The data volume, for item history. |
| `--project` | slug | required | The project session the tools serve. |
| `--server` | `watchdog` \| `cht-docs` | `watchdog` | Which server to serve; `cht-docs` only exists under `--replay`. |
| `--replay` | flag | off | Answer from `<run-dir>/<slug>/recorded-tool-calls.jsonl`; anything unrecorded is `unavailable`. |

Logs go to stderr; stdout belongs to the MCP transport. Exits 0 when the client closes the transport,
64 on a bad flag, 65 when the run or project directory is missing.

### `purge`

Apply retention (FR-040). `--dry-run` lists what would be removed. Also runs implicitly at the
start of `run`.

### Global flags

`--help`, `--version`, `--config-dir <path>` (overrides `AGENT_WATCHDOG_CONFIG_DIR`),
`--data-dir <path>` (overrides `AGENT_WATCHDOG_DATA_DIR`), `--log-level`, `--log-format`.

## Examples

```sh
# Full daily run in preview from a laptop, printing the would-be post
agent-watchdog run --dry-run --date 2026-09-18 > payload.json

# One stage at a time
agent-watchdog run --date 2026-09-18 --stage collect
agent-watchdog run --date 2026-09-18 --stage analyze
agent-watchdog run --date 2026-09-18 --stage agent --project https://cht.example.org

# Replay yesterday against an experimental prompt set
agent-watchdog replay --date 2026-09-18 --prompts ./prompts-experiment --label tighter-severity

# Readiness
agent-watchdog check https://cht.example.org
```

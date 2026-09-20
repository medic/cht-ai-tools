# Contract: Run Directory Layout

Every stage reads the files of the previous stage and writes its own, so any stage can be re-run
alone (FR-043) and any run can be replayed offline (FR-041). Paths are relative to
`AGENT_WATCHDOG_DATA_DIR`. Retention classes: **raw** is purged after
`AGENT_WATCHDOG_RETENTION_RAW_DAYS` (default 14); **kept** after `AGENT_WATCHDOG_RETENTION_DAYS`
(default 30); **durable** is never purged by this system (FR-040).

```text
<DATA_DIR>/
├── runs/
│   └── <run_id>/                          # YYYY-MM-DD or YYYY-MM-DD-f<n>
│       ├── run.json                       # Run record: status, stages, versions, usage, cost   [kept]
│       ├── config.effective.json          # redacted effective configuration (FR-055)          [kept]
│       ├── feedback.ingested.json         # feedback read at start, matched and unmatched      [kept]
│       ├── discovery.json                 # projects, dashboards, panels, targets, versions    [kept]
│       ├── <project_slug>/
│       │   ├── inputs/windows.json.gz     # Metric Windows, raw series                         [raw]
│       │   ├── changes.json               # Computed Changes                                   [kept]
│       │   ├── candidates.json            # Candidates                                         [kept]
│       │   ├── prompt.pass<n>.md          # the exact prompt sent for pass n                   [kept]
│       │   ├── findings.pass<n>.json      # Pass output after schema validation                [kept]
│       │   ├── verification.pass<n>.json  # in-analysis gate report for pass n                 [kept]
│       │   ├── tool-calls.jsonl           # every tool call and result, untrusted, for replay  [kept]
│       │   ├── passes.json                # per-pass diff and convergence (FR-058)             [kept]
│       │   └── session.json               # runtime session id, model, usage per call          [kept]
│       ├── rollup/
│       │   ├── items.ranked.json          # merged items with rank and placement               [kept]
│       │   ├── brief.draft<n>.json        # drafts submitted to the publish gate               [kept]
│       │   ├── verification.draft<n>.json # publish gate reports                               [kept]
│       │   ├── brief.json                 # final Brief (brief, heartbeat, degraded, failure)  [kept]
│       │   ├── report.html                # one-page report (FR-022)                           [kept]
│       │   ├── brief.png                  # image rendered from report.html (FR-023)           [raw]
│       │   ├── payload.json               # exact Slack payload; preview output (FR-025)       [kept]
│       │   └── publication.json           # channel, ts, permalinks, file id                   [kept]
│       ├── memory.patch                   # memory change made by this run, if any             [kept]
│       ├── proposals/                     # proposals written by this run (copies)             [kept]
│       └── trace.json                     # trace id, url, span summary                        [kept]
├── memory/
│   ├── memory.md                          # current curated memory                             [durable]
│   └── history/<run_id>.patch             # one diff per change (FR-031)                       [durable]
├── feedback.jsonl                         # append-only Feedback records (FR-028)              [kept]*
├── proposals/<date>-<type>-<slug>.md      # canonical proposal files (FR-032)                  [durable]
├── corpus/
│   ├── index.json                         # Corpus Item records, no content (FR-037)           [durable]
│   ├── outcomes/<date>.jsonl              # run outcomes appended for distillation (FR-030)    [durable]
│   └── cards.proposed/<card_id>.md        # proposed pattern cards awaiting review (FR-036)    [durable]
├── calibration/<YYYY-Www>.json            # Calibration Reports                                [kept]
└── knowledge-corpus/raw/                  # AGENT_WATCHDOG_CORPUS_RAW_DIR; maintainer-managed  [durable]
```

`*` `feedback.jsonl` is compacted, not truncated: records older than the kept period are dropped
only after their items' outcomes have been appended under `corpus/outcomes/`, which is what SC-002
is measured from.

## Stage inputs and outputs

| Stage | Reads | Writes |
|---|---|---|
| `purge` | retention settings, directory timestamps | deletions only, logged per file |
| `feedback` | `publication.json` of the previous N runs, Slack | `feedback.ingested.json`, `feedback.jsonl` |
| `collect` | configuration, Grafana | `discovery.json`, `<project>/inputs/windows.json.gz` |
| `analyze` | `discovery.json`, `inputs/windows.json.gz`, `thresholds.yaml`, `projects.yaml` | `changes.json`, `candidates.json` |
| `agent` | `candidates.json`, `changes.json`, memory, pattern-card index, feedback | `prompt.pass<n>.md`, `findings.pass<n>.json`, `verification.pass<n>.json`, `tool-calls.jsonl`, `passes.json`, `session.json` |
| `rollup` | all `findings.pass<last>.json`, feedback, memory | `items.ranked.json`, `brief.draft<n>.json`, `verification.draft<n>.json`, `brief.json`, `memory.patch`, `proposals/` |
| `render` | `brief.json`, `changes.json` | `report.html`, `brief.png` |
| `publish` | `brief.json`, `brief.png`, `items.ranked.json` | `payload.json`, `publication.json`, `run.json` (final) |

Rules:

- A stage refuses to start when a required input is missing or fails schema validation, and exits
  with code 65 (see exit codes). It never fabricates inputs.
- Every write is atomic: write to `<name>.tmp` in the same directory, then rename.
- `run.json` is updated at every stage boundary with a monotonic timestamp.
- Replay (`replay --date`) reads a run directory, writes to `runs-replay/<run_id>/<label>/` with
  the same layout, and serves recorded `tool-calls.jsonl` results to the model in place of the
  live documentation service, so nothing external is contacted except the model API.
- Preview mode (`--dry-run`) writes the full layout and stops before `publish` writes
  `publication.json`; `payload.json` is the deliverable (FR-025).

## Replay directories

`runs-replay/<run_id>/<label>/` mirrors the run layout for the files replay reads and writes: the copied
`discovery.json`, `feedback.ingested.json` and per-project `changes.json`, `candidates.json`, `suppressed.json`
and `inputs/windows.json.gz` (when the raw file has not yet been purged), then everything the agent stage
writes (`prompt.pass<n>.md`, `findings.pass<n>.json`, `verification.pass<n>.json`, `passes.json`,
`session.json`, `agent.summary.json`). Two files are specific to replay:

- `<project_slug>/recorded-tool-calls.jsonl` — the source run's `tool-calls.jsonl`, copied before the session;
  every local tool and the documentation service answer from it, and a call it does not cover returns
  `{ "unavailable": true, "reason": "not recorded" }`. The replay's own `tool-calls.jsonl` records the new
  session's calls beside it.
- `comparison.json` — the items before (the source run's highest-numbered pass, the file the roll-up used)
  and after (the replay's), per project: `added`, `removed`, `changed` (identity, severity or evidence within
  display rounding) and `unavailable_tool_calls`, with totals, the prompts and skill hashes under test, cost,
  usage and duration. The same object is printed on stdout; a `--from/--to` range prints one per run plus a
  summary.

`run.json` in a replay directory has `mode: replay`, `replay_of`, `label`, the `versions` of the code and of
the prompts and skill under test, `source_versions` copied from the source run, and `prompts_dir`/`skill_dir`.
Replay directories are `kept` for retention purposes (FR-040) and are never written by a scheduled run.

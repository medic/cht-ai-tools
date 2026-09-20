# Data Model: Watchdog Slack Loop

**Feature**: `001-watchdog-slack-loop` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

Every entity below is persisted as a plain JSON, JSONL or Markdown file under the layout in
[contracts/run-directory.md](./contracts/run-directory.md). Identity rules, validation rules and
state transitions are stated here once; zod schemas under `src/**/schema.js` and the verification
gate under `src/verify/` implement them and are tested against fixtures. `FR-nnn` references point
at the spec.

## Conventions

- Timestamps are ISO-8601 UTC strings (`2026-09-19T06:00:00Z`). Dates are `YYYY-MM-DD` in UTC.
- Identifiers are lowercase and URL-safe. Hashes are hex SHA-256 truncated to 12 characters
  unless stated otherwise.
- `cost_usd` is a number with at most six decimals. Token counts are integers.
- Enumerations are closed sets; an unknown value fails validation (FR-011).
- Anything the model wrote is untrusted until the gate accepts it (FR-016, FR-044).
- Anything fetched from outside (tool results, Slack text, corpus items) is data, never
  instructions (FR-044); it is stored verbatim for replay and escaped on render.

## Entities

### Project

A monitored CHT deployment, discovered from the metrics store on every run (FR-001).

| Field | Type | Rules |
|---|---|---|
| `host` | string | Identity. The `instance` label value as recorded in the metrics store: a bare, lowercased hostname (research.md R-6). |
| `url` | string | Derived: `https://<host>`; this is the `project_url` used everywhere else in this model. |
| `slug` | string | Derived: `host` with `.` replaced by `-`; used for directory names only. |
| `configured` | boolean | True when `projects.yaml` has an entry for `url` (US5 scenario 1). |
| `owner` | string or null | From `projects.yaml`. |
| `notes` | string or null | From `projects.yaml`. Rendered through escaping templates. |
| `thresholds` | object or null | Per-project overrides, same shape as `thresholds.yaml` (FR-014). |
| `expected_load_windows` | ExpectedLoadWindow[] | Per-project windows merged with global defaults (FR-007). |
| `cht_version` | string or null | Collected each run (FR-005). |
| `history_days` | integer | Days of metric history available. Below 14, history comparisons are `available: false` (US5 scenario 3). |
| `scrape_targets` | ScrapeTarget[] | `{ job, scrape_url, health: 'up' \| 'down' \| 'unknown', last_error }` (FR-005). |
| `group` | string | Label of the first Project Group whose pattern matches `host`, else `Other` (FR-068). |

A host matching a pattern under `projects.yaml` `ignore` never becomes a Project: `discovery.json` lists
it under `ignored` as `{ host, pattern }` and it is neither queried, analysed, charged nor named in a post
(FR-068). `discovery.json` also lists `groups` as `{ label, hosts }` in file order with `Other` last.

### Project Group

A programme the hosted watchdog serves, declared in `projects.yaml` (FR-068). Two labels are
reserved and always present: `Other` for hosts no pattern matches and `Watchdog` for alerts that
carry no `instance` label.

| Field | Type | Rules |
|---|---|---|
| `label` | string | Identity; unique, at most 40 characters, shown in the post exactly as written. |
| `host_patterns` | string[] | Lowercase globs matched against the bare host: `*` matches any run of characters, `?` one character; converted to anchored regular expressions in code, no glob library. The first group whose pattern matches wins, in file order. Empty for the reserved labels. |
| `hosts` | string[] | Hosts assigned this run, ignored hosts excluded. |

### Run

One execution for one date (FR-039, FR-042).

| Field | Type | Rules |
|---|---|---|
| `run_id` | string | `YYYY-MM-DD` for the first run of a date; `YYYY-MM-DD-f<n>` for the n-th forced run. |
| `date` | string | UTC date the run analyses. |
| `mode` | enum | `scheduled` \| `manual` \| `preview` \| `replay` \| `stage`. |
| `status` | enum | See state machine below. |
| `started_at`, `finished_at` | timestamp | Monotonic `duration_ms` recorded alongside. |
| `versions` | object | `{ package, git_sha, prompts_hash, skill_hash, schema_hash, config_hash }` (US3 scenario 4). |
| `config_effective_path` | string | Redacted effective configuration file (FR-055). |
| `stages` | Stage[] | `{ name, status, started_at, finished_at, duration_ms, error }` per stage. |
| `projects` | string[] | URLs analysed, in priority order. |
| `usage` | Usage | Summed token usage across model calls. |
| `cost_usd` | number | Sum of Cost Records; reconciled with the runtime's estimate (FR-049). |
| `publications` | Publication[] | Parent post, thread replies, image file (see Brief, Thread Reply). |
| `trace_id`, `trace_url` | string | One trace per run (FR-049). |
| `supersedes`, `superseded_by` | string or null | Linked forced runs (Edge Cases). |
| `bounds_hit` | string[] | Which bounds ended work early, if any (FR-012). |

**State machine** (terminal states in bold; exit codes in
[contracts/exit-codes.md](./contracts/exit-codes.md)):

| From | Event | To |
|---|---|---|
| (start) | run directory for `date` exists and no `--force` | **refused** |
| (start) | configuration valid, directory created | `created` |
| `created` | feedback ingested, metrics and target health collected | `collected` |
| `created` | metrics source unreachable or timed out | **failed** (notice posted) |
| `collected` | deltas and candidates computed for every project | `analysed` |
| `analysed` | model passes complete or every model-dependent stage degraded | `drafted` |
| `drafted` | publish gate accepts the brief | `verified` |
| `drafted` | gate rejects three drafts, or model output unusable | `degraded` (deterministic brief built) |
| `verified` or `degraded` | report and image rendered | `rendered` |
| `rendered` | `mode = preview` | **previewed** (payload emitted, nothing posted) |
| `rendered` | posted, with items | **published** |
| `rendered` | posted, no items | **heartbeat** |
| `rendered` | Slack unavailable after retries | **unposted** |
| any non-terminal | unexpected error | **failed** (notice posted if Slack reachable) |

`degraded` is not a failure: the run publishes the deterministic brief with an explicit notice
(Edge Cases, FR-017) and exits 0 with `status: degraded` in `run.json`.

### Metric Window

A metric's values over one named period for one project (FR-004).

| Field | Type | Rules |
|---|---|---|
| `project_url` | string | Project identity. |
| `metric` | string | Metric key: the PromQL expression identifier from the dashboard panel target, or the bare metric name for target health. |
| `panel_ref` | PanelRef | `{ dashboard_uid, panel_id, panel_title, ref_id }` — where the expression came from (FR-003). |
| `window` | enum | `current` \| `previous_day` \| `previous_week` \| `previous_cycle` \| `trailing_14d`. |
| `start`, `end` | timestamp | Inclusive bounds. `current` is the 24 hours ending at run start. |
| `step_s` | integer | Query step in seconds. |
| `unit` | string | From the panel's field config, else `count`. |
| `values` | [number, number][] | `[epoch_seconds, value]` pairs; empty when unavailable. |
| `available` | boolean | False when history is shorter than the window needs or the query failed. |
| `unavailable_reason` | string or null | Required when `available` is false. |

Raw windows are the only artefact under the short retention period (FR-040).

### Computed Change

The deterministic comparison of a metric across windows (FR-006, FR-007). One per project and
metric per run; kept for the long retention period because the model saw it.

| Field | Type | Rules |
|---|---|---|
| `project_url`, `metric`, `panel_ref` | | As above. |
| `current_value` | number or null | Last value of `current`, or the aggregate the panel uses. |
| `previous_day_value`, `previous_week_value`, `previous_cycle_value` | number or null | Null when the window is unavailable. |
| `pct_change_vs_previous_day` | number or null | `(current - previous_day) / abs(previous_day) * 100`; null when `previous_day` is 0 or unavailable. |
| `trailing_mean`, `trailing_stddev` | number or null | Over `trailing_14d` daily values; null below 14 days of history. |
| `deviation_sigma` | number or null | `(current - trailing_mean) / trailing_stddev`; null when stddev is 0 or unavailable. |
| `monotonic_rise_hours` | number | Longest run of non-decreasing consecutive samples ending at the last sample, in hours; 0 when none. |
| `baseline` | enum | `previous_day` \| `previous_cycle` — `previous_cycle` when an expected-load window is active (FR-007). |
| `expected_load_window_id` | string or null | Active window, if any. |

### Candidate

A deterministic flag on a Computed Change (Key Entities; FR-006, FR-014).

| Field | Type | Rules |
|---|---|---|
| `candidate_id` | string | Hash of `project_url`, `metric`, `rule`, `date`. |
| `project_url`, `metric`, `panel_ref` | | As above. |
| `rule` | enum | `pct_change` \| `deviation` \| `monotonic` \| `target_down` \| `backlog_absolute`. |
| `threshold` | object | `{ source: 'default' \| 'global' \| 'project', value }` — which threshold fired (FR-014). |
| `observed` | number | The value compared against the threshold. |
| `severity_floor` | enum | `low` \| `medium` \| `high`. `high` only from the FR-014 high rules: `target_down`; outbound push backlog above zero; sentinel backlog above three times its baseline. |
| `evidence` | Evidence[] | See Item. |
| `expected_load_window_id` | string or null | Copied from the Computed Change. |

### Alert Rule

A Grafana-managed alert rule provisioned on the hosted watchdog, read live each run (FR-064).

| Field | Type | Rules |
|---|---|---|
| `rule_uid` | string | Identity; the rule UID as Grafana reports it. |
| `title` | string | The provisioned title (`cht.yml` `title`); the key into `alerts.yaml`. Untrusted text, escaped on render. |
| `folder`, `rule_group` | string | Grafana folder and evaluation group (`10m`, `1m` on the stock watchdog). |
| `pending_for` | string | The rule's `for` duration as provisioned. |
| `dashboard_uid`, `panel_id` | string or null, integer or null | From the rule annotations `__dashboardUid__` and `__panelId__`; used for the dashboard link when present. |
| `category` | string | From `alerts.yaml`; `uncategorised` when the title is unknown (FR-065). |
| `importance` | enum | `critical` \| `high` \| `medium` \| `low`; `medium` when the title is unknown (FR-065). |
| `known` | boolean | False when the title has no `alerts.yaml` entry; the brief says so. |

### Alert Instance

One evaluation of a rule for one label set, as reported at run time (FR-064, FR-065).

| Field | Type | Rules |
|---|---|---|
| `instance_id` | string | Hash of `rule_uid` and the sorted label pairs, `alertname` excluded. |
| `rule_uid`, `title`, `category`, `importance` | | Copied from the Alert Rule. |
| `host` | string or null | The `instance` label, normalised as for Projects (research.md R-6); null when the rule has no such label. |
| `project_url` | string or null | Derived from `host`. |
| `group` | string | The host's Project Group label; `Watchdog` when `host` is null. Instances on ignored hosts are dropped at collection and counted in `alerts.json`. |
| `labels`, `annotations` | object | As collected; untrusted data. |
| `state` | enum | `firing` \| `pending` \| `nodata` \| `error`, normalised by code from Grafana's state names (research.md R-14). Only `firing` instances are counted, grouped and posted; the others are stored for the record. |
| `active_at` | timestamp or null | Grafana's `activeAt` when reported. |
| `started_at` | timestamp | `active_at`, else the run start of the first run that observed the instance firing (Edge Cases: no state history). |
| `days_firing` | integer | Whole days from `started_at` to the run start. |
| `stale` | boolean | `days_firing >= stale_after_days` from `alerts.yaml` (default 14; FR-065). |
| `new` | boolean | True when the previous run's `alerts.classified.json` did not hold this `instance_id` firing. |
| `value` | string or null | The evaluated value as Grafana reports it; untrusted, never rendered into bullet text. |

Instances are grouped for the post by `group` and `category` (FR-066): each Alert Group carries
`{ group, category, importance (highest), firing, new, stale, oldest_started_at, rule_uids,
instance_ids, link_ref }`, where `link_ref` is what the link builder turns into the filtered
alert-list link (FR-070). A group's thread reply lists at most fifty instances and the count of the
rest (Edge Cases).

### Alert Episode

The durable record of one Alert Instance from start to clear (FR-067), kept as append-only events
in `alerts/episodes.jsonl`.

| Field | Type | Rules |
|---|---|---|
| `episode_id` | string | Hash of `instance_id` and the date of `started_at`. |
| `event` | enum | `opened` (first run to see it firing) \| `observed` (each later run while firing) \| `cleared` (first run that no longer sees it firing). |
| `run_id`, `at` | string, timestamp | The run that wrote the event and its start. |
| `instance_id`, `rule_uid`, `title`, `host`, `project_url`, `group`, `category`, `importance` | | Copied from the instance. |
| `started_at`, `cleared_at` | timestamp, timestamp or null | `cleared_at` only on `cleared`. |
| `duration_hours` | number or null | On `cleared`. |
| `correlations` | object | Built by code at `opened` and refreshed on every event: `{ expected_load_window_id, version_change: { from, to, observed } or null, related_candidates: candidate_id[], related_items: item_id[] }`; a version change counts when the project's `cht_version` differs between the runs on either side of `started_at`; candidates and items are related when they are on the same project and their metric is listed under the category in `alerts.yaml`, within one day of `started_at`. |
| `explanation` | object or null | `{ item_id, why_now }` when an accepted Item of the same project and category exists; model prose, gate-accepted, copied by code. |

An episode that clears is also appended to `corpus/outcomes/<date>.jsonl` as
`{ kind: 'alert_episode', ... }` so distillation can learn from it (FR-067, FR-030).

### Item

A finding the analysis chose to surface (FR-009). Written by the model, validated by schema, then
accepted or rejected by the gate.

| Field | Type | Rules |
|---|---|---|
| `item_id` | string | **Stable identity**: hash of `project_url`, `metric` and `pattern_card` (or the literal `none`). Computed by code from the model's `item_key`, never by the model (Key Entities). |
| `project_url` | string | Must be a discovered project (FR-016). |
| `metric` | string | Must be a metric collected this run. |
| `severity` | enum | `low` \| `medium` \| `high`. `high` requires at least one referenced candidate with `severity_floor: high`; otherwise the gate rejects with a reason. |
| `evidence` | Evidence[] | `{ window, value, unit, start, end }`; every `value` must equal a computed value for the metric and window (FR-016). |
| `why_now` | string | Prose; escaped on render. |
| `suggested_check` | string | Prose, or the matched pattern card's confirmation steps (US6 scenario 4). |
| `dashboard_ref` | DashboardRef | `{ dashboard_uid, panel_id, project_url, from, to }`; the link is built by code from it (FR-009, FR-016). |
| `confidence` | number | 0 to 1 inclusive, checked in code. |
| `persisting_days` | integer | Consecutive prior runs whose accepted items contained this `item_id`, plus one. Set by code (Edge Cases). |
| `pattern_card` | string or null | Card id from the merged index; unknown ids are rejected. |
| `candidate_ids` | string[] | Non-empty; every id must exist in this run's candidates. |
| `reference_urls` | string[] | URLs the model cites; each must have appeared in a tool result this run and be on the allow-list (FR-016). |
| `rank` | integer | Assigned by the roll-up; 1 is highest. |
| `placement` | enum | `body` \| `thread` (FR-010). Body items occupy a top-level bullet alone or appear as a sub-bullet of their Project Group's bullet (FR-069). |
| `slot` | integer or null | 1 to 5: the top-level bullet the item appears in; null in the thread. Assigned by the layout rule under Bullet. |
| `pass_history` | PassChange[] | `{ pass, change: 'added' \| 'removed' \| 'changed', reason }` (FR-056). |

Lifecycle: `drafted` (pass 1) → `revised` (later passes) → `ranked` → `placed` → `published` →
`tracked` (next runs increment `persisting_days`) → `reviewed` (Feedback) → `outcome`
(`confirmed` \| `dismissed` \| `unreviewed`, appended to the corpus as a run outcome, FR-030).

### Pass

One model pass over one project (FR-056 to FR-058).

| Field | Type | Rules |
|---|---|---|
| `pass` | integer | 1-based; at most the hard cap in code. |
| `session_id` | string | Shared by all passes of the project (FR-057). |
| `items` | Item[] | Output of this pass after schema validation. |
| `not_selected` | `{ candidate_id, reason }[]` | Candidates examined but not surfaced. |
| `changes` | PassChange[] | Empty for pass 1; required for later passes. |
| `converged` | boolean | True when items match the previous pass on identity, severity and evidence within display rounding (FR-057). |
| `gate` | VerificationReport | Result of the in-analysis gate for this pass. |
| `usage`, `cost_usd`, `num_turns`, `duration_ms` | | From the runtime result. |
| `tool_calls_path` | string | JSONL of every tool call and result, for replay (FR-041). |

### Verification Report

The gate's verdict on one draft (FR-016 to FR-018).

| Field | Type | Rules |
|---|---|---|
| `subject` | enum | `pass` \| `brief`. |
| `subject_ref` | string | `<project_slug>/pass<n>` or `rollup/draft<n>`. |
| `attempt` | integer | 1 to 3; the third failure degrades the run (FR-017). |
| `checks` | Check[] | `{ name, status: 'pass' \| 'fail', reasons: string[] }`. |
| `outcome` | enum | `accepted` \| `rejected`. |

Check names, fixed in code: `schema`, `projects_known`, `metrics_known`, `candidates_known`,
`numbers_match`, `dates_match`, `links_built`, `links_allowlisted`, `links_resolve`,
`severity_rules`, `bullet_count`, `bullet_length`, `secrets_absent`, `personal_data_absent`,
`pattern_cards_known`. The same list runs inside the analysis and before publication (FR-018).
`bullet_count` checks top-level bullets (at most five) and sub-bullets per bullet (at most eight);
`bullet_length` checks two lines of 120 characters per bullet and one line per sub-bullet, and that
every body item of the layout has exactly one bullet or sub-bullet (FR-015, FR-069).

### Brief

The published post for a run (FR-019 to FR-025).

| Field | Type | Rules |
|---|---|---|
| `run_id` | string | |
| `kind` | enum | `brief` \| `heartbeat` \| `degraded` \| `failure`. |
| `headline` | string | One line. |
| `bullets` | Bullet[] | At most 5 (FR-010, revised from 3 in spec revision 9). See Bullet; constants in code. |
| `expected_load_notice` | string or null | Present when a window was active (FR-007). |
| `checked` | object | `{ projects, panels, candidates }` counts, shown on heartbeats (FR-021). |
| `degradation_notice` | string or null | Required when `kind` is `degraded`. |
| `notices` | string[] | Added by code, never by the model: projects new since the previous run, marked unconfigured when they have no `projects.yaml` entry (FR-001, SC-008). Empty on most days. |
| `image` | object | `{ path, slack_file_id }`; rendered from the same report as the text (FR-023). |
| `footer` | object | `{ prompts_url, config_url, trace_url, cost_usd }` (FR-019). |
| `publication` | Publication or null | `{ channel_id, ts, permalink }` after posting. |

### Bullet

One top-level line of the post body (FR-010, FR-015, FR-066, FR-069).

| Field | Type | Rules |
|---|---|---|
| `kind` | enum | `item` \| `group` \| `alerts`. |
| `item_id` | string or null | Required when `kind` is `item`; null otherwise. |
| `group` | string or null | Project Group label; required for `group` and `alerts`. |
| `text` | string | At most 2 lines of at most 120 characters, no URLs. Written by the model for `item`; built by code for `group` ("<label>: <n> projects with issues") and `alerts` ("<label> alerts: <n> firing, <m> stale for more than <d> days"). |
| `children` | Child[] | At most 8. `{ item_id or null, text }`, one line of at most 120 characters each. For `group`: one per member item in rank order, text written by the model as that item's one-line bullet. For `alerts`: one per category, built by code with the count, the oldest start and the stale count. Empty for `item`. |
| `alert_key` | string or null | For `alerts`: `<group>/<category>` of the group when the bullet holds one category, else `<group>`; the thread reply and its link are built from the Alert Groups it covers (FR-070). |

**Layout rule** (code, before the roll-up call; the result is `rollup/layout.json` and the prompt
tells the model which items must be one-liners): walk the ranked Items and Alert Groups together,
Alert Groups ordered among Items by importance (critical before every item, otherwise after the
items of the same severity); an entry whose Project Group already holds a slot joins it as a
sub-bullet while the slot has fewer than eight and goes to the thread once it is full; otherwise it
opens a new slot while fewer than five are open; otherwise it goes to the thread. The reserved
`Other` group never collapses: its entries take slots of their own, since a fallback bucket is not
a programme. A slot with one Item is an `item` bullet; with two or more Items a `group` bullet;
Alert Groups of one Project Group share one `alerts` bullet with a sub-bullet per category and
never mix with Items. The model's draft carries one `{ item_id, text }`
per body Item; code assembles the Bullets from the draft and the layout, and the gate rejects a
draft whose item ids differ from the layout's body items.

### Thread Reply

The per-item message that carries reactions (FR-020), and the per-alert-group message (FR-066).

| Field | Type | Rules |
|---|---|---|
| `run_id` | string | |
| `item_id` | string or null | The Item; null for an alert-group reply. |
| `alert_key` | string or null | `<group>/<category>` for an alert-group reply; null for an item. Exactly one of `item_id` and `alert_key` is set. |
| `text` | string | Item rendered for Slack, or the alert group's instances (at most fifty, with the count of the rest) and its code-built link; escaped. |
| `publication` | Publication | `{ channel_id, ts, permalink }`. |

### Feedback Digest

The once-per-run thread reply that acknowledges new feedback (FR-062, US7). Stored as
`rollup/feedback.digest.json` and carried in the payload as `digest`.

| Field | Type | Rules |
|---|---|---|
| `run_id` | string | |
| `acknowledged` | string[] | `feedback_id` values acknowledged by this digest; each appears in exactly one digest ever. |
| `items` | object[] | Per item with new feedback: `{ item_id, host, metric, up, down, notes, effect }` where `effect` is `confidence_up` \| `confidence_down` \| `suppressed` \| `none` and, when suppressed, `until` the horizon date. |
| `brief` | object | `{ up, down, notes }` for reactions on the parent post. |
| `proposals` | object[] | `{ proposal_id, type, path }` written from this feedback. |
| `unclassified` | integer | Notes whose classification call failed; retried next run. |
| `retention` | object | `{ records_path, influence_days }`: where the records live permanently and how long they adjust ranking. |
| `reactions` | object[] | `{ source_ts, name: 'eyes', ok }` per acknowledged note after posting; empty in preview. |
| `publication` | Publication or null | The digest's own message in the brief's or heartbeat's thread. |

The digest names no person: authors are counted, never shown.

### Feedback

A reaction or note from a named person (FR-026 to FR-029). Appended to `feedback.jsonl`.

| Field | Type | Rules |
|---|---|---|
| `feedback_id` | string | Hash of `source_ts`, `author`, `kind`, `verdict`. Duplicate ids are ignored on re-ingestion. |
| `date` | string | Date the feedback was observed. |
| `run_id` | string | Run whose post carried the reaction or note. |
| `target` | enum | `item` \| `brief` \| `alert_group`. A reaction on the parent post targets the brief (US2 scenario 3); one on an alert-group reply targets that group (FR-066). |
| `item_id` | string or null | Required when `target` is `item`. |
| `alert_key` | string or null | Required when `target` is `alert_group`. Recorded and acknowledged like item feedback; it does not change alert ranking in this revision. |
| `kind` | enum | `reaction` \| `note`. |
| `verdict` | enum or null | `up` \| `down` \| `retracted` for reactions; null for notes. A removed reaction is recorded as `retracted` (Edge Cases). |
| `note` | string or null | Thread reply text, verbatim, untrusted. |
| `horizon` | string or null | Date parsed from the note by the feedback-parsing stage, when one is stated (US2 scenario 1). |
| `author` | string | Slack user id. Never rendered into partner-facing output. |
| `matched` | boolean | False when a note names no item; surfaced next run (US2 scenario 4). |
| `source_ts` | string | Slack message timestamp the feedback was read from. |
| `acknowledged_run_id` | string or null | Run whose digest acknowledged this record; set once, by the run that posted it, never in preview (FR-062). |
| `classification` | enum or null | For notes: `expectation` \| `project_annotation` \| `skill` \| `prompt` \| `threshold` \| `pattern_card` \| `none`; null until reviewed, and still null after a failed classification call so the next run retries (FR-061). Reactions are never classified. |
| `proposal_id` | string or null | Proposal written from this note, when its classification produced one (FR-061). |

Records are kept permanently (FR-059); `purge` never removes or compacts `feedback.jsonl`. Only
the ranking tallies apply the influence window (FR-060): a record older than
`AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` counts for nothing, while its horizon, if any, holds until
its date.

### Memory

The agent's curated notes (FR-031).

| Field | Type | Rules |
|---|---|---|
| `path` | string | `memory/memory.md`. |
| `max_tokens` | integer | From `AGENT_WATCHDOG_MEMORY_MAX_TOKENS`; estimated as `ceil(chars / 4)` with a 10 % margin, in code. |
| `version` | integer | Incremented per change. |
| `diffs` | string[] | `memory/history/<run_id>.patch`, one unified diff per run that changed memory. |

At the cap the agent condenses within the cap; the run does not fail (US4 scenario 2).

### Proposal

A suggested change awaiting human review (FR-032, FR-033).

| Field | Type | Rules |
|---|---|---|
| `proposal_id` | string | `<date>-<type>-<slug>`. |
| `type` | enum | `skill` \| `prompt` \| `threshold` \| `pattern_card` \| `project_annotation`. A `project_annotation` body carries a ready-to-paste `projects.yaml` fragment in a fenced block plus a short rationale (FR-061). |
| `run_id` | string | Run that produced it. |
| `title`, `body` | string | Pattern-level Markdown. |
| `evidence` | object[] | Replayed evidence: for thresholds, current value, proposed value, observed distribution, effect on the last 30 days of items including confirmed items kept (US4 scenario 4). |
| `flags` | Flag[] | `{ kind: 'hostname' \| 'person' \| 'address' \| 'secret', excerpt }` — identifiers found; the proposal is written with the identifier masked and the flag shown to the reviewer (FR-033). |
| `status` | enum | `proposed` \| `superseded`. Acceptance happens by PR, outside this system. |

### Corpus Item

A raw file placed in the knowledge corpus (FR-034, FR-035).

| Field | Type | Rules |
|---|---|---|
| `relative_path` | string | Under `AGENT_WATCHDOG_CORPUS_RAW_DIR`; never copied into a proposal. |
| `content_hash` | string | Full SHA-256; identity for change detection (US6 scenario 2). |
| `size_bytes` | integer | |
| `kind` | enum | `conversation` \| `export` \| `incident` \| `explainer` \| `run_outcome` \| `unknown`. |
| `status` | enum | `new` \| `distilled` \| `skipped`. A changed hash resets to `new`. |
| `skipped_reason` | string or null | Required when skipped, for example `binary` or `too_large` (Edge Cases). |
| `distilled_at` | timestamp or null | |
| `card_ids` | string[] | Cards that cite this item. |

The corpus index (`corpus/index.json`) holds these records and nothing of the content (FR-037).

### Pattern Card

A reviewed description of a recurring pattern (FR-035, FR-036, FR-038). Markdown with YAML front
matter under `skill/cht-watchdog/pattern-cards/<card_id>.md`; a one-line-per-card index at
`skill/cht-watchdog/pattern-cards/index.md` is what the daily analysis loads.

| Field | Type | Rules |
|---|---|---|
| `card_id` | string | Slug; identity. |
| `title` | string | |
| `symptom` | string | |
| `metrics` | `{ metric, shape }[]` | Shape is prose such as `rises over hours`. |
| `watchdog_appearance` | string | |
| `root_cause`, `resolution` | string | |
| `confirmation_steps` | string[] | Used as `suggested_check` when matched (US6 scenario 4). |
| `false_positives` | string[] | |
| `sources` | string[] | Corpus item content hashes. |
| `status` | enum | `proposed` \| `merged`. Only merged cards are indexed. |

### Calibration Report

Weekly, per project and metric (US4 scenario 4, FR-058).

| Field | Type | Rules |
|---|---|---|
| `week` | string | ISO week `YYYY-Www`. |
| `entries` | Entry[] | Per `project_url` and `metric`: `distribution` (percentiles of daily percentage change and deviation), `outcomes` `{ confirmed, dismissed, unreviewed }`, `current_threshold`, `suggested_threshold`, `effect_last_30d` `{ items_kept, items_dropped, confirmed_kept }`. |
| `pass_change_rate` | number | Share of projects where a later pass changed the outcome (FR-058). |
| `proposals` | string[] | Threshold proposal ids written from this report. |
| `open_proposals` | object[] | Every proposal still `proposed`, as `{ proposal_id, type, age_days }`, so the weekly report is the one reminder of what awaits review (FR-063). |
| `feedback_rate` | object | `{ window_days: 60, overall, by_month: [{ month, rate, items }] }`, computed from `corpus/outcomes/`, which outlive run-record retention (SC-002). |

### Expected-Load Window

| Field | Type | Rules |
|---|---|---|
| `id` | string | Slug. |
| `scope` | string | `all` or a project URL. |
| `kind` | enum | `month_end` \| `dates` \| `weekly`. |
| `start`, `end` | string | Local dates or day offsets per `kind`. |
| `timezone` | string | IANA zone; required (Edge Cases). |
| `note` | string | Shown in the post when active (FR-007). |
| `cycle_days` | integer | Length of the cycle used for `previous_cycle` comparison. |

### Priority List

| Field | Type | Rules |
|---|---|---|
| `dashboards` | `{ uid, title, panel_ids }[]` | Ordered; `panel_ids` empty means every panel. The analysis may still look beyond the list (FR-003). |

### Cost Record

| Field | Type | Rules |
|---|---|---|
| `run_id`, `project_url`, `stage`, `pass` | | `project_url` null for roll-up and feedback parsing. |
| `model` | string | |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | integer | |
| `cost_usd` | number | From the runtime result. |
| `num_turns`, `duration_ms` | integer | |

## Relationships

- A Run analyses many Projects; each Project has many Metric Windows, one Computed Change per
  metric, zero or more Candidates, and one Pass per analysis pass.
- An Item references one or more Candidates of the same project and at most one Pattern Card.
- A Brief carries at most five Bullets in its body; a Bullet holds one Item, one Project Group's
  Items as sub-bullets, or one Project Group's Alert Groups by category. Every Item of the run has
  one Thread Reply, and so does every Alert Group.
- A Project belongs to one Project Group. An Alert Instance belongs to one Alert Rule and, through
  its host, to one Project and one Project Group; an Alert Episode follows one Alert Instance from
  start to clear and may name one Item as its explanation.
- Feedback targets one Item or the Brief; Items accumulate Feedback across runs by `item_id`.
- A Proposal belongs to the Run that wrote it; Pattern Cards cite Corpus Items by hash.
- A Calibration Report reads Runs, Items and Feedback from the retention window.

## Cross-cutting validation rules

- Number matching (FR-016): the gate extracts every numeric token from bullet text, formats each
  computed value for the metric with the same display formatter, and requires every token to match
  one formatted value. Formatter, fixed in code: integers with thousands separators; other values to
  three significant figures; percentages with one decimal and a `%` sign; durations as `Nh` or
  `Nd`. Numerals inside backtick code spans are exempt from matching; instead each code span must
  equal, character for character, a PromQL expression from a collected panel target or a metric
  name collected this run, otherwise `numbers_match` fails. Bullet text outside code spans never
  contains PromQL.
- Links (FR-016): the model emits no URLs except `reference_urls`. Dashboard links are built by
  code from `dashboard_ref`; every link must resolve (HTTP 2xx or 3xx) and its host must be on the
  allow-list held in code: the configured Grafana host, `docs.communityhealthtoolkit.org`,
  (alert-list links are built by code from an Alert Group's rule titles and hosts as a `search`
  filter and resolve by confirming every title and host exists in the collected Alert Rules and
  Instances, research.md R-14; FR-070),
  `forum.communityhealthtoolkit.org`, `github.com/medic/`, the tracing host, and the hosts of
  `AGENT_WATCHDOG_PROMPTS_URL` and `AGENT_WATCHDOG_CONFIG_URL`.
- Secrets and personal data (FR-016, FR-045): reject on patterns for Slack tokens (`xox[abp]-`),
  Anthropic keys (`sk-ant-`), Grafana tokens (`glsa_`), bearer strings, e-mail addresses and
  phone numbers. Partner-facing scans are out of scope here (feature 002).
- Untrusted text (FR-044): tool results, notes and corpus excerpts are wrapped in labelled
  delimiters in prompts and rendered only through Handlebars `{{ }}` escaping; `{{{ }}}` is
  forbidden by lint rule in templates.
- Identity stability: `item_id` ignores severity, values and wording so an item persists across
  days while its evidence changes.

## Scale assumptions

- Up to 50 projects, 10 dashboards and roughly 200 panel expressions per project.
- Raw windows: five windows of 24 hours at a 5-minute step plus the 14-day trailing window is
  about 5,500 samples per metric. At 200 metrics a project's raw file is roughly 10 MB uncompressed;
  50 projects for 14 days is under 10 GB only if raw files are gzip-compressed on write, so
  `inputs/windows.json.gz` is written compressed. Everything else is small.
- Up to 500 firing Alert Instances per run; a group's thread reply lists at most fifty of them, and
  `alerts/episodes.jsonl` grows by one line per firing instance per day, kilobytes a year.
- Model usage is bounded per project and per run by configuration with hard caps in code
  (FR-012); projects with no candidates cost nothing (FR-013).

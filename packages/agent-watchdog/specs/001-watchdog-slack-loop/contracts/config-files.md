# Contract: Mounted Configuration Files

Structured, reviewed policy lives in versioned files (FR-053). Two locations:

1. **Deployment policy**, edited by the hosting team by pull request in `medic-infrastructure` and
   mounted read-only at `AGENT_WATCHDOG_CONFIG_DIR` (default `/etc/agent-watchdog`) from a
   ConfigMap: `projects.yaml`, `dashboards.yaml`, `thresholds.yaml`, `alerts.yaml`.
2. **Agent definition**, versioned with the code in this package and shipped in the image:
   `prompts/`, `skill/cht-watchdog/`, `schema/`, `templates/`. Prompts are code (constitution II);
   changing them is a pull request in `cht-ai-tools` with the replay diff attached. The footer
   link `AGENT_WATCHDOG_PROMPTS_URL` points here.

Every file is parsed with the `yaml` package (YAML 1.2, no custom tags), validated with zod at
startup, and its SHA-256 recorded in `run.json` under `versions.config_hash` (a hash over the
four policy files) so a run can always be tied to the policy that produced it. Missing optional
files fall back to the package defaults under `config/defaults/`; a present file that fails
validation exits 78.

## `projects.yaml`

Annotations per monitored project, keyed by the project's `instance` label exactly as it appears
in the metrics store: a bare host such as `cht.example.org` (research.md R-6). Projects absent
from this file are still analysed (FR-001, US5 scenario 1).

```yaml
defaults:                               # applies to every project unless overridden
  expected_load_windows:
    - id: month-end
      kind: month_end                   # last 2 days and first 2 days of each month
      days_before: 2
      days_after: 2
      timezone: Africa/Nairobi
      note: Month-end reporting; volumes rise across most projects.
      cycle_days: 30
projects:
  cht.example.org:                      # instance label value: bare host, no scheme
    owner: hosting-team                 # free text, shown internally only
    notes: Large deployment; sentinel backlog is normally under 200.
    host_metrics: false                 # true when cAdvisor is exposed on :8443 (readiness check)
    thresholds:                         # same keys as thresholds.yaml, partial override
      pct_change_vs_previous_day: 80
    expected_load_windows:
      - id: sync-week
        kind: dates
        start: 2026-10-05
        end: 2026-10-09
        timezone: Africa/Kampala
        note: Quarterly supervisor sync.
        cycle_days: 90
groups:                                 # programmes (FR-068); first matching pattern wins, in file order
  - label: MoH Nepal                    # PLACEHOLDER patterns until the hosting team sets the real ones
    host_patterns: ['*nepal*']
  - label: eCHIS Kenya                  # PLACEHOLDER
    host_patterns: ['*echis*']
ignore:                                 # development instances: discovered and counted, never analysed or posted
  - '*.dev.*'
  - '*-dev.*'
```

Rules: keys are lowercased hosts; a scheme, `www.` prefix or trailing slash is stripped on load so a
pasted URL still matches; the project URL is derived as `https://<host>`; `timezone` is a valid
IANA zone; window `kind` is one of `month_end`, `dates`, `weekly`. Group labels are unique, at
most 40 characters, and may not be the reserved `Other` or `Watchdog`; `host_patterns` and
`ignore` entries are lowercase globs (`*` any run of characters, `?` one character) matched
against the bare host, `ignore` checked first; a host matching no group belongs to `Other`. The
package default declares the two placeholder groups above and the two ignore patterns;
`node smoke/grafana.js --hosts` prints every discovered host with its group and whether it is
ignored, so the real patterns can be set from what the watchdog actually monitors.

## `dashboards.yaml`

The priority list (FR-003). Dashboards are referenced by Grafana UID; titles are informational
and refreshed from Grafana at run time.

```yaml
datasource_uid_env: AGENT_WATCHDOG_PROMETHEUS_DATASOURCE_UID   # informational
dashboards:                             # stock cht-watchdog uids (research.md R-6)
  - uid: oa2OfL-Vk
    title: CHT Admin Overview
    panels: [2, 3, 21, 7, 14, 16, 19, 13, 8, 23, 27, 50]   # panel ids, in order of interest
  - uid: hkQUbyfVk
    title: CHT Admin Details
    panels: []                          # empty means every panel on the dashboard
  - uid: 3J_78b6Zz
    title: CHT API Server
    panels: []
  - uid: d4f05050-804e-4ea4-9642-4d088cc39a1b
    title: CHT Replication
    panels: []
```

Rules: at least one dashboard; UIDs unique; every listed dashboard must select its instance with
the `cht_instance` variable; the analysis may look beyond the list (FR-003).

## `thresholds.yaml`

Global candidate thresholds and severity rules (FR-014). These are the initial defaults from the
spec; the system suggests changes as proposals and never edits this file (FR-032).

```yaml
trailing_days: 14                       # history needed for deviation; below it, unavailable
candidate_rules:
  pct_change_vs_previous_day: 50        # percent, absolute change in either direction
  deviation_sigma_vs_trailing: 2.5      # standard deviations versus the trailing window
  monotonic_rise_hours: 6               # sustained non-decreasing rise ending now
severity:
  default: low
  medium_when:
    - two_or_more_rules_fire
  high_when:                            # fixed list from FR-014; keys are metric roles
    - role: scrape_target
      condition: down
    - role: outbound_push_backlog
      condition: gt
      value: 0
    - role: sentinel_backlog
      condition: gt_multiple_of_baseline
      value: 3
metric_roles:                           # maps roles above to metric keys (research.md R-6)
  scrape_target: up{job="cht"}
  outbound_push_backlog: cht_outbound_push_backlog_count
  sentinel_backlog: cht_sentinel_backlog_count
display:
  persisting_days_label: persisting {n} days
```

Rules: numbers are positive; `metric_roles` values must exist in the collected metrics or the run
logs a warning and the rule cannot fire; only the three FR-014 high rules are accepted under
`high_when` (the list is validated against an enum, so a new high rule needs a code change and a
spec amendment).

## `alerts.yaml`

The reviewed alert policy (FR-065): category and importance per Grafana-managed rule title, the
staleness threshold, and the metric keys that count as related to each category when episodes are
correlated (FR-067). Titles are matched exactly against the rules read from Grafana, which on the
stock watchdog come from `grafana/provisioning/alerting/cht.yml` in cht-watchdog. A firing rule
whose title is absent here is reported as uncategorised with medium importance; adding it is a
pull request against this file, never a run-time write.

```yaml
stale_after_days: 14                    # firing this long or longer is "stale" (FR-065)
rules:                                  # keyed by rule title exactly as provisioned
  API Server Down:              { category: availability,  importance: critical }
  Sentinel Backlog:             { category: backlog,       importance: high }
  Outbound Push Backlog:        { category: backlog,       importance: high }
  Message Delivery Rate:        { category: messaging,     importance: high }
  DB Conflicts Rate:            { category: database,      importance: medium }
  Client Feedback/Error Rate:   { category: client_errors, importance: medium }
  Users Over Replication Limit: { category: replication,   importance: medium }
  DB Fragmentation:             { category: database,      importance: low }
  Server Time Accurate:         { category: host,          importance: low }
categories:                             # metric keys related to a category, for episode correlations (FR-067)
  availability: ['up{job="cht"}']
  backlog: [cht_sentinel_backlog_count, cht_outbound_push_backlog_count]
  messaging: [cht_messaging_outgoing_total]
  database: [cht_couchdb_doc_conflicts, cht_couchdb_fragmentation]
  client_errors: [cht_feedback_total]
  replication: [cht_replication_limit_users_over_count]
  host: []
```

Rules: `stale_after_days` is an integer from 1 to 365; `importance` is one of `critical`, `high`,
`medium`, `low`; `category` is a lowercase slug and every category used by a rule has an entry
under `categories` (an empty list is allowed); metric keys are checked against the collected
metrics at run time and unknown ones log a warning. The package default carries the mapping above;
the exact metric keys per category are confirmed against the dashboards during implementation
(research.md R-6).

## Package-shipped agent definition (read-only, versioned with code)

| Path | Purpose |
|---|---|
| `prompts/system.md` | System prompt; static prefix kept identical across calls for caching. |
| `prompts/pass-first.md`, `prompts/pass-review.md` | Pass prompts (FR-056). |
| `prompts/rollup.md`, `prompts/feedback-parse.md`, `prompts/calibration.md`, `prompts/distill.md` | Stage prompts. |
| `skill/cht-watchdog/SKILL.md` and `references/` | The cht-watchdog skill. |
| `skill/cht-watchdog/pattern-cards/index.md`, `*.md` | Merged pattern cards and their index (FR-038). |
| `schema/findings.schema.json`, `schema/brief.schema.json` | Structured-output schemas ([findings.schema.json](./findings.schema.json), [brief.schema.json](./brief.schema.json)). |
| `templates/report.hbs`, `templates/slack/*.hbs` | Handlebars templates; HTML-escaping on, triple-stash forbidden. `slack/alert-group.hbs` renders an alert group's thread reply (FR-066). |
| `config/defaults/*.yaml` | Fallbacks when a policy file is absent. |
| `agent/mcp.json`, `agent/hooks.json`, `agent/tools.json` | The one configuration source both engines read ([agent-definition.md](./agent-definition.md)). |

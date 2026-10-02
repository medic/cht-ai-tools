---
name: cht-watchdog
description: How to read CHT Watchdog metrics for a CHT deployment, decide what deserves a human's attention, and describe it for technical operations staff.
---

# CHT Watchdog analysis skill

## What the watchdog measures

CHT Watchdog is Prometheus plus Grafana scraping each CHT instance's monitoring endpoint
(`/api/v2/monitoring`) every five minutes through a JSON exporter, and the API's own express
metrics on CHT 4.3 and later. Every series carries `instance` (the bare host) and `job`. The
metric catalogue with meanings and labels is in `references/metrics.md`; the most consequential
signals are:

- `up{job="cht"}`: 0 means the monitoring endpoint could not be fetched. Treat as the deployment
  being unreachable until confirmed otherwise.
- `cht_sentinel_backlog_count`: changes Sentinel has not yet processed. A sustained rise means
  transitions, tasks and messages are delayed for every user of that deployment.
- `cht_outbound_push_backlog_count`: changes not yet pushed to external systems. Any value above
  zero for more than one scrape means an integration is stalled.
- `cht_replication_limit_count`: users whose documents exceed the replication limit; they cannot
  sync fully.
- `cht_conflict_count`, `cht_feedback_total`: document conflicts and client-side error reports;
  rises usually follow a release or a data problem.
- `cht_couchdb_*`: database size, fragmentation and growth; slow-moving, matters when the trend
  breaks.
- `cht_date_current_millis` and `cht_date_uptime_seconds`: server clock accuracy and restarts.

## How to reason about candidates

Code raises a candidate when a metric changed 50 percent or more versus the previous day, moved
2.5 standard deviations or more from the trailing fourteen days, or rose monotonically for six
hours or more; and always when a scrape target is down. Candidates carry the rule, the threshold
that fired and the observed value.

- Prefer the operational meaning over the size of the number. A backlog climbing steadily for
  hours matters more than a one-scrape spike that returned to normal.
- Ask whether the change is explained by an expected-load window (month-end, sync weeks) or by a
  known event recorded in feedback or memory. If so, say so in `not_selected` rather than
  flagging it.
- Two rules firing on one metric strengthen the case; one rule on a noisy, low-volume metric
  weakens it.
- Fewer than fourteen days of history means the deviation comparison is unavailable; do not infer
  a baseline yourself.
- Severity `high` only for the three fixed situations: scrape target down, outbound push backlog
  above zero, sentinel backlog above three times its baseline.

## Writing why_now and suggested_check

- `why_now`: one or two sentences naming the metric, the change and its consequence for users or
  operators today. Quote computed values with their windows; do not round or estimate.
- `suggested_check`: the first concrete thing an operator should look at, in order of likelihood:
  the panel over the window, then the service logs or the CouchDB status that would confirm the
  cause. When a pattern card matches, use its confirmation steps.
- Never speculate about a cause as fact; phrase hypotheses as things to confirm.
- Write for someone who knows the CHT and PromQL; skip pleasantries and hedging.

# CHT Watchdog metric catalogue

Verified against the cht-watchdog repository (main, 2026-09-19; research.md R-6). Every series
also carries `instance` (bare host) and `job`.

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
| `up` | gauge | `job`, `instance` | Scrape health per job; `up{job="cht"}` is the monitoring endpoint probe |

Jobs: `cht` (json_exporter probe of `/api/v2/monitoring`, 5-minute interval), `cht-express-metrics`
(`/api/v1/express-metrics`, CHT 4.3.0 or later, `cht_api_*` metrics), `json_exporter`,
`prometheus`, `grafana`.

Provisioned dashboards: CHT Admin Overview `oa2OfL-Vk`, CHT Admin Details `hkQUbyfVk`, CHT API
Server `3J_78b6Zz`, CHT Replication `d4f05050-804e-4ea4-9642-4d088cc39a1b`. All select an instance
with the single-valued `cht_instance` variable.

# Contract: Exit Codes

Codes follow the BSD `sysexits` convention for specific conditions so they never collide with
Node's own exit codes (1 to 13 are reserved by Node for internal failures, of which only 1 is used
here). A non-zero exit always has a matching JSON log line with `event: "run.exit"`, the code, and
the reason. Failure is loud: whenever Slack is reachable and the channel is known, a non-zero exit
of a `run` is preceded by a one-line failure notice with the trace link (FR-024).

| Code | Name | Meaning | Posts to Slack |
|---|---|---|---|
| 0 | `OK` | `run` published a brief, a heartbeat or a degraded brief; or `run --dry-run`, `replay`, `distill`, `calibrate`, `purge` completed; or `check` found every prerequisite met. | brief or heartbeat (not in preview) |
| 1 | `FAILED` | `run` failed for a reason not listed below (unexpected error, model runtime crash); or `check` found unmet prerequisites. | failure notice |
| 64 | `USAGE` | Unknown command, unknown flag, or an invalid flag combination (for example `--stage` with `replay`). | no |
| 65 | `DATAERR` | A stage or replay prerequisite file is missing or fails validation. | no |
| 69 | `UNAVAILABLE` | Metrics source unreachable or timed out after retries; nothing partial is published (Edge Cases). | failure notice |
| 74 | `IOERR` | Slack unavailable after retries; every artefact persisted and the run marked `unposted` (Edge Cases). | no (cannot) |
| 75 | `TEMPFAIL` | A run for this date already exists and `--force` was not given (FR-042); or a stage-only `publish` found the run's publication record already naming a parent post (revision 34). Retry with `--force` if intended. | no |
| 78 | `CONFIG` | Startup validation of environment, flags or configuration files failed; the offending keys are named in the log with values redacted (FR-055). | no |

Notes:

- A request to a destination outside the egress allow-list (FR-083, revision 30) is refused before a
  connection is made and surfaces as `UNAVAILABLE` (69) with the host and port in the log and the
  failure notice, never the URL.
- Reaching a tool, token or cost bound is not a failure: the run completes with what it has, says
  so in the post, records `bounds_hit` in `run.json`, and exits 0 (FR-012).
- A degraded brief exits 0 with `status: degraded` so the scheduler does not retry a run that has
  already posted (FR-017).
- The scheduler in `medic-infrastructure` should treat any non-zero exit as a failed job and rely
  on its own alerting for repeated failures; this package never pages anyone (FR-024; Out of Scope).
- Exit codes above 128 are signal terminations from the platform (for example 137 on OOM kill)
  and are not produced by this package.

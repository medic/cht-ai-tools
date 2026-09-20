# Corpus fixtures

Small raw items a maintainer might drop into `AGENT_WATCHDOG_CORPUS_RAW_DIR`, used by the corpus
index, distillation and User Story 6 end-to-end tests. Hosts are `<name>.example.org`, the person
is a fake Slack id and the address is `ops@example.org`, so the scrub has something to find.

| Path | Kind | Notes |
|---|---|---|
| `conversations/2026-05-14-sentinel-stall.md` | conversation | Slack-style thread: sentinel backlog climbing for hours after an upgrade, a transition error, a mention, a hostname and an e-mail address. |
| `exports/2026-05-14-sentinel-backlog.csv` | export | The rising backlog series from the same morning. |
| `incidents/2026-06-02-outbound-push.md` | incident | Outbound push backlog above zero after a credential rotation. |
| `explainers/sentinel.md` | explainer | What Sentinel does and what its backlog means. |
| `binary/dashboard.png` | unknown, skipped `binary` | A 16-byte PNG header, not a real image. |
| `too-large/metrics-dump.txt` | unknown, skipped `too_large` | About 6 KiB of repeated lines; tests pass `maxBytes: 4096` so it counts as too large. |

Tests copy the item directories (not this README) into a temporary raw directory.
`node test/fixtures/generate-corpus.js` rewrites the two synthetic files.

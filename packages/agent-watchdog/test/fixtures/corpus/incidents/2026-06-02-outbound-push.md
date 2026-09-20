# Incident 2026-06-02: outbound push stalled after a credential rotation

Summary: on field.example.org the outbound push backlog rose from zero to 41 over one afternoon and
stayed there. Nothing else on the dashboards changed. The receiving system had rotated the API key
that morning and the new key had not been written into the CHT configuration.

Detection: the watchdog's Outbound Push Backlog panel showed a step to a non-zero value that never
returned to zero; the API and sentinel panels were flat.

Root cause: outbound push retries every change against the old credential; each attempt fails with
401 and the change stays queued, so the backlog counts the number of changes waiting.

Resolution: the new key was written into the outbound configuration and the queue drained in about
ten minutes without manual replay.

Confirmation: the outbound push log shows repeated 401 responses from the receiving system, and the
backlog starts falling as soon as the credential is corrected.

Follow-up: rotate credentials on both sides in one change window.

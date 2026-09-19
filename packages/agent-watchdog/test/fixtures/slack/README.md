# Slack fixtures

Recorded-shape Web API payloads for the feedback ingestion tests (User Story 2).

- `replies-page1.json`, `replies-page2.json`: one `conversations.replies` thread for the 2026-09-17 brief, paged by cursor: the parent, two bot item replies with registered metadata, one human note that references an item, one note that references nothing.
- `reactions.json`: `reactions.get` results keyed by message ts (a thumbs-up on the parent, a thumbs-down on the alpha item, two thumbs-up on the gamma item, one non-verdict reaction).
- `publication-2026-09-17.json`, `items-2026-09-17.json`: what that run left under `rollup/`.
- `history-page.json`, `replies-2026-09-16.json`, `reactions-2026-09-16.json`: the fallback path for a run whose `publication.json` is missing.

Item ids are `identity.itemId(project_url, metric, null)` for the metrics named in the metadata.

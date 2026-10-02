# Contract: Slack Payload, Feedback Reads and App Configuration

Facts about the Slack Web API below were verified against https://docs.slack.dev on 2026-09-19
(research.md R-10 and R-11). The app is an internal, single-workspace app named `agent-watchdog`;
its bot display name is set in the app configuration, so no per-message identity override and no
`chat:write.customize` scope is used (FR-047).

## Markers, patterns and correlation (revision 14)

The payload builder adds emoji markers when it renders (FR-082): the header by brief kind (📋 brief,
🚨 alerts only, ✅ heartbeat, ⚠️ degraded, ❌ failure), each item or programme section by its worst
severity (🔴 🟠 🟡), alert sections with 🚨, and context lines by kind (✅ resolved, 🧹 housekeeping,
🆕 first run or new projects, ⚠️ analysis incomplete or alerts unavailable, 📅 expected load).
`brief.json` and the model's output carry no markers. An alert group's thread
reply opens with one paragraph per programme-wide pattern (`🔁 Programme-wide: <rule> on N of M
projects, first <date>, last <date>` and the hosts) and lists the other instances with the metric
behind the alert (`· <metric> <value> now (yesterday <value>)`). An item reply carries
`🚨 Alert firing: <rule> since <date> (<n>d)` when a firing alert's category covers its metric.

## App configuration (managed outside this package, documented here)

| Item | Value |
|---|---|
| Bot display name | `agent-watchdog` |
| Bot token scopes | `chat:write`, `files:write`, `reactions:read`, `reactions:write` (the "seen" reaction on acknowledged notes, FR-062), `channels:history`; add `groups:history` only if the configured channel is private; `im:write` and `im:history` when the configured conversation is a direct message with the bot, as a test post (FR-084, revision 27). The bot must be a member of the conversation; a post refused for `not_in_channel` fails the run with exit 74 |
| Channel membership | the bot is invited to the configured channel; posting and reading both require membership (`not_in_channel` otherwise) |
| Message metadata schemas (app manifest, `metadata.event_subscriptions`) | `agent_watchdog.brief` with `run_id`, `date`, `kind`; `agent_watchdog.programme` with `run_id`, `date`, `group`, `kind` (`programme` or `other`), `item_ids` for the programme and Other replies (revision 28); `agent_watchdog.alerts` with `run_id`, `date`, `firing` (count), `programmes` for the one alerts reply (FR-066, revision 28); `agent_watchdog.feedback_digest` with `run_id`, `date`, `acknowledged` (count). `agent_watchdog.item` (`run_id`, `item_id`, `project_url`, `metric`) and the per-group `agent_watchdog.alerts` shape (`group`, `category`) are still read from posts made before revision 28. Unregistered metadata is ignored by Slack with a warning, so registration is part of the app setup checklist. |
| Rate-limit class | internal customer-built app: `conversations.history` and `conversations.replies` keep Tier 3 and the normal `limit` values; the 2025 one-request-per-minute limit applies only to non-Marketplace apps distributed commercially |

## Publishing sequence (`src/publish/slack.js`)

1. **No image upload** (revision 24). Until then the brief image was uploaded privately with
   `files.uploadV2` and shown as an `image` block; the report share (step 3) is the artefact a reader
   opens, so the parent carries no file before it is posted. `files.upload` is sunset (12 November
   2025) and is never called.
2. **Post the parent message** with `chat.postMessage({ channel, text, blocks, unfurl_links: false,
   unfurl_media: false, metadata })`. `text` is the plain-text fallback (headline plus bullets).
   Blocks, at most 50, in order: a `section` with the headline in bold (never Slack's `header` block,
   which cuts text at 150 characters; revision 28), one `section` per programme bullet with `mrkdwn`
   (at most two; the group line, then each project line on its own line prefixed by three spaces and
   `◦`, at most three plus the count of the rest, since Slack has no nested lists; the indentation's
   rendering is smoke test S-16), a `context` block with the expected-load or degradation notice when
   present, one `context` block per code-added notice that is not alert-derived (a project new since the
   previous run, a standing condition, an incomplete analysis), and a `context` footer identical to the
   report's footer line (revision 25): the specification, configuration and trace links, the cost in
   currency and the run id, then the count of items only in the report.
3. **Share the report into the thread** with `files.uploadV2({ file, filename: 'report-<run_id>.html',
   title, channel_id, thread_ts: <parent ts>, initial_comment })` (revision 23): an upload given a
   channel and a thread posts the file as the thread's first reply, readable by every channel member,
   where the private image upload of step 1 is readable by the bot alone. `initial_comment` is built
   by code and states the item count, how many items have replies and how to cite an item in a note
   (`#<rank>`, or host and metric) with a thumbs as the verdict. The file id and the share's `ts` are
   recorded (smoke test S-31). Then **post the thread replies** (revision 28), each with
   `chat.postMessage({ channel, thread_ts: <parent ts>, text, blocks, metadata })`: one reply per
   programme not in the body with two or more flagged projects (`templates/slack/programme.hbs`: the
   group line, at most three project lines, the count of the rest; `metadata.event_type:
   'agent_watchdog.programme'` with `{ run_id, date, group, item_ids }`), one `Other` reply in the same
   form for the remaining projects, and one alerts reply (`templates/slack/alerts.hbs`: per programme the
   firing count with its categories, the new and stale counts and the code-built link to that programme's
   filtered alert list, then the link to every firing alert, then the housekeeping, resolved and
   alerts-unavailable notices; `metadata.event_type: 'agent_watchdog.alerts'`). No item and no alert
   group has a reply of its own since revision 28. Each reply is one section of at most 3,000 characters
   and a link is never cut; a programme's own alert-list link longer than 1,000 characters is left off its
   line, which keeps its counts, and the notices and the link to every firing alert are given up only
   after the last programme line (revisions 36 and 37). Replies are never broadcast.
4. **Record** `chat.getPermalink({ channel, message_ts })` for the parent and each reply into
   `publication.json`; permalinks of thread replies carry `thread_ts` and `cid`.
5. A forced re-run posts a new parent whose first context block links the superseded post's
   permalink; it does not edit or delete the earlier post.
6. **Post the feedback digest** (User Story 7), only when the run acknowledged new feedback, as one
   threaded reply under the parent it published that day, brief or heartbeat, with
   `metadata: { event_type: 'agent_watchdog.feedback_digest', event_payload: { run_id, date, acknowledged } }`.
   Its text is built by code from `rollup/feedback.digest.json` through
   `templates/slack/feedback-digest.hbs`: per item the effect applied today and, since revision 29
   (FR-085), how the feedback was used: the exact `kind`, `verdict`, `note` and `horizon` lines it put
   into the project's `prompt.pass1.md`, quoted (at most eight, then the count of the rest) with the
   run's trace link, or the suppression it caused before analysis with the file that records it, or
   that it was not used today; then the proposals written with destination and path, and one
   retention sentence naming where the records live permanently and how many days they adjust
   ranking. It names no person. Then `reactions.add({ channel,
   timestamp: <note ts>, name: 'eyes' })` for each acknowledged note; `already_reacted` is not an
   error, any other failure is logged and never fails the run. Nothing is posted or reacted to in
   preview mode.

Heartbeat and failure notices are single `chat.postMessage` calls with `text` only and the
`agent_watchdog.brief` metadata (`kind: heartbeat | failure`); a heartbeat still receives the
feedback digest in its thread when there is feedback to acknowledge. Posting is paced to one message per
second per channel; the client's built-in retry handles `429` with `Retry-After`.

## Payload object (`payload.json`, also the preview output)

```json
{
  "run_id": "2026-09-19",
  "kind": "brief",
  "parent": { "channel": "C…", "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.brief", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "kind": "brief" } } },
  "image": null,
  "report": { "filename": "report-2026-09-19.html", "title": "…", "path": "rollup/report.html", "initial_comment": "…", "items": 150, "slack_file_id": null, "ts": null },
  "replies": [
    { "kind": "programme", "group": "North Programme", "item_id": null, "alert_key": null, "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.programme", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "group": "North Programme", "kind": "programme", "item_ids": [ "a1b2c3d4e5f6" ] } } },
    { "kind": "other", "group": "Other", "item_id": null, "alert_key": null, "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.programme", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "group": "Other", "kind": "other", "item_ids": [ "b2c3d4e5f6a1" ] } } },
    { "kind": "alerts", "group": null, "item_id": null, "alert_key": null, "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.alerts", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "firing": 13, "programmes": [ "North Programme", "South Programme" ] } } }
  ],
  "digest": { "text": "…", "blocks": [ … ], "metadata": { "event_type": "agent_watchdog.feedback_digest", "event_payload": { "run_id": "2026-09-19", "date": "2026-09-19", "acknowledged": 3 } }, "acknowledged": [ "<feedback_id>" ], "reactions": [ { "source_ts": "1700000000.000100", "name": "eyes" } ] }
}
```

`replies` carries the programme replies, the `Other` reply and the alerts reply, each with `kind` and `group` and with `item_id` and `alert_key` null (FR-020, revision 28); `report` is null for a
heartbeat or a failure. `image` is always null since revision 24. In preview mode nothing is sent; after publishing,
`publication.json` adds `ts`, `permalink` and `report: { file_id, ts, permalink }` for the share
(`slack_file_id` stays null). `digest` is null when the run
acknowledged nothing new; in preview it is filled but nothing is posted or reacted to, and no
record is marked acknowledged.

## Text rules enforced by the gate before publishing

- Headline: at most two lines of 120 characters, shown whole (revision 28). Bullets: at most two
  top-level, one per programme, each with at most three project lines and a count of the rest; every
  project line covers all of that project's items in at most two lines of 120 characters, the first
  within the budget left by the project's short host, which code writes in front of it (an item
  bullet carries its full host; revision 26, FR-069); the thread's programme and Other replies follow
  the same rules; numbers formatted by the shared formatter; no URLs in bullet or line text (links
  live in the footer and the alerts reply).
- Every string is rendered through Handlebars templates under `templates/slack/` with escaping on;
  Slack `mrkdwn` special characters `&`, `<`, `>` in untrusted text are escaped as `&amp;`, `&lt;`,
  `&gt;`.
- Fallback `text` is limited to 4,000 characters.

## Reading feedback (`src/feedback/ingest.js`)

For each of the previous N runs (`AGENT_WATCHDOG_FEEDBACK_LOOKBACK_RUNS`, or since `--since`),
using the `ts` values recorded in that run's `publication.json`:

1. `conversations.replies({ channel, ts: <parent ts>, limit: 1000, include_all_metadata: true })`,
   paging with `cursor`. The first message is the parent; replies carry `thread_ts` and
   `parent_user_id`. The bot's own replies are recognised by the `ts` values in `publication.json`
   or their metadata: since revision 28 they are the programme, Other and alerts replies, which are
   never notes and whose reactions are not feedback; in posts made before revision 28, a reply with
   `agent_watchdog.item` metadata is an item and one with per-group `agent_watchdog.alerts` metadata
   an alert group (feedback on them targets `item` or `alert_group`). Other messages are notes.
2. For the parent and every item or alert-group reply, `reactions.get({ channel, timestamp, full: true })`
   to obtain the complete `reactions[] { name, users[], count }` list, because reaction arrays
   embedded in history payloads may omit users.
3. Map `+1`/`thumbsup` to `up` and `-1`/`thumbsdown` to `down`; a reaction recorded in
   `feedback.jsonl` on a previous ingestion and absent now is recorded as `retracted`. Reactions on
   the parent target the brief. Notes are matched to items by explicit reference, `#<rank>` against
   the source run's `items.ranked.json` first, then item id, then host and metric (revision 23), or
   recorded as unmatched; a thumbs written in the note (`:+1:`, `:thumbsup:`, `:-1:`, `:thumbsdown:`
   or the emoji) is the note's verdict and counts like a reaction on the item it cites. Since
   revision 28 this is the only way to give a verdict on one item, as no item has a reply of its own.
   The notes on one item are read together in thread order (revision 29, FR-085): the horizon applied
   is the last one the thread states, each note's own parse is stored, a note without a date reaches
   the model with the earlier notes of its thread as context, and the review classifies the thread as
   one whole with at most one proposal.
4. Only when a run's `publication.json` is missing does the ingester fall back to
   `conversations.history({ channel, oldest, latest, include_all_metadata: true })` and identify
   posts by their `agent_watchdog.brief` metadata.

Call volume per run is bounded: at most N parents, their reply pages, and one `reactions.get` per
bot message, paced under the Tier 3 allowance.

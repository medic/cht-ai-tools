# Feature Specification: Watchdog Slack Loop

**Feature Branch**: `001-watchdog-slack-loop`
**Created**: 2026-09-19
**Status**: Draft (revision 29)
**Input**: Daily analysis of the CHT projects monitored by Medic's hosted CHT Watchdog, posted to
Slack as a short brief that flags what a human should look into, with a feedback loop, a knowledge
corpus the agent learns from under review, and the ability for anyone with a watchdog installation
to run the same agent on their own machine and see exactly what it would post.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daily brief for the on-call engineer (Priority: P1)

A Medic engineer responsible for hosted CHT projects opens Slack in the morning and finds one
post from agent-watchdog: a headline, at most five bullets across all monitored projects (a
bullet may carry sub-bullets for a programme's projects or alerts, User Stories 8 and 9), each
with the metric evidence, why it matters now, a suggested check and a link straight to the
relevant dashboard view for that project and time window, plus the full report shared into the
thread (until revision 24 also a rendered image of the brief, retired as a picture of the message it
sat under).
On a day with nothing worth flagging, the post is a single line saying so and what was checked.

**Why this priority**: the whole system exists to produce this post. Every other story
improves it.

**Independent Test**: run against a recorded day of metrics containing one seeded anomaly and
verify the post names the project and metric with evidence and a link; run against a recorded
quiet day and verify the one-line post.

**Acceptance Scenarios**:

1. **Given** the hosted watchdog holds metrics for many projects and one project's sentinel
   backlog has climbed steadily for six hours to three times its level in the same window
   yesterday, **When** the daily run executes, **Then** the post's bullets include that project
   and metric with the current value, the comparison values, the duration of the climb, and a
   dashboard link scoped to that project and window.
2. **Given** no project's metrics differ notably from their baselines, **When** the run
   executes, **Then** a single-line post states all is quiet and how many projects and panels
   were checked, and no thread replies are created.
3. **Given** more items qualify than five bullets can hold, **When** the run executes, **Then**
   the two highest-ranked programmes fill the body, each with at most three project lines, every
   other programme with two or more flagged projects has a thread reply of its own, the remaining
   projects share one "Other" reply, the alerts share one reply (revision 28), and every item appears in the run's report, shared into
   the thread as its first reply, where every item is numbered by rank so a note can cite it
   (revision 23; until then every item had a reply, which reached 159 replies under one post).
4. **Given** the run falls inside a configured expected-load window (month-end, sync week),
   **When** a metric rises in line with the same phase of the previous cycle, **Then** it is
   not flagged and the post notes that the window is active.
5. **Given** a scrape target for a project is down, **When** the run executes, **Then** the
   outage is itself a flagged item rather than being treated as missing data.
6. **Given** the analysis passes run, **When** the verification gate rejects a draft, **Then** the
   revision the model is asked for names only the checks that failed, and no rejection is caused by
   a value the run already computed, so a pass is not spent re-deriving a fact the harness holds
   (revision 18).
7. **Given** a draft brief contains a number that does not match the computed data, a project
   name that is not a monitored project, or a link that does not resolve, **When** the run
   reaches publication, **Then** the draft is rejected, the reasons are returned for revision,
   and nothing is posted until a draft passes or the run degrades to the deterministic brief.
8. **Given** the run is configured for two analysis passes, **When** the first pass has produced
   its items, **Then** a second pass receives those items and the candidates the first pass did
   not select, re-examines the data, asks the documentation service any new or clarifying
   questions the first answers raised, and emits revised items with a recorded reason for every
   addition, removal or change; and **When** a pass changes nothing material, **Then** remaining
   passes are skipped and the run says so.

### User Story 2 - Feedback that changes tomorrow's brief (Priority: P2)

An engineer reacts with a thumbs-up to a flagged item that was accurate and useful, or a
thumbs-down to one that was not, and replies in the thread explaining why. The next run reads
those reactions and notes, records them against the item's stable identity, stops repeating
dismissed patterns and treats confirmed ones as known-good.

**Why this priority**: without it the brief cannot improve and will be muted within weeks.

**Independent Test**: seed reactions and a thread note on a recorded post, run the next day
against recorded metrics, verify the feedback record exists and that the pattern's ranking and
the agent's memory reflect the note.

**Acceptance Scenarios**:

1. **Given** a flagged item received a thumbs-down and a thread note "known migration, expected
   until 1 October", **When** the next run executes, **Then** the feedback is stored with the
   item's identity, verdict, note and author; the agent's memory contains the note; and the same
   pattern is not flagged again before 1 October unless it exceeds the noted expectation.
2. **Given** a flagged item received thumbs-up from two people, **When** the next run executes,
   **Then** both are recorded and the pattern's confidence is raised in memory.
3. **Given** a reaction was placed on the parent post rather than on an item's reply, **When**
   it is ingested, **Then** it is recorded as feedback on the brief as a whole.
4. **Given** a thread note cannot be matched to any item, **When** it is ingested, **Then** it
   is recorded as unmatched and surfaced in the next brief's thread for a human to clarify.
5. **Given** feedback has accumulated for thirty days, **When** the next run executes,
   **Then** confirmed and dismissed items have been appended to the knowledge corpus as run
   outcomes, available to the distillation described in User Story 6.
6. **Given** a thread note reads "#12 :-1: known migration until 1 October" under a brief whose
   report lists an item ranked 12, **When** it is ingested, **Then** it is recorded as feedback on
   that item with verdict down, the note and its horizon; and a note whose only content is a
   thumbs, citing no item, is recorded as unmatched (revision 23).

### User Story 3 - Steering, auditing and running it yourself (Priority: P2)

A member of the AI team wants to change what the agent prioritises, edit its prompts, see
exactly what happened in a run and know what it cost. A contributor — at Medic or in the
community with their own watchdog — wants to run the agent from their own machine against their
own watchdog, watch each stage, and see the exact message it would have posted without posting
anything.

**Why this priority**: trust in an autonomous daily post depends on being able to inspect,
redirect and reproduce it without touching code in production.

**Independent Test**: follow the footer links from a posted brief; reorder the priority list in
configuration; run; verify analysis order changed, the trace exists and the cost is shown. On a
laptop, run each stage in turn against a watchdog, inspect the stored files between stages, and
run the full pipeline in preview mode to obtain the would-be post as structured data.

**Acceptance Scenarios**:

1. **Given** a posted brief, **When** the reader follows its footer, **Then** they reach the
   feature's specification, the deployment configuration where dashboard priority order and the expected-load
   calendar are edited, and the run's trace, and they see the run's cost in currency.
2. **Given** a maintainer reorders the priority list or adds a dashboard, **When** the next run
   executes, **Then** the analysis reflects the new order, and the agent may still examine
   dashboards beyond the list.
3. **Given** any stored run, **When** a maintainer replays it with a changed prompt, **Then** the
   findings are regenerated from stored inputs without contacting the metrics source or Slack,
   and can be compared with the original.
4. **Given** any run, **Then** its record names the code, prompt and configuration versions that
   produced it.
5. **Given** a contributor with a watchdog installation and their own model credentials,
   **When** they run the agent in preview mode from their machine, **Then** it produces the
   same stored artefacts as a production run and prints the exact message payload (post,
   thread replies, report share) as structured data, and posts nothing.
6. **Given** a contributor runs one stage at a time, **When** each stage completes, **Then** its
   output is a readable file the next stage consumes, so any stage can be re-run in isolation.
7. **Given** a contributor runs the analysis stage through the agent runtime's own command-line
   interface rather than through this package, **When** the same skill, tools, prompts and
   output schema are supplied, **Then** the resulting items validate against the same schema and
   the verification gate accepts or rejects them on the same grounds.

### User Story 4 - Self-improvement under review (Priority: P3)

Over time the agent notices patterns its skill or notes were missing, sees that thresholds are
too loose or too tight for a given project, and proposes updates. A human reviews every proposal
before anything about the agent's behaviour changes.

**Why this priority**: it compounds the value of the loop, but only once the loop itself works.

**Independent Test**: run against recorded days containing a recurring pattern and a noisy
metric; verify a pattern proposal and a threshold proposal appear, that both are evidence-backed
and pattern-level, and that no prompt, skill or threshold file changed.

**Acceptance Scenarios**:

1. **Given** a run in which the agent learned a durable pattern, **When** it completes, **Then**
   a proposal exists describing the pattern in general terms with evidence, and no prompt, tool,
   skill or threshold content was modified.
2. **Given** the agent's memory is at its size cap, **When** the agent adds notes, **Then** it
   condenses within the cap, the change is stored as a diff, and the run does not fail.
3. **Given** a proposal contains a project hostname or a person's name, **When** it is written,
   **Then** the identifier is flagged for the reviewer rather than published as-is.
4. **Given** thirty days of stored runs and feedback for a project, **When** the weekly
   calibration runs, **Then** any threshold suggestion states the current value, the proposed
   value, the observed distribution of changes that justifies it, and the effect it would have
   had on the last thirty days of items, including which confirmed items it would have kept.
5. **Given** a rule that raises candidates the analysis examines and sets aside day after day,
   and no human has judged them, **When** the weekly calibration runs, **Then** the report states
   how many candidates each rule raised, how many became items, how many the analysis set aside
   and its commonest reasons, and any threshold suggestion drawn from those says so; a human
   verdict on the same candidate always outranks the analysis's own (revision 20).

### User Story 5 - New projects and readiness (Priority: P3)

A community project's URL is added to Medic's hosted watchdog. The next run analyses it without
anyone editing agent-watchdog. Separately, an operator can check whether a CHT deployment meets
the prerequisites for useful monitoring.

**Why this priority**: it removes agent-watchdog from the onboarding critical path.

**Independent Test**: add a project to recorded metrics with no configuration entry; run; verify
it is analysed and named as new. Run the readiness check against a deployment below the minimum
version; verify the plain-language report and non-zero exit.

**Acceptance Scenarios**:

1. **Given** a project appears in the metrics store with no configuration entry, **When** the
   run executes, **Then** it is analysed like any other and the brief notes a new, unconfigured
   project.
2. **Given** an operator runs the readiness check against a CHT URL, **When** the deployment's
   version is below the minimum the watchdog supports or the host-metrics exporter is absent,
   **Then** each unmet prerequisite is reported in plain language and the command exits non-zero.
3. **Given** a project has fewer than fourteen days of history, **When** it is analysed,
   **Then** comparisons that need history are marked unavailable rather than computed from
   partial data.

### User Story 6 - Learning from the knowledge corpus (Priority: P3)

A maintainer drops material into a knowledge corpus: past conversations in which the watchdog was
used to find a problem, exported dashboard data from an incident, incident write-ups, and
explainers of CHT components such as the existing Sentinel write-up. On demand, or on a schedule,
the agent reads what is new, abstracts reusable patterns — what the symptom looked like in the
watchdog, which metrics moved and how, what the cause turned out to be, how to confirm it — and
proposes additions to its skill. A human reviews the proposals; once merged, the daily analysis
uses them.

**Why this priority**: it turns years of operational experience into the agent's judgement,
but only pays off once the daily loop is stable.

**Independent Test**: place two items in the corpus (one conversation, one data export), run
the distillation, verify one pattern card per distinct pattern with sources cited, verify
identifiers are scrubbed or flagged, verify the daily analysis can reference the merged card by
name in a later replay.

**Acceptance Scenarios**:

1. **Given** new items in the corpus, **When** distillation runs, **Then** each distinct pattern
   becomes or updates one pattern card with symptom, metrics involved and their shape of change,
   how it appeared in the watchdog, root cause, resolution, how to confirm, known false
   positives and the corpus items it came from.
2. **Given** an item was already distilled, **When** distillation runs again, **Then** it is not
   re-processed unless it changed.
3. **Given** a pattern card would contain a project hostname, a person's name or a recipient
   address, **When** it is written, **Then** the identifier is removed or flagged for the
   reviewer, and raw corpus material is never copied into the proposal.
4. **Given** pattern cards have been merged, **When** the daily analysis flags an item matching
   a card, **Then** the item names the pattern and uses the card's confirmation steps as its
   suggested check.
5. **Given** the corpus grows large, **When** the daily analysis runs, **Then** it loads a short
   index of pattern cards and reads full cards only when relevant, so the size of the corpus
   does not grow the cost of every run.

### User Story 7 - Feedback acknowledged and made permanent (Priority: P3)

An engineer who reacts to an item or leaves a note wants to know it was seen, what it changed,
and how to make the lesson permanent. The next run reviews the feedback it read: reactions are
tallied by code, notes with a reusable lesson become proposals for the place the lesson belongs
(the skill, a prompt, a project annotation, a threshold or a pattern card), and one digest reply
in the new brief's thread reports, per item, what changed today, which proposals were written and
where, and how long the feedback keeps influencing ranking. Feedback records are kept permanently
for audit; only their automatic influence on ranking is bounded.

**Why this priority**: it closes the loop for the people giving feedback and turns notes into
reviewed, permanent improvements instead of memory that may be condensed away; it depends on
User Stories 2 and 4.

**Independent Test**: seed thumbs and notes of each kind (an expectation with a horizon, a
project fact, a skill lesson, a prompt complaint, a threshold complaint) on a recorded post; run
the next day; verify one digest reply naming each item's effect and each proposal with its
destination and path; verify a second run acknowledges nothing again; verify the records survive
a purge dated a year later and that records older than the influence window no longer adjust
confidence.

**Acceptance Scenarios**:

1. **Given** reactions and notes on yesterday's post, **When** today's run completes, **Then** the
   new brief's thread carries exactly one feedback digest reply that states, per item, what the
   feedback changed today (confidence raised or lowered, or the candidate suppressed until its
   horizon), that the record is kept permanently at its path, how many days it keeps influencing
   ranking, and that the item's outcome is recorded in the knowledge corpus.
2. **Given** a note carrying a reusable lesson, **When** the run reviews it, **Then** a proposal
   file names one destination (skill, prompt, project annotation, threshold or pattern card) and
   states the lesson in pattern-level terms; the digest names the proposal's path and destination;
   and no skill, prompt, threshold or configuration file was modified.
3. **Given** only thumbs-up or thumbs-down without notes, **When** the run reviews them, **Then**
   no model call is made and no proposal is written; the digest reports the tallies and their
   effect only.
4. **Given** feedback that was acknowledged in an earlier digest, **When** a later run reads the
   same post again, **Then** it is not acknowledged again; the digest lists only feedback not
   previously acknowledged, and a run that acknowledges nothing posts no digest.
5. **Given** a feedback record older than the influence window, **When** items are ranked,
   **Then** it no longer adjusts confidence, while it remains in the feedback file unchanged and
   is never purged.
6. **Given** notes written by named people, **When** the digest is posted, **Then** it names no
   person and contains no personal data.
7. **Given** proposals produced from feedback that nobody has adopted, **When** the weekly
   calibration report runs, **Then** it lists them with their age, so the reminder lives in one
   place and the feedback itself never expires.
8. **Given** two people who write in sequence about one item, the second correcting the first's
   horizon, **When** the next run reads the thread, **Then** the candidate is suppressed until the
   corrected horizon only, the two notes are reviewed together as one whole with at most one
   proposal, and the digest says for that item how the feedback was used: the exact lines it put
   into the project's analysis prompt, quoted, with a link to the run's trace, or the suppression it
   caused before analysis (FR-085, revision 29).

### User Story 8 - Alerts in the brief (Priority: P2)

The hosted watchdog already raises Grafana alerts (API server down, sentinel and outbound push
backlogs, conflicts, feedback rate, message delivery, fragmentation, replication limit, server
time, and whatever else operators provision). An engineer reading the brief wants to know which
alerts are firing right now, which are new, which have been firing so long that nobody is acting
on them, and which matter most, grouped so that fifteen alerts about one thing read as one line.
Over time the team wants a record of when each alert fired, what else was happening, and why.

**Why this priority**: the alerts are the existing monitoring stack's own judgement; a brief that
ignores them makes the reader open two tools.

**Independent Test**: record a day on which the hosted watchdog has firing alerts of several
rules across several projects, including some firing for weeks; run; verify the brief carries
grouped alert bullets with counts, staleness and working links, one thread reply per alert group,
an episode record per alert instance with its correlations, and that a day with no firing alerts
adds nothing.

**Acceptance Scenarios**:

1. **Given** alerts are firing when the run executes, **When** the brief is composed, **Then** one
   thread reply states per project group how many alerts fire, by category, how many are new and
   how many stale, with a link to that group's filtered alert list and one to every firing alert,
   for example "North Programme: 15 firing (disk usage 12, backlog 3), 2 new, 3 stale"; the post
   body carries no alert bullet, because the alerts are the monitoring stack's own notifications
   and the body is for what the analysis added (revision 28).
2. **Given** an alert has been firing longer than the configured staleness threshold, **When**
   the brief is composed, **Then** it is marked stale and counted separately from new and
   persisting alerts.
3. **Given** the reviewed alert policy assigns importance to rule titles, **When** the alerts
   reply and the report list them, **Then** critical alerts come first and unknown rules are
   reported as uncategorised with medium importance (alerts no longer compete with items for the
   body, revision 28).
4. **Given** alerts are numerous, **When** the brief is composed, **Then** the alerts reply
   summarises them per project group with counts and links only, and the full list with every
   instance is in the report's alerts section (revision 28; until then one reply per alert group
   listed the instances).
5. **Given** an alert started or cleared since the previous run, **When** the run completes,
   **Then** an episode record holds when it started and cleared, the expected-load window and any
   CHT version change in force at the start, the flagged items on the same project and metric in
   the same window, and the analysis's explanation when it produced one; episodes are appended to
   the knowledge corpus.
6. **Given** the alerting endpoints are unreachable, **When** the run executes, **Then** the brief
   notes that alerts were unavailable and the run otherwise completes.

### User Story 9 - Grouped briefing for programmes (Priority: P2)

Medic's hosted watchdog monitors projects that belong to programmes, for example a national
community health programme and a ministry deployment, plus development instances nobody wants in
the brief. A reader wants the body to say
"North: 5 projects with issues" with one line per project underneath, and never to see a `.dev`
host.

**Why this priority**: with dozens of projects a flat list of items hides the programme-level
picture, and development instances add noise.

**Independent Test**: declare two groups by host pattern and an ignore pattern in the project
annotations; run against recorded metrics with issues on several projects of one group and on a
development host; verify the group bullet with sub-bullets, the per-project thread replies, the
ignored host's absence from analysis and post, and the "Other" group for unmatched hosts.

**Acceptance Scenarios**:

1. **Given** `projects.yaml` declares groups by host pattern, **When** several projects of one
   group have flagged items, **Then** the body shows one bullet for the group, "North: 5 projects
   with 7 issues", with one sub-bullet per project for the three highest-ranked projects, each
   starting with the project written by code and covering every issue of that project in the
   model's words, and a last line counting the projects beyond three; the programme has no reply of
   its own when it is in the body, and a programme with two or more flagged projects that is not in
   the body gets one thread reply in the same form (revision 28; revisions 25 and 26 before it).
2. **Given** a host matches the ignore list, **When** the run executes, **Then** it is discovered
   and counted as ignored but neither analysed, nor charged for model usage, nor named in the post.
3. **Given** a host matches no group, **When** the brief is composed, **Then** it is reported under
   the group "Other".
4. **Given** more than two programmes qualify, **When** the brief is composed, **Then** at most
   two programme bullets appear in the body, each with at most three project lines of at most two
   lines, and the gate rejects a draft that exceeds any of these limits (revision 28; five slots of
   eight one-line sub-bullets until then).

### User Story 10 - An honest brief with metrics that mean something (Priority: P2)

*Proposed in revision 13 after the first hosted runs, accepted and planned in revision 14.* The first
complete preview run computed 2,058 candidates, lost every model session to a runtime error, and
published "no metric changes to flag". Its candidate list was also two thirds noise: counters and
clocks, which only ever rise, tripped the sustained-rise rule on every project, and five panels
were display duplicates of others.

**Why this priority**: a brief that can say "quiet" when the analysis did not run destroys trust
faster than a missed item; and a candidate list the model must sift for noise costs money and
attention every day.

**Independent Test**: replay a recorded day with the model engine failing for every project;
verify a degraded brief that names the failure and leads with the highest candidates. Replay a
recorded day and verify that counters produce rate-based candidates only, uptime resets produce a
restart candidate, clocks produce none, and duplicate display panels collapse into one metric.

**Acceptance Scenarios**:

1. **Given** candidates exist and every model session failed, **When** the brief is composed,
   **Then** it is the degraded brief from deterministic candidates, its notice names the failure
   and the number of projects affected, and the operator sees the same in the run record.
2. **Given** a metric is a monotonically increasing counter, **When** changes are computed,
   **Then** its candidate rules apply to its rate of increase, never to its level.
3. **Given** a metric is an uptime or a clock, **When** changes are computed, **Then** it raises no
   level candidate, and a drop in uptime raises a restart candidate for that project.
4. **Given** two panels differ only by a display comparison such as `>= 0`, **When** metrics are
   discovered, **Then** they are one metric in the analysis and the brief.

### User Story 11 - Correlation and consolidation (Priority: P2)

*Proposed in revision 13, accepted and planned in revision 14.* The on-call reader wants one message that
holds what a senior engineer would say after reading the alerts and the dashboards together: what
changed, on which projects, since when, whether it is one event across a programme, and what is
old news.

**Why this priority**: without it the brief is an alert roll-up with grouping, which Grafana can
send by itself.

**Independent Test**: replay a recorded day where the same alert fires on most projects of a
programme, an alert has fired for months on decommissioned hosts, and a project has both a firing
alert and a flagged metric; verify one programme-wide line, one housekeeping line, and one project
line that shows the alert and its metric together.

**Acceptance Scenarios**:

1. **Given** the same alert rule fires on a majority of a programme's projects within two days,
   **When** the brief is composed, **Then** the body carries one line for the programme naming the
   rule, the count and the window, and the thread lists the projects; no project is repeated.
2. **Given** a project has both a firing alert and a flagged metric in the alert's category,
   **When** its line is written, **Then** the line shows the alert, the metric's current value, its
   change and how long it has been abnormal.
3. **Given** alerts have fired for longer than the stale threshold on hosts with no data in any
   window, **When** the brief is composed, **Then** they appear once in a housekeeping line that
   suggests removing or silencing them, not in the body's news.
4. **Given** an alert cleared since the previous run, **When** the brief is composed, **Then** a
   resolved line names it.
5. **Given** several projects are flagged, **When** they are ranked, **Then** the number of
   connected users of each project is a ranking input, so the most-used projects come first.
6. **Given** a brief is rendered for Slack or in the report, **When** it is read, **Then** a small
   fixed set of emoji placed by code marks status and severity: the headline by kind, each item or
   programme line by its worst severity, alert lines with an alarm, and the resolved, housekeeping
   and new-project notices with their own marker; the model writes none of them.

### Edge Cases

- Metrics source unreachable or timing out: post a failure notice, exit non-zero, publish no
  partial brief.
- Slack unavailable after retries: persist everything, mark the run unposted, exit non-zero.
- Model output invalid or the verification gate fails a third time, after two returns to the
  analysis (FR-017): publish a degraded brief built from deterministic candidates only, with an
  explicit notice.
- The model session of a project fails before producing anything (the runtime exits, the schema
  is refused, the network is down): the failure is recorded on the pass with its message, counted
  as an `error` bound rather than a timeout, and named in the brief. When no project produced an
  item and candidates exist, the brief is the degraded one built from the candidates, never a
  "nothing to flag" headline (revision 13).
- Tracing cannot be flushed at the end of a run (credentials rejected, exporter unreachable): the
  failure is logged and the run's exit code is unaffected (revision 13).
- Tool loop, token or cost bound reached: stop, use what was gathered, say so in the post. The
  run budget is enforced across sessions: once it is spent no further session opens, and the brief
  names how many projects were analysed and how many were left out (revision 14).
- Second run on the same date: refuse unless explicitly forced; a forced run supersedes and
  links the earlier post.
- Fetched text (forum, documentation, issues, annotations, notes, corpus items) attempts to
  instruct the agent: treated as data; no item is ever created solely on the strength of such
  text.
- An item persists for many days: shown as "persisting N days", not re-explained daily. N counts
  analysed dates, so re-running one date does not raise it (FR-009, revision 21).
- Conflicting reactions from several people: all recorded, aggregate shown.
- Reaction removed: recorded as a retraction.
- A hundred projects: the run completes within its time budget; projects with no candidates
  incur no model usage; collection fetches only the current windows once the data volume is warm
  (FR-072, FR-074).
- The documentation search service is unavailable: analysis proceeds with skill and memory only,
  and the brief notes that reference sources were unavailable.
- A corpus item is enormous or binary: it is skipped with a note in the distillation report,
  never truncated silently.
- Dates are UTC; expected-load windows carry their own timezone in configuration.
- The classification call for notes fails: the digest still acknowledges the feedback with its
  tallies and effect, marks the notes as not yet classified, and the next run classifies them and
  names the late proposals in its own digest.
- Preview mode: the digest is part of the printed payload, nothing is posted, and no record is
  marked acknowledged, so the next real run acknowledges it.
- Slack unavailable when the digest would be posted: the run is already marked unposted (above)
  and the records stay unacknowledged for the next run.
- Reactions on a heartbeat post: acknowledged in the next digest as feedback on the brief.
- The alerting endpoints answer but Grafana's alert state history is not configured: episodes are
  built from the run's own daily observations (first seen, last seen), not from Grafana's history.
- An alert instance carries no `instance` label (a rule about the watchdog itself): it belongs to
  no project and is reported under a "Watchdog" group.
- A project is both flagged by the analysis and alerting: one bullet carries both; nothing is
  counted twice, and the alert episode links to the item.
- Hundreds of alerts fire at once: grouping keeps the body within its limits and the thread reply
  lists at most fifty instances per group, with the count of the rest.
- Every host is ignored or no host matches a group: the brief still names the counts.
- A panel expression uses a dashboard variable with no single value (a selection such as a
  database name): the metric is recorded as unavailable with the variable named, no query is sent,
  and the panel still counts as checked; a panel using an interval variable or a Grafana built-in
  time variable is collected with the value resolved by code (FR-071).
- One query times out or fails on a heavy expression while the source answers everything else:
  the window is unavailable after one retry, the metric and window are logged, and the run goes
  on; only a connection failure or consecutive query failures make the source unreachable
  (FR-073).
- The first runs, a gap in the runs, or a purged raw window: the missing comparison window is
  fetched from the source; the ledger is filled from the fetched trailing window, so the second
  run already builds its baseline locally (FR-072).
- A forced re-run of a date: its current window replaces that day's ledger entry; the comparison
  windows come from the latest run of each earlier date (FR-072).
- A panel groups by route or code, or ranks the top five: it is a breakdown, listed in discovery and
  left out of the metrics; its aggregate siblings (request rate, error share) are still analysed
  (FR-075).
- A plain selector returns several series for one project (a per-database gauge without the
  database pinned): every window of that metric is unavailable with the differing labels named;
  a sibling panel that pins the label is analysed as usual (FR-075).
- The command-line engine runs without `ANTHROPIC_API_KEY` on a machine where the runtime is logged
  in: the run uses that login and loads none of the operator's settings, rules, instruction files or
  memory; a blank key left by an environment file counts as unset; with the SDK engine the missing
  key remains a configuration error that names the alternative (FR-050).
- A forced re-run of a past date reads the alert state of the moment it runs: alert ages, episode
  events and durations are measured from the time the alerts were read, never from the re-run's
  date, so an alert that started after that date is simply new; a duration that would still be
  negative (clock skew between the source and the run) is recorded as zero and logged (FR-067).
- A model session is stopped by its budget or turn cap before any pass produced a result: the brief
  says so, with the count of projects and what was spent, and degrades to the computed candidates
  when nothing else was produced, instead of reading as a day with no metric changes (FR-067 for
  alerts, FR-012 for the bound, revision 16).
- The runtime answers a turn with a result it marks as an error (a model it cannot use, an
  authentication problem) rather than with structured output: the project's analysis fails with the
  runtime's own message, is not retried with a revision prompt, and the brief names the failure; it
  never reads as a quiet day (FR-058, revision 17).
- A model id is written with a dot or a capital (`claude-opus-4.8`): the configuration is rejected
  before anything runs, naming the form the API uses (`claude-opus-4-8`) (FR-051, revision 17).
- An alert group's thread reply would exceed one message block: it is fitted by code, never by
  cutting a link, keeping as many instances as fit, then naming fewer of a pattern's hosts with the
  count of the rest, then dropping the per-rule filtered links, then using links without the host
  filter (FR-066, revision 17).
- An alert instance's label names the host with a scrape port (`host:9100`): the port is not part
  of the host, so the instance joins its project and programme (FR-068, revision 17).
- An episode is open on a host the run now ignores: it is neither observed nor cleared, and never
  reported as resolved, because the run stopped watching it (FR-067, FR-068, revision 17).
- A run analyses only some projects (a `--project` or `--group` filter): a host whose scrape target
  discovery found down still counts as dead for housekeeping (FR-080, revision 17); the same helper
  resolves the filter in every stage (revision 24).
- A metric's collected windows are all unavailable but the metric is known: the dashboard reference
  is still built from the panel and window bounds recorded at discovery, because those are facts of
  the run, not of the data (FR-009, revision 18).
- An item's leading evidence names a window the run did not collect: the dashboard reference falls
  back to the current window, and the item is judged on its evidence as usual (FR-009, revision 18).
- The model's prose carries an unrounded computed value such as a trailing mean with many decimal
  places: it is a number, not personal data, and MUST NOT be reported as a phone number (FR-016,
  revision 18). A document or byte count of nine or more digits that equals a computed value for the
  item is likewise a number; a bare digit run that matches nothing computed is still a phone number
  (revision 22).
- The model's prose names a window by its identifier (`trailing_14d`, `14d`): it is the run's own
  name for a window, not an invented figure, and MUST NOT be reported as a number that matches no
  computed value (FR-016, revision 18). The same holds for the numeral alone ("the trailing 14
  days"), for a numeral inside a collected metric expression written out in prose, and for a
  collected panel's id ("panel 34") (revision 22).
- The model's prose quotes a number it read in its own session, an alert's days firing, the
  duration inside an expression's window, a count from a history entry: it is the run's own text
  read back, not an invented figure, and MUST NOT be reported as unmatched; a number found in
  neither the session's text nor the computed values still is (FR-016, revision 23).
- The model writes two decimals side by side ("0.00465 (0.01858 yesterday)"): the phone pattern
  spans both, but a run made only of decimal numbers, dates and times is a list of values, not a
  phone number (FR-016, revision 23).
- The model abbreviates a project's host to its leading labels to fit a bullet: it names that
  project and MUST NOT be reported as an undiscovered one; a bare domain or a single label names
  nothing (FR-016, revision 23).
- Every candidate of a project is a standing condition (an outbound push backlog above zero as
  yesterday, a host dark for the whole trailing fortnight): the project opens no session, code names the condition in
  the brief and lists it in the report, and the project is neither quiet nor incomplete (FR-013,
  FR-014, revision 23).
- A note cites `#7` under a forced re-run's post: the rank is resolved against that run's own
  ranked items, never against another run of the same date (FR-027, revision 23).
- The model writes "+27 jump" for a value that rose from 818 to 845, "roughly 3x" for 912 against
  300, or "-56%" for a fall it computed: each is a derived value of two numbers it may quote, and is
  not unmatched (FR-016, revision 24). A numeral that no pair of quotable values produces still is.
- The model writes a signed decimal ("+0.2748442279996993"): it is a value, not a phone number
  (FR-016, revision 24).
- A chronic outbound push backlog rose every scrape for 24 hours, as it does every day: the
  `monotonic` rule raises no candidate on a standing metric, and a `deviation` or `pct_change`
  candidate on it carries the floor those rules earn alone (FR-014, revision 24).
- A window kept from a stored run belongs to a metric discovery no longer marks analysable (a
  reference line): the analysis leaves it out, so yesterday's collection cannot bring today's
  excluded metric back (FR-075, revision 24).
- The report is opened by a reader who cannot reach the hosted watchdog: with
  `AGENT_WATCHDOG_REPORT_LINKS=none` it names panels, alerts and the trace and links nothing
  (FR-022, revision 24).
- A run analyses one project of ninety: the brief names that project's alerts and nothing else, the
  housekeeping and resolved lines cover only hosts it analysed, and the durable episode record is
  still updated for every project so the next full run is unaffected (FR-066, revision 19).
- A run analyses a subset and none of those projects has a firing alert: the brief says so for the
  projects it looked at rather than reporting the other projects' alerts (FR-066, revision 19).
- A reference tool the allow-list does not carry is refused: that is the design working, not a
  failure, so the brief MUST NOT say the reference sources were unavailable when another reference
  tool answered (FR-018, revision 19).
- The model asks a metric tool for a metric by the key the candidates and changes use, functions
  and label matchers included: the tool MUST accept it, since that is the key it was told to use
  (FR-018, revision 19).
- A quiet project's first pass is accepted with no items: no review pass runs, and the run records
  one pass rather than an unchanged second (FR-057, revision 19).
- A rule raises the same candidate every day and the analysis sets it aside every day, with nobody
  reacting in Slack: the weekly report counts those dismissals, names the commonest reason and may
  rest a threshold suggestion on them, saying that it did (FR-014a, revision 20).
- A person confirmed a candidate the analysis had set aside, or dismissed one it had surfaced: the
  person's verdict is the one that counts, and the analysis's own is not mixed in with it
  (FR-014a, revision 20).
- The analysis names a relation to a metric that is not another item of the same findings, or names
  its own metric: verification rejects it, and the item stands or falls on its own evidence
  (FR-009, revision 20).
- Two items of a run relate to each other, a level and the rate of change of the same thing: both
  are still ranked and posted as themselves; the relation is recorded, given to the roll-up and
  counted in the weekly report, and it does not change the five bullets (FR-009, FR-069,
  revision 20).

## Requirements *(mandatory)*

### Functional Requirements

Discovery and collection

- **FR-001**: The system MUST discover the set of monitored CHT projects from the hosted
  watchdog's metrics store on every run, without a hard-coded list.
- **FR-002**: The system MUST read metrics with a read-only credential and MUST NOT require write
  access to any monitored CHT system or to the metrics store. Its only writes are to the one
  configured Slack conversation (posts, the report share, reactions), to its tracing backend and
  to its own data volume (revision 27, the scope the constitution states).
- **FR-003**: The system MUST derive the metrics it examines from the dashboards in the configured
  priority list, in that order, and MAY examine additional metrics the analysis judges relevant.
- **FR-004**: For each metric and project the system MUST collect the current window and its
  comparison windows: the previous day, the same day of the previous week, and the same phase of
  the previous cycle when an expected-load window is active.
- **FR-005**: The system MUST collect scrape-target health and the CHT version for every project.

Analysis

- **FR-006**: The system MUST compute changes and baselines deterministically (percentage change
  per window, deviation against trailing history, sustained monotonic change) and produce
  candidate items before any model involvement.
- **FR-007**: The system MUST treat configured expected-load windows (month-end, sync weeks) as
  context that changes the comparison baseline, and MUST state an active window in its output.
- **FR-008**: The system MUST use the cht-watchdog skill, its own memory, the merged pattern
  cards, and the CHT documentation search service — which covers the documentation, the
  community forum, and GitHub issues and pull requests — as reference material. Reference lookups
  MUST be read-only. The curated memory, when read back into a session or a roll-up, is untrusted
  data like any fetched text (FR-044): delimited, labelled and never obeyed (revision 27).
- **FR-009**: Every flagged item MUST include: a stable identity, the project, a severity, metric
  evidence (values and windows), why it matters now, a suggested check, a structured reference to
  the dashboard view (dashboard, panel, project, window) from which the link is built, a
  confidence, the number of consecutive dates it has persisted, and the pattern card it matches if
  any. Persistence MUST be counted by code in analysed dates, not in runs: the consecutive dates
  immediately preceding this run's date whose ranked items contained this item, plus one, where
  the latest run of a date is the one that speaks for it and re-runs of a single date therefore
  count once (revision 21). The dashboard reference MUST be built by code from the item's metric
  and the window its leading evidence cites, never emitted by the model: the dashboard, the panel
  and the window bounds are all recorded by collection, so asking the model for them is asking it
  to compute what code already holds (constitution III, revision 18). An item MAY also record that
  it relates to another item of the same run and project, naming that item by its metric and the
  kind of relation, so a judgement the analysis already makes in prose survives as data the
  roll-up and the weekly report can use; code resolves the metric to that item's identity and
  verification rejects a metric that is not another item of the same findings (revision 20). An
  item related to a higher-ranked item of the same run and project is presented under that item:
  the report nests it, the higher item's thread reply names it with the relation and its rank,
  and, unless it is a high item itself, it takes no thread reply of its own (revisions 23 and 25). A relation
  that names the item's own metric is empty rather than wrong: code drops it when the items are
  normalised and the pass is not rejected for it (revision 24; one run's revisions carried 21 such
  reasons after a prompt sentence against it changed nothing).
- **FR-010**: The system MUST rank flagged items and place at most two programme bullets in the
  post body, the programmes of the two highest-ranked items; a bullet is one project line when the
  programme has one flagged project, otherwise a group line with one sub-bullet per project for at
  most three projects in rank order and a count of the rest (FR-069). Alerts take no body bullet
  (FR-066). Revision 28; five slots from revision 9, three before it.
- **FR-011**: Items MUST be produced in a machine-validated structure; output that fails
  validation MUST NOT be published.
- **FR-012**: Analysis MUST be bounded per run by maximum tool invocations, tokens and cost; on
  reaching a bound the run completes with what it has and says so.
- **FR-013**: A project with no candidate items MUST NOT incur model usage. A project whose only
  candidates are standing conditions (FR-014) MUST NOT incur model usage either: code names them,
  and a session spent on them adds nothing the reader does not already know (revision 23).
- **FR-014a**: A candidate the analysis examined and did not surface, with the reason it gave,
  MUST be usable as threshold evidence in the weekly calibration report, ranking below a human
  verdict: where a person has judged the same candidate that verdict decides, and a suggestion
  resting on the analysis's own dismissals MUST say so. The system MUST still propose rather than
  change (FR-032). Added in revision 20.
- **FR-014**: Severity levels and candidate thresholds MUST be configurable globally and per
  project. The system MUST NOT change them itself. It MUST compute, per project and metric, the
  observed distribution of changes and the confirmed and dismissed rate of past items, and MUST
  produce threshold suggestions as reviewable proposals that show the evidence and the effect on
  the last thirty days of items. Initial defaults: a candidate is raised on a change of 50% or
  more versus the previous day, a deviation of 2.5 standard deviations or more versus the
  trailing fourteen days, or a monotonic rise lasting six hours or more. Severities are low,
  medium and high; high is reserved for a scrape target down, an outbound push backlog above
  zero, or a sentinel backlog above three times its baseline. A high rule whose condition already
  held before today (an outbound push backlog above zero yesterday as well; a scrape target that
  read zero yesterday and throughout the trailing fortnight, since an outage in its second day is
  news and a host dark for weeks is not) is a **standing condition**: the candidate is still computed and
  recorded, but it is not handed to the model; code names standing conditions once per rule in the
  brief, grouped by programme with the count out of the programme's size and the largest value,
  and lists them per host in the report (revision 23, research.md R-28). A condition new today keeps
  its high floor and goes to the model as before. A standing rule MUST NOT set the floor of the other
  candidates on its metric, and the `monotonic` rule MUST raise no candidate on a standing metric,
  since a queue that never drains rises by definition; `deviation` and `pct_change` on a standing
  metric keep their candidates at the floor they earn without the standing rule (revision 24, after a
  run in which 42 of 43 high items were the chronic backlog through its `monotonic` candidates).
- **FR-015**: The brief is written for a technical operations audience: metric names as recorded
  in the metrics store, values with units and the comparison window, dashboard and panel names as
  they appear in the watchdog, PromQL where it helps the reader confirm; except in the body's
  sub-bullets and single-project bullets, which start with the project written by code and describe
  the change in words (FR-069, revision 26). Emoji are permitted as
  status and severity markers. At most two programme bullets, each with at most three project
  lines of at most two lines of 120 characters; the headline at most two such lines; these
  structural limits are checked by the verification gate (revision 28; five bullets of eight
  one-line sub-bullets until then). No separate writing or voice skill is applied. Numbers the report renders are rounded for
  reading: at most three decimals, and three significant figures below one, applied by code at render
  time to the values it formats, to long decimals inside an item's prose and to the notes on its
  evidence lines (revision 25); the stored item keeps the full value the gate verified (revision 24).

Analysis passes

- **FR-056**: The analysis of each project MUST run as a configurable number of passes, set
  through the environment with a default of one, a minimum of one and a hard upper bound in code
  (the default was two until revision 22, when measured review passes were found to change little
  at close to half the model spend, research.md R-27). A project whose first pass was rejected by
  the gate on every attempt MUST be named in the brief's incomplete-analysis notice with the
  commonest failing check, so it is never read as a quiet project (revision 22). The notice names
  the projects by host (up to three, then the count of the rest) and says in plain words what the
  check refused, for example "digits that looked like a phone number", never the check's code name
  alone (revision 25, after the notice appeared on every hosted brief and no reader could tell what
  it meant).
  The first pass produces items. Each later pass receives the previous pass's items and the
  candidates it did not select, re-examines the computed data, MAY ask the documentation service
  new or clarifying questions prompted by earlier answers, looks specifically for anything
  missed, and emits revised items with a recorded reason for every addition, removal or change.
- **FR-057**: Passes MUST share one session so earlier tool results remain available to later
  passes. Every pass runs the verification gate. Passes MUST stop early when a pass changes
  nothing material (same item identities, severities and values within display rounding) and
  MUST stop regardless when the run's cost or turn bound is reached. A review pass MUST NOT run
  when the accepted pass before it produced no items: there is nothing to review, and on a quiet
  project that is the common case (revision 19). A review pass MUST NOT be sent the candidates,
  computed changes or alerts again: the first turn of the shared session already carries them, and
  the review prompt says so (revision 22).
- **FR-058**: The run record MUST store each pass's items and the differences between passes,
  and the weekly calibration report MUST state how often later passes changed the outcome, so
  the pass count can be tuned on evidence. The record MUST also make a pass that the gate never
  accepted visible as such, since its items are discarded and the pass contributes nothing
  (revision 18). The weekly report MUST state, per project and metric, how many candidates were
  raised, how many became items and how many the analysis set aside with its commonest reasons, so
  a rule that raises noise every day is visible without reading a run (revision 20).

Verification gate

- **FR-016**: Before publication the system MUST verify every draft deterministically: the output
  validates against the schema; every project named is a discovered project; every number in the
  text matches the computed data for that project and metric within display rounding; every date
  and window matches the run; every link is built by the system from a structured reference or
  appeared in a reference-lookup result during this run, and resolves; the bullet count and
  length limits hold; no secret or personal-data pattern is present. A date is not a phone number.
  Findings in recorded tool results are reference text the model was given, not output the system
  wrote, and MUST be counted apart from findings in what the run produced, so a clean run reports
  none of its own (revision 19). The run's own identifiers are not figures the model invented: a
  numeral that spells a numeric part of a window name, appears inside a metric key or panel
  expression the run collected, or is the id of a collected dashboard panel MUST NOT be reported
  as a number that matches no computed value, and a run of nine or more digits that equals a
  computed value for the item MUST NOT be reported as a phone number, while one that matches no
  computed value still is (revision 22). A numeral that appears in the text the model was given in
  its session, its prompts and the results its tools returned, is not a figure it invented either
  and MUST NOT be reported as unmatched; for a brief bullet the given text is that item's own entry
  and the run-wide counts, never another item's, so a bullet cannot borrow a neighbour's number; a
  numeral found in neither the given text nor the computed values still is. A phone-shaped run
  whose parts are each a decimal number, a date or a time is a list of values, not a phone number.
  A host written as the leading labels of a discovered host, two labels or more, names that
  project and is not an undiscovered one (revision 23). A numeral equal, within display rounding, to
  the difference, the ratio or the percent change of two values the item may quote is a **derived
  value** the model computed correctly and MUST NOT be reported as unmatched: code verifies the
  arithmetic rather than forbidding it (revision 24; every one of one run's 127 refused numerals was
  such a value). A decimal with a leading sign is a value, not a phone number (revision 24).
  Revision 25, from a run whose refusals were traced one by one (research.md R-30): a comma joins
  digits into one numeral only as a thousands separator, groups of three after a first group of one
  to three digits, so `1789538400,390778880` in a tool result is two numbers the model was given
  and not one it never saw; the phone-number check MUST apply the same given-text exemption as the
  number check, so a byte count copied from the candidates or a tool result is never a phone
  number, and its reason MUST name the digits it refused so a revision can act on it; a numeral
  with a decimal point or a percent sign that rounds a numeral the model was given, within its own
  decimals, is that numeral (`2.48` for `2.484518`, `+32.7%` for `32.656`), and a percentage
  matches a computed or given percentage by magnitude because the direction is in the words around
  it; a numeral followed by a unit word (`7.5 days`, `24 hours`) carries that unit as the letter
  suffixes already do, and a metric whose key ends in `_seconds` holds seconds, so a duration the
  model converted matches; a range literal of a collected expression (`24h` from `rate(x[24h])`) is
  a run identifier when written bare; and the brief's gate is handed the run's candidates, so a
  cited candidate's value counts in a bullet as it does in an item.
  The checks are a closed list fixed in code and named in the data model ("Verification Report":
  `schema`, `projects_known`, `metrics_known`, `candidates_known`, `numbers_match`, `dates_match`,
  `relates_to`, `links_built`, `links_allowlisted`, `links_resolve`, `severity_rules`, `bullet_count`,
  `bullet_length`, `secrets_absent`, `personal_data_absent`, `pattern_cards_known`), as are the
  secret and personal-data patterns and the link allow-list; adding one is a code change by pull
  request. A link that times out or errors during resolution is unresolved and fails the check; a
  redirect is followed only when its target is on the allow-list, otherwise the link fails. Personal
  data means e-mail addresses, telephone numbers, person names known to the run (owners and
  feedback authors) and Slack user ids; hostnames are not personal data but are masked in
  proposals. The scan applies to every published text whatever its source: a secret or personal
  datum quoted from a tool result, a memory or a metric label is refused like one the model wrote
  (revision 27).
- **FR-017**: A draft that fails verification MUST be returned to the analysis with the reasons,
  at most twice; after that the run MUST publish the degraded deterministic brief with a notice.
  For the brief, every attempt MUST share one model session so the ranked items are sent once and
  cached, the return MUST name only the bullets that failed with their reasons, and the corrected
  draft MUST be assembled by code from the accepted bullets of the previous attempt and the model's
  rewrites of the failing ones before it is verified again, so a retry can only mend what was wrong
  (revision 23; on one day three drafts were each rejected on one or two bullets and the brief
  degraded, research.md R-28).
- **FR-018**: The same verification MUST run both inside the analysis (so the model can correct
  itself) and again immediately before publication, using the same code. A revision request MUST
  carry only the reasons of checks that failed; a check that passed MUST NOT contribute text to it,
  so every line the model is asked to act on is a real defect (revision 18). A reference tool the
  allow-list does not carry MUST NOT be presented to the model as available, and its refusal MUST
  NOT be reported as the reference sources being unavailable. Each run MUST log how its tools were
  used, per project and per run, counting calls by tool with their failures and refusals, so a tool
  whose contract no longer matches what the model is told shows up without reading the record
  (revision 19).

Publishing

- **FR-019**: The system MUST post one message per run to the configured Slack channel containing
  a headline shown in full (a bold section, never Slack's 150-character header block, which cut
  one run's headline mid-word; the gate holds a headline to at most two lines of 120 characters,
  revision 28), at most two programme bullets (FR-010), and a footer identical to the report's (revision 25):
  a link to the feature's specification (`specs`, which replaced the prompts link), a link to the
  deployment configuration, a link to the run's trace, the run's cost in currency and the run id,
  followed by the count of items only in the report. The brief image (a screenshot of the report's
  summary, uploaded privately and shown as an image block) was retired in revision 24: the report
  shared into the thread is the artefact a reader opens, and the image was a picture of the message
  it sat under.
- **FR-020**: The thread under the post MUST hold, in order: the report share (FR-022); one reply
  per programme not in the body that has two or more flagged projects, in rank order, each in the
  body's form (the programme line, at most three project lines, the count of the rest); one "Other"
  reply for every remaining project, ungrouped hosts and single-project programmes alike, in the
  same form; and one alerts reply (FR-066). No item has a reply of its own: every item is in the
  report, where a note cites it by rank (`#12 👍`), and the parent's footer says how many items are
  only there (revision 28: the thread is three or four replies a person can read). History: every
  item had a reply until revision 23 (159 under one post, research.md R-28), body items from 23 to
  24, high items in 25 to 27.
- **FR-021**: On a quiet day the system MUST post a one-line heartbeat stating what was checked.
- **FR-022**: The system MUST render a one-page report per run containing every flagged item and
  evidence charts drawn from the collected data, and store it with the run. The report MUST number
  every item by its rank and show its identity, list the standing conditions per host (FR-014) and
  nest related items under the item they relate to (FR-009), and MUST be shared into the post's
  thread as its first reply with a code-built comment that states how many items it holds, how
  many have replies, and how to cite an item in a note (`#<rank>`, or its host and metric) with a
  thumbs as the verdict (revision 23). The report is the document a reader opens (revision 24): it
  MUST list the alert groups the brief covered, and every reference in it to a dashboard panel, an
  alert list, the prompts, the configuration or the trace MUST be a link built by code from the same
  structured references as the thread replies, or a name alone, according to one setting
  (`AGENT_WATCHDOG_REPORT_LINKS`, `internal` by default, `none` for readers without access to the
  hosted watchdog, which a later story of per-project or per-programme reports will need); the model
  never writes a link. Its footer MUST carry the specification, configuration and trace links, the
  cost, the run id and the citation line, and the Slack post's footer is the same line (FR-019). Its
  layout is the original design (revision 25): the revision-24 redesign under a design skill was
  tried on one hosted run and set aside, the operator preferring the original's directness. An
  item's header names its rank as a number, its severity, host, metric and persistence, with its
  identity set apart at the end, and never repeats the rank in words; the confidence stands on a
  line of its own beneath the rank. Evidence keeps the window names as the run records them. The
  wording of items is the model's and is not restyled.
- **FR-023**: Retired in revision 24: the brief image, a screenshot of the report's summary, is no
  longer rendered or posted (see FR-019); no run uses a browser.
- **FR-024**: On failure the system MUST post a one-line failure notice with the trace link and
  exit non-zero. The notice is code text, never model output, so it does not pass the verification
  gate; the error message it quotes MUST be passed through the secret and personal-data patterns
  first, with any match redacted (revision 27).
- **FR-025**: In preview mode the system MUST produce every artefact of a real run and emit the
  exact message payload (post, thread replies, report share) as structured data instead of
  posting.

Feedback

- **FR-026**: At the start of each run the system MUST read reactions and thread replies from the
  posts of the previous N runs, N configurable with a default of seven.
- **FR-027**: The system MUST map thumbs-up and thumbs-down to items by stable identity, and notes
  to items by explicit reference; unmatched notes MUST be recorded as such. An explicit reference
  includes `#<rank>`, resolved against the ranked items of the run whose post the note sits under
  and tried before the item id, host and metric; a thumbs-up or thumbs-down written inside a note is
  that note's verdict and counts like a reaction on the item it cites; a thumbs that cites no item
  stays unmatched (revision 23).
- **FR-028**: The system MUST persist each piece of feedback with date, item identity, verdict,
  note and author, in an append-only record that is never purged (FR-059).
- **FR-029**: Feedback MUST influence subsequent runs: repeatedly dismissed patterns rank lower,
  confirmed patterns rank higher, and notes that state an expectation are honoured until their
  stated horizon, which is the horizon an item's thread states last when several notes state one
  (FR-085, revision 29). Ranking influence counts only records within the configured influence window
  (FR-060). The feedback read that day, with author identifiers removed, MUST be part of the
  roll-up's context so the memory update can reflect it (User Story 2, scenario 1).
- **FR-030**: Confirmed and dismissed items, with their notes, MUST be appended to the knowledge
  corpus as run outcomes so that distillation learns from operation as well as from history.

Feedback review and acknowledgement

- **FR-059**: Feedback records MUST be kept permanently in the append-only feedback file; no
  retention setting removes or compacts them. Run records and raw series keep their FR-040
  periods.
- **FR-060**: Feedback MUST adjust ranking only within an influence window, configurable
  (`AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS`, default 30 days) with a hard cap in code; a horizon
  stated in a note is honoured until its date regardless of the window; the history the analysis
  can read and the corpus outcomes are unaffected by the window.
- **FR-061**: Each run MUST review the feedback it read that day. Reactions are tallied by code
  and never sent to the model for classification. The notes left on one item are read together in
  thread order and classified by one bounded, schema-validated model call as the clarified whole
  (FR-085, revision 29; a note matched to no item is classified alone) into one of: expectation or
  horizon (already handled by FR-029),
  project annotation, skill, prompt, threshold, pattern card, or no reusable lesson. Every
  classification other than the first and the last MUST produce a proposal (FR-032, FR-033) that
  names its destination and states the lesson in pattern-level terms; the system MUST NOT apply
  it. A project-annotation proposal MUST carry a ready-to-paste `projects.yaml` fragment (notes,
  a threshold override or an expected-load window) with a short rationale; the host it concerns
  is flagged for the reviewer as any identifier is.
- **FR-062**: The system MUST acknowledge feedback with at most one digest reply per run, posted
  in the thread of the brief or heartbeat published that day and built by code from structured
  fields: per item the effect applied today, the proposals written with destination and path,
  and one statement that the records are kept permanently at their path and influence ranking
  for the configured window. Since revision 29 it also says, per item, how the feedback was used
  (FR-085): the exact lines it put into the project's analysis prompt, quoted, with a link to the
  run's trace; or the suppression it caused before analysis; or that it was not used today. The
  digest MUST name no person, MUST acknowledge each record once
  (the acknowledgement is stored on the record with the run that posted it), MUST be part of
  the preview payload, and MUST be omitted when there is nothing new to acknowledge. Notes that
  could not be matched to an item are listed in the digest for a human to clarify, which replaces
  the separate unmatched-notes reply (User Story 2, scenario 4). On a quiet day the digest goes in
  the heartbeat's thread. After posting the digest, the system MUST add
  one `eyes` reaction to each note it acknowledged as a "seen" signal (Slack scope
  `reactions:write`); a failed reaction is logged and never fails the run, and no reaction is
  added in preview mode.
- **FR-063**: The weekly calibration report MUST list every proposal still awaiting review, with
  its age in days and its destination.

Alerts and groups

- **FR-064**: Each run MUST read the Grafana-managed alert rules and their firing instances from
  the hosted watchdog with the same read-only credential used for metrics, recording per instance
  the rule, the project (from the `instance` label), the state and since when it has fired. When
  the alerting endpoints are unavailable the brief MUST say so and the run MUST complete.
- **FR-065**: Alerts MUST be classified by code: category and importance from a reviewed policy
  file (`alerts.yaml`, keyed by rule title; unknown rules are medium and reported as
  uncategorised), newness against the previous run, and staleness after a configurable number of
  days firing (default 14). Initial importance: critical for API Server Down; high for Sentinel
  Backlog, Outbound Push Backlog and Message Delivery Rate; medium for DB Conflicts Rate, Client
  Feedback/Error Rate and Users Over Replication Limit; low for DB Fragmentation and Server Time
  Accurate.
- **FR-066**: The brief MUST summarise firing alerts in one thread reply: per project group the
  firing count with its categories, the new and stale counts, and a code-built link to that group's
  filtered alert list, then one link to every firing alert; the alert-derived notices (housekeeping,
  resolved since the previous run, alerts unavailable) close that reply. Alerts take no body bullet
  and no longer rank against items: the body is for what the analysis added over the monitoring
  stack's own notifications, and the instances are listed in the report's alerts section (revision
  28; until then each alert group had a body bullet and a reply of its own with its instances, fitted
  into one block, revision 17). When a
  run analyses only some of the discovered projects, the brief MUST cover only those: alert
  instances on projects it did not analyse are left out of the groups, the counts, the patterns and
  the notices, because the reader asked about those projects and cannot act on the rest. Collection,
  the classified alert record and the durable episodes stay whole regardless, so the next full run
  still sees the same newness and no episode appears to have cleared. A thread reply MUST describe
  the same alerts as the bullet above it, so what the brief covered is recorded for the publish step
  rather than derived a second time (revision 19). A run MAY be restricted by project (`--project`)
  or by programme (`--group`, every discovered project of a group label), and every stage and the
  presentation scope MUST resolve the restriction through one helper so they agree on the set
  (revision 24); the post still goes to the one configured channel. What the brief and the report
  say was checked MUST count the projects the run analysed, not every project discovered, so a
  restricted run never reads "Checked 90 projects" over 30 (revision 25).
- **FR-067**: The system MUST keep a durable episode per alert instance: rule, project, category,
  when it started and cleared, its duration, and correlations computed by code (the expected-load
  window active at the start, a CHT version change within a day of the start, flagged items on the
  same project and a related metric in the same window). The analysis pass receives the project's
  firing alerts as context; an item that explains an alert is linked to the episode as its
  explanation. Episodes are appended to the knowledge corpus as run outcomes are. Episode times and
  alert ages are measured from the time the alerts were read, and a duration is never negative
  (revision 16).
- **FR-068**: `projects.yaml` MUST support project groups (a label and host patterns) and an
  ignore list of host patterns. Ignored hosts are discovered and counted but MUST NOT be analysed,
  incur model usage or be named in any post. Hosts matching no group belong to "Other".
- **FR-069**: When a group has more than one flagged project, the body MUST show one bullet for the
  group naming the count, with one sub-bullet per project item in rank order; a group with one
  flagged project shows that item as today. Every sub-bullet MUST start with its project, written by
  code from the item's host as the host's first label (`north-a: `), or two labels when two projects
  of the group share the first; a single-project bullet starts with the full host the same way. The
  model writes what follows: the change in words a technical reader can act on, with its values,
  without metric keys or PromQL, which the report carries; the prompt tells it the project is
  written for it and the characters it has left, and the length check counts the prefix. A project
  the model names anyway at the start of its line is not written twice (revision 26, after one run's
  sub-bullets read as raw metric expressions with no project). One line per project (revision 28):
  when a project has several flagged items the line covers all of them in at most two lines, the
  prompt names every item the line must cover and the gate allows every one of their values; a
  programme shows its three highest-ranked projects and counts the rest, in the body and in its
  thread reply alike (FR-020).
- **FR-070**: Links to alerts MUST be built by code from the collected rule definitions and labels
  to the watchdog's alert list, and MUST pass the same allow-list and resolution checks as
  dashboard links.
- **FR-071**: Panel expressions MUST reach the metrics source as valid queries: the instance
  variable resolves to the project host, a dashboard's own variables to their single configured
  value, and Grafana's built-in time variables to the window being collected. A metric whose
  expression depends on a variable with no single value MUST be recorded as unavailable, naming
  the variable, without a query being sent. Baseline queries over a window MUST be valid for any
  panel expression, not only for bare series selectors. Added in revision 10.
- **FR-072**: Collection MUST fetch from the metrics source only what the data volume does not
  already hold for the run's windows. The current window is fetched every run. The previous-day,
  previous-week and previous-cycle windows MUST be taken from the stored current windows of the
  runs one, seven or one cycle of days earlier when a stored window exists with exactly the same
  bounds, step and metric. The trailing baseline MUST be built from a per-project ledger of daily
  maxima that every run extends from its current window, once the ledger holds enough days; a day
  the volume lacks is fetched from the source as before, and a fetched trailing window fills the
  ledger. Every run still writes its complete windows, each marked with its source (`fetched`, the
  stored run it came from, or `ledger`), so replay stays self-contained (FR-041). Added in revision 11.
- **FR-073**: A single query that fails or exceeds its timeout MUST make only its window
  unavailable, after one retry, and the log MUST name the metric and window. The run MUST treat the
  metrics source as unreachable (failure notice, non-zero exit) only when the source cannot be
  connected to or when queries fail consecutively. Range and instant queries MUST have their own
  timeout, distinct from the timeout of the Grafana API calls. Added in revision 11.
- **FR-074**: Collection MUST run projects concurrently within the configured project concurrency
  bound, log per project what was fetched and what was reused, and complete within its share of
  the run budget at the scale assumption of one hundred projects. Added in revision 11.
- **FR-075**: A per-project metric is one series per project. A panel whose expression yields one
  series per label value (grouped by anything but the histogram bucket) or a ranked set MUST be
  recorded in discovery with its grouping and MUST NOT be collected or analysed; a query that
  returns several series for a project MUST make that window unavailable, naming the labels that
  differ, rather than have one series chosen over the others. Breakdown analysis per route, code or
  database is a later feature (Out of Scope). Added in revision 12. A **reference line**, a target
  after the first on a panel with several targets whose expression is another series adjusted only
  by constant arithmetic (a threshold drawn from the connected-user count, an expected rate drawn
  from the write rate), MUST likewise be recorded in discovery with its subject and source and MUST
  NOT be collected or analysed: it repeats a series the run already holds, scaled (revision 23; six
  such targets produced 161 of one day's 1,189 candidates and two low items, research.md R-28). The
  collection's query list and the analysis MUST both take their metrics from what discovery marked
  analysable, so a window kept from a stored run cannot bring an excluded metric back (revision 24,
  after the exclusion held in discovery and not in collection).
- **FR-076**: Each metric MUST be analysed according to its kind, declared in the reviewed
  thresholds policy (`metric_kinds`) by metric name, with the stock CHT metrics as the default: a
  gauge as a level; a counter as its increase over each window, its trailing baseline as daily
  increases, and never by the sustained-rise rule; an uptime as restarts, where a fall below half
  the previous sample is one restart and raises a medium candidate; a clock as excluded from every
  rule. An expression built with functions or arithmetic is a gauge, since its author already
  derived the quantity. Every computed change MUST record its kind and aggregate, and evidence
  drawn from a counter MUST say it is an increase. Added in revision 14.
- **FR-077**: Two panels whose expressions differ only by a display comparison that keeps zero
  visible (`>= 0`) MUST be one metric in discovery, analysis and the brief. Added in revision 14.
- **FR-078**: When one alert rule fires on at least three projects of a programme, on at least half
  of them, with first occurrences within two days, the brief MUST present it as one programme-wide
  event: the report's alerts section names the rule, the count out of the programme's size and the
  first day, and lists the projects once (revision 28; until then the category line and the group's
  thread reply carried it). Added in revision 14.
- **FR-079**: Every alert instance MUST carry, when one exists, the computed change of the metric
  that its category names for its project (the metric, its current and previous-day values, the
  change), shown next to the alert in the report's alerts section (in the thread until revision
  28); the item reply that named a firing alert of its project was retired with item replies
  (FR-020, revision 28). Added in revision 14.
- **FR-080**: A stale alert on a host whose scrape target was down for the whole current window is
  housekeeping: left out of the alert groups and counts and named once in a housekeeping notice
  that suggests removing the host from the watchdog or silencing the rule; the housekeeping and
  resolved notices close the alerts reply rather than the post body (revision 28). The same notice MUST
  name, once, every host whose scrape target read zero for the whole current window, on the
  previous day and throughout the trailing fortnight (a dark host), whether or not an alert is
  stale there, so no session is spent describing a host dark for weeks (revision 23). An episode open in the
  durable record whose instance no longer fires MUST be named in a resolved notice with how long it
  fired. Added in revision 14.
- **FR-081**: The number of connected users of a project MUST be a ranking input for its items:
  within a severity, an item on a project with ten times the users ranks first; confidence and
  persistence order items within the same order of magnitude. Added in revision 14.
- **FR-082**: Emoji MUST be placed by code alone, from a fixed vocabulary, when the brief is rendered
  for Slack or in the report: the headline by kind, item and programme lines by worst severity, alert
  lines with an alarm, the notices by what they say. Stored texts and the model's output carry none.
  Added in revision 14.

Memory, proposals and the knowledge corpus

- **FR-031**: The system MUST maintain a curated memory, capped in size, that is available to every
  analysis; every change to it MUST be stored as a diff alongside the run.
- **FR-032**: The system MUST write skill, prompt and threshold improvement proposals as files for
  human review and MUST NOT modify prompts, tools, skill content or thresholds itself.
- **FR-033**: Proposals MUST be pattern-level and MUST NOT contain project identifiers or personal
  data; the system MUST flag any that do.
- **FR-034**: The system MUST provide a knowledge corpus directory into which maintainers place
  raw material (conversations, data exports, incident notes, component explainers) with no
  required format beyond plain files.
- **FR-035**: The system MUST provide a distillation step, runnable on demand and on a schedule,
  that processes only new or changed corpus items and produces pattern cards in a fixed
  structure: symptom, metrics involved and shape of change, appearance in the watchdog, root
  cause, resolution, confirmation steps, known false positives, and source items.
- **FR-036**: Pattern cards MUST be delivered as proposals for review, scrubbed of identifiers,
  and MUST NOT reproduce raw corpus content.
- **FR-037**: Raw corpus material MUST be storable outside the public repository, and the public
  repository MUST contain only reviewed pattern cards and the corpus index.
- **FR-038**: The daily analysis MUST load a short index of merged pattern cards and read a full
  card only when relevant, so corpus growth does not increase the fixed cost of every run.

Persistence and reproducibility

- **FR-039**: For every run and project the system MUST persist the collected inputs, computed
  changes, candidates, items, verification results, published-message references, usage and
  cost, and the code, prompt and configuration versions.
- **FR-040**: The system MUST NOT retain raw metric series longer than a short configurable
  period, because the hosted watchdog is the source of record; computed changes, candidates,
  items, feedback and memory — the inputs the model saw — MUST be retained for the long period.
  Feedback records are exempt from retention and kept permanently (FR-059). Defaults: 14 days
  for raw series, 30 days for everything else (rendered images, retired in revision 24, shared the
  short period).
- **FR-041**: The system MUST support offline replay of any stored run from its retained inputs;
  replay MUST NOT contact the metrics source or Slack.
- **FR-042**: Runs MUST be idempotent per date; a second run on the same date MUST require an
  explicit force flag.
- **FR-043**: Each stage MUST be runnable on its own from the files of the previous stage.

Security and trust boundaries

- **FR-044**: All externally fetched text MUST be treated as untrusted data: delimited and
  labelled when shown to the model, never executed as instructions, escaped when rendered. Text
  that itself contains the delimiter is stripped of it before it is wrapped, so fetched content
  cannot close the delimiter early. Proposal files are Markdown for a human reviewer, scrubbed of
  identifiers by code (FR-033); the preview payload is JSON built by code, so neither needs
  template escaping (revision 27).
- **FR-045**: Secrets MUST NOT appear in posts, run records, logs or the public repository. Run
  records include every prompt, tool result, session ledger and verification report the run
  stores, which the end-of-run scan covers with the same patterns as the gate; logs redact the
  values of secret-named keys and never carry the model runtime's raw transcript (revision 27).
- **FR-046**: The tools available to the model MUST be read-only and enumerated: the run's own
  `get_windows`, `query_metric`, `read_pattern_card` and `get_item_history`, and the documentation
  service's `search_docs` and `get_sources` (its `ask_question` is denied by default so provenance
  stays first-hand; contracts/agent-definition.md). The
  documentation service is one enumerated tool over a fixed corpus, not web access. The model has
  no shell, no HTTP tool and no tool that writes or executes anything; the system, not the model,
  writes the run's files, and only under the current run's directory and the data volume (revision
  27, replacing wording that read as if the model could write files).

Operations

- **FR-047**: The system MUST run once daily at a configured time and MUST prevent overlapping
  runs. Defaults: the run starts at 06:00 UTC and posts to the `#agents` Slack channel as the
  bot named `agent-watchdog`.
- **FR-048**: The system MUST provide a readiness check for a CHT URL that reports unmet
  prerequisites (minimum supported version, host-metrics exporter present) in plain language.
- **FR-049**: The system MUST record one trace per run with a span per stage and usage per model
  call, and MUST reconcile the runtime's cost estimate with recorded usage.
- **FR-050**: The same agent definition — skill, tools, reference sources, prompts, output schema
  and verification hooks — MUST be usable both by this system's scheduled run and by a
  contributor invoking the agent runtime directly, from one configuration source. When no API key
  is configured, the contributor's face MUST run on the contributor's own runtime login while
  loading none of the contributor's settings, rules, instruction files or memory; the scheduled run
  authenticates with the key (revision 15).

Configuration

- **FR-051**: Per-environment scalar settings MUST be settable through environment variables with
  documented defaults: model, effort level, per-stage model overrides, cost and turn bounds,
  timeouts, endpoints and identifiers (metrics source, Slack channel, documentation service,
  tracing backend, footer links), storage paths, retention periods, feedback look-back, memory
  cap, analysis pass count, engine selection, log level and format, and preview mode. Pricing the
  review passes apart from the first is deferred: both engines bind the model when the session
  opens, so a second model means a second session, and FR-057 requires the passes to share one so
  earlier tool results stay available (revision 19).
- **FR-052**: Secrets MUST be supplied only through the environment, never through configuration
  files or the run record.
- **FR-053**: Structured, reviewed policy — project annotations, dashboard priorities, thresholds,
  expected-load calendar, prompts, output schema — MUST live in versioned configuration files,
  not in environment variables.
- **FR-054**: Safety rails — the tool allow-list, disabled shell and web access, permission
  handling, the verification gate, and the hard upper bounds in code on turns, cost, passes,
  retries and concurrency — MUST NOT be configurable at runtime; the environment may set a value
  only below those bounds (revision 27).
- **FR-083**: Network egress from the container MUST be restricted to the enumerated endpoints:
  the hosted watchdog's Grafana, Slack, the model API, the tracing backend, the documentation
  service, and the hosts of the footer's specification and configuration links for the gate's link
  resolution; every other destination is refused (revision 27, promoted from the plan; the
  container revision enforces it).
- **FR-084**: The Slack app MUST hold exactly the bot scopes the posting needs: `chat:write`,
  `files:write`, `reactions:read`, `reactions:write`, `channels:history` for a public channel,
  `groups:history` if the channel is private, and `im:write` with `im:history` when the configured
  conversation is a direct message. The bot's membership of the configured conversation is a
  deployment precondition: a post refused for it fails the run loudly (exit 74) with the reason in
  the log, never silently (revision 27).
- **FR-085**: Feedback on one item from several people in sequence MUST be read together, in thread
  order, so a later note that clarifies or corrects an earlier one is applied as the clarified
  whole, not as two contradicting notes; and the next run MUST tell the authors how their feedback
  was used: the digest names the item, quotes the exact lines the feedback put into that project's
  analysis prompt and links the session's trace where those lines can be seen, so a reader can
  follow a note from the thread to the point in the pipeline where it acted. Specified in revision
  28 after the operator asked for it; implemented in revision 29: the horizon applied to an item is the
  last one its thread states, the notes of one item are reviewed in one call as the clarified whole,
  and the digest carries each item's provenance (User Story 7, scenario 8).
- **FR-055**: Precedence MUST be command-line flag, then environment variable, then configuration
  file default. All settings MUST be validated at startup, failing fast on an invalid or missing
  value, and the effective values with secrets redacted MUST be written to the run record.

### Key Entities

- **Project**: a monitored CHT deployment, identified by its URL as recorded in the metrics
  store; optionally annotated in configuration with owner, notes, thresholds and expected-load
  windows.
- **Run**: one scheduled or manual execution for one date; owns its inputs, changes, candidates,
  items, verification results, publications, usage, cost and version stamps.
- **Metric Window**: a metric's values over a named period (current, previous day, previous week,
  previous cycle, trailing baseline) for one project, marked with where the values came from:
  fetched, a stored earlier run, or the ledger.
- **Daily Maxima Ledger**: per project, one number per metric per day, the maximum of that day's
  current window; extended by every run and the source of the trailing baseline once it holds
  enough days; entries older than the kept retention period are compacted.
- **Candidate**: a deterministic flag on a metric window that exceeded a threshold or showed a
  sustained trend; input to analysis.
- **Item**: a finding the analysis chose to surface; carries a stable identity derived from
  project, metric and pattern so it can be tracked across days.
- **Verification Report**: the result of the gate for one draft — each check, pass or fail, with
  reasons.
- **Brief**: the published post for a run: headline, up to five bullets each with optional
  sub-bullets, the report shared into its thread, footer.
- **Thread Reply**: the per-item message that carries reactions; alert groups have one too.
- **Project Group**: a programme such as North Programme or South Programme, declared by host patterns in
  the project annotations, plus "Other" for unmatched hosts and "Watchdog" for alerts without a
  project.
- **Alert Rule**: a Grafana-managed rule provisioned on the hosted watchdog, with the category and
  importance the reviewed alert policy assigns to its title.
- **Alert Instance**: one firing evaluation of a rule for one project, with its state and start.
- **Alert Episode**: the durable record of one instance from start to clear, with the correlations
  computed for it and the explanation the analysis produced, if any.
- **Feedback**: a verdict (up, down, retracted) or note from a named person about an item or a
  brief, dated; kept permanently; carries the run that acknowledged it and, for notes, its
  classification and the proposal it produced.
- **Feedback Digest**: the once-per-run thread reply that acknowledges new feedback, states its
  effect and names the proposals written from it.
- **Memory**: the agent's curated, size-capped notes, versioned by diff.
- **Proposal**: a suggested change to the skill, a prompt, a threshold, a project annotation or
  a pattern card, awaiting human review.
- **Corpus Item**: a raw file placed in the knowledge corpus, tracked by content hash and
  distillation status.
- **Pattern Card**: a reviewed, structured description of a recurring watchdog pattern, cited back
  to its corpus items.
- **Calibration Report**: per project and metric, the observed distribution of changes and past
  item outcomes that justify a threshold suggestion.
- **Expected-Load Window**: a configured period (month-end, sync week) with a note and timezone
  that alters baselines.
- **Priority List**: the ordered dashboards and panels the analysis examines first.
- **Cost Record**: token usage and currency cost per model call, summed per run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On every scheduled day exactly one of brief, quiet-day heartbeat or failure notice
  is posted; measured over any 30-day window this holds on at least 99% of days.
- **SC-002**: In the first 60 days no more than 30% of flagged items receive a thumbs-down without
  a thumbs-up, and the rate falls month over month. The rate is measured from the run outcomes
  appended to the knowledge corpus (FR-030), which fall outside the FR-040 retention limits.
- **SC-003**: Feedback left on day N is reflected in day N+1's memory and ranking every time,
  verified by replay.
- **SC-004**: Zero published numbers, project names or links fail verification; every published
  brief has a stored verification report with all checks passing or an explicit degradation
  notice. The report is the gate's own record; the replay evaluation over the committed fixtures
  is the independent oracle, and a manual sample of published items against the stored windows is
  part of each calibration review (revision 27).
- **SC-005**: Cost per run is visible on every post from day one; after the first two weeks of
  measured runs a target is set and thereafter the 30-day median stays within it.
- **SC-006**: A maintainer can replay thirty days of stored runs against a changed prompt in under
  ten minutes without touching production.
- **SC-007**: A contributor can run the full pipeline in preview mode on their own machine and
  obtain the would-be post as structured data, with the same artefacts a production run stores.
- **SC-008**: A project newly added to the hosted watchdog is analysed in the next run and named
  in that brief.
- **SC-009**: A new corpus item becomes a reviewable pattern card within one distillation cycle,
  and a merged card is referenced by name in the next run that flags a matching item.
- **SC-010**: Zero secrets or partner personal data appear in posts, run records, proposals or the
  public repository, verified by an automated check on every PR and every run.
- **SC-011**: From a brief, a reader reaches the configuration that reorders priorities in two
  clicks or fewer.
- **SC-012**: Every reaction and note left on a brief is acknowledged in the next run's digest,
  exactly once, verified by replay on recorded feedback.
- **SC-013**: A feedback record left on day N is present and unchanged in the feedback file on
  day N+365, verified by a retention test; no purge setting can remove it.
- **SC-014**: Every alert firing on the hosted watchdog at run time appears in that day's brief
  body or thread, grouped, with a link that resolves, verified by replay on recorded alert
  fixtures.
- **SC-015**: No published body exceeds five bullets, two lines per bullet or eight sub-bullets per
  bullet, verified by the gate report of every post.
- **SC-016**: With a warm data volume, a run over one hundred projects fetches one range query per
  metric per project and no trailing query, verified by query counts against the fake watchdog; a
  single failed query never fails a run, verified by test; the hosted collection stage completes
  within fifteen minutes at the default concurrency, read from the stage timings of the run record.

## Assumptions

- Medic's hosted CHT Watchdog scrapes every participating project into a single metrics store,
  and the project URL is available as a label on every metric.
- The monitoring endpoints it scrapes are public and carry no patient data (if a label value ever
  carries one, it reaches no post: metric keys and labels are published text and pass the
  personal-data scan like any other, FR-016); host metrics exposed
  by partners likewise carry no health data.
- A dedicated Slack channel and app exist for the brief; readers of that channel are Medic staff.
- The CHT documentation search service (cht-docs-mcp, kapa-backed) indexes the documentation, the
  community forum and the GitHub issues, pull requests and files of the relevant CHT repositories;
  Medic is adding the cht-watchdog repository so its issues and discussions are searchable.
- The cht-watchdog skill, including its voice rules and pattern-card index, is developed alongside
  this feature in the same repository.
- Expected-load window definitions are supplied by the hosting team from existing operational
  notes.
- Contributors running the agent themselves hold their own model credentials and their own
  watchdog read access.
- Development instances of the hosted watchdog are recognisable by host pattern (`*.dev.*`,
  `*-dev.*`); programme membership is likewise a host pattern, with placeholders until the real
  patterns are set by the hosting team.

## Dependencies

- Read-only access to the hosted watchdog's metrics store.
- The cht-watchdog skill (same repository).
- The CHT documentation search service (cht-docs-mcp) with the watchdog repository added as a
  source.
- Deployment configuration, secrets and scheduling in `medic-infrastructure`.
- A tracing backend and a Slack app with permission to post, upload, read reactions and read
  thread replies in one channel.
- Grafana-managed alerting on the hosted watchdog, readable with the same Viewer service-account
  token as the metrics; which alerting endpoints that role can read is verified before
  implementation (User Story 8).

## Out of Scope

- Emails or any output to partners (feature `002-partner-email-digest`).
- Hosting the one-page report at a URL (planned follow-up once object storage is in place).
- Real-time handling of reactions or interactive buttons; feedback is read at the next run.
- Automatic merging of any change to prompts, skill, thresholds or configuration.
- Paging or alerting; the existing monitoring stack keeps that responsibility.
- Any remediation action against a deployment.
- Posting to more than one Slack channel, or sending a programme's report to its own channel or
  recipients (people without credentials for the hosted watchdog); the report's link setting and the
  `--group` filter prepare for that story (revision 24).
- Breakdown analysis: per-route, per-code or per-database series from grouped panels, with a
  cardinality bound and items that name the route or code. A later user story; today such panels
  are listed in discovery and not analysed (FR-075).
- A hosted or multi-tenant service for community members; they run the agent themselves.

## Clarifications

### Session 2026-09-19

- Q: Where does the code live? → A: `cht-ai-tools` at `packages/agent-watchdog`; deployment
  manifests and per-project configuration in `medic-infrastructure`. Specs live at
  `packages/agent-watchdog/specs/`.
- Q: Is feedback handled in real time? → A: No. Reactions and notes are read at the start of the
  next run; no always-on component.
- Q: How does a reader react to one item rather than the whole brief? → A: each flagged item is
  its own threaded reply until revision 25; since then a reply is for a high item or an alert group,
  every other item lives in the report shared into the thread.
- Q: How much of the day goes in the post body? → A: The two highest-ranked programmes, each with
  at most three project lines; everything else is in the thread and the report (revision 28).
- Q: Which programmes get a thread reply of their own? → A: Those with two or more flagged projects
  that are not in the body; single-project programmes and ungrouped hosts share one "Other" reply
  (revision 28).
- Q: How does a project with several issues read? → A: One line of at most two lines covering all
  of them, the project written by code, the words the model's (revision 28).
- Q: Where does "here is how your feedback was used" point? → A: The digest quotes the lines
  inserted into the project's prompt and links the session's trace; run files are not web-served
  (revision 28, for revision 29).
- Q: Are partner emails part of this feature? → A: No; separate feature with its own privacy
  requirements.
- Q: Are dashboard panel images embedded? → A: No. Items carry structured dashboard references
  from which links are built; charts in the report are drawn from the data the analysis used. The
  brief's own image, a screenshot of its summary, was retired in revision 24; captures of dashboard
  panels remain a possible later story.
- Q: Does the agent edit its own prompts, skill or thresholds? → A: No. It writes bounded memory
  and proposals; humans change prompts, skill and thresholds by PR.
- Q: What is the data source? → A: Medic's hosted CHT Watchdog, read-only, one metrics store
  across all projects.
- Q: How many items in the post body? → A: at most five top-level bullets, each with up to eight
  one-line sub-bullets (revised from three in revision 9, FR-010, FR-015); further items go to the
  thread, and every high-severity project item keeps its own thread reply (revision 25).
- Q: Where do reference lookups come from? → A: the CHT documentation search service
  (cht-docs-mcp): documentation, community forum, GitHub issues and pull requests.
- Q: Can the agent be run outside production? → A: Yes. Any contributor can run every stage and
  the full pipeline in preview mode on their machine, and can drive the analysis through the agent
  runtime's own command line from the same agent definition.
- Q: How are links kept accurate? → A: the model emits structured references; code builds the
  links; a verification gate checks every link resolves and every number matches computed data.
- Q: How does the agent learn from past incidents? → A: a knowledge corpus of raw material,
  distilled into reviewed pattern cards that the skill references.
- Q: Do thresholds adapt automatically? → A: No. The system measures and suggests; humans decide.
- Q: How long is raw metric data kept? → A: briefly; the watchdog is the source of record and
  only the model's inputs are kept long-term.
- Q: Is a writing or voice skill applied to the bullets? → A: No. The audience is technical
  operations staff; metric names, values, windows and PromQL are the style, and emoji are fine as
  status markers. A design skill was used once, to redesign the report template in revision 24, and
  the original design was kept in revision 25.
- Q: What is configurable through the environment? → A: per-environment scalars (model, effort,
  bounds, endpoints, paths, retention, logging, engine, preview) and secrets; structured policy
  stays in versioned files; safety rails are not configurable.
- Q: Will the documentation service cover the watchdog itself? → A: Yes; Medic is adding the
  cht-watchdog repository to cht-docs-mcp's sources.
- Q: Does the analysis take a second look? → A: Yes. A configurable number of passes (default
  two) in one session; later passes review earlier items, re-query the documentation service
  with new or clarifying questions, record every change with a reason, and stop early when a
  pass changes nothing.
- Q: What are the starting candidate thresholds and severity levels? → A: a candidate is raised
  on a change of 50% or more versus the previous day, 2.5 standard deviations or more versus the
  trailing fourteen days, or a monotonic rise lasting six hours or more; severities are low,
  medium and high, with high reserved for a scrape target down, an outbound push backlog above
  zero, or a sentinel backlog above three times its baseline.
- Q: What are the default retention periods? → A: 14 days for raw series, 30 days for everything
  else (rendered images shared the short period until they were retired in revision 24).
- Q: When and where is the daily brief posted? → A: 06:00 UTC, to the `#agents` Slack channel,
  as the bot named `agent-watchdog`.
- Q: Where is the SC-002 thumbs-down rate measured from, given 30-day retention of items and
  feedback? → A: from the run outcomes appended to the knowledge corpus (FR-030), which fall
  outside the FR-040 retention limits.
- Q: How long are feedback records kept? → A: Permanently; they are kilobytes a month and the
  audit trail of every reaction (FR-059). The earlier 30-day answer applies to run records, not
  to feedback.
- Q: How long does feedback influence ranking? → A: 30 days by default, configurable with a hard
  cap; horizons stated in notes are honoured until their date (FR-060).
- Q: How is feedback acknowledged? → A: one code-built digest reply per run in that day's brief
  thread, once per record; never a reply per reaction (FR-062).
- Q: Where do lessons from notes become permanent? → A: as proposal files for the skill, a
  prompt, a project annotation, a threshold or a pattern card, never applied automatically
  (FR-061); the weekly report lists proposals still awaiting review (FR-063).
- Q: Is the digest posted on a quiet day? → A: Yes, in the heartbeat's thread; feedback is
  acknowledged by the next run whatever it posted (FR-062).
- Q: Does the run mark each acknowledged note as seen? → A: Yes, one `eyes` reaction per
  acknowledged note after the digest is posted, which adds the `reactions:write` scope; never in
  preview, and a failed reaction is logged, not fatal (FR-062).
- Q: How is the author stored now that records are permanent? → A: as the raw Slack user id, on
  the private volume only, never rendered; it is needed as-is for de-duplication and retraction
  matching (FR-028).
- Q: What does a project-annotation proposal contain? → A: a ready-to-paste `projects.yaml`
  fragment plus a short rationale, with the host flagged for the reviewer (FR-061).
- Q: Do alerts belong in the brief? → A: Yes. Each run reads the Grafana-managed alert rules and
  firing instances with the same read-only credential, classifies them by code from a reviewed
  policy (category, importance, staleness after 14 days by default), groups them per programme
  and category, links to the filtered alert list, and keeps a durable episode per instance with
  its correlations (FR-064 to FR-067, FR-070).
- Q: How are programmes and development instances handled? → A: `projects.yaml` declares groups
  by host pattern (placeholders for North Programme and South Programme until the real patterns are set in
  medic-infrastructure) and an ignore list (`*.dev.*`, `*-dev.*`); unmatched hosts are "Other";
  ignored hosts are neither analysed nor posted (FR-068).
- Q: How is the bot identified in Slack? → A: reaffirmed on 2026-09-19: an internal Slack app
  whose display name and icon are set in the app configuration; no per-message `username` or
  `icon_emoji` and no `chat:write.customize` scope; a non-rotating bot token, since rotation
  cannot be turned off and needs the app's client secret to refresh (FR-047 unchanged).

### Session 2026-09-20

- Q: The first hosted run re-collects four windows per metric for 95 projects (364 queries and
  about 65 seconds per project, over 100 minutes in all) and one slow query failed the whole run;
  should collection fetch only the new day's data, and is a database needed? → A: Fetch the current
  window only; take the previous-day and previous-week windows from the stored runs one and seven
  days earlier; build the trailing baseline from a per-project ledger of daily maxima kept in the
  data volume; fetch from the source only what the volume lacks. No database: Prometheus is the
  time-series store and the run directory plus the ledger is the cache. A single failed query makes
  only its window unavailable after one retry; the source is unreachable only on connection failure
  or consecutive query failures; range queries get their own timeout. Collect projects concurrently
  within the existing concurrency bound. Scale assumption raised to one hundred projects (FR-072 to
  FR-074, SC-016, revision 11).
- Q: The per-route p90 latency panel times out (30 s) and trips Prometheus's sample limit (HTTP 422)
  as a twenty-day subquery, and ten API panels group by route or code, of which the collector kept
  an arbitrary first series; should they be skipped, and does that lose insight? → A: Skip grouped
  and ranked panels at discovery and refuse several series at collection (FR-075); the aggregate
  request rate, request count and error-share panels remain, so a project-wide degradation still
  shows, while per-route and per-code changes become a later breakdown story. The API dashboard has
  no aggregate latency panel; adding `histogram_quantile(0.9, sum(rate(…_bucket[$interval])) by (le))`
  to cht-watchdog would give the brief latency at once (revision 12).
- Q: The first complete hosted run lost all 95 model sessions to a runtime error (the Claude Code
  binary refused the output schema's 2020-12 dialect), recorded them as timeouts, and published
  "Alerts only: no metric changes to flag" over 2,058 computed candidates; the run then exited 1
  because the tracing exporter answered 401. Is the brief what was intended? → A: No. Fixes now
  (revision 13): the output schema is handed to the runtime without its dialect and identifier
  keywords and with `definitions`; a failed session is an `error` bound with its message; with no
  items and candidates present the brief degrades to the deterministic candidates and names the
  failure; a tracing flush failure never changes the exit code; version strings are not phone
  numbers to the scan. Proposed for approval: User Story 10 (honest brief, metric semantics) and
  User Story 11 (correlation and consolidation).
- Q: With `AGENT_WATCHDOG_ENGINE=cli` and `ANTHROPIC_API_KEY` left empty because `claude` is logged
  in on a Team plan, the run exited 78; should the binary simply be used as logged in? → A: Yes. The
  key is required only for the `sdk` engine. Without it the command-line engine runs `claude` on the
  operator's login, without bare mode (which never reads a login) and isolated by flags instead: no
  settings sources, no built-in tools, strict MCP configuration, no session persistence, auto memory
  off. The scheduled run keeps the key (FR-050, revision 15).
- Q: The first single-project run on that login crashed the roll-up with a negative alert episode
  duration (a forced re-run of the previous day measured the live alert snapshot from that day's
  06:00 start), and its only session was stopped by the $0.75 budget before a first result, so the
  brief would have read "alerts only" over 22 computed candidates. What should hold? → A: Alert ages,
  episode events and durations are measured from the time the alerts were read (the run's clock,
  recorded as `observed_at`), never from the analysed date; a duration is clamped at zero and
  logged. A session stopped by its budget or turn cap before a result is named in the brief with the
  spend, and the brief degrades to the candidates when nothing else exists. The measured first-pass
  cost of one project with 22 candidates exceeded $0.75 at the configured model and effort; the
  per-project budget is tuned after measuring one complete session, not guessed (revision 16).
- Q: The next single-project preview completed with exit 0, cost $0.00 and "Alerts only": was it a
  success? → A: No. The model id `claude-opus-4.8` does not exist; the runtime answered every turn
  in under half a second with a result marked as an error and no usage, and the harness read it as a
  turn without structured output, so six turns were "revised" for nothing and the brief called it a
  quiet day. Now a result the runtime marks as an error fails the project's analysis with the
  runtime's message, and model ids are validated at startup. The same output showed four more
  defects, all fixed: one programme's client-errors reply was cut mid-link (replies are now fitted without
  cutting a link); two node-exporter hosts with `:9100` fell into "Other" (the port is stripped);
  a resolved line named an ignored training host (episodes on ignored hosts are left alone); and
  stale API-down alerts on dead hosts were not housekeeping in a preview (discovery's target health
  stands in for projects not analysed) (revision 17).
- Q: The first complete single-project run cost $2.28, of which $2.00 bought nothing: four of five
  model turns were rejected, all on the same check, and pass 1 was never accepted so its items were
  discarded. Should the prompt be improved, or more revision attempts allowed? → A: Neither. Every
  rejection was the dashboard reference window, which the prompt never gave the model the bounds
  for and which the run already holds exactly (panel and window start and end per metric). The
  reference is now built by code and removed from what the model emits, which is what constitution
  III required all along. Two smaller defects came from the same turns: the revision request
  repeated the informational text of checks that had passed, and the gate called an unrounded
  trailing mean a phone number and a window identifier an invented number. Cost work at ninety
  projects a day is a separate story, to be measured after these land, not guessed now
  (FR-009, FR-016, FR-018, FR-058, revision 18).
- Q: With the reference built by code the run converged for the first time, three passes and two
  items, but it cost $2.82 for one project, its brief carried fifty alerts from projects it never
  analysed, and it declared its own reference sources unavailable while citing the documentation it
  had just read. What holds, and where is the cost? → A: Three things. A filtered run's brief covers
  only the projects it analysed, while collection, the classified record and the episodes stay whole
  so the next full run is unaffected. A refusal of a tool the allow-list never carried is the design
  working, not a source failure, and such a tool is not offered to the model at all; the metric tool
  accepts the key the candidates use, functions and matchers included; a date is not a phone number
  and findings in recorded reference text are counted apart from the run's own output; and each run
  logs how its tools were used. On cost, caching already works, so the levers are output tokens and
  wasted passes: a written justification is asked for only where the candidate's floor is medium or
  high, and no review pass runs when the pass before it produced no items. A third pass cost $0.649
  and changed nothing, which is what the existing pass-count setting is for. Pricing the review
  passes on a cheaper model was dropped on inspection: both engines bind the model when the session
  opens, so it would cost the shared session FR-057 requires, and that trade needs its own decision
  (FR-016, FR-018, FR-051, FR-057, FR-066, revision 19).
- Q: The analysis records which candidates it set aside and why, and it decides in prose that one
  item explains another. Should either be kept and mined, and should projects seeing the same
  numbers share an analysis? → A: Keep and use both, and do not share analyses. The dismissals
  become threshold evidence in the weekly report, ranked below a human verdict and never proposing
  by themselves, and the report states what each rule raised, what became an item and what was set
  aside with its reasons. The relation between two items is recorded as data, named by metric and
  resolved by code, given to the roll-up and counted in the report, without changing the five
  bullets. Analysing one project and reusing the conclusion on others was rejected: one wrong
  judgement would reach every project at once, and the reviewed pattern card already carries a
  lesson from one project to all of them under human review (FR-009, FR-014a, FR-058, revision 20).

## Notes for `/speckit.plan` *(not requirements)*

Decisions already taken during design that belong in the plan, listed so they are not re-litigated:

- Engine: the Claude Agent SDK for TypeScript, consumed from CommonJS JavaScript, is the analysis engine in production, with
  `claude -p` as the identical local face; both are configured from one source (skill directory,
  MCP configuration, hooks JSON, output schema, system-prompt file). Production uses bare mode
  semantics: no filesystem settings discovery, explicit allow-listed tools, shell and web tools
  disabled, permission prompts off. A contributor's `claude -p` run without an API key uses the
  contributor's login with the same isolation achieved by flags (revision 15).
- Model: `claude-fable-5-1` at maximum effort for analysis and roll-up, both read from the
  environment; per-stage model overrides so small stages can be moved to a cheaper model later;
  cost bounded per project and per run with the SDK's budget option; prompt caching kept effective
  by holding the static prefix (skill, memory, pattern-card index) identical across calls and
  placing per-project data last.
- Passes: one SDK session per project, driven as a multi-turn conversation (streaming input or
  session resume) so pass N sees pass N-1's tool results; pass prompts live in
  `prompts/pass-first.md` and `prompts/pass-review.md`; each pass returns schema-validated
  structured output that the harness writes to `findings.pass<N>.json`; the harness diffs passes
  and applies the convergence rule.
- Configuration: `AGENT_WATCHDOG_`-prefixed environment variables for the harness's own settings,
  vendor-standard names for vendor credentials (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`,
  `LANGFUSE_*`); a committed `.env.example` documents every variable and default; local runs use
  Node's `--env-file`; in the cluster, non-secrets arrive through a ConfigMap `envFrom` and secrets
  through an External Secrets-managed Secret; a zod schema validates everything at startup and the
  redacted effective configuration is written to `runs/<date>/config.effective.json`.
- Verification: implemented once under `src/verify/` and called by the harness after every model
  turn on both engines and again before publish; the SDK engine also runs it in the `Stop` hook as
  a second line of defence. `claude --bare` skips hook surfaces (research.md R-3), so no check
  depends on hooks.
- Reference sources: cht-docs-mcp via the SDK's `mcpServers` option and `--mcp-config` on the CLI,
  with the cht-watchdog repository indexed. The allow-list exposes the search tools, whose results
  carry source URLs the gate can check, and leaves the service's synthesised-answer tool off by
  default so provenance stays first-hand.
- Metrics are read through the hosted Grafana's datasource proxy rather than an exposed metrics
  store.
- Rendering: the report template is filled, never generated per run, with no external asset,
  script or network dependency; it was designed once with the design-taste-frontend skill, redesigned
  in revision 24 under its minimalist and redesign variants, and returned to the original design in
  revision 25 with the links, the alerts section and the rounding kept; no skill plays a part in the
  daily run or in the wording of the brief. The brief image, a screenshot of the report's summary in a
  headless browser, was retired in revision 24.
- Storage: run artefacts on a 10 Gi persistent volume under `runs/<date>/<project>/` with memory,
  feedback, proposals and the corpus index beside them; raw corpus material outside the public
  repository; retention split as in FR-040.
- Package is CommonJS on Node 22 per the constitution; the SDK is loaded through dynamic import if
  it ships as ES modules only.
- Feedback review (User Story 7): `AGENT_WATCHDOG_FEEDBACK_INFLUENCE_DAYS` joins the environment
  contract; `feedback.jsonl` becomes a durable class and the purge stops compacting it; Feedback
  records gain `acknowledged_run_id`, `classification` and `proposal_id`; the digest is a new
  Slack template and a new registered metadata event type; note classification uses
  `AGENT_WATCHDOG_MODEL_FEEDBACK` with a new prompt file; the Proposal type gains
  `project_annotation` (a `projects.yaml` change); the calibration report gains an
  `open_proposals` list; and the roll-up prompt receives the day's matched feedback.
- Alerts and groups (User Stories 8 and 9): verify against the hosted Grafana with the Viewer token
  which of `GET /api/prometheus/grafana/api/v1/rules`, `GET /api/prometheus/grafana/api/v1/alerts`
  and `GET /api/alertmanager/grafana/api/v2/alerts` answer (the provisioning API is expected to
  need a higher role and is not used), whether alert state history (`/api/v1/rules/history`) is
  configured, and the URL form of the filtered alert list; `alerts.yaml` joins the policy files
  with the mapping in FR-065 and `stale_after_days`; `projects.yaml` gains `groups` and
  `ignore`; the run stores `alerts.json` and appends `alerts/episodes.jsonl` (durable); the
  Bullet entity gains `children`; the body limit constants and the gate's bullet checks move to
  five bullets and eight sub-bullets; alert groups post one thread reply with metadata
  `agent_watchdog.alerts`; the fake Grafana gains alert endpoints and a recorded alert fixture
  day.

# Feature Specification: Watchdog Slack Loop

**Feature Branch**: `001-watchdog-slack-loop`
**Created**: 2026-09-19
**Status**: Draft (revision 11)
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
relevant dashboard view for that project and time window, plus a rendered image of the brief.
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
   the highest-ranked fill the five bullets, alone or as sub-bullets of their programme, and the
   remainder appear as additional threaded replies, each still individually reactable.
4. **Given** the run falls inside a configured expected-load window (month-end, sync week),
   **When** a metric rises in line with the same phase of the previous cycle, **Then** it is
   not flagged and the post notes that the window is active.
5. **Given** a scrape target for a project is down, **When** the run executes, **Then** the
   outage is itself a flagged item rather than being treated as missing data.
6. **Given** a draft brief contains a number that does not match the computed data, a project
   name that is not a monitored project, or a link that does not resolve, **When** the run
   reaches publication, **Then** the draft is rejected, the reasons are returned for revision,
   and nothing is posted until a draft passes or the run degrades to the deterministic brief.
7. **Given** the run is configured for two analysis passes, **When** the first pass has produced
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
   prompts, the deployment configuration where dashboard priority order and the expected-load
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
   thread replies, image) as structured data, and posts nothing.
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

1. **Given** alerts are firing when the run executes, **When** the brief is composed, **Then** it
   states per project group how many alerts fire, grouped by category, with the oldest start and a
   link to the filtered alert list, for example "MoH-Nepal alerts: 15 firing, 12 about disk usage,
   3 stale for more than 14 days".
2. **Given** an alert has been firing longer than the configured staleness threshold, **When**
   the brief is composed, **Then** it is marked stale and counted separately from new and
   persisting alerts.
3. **Given** the reviewed alert policy assigns importance to rule titles, **When** alerts compete
   with flagged items for the body, **Then** critical alerts rank first and unknown rules are
   reported as uncategorised with medium importance.
4. **Given** alerts are numerous, **When** the brief is composed, **Then** one bullet per project
   group summarises them with one sub-bullet per category, and the full list is in that group's
   thread reply, which can receive reactions and notes like an item.
5. **Given** an alert started or cleared since the previous run, **When** the run completes,
   **Then** an episode record holds when it started and cleared, the expected-load window and any
   CHT version change in force at the start, the flagged items on the same project and metric in
   the same window, and the analysis's explanation when it produced one; episodes are appended to
   the knowledge corpus.
6. **Given** the alerting endpoints are unreachable, **When** the run executes, **Then** the brief
   notes that alerts were unavailable and the run otherwise completes.

### User Story 9 - Grouped briefing for programmes (Priority: P2)

Medic's hosted watchdog monitors projects that belong to programmes, today eCHIS Kenya and MoH
Nepal, plus development instances nobody wants in the brief. A reader wants the body to say
"Nepal: 5 projects with issues" with one line per project underneath, and never to see a `.dev`
host.

**Why this priority**: with dozens of projects a flat list of items hides the programme-level
picture, and development instances add noise.

**Independent Test**: declare two groups by host pattern and an ignore pattern in the project
annotations; run against recorded metrics with issues on several projects of one group and on a
development host; verify the group bullet with sub-bullets, the per-project thread replies, the
ignored host's absence from analysis and post, and the "Other" group for unmatched hosts.

**Acceptance Scenarios**:

1. **Given** `projects.yaml` declares groups by host pattern, **When** several projects of one
   group have flagged items, **Then** the body shows one bullet for the group, "Nepal: 5 projects
   with issues", with one sub-bullet per project item in rank order, and each project item still
   has its own thread reply.
2. **Given** a host matches the ignore list, **When** the run executes, **Then** it is discovered
   and counted as ignored but neither analysed, nor charged for model usage, nor named in the post.
3. **Given** a host matches no group, **When** the brief is composed, **Then** it is reported under
   the group "Other".
4. **Given** five or more bullets qualify, **When** the brief is composed, **Then** at most five
   appear, each at most two lines with at most eight sub-bullets, and the gate rejects a draft that
   exceeds any of these limits.

### Edge Cases

- Metrics source unreachable or timing out: post a failure notice, exit non-zero, publish no
  partial brief.
- Slack unavailable after retries: persist everything, mark the run unposted, exit non-zero.
- Model output invalid or the verification gate fails a third time, after two returns to the
  analysis (FR-017): publish a degraded brief built from deterministic candidates only, with an
  explicit notice.
- Tool loop, token or cost bound reached: stop, use what was gathered, say so in the post.
- Second run on the same date: refuse unless explicitly forced; a forced run supersedes and
  links the earlier post.
- Fetched text (forum, documentation, issues, annotations, notes, corpus items) attempts to
  instruct the agent: treated as data; no item is ever created solely on the strength of such
  text.
- An item persists for many days: shown as "persisting N days", not re-explained daily.
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

## Requirements *(mandatory)*

### Functional Requirements

Discovery and collection

- **FR-001**: The system MUST discover the set of monitored CHT projects from the hosted
  watchdog's metrics store on every run, without a hard-coded list.
- **FR-002**: The system MUST read metrics with a read-only credential and MUST NOT require write
  access to any system.
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
  MUST be read-only.
- **FR-009**: Every flagged item MUST include: a stable identity, the project, a severity, metric
  evidence (values and windows), why it matters now, a suggested check, a structured reference to
  the dashboard view (dashboard, panel, project, window) from which the link is built, a
  confidence, the number of days it has persisted, and the pattern card it matches if any.
- **FR-010**: The system MUST rank flagged items and place at most five bullets in the post body; a
  bullet is one item or, when a project group has several flagged projects or several alerts, one
  group line with one sub-bullet per member (FR-069, FR-066). Revised from three in revision 9.
- **FR-011**: Items MUST be produced in a machine-validated structure; output that fails
  validation MUST NOT be published.
- **FR-012**: Analysis MUST be bounded per run by maximum tool invocations, tokens and cost; on
  reaching a bound the run completes with what it has and says so.
- **FR-013**: A project with no candidate items MUST NOT incur model usage.
- **FR-014**: Severity levels and candidate thresholds MUST be configurable globally and per
  project. The system MUST NOT change them itself. It MUST compute, per project and metric, the
  observed distribution of changes and the confirmed and dismissed rate of past items, and MUST
  produce threshold suggestions as reviewable proposals that show the evidence and the effect on
  the last thirty days of items. Initial defaults: a candidate is raised on a change of 50% or
  more versus the previous day, a deviation of 2.5 standard deviations or more versus the
  trailing fourteen days, or a monotonic rise lasting six hours or more. Severities are low,
  medium and high; high is reserved for a scrape target down, an outbound push backlog above
  zero, or a sentinel backlog above three times its baseline.
- **FR-015**: The brief is written for a technical operations audience: metric names as recorded
  in the metrics store, values with units and the comparison window, dashboard and panel names as
  they appear in the watchdog, PromQL where it helps the reader confirm. Emoji are permitted as
  status and severity markers. At most five bullets of at most two lines each, each bullet with at
  most eight sub-bullets of one line each; these structural limits are checked by the verification
  gate. No separate writing or voice skill is applied.

Analysis passes

- **FR-056**: The analysis of each project MUST run as a configurable number of passes, set
  through the environment with a default of two, a minimum of one and a hard upper bound in code.
  The first pass produces items. Each later pass receives the previous pass's items and the
  candidates it did not select, re-examines the computed data, MAY ask the documentation service
  new or clarifying questions prompted by earlier answers, looks specifically for anything
  missed, and emits revised items with a recorded reason for every addition, removal or change.
- **FR-057**: Passes MUST share one session so earlier tool results remain available to later
  passes. Every pass runs the verification gate. Passes MUST stop early when a pass changes
  nothing material (same item identities, severities and values within display rounding) and
  MUST stop regardless when the run's cost or turn bound is reached.
- **FR-058**: The run record MUST store each pass's items and the differences between passes,
  and the weekly calibration report MUST state how often later passes changed the outcome, so
  the pass count can be tuned on evidence.

Verification gate

- **FR-016**: Before publication the system MUST verify every draft deterministically: the output
  validates against the schema; every project named is a discovered project; every number in the
  text matches the computed data for that project and metric within display rounding; every date
  and window matches the run; every link is built by the system from a structured reference or
  appeared in a reference-lookup result during this run, and resolves; the bullet count and
  length limits hold; no secret or personal-data pattern is present.
- **FR-017**: A draft that fails verification MUST be returned to the analysis with the reasons,
  at most twice; after that the run MUST publish the degraded deterministic brief with a notice.
- **FR-018**: The same verification MUST run both inside the analysis (so the model can correct
  itself) and again immediately before publication, using the same code.

Publishing

- **FR-019**: The system MUST post one message per run to the configured Slack channel containing
  a headline, at most five bullets (FR-010), the brief image, and a footer with a link to the prompts, a
  link to the deployment configuration, a link to the run's trace, and the run's cost in currency.
- **FR-020**: The system MUST post each flagged item as its own threaded reply so it can receive
  reactions independently.
- **FR-021**: On a quiet day the system MUST post a one-line heartbeat stating what was checked.
- **FR-022**: The system MUST render a one-page report per run containing every flagged item and
  evidence charts drawn from the collected data, and store it with the run.
- **FR-023**: The brief image MUST be rendered from that same report so image and text never
  diverge.
- **FR-024**: On failure the system MUST post a one-line failure notice with the trace link and
  exit non-zero.
- **FR-025**: In preview mode the system MUST produce every artefact of a real run and emit the
  exact message payload (post, thread replies, image reference) as structured data instead of
  posting.

Feedback

- **FR-026**: At the start of each run the system MUST read reactions and thread replies from the
  posts of the previous N runs, N configurable with a default of seven.
- **FR-027**: The system MUST map thumbs-up and thumbs-down to items by stable identity, and notes
  to items by explicit reference; unmatched notes MUST be recorded as such.
- **FR-028**: The system MUST persist each piece of feedback with date, item identity, verdict,
  note and author, in an append-only record that is never purged (FR-059).
- **FR-029**: Feedback MUST influence subsequent runs: repeatedly dismissed patterns rank lower,
  confirmed patterns rank higher, and notes that state an expectation are honoured until their
  stated horizon. Ranking influence counts only records within the configured influence window
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
  and never sent to the model for classification. Each note is classified by one bounded,
  schema-validated model call into one of: expectation or horizon (already handled by FR-029),
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
  for the configured window. The digest MUST name no person, MUST acknowledge each record once
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
- **FR-066**: The brief MUST summarise firing alerts per project group and category with counts,
  the oldest start, the number stale, and a code-built link to the filtered alert list; when a
  group has several categories the bullet carries one sub-bullet per category. Alert bullets rank
  with flagged items by importance, critical first. Each alert group gets one thread reply listing
  its instances (at most fifty, with the count of the rest) that can receive reactions and notes.
- **FR-067**: The system MUST keep a durable episode per alert instance: rule, project, category,
  when it started and cleared, its duration, and correlations computed by code (the expected-load
  window active at the start, a CHT version change within a day of the start, flagged items on the
  same project and a related metric in the same window). The analysis pass receives the project's
  firing alerts as context; an item that explains an alert is linked to the episode as its
  explanation. Episodes are appended to the knowledge corpus as run outcomes are.
- **FR-068**: `projects.yaml` MUST support project groups (a label and host patterns) and an
  ignore list of host patterns. Ignored hosts are discovered and counted but MUST NOT be analysed,
  incur model usage or be named in any post. Hosts matching no group belong to "Other".
- **FR-069**: When a group has more than one flagged project, the body MUST show one bullet for the
  group naming the count, with one sub-bullet per project item in rank order; a group with one
  flagged project shows that item as today. Every project item keeps its own thread reply.
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
  for raw series and rendered images, 30 days for everything else.
- **FR-041**: The system MUST support offline replay of any stored run from its retained inputs;
  replay MUST NOT contact the metrics source or Slack.
- **FR-042**: Runs MUST be idempotent per date; a second run on the same date MUST require an
  explicit force flag.
- **FR-043**: Each stage MUST be runnable on its own from the files of the previous stage.

Security and trust boundaries

- **FR-044**: All externally fetched text MUST be treated as untrusted data: delimited and
  labelled when shown to the model, never executed as instructions, escaped when rendered.
- **FR-045**: Secrets MUST NOT appear in posts, run records, logs or the public repository.
- **FR-046**: The tools available to the model MUST be read-only and enumerated; no shell, no
  arbitrary web access, and file writes only into the current run's directory.

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
  contributor invoking the agent runtime directly, from one configuration source.

Configuration

- **FR-051**: Per-environment scalar settings MUST be settable through environment variables with
  documented defaults: model, effort level, per-stage model overrides, cost and turn bounds,
  timeouts, endpoints and identifiers (metrics source, Slack channel, documentation service,
  tracing backend, footer links), storage paths, retention periods, feedback look-back, memory
  cap, analysis pass count, engine selection, log level and format, and preview mode.
- **FR-052**: Secrets MUST be supplied only through the environment, never through configuration
  files or the run record.
- **FR-053**: Structured, reviewed policy — project annotations, dashboard priorities, thresholds,
  expected-load calendar, prompts, output schema — MUST live in versioned configuration files,
  not in environment variables.
- **FR-054**: Safety rails — the tool allow-list, disabled shell and web access, permission
  handling, and the verification gate — MUST NOT be configurable at runtime.
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
  sub-bullets, image, footer.
- **Thread Reply**: the per-item message that carries reactions; alert groups have one too.
- **Project Group**: a programme such as MoH Nepal or eCHIS Kenya, declared by host patterns in
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
  notice.
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
- The monitoring endpoints it scrapes are public and carry no patient data; host metrics exposed
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
- Posting to more than one Slack channel.
- A hosted or multi-tenant service for community members; they run the agent themselves.

## Clarifications

### Session 2026-09-19

- Q: Where does the code live? → A: `cht-ai-tools` at `packages/agent-watchdog`; deployment
  manifests and per-project configuration in `medic-infrastructure`. Specs live at
  `packages/agent-watchdog/specs/`.
- Q: Is feedback handled in real time? → A: No. Reactions and notes are read at the start of the
  next run; no always-on component.
- Q: How does a reader react to one item rather than the whole brief? → A: each flagged item is
  its own threaded reply.
- Q: Are partner emails part of this feature? → A: No; separate feature with its own privacy
  requirements.
- Q: Are dashboard panel images embedded? → A: No. Items carry structured dashboard references
  from which links are built; charts in the brief are drawn from the data the analysis used, so
  image and text agree.
- Q: Does the agent edit its own prompts, skill or thresholds? → A: No. It writes bounded memory
  and proposals; humans change prompts, skill and thresholds by PR.
- Q: What is the data source? → A: Medic's hosted CHT Watchdog, read-only, one metrics store
  across all projects.
- Q: How many items in the post body? → A: at most five top-level bullets, each with up to eight
  one-line sub-bullets (revised from three in revision 9, FR-010, FR-015); further items go to the
  thread, and every project item keeps its own thread reply.
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
  status markers. The design skill is used only to design the report template.
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
- Q: What are the default retention periods? → A: 14 days for raw series and rendered images,
  30 days for everything else.
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
  by host pattern (placeholders for MoH Nepal and eCHIS Kenya until the real patterns are set in
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

## Notes for `/speckit.plan` *(not requirements)*

Decisions already taken during design that belong in the plan, listed so they are not re-litigated:

- Engine: the Claude Agent SDK for TypeScript is the analysis engine in production, with
  `claude -p` as the identical local face; both are configured from one source (skill directory,
  MCP configuration, hooks JSON, output schema, system-prompt file). Production uses bare mode
  semantics: no filesystem settings discovery, explicit allow-listed tools, shell and web tools
  disabled, permission prompts off.
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
- Rendering: the brief image is a screenshot of the report's summary element rendered in a
  headless browser with network disabled; the report template is filled, never generated per run;
  the template is designed once with the design-taste-frontend skill (design read recorded in the
  template header), and that skill plays no part in the daily run or in the wording of the brief.
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

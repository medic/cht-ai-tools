'use strict';
// zod schemas for every entity in data-model.md. Enumerations are closed; unknown values fail (FR-011).
const { z } = require('zod');

const hex12 = z.string().regex(/^[0-9a-f]{12}$/, 'expected a 12-character hex id');
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isoTimestamp = z.string().regex(TIMESTAMP_PATTERN, 'expected an ISO-8601 UTC timestamp');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const host = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/, 'expected a bare, lowercase host');
const url = z.url();

// The body layout's caps (src/rollup/layout.js reads them from here, revision 35): two body slots, and a
// programme's entry names at most three projects and a count of the rest, four children in all.
const LAYOUT_CAPS = Object.freeze({ BODY_SLOTS: 2, MAX_CHILDREN: 4 });

const enums = {
  Severity: z.enum(['low', 'medium', 'high']),
  WindowName: z.enum(['current', 'previous_day', 'previous_week', 'previous_cycle', 'trailing_14d']),
  RunMode: z.enum(['scheduled', 'manual', 'preview', 'replay', 'stage']),
  RunStatus: z.enum([
    'created', 'collected', 'analysed', 'drafted', 'verified', 'degraded', 'rendered', 'published', 'heartbeat',
    'previewed', 'unposted', 'failed', 'refused',
  ]),
  StageStatus: z.enum(['running', 'completed', 'failed', 'skipped', 'degraded']),
  CandidateRule: z.enum(['pct_change', 'deviation', 'monotonic', 'target_down', 'backlog_absolute', 'restart']),
  MetricKind: z.enum(['gauge', 'counter', 'uptime', 'clock']),
  Aggregate: z.enum(['level', 'increase', 'restarts', 'excluded']),
  ThresholdSource: z.enum(['default', 'global', 'project']),
  Baseline: z.enum(['previous_day', 'previous_cycle']),
  Placement: z.enum(['body', 'thread']),
  PassChange: z.enum(['added', 'removed', 'changed']),
  CheckStatus: z.enum(['pass', 'fail']),
  VerificationSubject: z.enum(['pass', 'brief']),
  VerificationOutcome: z.enum(['accepted', 'rejected']),
  BriefKind: z.enum(['brief', 'heartbeat', 'degraded', 'failure']),
  // A top-level line of the post body: one item, a programme's items as sub-bullets, or a programme's alerts (US8).
  BulletKind: z.enum(['item', 'group', 'alerts']),
  FeedbackTarget: z.enum(['item', 'brief', 'alert_group']),
  FeedbackKind: z.enum(['reaction', 'note']),
  FeedbackVerdict: z.enum(['up', 'down', 'retracted']),
  // Where a note's lesson belongs (FR-061); `expectation` is handled by the horizon rule, `none` carries no lesson.
  FeedbackClassification: z.enum([
    'expectation', 'project_annotation', 'skill', 'prompt', 'threshold', 'pattern_card', 'none',
  ]),
  ProposalType: z.enum(['skill', 'prompt', 'threshold', 'pattern_card', 'project_annotation']),
  ProposalStatus: z.enum(['proposed', 'superseded']),
  FlagKind: z.enum(['hostname', 'person', 'address', 'secret']),
  CorpusKind: z.enum(['conversation', 'export', 'incident', 'explainer', 'run_outcome', 'unknown']),
  CorpusStatus: z.enum(['new', 'distilled', 'skipped']),
  CardStatus: z.enum(['proposed', 'merged']),
  WindowKind: z.enum(['month_end', 'dates', 'weekly']),
  TargetHealth: z.enum(['up', 'down', 'unknown']),
  Audience: z.enum(['internal', 'partner']),
  // Grafana-managed alerts (User Story 8): states normalised by code, importance from alerts.yaml, episode events.
  AlertState: z.enum(['firing', 'pending', 'nodata', 'error', 'normal']),
  AlertImportance: z.enum(['critical', 'high', 'medium', 'low']),
  EpisodeEvent: z.enum(['opened', 'observed', 'cleared']),
};

const ScrapeTarget = z.object({
  job: z.string(),
  scrape_url: z.string(),
  health: enums.TargetHealth,
  last_error: z.string().nullable(),
}).strict();

const ExpectedLoadWindow = z.object({
  id: z.string().min(1),
  scope: z.string(),
  kind: enums.WindowKind,
  start: z.string().nullable(),
  end: z.string().nullable(),
  timezone: z.string(),
  note: z.string(),
  cycle_days: z.number().int().min(1),
}).strict();

const Project = z.object({
  host,
  url,
  slug: z.string().min(1),
  configured: z.boolean(),
  owner: z.string().nullable(),
  notes: z.string().nullable(),
  thresholds: z.record(z.string(), z.number()).nullable(),
  expected_load_windows: z.array(z.any()),
  cht_version: z.string().nullable(),
  history_days: z.number().int().min(0),
  scrape_targets: z.array(ScrapeTarget),
  // The Project Group label from projects.yaml; hosts matching no pattern belong to "Other" (FR-068).
  group: z.string().min(1).default('Other'),
}).strict();

const Stage = z.object({
  name: z.string(),
  status: enums.StageStatus,
  started_at: isoTimestamp.nullable(),
  finished_at: isoTimestamp.nullable(),
  duration_ms: z.number().nullable(),
  error: z.string().nullable(),
}).passthrough();

const Usage = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
  cache_creation_tokens: z.number().int().min(0),
}).strict();

const Publication = z.object({
  channel_id: z.string(),
  ts: z.string(),
  permalink: z.string().nullable(),
}).strict();

const Run = z.object({
  run_id: z.string().regex(/^\d{4}-\d{2}-\d{2}(-f\d+)?$/),
  date: isoDate,
  mode: enums.RunMode,
  status: enums.RunStatus,
  started_at: isoTimestamp,
  finished_at: isoTimestamp.nullable(),
  duration_ms: z.number().nullable(),
  versions: z.object({
    package: z.string(),
    git_sha: z.string().nullable(),
    prompts_hash: z.string().nullable(),
    skill_hash: z.string().nullable(),
    schema_hash: z.string().nullable(),
    config_hash: z.string().nullable(),
  }).strict(),
  config_effective_path: z.string(),
  stages: z.array(Stage),
  projects: z.array(url),
  usage: Usage.nullable(),
  cost_usd: z.number().nullable(),
  publications: z.array(Publication),
  trace_id: z.string().nullable(),
  trace_url: z.string().nullable(),
  supersedes: z.string().nullable(),
  superseded_by: z.string().nullable(),
  bounds_hit: z.array(z.string()),
}).passthrough();

const PanelRef = z.object({
  dashboard_uid: z.string(),
  panel_id: z.number().int(),
  panel_title: z.string(),
  ref_id: z.string(),
}).strict();

const MetricWindow = z.object({
  project_url: url,
  metric: z.string().min(1),
  panel_ref: PanelRef,
  window: enums.WindowName,
  start: isoTimestamp,
  end: isoTimestamp,
  step_s: z.number().int().min(1),
  unit: z.string(),
  values: z.array(z.tuple([z.number(), z.number()])),
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  // Where the values came from (FR-072): queried this run, the current window of a stored earlier run, or the ledger.
  source: z.string().regex(/^(fetched|ledger|stored:[A-Za-z0-9._-]+)$/).default('fetched'),
}).strict().refine((w) => w.available || w.unavailable_reason, {
  message: 'unavailable_reason is required when available is false',
  path: ['unavailable_reason'],
});

const ComputedChange = z.object({
  project_url: url,
  metric: z.string().min(1),
  panel_ref: PanelRef,
  current_value: z.number().nullable(),
  previous_day_value: z.number().nullable(),
  previous_week_value: z.number().nullable(),
  previous_cycle_value: z.number().nullable(),
  pct_change_vs_previous_day: z.number().nullable(),
  trailing_mean: z.number().nullable(),
  trailing_stddev: z.number().nullable(),
  deviation_sigma: z.number().nullable(),
  monotonic_rise_hours: z.number().min(0),
  baseline: enums.Baseline,
  expected_load_window_id: z.string().nullable(),
  // How the metric was analysed (FR-076): a level, a counter's increase over the window, restarts, or excluded.
  kind: enums.MetricKind.default('gauge'),
  aggregate: enums.Aggregate.default('level'),
  restarts_24h: z.number().int().min(0).nullable().default(null),
}).strict();

const Evidence = z.object({
  window: enums.WindowName,
  value: z.number(),
  unit: z.string(),
  start: isoTimestamp.optional(),
  end: isoTimestamp.optional(),
  note: z.string().optional(),
}).strict();

const Candidate = z.object({
  candidate_id: hex12,
  project_url: url,
  metric: z.string().min(1),
  panel_ref: PanelRef,
  rule: enums.CandidateRule,
  threshold: z.object({ source: enums.ThresholdSource, value: z.number() }).strict(),
  observed: z.number(),
  severity_floor: enums.Severity,
  evidence: z.array(Evidence),
  expected_load_window_id: z.string().nullable(),
}).strict();

const DashboardRef = z.object({
  dashboard_uid: z.string(),
  // Null when the metric has no panel on a priority dashboard (scrape-target health): the link is then
  // dashboard-level, scoped to the project and window (FR-009, revision 18).
  panel_id: z.number().int().nullable(),
  project_url: url,
  from: isoTimestamp,
  to: isoTimestamp,
}).strict();

const PassChangeRecord = z.object({
  pass: z.number().int().min(1),
  change: enums.PassChange,
  reason: z.string(),
}).strict();

const Item = z.object({
  item_id: hex12,
  project_url: url,
  metric: z.string().min(1),
  severity: enums.Severity,
  evidence: z.array(Evidence),
  why_now: z.string(),
  suggested_check: z.string(),
  // The sibling item this one relates to, resolved from the metric the analysis named (FR-009, revision 20).
  relates_to: z.object({
    item_id: hex12,
    metric: z.string(),
    relation: z.enum(['level_of', 'rate_of', 'same_cause', 'consequence_of']),
  }).strict().nullable().default(null),
  dashboard_ref: DashboardRef,
  confidence: z.number().min(0).max(1),
  persisting_days: z.number().int().min(1),
  pattern_card: z.string().nullable(),
  candidate_ids: z.array(z.string()).min(1),
  reference_urls: z.array(z.string()),
  rank: z.number().int().min(1).nullable(),
  placement: enums.Placement.nullable(),
  // The top-level bullet the item appears in, alone or as a sub-bullet; null in the thread (FR-069).
  slot: z.number().int().min(1).max(LAYOUT_CAPS.BODY_SLOTS).nullable().default(null),
  pass_history: z.array(PassChangeRecord),
}).strict();

const Check = z.object({
  name: z.string(),
  status: enums.CheckStatus,
  reasons: z.array(z.string()),
}).strict();

const VerificationReport = z.object({
  subject: enums.VerificationSubject,
  subject_ref: z.string(),
  attempt: z.number().int().min(1).max(3),
  checks: z.array(Check),
  outcome: enums.VerificationOutcome,
}).strict();

const Pass = z.object({
  pass: z.number().int().min(1),
  session_id: z.string().nullable(),
  items: z.array(Item),
  // A written reason where the candidate's severity floor is medium or high; the id alone where it is low, so a
  // project with thirty low-floor candidates does not spend output tokens on thirty paragraphs (revision 19).
  not_selected: z.array(z.object({ candidate_id: z.string(), reason: z.string().optional() }).strict()),
  changes: z.array(PassChangeRecord),
  converged: z.boolean(),
  gate: VerificationReport.nullable(),
  usage: Usage.nullable(),
  cost_usd: z.number().nullable(),
  num_turns: z.number().int().nullable(),
  duration_ms: z.number().nullable(),
  tool_calls_path: z.string(),
}).strict();

// A sub-bullet: one project's line, its lead item and every item it covers (FR-069, revision 28), or the code-written
// count of the projects beyond three (item_id null).
const BulletChild = z.object({
  item_id: hex12.nullable(), item_ids: z.array(hex12).default([]), text: z.string(),
}).strict();

// A bare { item_id, text } is an item bullet with no sub-bullets, so earlier callers keep working.
const Bullet = z.object({
  kind: enums.BulletKind.default('item'),
  item_id: hex12.nullable().default(null),
  // Every item an item bullet's line covers, the lead first (revision 28); empty for a group.
  item_ids: z.array(hex12).default([]),
  group: z.string().nullable().default(null),
  text: z.string(),
  children: z.array(BulletChild).max(LAYOUT_CAPS.MAX_CHILDREN).default([]),
  alert_key: z.string().nullable().default(null),
}).strict().refine((b) => (b.kind === 'item' ? b.item_id !== null : b.group !== null), {
  message: 'an item bullet needs item_id; group and alerts bullets need group',
  path: ['item_id'],
});

const Brief = z.object({
  run_id: z.string(),
  kind: enums.BriefKind,
  headline: z.string(),
  bullets: z.array(Bullet).max(LAYOUT_CAPS.BODY_SLOTS),
  // The thread bullets (revision 28): one group bullet per programme reply and one for the Other reply.
  thread: z.array(Bullet).default([]),
  expected_load_notice: z.string().nullable(),
  checked: z.object({ projects: z.number().int(), panels: z.number().int(), candidates: z.number().int() }).strict(),
  degradation_notice: z.string().nullable(),
  notices: z.array(z.string()).default([]),
  image: z.object({ path: z.string(), slack_file_id: z.string().nullable() }).strict().nullable(),
  // The one-page report shared into the thread (FR-022, revision 23); null for a heartbeat or a failure.
  report: z.object({ path: z.string(), slack_file_id: z.string().nullable(), ts: z.string().nullable() })
    .strict().nullable().default(null),
  footer: z.object({
    specs_url: z.string(),
    config_url: z.string(),
    trace_url: z.string().nullable(),
    cost_usd: z.number(),
  }).strict(),
  publication: Publication.nullable(),
}).strict().refine((b) => b.kind !== 'degraded' || Boolean(b.degradation_notice), {
  message: 'degradation_notice is required for a degraded brief',
  path: ['degradation_notice'],
});

// A thread reply (FR-020, FR-066, revision 28): a programme, the Other reply or the alerts reply; an item's or an
// alert group's own reply until then, when exactly one of item_id and alert_key was set.
const ThreadReply = z.object({
  kind: z.enum(['item', 'alerts', 'programme', 'other']).default('item'),
  group: z.string().nullable().default(null),
  item_id: hex12.nullable(),
  alert_key: z.string().nullable().default(null),
  run_id: z.string(),
  text: z.string(),
  publication: Publication.nullable(),
}).strict().refine((r) => (r.kind === 'programme' || r.kind === 'other' || r.kind === 'alerts')
  || (r.item_id === null) !== (r.alert_key === null), {
  message: 'a thread reply belongs to one item or one alert group',
  path: ['item_id'],
});

const AlertRule = z.object({
  rule_uid: z.string().nullable(),
  title: z.string().min(1),
  folder: z.string().nullable(),
  rule_group: z.string().nullable(),
  pending_for: z.string().nullable(),
  dashboard_uid: z.string().nullable(),
  panel_id: z.number().int().nullable(),
  health: z.string().nullable(),
  state: enums.AlertState,
  category: z.string().min(1),
  importance: enums.AlertImportance,
  known: z.boolean(),
}).strict();

const AlertInstance = z.object({
  instance_id: hex12,
  rule_uid: z.string().nullable(),
  title: z.string().min(1),
  host: host.nullable(),
  project_url: url.nullable(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.any()),
  state: enums.AlertState,
  active_at: isoTimestamp.nullable(),
  value: z.string().nullable(),
  dashboard_uid: z.string().nullable(),
  panel_id: z.number().int().nullable(),
  group: z.string().min(1),
  category: z.string().min(1),
  importance: enums.AlertImportance,
  known: z.boolean(),
  started_at: isoTimestamp,
  days_firing: z.number().int().min(0),
  stale: z.boolean(),
  new: z.boolean(),
  // Revision 14: a stale alert on a host with no data is housekeeping (FR-080); the metric behind the alert (FR-079).
  housekeeping: z.boolean().default(false),
  evidence: z.object({
    metric: z.string(), aggregate: z.string(), current_value: z.number().nullable(),
    previous_day_value: z.number().nullable(), pct_change_vs_previous_day: z.number().nullable(),
  }).strict().nullable().default(null),
}).strict();

const AlertGroupMember = z.object({
  instance_id: hex12,
  title: z.string(),
  host: host.nullable(),
  started_at: isoTimestamp,
  days_firing: z.number().int().min(0),
  stale: z.boolean(),
  new: z.boolean(),
  evidence: z.any().nullable().default(null),
}).strict();

const AlertGroup = z.object({
  alert_key: z.string().min(1),
  group: z.string().min(1),
  category: z.string().min(1),
  importance: enums.AlertImportance,
  firing: z.number().int().min(1),
  new: z.number().int().min(0),
  stale: z.number().int().min(0),
  oldest_started_at: isoTimestamp,
  rule_uids: z.array(z.string()),
  titles: z.array(z.string()),
  instance_ids: z.array(hex12),
  hosts: z.array(z.string()),
  instances: z.array(AlertGroupMember),
  patterns: z.array(z.object({
    group: z.string(), category: z.string(), title: z.string(), count: z.number().int(), of: z.number().int(),
    since_min: z.string(), since_max: z.string(), hosts: z.array(z.string()), instance_ids: z.array(z.string()),
  }).strict()).default([]),
}).strict();

const AlertEpisode = z.object({
  episode_id: hex12,
  event: enums.EpisodeEvent,
  run_id: z.string(),
  at: isoTimestamp,
  instance_id: hex12,
  rule_uid: z.string().nullable(),
  title: z.string(),
  host: host.nullable(),
  project_url: url.nullable(),
  group: z.string(),
  category: z.string(),
  importance: enums.AlertImportance,
  started_at: isoTimestamp,
  cleared_at: isoTimestamp.nullable(),
  duration_hours: z.number().min(0).nullable(),
  correlations: z.object({
    expected_load_window_id: z.string().nullable(),
    version_change: z.object({ from: z.string(), to: z.string(), observed: isoTimestamp }).strict().nullable(),
    related_candidates: z.array(z.string()),
    related_items: z.array(z.string()),
  }).strict(),
  explanation: z.object({ item_id: hex12, why_now: z.string() }).strict().nullable(),
}).strict();

const Feedback = z.object({
  feedback_id: hex12,
  date: isoDate,
  run_id: z.string(),
  target: enums.FeedbackTarget,
  item_id: hex12.nullable(),
  // Feedback on an alert-group reply (FR-066): recorded and acknowledged, never a ranking input.
  alert_key: z.string().nullable().default(null),
  kind: enums.FeedbackKind,
  verdict: enums.FeedbackVerdict.nullable(),
  note: z.string().nullable(),
  horizon: isoDate.nullable(),
  author: z.string(),
  matched: z.boolean(),
  source_ts: z.string(),
  // User Story 7: set once by the run whose digest acknowledged the record; a note's review outcome.
  acknowledged_run_id: z.string().nullable().default(null),
  classification: enums.FeedbackClassification.nullable().default(null),
  proposal_id: z.string().nullable().default(null),
  // Revision 34: what the note's parse found besides the horizon, so a stored horizon keeps its size and its
  // provenance; how the horizon was found; and how many review calls failed on the note (FR-029, FR-061).
  expected_max: z.number().nullable().default(null),
  observed_value: z.number().nullable().default(null),
  horizon_source: z.enum(['deterministic', 'model', 'model-invalid', 'model-failed', 'none']).nullable().default(null),
  review_attempts: z.number().int().min(0).default(0),
}).strict().refine((f) => f.target !== 'item' || f.item_id, {
  message: 'item_id is required when target is item',
  path: ['item_id'],
}).refine((f) => f.target !== 'alert_group' || f.alert_key, {
  message: 'alert_key is required when target is alert_group',
  path: ['alert_key'],
});

const MemoryMeta = z.object({
  path: z.string(),
  max_tokens: z.number().int(),
  version: z.number().int().min(0),
  diffs: z.array(z.string()),
}).strict();

const Flag = z.object({ kind: enums.FlagKind, excerpt: z.string() }).strict();

const Proposal = z.object({
  proposal_id: z.string(),
  type: enums.ProposalType,
  run_id: z.string(),
  title: z.string(),
  body: z.string(),
  evidence: z.array(z.any()),
  flags: z.array(Flag),
  status: enums.ProposalStatus,
}).strict();

const CorpusItem = z.object({
  relative_path: z.string(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().min(0),
  kind: enums.CorpusKind,
  status: enums.CorpusStatus,
  skipped_reason: z.string().nullable(),
  distilled_at: isoTimestamp.nullable(),
  card_ids: z.array(z.string()),
}).strict();

const PatternCard = z.object({
  card_id: z.string(),
  title: z.string(),
  symptom: z.string(),
  metrics: z.array(z.object({ metric: z.string(), shape: z.string() }).strict()),
  watchdog_appearance: z.string(),
  root_cause: z.string(),
  resolution: z.string(),
  confirmation_steps: z.array(z.string()),
  false_positives: z.array(z.string()),
  sources: z.array(z.string()),
  status: enums.CardStatus,
}).strict();

const CalibrationReport = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  entries: z.array(z.object({
    project_url: url,
    metric: z.string(),
    distribution: z.record(z.string(), z.number()),
    outcomes: z.object({
      confirmed: z.number().int(),
      dismissed: z.number().int(),
      unreviewed: z.number().int(),
      // Candidates the analysis examined and set aside that no person has judged (FR-014a, revision 20).
      model_dismissed: z.number().int(),
    }).strict(),
    // What the rule raised for this metric and what became of it, so a rule that raises noise daily is visible.
    selection: z.object({
      raised: z.number().int(),
      became_items: z.number().int(),
      set_aside: z.number().int(),
      reasons: z.array(z.object({ reason: z.string(), count: z.number().int() }).strict()),
    }).strict(),
    current_threshold: z.number().nullable(),
    suggested_threshold: z.number().nullable(),
    effect_last_30d: z.object({
      items_kept: z.number().int(),
      items_dropped: z.number().int(),
      confirmed_kept: z.number().int(),
    }).strict(),
  }).strict()),
  pass_change_rate: z.number().min(0).max(1),
  // Metric pairs the analysis reported as related, commonest first (FR-009, revision 20).
  related_metric_pairs: z.array(z.object({
    metrics: z.array(z.string()).length(2),
    relation: z.enum(['level_of', 'rate_of', 'same_cause', 'consequence_of']),
    count: z.number().int(),
  }).strict()),
  feedback_rate: z.object({
    window_days: z.number().int(),
    overall: z.number().nullable(),
    by_month: z.array(z.object({ month: z.string(), rate: z.number().nullable(), items: z.number().int() }).strict()),
  }).strict().optional(),
  proposals: z.array(z.string()),
  open_proposals: z.array(z.object({
    proposal_id: z.string(),
    type: enums.ProposalType,
    age_days: z.number().int().min(0),
  }).strict()).optional(),
}).strict();

const PriorityList = z.object({
  dashboards: z.array(z.object({
    uid: z.string(),
    title: z.string().nullable(),
    panel_ids: z.array(z.number().int()),
  }).strict()),
}).strict();

const CostRecord = z.object({
  run_id: z.string(),
  project_url: url.nullable(),
  stage: z.string(),
  pass: z.number().int().nullable(),
  model: z.string(),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
  cache_creation_tokens: z.number().int().min(0),
  cost_usd: z.number().min(0),
  num_turns: z.number().int().nullable(),
  duration_ms: z.number().nullable(),
}).strict();

const schemas = {
  ScrapeTarget, ExpectedLoadWindow, Project, Stage, Usage, Publication, Run, PanelRef, MetricWindow, ComputedChange,
  Evidence, Candidate, DashboardRef, PassChangeRecord, Item, Check, VerificationReport, Pass, BulletChild, Bullet,
  Brief, ThreadReply, AlertRule, AlertInstance, AlertGroup, AlertGroupMember, AlertEpisode,
  Feedback, MemoryMeta, Flag, Proposal, CorpusItem, PatternCard, CalibrationReport, PriorityList, CostRecord,
};

module.exports = {
  LAYOUT_CAPS, schemas, enums };

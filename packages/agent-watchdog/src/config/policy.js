'use strict';
// Structured, reviewed policy files: projects.yaml (annotations, programme groups, ignore list), dashboards.yaml,
// thresholds.yaml (FR-053, FR-068, contracts/config-files.md).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { z } = require('zod');

const CONFIG_EXIT_CODE = 78;

class PolicyError extends Error {
  constructor(file, problems) {
    super(`invalid policy in ${file}: ${problems.join('; ')}`);
    this.name = 'PolicyError';
    this.code = CONFIG_EXIT_CODE;
    this.file = file;
    this.problems = problems;
  }
}

/** Lowercase a host and strip scheme, `www.`, path and trailing slashes so a pasted URL matches the instance label. */
const normaliseHost = (value) => String(value).trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  .replace(/^www\./, '')
  .replace(/\/.*$/, '')
  .replace(/\/+$/, '');

const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const timezone = z.string().refine(isValidTimezone, { message: 'invalid IANA timezone' });

// Host globs (FR-068): lowercase host characters plus `*` (any run of characters) and `?` (one character).
const GLOB_PATTERN = /^[a-z0-9*?.:-]+$/;
const RESERVED_GROUPS = Object.freeze(['Other', 'Watchdog']);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchored regular expression for a host glob; no glob library for two wildcards. */
const globToRegExp = (pattern) => new RegExp(`^${String(pattern).split(/([*?])/).map((part) => {
  if (part === '*') {
    return '.*';
  }
  return part === '?' ? '.' : escapeRegExp(part);
}).join('')}$`);

const matchesGlob = (host, pattern) => globToRegExp(pattern).test(host);

const hostGlob = z.string().min(1)
  .regex(GLOB_PATTERN, 'expected a lowercase host glob (letters, digits, ".", "-", ":", "*" and "?")')
  .refine((pattern) => !pattern.startsWith('www.'), { message: 'drop the www. prefix; hosts are matched without it' });

const ProjectGroup = z.object({
  label: z.string().min(1, 'label is required').max(40, 'label is at most 40 characters'),
  host_patterns: z.array(hostGlob).min(1, 'host_patterns needs at least one glob'),
}).strict().refine((group) => !RESERVED_GROUPS.includes(group.label), {
  message: `label is reserved (${RESERVED_GROUPS.join(', ')})`,
  path: ['label'],
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const ExpectedLoadWindow = z.object({
  id: z.string().min(1),
  kind: z.enum(['month_end', 'dates', 'weekly']),
  days_before: z.number().int().min(0).optional(),
  days_after: z.number().int().min(0).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  timezone,
  note: z.string(),
  cycle_days: z.number().int().min(1),
}).strict();

const ThresholdOverride = z.object({
  pct_change_vs_previous_day: z.number().positive().optional(),
  deviation_sigma_vs_trailing: z.number().positive().optional(),
  monotonic_rise_hours: z.number().positive().optional(),
}).strict();

const ProjectAnnotation = z.object({
  owner: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  host_metrics: z.boolean().optional(),
  thresholds: ThresholdOverride.optional(),
  expected_load_windows: z.array(ExpectedLoadWindow).optional(),
}).strict();

const ProjectsFile = z.object({
  defaults: z.object({ expected_load_windows: z.array(ExpectedLoadWindow).optional() }).strict().optional(),
  projects: z.record(z.string(), ProjectAnnotation).default({}),
  groups: z.array(ProjectGroup).default([]),
  ignore: z.array(hostGlob).default([]),
}).strict().refine((file) => new Set(file.groups.map((g) => g.label)).size === file.groups.length, {
  message: 'group labels must be unique',
  path: ['groups'],
});

const DashboardsFile = z.object({
  datasource_uid_env: z.string().optional(),
  dashboards: z.array(z.object({
    uid: z.string().min(1),
    title: z.string().optional(),
    panels: z.array(z.number().int()).default([]),
  }).strict()).min(1),
}).strict().refine((file) => new Set(file.dashboards.map((d) => d.uid)).size === file.dashboards.length, {
  message: 'dashboard uid values must be unique',
  path: ['dashboards'],
});

// Only the three FR-014 high-severity rules are accepted; a new rule needs a code change and a spec amendment.
const HIGH_RULES = Object.freeze({
  scrape_target: 'down',
  outbound_push_backlog: 'gt',
  sentinel_backlog: 'gt_multiple_of_baseline',
});

const HighRule = z.object({
  role: z.enum(['scrape_target', 'outbound_push_backlog', 'sentinel_backlog']),
  condition: z.enum(['down', 'gt', 'gt_multiple_of_baseline']),
  value: z.number().optional(),
}).strict().refine((rule) => HIGH_RULES[rule.role] === rule.condition, {
  message: 'only the FR-014 high rules are allowed',
  path: ['condition'],
});

const ThresholdsFile = z.object({
  trailing_days: z.number().int().min(2),
  candidate_rules: z.object({
    pct_change_vs_previous_day: z.number().positive(),
    deviation_sigma_vs_trailing: z.number().positive(),
    monotonic_rise_hours: z.number().positive(),
  }).strict(),
  severity: z.object({
    default: z.enum(['low', 'medium', 'high']),
    medium_when: z.array(z.enum(['two_or_more_rules_fire'])).default([]),
    high_when: z.array(HighRule),
  }).strict(),
  metric_roles: z.object({
    scrape_target: z.string().min(1),
    outbound_push_backlog: z.string().min(1),
    sentinel_backlog: z.string().min(1),
  }).strict(),
  display: z.object({ persisting_days_label: z.string() }).strict().optional(),
}).strict();

const FILES = [
  { name: 'projects.yaml', key: 'projects', schema: ProjectsFile },
  { name: 'dashboards.yaml', key: 'dashboards', schema: DashboardsFile },
  { name: 'thresholds.yaml', key: 'thresholds', schema: ThresholdsFile },
];

const formatIssues = (error) => error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

const readPolicyFile = (configDir, defaultsDir, name) => {
  const deployed = path.join(configDir, name);
  if (fs.existsSync(deployed)) {
    return { file: deployed, content: fs.readFileSync(deployed, 'utf8') };
  }
  const fallback = path.join(defaultsDir, name);
  return { file: fallback, content: fs.readFileSync(fallback, 'utf8') };
};

const parseYaml = (file, content) => {
  try {
    const doc = YAML.parse(content, { schema: 'core' });
    return doc === null || doc === undefined ? {} : doc;
  } catch (error) {
    throw new PolicyError(file, [`YAML parse error: ${error.message}`]);
  }
};

const normaliseProjects = (projects) => {
  const out = {
    defaults: projects.defaults || { expected_load_windows: [] },
    projects: {},
    groups: projects.groups || [],
    ignore: projects.ignore || [],
  };
  if (!out.defaults.expected_load_windows) {
    out.defaults.expected_load_windows = [];
  }
  for (const [key, value] of Object.entries(projects.projects || {})) {
    out.projects[normaliseHost(key)] = value;
  }
  return out;
};

/**
 * Load and validate the three policy files, falling back to the package defaults per file.
 * @returns {{ projects: object, dashboards: object, thresholds: object, hash: string, sources: object }}
 */
const loadPolicy = ({ configDir, defaultsDir }) => {
  const result = { sources: {} };
  const hash = crypto.createHash('sha256');
  for (const { name, key, schema } of FILES) {
    const { file, content } = readPolicyFile(configDir, defaultsDir, name);
    hash.update(`${name}\n${content}\n`);
    const parsed = schema.safeParse(parseYaml(file, content));
    if (!parsed.success) {
      throw new PolicyError(file, formatIssues(parsed.error));
    }
    result[key] = key === 'projects' ? normaliseProjects(parsed.data) : parsed.data;
    result.sources[key] = file;
  }
  result.hash = hash.digest('hex');
  return result;
};

module.exports = {
  loadPolicy, normaliseHost, PolicyError, ExpectedLoadWindow, ThresholdsFile, DashboardsFile, ProjectsFile, HIGH_RULES,
  globToRegExp, matchesGlob, RESERVED_GROUPS,
};

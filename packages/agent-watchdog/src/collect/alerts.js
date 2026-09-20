'use strict';
// Grafana-managed alert rules and their firing instances, read from the hosted watchdog with the same read-only
// token as the metrics (FR-064, research.md R-14). Everything Grafana returns is data: stored verbatim under `raw`,
// normalised into rules and instances, and never trusted as instructions. An unavailable alerting API is recorded
// as such; the run continues without alerts.
const crypto = require('node:crypto');
const { normaliseHost } = require('../config/policy');
const { projectUrlFor } = require('../model/identity');
const { ignoredBy } = require('./discovery');

const noop = { debug() {}, info() {}, warn() {}, error() {} };

const STATE_MAP = {
  alerting: 'firing', firing: 'firing', pending: 'pending', nodata: 'nodata', error: 'error', normal: 'normal',
  inactive: 'normal',
};

/** Grafana's state names, compared case-insensitively; `alerting` is `firing` (R-14). */
const normaliseState = (state) => {
  const key = String(state === undefined || state === null ? 'normal' : state).toLowerCase();
  return STATE_MAP[key] || 'normal';
};

const hash12 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Instance identity: the rule and its labels other than alertname, in sorted order (data-model.md Alert Instance). */
const instanceIdFor = (ruleUid, labels = {}) => {
  const labelText = Object.entries(labels)
    .filter(([key]) => key !== 'alertname')
    .sort()
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return hash12(`${ruleUid}|${labelText}`);
};

const durationText = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  if (n % 3600 === 0) {
    return `${n / 3600}h`;
  }
  return n % 60 === 0 ? `${n / 60}m` : `${n}s`;
};

const isoOrNull = (value) => {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  // Go's zero time marks "never active".
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

const panelIdOf = (annotations) => {
  const raw = annotations && annotations.__panelId__;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
};

const hostOfLabels = (labels) => (labels && labels.instance ? normaliseHost(labels.instance) : null);

const instanceRecord = ({ ruleUid, title, alert, ruleAnnotations = {} }) => {
  const labels = alert.labels || {};
  const annotations = { ...ruleAnnotations, ...(alert.annotations || {}) };
  const host = hostOfLabels(labels);
  return {
    instance_id: instanceIdFor(ruleUid || title, labels),
    rule_uid: ruleUid || null,
    title,
    host,
    project_url: host ? projectUrlFor(host) : null,
    labels,
    annotations,
    state: normaliseState(alert.state),
    active_at: isoOrNull(alert.activeAt),
    value: alert.value === undefined || alert.value === null ? null : String(alert.value),
    dashboard_uid: annotations.__dashboardUid__ || null,
    panel_id: panelIdOf(annotations),
  };
};

const ruleRecord = (group, rule, folder) => {
  const annotations = rule.annotations || ((rule.alerts || [])[0] || {}).annotations || {};
  return {
    rule_uid: rule.uid || null,
    title: rule.name,
    folder: group.file || folder || null,
    rule_group: group.name || null,
    pending_for: durationText(rule.duration),
    dashboard_uid: annotations.__dashboardUid__ || null,
    panel_id: panelIdOf(annotations),
    health: rule.health || null,
    state: normaliseState(rule.state),
  };
};

const reasonOf = (error) => (error && error.message ? error.message : String(error));

/** Split instances into kept and ignored (development hosts, FR-068), the latter with the pattern that matched. */
const partitionIgnored = (instances, ignorePatterns) => {
  const kept = [];
  const ignored = [];
  for (const instance of instances) {
    const pattern = instance.host ? ignoredBy(instance.host, ignorePatterns) : null;
    if (pattern) {
      ignored.push({ host: instance.host, pattern, title: instance.title });
    } else {
      kept.push(instance);
    }
  }
  return { kept, ignored };
};

/**
 * Read the alerting state of the hosted watchdog: the rules endpoint (rules with their instances), or the alerts
 * endpoint alone when the rules endpoint fails, or `available: false` with the reasons when neither answers.
 * Never throws (FR-064: the brief says alerts were unavailable and the run completes).
 */
const collectAlerts = async ({ grafana, policy, logger = noop, now = new Date() }) => {
  const at = now instanceof Date ? now : new Date(now);
  const base = {
    available: false, reason: null, fetched_at: at.toISOString(), source: null, pages: 0, rules: [], instances: [],
    ignored: [], raw: [],
  };
  const ignorePatterns = (policy && policy.projects && policy.projects.ignore) || [];
  let rulesError = null;
  try {
    const { groups, pages, raw } = await grafana.alertRules();
    const rules = [];
    const instances = [];
    for (const group of groups || []) {
      for (const rule of group.rules || []) {
        const record = ruleRecord(group, rule, policy && policy.alerts && policy.alerts.folder);
        rules.push(record);
        for (const alert of rule.alerts || []) {
          instances.push(instanceRecord({
            ruleUid: record.rule_uid, title: record.title, alert, ruleAnnotations: rule.annotations || {},
          }));
        }
      }
    }
    const { kept, ignored } = partitionIgnored(instances, ignorePatterns);
    logger.info('alerts.collected', {
      source: 'rules', pages, rules: rules.length, instances: kept.length,
      firing: kept.filter((i) => i.state === 'firing').length, ignored: ignored.length,
    });
    return { ...base, available: true, source: 'rules', pages, rules, instances: kept, ignored, raw };
  } catch (error) {
    rulesError = error;
    logger.warn('alerts.rules_unavailable', { reason: reasonOf(error) });
  }
  try {
    const alerts = await grafana.alertInstances();
    const instances = alerts.map((alert) => instanceRecord({
      ruleUid: (alert.labels || {}).__alert_rule_uid__ || null,
      title: (alert.labels || {}).alertname || 'unknown',
      alert,
    }));
    const { kept, ignored } = partitionIgnored(instances, ignorePatterns);
    logger.info('alerts.collected', {
      source: 'alerts', instances: kept.length, firing: kept.filter((i) => i.state === 'firing').length,
      ignored: ignored.length,
    });
    return {
      ...base, available: true, source: 'alerts', pages: 1, instances: kept, ignored, raw: [{ data: { alerts } }],
    };
  } catch (error) {
    const reason = `rules endpoint: ${reasonOf(rulesError)}; alerts endpoint: ${reasonOf(error)}`;
    logger.warn('alerts.unavailable', { reason });
    return { ...base, available: false, reason };
  }
};

module.exports = { collectAlerts, normaliseState, instanceIdFor, durationText, hostOfLabels, partitionIgnored };

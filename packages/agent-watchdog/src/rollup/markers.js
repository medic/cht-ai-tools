'use strict';
// Status and severity markers (FR-015, FR-082): a small fixed vocabulary of emoji placed by code on the rendered
// brief. Stored texts stay plain; the Slack payload and the report add the marker when they render.
const MARKERS = Object.freeze({
  brief: '📋',
  heartbeat: '✅',
  degraded: '⚠️',
  failure: '❌',
  alerts: '🚨',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  resolved: '✅',
  housekeeping: '🧹',
  newProject: '🆕',
  warning: '⚠️',
  pattern: '🔁',
  expectedLoad: '📅',
});

const SEVERITY_ORDER = ['high', 'medium', 'low'];

const headlineMarker = (brief) => {
  const bullets = brief.bullets || [];
  if (brief.kind === 'brief' && bullets.length && bullets.every((b) => b.kind === 'alerts')) {
    return MARKERS.alerts;
  }
  return MARKERS[brief.kind] || MARKERS.brief;
};

/** The marker of a bullet: alarm for alerts, the item's severity, or a group's worst child severity. */
const bulletMarker = (bullet, severityOf) => {
  if (bullet.kind === 'alerts') {
    return MARKERS.alerts;
  }
  const ids = bullet.kind === 'group' ? (bullet.children || []).map((c) => c.item_id) : [bullet.item_id];
  const severities = ids.map((id) => severityOf(id)).filter(Boolean);
  const worst = SEVERITY_ORDER.find((s) => severities.includes(s));
  return worst ? MARKERS[worst] : '';
};

const NOTICE_MARKERS = [
  [/^Resolved /, MARKERS.resolved],
  [/^Housekeeping:/, MARKERS.housekeeping],
  [/^(First run|New project)/, MARKERS.newProject],
  [/^(Analysis incomplete|Alerts unavailable|Degraded)/, MARKERS.warning],
];

const noticeMarker = (text) => {
  const found = NOTICE_MARKERS.find(([pattern]) => pattern.test(String(text)));
  return found ? found[1] : '';
};

const withMarker = (marker, text) => (marker ? `${marker} ${text}` : text);

module.exports = { MARKERS, headlineMarker, bulletMarker, noticeMarker, withMarker };

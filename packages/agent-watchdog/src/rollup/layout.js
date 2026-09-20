'use strict';
// The body layout (data-model.md Bullet; FR-010, FR-069): five top-level slots of at most two lines, each holding one
// item or, for a programme with several flagged items, up to eight one-line sub-bullets. Computed by code before the
// roll-up call so the model writes only item text; the gate rejects a draft whose item ids differ from the layout.

const BODY_SLOTS = 5;
const MAX_CHILDREN = 8;
// Hosts matching no programme pattern: never collapsed into a group bullet, since a fallback bucket is not a programme.
const UNGROUPED = 'Other';
// Alerts without an `instance` label (User Story 8).
const WATCHDOG = 'Watchdog';

/**
 * Lay out ranked entries: an entry whose programme already holds a slot joins it as a sub-bullet while the slot has
 * fewer than `maxChildren`; otherwise it opens a slot while fewer than `slots` are open; otherwise it goes to the
 * thread. A slot with one entry is an `item` bullet, with several a `group` bullet.
 * @param {Array<{ key: string, group: string }>} entries in rank order
 * @returns {{ slots: Array<{ slot: number, kind: string, group: string, keys: string[] }>, body: string[],
 *   thread: string[], one_line: string[] }} body lists keys in slot order, one_line the keys that are sub-bullets
 */
const layoutEntries = (entries, { slots: maxSlots = BODY_SLOTS, maxChildren = MAX_CHILDREN } = {}) => {
  const slots = [];
  const open = new Map();
  const openAlerts = new Map();
  const thread = [];
  const alertsThread = [];
  for (const entry of entries) {
    const group = entry.group || UNGROUPED;
    const isAlerts = entry.type === 'alerts';
    // Alert Groups of one programme share one `alerts` slot, a sub-bullet per category, and never mix with items.
    const collapsible = isAlerts || group !== UNGROUPED;
    const shared = collapsible ? (isAlerts ? openAlerts : open).get(group) : undefined;
    const overflow = isAlerts ? alertsThread : thread;
    if (shared) {
      if (shared.keys.length < maxChildren) {
        shared.keys.push(entry.key);
      } else {
        overflow.push(entry.key);
      }
      continue;
    }
    if (slots.length < maxSlots) {
      const slot = { slot: slots.length + 1, kind: isAlerts ? 'alerts' : 'item', group, keys: [entry.key] };
      slots.push(slot);
      if (collapsible) {
        (isAlerts ? openAlerts : open).set(group, slot);
      }
      continue;
    }
    overflow.push(entry.key);
  }
  for (const slot of slots) {
    if (slot.kind !== 'alerts') {
      slot.kind = slot.keys.length > 1 ? 'group' : 'item';
    }
  }
  const itemSlots = slots.filter((slot) => slot.kind !== 'alerts');
  return {
    slots,
    body: itemSlots.flatMap((slot) => slot.keys),
    thread,
    one_line: itemSlots.filter((slot) => slot.kind === 'group').flatMap((slot) => slot.keys),
    alerts_body: slots.filter((slot) => slot.kind === 'alerts').flatMap((slot) => slot.keys),
    alerts_thread: alertsThread,
  };
};

/** The stored form (rollup/layout.json): slots with item ids and one-line flags, body and thread ids. */
const toLayoutDocument = (layout) => ({
  slots: layout.slots.map((slot) => ({
    slot: slot.slot,
    kind: slot.kind,
    group: slot.group,
    item_ids: slot.kind === 'alerts' ? [] : [...slot.keys],
    alert_keys: slot.kind === 'alerts' ? [...slot.keys] : [],
    one_line: slot.kind === 'group',
  })),
  body_items: [...layout.body],
  thread_items: [...layout.thread],
  one_line: [...layout.one_line],
  body_alerts: [...(layout.alerts_body || [])],
  thread_alerts: [...(layout.alerts_thread || [])],
});

/** Map a project url to its Project Group label from a discovery document; unknown hosts are `Other`. */
const groupOfProjects = (discovery) => {
  const byUrl = new Map(((discovery && discovery.projects) || []).map((p) => [p.url, p.group || UNGROUPED]));
  return (projectUrl) => byUrl.get(projectUrl) || UNGROUPED;
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
// Alert Groups rank among items by importance: critical before every item, otherwise after the items of the same
// severity (FR-066).
const ALERT_RANK = { critical: -1, high: 0, medium: 1, low: 2 };

/**
 * The ranked items and the Alert Groups as one ordered list of layout entries.
 * @param {object[]} items ranked items (severity, item_id, project_url)
 * @param {object[]} alertGroups Alert Groups (alert_key, group, importance)
 * @param {(projectUrl: string) => string} [groupOf]
 */
const interleaveAlerts = (items, alertGroups = [], groupOf = () => UNGROUPED) => [
  ...items.map((item, order) => ({
    key: item.item_id, group: groupOf(item.project_url), type: 'item',
    primary: SEVERITY_RANK[item.severity] === undefined ? 2 : SEVERITY_RANK[item.severity], secondary: 0, order,
  })),
  ...alertGroups.map((group, order) => ({
    key: group.alert_key, group: group.group, type: 'alerts',
    primary: ALERT_RANK[group.importance] === undefined ? 1 : ALERT_RANK[group.importance], secondary: 1, order,
  })),
].sort((a, b) => a.primary - b.primary || a.secondary - b.secondary || a.order - b.order)
  .map(({ key, group, type }) => ({ key, group, type }));

/**
 * Lay out ranked items by their project's group, with the Alert Groups placed among them by importance.
 * @param {object[]} items ranked items
 * @param {{ groupOf?: (projectUrl: string) => string, alertGroups?: object[] }} [options]
 */
const buildLayout = (items, { groupOf = () => UNGROUPED, alertGroups = [] } = {}) => toLayoutDocument(
  layoutEntries(interleaveAlerts(items, alertGroups, groupOf)),
);

/** Slot number per key, for placement. */
const slotByKey = (layoutDocument) => {
  const out = new Map();
  for (const slot of layoutDocument.slots) {
    for (const id of slot.item_ids) {
      out.set(id, slot.slot);
    }
  }
  return out;
};

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The group line, written by code (FR-069): "MoH Nepal: 3 projects with issues". */
const groupBulletText = ({ label, projects, issues }) => (issues === projects
  ? `${label}: ${plural(projects, 'project')} with issues`
  : `${label}: ${plural(projects, 'project')} with ${plural(issues, 'issue')}`);

/** The alerts line, written by code (FR-066): "MoH Nepal alerts: 15 firing, 3 stale for more than 14 days". */
const alertsBulletText = ({ label, firing, stale, staleAfterDays }) => (stale > 0
  ? `${label} alerts: ${firing} firing, ${stale} stale for more than ${staleAfterDays} days`
  : `${label} alerts: ${firing} firing, none stale`);

const MAX_TITLES_IN_LINE = 2;

/** One sub-bullet per category, written by code: count, rules, oldest start, stale and new counts. */
const alertCategoryLine = (group) => {
  const titles = group.titles || [];
  const shown = titles.slice(0, MAX_TITLES_IN_LINE).join(', ');
  const more = titles.length > MAX_TITLES_IN_LINE ? `, +${titles.length - MAX_TITLES_IN_LINE} more` : '';
  const parts = [`${group.category}: ${group.firing} firing (${shown}${more})`];
  parts.push(`oldest since ${String(group.oldest_started_at).slice(0, 10)}`);
  if (group.stale > 0) {
    parts.push(`${group.stale} stale`);
  }
  if (group.new > 0) {
    parts.push(`${group.new} new`);
  }
  return parts.join(', ');
};

const alertsBullet = (slot, alertGroups, staleAfterDays) => {
  const groups = slot.alert_keys.map((key) => alertGroups.find((g) => g.alert_key === key)).filter(Boolean);
  const firing = groups.reduce((sum, g) => sum + g.firing, 0);
  const stale = groups.reduce((sum, g) => sum + g.stale, 0);
  return {
    kind: 'alerts',
    item_id: null,
    group: slot.group,
    text: alertsBulletText({ label: slot.group, firing, stale, staleAfterDays }),
    children: groups.map((g) => ({ item_id: null, text: alertCategoryLine(g) })),
    alert_key: groups.length === 1 ? groups[0].alert_key : slot.group,
  };
};

/**
 * Build Bullet entities from a layout document. `textFor(id)` gives an entry's line (the model's for items, code's
 * for candidates); `hostFor(id)` its project host, to count the projects behind a group line. Alert bullets are
 * entirely code-built from the Alert Groups (FR-066).
 */
const assembleBullets = ({
  layout, textFor, hostFor, alertGroups = [], staleAfterDays = 14,
}) => layout.slots.map((slot) => {
  if (slot.kind === 'alerts') {
    return alertsBullet(slot, alertGroups, staleAfterDays);
  }
  if (slot.kind === 'group') {
    const children = slot.item_ids.map((id) => ({ item_id: id, text: textFor(id) }));
    const projects = new Set(slot.item_ids.map(hostFor)).size;
    return {
      kind: 'group',
      item_id: null,
      group: slot.group,
      text: groupBulletText({ label: slot.group, projects, issues: children.length }),
      children,
      alert_key: null,
    };
  }
  const [id] = slot.item_ids;
  return { kind: 'item', item_id: id, group: slot.group, text: textFor(id), children: [], alert_key: null };
});

module.exports = {
  layoutEntries, toLayoutDocument, buildLayout, interleaveAlerts, groupOfProjects, slotByKey, groupBulletText,
  alertsBulletText, alertCategoryLine, assembleBullets, BODY_SLOTS, MAX_CHILDREN, UNGROUPED, WATCHDOG,
};

'use strict';
// The body and thread layout (data-model.md "Layout rule"; FR-010, FR-020, FR-069, revision 28). Computed by code
// before the roll-up call so the model writes only the project lines: the programmes of the two highest-ranked items
// fill the body, each with at most three project lines and a count of the rest; every other programme with two or
// more flagged projects gets a thread reply of its own; the remaining projects share one "Other" reply. Alerts take
// no slot. The gate rejects a draft whose lead ids differ from the layout's entries.

const { LAYOUT_CAPS } = require('../model/schemas');

// The caps live with the entity schema (src/model/schemas.js): the "more projects" line follows the three
// project lines, so a bullet has at most four children.
const { BODY_SLOTS, MAX_PROJECTS, MAX_CHILDREN } = LAYOUT_CAPS;
const OWN_REPLY_MIN_PROJECTS = 2;
// Hosts matching no programme pattern: a fallback bucket, not a programme, so each of its projects is a unit of one in
// the body and all of them share the Other reply in the thread.
const UNGROUPED = 'Other';
// Alerts without an `instance` label (User Story 8).
const WATCHDOG = 'Watchdog';
const PREFIX_SEPARATOR = ': ';
const MAX_LINE_CHARS = 120;

const hostOfUrl = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
};

/**
 * A project's short name for a sub-bullet (FR-069, revision 26): the host's first label, or two labels when another
 * member of the same programme shares the first, so `north-a.example.org` reads `north-a` and two `cht.*` hosts keep
 * their second label.
 */
const shortHostLabel = (host, siblings = []) => {
  const labels = String(host || '').toLowerCase().split('.');
  const first = labels[0];
  const clash = siblings.some((other) => other !== host && String(other || '').toLowerCase().split('.')[0] === first);
  return clash && labels.length > 1 ? `${labels[0]}.${labels[1]}` : first;
};

/**
 * The ranked items as programmes of projects, each in rank order of its best item; `order` is the index of that
 * best item, the unit's rank among units.
 */
const programmesOf = (items, groupOf) => {
  const byLabel = new Map();
  items.forEach((item, order) => {
    const label = groupOf(item.project_url) || UNGROUPED;
    if (!byLabel.has(label)) {
      byLabel.set(label, { label, order, projects: new Map() });
    }
    const programme = byLabel.get(label);
    const host = hostOfUrl(item.project_url);
    if (!programme.projects.has(host)) {
      programme.projects.set(host, { host, project_url: item.project_url, order, item_ids: [] });
    }
    programme.projects.get(host).item_ids.push(item.item_id);
  });
  return [...byLabel.values()].map((p) => ({ label: p.label, order: p.order, projects: [...p.projects.values()] }));
};

/** The body's candidates: every programme as one unit, every ungrouped project as a unit of its own. */
const unitsOf = (programmes) => programmes
  .flatMap((programme) => (programme.label === UNGROUPED
    ? programme.projects.map((project) => ({ label: UNGROUPED, order: project.order, projects: [project] }))
    : [programme]))
  .sort((a, b) => a.order - b.order);

/** A unit's project lines: the three highest-ranked projects with the prefix code writes, and the count of the rest. */
const entriesOf = (unit) => {
  const shown = unit.projects.slice(0, MAX_PROJECTS);
  const hosts = shown.map((p) => p.host);
  const single = unit.projects.length === 1;
  return {
    entries: shown.map((project) => ({
      lead_id: project.item_ids[0],
      item_ids: [...project.item_ids],
      host: project.host,
      prefix: `${single ? project.host.toLowerCase() : shortHostLabel(project.host, hosts)}${PREFIX_SEPARATOR}`,
    })),
    more_projects: unit.projects.length - shown.length,
    projects_total: unit.projects.length,
    issues_total: unit.projects.reduce((sum, p) => sum + p.item_ids.length, 0),
  };
};

const documentUnit = (unit, kind) => ({
  kind,
  group: unit.label,
  ...entriesOf(unit),
});

/**
 * Lay out ranked items into the body and the thread (revision 28).
 * @param {object[]} items ranked items (item_id, project_url), in rank order
 * @param {{ groupOf?: (projectUrl: string) => string, alertGroups?: object[] }} [options] `alertGroups` only fill
 *   `thread_alerts`: alerts take no slot
 */
const buildLayout = (items, { groupOf = () => UNGROUPED, alertGroups = [] } = {}) => {
  const units = unitsOf(programmesOf(items, groupOf));
  const body = units.slice(0, BODY_SLOTS);
  const rest = units.slice(BODY_SLOTS);
  const own = rest.filter((unit) => unit.label !== UNGROUPED && unit.projects.length >= OWN_REPLY_MIN_PROJECTS);
  const leftover = rest.filter((unit) => !own.includes(unit)).flatMap((unit) => unit.projects)
    .sort((a, b) => a.order - b.order);
  const slots = body.map((unit, i) => ({
    slot: i + 1,
    ...documentUnit(unit, unit.projects.length === 1 ? 'item' : 'group'),
  }));
  const replies = own.map((unit) => documentUnit(unit, 'programme'));
  if (leftover.length) {
    replies.push(documentUnit({ label: UNGROUPED, order: leftover[0].order, projects: leftover }, 'other'));
  }
  const entries = {};
  const describe = (container, where) => {
    for (const entry of container.entries) {
      entries[entry.lead_id] = {
        item_ids: entry.item_ids,
        host: entry.host,
        prefix: entry.prefix,
        budget: MAX_LINE_CHARS - entry.prefix.length,
        where,
        group: container.group,
      };
    }
  };
  slots.forEach((slot) => describe(slot, 'body'));
  replies.forEach((reply) => describe(reply, 'reply'));
  const covered = new Set(slots.flatMap((slot) => slot.entries.flatMap((e) => e.item_ids)));
  const withIds = (container) => ({ ...container, item_ids: container.entries.map((e) => e.lead_id) });
  return {
    slots: slots.map(withIds),
    replies: replies.map(withIds),
    entries,
    body_items: slots.flatMap((slot) => slot.entries.map((e) => e.lead_id)),
    reply_items: replies.flatMap((reply) => reply.entries.map((e) => e.lead_id)),
    thread_items: items.map((item) => item.item_id).filter((id) => !covered.has(id)),
    // Retired in revision 28: every line may take two lines; kept empty for readers of older layouts.
    one_line: [],
    body_alerts: [],
    thread_alerts: alertGroups.map((group) => group.alert_key),
  };
};

/** Map a project url to its Project Group label from a discovery document; unknown hosts are `Other`. */
const groupOfProjects = (discovery) => {
  const byUrl = new Map(((discovery && discovery.projects) || []).map((p) => [p.url, p.group || UNGROUPED]));
  return (projectUrl) => byUrl.get(projectUrl) || UNGROUPED;
};

/** Slot number per item id, for placement: every item a body entry covers is in the body. */
const slotByKey = (layoutDocument) => {
  const out = new Map();
  for (const slot of layoutDocument.slots || []) {
    for (const entry of slot.entries || []) {
      for (const id of entry.item_ids) {
        out.set(id, slot.slot);
      }
    }
  }
  return out;
};

/** The items a line covers, by its lead id; the lead alone when the layout has no entry for it. */
const coveredIds = (layoutDocument, leadId) => {
  const entry = layoutDocument && layoutDocument.entries ? layoutDocument.entries[leadId] : null;
  return entry && Array.isArray(entry.item_ids) && entry.item_ids.length ? [...entry.item_ids] : [leadId];
};

/** The prefix code writes in front of each entry's line, by lead id. */
const childPrefixes = (layoutDocument) => {
  const prefixes = new Map();
  for (const [leadId, entry] of Object.entries((layoutDocument && layoutDocument.entries) || {})) {
    prefixes.set(leadId, entry.prefix);
  }
  return prefixes;
};

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The group line, written by code (FR-069): "North Programme: 3 projects with 5 issues". */
const groupBulletText = ({ label, projects, issues }) => (issues === projects
  ? `${label}: ${plural(projects, 'project')} with issues`
  : `${label}: ${plural(projects, 'project')} with ${plural(issues, 'issue')}`);

/** The line that counts the projects a bullet does not show. */
const moreProjectsText = (count) => `+${plural(count, 'more project')} in the report`;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A host the model wrote anyway at the start of its line, as the full host or the short label, followed by a colon,
 * a dash, a middle dot or a space, is dropped so code's prefix is not doubled.
 */
const stripLeadingHost = (text, host, short) => {
  const names = [host, short].filter(Boolean).map((name) => escapeRegExp(String(name)));
  if (!names.length) {
    return String(text || '');
  }
  const pattern = new RegExp(`^\\s*(?:${names.join('|')})(?:\\s*(?::|-|–|—|·)\\s*|\\s+)`, 'i');
  return String(text || '').replace(pattern, '');
};

const lineFor = (entry, textFor, prefixHosts) => {
  const text = textFor(entry.lead_id);
  if (!prefixHosts) {
    return text;
  }
  return `${entry.prefix}${stripLeadingHost(text, entry.host, entry.prefix.slice(0, -PREFIX_SEPARATOR.length))}`;
};

const childrenOf = (container, textFor, prefixHosts) => {
  const children = container.entries.map((entry) => ({
    item_id: entry.lead_id, item_ids: [...entry.item_ids], text: lineFor(entry, textFor, prefixHosts),
  }));
  if (container.more_projects > 0) {
    children.push({ item_id: null, item_ids: [], text: moreProjectsText(container.more_projects) });
  }
  return children;
};

const groupBullet = (container, textFor, prefixHosts) => ({
  kind: 'group',
  item_id: null,
  item_ids: [],
  group: container.group,
  text: groupBulletText({ label: container.group, projects: container.projects_total, issues: container.issues_total }),
  children: childrenOf(container, textFor, prefixHosts),
  alert_key: null,
});

/**
 * Build the body Bullets from the layout's slots. `textFor(leadId)` gives an entry's line (the model's for the brief,
 * code's for the deterministic one); with `prefixHosts` the project is written in front of it (FR-069, revision 26).
 */
const assembleBullets = ({ layout, textFor, prefixHosts = false }) => (layout.slots || []).map((slot) => {
  if (slot.kind === 'group') {
    return groupBullet(slot, textFor, prefixHosts);
  }
  const [entry] = slot.entries;
  return {
    kind: 'item', item_id: entry.lead_id, item_ids: [...entry.item_ids], group: slot.group,
    text: lineFor(entry, textFor, prefixHosts), children: [], alert_key: null,
  };
});

/**
 * Build the thread bullets from the layout's replies: one group bullet per programme reply and for the Other reply.
 * A thread bullet is a plain Bullet; its reply is a programme reply unless its group is the Other bucket.
 */
const assembleThread = ({ layout, textFor, prefixHosts = false }) => (layout.replies || [])
  .map((reply) => groupBullet(reply, textFor, prefixHosts));

/** The kind of thread reply a thread bullet makes (revision 28). */
const replyKindOf = (bullet) => (bullet.group === UNGROUPED ? 'other' : 'programme');

module.exports = {
  shortHostLabel, childPrefixes, stripLeadingHost, coveredIds, PREFIX_SEPARATOR, MAX_LINE_CHARS,
  programmesOf, unitsOf, buildLayout, groupOfProjects, slotByKey, groupBulletText,
  moreProjectsText, assembleBullets, assembleThread, replyKindOf, BODY_SLOTS, MAX_PROJECTS, OWN_REPLY_MIN_PROJECTS,
  MAX_CHILDREN, UNGROUPED, WATCHDOG,
};

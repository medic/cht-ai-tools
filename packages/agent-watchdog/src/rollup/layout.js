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
  const thread = [];
  for (const entry of entries) {
    const group = entry.group || UNGROUPED;
    const collapsible = group !== UNGROUPED;
    const shared = collapsible ? open.get(group) : undefined;
    if (shared) {
      if (shared.keys.length < maxChildren) {
        shared.keys.push(entry.key);
      } else {
        thread.push(entry.key);
      }
      continue;
    }
    if (slots.length < maxSlots) {
      const slot = { slot: slots.length + 1, kind: 'item', group, keys: [entry.key] };
      slots.push(slot);
      if (collapsible) {
        open.set(group, slot);
      }
      continue;
    }
    thread.push(entry.key);
  }
  for (const slot of slots) {
    slot.kind = slot.keys.length > 1 ? 'group' : 'item';
  }
  return {
    slots,
    body: slots.flatMap((slot) => slot.keys),
    thread,
    one_line: slots.filter((slot) => slot.kind === 'group').flatMap((slot) => slot.keys),
  };
};

/** The stored form (rollup/layout.json): slots with item ids and one-line flags, body and thread ids. */
const toLayoutDocument = (layout) => ({
  slots: layout.slots.map((slot) => ({
    slot: slot.slot, kind: slot.kind, group: slot.group, item_ids: [...slot.keys], one_line: slot.kind === 'group',
  })),
  body_items: [...layout.body],
  thread_items: [...layout.thread],
  one_line: [...layout.one_line],
});

/** Map a project url to its Project Group label from a discovery document; unknown hosts are `Other`. */
const groupOfProjects = (discovery) => {
  const byUrl = new Map(((discovery && discovery.projects) || []).map((p) => [p.url, p.group || UNGROUPED]));
  return (projectUrl) => byUrl.get(projectUrl) || UNGROUPED;
};

/**
 * Lay out ranked items by their project's group.
 * @param {object[]} items ranked items
 * @param {{ groupOf?: (projectUrl: string) => string }} [options]
 */
const buildLayout = (items, { groupOf = () => UNGROUPED } = {}) => toLayoutDocument(
  layoutEntries(items.map((item) => ({ key: item.item_id, group: groupOf(item.project_url) }))),
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

/**
 * Build Bullet entities from a layout document. `textFor(id)` gives an entry's line (the model's for items, code's
 * for candidates); `hostFor(id)` its project host, to count the projects behind a group line.
 */
const assembleBullets = ({ layout, textFor, hostFor }) => layout.slots.map((slot) => {
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
  layoutEntries, toLayoutDocument, buildLayout, groupOfProjects, slotByKey, groupBulletText, assembleBullets,
  BODY_SLOTS, MAX_CHILDREN, UNGROUPED, WATCHDOG,
};

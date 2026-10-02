'use strict';
// FR-009 (revision 18): the dashboard reference is built by code from the metric's collected windows and the
// window the item's leading evidence cites. The model never emits it, so it can never be outside the run.
const { dashboardRefFor } = require('../../src/links/dashboard-ref');

const URL = 'https://cht.example.org';
const METRIC = 'cht_sentinel_backlog_count';
const PANEL_REF = { dashboard_uid: 'oa2OfL-Vk', panel_id: 3, panel_title: 'Sentinel Backlog', ref_id: 'A' };

const windowOf = (name, start, end, extra = {}) => ({
  project_url: URL, metric: METRIC, panel_ref: PANEL_REF, window: name, start, end, available: true, ...extra,
});

const CURRENT = ['2026-09-18T06:00:00.000Z', '2026-09-19T06:00:00.000Z'];
const WINDOWS = [
  windowOf('current', ...CURRENT),
  windowOf('previous_day', '2026-09-17T06:00:00.000Z', '2026-09-18T06:00:00.000Z'),
  windowOf('trailing_14d', '2026-08-30T06:00:00.000Z', '2026-09-19T06:00:00.000Z'),
];

const evidence = (...names) => names.map((window) => ({ window, value: 1, unit: 'count' }));

// The priority list, as discovery records it: the panel the scrape-target metric carries is not one of these.
const DISCOVERY = {
  dashboards: [
    { uid: 'oa2OfL-Vk', title: 'CHT Admin Overview', panels: [{ panel_id: 3, title: 'Sentinel Backlog' }] },
    { uid: 'hkQUbyfVk', title: 'CHT Admin Details', panels: [{ panel_id: 2, title: 'Doc Count' }] },
  ],
};

describe('links/dashboard-ref', () => {
  it('takes the panel from the metric and the bounds from the window the leading evidence cites', () => {
    const ref = dashboardRefFor({
      windows: WINDOWS, projectUrl: URL, metric: METRIC, evidence: evidence('current', 'previous_day'),
    });
    expect(ref).to.deep.equal({
      dashboard_uid: 'oa2OfL-Vk',
      panel_id: 3,
      project_url: URL,
      from: CURRENT[0],
      to: CURRENT[1],
    });
    const trailing = dashboardRefFor({
      windows: WINDOWS, projectUrl: URL, metric: METRIC, evidence: evidence('trailing_14d'),
    });
    expect(trailing).to.include({ from: '2026-08-30T06:00:00.000Z', to: '2026-09-19T06:00:00.000Z' });
  });

  it('falls back to the current window when the evidence is empty or names a window the run did not collect', () => {
    for (const ev of [[], evidence('previous_cycle'), undefined]) {
      const ref = dashboardRefFor({ windows: WINDOWS, projectUrl: URL, metric: METRIC, evidence: ev });
      expect(ref).to.include({ from: CURRENT[0], to: CURRENT[1] });
    }
  });

  it('falls back to the full collected span when the run collected no current window', () => {
    const withoutCurrent = WINDOWS.filter((w) => w.window !== 'current');
    const ref = dashboardRefFor({
      windows: withoutCurrent, projectUrl: URL, metric: METRIC, evidence: evidence('current'),
    });
    expect(ref).to.include({ from: '2026-08-30T06:00:00.000Z', to: '2026-09-19T06:00:00.000Z' });
  });

  it('builds the reference from an unavailable window too: the panel and bounds are facts of the run', () => {
    const unavailable = [windowOf('current', ...CURRENT, {
      available: false, unavailable_reason: '4 series, not one per project (labels: db)',
    })];
    expect(dashboardRefFor({ windows: unavailable, projectUrl: URL, metric: METRIC, evidence: [] }))
      .to.include({ panel_id: 3, from: CURRENT[0], to: CURRENT[1] });
  });

  it('matches the metric by key form and the project exactly', () => {
    const spaced = dashboardRefFor({
      windows: WINDOWS, projectUrl: URL, metric: ' cht_sentinel_backlog_count ', evidence: [],
    });
    expect(spaced).to.include({ panel_id: 3 });
    expect(dashboardRefFor({
      windows: WINDOWS, projectUrl: 'https://other.example.org', metric: METRIC, evidence: [],
    })).to.equal(null);
  });

  it('prefers the metric\'s own panel over a sibling sharing its base name', () => {
    // One base name, several collected metrics: a per-database doc count on one panel and a growth rate on
    // another. The item's own key decides, not the family.
    const family = [
      { ...windowOf('current', ...CURRENT), metric: 'cht_couchdb_doc_total{db="medic"}' },
      {
        ...windowOf('current', ...CURRENT),
        metric: 'rate(cht_couchdb_doc_total[1h]) * 60 * 60',
        panel_ref: { dashboard_uid: 'oa2OfL-Vk', panel_id: 8, panel_title: 'DB Growth Rate', ref_id: 'A' },
      },
      {
        ...windowOf('current', ...CURRENT),
        metric: 'cht_couchdb_doc_total{db="sentinel"}',
        panel_ref: { dashboard_uid: 'hkQUbyfVk', panel_id: 2, panel_title: 'Doc Count [sentinel]', ref_id: 'A' },
      },
    ];
    // The growth-rate window is listed before the sentinel one, so an unspecific match would take it.
    const ref = dashboardRefFor({
      windows: [family[1], family[2], family[0]],
      projectUrl: URL,
      metric: 'cht_couchdb_doc_total{db="sentinel"}',
      evidence: [],
    });
    expect(ref).to.include({ dashboard_uid: 'hkQUbyfVk', panel_id: 2 });
    expect(dashboardRefFor({
      windows: family, projectUrl: URL, metric: 'rate(cht_couchdb_doc_total[1h]) * 60 * 60', evidence: [],
    })).to.include({ panel_id: 8 });
    // The instance matcher is not part of the key, so a panel expression still matches its collected metric.
    expect(dashboardRefFor({
      windows: family, projectUrl: URL, metric: 'cht_couchdb_doc_total{instance=~"$cht_instance",db="sentinel"}',
      evidence: [],
    })).to.include({ panel_id: 2 });
    // A metric of the family that was never collected falls back to the family rather than losing the link.
    expect(dashboardRefFor({
      windows: family, projectUrl: URL, metric: 'cht_couchdb_doc_total{db="_users"}', evidence: [],
    })).to.not.equal(null);
  });

  it('links the first priority dashboard without a panel when the metric has no real panel (revision 18)', () => {
    // Scrape-target health is collected under a pseudo panel reference that no dashboard holds; pointing the
    // reader at an unrelated panel to satisfy the gate would be a misleading link.
    const targets = [{
      project_url: URL,
      metric: 'up{job="cht"}',
      panel_ref: { dashboard_uid: 'targets', panel_id: 0, panel_title: 'Scrape target health', ref_id: 'up' },
      window: 'current',
      start: CURRENT[0],
      end: CURRENT[1],
    }];
    const ref = dashboardRefFor({
      windows: targets, discovery: DISCOVERY, projectUrl: URL, metric: 'up{job="cht"}', evidence: [],
    });
    expect(ref).to.deep.equal({
      dashboard_uid: 'oa2OfL-Vk', panel_id: null, project_url: URL, from: CURRENT[0], to: CURRENT[1],
    });
    // A metric whose recorded panel is real keeps it.
    expect(dashboardRefFor({ windows: WINDOWS, discovery: DISCOVERY, projectUrl: URL, metric: METRIC, evidence: [] }))
      .to.include({ dashboard_uid: 'oa2OfL-Vk', panel_id: 3 });
    // Without a discovery to check against, the recorded panel is taken as given.
    expect(dashboardRefFor({ windows: targets, projectUrl: URL, metric: 'up{job="cht"}', evidence: [] }))
      .to.include({ dashboard_uid: 'targets', panel_id: 0 });
    // No priority dashboard at all: nothing to link.
    expect(dashboardRefFor({
      windows: targets, discovery: { dashboards: [] }, projectUrl: URL, metric: 'up{job="cht"}', evidence: [],
    })).to.equal(null);
  });

  it('returns null when the metric has no collected window, or the window carries no panel', () => {
    expect(dashboardRefFor({ windows: WINDOWS, projectUrl: URL, metric: 'cht_conflict_count', evidence: [] }))
      .to.equal(null);
    expect(dashboardRefFor({ windows: [], projectUrl: URL, metric: METRIC, evidence: [] })).to.equal(null);
    const noPanel = [{ ...windowOf('current', ...CURRENT), panel_ref: null }];
    expect(dashboardRefFor({ windows: noPanel, projectUrl: URL, metric: METRIC, evidence: [] })).to.equal(null);
  });
});

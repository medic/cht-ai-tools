const { buildDashboardLink, buildItemLinks } = require('../../src/links/build');
const { baseContext, T0, T1 } = require('../verify/helpers/context');

describe('links/build', () => {
  const dashboard = { uid: 'oa2OfL-Vk', slug: 'cht-admin-overview', duplicate_panel_ids: [] };

  it('builds a dashboard link scoped to instance and window with a panel when the id is unique', () => {
    const url = buildDashboardLink({
      grafanaUrl: 'https://watchdog.example.org/', dashboard, panelId: 3, host: 'cht.example.org', from: T0, to: T1,
    });
    expect(url).to.equal('https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview'
      + `?orgId=1&from=${Date.parse(T0)}&to=${Date.parse(T1)}&timezone=utc`
      + '&var-cht_instance=cht.example.org&viewPanel=panel-3');
  });

  it('omits viewPanel when the panel id is duplicated on the dashboard or not given, and encodes the host', () => {
    const dup = { ...dashboard, duplicate_panel_ids: [3] };
    const url = buildDashboardLink({
      grafanaUrl: 'https://watchdog.example.org', dashboard: dup, panelId: 3, host: 'cht.example.org:8443', from: T0, to: T1,
    });
    expect(url).to.not.include('viewPanel');
    expect(url).to.include('var-cht_instance=cht.example.org%3A8443');
    const noPanel = buildDashboardLink({ grafanaUrl: 'https://g', dashboard, host: 'h', from: T0, to: T1 });
    expect(noPanel).to.not.include('viewPanel');
  });

  it('builds one link per item from discovery', () => {
    const ctx = baseContext();
    const links = buildItemLinks(ctx.items, ctx.discovery, 'https://watchdog.example.org');
    expect(links.get('a1b2c3d4e5f6')).to.include('/d/oa2OfL-Vk/cht-admin-overview?');
    expect(links.get('a1b2c3d4e5f6')).to.include('viewPanel=panel-3');
    ctx.items[0].dashboard_ref.dashboard_uid = 'missing';
    expect(buildItemLinks(ctx.items, ctx.discovery, 'https://watchdog.example.org').get('a1b2c3d4e5f6')).to.equal(null);
  });
});

describe('links/build: alert-list links (FR-070, research.md R-14)', () => {
  const { buildAlertListLink, alertTerms, buildAlertGroupLinks } = require('../../src/links/build');
  const { classified, groupOf: alertGroupOf } = require('../helpers/alerts');
  const group = alertGroupOf([
    classified('sentinel', 'nepal-a.example.org'), classified('outbound', 'nepal-b.example.org'),
  ]);

  it('builds the search terms: namespace, firing state, the instance matcher and an optional rule title', () => {
    expect(alertTerms({ hosts: ['nepal-a.example.org', 'nepal-b.example.org'] })).to.deep.equal([
      'namespace:CHT', 'state:firing', 'label:instance=~"^(nepal-a\\.example\\.org|nepal-b\\.example\\.org)$"',
    ]);
    expect(alertTerms({ hosts: ['a.example.org'], title: 'Sentinel Backlog' })).to.deep.equal([
      'namespace:CHT', 'state:firing', 'rule:"Sentinel Backlog"', 'label:instance=~"^(a\\.example\\.org)$"',
    ]);
    expect(alertTerms({ hosts: [], title: 'Watchdog Scrape Failures' })).to.deep.equal([
      'namespace:CHT', 'state:firing', 'rule:"Watchdog Scrape Failures"',
    ]);
  });

  it('emits the list page with the terms encoded into the search parameter under the Grafana host', () => {
    const url = buildAlertListLink({ grafanaUrl: 'https://watchdog.example.org/', terms: ['namespace:CHT', 'rule:"A B"'] });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).to.equal('https://watchdog.example.org/alerting/list');
    expect(parsed.searchParams.get('search')).to.equal('namespace:CHT rule:"A B"');
  });

  it('builds one link for the group and one per rule title', () => {
    const links = buildAlertGroupLinks({ grafanaUrl: 'https://watchdog.example.org', group });
    expect(new URL(links.group).searchParams.get('search'))
      .to.equal('namespace:CHT state:firing label:instance=~"^(nepal-a\\.example\\.org|nepal-b\\.example\\.org)$"');
    expect(links.rules.map((r) => r.title)).to.deep.equal(['Outbound Push Backlog', 'Sentinel Backlog']);
    expect(new URL(links.rules[1].url).searchParams.get('search')).to.include('rule:"Sentinel Backlog"');
    expect(links.all).to.have.length(3);
  });
});

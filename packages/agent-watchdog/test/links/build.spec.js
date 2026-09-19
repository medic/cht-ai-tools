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

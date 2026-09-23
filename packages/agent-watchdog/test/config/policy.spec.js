const fs = require('node:fs');
const path = require('node:path');
const { loadPolicy, normaliseHost, PolicyError } = require('../../src/config/policy');
const { tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');

describe('config/policy', () => {
  let dir;
  beforeEach(() => {
    dir = tempDir(); 
  });
  afterEach(() => removeDir(dir));

  describe('normaliseHost', () => {
    it('lowercases and strips scheme, www. and trailing slashes so a pasted URL matches the instance label', () => {
      expect(normaliseHost('HTTPS://www.CHT.Example.org/')).to.equal('cht.example.org');
      expect(normaliseHost('cht.example.org')).to.equal('cht.example.org');
      expect(normaliseHost('http://cht.example.org:8443/path/')).to.equal('cht.example.org:8443');
    });
  });

  it('falls back to the package defaults when a policy file is absent', () => {
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.thresholds.candidate_rules.pct_change_vs_previous_day).to.equal(50);
    expect(policy.thresholds.candidate_rules.deviation_sigma_vs_trailing).to.equal(2.5);
    expect(policy.thresholds.candidate_rules.monotonic_rise_hours).to.equal(6);
    expect(policy.thresholds.trailing_days).to.equal(14);
    expect(policy.thresholds.metric_roles.sentinel_backlog).to.equal('cht_sentinel_backlog_count');
    expect(policy.dashboards.dashboards[0].uid).to.equal('oa2OfL-Vk');
    expect(policy.projects.projects).to.deep.equal({});
    expect(policy.hash).to.match(/^[0-9a-f]{64}$/);
  });

  it('reads a deployment policy file over the default and normalises project keys', () => {
    fs.writeFileSync(path.join(dir, 'projects.yaml'), [
      'projects:',
      '  https://www.CHT.Example.org/:',
      '    owner: hosting',
      '    host_metrics: true',
      '    thresholds:',
      '      pct_change_vs_previous_day: 80',
      '    expected_load_windows:',
      '      - id: sync-week',
      '        kind: dates',
      '        start: 2026-10-05',
      '        end: 2026-10-09',
      '        timezone: Africa/Kampala',
      '        note: Quarterly sync',
      '        cycle_days: 90',
    ].join('\n'));
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    const project = policy.projects.projects['cht.example.org'];
    expect(project.owner).to.equal('hosting');
    expect(project.host_metrics).to.equal(true);
    expect(project.thresholds.pct_change_vs_previous_day).to.equal(80);
    expect(project.expected_load_windows[0].kind).to.equal('dates');
  });

  it('changes the hash when any policy file changes', () => {
    const before = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR }).hash;
    fs.writeFileSync(path.join(dir, 'dashboards.yaml'), 'dashboards:\n  - uid: abc\n    panels: []\n');
    const after = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR }).hash;
    expect(after).to.not.equal(before);
  });

  it('rejects an invalid timezone, an unknown window kind and duplicate dashboard uids', () => {
    fs.writeFileSync(path.join(dir, 'projects.yaml'), [
      'defaults:', '  expected_load_windows:', '    - id: x', '      kind: month_end', '      timezone: Mars/Olympus',
      '      note: n', '      cycle_days: 30', 'projects: {}', '',
    ].join('\n'));
    expect(() => loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR })).to.throw(PolicyError, /timezone/);
    fs.writeFileSync(path.join(dir, 'projects.yaml'), 'projects: {}\n');
    const duplicate = 'dashboards:\n  - uid: a\n    panels: []\n  - uid: a\n    panels: []\n';
    fs.writeFileSync(path.join(dir, 'dashboards.yaml'), duplicate);
    expect(() => loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR })).to.throw(PolicyError, /uid/);
  });

  it('accepts only the three FR-014 high-severity rules', () => {
    fs.writeFileSync(path.join(dir, 'thresholds.yaml'), [
      'trailing_days: 14',
      'candidate_rules: { pct_change_vs_previous_day: 50, deviation_sigma_vs_trailing: 2.5, monotonic_rise_hours: 6 }',
      'severity:',
      '  default: low',
      '  medium_when: [two_or_more_rules_fire]',
      '  high_when:',
      '    - role: disk_full',
      '      condition: gt',
      '      value: 0',
      'metric_roles: { scrape_target: up, outbound_push_backlog: a, sentinel_backlog: b }',
    ].join('\n'));
    expect(() => loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR })).to.throw(PolicyError, /high_when/);
  });

  it('carries an exit code of 78', () => {
    fs.writeFileSync(path.join(dir, 'dashboards.yaml'), 'dashboards: []\n');
    let error;
    try {
      loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR }); 
    } catch (e) {
      error = e; 
    }
    expect(error.code).to.equal(78);
  });
});

describe('config/policy: programme groups and the ignore list (FR-068, User Story 9)', () => {
  const { globToRegExp, matchesGlob } = require('../../src/config/policy');
  let dir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it('ships placeholder groups and the development-instance ignore patterns as the package default', () => {
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.projects.groups.map((g) => g.label)).to.deep.equal(['North Programme', 'South Programme']);
    expect(policy.projects.groups.every((g) => g.host_patterns.length > 0)).to.equal(true);
    expect(policy.projects.ignore).to.deep.equal(['*.dev.*', '*-dev.*']);
  });

  it('loads groups and ignore from a deployment file and keeps the defaults and projects beside them', () => {
    fs.writeFileSync(path.join(dir, 'projects.yaml'), [
      'groups:',
      '  - label: North Programme',
      "    host_patterns: ['*.moh-north.org', 'north-?.example.org']",
      '  - label: South Programme',
      "    host_patterns: ['*south*']",
      "ignore: ['*.dev.*', 'sandbox-*']",
      'projects:',
      '  north-a.example.org: { owner: hosting }',
    ].join('\n'));
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.projects.groups).to.deep.equal([
      { label: 'North Programme', host_patterns: ['*.moh-north.org', 'north-?.example.org'] },
      { label: 'South Programme', host_patterns: ['*south*'] },
    ]);
    expect(policy.projects.ignore).to.deep.equal(['*.dev.*', 'sandbox-*']);
    expect(policy.projects.projects['north-a.example.org'].owner).to.equal('hosting');
    expect(policy.projects.defaults.expected_load_windows).to.deep.equal([]);
  });

  it('defaults groups and ignore to empty lists when a deployment file omits them', () => {
    fs.writeFileSync(path.join(dir, 'projects.yaml'), 'projects: {}\n');
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.projects.groups).to.deep.equal([]);
    expect(policy.projects.ignore).to.deep.equal([]);
  });

  const withGroups = (lines) => {
    fs.writeFileSync(path.join(dir, 'projects.yaml'), ['projects: {}', ...lines, ''].join('\n'));
    return () => loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
  };

  it('rejects duplicate, reserved, empty and over-long labels', () => {
    const twice = ['groups:', "  - { label: A, host_patterns: ['a*'] }", "  - { label: A, host_patterns: ['b*'] }"];
    expect(withGroups(twice)).to.throw(PolicyError, /unique/);
    expect(withGroups(['groups:', "  - { label: Other, host_patterns: ['a*'] }"])).to.throw(PolicyError, /reserved/);
    expect(withGroups(['groups:', "  - { label: Watchdog, host_patterns: ['a*'] }"])).to.throw(PolicyError, /reserved/);
    expect(withGroups(['groups:', "  - { label: '', host_patterns: ['a*'] }"])).to.throw(PolicyError, /label/);
    const long = ['groups:', `  - { label: '${'x'.repeat(41)}', host_patterns: ['a*'] }`];
    expect(withGroups(long)).to.throw(PolicyError, /40/);
  });

  it('rejects a pattern with a scheme, a www. prefix, upper case or no pattern at all', () => {
    expect(withGroups(['groups:', "  - { label: A, host_patterns: ['https://a.example.org'] }"])).to.throw(PolicyError, /glob/);
    const www = ['groups:', "  - { label: A, host_patterns: ['www.*.example.org'] }"];
    expect(withGroups(www)).to.throw(PolicyError, /www/);
    expect(withGroups(['groups:', "  - { label: A, host_patterns: ['*.Example.org'] }"])).to.throw(PolicyError, /glob/);
    expect(withGroups(['groups:', '  - { label: A, host_patterns: [] }'])).to.throw(PolicyError, /host_patterns/);
    expect(withGroups(["ignore: ['http://dev.example.org']"])).to.throw(PolicyError, /glob/);
  });

  it('matches hosts against anchored globs where * is any run of characters and ? one character', () => {
    expect(globToRegExp('*.dev.*').source).to.equal('^.*\\.dev\\..*$');
    expect(matchesGlob('cht.dev.example.org', '*.dev.*')).to.equal(true);
    expect(matchesGlob('cht-dev.example.org', '*.dev.*')).to.equal(false);
    expect(matchesGlob('cht-dev.example.org', '*-dev.*')).to.equal(true);
    expect(matchesGlob('north-a.example.org', 'north-?.example.org')).to.equal(true);
    expect(matchesGlob('north-ab.example.org', 'north-?.example.org')).to.equal(false);
    expect(matchesGlob('north.example.org', '*north*')).to.equal(true);
    expect(matchesGlob('xnorthx.example.org:8443', '*north*')).to.equal(true);
    expect(matchesGlob('east.example.org', '*north*')).to.equal(false);
  });
});

describe('config/policy: the alert policy alerts.yaml (FR-065, User Story 8)', () => {
  let dir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it('ships the FR-065 mapping, the staleness threshold and the category metrics as the package default', () => {
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.alerts.stale_after_days).to.equal(14);
    expect(policy.alerts.rules['API Server Down']).to.deep.equal({ category: 'availability', importance: 'critical' });
    expect(policy.alerts.rules['Sentinel Backlog']).to.deep.equal({ category: 'backlog', importance: 'high' });
    expect(policy.alerts.rules['Outbound Push Backlog']).to.deep.equal({ category: 'backlog', importance: 'high' });
    // The hosted watchdog's lower-threshold sentinel rule, categorised by revision 23 (research.md R-28).
    expect(policy.alerts.rules['Sentinel Backlog >50']).to.deep.equal({ category: 'backlog', importance: 'medium' });
    expect(policy.alerts.rules['Message Delivery Rate']).to.deep.equal({ category: 'messaging', importance: 'high' });
    expect(policy.alerts.rules['DB Conflicts Rate']).to.deep.equal({ category: 'database', importance: 'medium' });
    expect(policy.alerts.rules['Client Feedback/Error Rate'])
      .to.deep.equal({ category: 'client_errors', importance: 'medium' });
    expect(policy.alerts.rules['Users Over Replication Limit'])
      .to.deep.equal({ category: 'replication', importance: 'medium' });
    expect(policy.alerts.rules['DB Fragmentation']).to.deep.equal({ category: 'database', importance: 'low' });
    expect(policy.alerts.rules['Server Time Accurate']).to.deep.equal({ category: 'host', importance: 'low' });
    expect(policy.alerts.categories.backlog)
      .to.deep.equal(['cht_sentinel_backlog_count', 'cht_outbound_push_backlog_count']);
    expect(Object.keys(policy.alerts.categories))
      .to.include.members(Object.values(policy.alerts.rules).map((r) => r.category));
    expect(policy.sources.alerts).to.include('alerts.yaml');
  });

  it('covers alerts.yaml with the policy hash', () => {
    const before = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR }).hash;
    fs.writeFileSync(path.join(dir, 'alerts.yaml'), [
      'stale_after_days: 7', 'rules:', '  Sentinel Backlog: { category: backlog, importance: high }',
      'categories: { backlog: [cht_sentinel_backlog_count] }', '',
    ].join('\n'));
    const policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    expect(policy.hash).to.not.equal(before);
    expect(policy.alerts.stale_after_days).to.equal(7);
    expect(Object.keys(policy.alerts.rules)).to.deep.equal(['Sentinel Backlog']);
  });

  const alertsWith = (lines) => {
    fs.writeFileSync(path.join(dir, 'alerts.yaml'), [...lines, ''].join('\n'));
    return () => loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
  };

  it('rejects a bad staleness threshold, an unknown importance, a category without metrics and a bad slug', () => {
    expect(alertsWith(['stale_after_days: 0', 'rules: {}', 'categories: {}']))
      .to.throw(PolicyError, /stale_after_days/);
    expect(alertsWith(['stale_after_days: 400', 'rules: {}', 'categories: {}']))
      .to.throw(PolicyError, /stale_after_days/);
    expect(alertsWith(['rules:', '  X: { category: backlog, importance: urgent }', 'categories: { backlog: [] }']))
      .to.throw(PolicyError, /importance/);
    expect(alertsWith(['rules:', '  X: { category: backlog, importance: high }', 'categories: {}']))
      .to.throw(PolicyError, /categories/);
    expect(alertsWith(['rules:', '  X: { category: Back Log, importance: high }', 'categories: { backlog: [] }']))
      .to.throw(PolicyError, /category/);
  });

  it('defaults stale_after_days to 14 and accepts an empty category list', () => {
    const policy = alertsWith(['rules:', '  X: { category: host, importance: low }', 'categories: { host: [] }'])();
    expect(policy.alerts.stale_after_days).to.equal(14);
    expect(policy.alerts.categories.host).to.deep.equal([]);
  });
});

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

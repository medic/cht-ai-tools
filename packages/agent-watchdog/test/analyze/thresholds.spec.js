const path = require('node:path');
const { effectiveThresholds, roleMatches } = require('../../src/analyze/thresholds');
const { loadPolicy } = require('../../src/config/policy');
const { tempDir, removeDir } = require('../helpers/fixtures');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config', 'defaults');

describe('analyze/thresholds', () => {
  let policy;
  before(() => {
    const dir = tempDir();
    policy = loadPolicy({ configDir: dir, defaultsDir: DEFAULTS_DIR });
    removeDir(dir);
  });

  it('returns the package defaults with their source', () => {
    const t = effectiveThresholds(policy.thresholds, null);
    expect(t.rules).to.deep.equal({
      pct_change_vs_previous_day: 50, deviation_sigma_vs_trailing: 2.5, monotonic_rise_hours: 6,
    });
    expect(t.sources).to.deep.equal({
      pct_change_vs_previous_day: 'default', deviation_sigma_vs_trailing: 'default', monotonic_rise_hours: 'default',
    });
  });

  it('applies per-project overrides and marks deployment thresholds as global', () => {
    const t = effectiveThresholds(policy.thresholds, { pct_change_vs_previous_day: 80 }, { globalSource: true });
    expect(t.rules.pct_change_vs_previous_day).to.equal(80);
    expect(t.sources.pct_change_vs_previous_day).to.equal('project');
    expect(t.sources.deviation_sigma_vs_trailing).to.equal('global');
  });

  it('matches metric roles by base name and label matchers', () => {
    expect(roleMatches('up{job="cht"}', 'up{job="cht"}')).to.equal(true);
    expect(roleMatches('up{job="cht"}', 'up{job="cht", instance="a.org"}')).to.equal(true);
    expect(roleMatches('up{job="cht"}', 'up')).to.equal(false);
    expect(roleMatches('up{job="cht"}', 'up{job="prometheus"}')).to.equal(false);
    expect(roleMatches('cht_sentinel_backlog_count', 'cht_sentinel_backlog_count')).to.equal(true);
    expect(roleMatches('cht_sentinel_backlog_count', 'cht_sentinel_backlog_count{db="x"}')).to.equal(true);
    expect(roleMatches('cht_sentinel_backlog_count', 'increase(cht_sentinel_backlog_count[1d])')).to.equal(false);
    expect(roleMatches('cht_sentinel_backlog_count', 'cht_sentinel_backlog_count_total')).to.equal(false);
  });
});

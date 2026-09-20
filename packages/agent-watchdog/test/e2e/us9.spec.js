// End-to-end User Story 9: grouped briefing for programmes. Real stages on the seeded fixture day replayed across
// aliased hosts (two programmes, one development instance), a scripted model, a stubbed Slack client and a fake
// browser. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase } = require('./helpers');

const GROUPED_PROJECTS_YAML = [
  'groups:',
  '  - label: MoH Nepal',
  "    host_patterns: ['*nepal*']",
  '  - label: eCHIS Kenya',
  "    host_patterns: ['*echis*']",
  "ignore: ['*-dev.*', '*.dev.*']",
  'projects: {}',
  '',
].join('\n');

// alpha carries the sentinel climb, gamma the down scrape target, beta is quiet (test/fixtures/runs/seeded-anomaly).
const ALIASES = {
  'nepal-a.example.org': 'alpha.example.org',
  'nepal-b.example.org': 'gamma.example.org',
  'nepal-c.example.org': 'alpha.example.org',
  'echis-a.example.org': 'alpha.example.org',
  'cht-dev.example.org': 'alpha.example.org',
};

describe('e2e: User Story 9, grouped briefing for programmes', function () {
  this.timeout(60000);
  const dirs = [];
  const fresh = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  const configDirWith = (yaml) => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'projects.yaml'), yaml);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      removeDir(dirs.pop());
    }
  });

  it('scenarios 1 to 3: one bullet per programme with a sub-bullet per project, Other for the rest, .dev ignored',
    async () => {
      const r = await runCase({
        caseName: 'seeded-anomaly', dataDir: fresh(), hostAliases: ALIASES,
        envExtra: { AGENT_WATCHDOG_CONFIG_DIR: configDirWith(GROUPED_PROJECTS_YAML) },
      });
      expect(r.error, r.error && r.error.stack).to.equal(undefined);
      expect(r.code).to.equal(0);
      expect(r.read('run.json').status).to.equal('published');

      // Discovery: groups by host pattern, Other for unmatched hosts, the development instance ignored and counted.
      const discovery = r.read('discovery.json');
      expect(discovery.projects.map((p) => p.host)).to.not.include('cht-dev.example.org');
      expect(discovery.ignored).to.deep.equal([{ host: 'cht-dev.example.org', pattern: '*-dev.*' }]);
      expect(discovery.groups).to.deep.equal([
        { label: 'MoH Nepal', hosts: ['nepal-a.example.org', 'nepal-b.example.org', 'nepal-c.example.org'] },
        { label: 'eCHIS Kenya', hosts: ['echis-a.example.org'] },
        { label: 'Other', hosts: ['alpha.example.org', 'beta.example.org', 'gamma.example.org'] },
      ]);
      // Never analysed: no project directory, no session, no cost.
      expect(fs.existsSync(path.join(r.root, 'cht-dev-example-org'))).to.equal(false);
      const summary = r.read('agent.summary.json');
      expect([...summary.projects_analysed, ...summary.projects_skipped]).to.not.include('https://cht-dev.example.org');

      // The brief: a group bullet for MoH Nepal with one sub-bullet per flagged project, single items elsewhere.
      const brief = r.read('rollup/brief.json');
      expect(brief.kind).to.equal('brief');
      expect(brief.bullets.length).to.be.at.most(5);
      const nepal = brief.bullets.find((b) => b.kind === 'group');
      expect(nepal).to.include({ group: 'MoH Nepal', text: 'MoH Nepal: 3 projects with issues', item_id: null });
      expect(nepal.children).to.have.length(3);
      const ranked = r.read('rollup/items.ranked.json');
      const nepalItems = ranked.filter((i) => /nepal/.test(i.project_url));
      expect(nepal.children.map((c) => c.item_id).sort()).to.deep.equal(nepalItems.map((i) => i.item_id).sort());
      for (const child of nepal.children) {
        expect(child.text.split('\n')).to.have.length(1);
        expect(child.text).to.match(/nepal-[abc]\.example\.org/);
      }
      expect(nepalItems.every((i) => i.placement === 'body' && i.slot !== null)).to.equal(true);
      const echis = brief.bullets.find((b) => b.group === 'eCHIS Kenya');
      expect(echis).to.include({ kind: 'item' });
      expect(echis.children).to.deep.equal([]);
      expect(echis.text).to.include('echis-a.example.org');
      const others = brief.bullets.filter((b) => b.group === 'Other');
      expect(others.map((b) => b.kind)).to.deep.equal(['item', 'item']);
      expect(others.map((b) => b.text).join(' ')).to.include('alpha.example.org').and.include('gamma.example.org');

      // The layout is written by code and agrees with the brief.
      const layout = r.read('rollup/layout.json');
      expect(layout.slots).to.have.length(brief.bullets.length);
      expect(layout.slots.find((s) => s.kind === 'group').item_ids.sort())
        .to.deep.equal(nepal.children.map((c) => c.item_id).sort());
      expect(layout.thread_items).to.deep.equal([]);
      expect(r.read('rollup/verification.draft1.json').outcome).to.equal('accepted');

      // Slack: one section per top-level bullet, sub-bullets indented, one thread reply per project item, and the
      // ignored host named nowhere.
      const payload = r.read('rollup/payload.json');
      const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
      expect(sections).to.have.length(brief.bullets.length);
      const nepalSection = sections.find((s) => s.startsWith('MoH Nepal: 3 projects with issues'));
      expect(nepalSection.split('\n').slice(1)).to.have.length(3);
      expect(nepalSection.split('\n').slice(1).every((line) => line.startsWith('   ◦ '))).to.equal(true);
      expect(payload.parent.text).to.include('• MoH Nepal: 3 projects with issues\n   ◦ ');
      expect(payload.replies.map((reply) => reply.item_id).sort()).to.deep.equal(ranked.map((i) => i.item_id).sort());
      expect(JSON.stringify(payload)).to.not.include('cht-dev');
      expect(r.slack.chat.postMessage.callCount).to.equal(1 + ranked.length);
      const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
      expect(report).to.include('MoH Nepal: 3 projects with issues');
      expect(report).to.include('<ul class="sub">');
      expect(report).to.not.include('cht-dev');
    });

  it('scenario 4: more than five slots keeps five bullets in the body and the rest as thread replies', async () => {
    const aliases = {
      ...ALIASES,
      'delta.example.org': 'alpha.example.org',
      'epsilon.example.org': 'alpha.example.org',
      'zeta.example.org': 'gamma.example.org',
    };
    const r = await runCase({
      caseName: 'seeded-anomaly', dataDir: fresh(), hostAliases: aliases,
      envExtra: { AGENT_WATCHDOG_CONFIG_DIR: configDirWith(GROUPED_PROJECTS_YAML) },
    });
    expect(r.error, r.error && r.error.stack).to.equal(undefined);
    const brief = r.read('rollup/brief.json');
    expect(brief.bullets).to.have.length(5);
    expect(brief.bullets.every((b) => b.text.split('\n').length <= 2)).to.equal(true);
    expect(brief.bullets.every((b) => b.children.length <= 8)).to.equal(true);
    const ranked = r.read('rollup/items.ranked.json');
    // Nine flagged projects: seven slots would be needed, so two items go to the thread and still get replies.
    expect(ranked).to.have.length(9);
    expect(ranked.filter((i) => i.placement === 'thread')).to.have.length(2);
    expect(ranked.filter((i) => i.placement === 'body')).to.have.length(7);
    const layout = r.read('rollup/layout.json');
    expect(layout.slots).to.have.length(5);
    expect(layout.thread_items).to.have.length(2);
    const payload = r.read('rollup/payload.json');
    expect(payload.replies).to.have.length(9);
    expect(payload.parent.blocks.filter((b) => b.type === 'section')).to.have.length(5);
    for (const n of [1]) {
      const report = r.read(`rollup/verification.draft${n}.json`);
      expect(report.outcome).to.equal('accepted');
      expect(report.checks.find((c) => c.name === 'bullet_count').status).to.equal('pass');
    }
  });
});

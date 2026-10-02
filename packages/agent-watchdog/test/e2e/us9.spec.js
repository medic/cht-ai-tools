// End-to-end User Story 9: grouped briefing for programmes. Real stages on the seeded fixture day replayed across
// aliased hosts (two programmes, one development instance), a scripted model, a stubbed Slack client and a fake
// browser. Nothing touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { runCase } = require('./helpers');

const GROUPED_PROJECTS_YAML = [
  'groups:',
  '  - label: North Programme',
  "    host_patterns: ['*north*']",
  '  - label: South Programme',
  "    host_patterns: ['*south*']",
  "ignore: ['*-dev.*', '*.dev.*']",
  'projects: {}',
  '',
].join('\n');

// alpha carries the sentinel climb, gamma the down scrape target, beta is quiet (test/fixtures/runs/seeded-anomaly).
const ALIASES = {
  'north-a.example.org': 'alpha.example.org',
  'north-b.example.org': 'gamma.example.org',
  'north-c.example.org': 'alpha.example.org',
  'south-a.example.org': 'alpha.example.org',
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
        { label: 'North Programme', hosts: ['north-a.example.org', 'north-b.example.org', 'north-c.example.org'] },
        { label: 'South Programme', hosts: ['south-a.example.org'] },
        { label: 'Other', hosts: ['alpha.example.org', 'beta.example.org', 'gamma.example.org'] },
      ]);
      // Never analysed: no project directory, no session, no cost.
      expect(fs.existsSync(path.join(r.root, 'cht-dev-example-org'))).to.equal(false);
      const summary = r.read('agent.summary.json');
      expect([...summary.projects_analysed, ...summary.projects_skipped]).to.not.include('https://cht-dev.example.org');

      // The brief (revision 28): two body slots for the two highest-ranked units, the North Programme as one bullet
      // with a line per project; the rest in the thread, a programme of two or more projects as its own reply and
      // the single projects together in the Other reply.
      const brief = r.read('rollup/brief.json');
      expect(brief.kind).to.equal('brief');
      expect(brief.bullets).to.have.length(2);
      expect(brief.thread.length).to.be.within(1, 2);
      const containers = [...brief.bullets, ...brief.thread];
      const north = containers.find((b) => b.group === 'North Programme');
      expect(north).to.include({
        kind: 'group', text: 'North Programme: 3 projects with issues', item_id: null,
      });
      expect(north.children).to.have.length(3);
      const ranked = r.read('rollup/items.ranked.json');
      const northItems = ranked.filter((i) => /north/.test(i.project_url));
      expect(north.children.map((c) => c.item_id).sort()).to.deep.equal(northItems.map((i) => i.item_id).sort());
      for (const child of north.children) {
        expect(child.text.split('\n').length).to.be.at.most(2);
        // The project is written by code as the member's short host (FR-069, revision 26).
        expect(child.text).to.match(/^north-[abc]: /);
      }
      const northInBody = brief.bullets.includes(north);
      expect(northItems.every((i) => i.placement === (northInBody ? 'body' : 'thread'))).to.equal(true);
      // South Programme has one flagged project: a unit of its own in the body, or a line of the Other reply.
      const text = JSON.stringify(containers);
      expect(text).to.match(/south-a(\.example\.org)?: /);
      expect(text).to.match(/alpha(\.example\.org)?: /).and.match(/gamma(\.example\.org)?: /);
      expect(brief.thread.every((b) => b.kind === 'group' && ['North Programme', 'Other'].includes(b.group)))
        .to.equal(true);

      // The layout is written by code and agrees with the brief; every flagged project has a line somewhere.
      const layout = r.read('rollup/layout.json');
      expect(layout.slots).to.have.length(brief.bullets.length);
      expect(layout.replies).to.have.length(brief.thread.length);
      const northContainer = [...layout.slots, ...layout.replies].find((s) => s.group === 'North Programme');
      expect(northContainer.item_ids.sort()).to.deep.equal(north.children.map((c) => c.item_id).sort());
      // thread_items are the items outside the body; here every one of them has a line in a reply.
      const shown = new Set([...layout.slots, ...layout.replies].flatMap((c) => c.entries.flatMap((e) => e.item_ids)));
      expect(ranked.every((i) => shown.has(i.item_id))).to.equal(true);
      expect(layout.thread_items).to.have.length(ranked.length - layout.body_items.length);
      expect(r.read('rollup/verification.draft1.json').outcome).to.equal('accepted');

      // Slack: the headline section, one section per body bullet with its lines indented, one reply per thread
      // bullet, and the ignored host named nowhere.
      const payload = r.read('rollup/payload.json');
      const sections = payload.parent.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
      expect(sections).to.have.length(brief.bullets.length + 1);
      expect(sections[0]).to.match(/^\*.*\*$/s);
      const northReply = payload.replies.find((reply) => reply.group === 'North Programme');
      // The rendered group carries its severity marker in front of the stored text (FR-082), then three lines.
      const northText = northInBody
        ? sections.find((s) => /^\S+ North Programme: 3 projects with issues/.test(s))
        : northReply.text;
      expect(northText.split('\n')).to.have.length(4);
      if (northInBody) {
        expect(northText.split('\n').slice(1).every((line) => line.startsWith('   ◦ '))).to.equal(true);
        expect(payload.parent.text).to.match(/• \S+ North Programme: 3 projects with issues\n {3}◦ /);
      } else {
        expect(northReply).to.include({ kind: 'programme' });
        expect(northText.split('\n').slice(1).every((line) => line.startsWith('• north-'))).to.equal(true);
      }
      expect(payload.replies.filter((reply) => reply.kind !== 'alerts')).to.have.length(brief.thread.length);
      expect(payload.replies.some((reply) => reply.item_id)).to.equal(false);
      expect(JSON.stringify(payload)).to.not.include('cht-dev');
      expect(r.slack.chat.postMessage.callCount).to.equal(1 + payload.replies.length);
      const report = fs.readFileSync(path.join(r.root, 'rollup', 'report.html'), 'utf8');
      if (northInBody) {
        expect(report).to.include('North Programme: 3 projects with issues');
        expect(report).to.include('<ul class="sub">');
      }
      expect(report).to.not.include('cht-dev');
    });

  it('scenario 4: more units than slots keeps two bullets in the body and threads the rest', async () => {
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
    expect(brief.bullets).to.have.length(2);
    const containers = [...brief.bullets, ...brief.thread];
    expect(containers.every((b) => b.text.split('\n').length <= 2)).to.equal(true);
    expect(containers.every((b) => b.children.length <= 4)).to.equal(true);
    expect(containers.every((b) => b.children.filter((c) => c.item_id).length <= 3)).to.equal(true);
    const ranked = r.read('rollup/items.ranked.json');
    // Nine flagged projects in seven units: two units fill the body; a programme of two or more projects outside
    // the body gets its own reply; the single projects share the Other reply, which names three and counts the
    // rest, and those live only in the report (FR-020, FR-022).
    expect(ranked).to.have.length(9);
    const layout = r.read('rollup/layout.json');
    expect(layout.slots).to.have.length(2);
    const inBody = layout.body_items.length;
    expect(ranked.filter((i) => i.placement === 'body')).to.have.length(inBody);
    expect(ranked.filter((i) => i.placement === 'thread')).to.have.length(9 - inBody);
    const other = brief.thread.find((b) => b.group === 'Other');
    expect(other, 'an Other reply').to.not.equal(undefined);
    expect(layout.thread_items).to.have.length(9 - inBody);
    const shownInThread = new Set(layout.replies.flatMap((r) => r.entries.flatMap((e) => e.item_ids)));
    const onlyInReport = layout.thread_items.filter((id) => !shownInThread.has(id));
    expect(onlyInReport.length).to.be.at.least(1);
    expect(other.children[other.children.length - 1].text).to.match(/^\+\d+ more projects? in the report$/);
    expect(other.children.filter((c) => c.item_id)).to.have.length(3);
    const payload = r.read('rollup/payload.json');
    expect(payload.replies.filter((reply) => reply.kind !== 'alerts')).to.have.length(brief.thread.length);
    expect(payload.replies.some((reply) => reply.item_id)).to.equal(false);
    expect(payload.report).to.include({ items: 9 });
    expect(payload.report.initial_comment).to.include('Full report: 9 items');
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include(`${9 - inBody} more items in the report`);
    expect(payload.parent.blocks.filter((b) => b.type === 'section')).to.have.length(3);
    for (const n of [1]) {
      const report = r.read(`rollup/verification.draft${n}.json`);
      expect(report.outcome).to.equal('accepted');
      expect(report.checks.find((c) => c.name === 'bullet_count').status).to.equal('pass');
    }
  });
});

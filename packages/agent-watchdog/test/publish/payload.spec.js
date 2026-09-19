const fs = require('node:fs');
const path = require('node:path');
const { buildPayload, withImageBlock } = require('../../src/publish/payload');
const { AUDIENCES, assertAudience } = require('../../src/publish/audience');
const { makeItem, makeBrief } = require('../rollup/factories');

const SLACK_TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'slack');

describe('publish/audience', () => {
  it('knows the audiences and only accepts internal in this feature', () => {
    expect(AUDIENCES).to.include.members(['internal', 'partner']);
    expect(() => assertAudience('internal')).to.not.throw();
    expect(() => assertAudience('partner')).to.throw(/partner/);
    expect(() => assertAudience(undefined)).to.throw();
  });
});

describe('publish/payload', () => {
  const item = makeItem({ rank: 1, placement: 'body', why_now: 'Backlog <3x & rising>' });
  const second = makeItem({
    metric: 'cht_conflict_count', severity: 'low', rank: 2, placement: 'body', confidence: 0.4,
  });
  const brief = makeBrief({
    bullets: [
      { item_id: item.item_id, text: 'alpha sentinel backlog 912 vs 300 & climbing' },
      { item_id: second.item_id, text: 'conflicts up' },
    ],
    expected_load_notice: 'Month-end window active',
  });
  const links = new Map([[item.item_id, 'https://watchdog.example.org/d/oa2OfL-Vk/cht-admin-overview?orgId=1&var-cht_instance=alpha.example.org']]);
  const args = {
    brief, items: [item, second], links, runId: '2026-09-18', date: '2026-09-18', audience: 'internal', channel: 'C123',
  };

  it('builds the parent message with header, bullet sections, notices, footer and registered metadata', () => {
    const payload = buildPayload(args);
    expect(payload.run_id).to.equal('2026-09-18');
    expect(payload.kind).to.equal('brief');
    expect(payload.parent.channel).to.equal('C123');
    const types = payload.parent.blocks.map((b) => b.type);
    expect(types[0]).to.equal('header');
    expect(types.filter((t) => t === 'section')).to.have.length(2);
    expect(types).to.not.include('image');
    expect(types.filter((t) => t === 'context')).to.have.length(2);
    expect(payload.parent.blocks[1].text.text).to.include('912 vs 300 &amp; climbing');
    const footer = payload.parent.blocks[payload.parent.blocks.length - 1].elements[0].text;
    expect(footer).to.include('<https://github.com/medic/cht-ai-tools/tree/main/packages/agent-watchdog/prompts|prompts>');
    expect(footer).to.include('cost $0.12');
    expect(payload.parent.text).to.include('Sentinel backlog tripled on alpha');
    expect(payload.parent.text.length).to.be.at.most(4000);
    expect(payload.parent.metadata).to.deep.equal({
      event_type: 'agent_watchdog.brief',
      event_payload: { run_id: '2026-09-18', date: '2026-09-18', kind: 'brief' },
    });
    expect(payload.parent.unfurl_links).to.equal(false);
    expect(payload.image).to.deep.equal({
      filename: 'brief-2026-09-18.png', alt_text: 'Sentinel backlog tripled on alpha', path: null, slack_file_id: null,
    });
  });

  it('adds one threaded reply per item in rank order with escaped text, the dashboard link and item metadata', () => {
    const payload = buildPayload(args);
    expect(payload.replies).to.have.length(2);
    expect(payload.replies[0].item_id).to.equal(item.item_id);
    expect(payload.replies[0].text).to.include('Backlog &lt;3x &amp; rising&gt;');
    expect(payload.replies[0].text).to.include('|dashboard>');
    expect(payload.replies[1].text).to.not.include('|dashboard>');
    expect(payload.replies[0].metadata).to.deep.equal({
      event_type: 'agent_watchdog.item',
      event_payload: {
        run_id: '2026-09-18', item_id: item.item_id, project_url: item.project_url, metric: item.metric,
      },
    });
    expect(payload.replies[0].blocks[0].type).to.equal('section');
  });

  it('truncates a long header and the fallback text within Slack limits', () => {
    const longBrief = makeBrief({
      headline: 'x'.repeat(400),
      bullets: [{ item_id: item.item_id, text: 'y'.repeat(3900) }],
    });
    const payload = buildPayload({ ...args, brief: longBrief, items: [item] });
    expect(payload.parent.blocks[0].text.text.length).to.be.at.most(150);
    expect(payload.parent.text.length).to.be.at.most(4000);
  });

  it('includes the image block only once a Slack file id exists', () => {
    const withFile = makeBrief({ image: { path: 'rollup/brief.png', slack_file_id: 'F123' } });
    const payload = buildPayload({ ...args, brief: withFile, items: [item] });
    const image = payload.parent.blocks.find((b) => b.type === 'image');
    expect(image).to.deep.equal({ type: 'image', slack_file: { id: 'F123' }, alt_text: withFile.headline });
    const later = withImageBlock(buildPayload(args), 'F999');
    expect(later.parent.blocks.find((b) => b.type === 'image').slack_file.id).to.equal('F999');
    expect(later.image.slack_file_id).to.equal('F999');
    const idx = later.parent.blocks.findIndex((b) => b.type === 'image');
    expect(later.parent.blocks[idx - 1].type).to.equal('section');
  });

  it('produces text-only heartbeat and failure payloads with metadata and no replies', () => {
    const quiet = makeBrief({
      kind: 'heartbeat', headline: 'All quiet: 3 projects and 3 panels checked, no candidates', bullets: [],
    });
    const heartbeat = buildPayload({ ...args, brief: quiet, items: [] });
    expect(heartbeat.parent.blocks).to.equal(undefined);
    expect(heartbeat.parent.text).to.include('All quiet');
    expect(heartbeat.parent.metadata.event_payload.kind).to.equal('heartbeat');
    expect(heartbeat.replies).to.deep.equal([]);
    expect(heartbeat.image).to.equal(null);
    const failed = makeBrief({ kind: 'failure', headline: 'Run failed: metrics source unreachable', bullets: [] });
    const failure = buildPayload({ ...args, brief: failed, items: [] });
    expect(failure.parent.text).to.include('Run failed');
    expect(failure.parent.text).to.include('|trace>');
    expect(failure.replies).to.deep.equal([]);
  });

  it('rejects any audience other than internal', () => {
    expect(() => buildPayload({ ...args, audience: 'partner' })).to.throw(/partner/);
  });

  it('routes every Slack template substitution through the mrkdwn helper', () => {
    for (const file of fs.readdirSync(SLACK_TEMPLATES)) {
      const text = fs.readFileSync(path.join(SLACK_TEMPLATES, file), 'utf8');
      const substitutions = [...text.matchAll(/\{\{([^#/!][^}]*)\}\}/g)].map((m) => m[1].trim());
      const allowed = (v) => v.startsWith('mrkdwn ') || v.startsWith('else') || v.startsWith('link ');
      const raw = substitutions.filter((v) => !allowed(v));
      expect(raw, `${file}: ${raw.join(', ')}`).to.deep.equal([]);
      expect(text).to.not.include('{{{');
    }
  });
});

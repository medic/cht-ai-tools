'use strict';
// FR-009 (revision 20): an item may name another item of the same findings as related, by that item's metric. The
// analysis cannot know an item id, since code derives it, so the metric is the handle and the gate checks it.
const { check, RELATIONS } = require('../../../src/verify/checks/relates_to');
const { baseContext } = require('../helpers/context');

const withItems = (relatesTo, second = 'cht_outbound_push_backlog_count') => {
  const ctx = baseContext();
  const [first] = ctx.findings.items;
  const sibling = JSON.parse(JSON.stringify(first));
  sibling.item_key = { ...sibling.item_key, metric: second };
  ctx.findings.items = [{ ...first, relates_to: relatesTo }, sibling];
  ctx.items = [
    { ...ctx.items[0], relates_to: relatesTo ? { ...relatesTo, item_id: 'b2c3d4e5f6a7' } : null },
    { ...ctx.items[0], item_id: 'b2c3d4e5f6a7', metric: second, relates_to: null },
  ];
  return ctx;
};

describe('verify/checks/relates_to', () => {
  it('passes an item naming another item of the same findings, with a known relation', () => {
    for (const relation of RELATIONS) {
      const ctx = withItems({ metric: 'cht_outbound_push_backlog_count', relation });
      expect(check(ctx), relation).to.include({ status: 'pass' });
    }
  });

  it('passes an item that names no relation at all, which is the common case', () => {
    expect(check(withItems(null)).status).to.equal('pass');
    expect(check(baseContext()).status).to.equal('pass');
  });

  it('fails an item that names its own metric: nothing explains itself', () => {
    const ctx = withItems({ metric: 'cht_sentinel_backlog_count', relation: 'level_of' });
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('itself');
  });

  it('fails a metric that is not another item of the same findings', () => {
    const ctx = withItems({ metric: 'cht_conflict_count', relation: 'same_cause' });
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('cht_conflict_count');
    expect(result.reasons[0]).to.include('not another item');
  });

  it('fails a relation that is not one of the four, naming the ones that are', () => {
    const ctx = withItems({ metric: 'cht_outbound_push_backlog_count', relation: 'causes' });
    const result = check(ctx);
    expect(result.status).to.equal('fail');
    expect(result.reasons[0]).to.include('causes');
    for (const relation of RELATIONS) {
      expect(result.reasons[0]).to.include(relation);
    }
  });

  it('names the four relations, level and rate among them', () => {
    expect([...RELATIONS].sort()).to.deep.equal(['consequence_of', 'level_of', 'rate_of', 'same_cause']);
  });
});

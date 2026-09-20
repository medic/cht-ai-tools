// The bounded worker pool the collect stage runs projects through (FR-074).
const { mapWithConcurrency } = require('../../src/collect/concurrency');

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('collect/concurrency', () => {
  it('keeps results in input order and never runs more workers than the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [5, 1, 4, 2, 3, 6, 0];
    const results = await mapWithConcurrency(items, 3, async (n, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      for (let i = 0; i < n; i += 1) {
        await tick();
      }
      inFlight -= 1;
      return `${index}:${n * 10}`;
    });
    expect(results).to.deep.equal(['0:50', '1:10', '2:40', '3:20', '4:30', '5:60', '6:0']);
    expect(peak).to.equal(3);
  });

  it('treats a limit below one as one, handles an empty list, and propagates the first failure', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).to.equal(1);
    expect(await mapWithConcurrency([], 4, async () => 1)).to.deep.equal([]);
    await expect(mapWithConcurrency([1, 2], 2, async (n) => {
      if (n === 2) {
        throw new Error('boom');
      }
      return n;
    })).to.be.rejectedWith('boom');
  });
});

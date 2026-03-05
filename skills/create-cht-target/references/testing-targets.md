# Testing Targets

Verification and automated testing approaches for CHT targets.

---

### Manual Verification

1. Deploy targets: `cht --local compile-app-settings upload-app-settings`
2. Create test data matching your target conditions
3. Check the Targets tab to verify counts/percentages
4. Test edge cases: zero records, boundary dates, duplicate reports

### Using cht-conf-test-harness

For automated testing of target logic:

```bash
npm install cht-conf-test-harness --save-dev
```

```javascript
const { expect } = require('chai');
const Harness = require('cht-conf-test-harness');
const harness = new Harness();

describe('deliveries-this-month target', () => {
  before(async () => await harness.start());
  after(async () => await harness.stop());

  it('should count delivery reports', async () => {
    await harness.setNow('2024-01-15');
    const result = await harness.getTargets({ type: 'delivery' });
    const target = result.find(t => t.id === 'deliveries-this-month');
    expect(target.value.total).to.equal(1);
  });
});
```

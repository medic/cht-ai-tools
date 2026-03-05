# Best Practice: Use Form Calculations for Complex Logic

**When a target requires multiple field conditions, add a calculated field in the XLSForm instead of cluttering targets.js.**

---

## Bad: Complex logic in targets.js

```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'delivery_place') === 'facility' &&
         Utils.getField(report, 'skilled_attendant') === 'yes' &&
         Utils.getField(report, 'complications') === 'none';
}
```

## Good: Add calculation to XLSForm

**In the XLSForm:**

| type | name | calculation |
|------|------|-------------|
| calculate | is_safe_delivery | if(${delivery_place} = 'facility' and ${skilled_attendant} = 'yes' and ${complications} = 'none', 'yes', 'no') |

**In targets.js:**

```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'is_safe_delivery') === 'yes';
}
```

## When to Suggest Form Calculations

Recommend adding a calculated field when:
- **3+ field references** from the same form
- **Complex boolean logic** (multiple AND/OR)
- **Logic reused** in tasks, targets, and contact-summary

## Workflow Integration

During **Step 4 (Gather Requirements)**, if user describes complex conditions:

1. **Identify** the fields involved
2. **Suggest** adding a calculated field
3. **Ask user** if they want you to add it to the XLSForm
4. **If yes**: Execute `scripts/add-xlsform-calculation.py`
5. **Generate** a simple target referencing that field

> **Recommendation:** I notice this target needs multiple conditions. I recommend adding a calculated field `is_safe_delivery` to your form. Would you like me to add this calculation?

## When to Suggest targets-extras.js Instead

Use an **extras file** instead of a form calculation when:
- Logic needs **access to `contact.reports`** (cross-report checks)
- Logic is **shared across multiple targets**
- Logic involves **contact properties** not in any form
- Logic requires **JavaScript operations** not expressible in XLSForm calculations

```javascript
// targets-extras.js
module.exports = {
  isActivePregnancy: function(contact) {
    return contact.reports.some(r =>
      r.form === 'pregnancy' &&
      r.fields && r.fields.edd &&
      new Date(r.fields.edd) > new Date()
    );
  },

  hasRecentVisit: function(contact, formName, daysAgo) {
    const cutoff = Date.now() - (daysAgo * 86400000);
    return contact.reports.some(r =>
      r.form === formName && r.reported_date >= cutoff
    );
  }
};
```

```javascript
// targets.js
const extras = require('./targets-extras');

module.exports = [
  {
    id: 'pregnant-with-recent-anc',
    type: 'percent',
    appliesTo: 'contacts',
    appliesToType: ['person'],
    appliesIf: function(contact) {
      return extras.isActivePregnancy(contact);
    },
    passesIf: function(contact) {
      return extras.hasRecentVisit(contact, 'anc_visit', 30);
    }
  }
];
```

**Decision guide:**

| Condition | Use Form Calculation | Use targets-extras.js |
|-----------|---------------------|----------------------|
| 3+ fields from same form | Yes | No |
| Cross-report checks | No | Yes |
| Shared across targets | Either | Yes (preferred) |
| Shared across targets + tasks | Form calc (if possible) | Yes |
| Contact property checks | No | Yes |

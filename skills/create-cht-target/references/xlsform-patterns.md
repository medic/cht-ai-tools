# XLSForm Patterns for Target Conditions

Common XLSForm patterns and how they map to target conditions.

---

## Best Practice: Consolidate Logic in Form Calculations

**When a target needs multiple field conditions, add a calculated field in the form rather than complex logic in targets.js.**

### Why This Matters

| Approach | Maintainability | Performance | Testability |
|----------|-----------------|-------------|-------------|
| Complex targets.js | Poor | Slower | Hard |
| Form calculation | Good | Faster | Easy |

### Implementation Pattern

**Step 1: Identify complex conditions**

If your target would look like:
```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'delivery_place') === 'facility' &&
         Utils.getField(report, 'skilled_attendant') === 'yes' &&
         Utils.getField(report, 'complications') === 'none';
}
```

**Step 2: Add calculated field to XLSForm**

| type | name | calculation |
|------|------|-------------|
| calculate | is_safe_delivery | if(${delivery_place} = 'facility' and ${skilled_attendant} = 'yes' and ${complications} = 'none', 'yes', 'no') |

**Step 3: Simplify the target**

```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'is_safe_delivery') === 'yes';
}
```

---

## Key Fields for Targets

### Outcome/Result Fields

Fields that indicate success or completion:

| Field Pattern | Target Usage |
|---------------|--------------|
| `outcome`, `result` | passesIf condition |
| `status`, `completed` | appliesIf/passesIf |
| `successful`, `achieved` | Numerator filtering |

**XLSForm:**
```
| type | name | label |
| select_one outcomes | delivery_outcome | Delivery Outcome |
```

**Target:**
```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'delivery_outcome') === 'healthy';
}
```

### Category/Type Fields

Fields for filtering or grouping:

| Field Pattern | Target Usage |
|---------------|--------------|
| `visit_type`, `assessment_type` | appliesToType or appliesIf |
| `risk_level`, `priority` | Conditional filtering |
| `category`, `classification` | groupBy or filtering |

**Target:**
```javascript
appliesIf: function(contact, report) {
  return Utils.getField(report, 'risk_level') === 'high';
}
```

### Boolean/Yes-No Fields

Simple pass/fail indicators:

**XLSForm:**
```
| type | name | label |
| select_one yes_no | referred | Was patient referred? |
| select_one yes_no | counseled | Counseling provided? |
```

**Target:**
```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'counseled') === 'yes';
}
```

### Numeric Fields

For threshold-based conditions:

**XLSForm:**
```
| type | name | label |
| integer | visit_count | Number of visits |
| decimal | weight_kg | Weight (kg) |
```

**Target:**
```javascript
passesIf: function(contact, report) {
  const visits = parseInt(Utils.getField(report, 'visit_count')) || 0;
  return visits >= 4;
}
```

---

## Common Calculation Formulas for Targets

### Boolean Flag

```
if(CONDITION, 'yes', 'no')
```

**Examples:**
```
if(${delivery_place} = 'facility', 'yes', 'no')
if(${anc_visits} >= 4, 'yes', 'no')
if(${risk_level} = 'high' or ${complications} != 'none', 'yes', 'no')
```

### Category Assignment

```
if(COND1, 'cat1', if(COND2, 'cat2', 'default'))
```

**Example:**
```
if(${anc_visits} >= 8, 'complete', if(${anc_visits} >= 4, 'adequate', 'inadequate'))
```

**Target:**
```javascript
passesIf: function(contact, report) {
  const coverage = Utils.getField(report, 'anc_coverage_level');
  return coverage === 'complete' || coverage === 'adequate';
}
```

### Score Calculation

```
(if(COND1, 1, 0) + if(COND2, 1, 0) + if(COND3, 1, 0))
```

**Example (quality score):**
```
(if(${counseled} = 'yes', 1, 0) + if(${vitals_taken} = 'yes', 1, 0) + if(${followup_scheduled} = 'yes', 1, 0))
```

**Target:**
```javascript
passesIf: function(contact, report) {
  const score = parseInt(Utils.getField(report, 'quality_score')) || 0;
  return score >= 2;  // At least 2 of 3 criteria met
}
```

### Multi-Select Check

```
if(selected(${field}, 'value'), 'yes', 'no')
```

**Example:**
```
if(selected(${services_provided}, 'immunization'), 'yes', 'no')
```

---

## Mapping Forms to Targets

### Example: Delivery Form → Multiple Targets

**Form Fields:**
```
- delivery_date (date)
- delivery_place (select_one: facility, home, tba)
- delivery_outcome (select_one: healthy, complications, stillbirth)
- skilled_attendant (select_one yes_no)
- baby_weight (decimal)
```

**Suggested Calculations to Add:**

| name | calculation |
|------|-------------|
| is_facility_delivery | if(${delivery_place} = 'facility', 'yes', 'no') |
| is_safe_delivery | if(${delivery_place} = 'facility' and ${skilled_attendant} = 'yes', 'yes', 'no') |
| is_low_birth_weight | if(number(${baby_weight}) < 2.5, 'yes', 'no') |
| is_healthy_outcome | if(${delivery_outcome} = 'healthy', 'yes', 'no') |

**Resulting Targets:**

```javascript
// Target 1: Facility delivery rate
{
  id: 'facility-deliveries',
  type: 'percent',
  passesIf: (c, r) => Utils.getField(r, 'is_facility_delivery') === 'yes'
}

// Target 2: Safe delivery rate
{
  id: 'safe-deliveries',
  type: 'percent',
  passesIf: (c, r) => Utils.getField(r, 'is_safe_delivery') === 'yes'
}

// Target 3: Low birth weight count
{
  id: 'low-birth-weight',
  type: 'count',
  appliesIf: (c, r) => Utils.getField(r, 'is_low_birth_weight') === 'yes'
}
```

---

## Related Reports Pattern

When a target needs to check other reports (not just the current one):

### Pregnancy with ANC Coverage

**Cannot use form calculation** (needs access to other reports)

```javascript
{
  id: 'pregnancies-with-anc',
  type: 'percent',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  passesIf: function(contact, report) {
    // Must check contact.reports
    const ancVisits = contact.reports.filter(r =>
      r.form === 'anc_visit' &&
      r.reported_date >= report.reported_date
    );
    return ancVisits.length >= 4;
  }
}
```

### When to Keep Logic in targets.js

- Checking **other reports** (contact.reports)
- Using **contact properties** not in the form
- Counting **across multiple forms**
- **GroupBy** logic (inherently needs aggregation)

---

## Reading Forms for Target Analysis

### What to Look For

1. **Outcome fields** → passesIf conditions
2. **Category fields** → appliesIf filters
3. **Date fields** → custom date functions
4. **Numeric fields** → threshold conditions
5. **Existing calculations** → reuse in targets

### Using the Analysis Script

```bash
python scripts/read-xlsform.py forms/app/delivery.xlsx
```

Look for:
- **Important Fields** section for outcome/category fields
- **Select Fields** section for choices that indicate pass/fail
- **Calculated Fields** section for existing logic to reuse

---

## Performance Patterns

### Filter Early with appliesToType

```javascript
// Good: Filter by form type first
{
  appliesTo: 'reports',
  appliesToType: ['delivery'],  // Only process delivery forms
  appliesIf: function(c, r) { ... }
}
```

### Use Simple appliesIf

```javascript
// Good: Simple field check
appliesIf: (c, r) => Utils.getField(r, 'is_eligible') === 'yes'

// Bad: Complex multi-field check
appliesIf: (c, r) => {
  return Utils.getField(r, 'a') === 'x' &&
         Utils.getField(r, 'b') === 'y' &&
         parseInt(Utils.getField(r, 'c')) > 10;
}
```

### Leverage Form Calculations

Move complex logic to form calculations:
- Evaluated once at form submission
- Stored in the report
- Simple to query in targets

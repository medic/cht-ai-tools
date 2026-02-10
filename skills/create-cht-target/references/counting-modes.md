# Counting Modes Reference

Deep dive into `idType`, `groupBy`, and `date` filters for accurate target counting.

## The Counting Problem

Without careful configuration, targets can produce misleading numbers:

| Scenario | Naive Count | Actual Unique |
|----------|-------------|---------------|
| Patient with 3 visits | 3 | 1 patient |
| Family visited 5 times | 5 | 1 family |
| Same form submitted twice | 2 | 1 submission |

Use `idType`, `groupBy`, and `date` to get accurate metrics.

---

## idType: Control What Gets Counted

### `idType: 'report'` (default)

Each report counts as 1.

```javascript
{
  id: 'total-visits',
  type: 'count',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  // idType defaults to 'report'
}
```

**Result:** 10 visits from 3 patients = **10**

### `idType: 'contact'`

Each unique contact counts as 1, regardless of report count.

```javascript
{
  id: 'patients-visited',
  type: 'count',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  idType: 'contact'
}
```

**Result:** 10 visits from 3 patients = **3**

### `idType: function`

Custom unique ID logic.

```javascript
{
  id: 'family-visit-days',
  type: 'count',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  idType: function(contact, report) {
    // Unique per family per day
    const familyId = contact.contact.parent._id;
    const date = new Date(report.reported_date).toISOString().split('T')[0];
    return [`${familyId}~${date}`];
  }
}
```

**Result:** Family visited 3 times on Monday, 2 times on Tuesday = **2** (unique days)

---

## Common idType Patterns

### Count Unique Patients

```javascript
idType: 'contact'
```

### Count Unique Families

```javascript
idType: function(contact, report) {
  return [contact.contact.parent._id];
}
```

### Count Unique Patient-Month Combinations

```javascript
idType: function(contact, report) {
  const patientId = contact.contact._id;
  const month = new Date(report.reported_date).toISOString().slice(0, 7);
  return [`${patientId}~${month}`];
}
```

### Count Unique Form-per-Patient

```javascript
idType: function(contact, report) {
  return [`${contact.contact._id}~${report.form}`];
}
```

---

## groupBy: Aggregate Then Count

Count groups that meet criteria, not individual records.

### Basic Structure

```javascript
{
  groupBy: function(contact, report) {
    return 'grouping-key';  // Records with same key are grouped
  },
  passesIfGroupCount: { gte: N }  // Group passes if N+ records
}
```

### Example: Families with 2+ Visits

**Goal:** What percent of families had at least 2 home visits?

```javascript
{
  id: 'families-2-visits',
  type: 'percent',
  goal: 80,
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  date: 'reported',

  groupBy: function(contact, report) {
    // Group by family
    return contact.contact.parent._id;
  },

  passesIfGroupCount: { gte: 2 }  // 2+ visits = pass
}
```

**Data:**
- Family A: 3 visits → passes
- Family B: 1 visit → fails
- Family C: 2 visits → passes

**Result:** 66% (2 of 3 families)

### Combining idType with groupBy

When using `groupBy`, often need custom `idType` to count correctly:

```javascript
{
  id: 'families-multi-visit',
  type: 'percent',

  // Custom ID: family + date (counts unique visit days)
  idType: function(contact, report) {
    const familyId = contact.contact.parent._id;
    const date = new Date(report.reported_date).toISOString().split('T')[0];
    return [`${familyId}~${date}`];
  },

  // Group by family
  groupBy: function(contact, report) {
    return contact.contact.parent._id;
  },

  passesIfGroupCount: { gte: 2 }
}
```

**Why both?**
- `idType` prevents counting same family twice on same day
- `groupBy` aggregates visits per family

---

## date: Time-Based Filtering

### `date: 'reported'`

Only count documents from **current calendar month**.

```javascript
{
  id: 'visits-this-month',
  date: 'reported'
}
```

- January 15: Shows January visits only
- February 1: Resets, shows February visits only

**Use for:** Monthly metrics, "this month" indicators

### `date: 'now'`

Count **all documents** regardless of date.

```javascript
{
  id: 'total-registrations',
  date: 'now'
}
```

- Always shows cumulative total
- Never resets

**Use for:** Cumulative totals, "all time" indicators

### `date: function`

Custom date logic.

```javascript
{
  id: 'recent-90-days',
  date: function(contact, report) {
    const reportDate = new Date(report.reported_date);
    const now = new Date();
    const daysDiff = (now - reportDate) / (1000 * 60 * 60 * 24);

    // Only count if within last 90 days
    if (daysDiff <= 90) {
      return reportDate;
    }
    return null;  // Exclude
  }
}
```

---

## Choosing the Right Configuration

### Decision Tree

```
What do you want to count?
│
├─ Total reports submitted
│   └─ idType: 'report' (default)
│
├─ Unique patients/contacts
│   └─ idType: 'contact'
│
├─ Unique families/households
│   └─ idType: function → return family ID
│
├─ Groups meeting criteria (e.g., 2+ visits)
│   └─ groupBy: function + passesIfGroupCount
│
└─ Custom unique combinations
    └─ idType: function → return custom ID

What time period?
│
├─ This month only
│   └─ date: 'reported'
│
├─ All time (cumulative)
│   └─ date: 'now'
│
└─ Custom (last 90 days, etc.)
    └─ date: function
```

### Common Configurations

| Metric | idType | groupBy | date |
|--------|--------|---------|------|
| Total visits this month | `'report'` | — | `'reported'` |
| Unique patients visited | `'contact'` | — | `'reported'` |
| Families with 2+ visits | custom | family | `'reported'` |
| All-time registrations | `'report'` | — | `'now'` |
| Unique patients ever | `'contact'` | — | `'now'` |

---

## Percent Targets: Denominator vs Numerator

For percent targets, understand what controls each part:

```javascript
{
  type: 'percent',

  // DENOMINATOR: What records are eligible?
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  appliesIf: function(c, r) {
    return true;  // All deliveries
  },

  // NUMERATOR: Which eligible records "pass"?
  passesIf: function(c, r) {
    return Utils.getField(r, 'place') === 'facility';
  }
}
```

**Result:** `(facility deliveries) / (all deliveries) × 100%`

### With groupBy

```javascript
{
  type: 'percent',

  appliesTo: 'reports',
  appliesToType: ['home_visit'],

  // DENOMINATOR: All families with any visit
  groupBy: function(c, r) {
    return c.contact.parent._id;
  },

  // NUMERATOR: Families with 2+ visits
  passesIfGroupCount: { gte: 2 }
}
```

**Result:** `(families with 2+ visits) / (all families with visits) × 100%`

---

## Performance Considerations

1. **`idType: 'contact'`** is efficient — built-in optimization
2. **Custom `idType` functions** run for every report
3. **`groupBy`** requires processing all reports before counting
4. **Complex conditions** slow down target calculation

### Optimization Tips

- Use `appliesToType` to filter early
- Use `appliesIf` to exclude irrelevant records
- Keep `idType` and `groupBy` functions simple
- Move complex logic to form calculations

# CHT Targets Schema Reference

Complete reference for targets.js configuration.

## Target Object Schema

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| `id` | string | Unique identifier for the target | Yes, unique |
| `type` | `'count'` or `'percent'` | Widget type | Yes |
| `icon` | string | Icon key from resources.json | No |
| `goal` | integer | Target goal. -1 for no goal | Yes |
| `translation_key` | translation key | Widget title | Yes |
| `subtitle_translation_key` | translation key | Subtitle (e.g., "This month") | No |
| `percentage_count_translation_key` | translation key | Text below percent bar | No |
| `context` | string | JS expression for visibility | No |
| `appliesTo` | `'contacts'` or `'reports'` | What to count | Yes |
| `appliesToType` | string[] | Filter by form codes or contact types | No |
| `appliesIf` | function(contact, report) | Filter condition | No |
| `passesIf` | function(contact, report) | Numerator condition (percent only) | Yes* |
| `date` | `'reported'`, `'now'`, or function | Time filter | No |
| `idType` | `'report'`, `'contact'`, or function | Counting mode | No |
| `groupBy` | function(contact, report) | Group aggregation | No |
| `passesIfGroupCount` | object | Group pass criteria | Yes** |
| `visible` | boolean | Show on targets page | No |
| `aggregate` | boolean | Show on TargetAggregates | No |
| `dhis` | object or object[] | DHIS2 integration | No |

*Required for `type: 'percent'` unless `groupBy` is defined.
**Required when `groupBy` is defined.

---

## Target Types

### Count Target

Shows a total number with optional goal.

```javascript
{
  id: 'registrations-count',
  type: 'count',
  goal: 20,           // Target: 20 registrations
  // goal: -1         // No goal (just shows count)
  ...
}
```

**Display:** "15" or "15 / 20" (if goal set)

### Percent Target

Shows progress bar with percentage.

```javascript
{
  id: 'coverage-percent',
  type: 'percent',
  goal: 80,           // Target: 80%
  appliesIf: ...,     // Denominator
  passesIf: ...,      // Numerator
  ...
}
```

**Display:** Progress bar showing "75%" with "15 of 20" below

---

## Date Filtering

| Value | Behavior |
|-------|----------|
| `'reported'` | Only documents with `reported_date` in current month |
| `'now'` | All documents regardless of date (cumulative) |
| `function(c, r)` | Custom function returns Date |

### Examples

```javascript
// This month only
date: 'reported'

// All time
date: 'now'

// Custom: based on a field
date: function(contact, report) {
  return new Date(Utils.getField(report, 'visit_date'));
}
```

---

## Counting Modes (idType)

Controls how documents are counted to avoid duplicates.

| Value | Behavior |
|-------|----------|
| `'report'` | Count each report individually (default) |
| `'contact'` | Count unique contacts (prevents double-counting) |
| `function(c, r)` | Returns array of unique IDs to count |

### When to Use `idType: 'contact'`

Use when you want to count **unique patients**, not total reports:

```javascript
{
  id: 'patients-visited',
  type: 'count',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  idType: 'contact',  // Count unique patients, not visits
  date: 'reported'
}
```

**Without `idType: 'contact'`:** Patient with 3 visits = counted 3 times
**With `idType: 'contact'`:** Patient with 3 visits = counted 1 time

### Custom idType Function

```javascript
idType: function(contact, report) {
  // Count unique family-date combinations
  const familyId = contact.contact.parent._id;
  const date = new Date(report.reported_date).toISOString().split('T')[0];
  return [`${familyId}~${date}`];
}
```

---

## Group Aggregation (groupBy)

Count groups that meet criteria instead of individual records.

**Use case:** "Families with 2+ home visits this month"

```javascript
{
  id: 'families-multi-visit',
  type: 'percent',
  goal: 80,
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  date: 'reported',

  // Group by family
  groupBy: function(contact, report) {
    return contact.contact.parent._id;
  },

  // Family passes if 2+ visits
  passesIfGroupCount: { gte: 2 }
}
```

**Important:** When using `groupBy`, you cannot use `passesIf`. Use `passesIfGroupCount` instead.

### passesIfGroupCount Options

| Property | Description |
|----------|-------------|
| `gte` | Group passes if count >= value |

---

## Context Filter

Show target only for certain users. The `context` property is a JavaScript expression string — if it evaluates to falsy, the widget is hidden.

```javascript
// Only show to CHWs
{
  id: 'chw-visits',
  context: 'user.role === "chw"',
  ...
}

// Only show to supervisors
{
  id: 'supervisor-overview',
  context: 'user.role === "supervisor"',
  ...
}

// Show to multiple roles
{
  id: 'shared-target',
  context: 'user.role === "chw" || user.role === "nurse"',
  ...
}
```

Available variables: `user` (contains `role`, `facility_id`, `contact_id`, `name`)

---

## Visibility and Aggregation

### `visible` Property

Controls whether the target appears on the Targets tab. Default: `true`.

Use `visible: false` for targets that should only appear on the TargetAggregates page (supervisor view) but not on individual CHW targets.

```javascript
{
  id: 'aggregation-only-target',
  visible: false,      // Hidden from CHW targets tab
  aggregate: true,     // Visible on supervisor aggregates
  ...
}
```

### `aggregate` Property (3.9+)

When `true`, this target appears on the TargetAggregates page, allowing supervisors to see combined data across multiple CHWs.

```javascript
{
  id: 'deliveries-this-month',
  type: 'count',
  icon: 'infant',
  goal: 10,
  translation_key: 'targets.deliveries.title',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  date: 'reported',
  aggregate: true      // Supervisors can see totals across all CHWs
}
```

**Common combinations:**

| visible | aggregate | Behavior |
|---------|-----------|----------|
| `true` (default) | `false` (default) | CHW sees it, supervisor does not aggregate |
| `true` | `true` | CHW sees it AND supervisor sees aggregated |
| `false` | `true` | Only supervisor sees aggregated (hidden from CHW) |
| `false` | `false` | Target is completely hidden (used for testing) |

---

## DHIS2 Integration

The `dhis` property maps target data to DHIS2 data elements for reporting.

### Single Data Element

```javascript
{
  id: 'deliveries-this-month',
  type: 'count',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  date: 'reported',
  dhis: {
    dataElement: 'ABC123DEF45',
    dataSet: 'XYZ789GHI01'
  }
}
```

### Multiple Data Elements

For percent targets, map both pass and total:

```javascript
{
  id: 'facility-delivery-rate',
  type: 'percent',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  dhis: [
    {
      dataElement: 'PASS_ELEMENT_ID',
      dataSet: 'DATASET_ID'
    },
    {
      dataElement: 'TOTAL_ELEMENT_ID',
      dataSet: 'DATASET_ID'
    }
  ]
}
```

**Note:** DHIS2 integration requires coordination with the MoH's DHIS2 instance. The `dataElement` and `dataSet` IDs come from the DHIS2 system.

---

## Contact-Based Targets

When `appliesTo: 'contacts'`, the target iterates over contacts (people/places) instead of reports.

**Critical difference:** The `report` parameter is `undefined` in contact-based targets. Use `contact.reports` to access reports.

### Count: Active Pregnant Women

```javascript
{
  id: 'active-pregnancies',
  type: 'count',
  icon: 'pregnancy',
  goal: -1,
  translation_key: 'targets.active_pregnancies.title',
  appliesTo: 'contacts',
  appliesToType: ['person'],
  date: 'now',
  appliesIf: function(contact) {
    // report is undefined for contact-based targets
    const validPregnancy = contact.reports.find(r =>
      r.form === 'pregnancy' &&
      r.fields &&
      r.fields.edd &&
      new Date(r.fields.edd) > Utils.now()
    );
    return !!validPregnancy;
  }
}
```

### Percent: Children Under 5 Fully Immunized

```javascript
{
  id: 'under5-immunized',
  type: 'percent',
  icon: 'child',
  goal: 100,
  translation_key: 'targets.under5_immunized.title',
  appliesTo: 'contacts',
  appliesToType: ['person'],
  date: 'now',
  appliesIf: function(contact) {
    // Denominator: children under 5
    if (!contact.contact.date_of_birth) return false;
    const ageMs = Date.now() - new Date(contact.contact.date_of_birth).getTime();
    const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
    return ageYears < 5;
  },
  passesIf: function(contact) {
    // Numerator: has completed immunization schedule
    return contact.reports.some(r =>
      r.form === 'immunization' &&
      r.fields &&
      r.fields.schedule_complete === 'yes'
    );
  }
}
```

### Percent: Households Visited This Month (Contact-Based)

```javascript
{
  id: 'households-visited',
  type: 'percent',
  icon: 'home-visit',
  goal: 100,
  translation_key: 'targets.households_visited.title',
  context: 'user.role === "chw"',
  appliesTo: 'contacts',
  appliesToType: ['clinic'],
  date: 'reported',
  passesIf: function(contact) {
    return contact.reports.some(r => r.form === 'home_visit');
  }
}
```

---

## Complete Examples

### Count: Deliveries This Month

```javascript
{
  id: 'deliveries-this-month',
  type: 'count',
  icon: 'infant',
  goal: 10,
  translation_key: 'targets.deliveries.title',
  subtitle_translation_key: 'targets.this_month.subtitle',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  date: 'reported'
}
```

### Count: Active Patients (Unique)

```javascript
{
  id: 'active-patients',
  type: 'count',
  icon: 'person',
  goal: 50,
  translation_key: 'targets.active.title',
  appliesTo: 'reports',
  appliesToType: ['assessment', 'home_visit', 'followup'],
  date: 'reported',
  idType: 'contact'  // Count unique contacts
}
```

### Percent: Facility Deliveries

```javascript
{
  id: 'facility-delivery-rate',
  type: 'percent',
  icon: 'hospital',
  goal: 80,
  translation_key: 'targets.facility_delivery.title',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  date: 'reported',
  appliesIf: function(contact, report) {
    // Denominator: all deliveries
    return true;
  },
  passesIf: function(contact, report) {
    // Numerator: facility deliveries
    return Utils.getField(report, 'delivery_place') === 'facility';
  }
}
```

### Percent: Pregnancies with ANC Visit

```javascript
{
  id: 'anc-coverage',
  type: 'percent',
  icon: 'nurse',
  goal: 100,
  translation_key: 'targets.anc_coverage.title',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  date: 'now',
  passesIf: function(contact, report) {
    // Check if any ANC visit exists after pregnancy registration
    return contact.reports.some(r =>
      r.form === 'anc_visit' &&
      r.reported_date >= report.reported_date
    );
  }
}
```

### Percent: Families with 2+ Visits (GroupBy)

```javascript
{
  id: 'families-visited-twice',
  type: 'percent',
  icon: 'family',
  goal: 80,
  translation_key: 'targets.family_coverage.title',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  date: 'reported',
  idType: function(contact, report) {
    const familyId = contact.contact.parent._id;
    const date = new Date(report.reported_date).toISOString().split('T')[0];
    return [`${familyId}~${date}`];
  },
  groupBy: function(contact, report) {
    return contact.contact.parent._id;
  },
  passesIfGroupCount: { gte: 2 }
}
```

### Conditional Count with Filter

```javascript
{
  id: 'high-risk-pregnancies',
  type: 'count',
  icon: 'risk',
  goal: -1,
  translation_key: 'targets.high_risk.title',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  date: 'reported',
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'risk_level') === 'high';
  }
}
```

---

## Translation Keys

Standard subtitle keys:

| Key | Display |
|-----|---------|
| `targets.this_month.subtitle` | "This month" |
| `targets.all_time.subtitle` | "All time" |

Percent count default: `targets.count.default` → "{{pass}} of {{total}}"

---

## Using Extras File

For complex reusable logic:

```javascript
// targets-extras.js
module.exports = {
  isHighRisk: function(report) {
    return Utils.getField(report, 'risk_level') === 'high';
  },

  hasANCVisit: function(contact, pregnancyReport) {
    return contact.reports.some(r =>
      r.form === 'anc_visit' &&
      r.reported_date >= pregnancyReport.reported_date
    );
  }
};
```

```javascript
// targets.js
const extras = require('./targets-extras');

module.exports = [{
  id: 'high-risk-with-anc',
  type: 'percent',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  appliesIf: function(c, r) {
    return extras.isHighRisk(r);
  },
  passesIf: function(c, r) {
    return extras.hasANCVisit(c, r);
  }
}];
```

---

## Important Notes

1. **`idType: 'contact'`** prevents double-counting same person
2. **`date: 'reported'`** resets each month
3. **`passesIf`** forbidden when using `groupBy`
4. Use `Utils.getField()` for safe field access
5. Targets update when reports sync to device
6. Test with representative sample data

---

## Utils Functions Available in Targets

| Function | Description | Example |
|----------|-------------|---------|
| `Utils.getField(report, path)` | Safely get nested field value | `Utils.getField(r, 'vitals.weight')` |
| `Utils.getMostRecentReport(reports, form)` | Latest report of a form type | `Utils.getMostRecentReport(contact.reports, 'anc_visit')` |
| `Utils.getMostRecentTimestamp(reports, form)` | Latest reported_date for form | `Utils.getMostRecentTimestamp(contact.reports, 'home_visit')` |
| `Utils.isFormSubmittedInWindow(reports, form, start, end)` | Check if form submitted in time range | `Utils.isFormSubmittedInWindow(contact.reports, 'visit', start, end)` |
| `Utils.addDate(date, days)` | Add days to a date | `Utils.addDate(new Date(), -30)` |
| `Utils.now()` | Current date | `Utils.now()` |
| `Utils.MS_IN_DAY` | Milliseconds constant (86400000) | `30 * Utils.MS_IN_DAY` |

# XLSForm Patterns for Task Triggers

Common XLSForm patterns and how they map to task conditions.

---

## Best Practice: Consolidate Logic in Form Calculations

**When a task needs multiple field conditions, add a calculated field in the form rather than complex logic in tasks.js.**

### Why This Matters

| Approach | Maintainability | Performance | Testability |
|----------|-----------------|-------------|-------------|
| Complex tasks.js | Poor - logic scattered | Slower - multiple getField calls | Hard - need full CHT setup |
| Form calculation | Good - single source | Faster - one field access | Easy - test in form preview |

### Implementation Pattern

**Step 1: Identify complex conditions**

If your task would look like this:
```javascript
appliesIf: function(contact, report) {
  const risk = Utils.getField(report, 'risk_level');
  const place = Utils.getField(report, 'delivery_place');
  const complications = Utils.getField(report, 'complications');
  const weight = Utils.getField(report, 'baby_weight');
  return risk === 'high' && place === 'home' &&
         complications !== 'none' && weight < 2.5;
}
```

**Step 2: Create a calculated field in XLSForm**

Add to the form's survey sheet (typically near the end, before summary group):

| type | name | label | calculation |
|------|------|-------|-------------|
| calculate | needs_urgent_pnc | | if(${risk_level} = 'high' and ${delivery_place} = 'home' and ${complications} != 'none' and number(${baby_weight}) < 2.5, 'yes', 'no') |

**Step 3: Simplify the task**

```javascript
appliesIf: function(contact, report) {
  return Utils.getField(report, 'needs_urgent_pnc') === 'yes';
}
```

### Common Calculation Formulas

#### Boolean Flag (yes/no)

```
if(CONDITION, 'yes', 'no')
```

Examples:
```
if(${risk} = 'high', 'yes', 'no')
if(${age} >= 18 and ${consent} = 'yes', 'yes', 'no')
if(selected(${symptoms}, 'fever') or selected(${symptoms}, 'cough'), 'yes', 'no')
```

#### Risk Score (numeric)

```
(if(COND1, 1, 0) + if(COND2, 1, 0) + if(COND3, 1, 0))
```

Example:
```
(if(${bp_systolic} > 140, 1, 0) + if(${age} > 35, 1, 0) + if(${previous_complications} = 'yes', 1, 0))
```

Then in task:
```javascript
appliesIf: function(contact, report) {
  return parseInt(Utils.getField(report, 'risk_score')) >= 2;
}
```

#### Category Assignment

```
if(COND1, 'category1', if(COND2, 'category2', 'default'))
```

Example:
```
if(${risk_score} >= 3, 'high', if(${risk_score} >= 1, 'medium', 'low'))
```

#### Date Calculation

```
if(${field} != '', ${field}, date-time(decimal-date-time(today()) + DAYS))
```

Example (next visit 30 days from today if not specified):
```
if(${next_visit_date} != '', ${next_visit_date}, date-time(decimal-date-time(today()) + 30))
```

### When NOT to Use Form Calculations

Keep logic in tasks.js when:

- Condition depends on **other reports** (not just the triggering report)
- Condition uses **contact properties** not available in the form
- Logic needs **Utils functions** like `getMostRecentReport`
- Simple single-field check (e.g., `risk_level === 'high'`)

## Key Fields for Tasks

When analyzing forms for task creation, focus on these field patterns:

| Field Type | Task Usage | Example Fields |
|------------|------------|----------------|
| Date fields | Scheduling due dates | `delivery_date`, `lmp_date`, `next_visit` |
| Select fields | Conditional triggers | `risk_level`, `outcome`, `delivery_place` |
| Calculated | Derived conditions | `edd`, `gestational_age`, `bmi` |
| Hidden/ID | Contact association | `patient_id`, `_id`, `place_id` |

---

## Date Fields

### Common Date Patterns

| Field Name | Description | Task Usage |
|------------|-------------|------------|
| `lmp_date` | Last menstrual period | Calculate EDD, ANC schedule |
| `edd` | Expected delivery date | Delivery reminder |
| `delivery_date` | Actual delivery | Postnatal visits |
| `birth_date`, `dob` | Date of birth | Immunization schedule |
| `visit_date` | Current visit | Follow-up scheduling |
| `next_visit` | Scheduled return | Reminder task |

### Using Date Fields in Tasks

```javascript
// Custom due date from form field
events: [{
  id: 'delivery-reminder',
  start: 14,
  end: 7,
  dueDate: function(event, contact, report) {
    const edd = Utils.getField(report, 'edd');
    if (edd) {
      return new Date(edd);
    }
    // Fallback: calculate from LMP
    const lmp = Utils.getField(report, 'lmp_date');
    if (lmp) {
      return Utils.addDate(new Date(lmp), 280);  // 40 weeks
    }
    return null;
  }
}]
```

---

## Select Fields as Conditions

### Risk Level Patterns

Form structure:
```
| type | name | label |
|------|------|-------|
| select_one risk | risk_level | Risk Assessment |
```

Choices:
```
| list_name | name | label |
|-----------|------|-------|
| risk | high | High Risk |
| risk | medium | Medium Risk |
| risk | low | Low Risk |
```

Task condition:
```javascript
appliesIf: function(contact, report) {
  const risk = Utils.getField(report, 'risk_level');
  return risk === 'high' || risk === 'medium';
}
```

### Outcome-Based Triggers

Form structure:
```
| type | name | label |
|------|------|-------|
| select_one outcomes | delivery_outcome | Delivery Outcome |
```

Task condition:
```javascript
appliesIf: function(contact, report) {
  const outcome = Utils.getField(report, 'delivery_outcome');
  return outcome === 'live_birth';  // Only for live births
}
```

### Location-Based Conditions

```javascript
appliesIf: function(contact, report) {
  const place = Utils.getField(report, 'delivery_place');
  // Higher priority follow-up for home deliveries
  return place === 'home' || place === 'traditional_birth_attendant';
}
```

---

## Multi-Select Fields

Form structure:
```
| type | name | label |
|------|------|-------|
| select_multiple symptoms | danger_signs | Danger Signs Present |
```

Choices:
```
| list_name | name | label |
|-----------|------|-------|
| symptoms | fever | Fever |
| symptoms | bleeding | Bleeding |
| symptoms | convulsions | Convulsions |
| symptoms | none | None |
```

Task condition:
```javascript
appliesIf: function(contact, report) {
  const signs = Utils.getField(report, 'danger_signs');
  // Check if any danger sign selected (not just 'none')
  return signs && signs !== 'none' && !signs.includes('none');
}
```

---

## Calculated Fields

### Common Calculations

| Calculation | Purpose | Task Usage |
|-------------|---------|------------|
| EDD from LMP | Expected delivery | Schedule reminder |
| Gestational age | Pregnancy stage | Conditional visits |
| Age in months | Child's age | Immunization schedule |
| BMI | Nutritional status | Referral trigger |

### XLSForm Examples

```
| type | name | calculation |
|------|------|-------------|
| calculate | edd | add-date(${lmp_date}, 0, 9, 0, 0, 0) |
| calculate | gest_weeks | int((today() - ${lmp_date}) div 7) |
| calculate | age_months | int((today() - ${dob}) div 30.44) |
```

### Using Calculations in Tasks

```javascript
appliesIf: function(contact, report) {
  const gestWeeks = Utils.getField(report, 'gest_weeks');
  // Only apply after 28 weeks
  return gestWeeks && parseInt(gestWeeks) >= 28;
}
```

---

## Form Group Patterns

### Standard CHT Input Group

```
| type | name | appearance |
|------|------|------------|
| begin group | inputs | field-list |
| hidden | source | |
| begin group | contact | |
| string | _id | select-contact type-person |
| string | patient_id | hidden |
| end group | | |
| end group | | |
```

### Accessing Input Data

```javascript
// The _id field links to the contact
appliesIf: function(contact, report) {
  // contact.contact._id matches the selected patient
  return report.fields && report.fields.inputs;
}
```

---

## Relevance Logic

### Form Relevance

```
| type | name | label | relevant |
|------|------|-------|----------|
| select_one yes_no | referred | Was patient referred? | |
| text | referral_facility | Referral facility | ${referred} = 'yes' |
| text | referral_reason | Reason | ${referred} = 'yes' |
```

### Mapping to Task Conditions

If a field has relevance, consider including that condition:

```javascript
appliesIf: function(contact, report) {
  // Only create referral follow-up if referral was made
  return Utils.getField(report, 'referred') === 'yes';
}
```

---

## Contact Association

### Standard Patterns

| Field | Purpose |
|-------|---------|
| `patient_id` or `fields.patient_id` | Links to person contact |
| `patient_uuid` or `fields.patient_uuid` | Links by UUID |
| `place_id` or `fields.place_id` | Links to place contact |

CHT automatically associates reports to contacts based on these fields.

---

## Reading Forms Programmatically

### Using Python/openpyxl

Always read forms with the Python script rather than guessing:

```bash
python scripts/read-xlsform.py forms/app/delivery.xlsx
```

This extracts:
- All field names and types
- Choice lists and their values
- Calculations and their formulas
- Relevance conditions

### Key Things to Look For

1. **Date fields**: For scheduling
2. **Select fields with meaningful values**: For conditions
3. **Fields with relevance**: Indicate branching logic
4. **Calculated fields**: May contain scheduling logic
5. **Groups named "inputs"**: Contact association pattern

---

## Mapping Form to Task

### Example: Delivery Form → PNC Task

**Form Analysis:**
```
Fields found:
- delivery_date (date)
- delivery_place (select_one)
- delivery_outcome (select_one)
- complications (select_multiple)
- baby_weight (decimal)
```

**Task Mapping:**

| Form Field | Task Property | Usage |
|------------|---------------|-------|
| `delivery_date` | `events.days` or `events.dueDate` | Schedule PNC visits relative to delivery |
| `delivery_place` | `appliesIf` | Home births get priority |
| `delivery_outcome` | `appliesIf` | Only for live births |
| `complications` | `priority` | High priority if complications |
| `baby_weight` | `appliesIf` | Low birth weight follow-up |

**Resulting Task:**

```javascript
{
  name: 'pnc-followup',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'delivery_outcome') === 'live_birth';
  },
  priority: function(contact, report) {
    const complications = Utils.getField(report, 'complications');
    const place = Utils.getField(report, 'delivery_place');
    if (complications && complications !== 'none' || place === 'home') {
      return { level: 'high', label: 'task.priority.urgent_pnc' };
    }
    return null;
  },
  events: [
    { id: 'pnc-1', days: 1, start: 0, end: 1 },
    { id: 'pnc-2', days: 3, start: 1, end: 1 },
    { id: 'pnc-3', days: 7, start: 2, end: 2 }
  ],
  actions: [{
    form: 'postnatal_visit',
    modifyContent: function(content, contact, report, event) {
      content.delivery_date = Utils.getField(report, 'delivery_date');
      content.delivery_place = Utils.getField(report, 'delivery_place');
      content.visit_number = event.id.replace('pnc-', '');
    }
  }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(
      c.reports, 'postnatal_visit',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime()
    );
  }
}
```

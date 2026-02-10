# Utils Functions Reference

The `Utils` object is globally available in `tasks.js` and `targets.js`.

## Function Reference

| Function | Returns | Description |
|----------|---------|-------------|
| `Utils.addDate(date, days)` | Date | Add days to date |
| `Utils.isFormSubmittedInWindow(reports, form, start, end)` | boolean | Check if form submitted in window |
| `Utils.getMostRecentReport(reports, form)` | report or undefined | Get latest report of type |
| `Utils.getMostRecentTimestamp(reports, form)` | number | Get latest reported_date |
| `Utils.getField(report, path)` | any | Safely get nested field |
| `Utils.isTimely(date, event)` | boolean | Check if date in event window |
| `Utils.getLmpDate(doc)` | Date or null | Extract LMP date |
| `Utils.isDateValid(date)` | boolean | Validate date object |
| `Utils.now()` | Date | Current date (testable) |
| `Utils.MS_IN_DAY` | 86400000 | Milliseconds per day |

---

## Utils.addDate(date, days)

Add or subtract days from a date.

```javascript
// 7 days after report
const dueDate = Utils.addDate(report.reported_date, 7);

// 2 days before due date
const startWindow = Utils.addDate(dueDate, -2);

// Using with Date object
const birthDate = new Date(contact.date_of_birth);
const sixWeeksLater = Utils.addDate(birthDate, 42);
```

**Note:** Works with Date objects or timestamps. Returns a Date object.

---

## Utils.isFormSubmittedInWindow(reports, form, start, end)

Check if a specific form was submitted within a time window.

```javascript
// Standard task resolution pattern
resolvedIf: function(contact, report, event, dueDate) {
  return Utils.isFormSubmittedInWindow(
    contact.reports,
    'followup_visit',
    Utils.addDate(dueDate, -event.start).getTime(),  // Window start
    Utils.addDate(dueDate, event.end + 1).getTime()  // Window end (+1 for inclusive)
  );
}
```

**Parameters:**
- `reports`: Array of report objects (usually `contact.reports`)
- `form`: Form code string (e.g., 'pregnancy', 'followup')
- `start`: Start timestamp (milliseconds)
- `end`: End timestamp (milliseconds)

**Returns:** `true` if any matching form was submitted in the window.

---

## Utils.getMostRecentReport(reports, form)

Get the most recently submitted report of a specific type.

```javascript
// Get last pregnancy registration
const pregnancy = Utils.getMostRecentReport(contact.reports, 'pregnancy');
if (pregnancy) {
  const edd = Utils.getField(pregnancy, 'edd');
  const lmp = Utils.getField(pregnancy, 'lmp_date');
}

// Check if specific report exists
appliesIf: function(contact, report) {
  const delivery = Utils.getMostRecentReport(contact.reports, 'delivery');
  return delivery && Utils.getField(delivery, 'outcome') === 'live_birth';
}
```

**Returns:** Report object or `undefined` if none found.

---

## Utils.getMostRecentTimestamp(reports, form)

Get the `reported_date` of the most recent matching report.

```javascript
// Check how long since last visit
appliesIf: function(contact) {
  const lastVisit = Utils.getMostRecentTimestamp(contact.reports, 'home_visit');
  if (!lastVisit) return true;  // Never visited

  const daysSince = (Utils.now().getTime() - lastVisit) / Utils.MS_IN_DAY;
  return daysSince > 30;  // Overdue if > 30 days
}

// Custom due date based on last report
dueDate: function(event, contact) {
  const lastAssessment = Utils.getMostRecentTimestamp(contact.reports, 'assessment');
  if (lastAssessment) {
    return new Date(lastAssessment + 30 * Utils.MS_IN_DAY);  // 30 days after
  }
  return Utils.now();  // Due now if never assessed
}
```

**Returns:** Timestamp (milliseconds) or `0` if no matching report.

---

## Utils.getField(report, path)

Safely retrieve a nested field value using dot notation.

```javascript
// Simple field access
const cough = Utils.getField(report, 'symptoms.cough');
const weight = Utils.getField(report, 'vitals.weight_kg');

// Deeply nested
const reason = Utils.getField(report, 'referral.reason.primary');

// In appliesIf
appliesIf: function(contact, report) {
  return Utils.getField(report, 'delivery_place') === 'home' &&
         Utils.getField(report, 'outcome') === 'live_birth';
}

// In modifyContent
modifyContent: function(content, contact, report, event) {
  content.patient_name = Utils.getField(report, 'patient_name');
  content.risk_factors = Utils.getField(report, 'risk.factors');
  content.previous_visit_date = Utils.getField(report, 'visit_date');
}
```

**Returns:** Field value or `undefined` if path doesn't exist.

**Note:** Safer than direct access like `report.fields.symptoms.cough` which throws if `symptoms` is undefined.

---

## Utils.isTimely(date, event)

Check if a date falls within the event's start/end window.

```javascript
// Typically used internally, but can be useful for custom logic
const isOnTime = Utils.isTimely(submissionDate, event);
```

---

## Utils.getLmpDate(doc)

Extract Last Menstrual Period date from pregnancy-related documents.

```javascript
// Calculate weeks pregnant
const lmp = Utils.getLmpDate(pregnancyReport);
if (lmp) {
  const weeksPregnant = Math.floor((Utils.now() - lmp) / (7 * Utils.MS_IN_DAY));
}

// Custom due date for ANC
dueDate: function(event, contact, report) {
  const lmp = Utils.getLmpDate(report);
  if (lmp) {
    // ANC visits at specific gestational weeks
    const visitWeek = event.id === 'anc-1' ? 12 : event.id === 'anc-2' ? 20 : 28;
    return Utils.addDate(lmp, visitWeek * 7);
  }
  return null;
}
```

**Returns:** Date object or `null` if not found.

---

## Utils.isDateValid(date)

Validate that a value is a valid Date object.

```javascript
const birthDate = new Date(contact.date_of_birth);
if (Utils.isDateValid(birthDate)) {
  const ageInDays = (Utils.now() - birthDate) / Utils.MS_IN_DAY;
  const ageInYears = Math.floor(ageInDays / 365.25);
}
```

---

## Utils.now()

Get current date. Use instead of `new Date()` for testability.

```javascript
// Calculate age
const today = Utils.now();
const birthDate = new Date(contact.date_of_birth);
const ageYears = Math.floor((today - birthDate) / (365.25 * Utils.MS_IN_DAY));

// Days since event
const daysSince = (Utils.now().getTime() - timestamp) / Utils.MS_IN_DAY;
```

---

## Utils.MS_IN_DAY

Constant: 86400000 (milliseconds in a day).

```javascript
// Convert timestamp difference to days
const daysDiff = (date2 - date1) / Utils.MS_IN_DAY;

// Convert days to milliseconds
const thirtyDaysMs = 30 * Utils.MS_IN_DAY;

// Calculate weeks
const weeksDiff = (date2 - date1) / (7 * Utils.MS_IN_DAY);
```

---

## Common Patterns

### Check if follow-up is overdue

```javascript
appliesIf: function(contact) {
  const lastFollowup = Utils.getMostRecentTimestamp(contact.reports, 'followup');
  if (!lastFollowup) return true;  // Never had followup

  const daysSince = (Utils.now().getTime() - lastFollowup) / Utils.MS_IN_DAY;
  return daysSince > 30;
}
```

### Calculate age

```javascript
function getAgeInYears(contact) {
  const birthDate = new Date(contact.contact.date_of_birth);
  if (!Utils.isDateValid(birthDate)) return null;

  const ageInDays = (Utils.now() - birthDate) / Utils.MS_IN_DAY;
  return Math.floor(ageInDays / 365.25);
}
```

### Filter reports by date range

```javascript
function getReportsThisMonth(reports, form) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  return reports.filter(r =>
    r.form === form &&
    r.reported_date >= startOfMonth.getTime()
  );
}
```

### Count completed tasks

```javascript
function countCompletedVisits(contact, formCode, sinceDate) {
  return contact.reports.filter(r =>
    r.form === formCode &&
    r.reported_date >= sinceDate
  ).length;
}
```

### Check for specific field values across reports

```javascript
function hasHighRiskReport(contact) {
  return contact.reports.some(r =>
    Utils.getField(r, 'risk_level') === 'high'
  );
}
```

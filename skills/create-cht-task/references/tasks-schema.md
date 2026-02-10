# CHT Tasks Schema Reference

Complete reference for tasks.js configuration.

## Task Object Schema

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| `name` | string | Unique identifier for the task | Yes, unique |
| `icon` | string | Icon key from resources.json | No |
| `title` | translation key | Display title for task | Yes |
| `appliesTo` | `'contacts'` or `'reports'` | Emit one task per contact or per report | Yes |
| `appliesToType` | string[] | Filter by contact types or form codes | No |
| `appliesIf` | function(contact, report) | Return true if task should exist | No |
| `contactLabel` | string or function | Label for task subject | No |
| `resolvedIf` | function(contact, report, event, dueDate) | Return true when complete | No* |
| `events` | object[] | Task timing configuration | Yes |
| `actions` | object[] | Forms/actions when task clicked | Yes |
| `priority` | object or function | High-risk indicator | No |

*Required if any action type is 'report'.

---

## Events Configuration

Each event defines when a task appears.

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| `id` | string | Unique event identifier | Yes (if multiple events) |
| `days` | integer | Days after `reported_date` | Yes* |
| `dueDate` | function(event, contact, report) | Custom due date | Yes* |
| `start` | integer | Days before due to show task | Yes |
| `end` | integer | Days after due to hide task | Yes |

*Either `days` OR `dueDate` is required.

### Event Timing Example

```
      start=2        end=2
         |   due date   |
   <-----|------|------|----->
   Day 5   Day 6   Day 7   Day 8   Day 9
   (show)         (due)         (hide)
```

If `days=7`, `start=2`, `end=2`:
- Task appears on day 5 (7 - 2)
- Due on day 7
- Disappears after day 9 (7 + 2)

---

## Actions Configuration

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| `type` | `'report'` or `'contact'` | Action type (default: 'report') | No |
| `form` | string | Form code to open | Yes (if type='report') |
| `label` | translation key | Label if multiple actions | No |
| `modifyContent` | function(content, contact, report, event) | Pre-fill form | No |

### modifyContent Example

```javascript
modifyContent: function(content, contact, report, event) {
  content.source = 'task';
  content.source_id = report._id;
  content.delivery_date = Utils.getField(report, 'delivery_date');
  content.event_id = event.id;
}
```

---

## Priority Configuration

```javascript
priority: {
  level: 'high',              // 'high' or positive integer
  label: 'task.priority.key'  // Translation key
}

// OR as a function
priority: function(contact, report) {
  if (Utils.getField(report, 'risk') === 'high') {
    return { level: 'high', label: 'task.high_risk' };
  }
  return null;  // Normal priority
}
```

---

## appliesTo Options

### Reports-Based Tasks

Trigger one task per matching report.

```javascript
{
  appliesTo: 'reports',
  appliesToType: ['pregnancy', 'delivery'],  // Form codes
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'outcome') === 'live_birth';
  }
}
```

### Contacts-Based Tasks

Trigger one task per matching contact.

```javascript
{
  appliesTo: 'contacts',
  appliesToType: ['person'],  // Contact types
  appliesIf: function(contact) {
    // contact.contact = the contact document
    // contact.reports = array of reports for this contact
    return contact.contact.age_years < 5;
  }
}
```

---

## resolvedIf Function

Check if task should be marked complete.

### Parameters

| Parameter | Description |
|-----------|-------------|
| `contact` | Contact object with `.contact` and `.reports` |
| `report` | Triggering report (for report-based tasks) |
| `event` | Current event object |
| `dueDate` | Calculated due date |

### Standard Pattern

```javascript
resolvedIf: function(contact, report, event, dueDate) {
  return Utils.isFormSubmittedInWindow(
    contact.reports,
    'followup_form',
    Utils.addDate(dueDate, -event.start).getTime(),
    Utils.addDate(dueDate, event.end + 1).getTime()
  );
}
```

### Default Behavior

If `resolvedIf` is undefined, CHT checks if any report matching the action's form was submitted during the task window.

### Custom Resolution

```javascript
resolvedIf: function(contact, report, event, dueDate) {
  // Check for specific field values
  const followups = contact.reports.filter(r => r.form === 'followup');
  return followups.some(r =>
    Utils.getField(r, 'completed') === 'yes' &&
    r.reported_date >= Utils.addDate(dueDate, -event.start).getTime()
  );
}
```

---

## Complete Task Examples

### Basic Follow-up Task

```javascript
{
  name: 'delivery-followup',
  icon: 'mother-child',
  title: 'task.delivery_followup',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  events: [
    { id: 'day-1', days: 1, start: 0, end: 1 },
    { id: 'day-3', days: 3, start: 1, end: 1 },
    { id: 'day-7', days: 7, start: 2, end: 2 }
  ],
  actions: [{ form: 'postnatal_visit' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(
      c.reports, 'postnatal_visit',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime()
    );
  }
}
```

### Contact-Based with Custom Due Date

```javascript
{
  name: 'immunization-reminder',
  icon: 'immunization',
  title: 'task.immunization',
  appliesTo: 'contacts',
  appliesToType: ['person'],
  appliesIf: function(contact) {
    const ageMonths = (Date.now() - new Date(contact.contact.date_of_birth)) / (30 * Utils.MS_IN_DAY);
    return ageMonths < 24;  // Under 2 years
  },
  events: [{
    id: 'immunization',
    start: 7,
    end: 7,
    dueDate: function(event, contact) {
      // Calculate next immunization date based on schedule
      const birthDate = new Date(contact.contact.date_of_birth);
      const schedule = [42, 70, 98, 270, 365];  // Days after birth
      const today = Utils.now().getTime();

      for (const days of schedule) {
        const dueDate = Utils.addDate(birthDate, days);
        if (dueDate.getTime() > today) {
          return dueDate;
        }
      }
      return null;
    }
  }],
  actions: [{ form: 'immunization' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(
      c.reports, 'immunization',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime()
    );
  }
}
```

### Task with Priority

```javascript
{
  name: 'danger-sign-followup',
  icon: 'risk',
  title: 'task.danger_sign',
  appliesTo: 'reports',
  appliesToType: ['assessment'],
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'danger_signs') === 'yes';
  },
  priority: {
    level: 'high',
    label: 'task.priority.danger'
  },
  events: [{ id: 'urgent', days: 0, start: 0, end: 1 }],
  actions: [{
    form: 'danger_followup',
    modifyContent: function(content, contact, report) {
      content.danger_type = Utils.getField(report, 'danger_type');
    }
  }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(
      c.reports, 'danger_followup',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime()
    );
  }
}
```

---

## Using nools-extras.js

For complex reusable logic, create a separate file:

```javascript
// nools-extras.js
module.exports = {
  isHighRisk: function(report) {
    return Utils.getField(report, 'risk_level') === 'high';
  },

  getExpectedDeliveryDate: function(report) {
    const lmp = Utils.getField(report, 'lmp_date');
    if (lmp) {
      return Utils.addDate(new Date(lmp), 280);  // 40 weeks
    }
    return null;
  },

  postnatalForms: ['pnc_visit', 'postnatal_visit', 'postnatal_followup']
};
```

```javascript
// tasks.js
const extras = require('./nools-extras');

module.exports = [{
  name: 'pnc-visit',
  appliesIf: function(c, r) {
    return extras.isHighRisk(r);
  },
  // ...
}];
```

---

## Important Constraints

1. **User restriction**: Tasks only show for "restricted to their place" users
2. **Time window**: 60 days past to 180 days future (CHT 4.0+)
3. **Performance**: Minimize task generation; use `appliesIf` to filter early
4. **Unique names**: Task names must be unique across the project
5. **Translation keys**: All titles/labels should use translation keys

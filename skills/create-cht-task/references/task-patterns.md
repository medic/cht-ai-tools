# Common Task Patterns

Reference patterns for CHT task configurations. Each pattern includes a complete working example.

---

### Pattern: Report-Based Follow-up

Trigger task X days after a specific form is submitted.

```javascript
{
  name: 'followup-after-registration',
  appliesTo: 'reports',
  appliesToType: ['registration'],
  events: [{ id: 'followup', days: 7, start: 2, end: 2 }],
  actions: [{ form: 'followup_visit' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(c.reports, 'followup_visit',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime());
  }
}
```

### Pattern: Contact-Based Recurring

Task for all contacts of a type on a schedule.

```javascript
{
  name: 'monthly-assessment',
  appliesTo: 'contacts',
  appliesToType: ['person'],
  appliesIf: function(contact) {
    return contact.contact.type === 'person' && contact.contact.active;
  },
  events: [{
    id: 'monthly',
    start: 0,
    end: 30,
    dueDate: function(event, contact) {
      // Custom logic for recurring due date
      const lastAssessment = Utils.getMostRecentTimestamp(contact.reports, 'assessment');
      return new Date(lastAssessment + 30 * Utils.MS_IN_DAY);
    }
  }],
  actions: [{ form: 'assessment' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(c.reports, 'assessment',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime());
  }
}
```

### Pattern: Multiple Events (ANC Schedule)

Multiple follow-ups from a single trigger.

```javascript
{
  name: 'anc-visits',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  events: [
    { id: 'anc-1', days: 0, start: 7, end: 14 },
    { id: 'anc-2', days: 30, start: 7, end: 14 },
    { id: 'anc-3', days: 60, start: 7, end: 14 },
    { id: 'anc-4', days: 90, start: 7, end: 14 }
  ],
  actions: [{ form: 'anc_visit' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(c.reports, 'anc_visit',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime());
  }
}
```

### Pattern: Conditional with Priority

High-priority task based on risk indicators.

```javascript
{
  name: 'high-risk-followup',
  appliesTo: 'reports',
  appliesToType: ['assessment'],
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'risk_level') === 'high';
  },
  priority: {
    level: 'high',
    label: 'task.priority.high_risk'
  },
  events: [{ id: 'urgent', days: 1, start: 0, end: 1 }],
  actions: [{ form: 'urgent_followup' }],
  resolvedIf: function(c, r, e, d) {
    return Utils.isFormSubmittedInWindow(c.reports, 'urgent_followup',
      Utils.addDate(d, -e.start).getTime(),
      Utils.addDate(d, e.end + 1).getTime());
  }
}
```

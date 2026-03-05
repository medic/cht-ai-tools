# Common Target Patterns

Reference patterns for CHT target configurations. Each pattern includes a complete working example.

---

### Pattern: Simple Count (This Month)

Count forms submitted this month.

```javascript
{
  id: 'pregnancies-this-month',
  type: 'count',
  icon: 'pregnancy',
  goal: 20,
  translation_key: 'targets.pregnancies.title',
  subtitle_translation_key: 'targets.this_month.subtitle',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  date: 'reported'
}
```

### Pattern: Simple Count (All Time)

Cumulative count of all records.

```javascript
{
  id: 'total-registrations',
  type: 'count',
  icon: 'person',
  goal: -1,  // No specific goal
  translation_key: 'targets.registrations.title',
  subtitle_translation_key: 'targets.all_time.subtitle',
  appliesTo: 'reports',
  appliesToType: ['registration'],
  date: 'now'
}
```

### Pattern: Percentage with Condition

Percent of deliveries that had facility delivery.

```javascript
{
  id: 'facility-deliveries',
  type: 'percent',
  icon: 'hospital',
  goal: 80,
  translation_key: 'targets.facility_delivery.title',
  appliesTo: 'reports',
  appliesToType: ['delivery'],
  date: 'reported',
  // Denominator: all deliveries
  appliesIf: function(contact, report) {
    return true;  // Count all deliveries
  },
  // Numerator: facility deliveries only
  passesIf: function(contact, report) {
    return Utils.getField(report, 'delivery_place') === 'facility';
  }
}
```

### Pattern: Unique Contacts (Avoid Double-Counting)

Count unique patients, not total reports.

```javascript
{
  id: 'active-patients',
  type: 'count',
  icon: 'person',
  goal: 50,
  translation_key: 'targets.active_patients.title',
  appliesTo: 'reports',
  appliesToType: ['home_visit', 'assessment'],
  date: 'reported',
  idType: 'contact'  // Count unique contacts, not reports
}
```

### Pattern: Percentage Based on Related Reports

Percent of pregnancies with at least one ANC visit.

```javascript
{
  id: 'pregnancies-with-anc',
  type: 'percent',
  icon: 'nurse',
  goal: 100,
  translation_key: 'targets.anc_coverage.title',
  appliesTo: 'reports',
  appliesToType: ['pregnancy'],
  date: 'reported',
  passesIf: function(contact, report) {
    // Check if any ANC visit exists for this contact
    return contact.reports.some(r =>
      r.form === 'anc_visit' &&
      r.reported_date >= report.reported_date
    );
  }
}
```

### Pattern: GroupBy (Families with Multiple Visits)

Percent of families with 2+ home visits this month.

```javascript
{
  id: 'families-2-visits',
  type: 'percent',
  icon: 'family',
  goal: 80,
  translation_key: 'targets.family_visits.title',
  appliesTo: 'reports',
  appliesToType: ['home_visit'],
  date: 'reported',
  idType: function(contact, report) {
    // Unique ID per family per day
    const familyId = contact.contact.parent._id;
    const date = new Date(report.reported_date).toISOString().split('T')[0];
    return [`${familyId}~${date}`];
  },
  groupBy: function(contact, report) {
    return contact.contact.parent._id;  // Group by family
  },
  passesIfGroupCount: { gte: 2 }  // Pass if 2+ visits
}
```

### Pattern: Contact-Based Count (Active Pregnant Women)

Count contacts meeting criteria. Note: `report` is `undefined` for contact-based targets.

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
    // For contact-based: check contact.reports directly
    return contact.reports.some(r =>
      r.form === 'pregnancy' &&
      r.fields &&
      r.fields.edd &&
      new Date(r.fields.edd) > Utils.now()
    );
  }
}
```

### Pattern: Contact-Based Percent (Children Immunized)

Percent of a contact population meeting criteria.

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
  // Denominator: children under 5
  appliesIf: function(contact) {
    if (!contact.contact.date_of_birth) return false;
    const ageMs = Date.now() - new Date(contact.contact.date_of_birth).getTime();
    return ageMs < 5 * 365.25 * 24 * 60 * 60 * 1000;
  },
  // Numerator: completed immunization
  passesIf: function(contact) {
    return contact.reports.some(r =>
      r.form === 'immunization' &&
      r.fields &&
      r.fields.schedule_complete === 'yes'
    );
  }
}
```

### Pattern: Contact-Based with Context (Supervisor Aggregated)

Target visible only to CHWs with aggregation enabled for supervisors.

```javascript
{
  id: 'households-visited',
  type: 'percent',
  icon: 'home-visit',
  goal: 100,
  translation_key: 'targets.households_visited.title',
  context: 'user.role === "chw"',
  aggregate: true,
  appliesTo: 'contacts',
  appliesToType: ['clinic'],
  date: 'reported',
  passesIf: function(contact) {
    return contact.reports.some(r => r.form === 'home_visit');
  }
}
```

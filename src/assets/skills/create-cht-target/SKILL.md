---
name: CHT Target Creator
description: "This skill should be used when the user asks to 'create a target', 'help me create a CHT target', 'build a target', 'add a KPI', 'generate targets.js', 'create indicator', 'add analytics target', or mentions target/indicator creation for CHT applications. Provides guided, educational assistance for creating CHT targets by analyzing existing forms and project context."
---

# CHT Target Creator

Interactive, educational assistant for creating CHT (Community Health Toolkit) targets. This skill guides developers through target creation by understanding their project context, analyzing existing forms, and generating properly configured targets.js code.

## Workflow Overview

```
1. EXPLAIN    → Brief description of what CHT targets are and how they work
2. DETECT     → Check if current folder is a CHT project, identify structure
3. ANALYZE    → Read forms using Python/openpyxl to extract fields and logic
4. GATHER     → Ask targeted questions about the indicator requirements
5. GENERATE   → Create the target configuration with educational explanations
```

---

## Step 1: Explain CHT Targets

Start by providing a brief, educational overview:

> **CHT Targets** are key performance indicators (KPIs) displayed on the Analytics/Targets tab. They help health workers and supervisors track progress toward goals.
>
> There are two types of targets:
> - **Count**: Shows totals (e.g., "15 pregnancies registered")
> - **Percent**: Shows progress bars (e.g., "80% of deliveries had ANC visits")
>
> Targets can count two kinds of data:
> - **Reports** — Count submitted forms (e.g., delivery reports this month)
> - **Contacts** — Count people/places meeting criteria (e.g., % of children immunized)
>
> Targets are configured in `targets.js` and work by:
> - **Counting** reports or contacts that match criteria
> - **Filtering** by time period (this month vs all time)
> - **Calculating** percentages using `appliesIf` (denominator) and `passesIf` (numerator)
> - **Grouping** for aggregated metrics (e.g., visits per family)
>
> Targets can be filtered by user role (`context`) and aggregated for supervisor dashboards (`aggregate`).

---

## Step 2: Detect CHT Project

Check if the current working directory is a CHT configuration project.

### Detection Script

Execute `scripts/detect-cht-project.sh` to identify:
- Is this a CHT project? (looks for `targets.js`, `forms/app/`, `app_settings.json`)
- What forms exist in `forms/app/`?
- Does `targets.js` already exist? What targets are defined?
- What contact types are configured?

If NOT a CHT project:
> "This doesn't appear to be a CHT project directory. To create targets, navigate to a CHT project root containing `targets.js` and `forms/app/` directory."

---

## Step 3: Analyze Forms

**Critical:** Always read XLSForm files using Python with openpyxl. Never guess form structure.

### Form Analysis Script

Execute `scripts/read-xlsform.py <form_path>` to extract:
- All field names and types from the `survey` sheet
- Choice lists from the `choices` sheet
- Form ID and title from the `settings` sheet
- Relevant/constraint conditions that indicate important logic

### Key Fields to Identify

When analyzing forms for target creation, look for:

| Field Pattern | Significance |
|---------------|--------------|
| `patient_id`, `_id` | Contact association |
| `outcome`, `result` | Success/failure indicators |
| `visit_type`, `visit_number` | Visit tracking |
| `referral_*`, `completed_*` | Completion indicators |
| `risk_level`, `status` | Categorization fields |
| Date fields | Time-based filtering |

---

## Step 4: Gather Requirements

Ask focused questions one at a time. Use the form analysis to offer relevant choices.

### Essential Questions

**Q1: Target Type**
> "What kind of indicator do you want to track?"
> - A) **Count** — Total number (e.g., "pregnancies registered", "home visits")
> - B) **Percent** — Progress toward goal (e.g., "% of deliveries with ANC", "% households visited")

**Q2: Data Source**
> "What should this target count?"
> - A) Reports (forms submitted) — *e.g., count delivery forms*
> - B) Contacts (people/places) — *e.g., count active patients*

**Q3: Form/Contact Type** (based on Q2)
> "Which forms should be counted?" [list detected forms]
> OR
> "Which contact types?" [list: person, clinic, health_center, etc.]

**Q4: Time Period**
> "What time period should this cover?"
> - A) **This month** (`date: 'reported'`) — Resets each month
> - B) **All time** (`date: 'now'`) — Cumulative total

**Q5: Goal**
> "What's the target goal?"
> - For percent: 0-100 (e.g., 80 for 80% goal)
> - For count: any number (e.g., 20 registrations)
> - No goal: -1

**Q6: Conditions** (for filtering)
> "Should only certain records be counted?"
> - Based on field values (e.g., only successful outcomes)
> - Based on contact properties
> - Count all matching records

**Q7: Pass Criteria** (for percent type only)
> "What makes a record 'pass' (count toward the numerator)?"
> - Based on field values
> - Based on related reports existing
> - Custom logic

**Q8: Unique Counting** (optional, important for accuracy)
> "How should records be counted?"
> - A) Count each report (`idType: 'report'`)
> - B) Count unique contacts (`idType: 'contact'`) — avoids double-counting

**Q9: Role Visibility** (optional)
> "Should this target be visible to specific user roles?"
> - A) All users (default — no `context` needed)
> - B) Only CHWs (`context: 'user.role === "chw"'`)
> - C) Only supervisors (`context: 'user.role === "supervisor"'`)
> - D) Custom role expression

**Q10: Supervisor Aggregation** (optional)
> "Should supervisors see aggregated data across CHWs for this target?"
> - A) No aggregation (default)
> - B) Yes, show on TargetAggregates page (`aggregate: true`)
> - C) Aggregation only — hide from individual CHW view (`aggregate: true, visible: false`)

**Q11: Data Availability Check** (ask when relevant)
> When the user's target uses `date: 'now'` (all-time) or `contact.reports` cross-checks:
>
> "I notice this target [counts all-time data / checks related reports]. Be aware:"
> - **Purging**: Report counts may decrease when old reports are purged from devices
> - **Replication**: Contact reports are limited to what's synced to the device
>
> Would you like to:
> - A) Keep as-is (acceptable for your use case)
> - B) Use time-bounded counting (`date: 'reported'` for this month only)
> - C) Add a form calculation to store the flag at submission time

---

## Step 5: Generate Target Configuration

Create the target with educational comments explaining each part.

### Target Schema Reference

```javascript
{
  id: 'unique-target-id',              // Unique identifier
  type: 'count',                       // 'count' or 'percent'
  icon: 'icon-name',                   // Icon from resources.json
  goal: 20,                            // Target goal (-1 for none)
  translation_key: 'targets.key',      // Title translation
  subtitle_translation_key: 'targets.subtitle',  // Optional subtitle
  percentage_count_translation_key: 'targets.count.custom',  // Optional: custom "X of Y" text (has {{pass}} and {{total}} vars)

  context: 'user.role === "chw"',      // Optional: JS expression for role-based visibility
  visible: true,                       // Optional: hide from Targets tab (default: true)
  aggregate: true,                     // Optional: show on TargetAggregates for supervisors (3.9+)

  appliesTo: 'reports',                // 'reports' or 'contacts'
  appliesToType: ['form_id'],          // Form codes or contact types
  appliesIf: function(c, r) {},        // Filter (denominator for percent)

  passesIf: function(c, r) {},         // For percent: numerator condition
  date: 'reported',                    // 'reported', 'now', or function
  idType: 'contact',                   // 'report', 'contact', or function

  // For grouped targets:
  groupBy: function(c, r) {},          // Group by value
  passesIfGroupCount: { gte: 2 },      // Group pass criteria

  // For DHIS2 integration:
  dhis: {                              // Optional: DHIS2 data element mapping
    dataElement: 'DHIS2_ELEMENT_ID',
    dataSet: 'DHIS2_DATASET_ID'
  }
}
```

---

## Educational Output Format

When generating the target, explain each section:

```markdown
### Generated Target: [target-id]

**What this target measures:**
[Plain language description]

**Type:** Count / Percent
**Period:** This month / All time
**Goal:** [goal value]

\`\`\`javascript
// targets.js - Add this to your targets array

{
  // ─── IDENTIFICATION ─────────────────────────────
  id: 'deliveries-this-month',        // Unique ID for this target
  icon: 'infant',                     // Icon shown in widget
  translation_key: 'targets.deliveries.title',
  subtitle_translation_key: 'targets.this_month.subtitle',

  // ─── TARGET TYPE ────────────────────────────────
  type: 'count',                      // Shows total number
  goal: 10,                           // Target: 10 deliveries

  // ─── DATA SOURCE ────────────────────────────────
  appliesTo: 'reports',               // Count reports (forms)
  appliesToType: ['delivery'],        // Only delivery forms

  // ─── TIME FILTER ────────────────────────────────
  date: 'reported'                    // Only count this month
}
\`\`\`

### Translation Keys to Add

Add to `translations/messages-en.properties`:
\`\`\`
targets.deliveries.title=Deliveries
targets.this_month.subtitle=This month
\`\`\`

### Build Command

\`\`\`bash
cht --local compile-app-settings upload-app-settings
\`\`\`
```

---

## Common Target Patterns

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

---

## Best Practice: Use Form Calculations for Complex Logic

**When a target requires multiple field conditions, add a calculated field in the XLSForm instead of cluttering targets.js.**

### ❌ Bad: Complex logic in targets.js

```javascript
passesIf: function(contact, report) {
  return Utils.getField(report, 'delivery_place') === 'facility' &&
         Utils.getField(report, 'skilled_attendant') === 'yes' &&
         Utils.getField(report, 'complications') === 'none';
}
```

### ✅ Good: Add calculation to XLSForm

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

### When to Suggest Form Calculations

Recommend adding a calculated field when:
- **3+ field references** from the same form
- **Complex boolean logic** (multiple AND/OR)
- **Logic reused** in tasks, targets, and contact-summary

### Workflow Integration

During **Step 4 (Gather Requirements)**, if user describes complex conditions:

1. **Identify** the fields involved
2. **Suggest** adding a calculated field
3. **Ask user** if they want you to add it to the XLSForm
4. **If yes**: Execute `scripts/add-xlsform-calculation.py`
5. **Generate** a simple target referencing that field

> **Recommendation:** I notice this target needs multiple conditions. I recommend adding a calculated field `is_safe_delivery` to your form. Would you like me to add this calculation?

### When to Suggest targets-extras.js Instead

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

---

## Translation Key Conventions

### Naming Pattern

Follow this convention for target translation keys:

```
targets.<target-name>.title        → Main title
targets.<target-name>.subtitle     → Subtitle
targets.<target-name>.count        → Custom percent count text
```

### Standard Subtitle Keys

| Key | Display |
|-----|---------|
| `targets.this_month.subtitle` | "This month" |
| `targets.all_time.subtitle` | "All time" |

### Custom Percent Count Text

The `percentage_count_translation_key` property customizes the "X of Y" text below percent bars. It has `{{pass}}` and `{{total}}` template variables.

**Default:** `"{{pass}} of {{total}}"` (via `targets.count.default`)

**Custom example:**
```properties
targets.facility_delivery.count={{pass}} facility deliveries of {{total}} total
```

```javascript
{
  id: 'facility-deliveries',
  type: 'percent',
  percentage_count_translation_key: 'targets.facility_delivery.count',
  ...
}
```

### Checking for Existing Keys

Before adding translation keys, check existing files to avoid duplicates:
```bash
grep "targets\." translations/messages-en.properties | sort
```

---

## Important Constraints

- Targets update when reports sync
- Use `idType: 'contact'` to avoid counting same person multiple times
- `date: 'reported'` resets each month; `date: 'now'` is cumulative
- `passesIf` is forbidden when using `groupBy`
- Test with sample data before deployment
- **Prefer form calculations over complex targets.js logic**

---

## Utils Functions Available

| Function | Description | Example |
|----------|-------------|---------|
| `Utils.getField(report, path)` | Safely get nested field | `Utils.getField(r, 'delivery_place')` |
| `Utils.getMostRecentReport(reports, form)` | Get latest report | `Utils.getMostRecentReport(contact.reports, 'pregnancy')` |
| `Utils.getMostRecentTimestamp(reports, form)` | Get latest timestamp | `Utils.getMostRecentTimestamp(contact.reports, 'visit')` |
| `Utils.isFormSubmittedInWindow(reports, form, start, end)` | Check form in time window | Used in cross-report checks |
| `Utils.addDate(date, days)` | Add days to date | `Utils.addDate(new Date(), -30)` |
| `Utils.now()` | Get current date | `Utils.now()` |
| `Utils.MS_IN_DAY` | Milliseconds constant | `30 * Utils.MS_IN_DAY` |

---

## Data Availability Warnings

**Always warn users about these issues when relevant.**

### Report Purging

Old reports can be purged to save device storage. This affects targets that use `date: 'now'` (all-time counting).

| Risky Pattern | Safe Alternative |
|---------------|------------------|
| All-time report count (`date: 'now'`) | Monthly count (`date: 'reported'`) |
| `contact.reports.filter(...).length` for totals | Time-bounded: filter by `reported_date > thirtyDaysAgo` |
| "Total visits" display | "Visits this month" display |

**When to warn:** If user selects `date: 'now'` in Q4, or if `passesIf` counts `contact.reports` without time bounds.

### Replication Depth

Targets run on the client device with only replicated data. Deep lineage references (`contact.contact.parent.parent`) may not be available for offline CHWs.

**When to warn:** If target logic accesses `contact.contact.parent.parent` or deeper.

---

## Testing Targets

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

---

## Cross-Skill Integration

Targets often share logic with tasks and contact-summary:

| Shared Logic | Example |
|-------------|---------|
| Form calculations | `is_high_risk` used in targets AND tasks AND contact-summary |
| `targets-extras.js` | Reusable functions shared across targets |
| Translation keys | Same subtitle keys across multiple targets |

When creating a target that uses the same field conditions as an existing task or card, check for:
- Existing calculated fields in the XLSForm (reuse them)
- Existing extras files (`targets-extras.js`, `contact-summary-extras.js`)
- Shared translation keys in `translations/messages-*.properties`

---

## Scripts

### `scripts/detect-cht-project.sh`
Detects CHT project structure and lists available forms.

### `scripts/read-xlsform.py`
Reads XLSForm files using openpyxl and extracts survey fields, choices, and settings.

### `scripts/add-xlsform-calculation.py`
Adds a calculated field to an XLSForm file. Used when suggesting form calculations for complex target logic.

**Usage:**
```bash
python scripts/add-xlsform-calculation.py <xlsform.xlsx> <field_name> "<calculation>"
```

---

## Additional Resources

For detailed reference information, consult:
- **`references/targets-schema.md`** - Complete target schema documentation
- **`references/counting-modes.md`** - idType, groupBy, and date filter details
- **`references/xlsform-patterns.md`** - Common XLSForm patterns for target conditions

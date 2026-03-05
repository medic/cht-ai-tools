---
name: create-cht-task
description: "This skill should be used when the user asks to 'create a task', 'help me create a CHT task', 'build a task', 'add a new task', 'generate tasks.js', 'create follow-up task', 'create reminder task', or mentions task creation for CHT applications. Provides guided, educational assistance for creating CHT tasks by analyzing existing forms and project context."
---

# CHT Task Creator

Interactive, educational assistant for creating CHT (Community Health Toolkit) tasks. This skill guides developers through task creation by understanding their project context, analyzing existing forms, and generating properly configured tasks.js code.

## Workflow Overview

```
1. EXPLAIN    → Brief description of what CHT tasks are and how they work
2. DETECT     → Check if current folder is a CHT project, identify structure
3. ANALYZE    → Read forms using Python/openpyxl to extract fields and logic
4. GATHER     → Ask targeted questions about the task requirements
5. GENERATE   → Create the task configuration with educational explanations
```

---

## Step 1: Explain CHT Tasks

Start by providing a brief, educational overview:

> **CHT Tasks** are reminders that appear in the Tasks tab of the CHT app. They prompt health workers to complete follow-up activities like postnatal visits, immunization reminders, or assessment follow-ups.
>
> Tasks are configured in `tasks.js` and work by:
> - **Triggering** from contacts or submitted reports
> - **Appearing** within a time window (start/end days relative to due date)
> - **Resolving** when a specific form is submitted
> - **Opening** an action form when clicked

---

## Step 2: Detect CHT Project

Check if the current working directory is a CHT configuration project.

### Detection Script

Execute `scripts/detect-cht-project.sh` to identify:
- Is this a CHT project? (looks for `tasks.js`, `forms/app/`, `app_settings.json`)
- What forms exist in `forms/app/`?
- Does `tasks.js` already exist? What tasks are defined?
- What contact types are configured?

If NOT a CHT project:
> "This doesn't appear to be a CHT project directory. To create tasks, navigate to a CHT project root containing `tasks.js` and `forms/app/` directory."

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

When analyzing forms for task creation, look for:

| Field Pattern | Significance |
|---------------|--------------|
| `patient_id`, `_id` | Contact association |
| `delivery_date`, `lmp_date` | Date fields for scheduling |
| `risk_level`, `danger_signs` | Priority indicators |
| `referral_*`, `follow_up_*` | Follow-up triggers |
| `visit_date`, `next_visit` | Scheduling fields |
| Calculated fields | Derived values for conditions |

---

## Step 4: Gather Requirements

Ask focused questions one at a time. Use the form analysis to offer relevant choices.

### Essential Questions

**Q1: Task Trigger**
> "What should trigger this task?"
> - A) After a specific form is submitted (report-based) — *e.g., pregnancy registration triggers ANC visits*
> - B) For all contacts of a type (contact-based) — *e.g., monthly assessment for all patients*

**Q2: Triggering Form/Contact** (based on Q1)
> "Which form should trigger this task?" [list detected forms]
> OR
> "Which contact type should have this task?" [list: person, clinic, health_center, etc.]

**Q3: Timing**
> "When should this task appear?"
> - Days after the triggering event (e.g., "7 days after delivery")
> - Based on a date field in the form (e.g., "on the EDD date")
> - Recurring schedule (e.g., "every 30 days")

**Q4: Task Window**
> "How long should the task be visible?"
> - Start: days before due date to show task
> - End: days after due date before task expires

**Q5: Resolution**
> "What form completes this task?" [list detected forms]

**Q6: Conditions** (if complex logic detected in forms)
> "Should this task only apply in certain conditions?"
> - Based on field values from triggering report
> - Based on contact properties
> - Always apply

**Q7: Priority** (optional)
> "Should some cases show as high priority?"
> - Based on risk indicators
> - Always normal priority

---

## Step 5: Generate Task Configuration

Create the task with educational comments explaining each part.

### Task Schema Reference

See [references/tasks-schema.md](references/tasks-schema.md) for the complete schema. Key fields:

- `name`, `icon`, `title` (translation key)
- `appliesTo` (`reports`|`contacts`), `appliesToType`, `appliesIf`
- `events[]`: `id`, `days`|`dueDate`, `start`, `end`
- `actions[]`: `form`, `modifyContent()`
- `resolvedIf()`: return true when task is complete
- `priority`: `level` + `label` (optional)

### Utils Functions

Key functions: `Utils.addDate()`, `Utils.isFormSubmittedInWindow()`, `Utils.getMostRecentReport()`, `Utils.getField()`, `Utils.MS_IN_DAY`. See [references/utils-functions.md](references/utils-functions.md) for full details.

---

## Educational Output Format

When generating the task, explain each section:

```markdown
### Generated Task: [task-name]

**What this task does:**
[Plain language description]

**Trigger:** [When the task is created]
**Window:** [When it appears/disappears]
**Resolution:** [What completes it]

\`\`\`javascript
// tasks.js - Add this to your tasks array

{
  // ─── IDENTIFICATION ─────────────────────────────
  name: 'postnatal-followup',     // Unique name for this task
  icon: 'mother-child',           // Icon shown in task list
  title: 'task.postnatal.title',  // Add to translations

  // ─── TRIGGER CONDITIONS ─────────────────────────
  // This task triggers from delivery reports
  appliesTo: 'reports',
  appliesToType: ['delivery'],

  // Only apply if delivery was at home (optional filter)
  appliesIf: function(contact, report) {
    return Utils.getField(report, 'delivery_place') === 'home';
  },

  // ─── TIMING ─────────────────────────────────────
  // Task appears 7 days after delivery, visible 2 days before/after
  events: [{
    id: 'pnc-day-7',
    days: 7,      // 7 days after delivery report
    start: 2,     // Show 2 days early (day 5)
    end: 2        // Hide 2 days late (day 9)
  }],

  // ─── ACTION ─────────────────────────────────────
  // Opens postnatal visit form when clicked
  actions: [{
    form: 'postnatal_visit',
    modifyContent: function(content, contact, report, event) {
      // Pre-fill the form with data from delivery report
      content.delivery_date = Utils.getField(report, 'delivery_date');
    }
  }],

  // ─── RESOLUTION ─────────────────────────────────
  // Task completes when postnatal_visit is submitted in window
  resolvedIf: function(contact, report, event, dueDate) {
    return Utils.isFormSubmittedInWindow(
      contact.reports,
      'postnatal_visit',
      Utils.addDate(dueDate, -event.start).getTime(),
      Utils.addDate(dueDate, event.end + 1).getTime()
    );
  }
}
\`\`\`

### Translation Keys to Add

Add to `translations/messages-en.properties`:
\`\`\`
task.postnatal.title=Postnatal Follow-up Visit
\`\`\`

### Build Command

\`\`\`bash
cht --local compile-app-settings upload-app-settings
\`\`\`
```

---

## Common Task Patterns

See [references/task-patterns.md](references/task-patterns.md) for 4 complete, working patterns:

| Pattern | Use Case |
|---------|----------|
| Report-Based Follow-up | Task X days after form submission |
| Contact-Based Recurring | Recurring task for all contacts of a type |
| Multiple Events (ANC) | Multiple follow-ups from single trigger |
| Conditional with Priority | High-priority based on risk indicators |

---

## Best Practice: Use Form Calculations for Complex Logic

**When a task requires multiple field conditions, add a calculated field in the XLSForm instead of cluttering tasks.js.**

This keeps tasks.js clean, puts logic where it belongs (in the form), and creates a single source of truth.

### ❌ Bad: Complex logic in tasks.js

```javascript
appliesIf: function(contact, report) {
  return Utils.getField(report, 'risk_level') === 'high' &&
         Utils.getField(report, 'delivery_place') === 'home' &&
         Utils.getField(report, 'complications') !== 'none' &&
         Utils.getField(report, 'baby_weight') < 2.5;
}
```

**Problems:** Hard to maintain, duplicates form logic, many `Utils.getField` calls.

### ✅ Good: Add calculation to XLSForm

**In the XLSForm (survey sheet):**

| type | name | label | calculation |
|------|------|-------|-------------|
| calculate | needs_urgent_pnc | | if(${risk_level} = 'high' and ${delivery_place} = 'home' and ${complications} != 'none' and number(${baby_weight}) < 2.5, 'yes', 'no') |

**In tasks.js:**

```javascript
appliesIf: function(contact, report) {
  return Utils.getField(report, 'needs_urgent_pnc') === 'yes';
}
```

### When to Suggest Form Calculations

Recommend adding a calculated field when the task condition involves:

- **3+ field references** from the same form
- **Complex boolean logic** (multiple AND/OR conditions)
- **Numeric comparisons** (thresholds, ranges)
- **Logic that might be reused** (in other tasks, targets, or contact-summary)

### Common Calculation Patterns for Tasks

| Scenario | Suggested Calculation Name | Example Formula |
|----------|---------------------------|-----------------|
| Risk assessment | `needs_followup` | `if(${risk} = 'high' or ${danger_signs} != 'none', 'yes', 'no')` |
| Eligibility check | `eligible_for_service` | `if(${age} >= 15 and ${age} <= 49 and ${sex} = 'female', 'yes', 'no')` |
| Scheduling trigger | `schedule_next_visit` | `if(${outcome} = 'positive' and ${referred} = 'no', 'yes', 'no')` |
| Priority flag | `is_high_priority` | `if(${complications} != 'none' or ${delivery_place} = 'home', 'yes', 'no')` |
| Date-based | `visit_due_date` | `if(${next_visit} != '', ${next_visit}, date(${visit_date} + 30))` |

### Workflow Integration

During **Step 4 (Gather Requirements)**, if the user describes complex conditions:

1. **Identify** the fields involved (3+ fields = suggest calculation)
2. **Suggest** adding a calculated field to the triggering form
3. **Ask user** if they want you to add it to the XLSForm
4. **If yes**: Update the form using `scripts/add-xlsform-calculation.py`
5. **Generate** a simple task that references the new field

#### Recommendation Dialog

> **Recommendation:** I notice this task needs to check multiple conditions (risk level, delivery place, complications, and birth weight). Instead of putting all this logic in tasks.js, I recommend adding a calculated field `needs_urgent_pnc` to your delivery form.
>
> **Proposed calculation:**
> ```
> if(${risk_level} = 'high' and ${delivery_place} = 'home' and ${complications} != 'none' and number(${baby_weight}) < 2.5, 'yes', 'no')
> ```
>
> **Would you like me to add this calculation to your form?**
> - Yes, add it to the form
> - No, I'll add it manually
> - No, keep the logic in tasks.js

#### If User Agrees

Execute `scripts/add-xlsform-calculation.py` to:
1. Open the XLSForm with openpyxl
2. Find the appropriate position (before summary group or at end of survey)
3. Add the calculate row
4. Save the file

Then confirm:
> ✓ Added `needs_urgent_pnc` calculation to `forms/app/delivery.xlsx`
>
> **Next step:** Run `cht --local convert-app-forms upload-app-forms -- delivery` to deploy the updated form.

---

## Important Constraints

- Tasks only show for users of type "restricted to their place"
- Task window: 60 days past to 180 days future (CHT 4.0+)
- Minimize task generation for performance
- Use unique task names across the project
- Test with `cht-conf-test-harness` before deployment
- **Prefer form calculations over complex tasks.js logic**

---

## Scripts

### `scripts/detect-cht-project.sh`
Detects CHT project structure and lists available forms.

### `scripts/read-xlsform.py`
Reads XLSForm files using openpyxl and extracts survey fields, choices, and settings.

### `scripts/add-xlsform-calculation.py`
Adds a calculated field to an XLSForm file. Used when suggesting form calculations for complex task logic.

**Usage:**
```bash
python scripts/add-xlsform-calculation.py <xlsform.xlsx> <field_name> "<calculation>"
```

**Example:**
```bash
python scripts/add-xlsform-calculation.py forms/app/delivery.xlsx needs_urgent_pnc \
  "if(\${risk_level} = 'high' and \${delivery_place} = 'home', 'yes', 'no')"
```

**Options:**
- `--before=group_name`: Insert before a specific group (default: before summary group)
- `--dry-run`: Show what would be done without making changes

---

## Additional Resources

For detailed reference information, consult:
- **`references/tasks-schema.md`** - Complete task schema documentation
- **`references/utils-functions.md`** - All Utils functions with examples
- **`references/xlsform-patterns.md`** - Common XLSForm patterns for task triggers

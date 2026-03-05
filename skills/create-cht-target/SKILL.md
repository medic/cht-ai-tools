---
name: create-cht-target
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

### Advanced Questions (ask only when relevant)

Skip these for simple count/percent targets unless the user mentions roles, supervisors, or data concerns.

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

See [references/targets-schema.md](references/targets-schema.md) for the complete schema. Key fields:

- `id`, `type` (`count`|`percent`), `icon`, `goal`, `translation_key`
- `appliesTo` (`reports`|`contacts`), `appliesToType`, `appliesIf`
- `passesIf` (percent only), `date`, `idType`
- `context`, `visible`, `aggregate` (optional)
- `groupBy`, `passesIfGroupCount` (grouped targets)
- `dhis` (DHIS2 integration)

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

See [references/target-patterns.md](references/target-patterns.md) for 9 complete, working patterns:

| Pattern | Key Concept |
|---------|------------|
| Simple Count (This Month) | `date: 'reported'` |
| Simple Count (All Time) | `date: 'now'` |
| Percentage with Condition | `passesIf` for numerator |
| Unique Contacts | `idType: 'contact'` |
| Related Reports Check | `contact.reports.some()` |
| GroupBy | `groupBy` + `passesIfGroupCount` |
| Contact-Based Count | `appliesTo: 'contacts'` |
| Contact-Based Percent | Contact `appliesIf` + `passesIf` |
| Supervisor Aggregated | `context` + `aggregate: true` |

---

## Best Practice: Use Form Calculations for Complex Logic

When a target requires 3+ field conditions, prefer adding a calculated field in the XLSForm over complex `targets.js` logic. For cross-report checks or shared logic, use `targets-extras.js` instead.

See [references/form-calculations-guide.md](references/form-calculations-guide.md) for complete examples, workflow integration, and a decision guide for choosing between form calculations and extras files.

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

## Utils Functions

See [references/counting-modes.md](references/counting-modes.md) for `idType`, `groupBy`, and `date` filter details. Key functions: `Utils.getField()`, `Utils.getMostRecentReport()`, `Utils.isFormSubmittedInWindow()`, `Utils.addDate()`, `Utils.now()`, `Utils.MS_IN_DAY`.

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

See [references/testing-targets.md](references/testing-targets.md) for manual verification steps and `cht-conf-test-harness` examples.

---

## Cross-Skill Integration

When creating targets, check for existing calculated fields in XLSForms, extras files (`targets-extras.js`, `contact-summary-extras.js`), and shared translation keys — reuse rather than duplicate.

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

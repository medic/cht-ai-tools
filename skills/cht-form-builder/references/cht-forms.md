# CHT App Forms Reference

Consolidated reference for building CHT app forms. Source: CHT official documentation.

---

## 1. App Form Structure

### Files Required

| File | Description | Required |
|------|-------------|----------|
| `{form_name}.xml` | XForm definition (converted from XLSForm) | Yes |
| `{form_name}.xlsx` | XLSForm source, converted via `cht-conf` | Recommended |
| `{form_name}.properties.json` | Title, icon, context, permissions | Optional |
| `{form_name}-media/` | Images, audio, video files | Optional |

### Resulting Data

When submitted, a form creates a `data_record` document (a "Report"). Reports with at least one of `place_id`, `patient_id`, or `patient_uuid` at the top level are associated with the matching contact.

---

## 2. XLSForm Structure

### Standard Form Layout

```
inputs group (relevant: ./source = 'user')
  └─ source          (hidden)
  └─ source_id       (hidden)
  └─ task_id         (hidden)
  └─ contact group
       └─ _id        (string, appearance: select-contact type-person)
       └─ patient_id (string, hidden)
       └─ name       (string, hidden)

[top-level calculate fields]
  calculate  _id          ../inputs/contact/_id
  calculate  patient_id   ../inputs/contact/patient_id
  calculate  name         ../inputs/contact/name

[form content groups / pages]
  begin group  group_page_1   (appearance: field-list)
  ...
  end group

[summary group]
  begin group  group_summary  (appearance: field-list summary)
  note         r_patient_info
  note         r_followup_note
  end group
```

The `inputs` group uses `relevant: ./source = 'user'` so it only shows when the form is opened from the Reports tab (not pre-filled from a contact or task).

### Supported XLSForm Meta Fields

| Field | Description |
|-------|-------------|
| `start` | Timestamp when form was fully loaded |
| `end` | Timestamp when Submit was clicked (currently same as `start`) |
| `today` | Date on which form was started |

### Appearance Values

| Appearance | Effect |
|-----------|--------|
| `field-list` | Renders the group as a single page |
| `field-list summary` | Renders the group as the summary page |
| `hidden` | Hides the field from the user |
| `select-contact type-{contact_type}` | Contact selector dropdown |
| `numbers tel` | Phone number input with validation |
| `countdown-timer` | Visual countdown timer (CHT 4.7.0+, use `trigger` type) |
| `mrdt-verify` | RDT capture widget |
| `display-base64-image` | Render a Base64 encoded image (CHT 3.13.0+) |
| `android-app-launcher` | Launch an external Android app |
| `descendant-of-current-contact` | Filter contact selector to current contact's descendants |

---

## 3. Form Inputs (Data Available in Forms)

### Inputs Group Fields

| Field path | Description |
|-----------|-------------|
| `inputs/source` | `'contact'` (from People tab), `'task'` (from task), `'user'` (from Reports tab) |
| `inputs/source_id` | ID of triggering report (for task-sourced forms) |
| `inputs/task_id` | ID of the task (for task-sourced forms) |
| `inputs/contact/_id` | UUID of the contact in context |
| `inputs/contact/patient_id` | Medic ID of the contact |
| `inputs/contact/name` | Name of the contact |
| `inputs/contact/parent` | Hydrated parent place data (when contact is a person) |
| `inputs/contact/contact` | Primary person data (when contact is a place) |
| `inputs/user/contact_id` | UUID of the current user's contact |
| `inputs/user/facility_id` | UUID of the current user's facility |
| `inputs/user/name` | Username of the current user |
| `inputs/user/language` | User's selected language code |

The `contact` group is also available at the top level (not nested in `inputs`). Same for `source`.

### Contact Summary Data

Access the contact's summary context via the `contact-summary` instance:

```
instance('contact-summary')/context/${variable_name}
```

Available in app forms when a contact is in context. Not available in forms opened from the Reports tab.

### User Contact Summary (CHT 4.21.0+)

Access the logged-in user's contact summary:

```
instance('user-contact-summary')/context/${variable_name}
```

### Contact Selector

To select a contact by type and load their data:

```
type: string
appearance: select-contact type-person      (or type-clinic, type-health_center, etc.)
```

Fields in the same group as the contact selector will be auto-populated with matching fields from the selected contact doc. Use `bind-id-only` in appearance to skip auto-population.

---

## 4. Properties JSON (`{form_name}.properties.json`)

### Full Schema

```json
{
  "title": [
    { "locale": "en", "content": "Form Title" },
    { "locale": "fr", "content": "Titre du formulaire" }
  ],
  "icon": "icon-key-in-resources-json",
  "subject_key": "translation.key.with.{{case_id}}",
  "hidden_fields": ["private_field", "internal_field"],
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.type === 'person' && ageInYears(contact) < 5",
    "permission": "can_submit_form"
  }
}
```

### Property Reference

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | array or string | Yes | Localized display title. Array of `{locale, content}` objects or a plain string. |
| `icon` | string | Yes | Key from `resources.json` for the form's icon. |
| `subject_key` | string | No | Translation key to override the report list title. Supports `{{field_name}}` interpolation. Available vars: `from`, `phone`, `form`, `subject.name`, `case_id`. |
| `hidden_fields` | string[] | No | Field names to hide in the view-report UI. |
| `context.person` | boolean | No | Show as an action on person profiles. |
| `context.place` | boolean | No | Show as an action on place profiles. |
| `context.expression` | string | No | JavaScript expression. Form is shown as an action when this evaluates to `true`. |
| `context.permission` | string | No | Permission key required to view and submit the form. |

### Expression Context Variables

The `context.expression` has access to:

| Variable | Description |
|----------|-------------|
| `contact` | The contact doc in context |
| `summary` | The contact's summary object |
| `user` | The current user's settings doc |
| `userSummary` | The user's contact summary (CHT 4.21.0+) |

### Expression Helper Functions

| Function | Description |
|----------|-------------|
| `ageInDays(contact)` | Age of contact in days |
| `ageInMonth(contact)` | Age of contact in months |
| `ageInYears(contact)` | Age of contact in years |
| `levenshteinEq(s0, s1, threshold=3)` | Fuzzy string match (CHT 4.19.0+) |
| `normalizedLevenshteinEq(s0, s1, threshold=0.43)` | Normalized fuzzy string match (CHT 4.19.0+) |

### Common Expression Patterns

```js
// Show only on female persons aged 10-65
"contact.type === 'person' && (!contact.sex || contact.sex === 'female') && ageInYears(contact) >= 10 && ageInYears(contact) < 65"

// Show only on children under 5
"contact.type === 'person' && ageInYears(contact) < 5"

// Show on Reports tab (no contact in context)
"!contact"

// Show on both people and from Reports tab
"!contact || contact.type === 'person'"
```

---

## 5. CHT XPath Functions

These functions are available in XLSForm `calculate` expressions:

| Function | Added | Description |
|----------|-------|-------------|
| `add-date(date, years, months, days, hours, minutes)` | 4.0.0 | Add time intervals to a date. Use negative values for past dates. |
| `cht:difference-in-days(date1, date2)` | 4.7.0 | Whole days between two dates. |
| `cht:difference-in-weeks(date1, date2)` | 4.7.0 | Whole calendar weeks between two dates. |
| `cht:difference-in-months(date1, date2)` | — | Whole calendar months between two dates. |
| `cht:difference-in-years(date1, date2)` | 4.7.0 | Whole calendar years between two dates. |
| `cht:extension-lib('lib.js', args...)` | 4.2.0 | Call a configured extension library. |
| `cht:strip-whitespace(string)` | 4.10.0 | Remove all whitespace from a string. |
| `cht:validate-luhn(number, length?)` | 4.10.0 | Validate a number with the Luhn algorithm. |
| `parse-timestamp-to-date(timestamp)` | 3.13.0 | Convert a Unix timestamp (ms) to a date. |
| `to-bikram-sambat(date)` | 3.14.0 | Format a date in Bikram Sambat calendar. |
| `z-score(table, sex, key, value)` | — | Look up a z-score from a CouchDB chart document. |

> For CHT versions below 4.7.0, use `difference-in-months` (without the `cht:` namespace prefix).

> String concatenation with `+` is deprecated — use `concat()` instead.

---

## 6. CHT Special Top-Level Fields

These fields, when placed at the top level of a form, trigger special CHT behaviors:

| Field | Description |
|-------|-------------|
| `patient_id` | Links the report to a contact by Medic ID |
| `patient_uuid` | Links the report to a contact by UUID |
| `place_id` | Links the report to a place |
| `visited_contact_uuid` | Counts this form as a household visit in UHC Mode (calculate field with place UUID) |
| `NationalQuintile` | Assigns wealth quintile to all persons in the place |
| `UrbanQuintile` | Assigns urban wealth quintile to all persons in the place |

---

## 7. Additional Docs from App Forms

A single form submission can create multiple CouchDB documents. Use `db-doc="true"` on an XForm model element to mark it as a separate document.

Use `db-doc-ref="xpath"` to create a cross-reference between documents (the field is populated with the referenced doc's `_id`).

**XLSForm column for extra docs:** add a column `bind::db-doc` with value `true`.

Common use case: registering a newborn from a delivery form (the child becomes a separate `person` contact doc).

---

## 8. Form Design Best Practices

### Titles

- Use Title Case: "Delivery Follow-Up" not "Delivery follow-up"
- Do not include the patient's name in the title
- Avoid generic words like "Visit" or "Report"
- Keep titles under 40 characters (longer titles may be truncated)

### Content and Layout

- **Group related questions** — users process forms faster when questions are logically batched (e.g., "Visit Details", "Danger Signs")
- **Ask questions in a conversational sequence** — each question should flow naturally from the previous
- **Reflect input length in the field** — for phone numbers, IDs, and other fixed-length inputs
- **Never use placeholder text inside fields** — empty fields draw more attention; placeholder text can cause users to skip a field
- **Mark optional fields** (not required ones) — especially when most fields are required
- **Stack radio buttons vertically** — never put options side by side; vertical scanning reduces missed options
- **Use radio buttons for fewer than 7 options** — use dropdowns only for long lists
- **Use images** where they help clarify a question

### Summary Page

The summary page is shown after all required questions are answered. The user must scroll to the bottom and click Submit.

**Recommended section order:**

1. Reminder: "To finish, be sure to click the Submit button at the bottom of the form."
2. Patient details (name, age, etc.)
3. Visit information (summary of captured data)
4. Signs and symptoms (if applicable)
5. Refer to facility warning (if applicable, styled in red)
6. Diagnosis and treatment (if applicable)
7. Healthy tips / educational info (if applicable)
8. Follow-ups scheduled (if applicable)

**Section headers:** only show a header when its section has visible content. Use a `relevant` condition that ORs together all child field conditions.

**Header colors:**
- `#e2b100` yellow — patient details
- `#6b9acd` blue — visit information, key messages
- `#b5bd21` lime — child health
- `#e00900` red — warnings and danger signs (use sparingly)
- `#75b2b2` green — follow-up

**Text styling in notes:**
- Bold: `**text**` or `<strong>text</strong>`
- Italic: `*text*` or `_text_`
- Lists: `<ul><li>item</li></ul>` or `<ol style="margin-left:1em"><li>item</li></ol>`
- Newlines: `\n`
- HTML tags supported: `h1`–`h4`, `em`, `i`, `ul`, `li`, `p`, `span` (including `style` attribute)

---

## 9. Common Form Patterns

### Pattern: Contact-Linked Report

Ensures the report is linked to the correct person whether opened from a contact page or the Reports tab.

```
inputs group (relevant: ./source = 'user', appearance: field-list)
  hidden     source          default: user
  contact group
    string   _id             select-contact type-person
    string   patient_id      hidden
    string   name            hidden
  end group
end group

calculate   patient_uuid    ../inputs/contact/_id
calculate   patient_id      ../inputs/contact/patient_id
calculate   name            ../inputs/contact/name
```

### Pattern: Capture User Metadata

```
inputs group
  user group
    string  contact_id    (populated from user-settings doc)
    string  facility_id
    string  name
  end group
end group

calculate  created_by             ../inputs/user/name
calculate  created_by_person_uuid ../inputs/user/contact_id
calculate  created_by_place_uuid  ../inputs/user/facility_id
```

### Pattern: Age-Gated Form (properties.json)

```json
{
  "title": [{ "locale": "en", "content": "Child Assessment" }],
  "icon": "icon-healthcare-assessment",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.type === 'person' && ageInYears(contact) < 5"
  }
}
```

### Pattern: Summary Note with Conditional Section

```
begin group  group_summary     field-list summary
note  lbl_submit_reminder   To finish, be sure to click the Submit button...
note  lbl_patient_header    <h1 style="background-color:#e2b100">Patient Details</h1>
                             relevant: true
note  lbl_patient_name      **${patient_name}**
note  lbl_danger_header     <h1 style="background-color:#e00900">Danger Signs</h1>
                             relevant: ${has_danger_sign_a} = 'yes' or ${has_danger_sign_b} = 'yes'
note  lbl_danger_text       Refer patient immediately.
                             relevant: ${has_danger_sign_a} = 'yes' or ${has_danger_sign_b} = 'yes'
end group
```

### Pattern: Task-Sourced Form with Pre-filled Contact

When a form is launched from a task, `inputs/source = 'task'` and `inputs/contact` is pre-populated. The `inputs` group's `relevant: ./source = 'user'` condition means the contact selector is hidden, and data flows automatically from the task context.

### Pattern: Contact Selector with Auto-populated Fields

```
begin group  selected_household   NO_LABEL
string       household_id         Household    select-contact type-clinic
string       household_name       Household Name            (auto-populated)
end group
```

### Pattern: Phone Number with Uniqueness Check

Requires `cht=https://communityhealthtoolkit.org` in the settings tab namespaces column.

```
type: string
appearance: numbers tel
instance::cht:unique_tel: true
constraint: true
constraint_message::en: Please enter a valid phone number.
```

### Pattern: Countdown Timer (CHT 4.7.0+)

Requires `cht=https://communityhealthtoolkit.org` in the settings tab namespaces column.

```
type: trigger
appearance: countdown-timer
instance::cht:duration: 30
required: .='OK'    (makes timer mandatory before continuing)
```

### Pattern: Multimedia in Forms

Place media files in `{form_name}-media/` directory. Reference them in XLSForm labels:

```
label: [audio]jr://audio.mp3
label: [image]jr://image.jpg
```

Or in XML:
```xml
<text id="guidance_image">
  <value form="image">jr://health_tip.jpg</value>
</text>
```

---

## 10. Build and Convert

```shell
# Convert XLSForm to XForm and upload
cht --local convert-app-forms upload-app-forms

# Upload a specific form
cht --url=https://<user>:<pass>@localhost --accept-self-signed-certs upload-app-forms -- assessment

# Upload resources (icons)
cht --url=https://<user>:<pass>@localhost --accept-self-signed-certs upload-resources
```

The XLSForm (`assessment.xlsx`) and its properties file (`assessment.properties.json`) should be in the same directory under `forms/app/`.

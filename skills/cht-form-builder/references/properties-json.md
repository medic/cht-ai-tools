# Form Properties Reference

Complete reference for `.properties.json` files in CHT forms.

## File Location

```
forms/app/
├── patient_assessment.xlsx
└── patient_assessment.properties.json    ← Must match form filename
```

---

## Complete Structure

**IMPORTANT:** Always use the localized array format for titles.

```json
{
  "title": [
    { "locale": "en", "content": "Patient Assessment" },
    { "locale": "fr", "content": "Évaluation du Patient" }
  ],
  "icon": "icon-healthcare",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person'"
  },
  "subject_key": "contact.name"
}
```

---

## Field Reference

### title (required)

Display name shown in the app. **Must use localized array format:**

```json
{
  "title": [
    { "locale": "en", "content": "Treatment Followup" },
    { "locale": "fr", "content": "Suivi Traitement" }
  ]
}
```

Each locale object has:
- `locale`: Language code (en, fr, sw, etc.)
- `content`: Translated title text

---

### icon (optional)

Icon displayed next to form name. Available icons:

| Icon | Use Case |
|------|----------|
| `icon-healthcare` | General health assessments |
| `icon-pregnancy` | Pregnancy-related |
| `icon-baby` | Child/newborn |
| `icon-follow-up` | Follow-up visits |
| `icon-referral` | Referral forms |
| `icon-death` | Death registration |
| `icon-household` | Household visits |
| `icon-person` | Person registration |
| `icon-clinic` | Facility forms |
| `icon-risk` | Danger sign assessments |

Custom icons can be added to `resources/icons/`.

---

### context (required)

Controls where and when the form appears.

#### Basic Context

```json
{
  "context": {
    "person": true,
    "place": false
  }
}
```

| Key | Effect |
|-----|--------|
| `person: true` | Shows on person contacts |
| `place: true` | Shows on place contacts (household, health_center) |

#### Expression-Based Context

Use `expression` for fine-grained control:

```json
{
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && ageInYears(contact) < 5"
  }
}
```

---

## Expression Patterns

### Contact Type Checks

```javascript
// Specific contact type (use contact_type, not type)
contact.contact_type === 'person'
contact.contact_type === 'patient'
contact.contact_type === 'c92_household'
contact.contact_type === 'health_center'

// Contact has specific property
contact.date_of_birth
contact.sex === 'female'
contact.pregnant === true
```

### Contact Summary Access

Access data calculated in contact-summary.templated.js:

```javascript
// Check if alive
summary.alive

// Check permissions
summary.canCreateChwReports()

// Custom context variables
summary.is_pregnant
summary.has_pending_referral
summary.risk_level === 'high'
```

### Age-Based Expressions

```javascript
// Children under 5
contact.date_of_birth && ageInYears(contact) < 5

// Infants under 1 year
contact.date_of_birth && ageInYears(contact) < 1

// Newborns under 28 days
contact.date_of_birth && ageInDays(contact) < 28

// Women of childbearing age (15-49)
contact.sex === 'female' && ageInYears(contact) >= 15 && ageInYears(contact) <= 49

// Children 6 months to 5 years
contact.date_of_birth && ageInMonths(contact) >= 6 && ageInYears(contact) < 5
```

### Time-Based Expressions

```javascript
// Within 42 days of delivery (postnatal period)
contact.delivery_date && daysSince(contact.delivery_date) <= 42

// Pregnancy not yet at term
contact.edd && daysUntil(contact.edd) > 0

// Last visit more than 30 days ago
!contact.last_visit_date || daysSince(contact.last_visit_date) > 30
```

### Status-Based Expressions

```javascript
// Active pregnancy
contact.pregnant === true

// Has pending referral
contact.has_pending_referral === true

// On active treatment
contact.on_treatment === true

// Not deceased
contact.date_of_death === undefined
```

### Role-Based Expressions

```javascript
// CHW only
user.role === 'chw'

// CHW or nurse
user.role === 'chw' || user.role === 'nurse'

// Supervisor and above
user.role === 'supervisor' || user.role === 'admin'

// Not a data manager
user.role !== 'data_manager'
```

### Combined Expressions

```javascript
// Under-5 assessment: Children under 5, CHW only
contact.contact_type === 'person' && contact.date_of_birth && ageInYears(contact) < 5 && user.role === 'chw'

// ANC visit: Pregnant women, not yet delivered
contact.contact_type === 'person' && contact.sex === 'female' && contact.pregnant === true && !contact.delivery_date

// PNC visit: Within 42 days of delivery
contact.contact_type === 'person' && contact.delivery_date && daysSince(contact.delivery_date) <= 42

// Immunization: Children under 2
contact.contact_type === 'person' && contact.date_of_birth && ageInYears(contact) < 2

// Household assessment: Households only, CHW visits
contact.contact_type === 'household' && user.role === 'chw'
```

---

## Permission-Based Access

For role-based restrictions, two approaches:

### Approach 1: Direct Role Check (Simple)

```json
{
  "context": {
    "expression": "contact.contact_type === 'person' && (user.role === 'chw' || user.role === 'nurse')"
  }
}
```

**Pros:** Simple, no app_settings changes
**Cons:** Hardcoded roles, must update each form to change

### Approach 2: Permission-Based (Recommended)

**Step 1:** Add permission to `app_settings.json`:
```json
{
  "permissions": {
    "can_access_patient_assessment": ["chw", "nurse", "supervisor"]
  }
}
```

**Step 2:** Reference in expression:
```json
{
  "context": {
    "expression": "contact.contact_type === 'person' && user.role && cht:extension-lib('permission', 'can_access_patient_assessment')"
  }
}
```

**Pros:** Centralized role management, easy to update
**Cons:** Requires app_settings modification

---

## subject_key (optional)

Defines what appears as the form submission subject line.

```json
{
  "subject_key": "contact.name"
}
```

Common patterns:

| Key | Result |
|-----|--------|
| `contact.name` | Patient name |
| `contact.patient_id` | Patient ID |
| Custom calculation | Set in XLSForm calculate field |

For custom subjects, add a `calculate` field in XLSForm:
```
type: calculate
name: subject
calculation: concat(${patient_name}, ' - ', ${assessment_result})
```

Then reference:
```json
{
  "subject_key": "subject"
}
```

---

## Complete Examples

### Under-5 Patient Assessment

```json
{
  "title": [
    { "locale": "en", "content": "Patient Assessment (Under 5)" },
    { "locale": "fr", "content": "Évaluation Patient (Moins de 5 ans)" }
  ],
  "icon": "icon-baby",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && contact.date_of_birth && ageInYears(contact) < 5 && summary.alive"
  },
  "subject_key": "contact.name"
}
```

### Pregnancy Registration

```json
{
  "title": [
    { "locale": "en", "content": "Pregnancy Registration" },
    { "locale": "fr", "content": "Enregistrement de Grossesse" }
  ],
  "icon": "icon-pregnancy",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && contact.sex === 'female' && ageInYears(contact) >= 15 && ageInYears(contact) <= 49 && contact.pregnant !== true && summary.alive"
  },
  "subject_key": "contact.name"
}
```

### ANC Follow-up

```json
{
  "title": [
    { "locale": "en", "content": "ANC Follow-up Visit" },
    { "locale": "fr", "content": "Visite de Suivi CPN" }
  ],
  "icon": "icon-pregnancy",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && contact.pregnant === true && !contact.delivery_date && summary.alive && summary.canCreateChwReports()"
  },
  "subject_key": "contact.name"
}
```

### Postnatal Care

```json
{
  "title": [
    { "locale": "en", "content": "Postnatal Care Visit" },
    { "locale": "fr", "content": "Visite Soins Postnatals" }
  ],
  "icon": "icon-baby",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && contact.delivery_date && daysSince(contact.delivery_date) <= 42 && summary.alive && summary.canCreateChwReports()"
  },
  "subject_key": "contact.name"
}
```

### Household Visit (CHW Only)

```json
{
  "title": [
    { "locale": "en", "content": "Household Visit" },
    { "locale": "fr", "content": "Visite du Ménage" }
  ],
  "icon": "icon-household",
  "context": {
    "person": false,
    "place": true,
    "expression": "contact.contact_type === 'household' && user.role === 'chw' && summary.canCreateChwReports()"
  },
  "subject_key": "contact.name"
}
```

### Referral Follow-up (With Permission)

```json
{
  "title": [
    { "locale": "en", "content": "Referral Follow-up" },
    { "locale": "fr", "content": "Suivi de Référence" }
  ],
  "icon": "icon-referral",
  "context": {
    "person": true,
    "place": false,
    "expression": "contact.contact_type === 'person' && contact.has_pending_referral === true && summary.alive && user.role && cht:extension-lib('permission', 'can_followup_referral')"
  },
  "subject_key": "contact.name"
}
```

Required permission in `app_settings.json`:
```json
{
  "permissions": {
    "can_followup_referral": ["chw", "nurse", "supervisor"]
  }
}
```

---

## Available Functions

| Function | Description | Example |
|----------|-------------|---------|
| `ageInYears(contact)` | Age in complete years | `ageInYears(contact) < 5` |
| `ageInMonths(contact)` | Age in months | `ageInMonths(contact) < 6` |
| `ageInDays(contact)` | Age in days | `ageInDays(contact) < 28` |
| `daysSince(date)` | Days since date | `daysSince(contact.delivery_date) <= 42` |
| `daysUntil(date)` | Days until date | `daysUntil(contact.edd) > 0` |

---

## Updating app_settings.json for Permissions

When adding a new permission:

1. **Read current permissions:**
```bash
jq '.permissions' app_settings.json
```

2. **Add new permission:**
```bash
jq '.permissions.can_access_new_form = ["chw", "nurse"]' app_settings.json > tmp.json && mv tmp.json app_settings.json
```

3. **Or manually edit** `app_settings.json`:
```json
{
  "permissions": {
    "existing_permission": ["chw"],
    "can_access_new_form": ["chw", "nurse", "supervisor"]
  }
}
```

4. **Upload configuration:**
```bash
cht --local upload-app-settings
```

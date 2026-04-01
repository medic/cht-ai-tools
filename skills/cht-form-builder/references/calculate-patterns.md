# Calculate Field Patterns Reference

Standard calculate field patterns used in CHT forms. Calculate fields store computed values without displaying them to users.

---

## Table of Contents

1. [Patient Info from Inputs](#1-patient-info-from-inputs)
2. [Age Calculations](#2-age-calculations)
3. [Contact-Summary Access](#3-contact-summary-access)
4. [Age Display Formatting](#4-age-display-formatting)
5. [Choice Label Lookup](#5-choice-label-lookup)
6. [Date Formatting](#6-date-formatting)
7. [Conditional Logic](#7-conditional-logic)
8. [Task-Related Calculations](#8-task-related-calculations)
9. [Best Practices](#best-practices)
10. [Common Mistakes](#common-mistakes)

---

## 1. Patient Info from Inputs

Extract patient data from the inputs group, which is populated when the form is opened for a specific contact.

### Standard Patient Fields

```
type      | name                | calculation
----------|---------------------|------------------------------------------
calculate | patient_id          | ../inputs/contact/_id
calculate | birthdate           | ../inputs/contact/date_of_birth
calculate | patient_first_name  | ../inputs/contact/first_name
calculate | patient_last_name   | ../inputs/contact/last_name
calculate | patient_full_name   | concat(${patient_first_name}, ' ', ${patient_last_name})
calculate | patient_name        | coalesce(../inputs/contact/name, ${patient_full_name})
calculate | patient_sex         | ../inputs/contact/sex
```

### Explanation

| Field | Description |
|-------|-------------|
| `patient_id` | Unique identifier for the contact (UUID) |
| `birthdate` | Date of birth (format: YYYY-MM-DD) |
| `patient_first_name` | First name only |
| `patient_last_name` | Last name only |
| `patient_full_name` | Concatenated full name (First + Last) |
| `patient_name` | Uses stored name if available, falls back to computed full name |
| `patient_sex` | Sex/gender value (typically 'male' or 'female') |

### Extended Patient Info

```
type      | name              | calculation
----------|-------------------|------------------------------------------
calculate | patient_phone     | ../inputs/contact/phone
calculate | patient_address   | ../inputs/contact/address
calculate | patient_notes     | ../inputs/contact/notes
calculate | parent_id         | ../inputs/contact/parent/_id
calculate | parent_name       | ../inputs/contact/parent/name
calculate | grandparent_id    | ../inputs/contact/parent/parent/_id
```

### Usage Notes

- Path `../inputs/contact/` navigates up from the current group to the inputs group
- Use `coalesce()` to handle missing or empty fields gracefully
- Always define patient info fields early in the form (right after inputs group)

---

## 2. Age Calculations

Calculate patient age in different units for conditional logic and display.

### Core Age Calculations

```
type      | name                 | calculation
----------|----------------------|--------------------------------------------------
calculate | patient_age_in_years | floor(difference-in-months(${date_of_birth}, today()) div 12)
calculate | patient_age_in_months| difference-in-months(${date_of_birth}, today())
calculate | patient_age_in_days  | floor(decimal-date-time(today()) - decimal-date-time(${date_of_birth}))
```

### Explanation

| Function | Description |
|----------|-------------|
| `difference-in-months(date1, date2)` | Returns months between two dates |
| `decimal-date-time(date)` | Converts date to decimal number (days since epoch) |
| `floor(number)` | Rounds down to nearest integer |
| `div` | Integer division operator |

### Alternative Age Calculation Methods

```
# Method 1: Using decimal-date-time (most accurate for days)
floor(decimal-date-time(today()) - decimal-date-time(${date_of_birth}))

# Method 2: Using simple subtraction (less precise for long periods)
today() - ${date_of_birth}

# Method 3: From days (when age_in_days is already calculated)
floor(${age_in_days} div 365.25)      # years
floor(${age_in_days} div 30.4375)     # months
```

### Age Ranges for CHT Programs

| Category | Age Range | Calculation Check |
|----------|-----------|-------------------|
| Newborn | 0-28 days | `${patient_age_in_days} <= 28` |
| Infant | 0-12 months | `${patient_age_in_months} < 12` |
| Under 2 months | < 60 days | `${patient_age_in_days} < 60` |
| Under 5 years | 0-59 months | `${patient_age_in_years} < 5` |
| Child | 5-14 years | `${patient_age_in_years} >= 5 and ${patient_age_in_years} < 15` |
| Adult | 15+ years | `${patient_age_in_years} >= 15` |

---

## 3. Contact-Summary Access

Access pre-computed values from the contact-summary configuration. Contact-summary fields are calculated in JavaScript and available to all forms for that contact.

### Standard Contact-Summary Fields

```
type      | name           | calculation
----------|----------------|--------------------------------------------------
calculate | cs_age_years   | instance('contact-summary')/context/age_years
calculate | cs_age_months  | instance('contact-summary')/context/age_months
calculate | cs_age_days    | instance('contact-summary')/context/age_days
calculate | is_pregnant    | instance('contact-summary')/context/pregnant
```

### Common Contact-Summary Context Variables

```
type      | name                    | calculation
----------|-------------------------|--------------------------------------------------
calculate | cs_is_active            | instance('contact-summary')/context/is_active
calculate | cs_last_visit_date      | instance('contact-summary')/context/last_visit_date
calculate | cs_visit_count          | instance('contact-summary')/context/visit_count
calculate | cs_risk_level           | instance('contact-summary')/context/risk_level
calculate | cs_edd                  | instance('contact-summary')/context/edd
calculate | cs_weeks_pregnant       | instance('contact-summary')/context/weeks_pregnant
calculate | cs_delivery_date        | instance('contact-summary')/context/delivery_date
calculate | cs_current_medication   | instance('contact-summary')/context/current_medication
```

### When to Use Contact-Summary vs Form Calculation

| Use Contact-Summary When | Use Form Calculation When |
|--------------------------|---------------------------|
| Value used across multiple forms | Value only needed in this form |
| Complex calculation in JavaScript | Simple XPath calculation |
| Value based on multiple reports | Value based on current form inputs |
| Performance optimization needed | Calculation is straightforward |

### Accessing Fields Array

```
type      | name                | calculation
----------|---------------------|--------------------------------------------------
calculate | has_danger_signs    | instance('contact-summary')/context/fields[name='has_danger_signs']/value
calculate | immunization_status | instance('contact-summary')/context/fields[name='immunization_status']/value
```

---

## 4. Age Display Formatting

Format age for user-friendly display with multilingual support.

### English Age Display

```
type      | name                   | calculation
----------|------------------------|--------------------------------------------------
calculate | patient_age_display_en | concat(
                                      int(${patient_age_years}),
                                      if(${patient_age_years}=1, ' year and ', ' years and '),
                                      int(${patient_age_months} mod 12),
                                      if(${patient_age_months} mod 12 = 1, ' month', ' months')
                                    )
```

### French Age Display

```
type      | name                   | calculation
----------|------------------------|--------------------------------------------------
calculate | patient_age_display_fr | concat(
                                      int(${patient_age_years}),
                                      if(${patient_age_years}=1, ' an et ', ' ans et '),
                                      int(${patient_age_months} mod 12),
                                      if(${patient_age_months} mod 12 = 1, ' mois', ' mois')
                                    )
```

### Compact Age Display (Smart Units)

```
type      | name                 | calculation
----------|----------------------|--------------------------------------------------
calculate | age_display_smart_en | if(${patient_age_years} >= 2,
                                    concat(${patient_age_years}, ' years'),
                                    if(${patient_age_months} >= 2,
                                      concat(${patient_age_months}, ' months'),
                                      concat(${patient_age_days}, ' days')
                                    )
                                  )
```

### Age Display Patterns

| Age Range | Display Format (EN) | Display Format (FR) |
|-----------|---------------------|---------------------|
| < 60 days | "45 days" | "45 jours" |
| 2-23 months | "8 months" | "8 mois" |
| 2+ years | "3 years and 5 months" | "3 ans et 5 mois" |

---

## 5. Choice Label Lookup

Retrieve the human-readable label for a choice value using `jr:choice-name()`.

### Basic Choice Label

```
type      | name       | calculation
----------|------------|--------------------------------------------------
calculate | sex_label  | jr:choice-name(${patient_sex}, '${patient_sex}')
```

### Syntax Explanation

```
jr:choice-name(value, 'field_reference')
```

- **First argument**: The value to look up (variable reference)
- **Second argument**: The field name as string (with quotes, referencing the choice list)

### Examples

```
type      | name              | calculation
----------|-------------------|--------------------------------------------------
calculate | status_label      | jr:choice-name(${health_status}, '${health_status}')
calculate | symptom_label     | jr:choice-name(${main_symptom}, '${main_symptom}')
calculate | referral_label    | jr:choice-name(${referral_reason}, '${referral_reason}')
```

### Multi-Select Label (First Selection)

For `select_multiple` fields, get the label of the first selected option:

```
type      | name                  | calculation
----------|----------------------|--------------------------------------------------
calculate | first_symptom_label  | jr:choice-name(
                                    substring-before(concat(${symptoms}, ' '), ' '),
                                    '${symptoms}'
                                  )
```

### Usage Notes

- Returns the label in the current form language
- Returns empty string if value not found in choice list
- Useful for displaying user-friendly values in notes or summaries

---

## 6. Date Formatting

Format dates for display and calculate future/past dates.

### Report Date (Today or Custom)

```
type      | name        | calculation
----------|-------------|--------------------------------------------------
calculate | report_date | if(${done_today} = 'yes', now(), ${date_done})
```

### Date Formatting

```
type      | name              | calculation
----------|-------------------|--------------------------------------------------
calculate | formatted_date    | format-date-time(${visit_date}, "%d/%m/%Y")
calculate | formatted_datetime| format-date-time(now(), "%d/%m/%Y %H:%M")
calculate | iso_date          | format-date-time(${visit_date}, "%Y-%m-%d")
```

### Format String Patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| `%Y` | 4-digit year | 2024 |
| `%y` | 2-digit year | 24 |
| `%m` | Month (01-12) | 03 |
| `%d` | Day (01-31) | 15 |
| `%H` | Hour (00-23) | 14 |
| `%M` | Minute (00-59) | 30 |
| `%S` | Second (00-59) | 45 |

### Calculate Future Dates

```
type      | name           | calculation
----------|----------------|--------------------------------------------------
calculate | next_visit     | format-date-time(
                              date-time(decimal-date-time(${report_date}) + ${days_count}),
                              "%d/%m/%Y"
                            )
calculate | followup_date  | date(decimal-date-time(today()) + 7)
calculate | edd_date       | date(decimal-date-time(${lmp_date}) + 280)
```

### Calculate Past Dates

```
type      | name              | calculation
----------|-------------------|--------------------------------------------------
calculate | one_week_ago      | date(decimal-date-time(today()) - 7)
calculate | days_since_visit  | decimal-date-time(today()) - decimal-date-time(${last_visit})
```

### Date Arithmetic Explanation

```
# Add days to a date:
date-time(decimal-date-time(${start_date}) + number_of_days)

# Subtract days from a date:
date-time(decimal-date-time(${start_date}) - number_of_days)

# Get days between dates:
decimal-date-time(${end_date}) - decimal-date-time(${start_date})
```

---

## 7. Conditional Logic

Use `if()` statements for conditional calculations.

### Basic Conditional

```
type      | name          | calculation
----------|---------------|--------------------------------------------------
calculate | need_referral | if(
                            (${health_state} = 'worsened' or ${health_state} = 'no_change'),
                            'yes',
                            'no'
                          )
```

### Nested Conditionals

```
type      | name        | calculation
----------|-------------|--------------------------------------------------
calculate | risk_level  | if(${score} >= 10, 'high',
                            if(${score} >= 5, 'medium', 'low')
                          )
```

### Boolean Flags

```
type      | name            | calculation
----------|-----------------|--------------------------------------------------
calculate | child_dead      | if(${reason_to_stop} = 'patient_death', 'yes', 'no')
calculate | needs_followup  | if(${outcome} = 'referred' or ${outcome} = 'pending', 'yes', 'no')
calculate | is_danger_sign  | if(
                               selected(${symptoms}, 'convulsions') or
                               selected(${symptoms}, 'unconscious') or
                               selected(${symptoms}, 'not_eating'),
                               'yes',
                               'no'
                             )
```

### Numeric Conditionals

```
type      | name          | calculation
----------|---------------|--------------------------------------------------
calculate | fever_level   | if(${temperature} >= 39, 'high',
                            if(${temperature} >= 38, 'moderate',
                              if(${temperature} >= 37.5, 'low', 'normal')
                            )
                          )
calculate | bmi_category  | if(${bmi} < 18.5, 'underweight',
                            if(${bmi} < 25, 'normal',
                              if(${bmi} < 30, 'overweight', 'obese')
                            )
                          )
```

### Conditional with Coalesce (Handle Missing Values)

```
type      | name              | calculation
----------|-------------------|--------------------------------------------------
calculate | effective_temp    | coalesce(${measured_temp}, ${estimated_temp}, 37)
calculate | display_name      | coalesce(${nickname}, ${full_name}, 'Unknown')
```

---

## 8. Task-Related Calculations

Calculations that support the CHT task system for follow-ups and workflows.

### Follow-up Count and Timing

```
type      | name               | calculation
----------|--------------------|-------------------------------------------------
calculate | followup_next_days | if(${t_followup_count} = '1', 3, 5)
calculate | continue_followup  | if(
                                  ${tracking_intent} = 'continue_followup' and
                                  ${t_followup_count} != '3',
                                  'yes',
                                  'no'
                                )
```

### Task Trigger Fields

```
type      | name                  | calculation
----------|----------------------|-------------------------------------------------
calculate | t_danger_sign_present | if(${danger_signs_count} > 0, 'true', 'false')
calculate | t_needs_followup      | if(${visit_outcome} != 'resolved', 'true', 'false')
calculate | t_followup_due_date   | format-date-time(
                                     date-time(decimal-date-time(${report_date}) + ${followup_next_days}),
                                     "%Y-%m-%d"
                                   )
```

### Task Counter Fields

```
type      | name                | calculation
----------|--------------------|-------------------------------------------------
calculate | t_visit_count       | if(${t_visit_count_prev} != '',
                                   ${t_visit_count_prev} + 1,
                                   1
                                 )
calculate | t_followup_count    | if(${t_followup_count_prev} != '',
                                   ${t_followup_count_prev} + 1,
                                   1
                                 )
```

### Workflow Completion Flags

```
type      | name                  | calculation
----------|----------------------|-------------------------------------------------
calculate | workflow_complete     | if(
                                    ${final_outcome} = 'resolved' or
                                    ${final_outcome} = 'referred' or
                                    ${final_outcome} = 'deceased',
                                    'yes',
                                    'no'
                                  )
calculate | t_pregnancy_active    | if(
                                    ${delivery_date} = '' and
                                    ${pregnancy_ended} != 'yes',
                                    'true',
                                    'false'
                                  )
```

### Task Naming Convention

| Prefix | Purpose | Example |
|--------|---------|---------|
| `t_` | Task-related field | `t_followup_count` |
| `t_danger_` | Danger sign flags | `t_danger_sign_present` |
| `t_needs_` | Action required flags | `t_needs_followup` |
| `t_*_date` | Task due dates | `t_followup_due_date` |

---

## Best Practices

### 1. Naming Conventions

```
# Use descriptive, snake_case names
patient_age_in_years    # Good
patAge                  # Bad

# Prefix task-related fields with t_
t_followup_count        # Good
followup_count          # Ambiguous

# Use _display suffix for formatted output
patient_age_display_en  # Good
age_text                # Unclear purpose
```

### 2. Field Ordering

Place calculate fields in this order:
1. Patient info from inputs (immediately after inputs group)
2. Age calculations
3. Contact-summary access
4. Form-specific calculations
5. Task-related calculations
6. Display formatting (at the end)

### 3. Use Coalesce for Robustness

```
# Handle potentially empty fields
coalesce(${optional_field}, 'default_value')

# Chain multiple fallbacks
coalesce(${primary}, ${secondary}, ${tertiary}, 'fallback')
```

### 4. Keep Calculations Simple

```
# Break complex calculations into steps
calculate | age_months     | difference-in-months(${dob}, today())
calculate | age_years      | floor(${age_months} div 12)
calculate | remaining_months | ${age_months} mod 12

# Instead of one mega-formula
```

### 5. Document Non-Obvious Calculations

Add comments in the hint column for complex calculations:

```
type      | name      | calculation                    | hint
----------|-----------|--------------------------------|------------------------
calculate | bmi       | ${weight}/(${height}*${height})| BMI = weight(kg)/height(m)^2
```

---

## Common Mistakes

### 1. Wrong Path to Inputs

```
# WRONG - missing ../
calculate | patient_id | inputs/contact/_id

# CORRECT
calculate | patient_id | ../inputs/contact/_id
```

### 2. Forgetting Quotes in if() String Results

```
# WRONG - unquoted string
calculate | status | if(${score} > 5, high, low)

# CORRECT
calculate | status | if(${score} > 5, 'high', 'low')
```

### 3. Using = Instead of != for Negative Check

```
# WRONG - double negative confusion
calculate | is_not_done | if(${done} = 'no', 'yes', 'no')

# CLEARER
calculate | is_done | if(${done} = 'yes', 'yes', 'no')
```

### 4. Integer Division Without floor()

```
# WRONG - may return decimal
calculate | years | ${months} div 12

# CORRECT
calculate | years | floor(${months} div 12)
```

### 5. Incorrect jr:choice-name() Syntax

```
# WRONG - missing quotes around second argument
calculate | label | jr:choice-name(${field}, ${field})

# CORRECT
calculate | label | jr:choice-name(${field}, '${field}')
```

### 6. Date Arithmetic Without decimal-date-time()

```
# WRONG - can't add to date directly
calculate | next_week | ${today} + 7

# CORRECT
calculate | next_week | date(decimal-date-time(today()) + 7)
```

---

## Quick Reference Card

| Pattern | Calculation |
|---------|-------------|
| Patient ID | `../inputs/contact/_id` |
| Patient Name | `coalesce(../inputs/contact/name, concat(${first}, ' ', ${last}))` |
| Age in Years | `floor(difference-in-months(${dob}, today()) div 12)` |
| Age in Months | `difference-in-months(${dob}, today())` |
| Age in Days | `floor(decimal-date-time(today()) - decimal-date-time(${dob}))` |
| Contact-Summary | `instance('contact-summary')/context/field_name` |
| Choice Label | `jr:choice-name(${field}, '${field}')` |
| Format Date | `format-date-time(${date}, "%d/%m/%Y")` |
| Add Days | `date(decimal-date-time(${date}) + N)` |
| Conditional | `if(condition, 'true_val', 'false_val')` |
| Fallback Value | `coalesce(${primary}, ${fallback}, 'default')` |

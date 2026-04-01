# XLSForm Reference for CHT Forms

## Survey Sheet Columns

### Core Columns

| Column | Description | Required |
|--------|-------------|----------|
| `type` | Question type | Yes |
| `name` | Unique field identifier | Yes |
| `label::en` | English label | Yes |
| `label::fr` | French label (or other languages) | Optional |

### Question Types

```
# Text Input
text                    # Single-line text
integer                 # Whole numbers only
decimal                 # Numbers with decimals
range                   # Numeric slider

# Selection
select_one [list_name]  # Single choice
select_multiple [list_name] # Multiple choices

# Date/Time
date                    # Date picker
time                    # Time picker
datetime                # Date and time

# Media
image                   # Photo capture
audio                   # Audio recording
video                   # Video recording

# Display
note                    # Read-only text display

# Data Handling
calculate               # Computed value (not displayed)
hidden                  # Hidden field for data storage

# Structure
begin group             # Start a group
end group               # End a group
begin repeat            # Start a repeating section
end repeat              # End a repeating section
```

### Naming Conventions

```
# Field names must:
- Start with letter or underscore
- Contain only letters, numbers, underscores
- Be unique within form
- Use snake_case (recommended)

# Examples:
patient_name            # Good
visit_date              # Good
symptom_count           # Good
2nd_visit               # Bad (starts with number)
patient-name            # Bad (contains hyphen)
```

### Validation Columns

| Column | Description | Example |
|--------|-------------|---------|
| `required` | Make field mandatory | `yes` |
| `relevant` | Show/hide condition | `${age} >= 18` |
| `constraint` | Validation rule | `. >= 0 and . <= 120` |
| `constraint_message::en` | Error message | `Age must be 0-120` |

### Other Columns

| Column | Description | Example |
|--------|-------------|---------|
| `calculation` | Formula for calculate type | `${weight} / (${height} * ${height})` |
| `default` | Default value | `today()` |
| `hint::en` | Help text | `Enter full name` |
| `choice_filter` | Filter choices dynamically | `district = ${selected_district}` |
| `appearance` | Display style | `minimal` |
| `media::image` | Image filename | `diagram.png` |
| `read_only` | Prevent editing | `yes` |

### Appearance Options

```
# Layout
field-list              # Show all questions in group on one page
horizontal              # Display choices horizontally
horizontal-compact      # Compact horizontal choices
minimal                 # Dropdown instead of radio buttons
compact                 # Reduced spacing

# Select Appearance
autocomplete            # Searchable dropdown
quick                   # Large touch-friendly buttons
likert                  # Likert scale display
label                   # Show only labels
list-nolabel            # List without labels

# Text Appearance
multiline               # Multi-line text input
numbers                 # Numeric keyboard

# Date Appearance
no-calendar             # Date input without calendar
month-year              # Month and year only
year                    # Year only

# Group Appearance
field-list              # All fields on single page

# CHT-Specific Appearance
db-object               # Link to database object
db:person               # Person selector
db:clinic               # Clinic selector
hidden                  # Hide from display
```

---

## CHT-Specific Patterns

### Standard Inputs Group

Every CHT form should start with the inputs group:

```
type          | name       | label::en        | appearance | calculate
--------------|------------|------------------|------------|------------------
begin group   | inputs     | Inputs           | field-list |
hidden        | source     | Source           |            |
hidden        | source_id  | Source ID        |            |
begin group   | contact    | Contact          |            |
db:person     | _id        | Patient ID       | db-object  |
text          | patient_id | Patient ID       | hidden     |
text          | name       | Patient Name     | hidden     |
end group     |            |                  |            |
end group     |            |                  |            |
```

### Hidden Fields Pattern

Use hidden fields to store data without displaying:

```
type      | name            | calculation
----------|-----------------|----------------------------------
calculate | bmi             | ${weight} / (${height} * ${height})
calculate | visit_timestamp | now()
calculate | form_version    | '1.0.0'
```

### Patient Data Fields

Common patient data fields:

```
type      | name            | label::en         | appearance
----------|-----------------|-------------------|------------
hidden    | patient_uuid    | Patient UUID      |
calculate | patient_name    | Patient Name      |
calculate | patient_age     | Patient Age       |
calculate | patient_sex     | Patient Sex       |
```

### Conditional Groups

Groups that show based on conditions:

```
type        | name              | label::en           | relevant
------------|-------------------|---------------------|------------------
begin group | pregnancy_details | Pregnancy Details   | ${sex} = 'female'
integer     | weeks_pregnant    | Weeks Pregnant      |
date        | edd               | Expected Due Date   |
end group   |                   |                     |
```

---

## Choices Sheet

### Structure

| Column | Description | Required |
|--------|-------------|----------|
| `list_name` | Reference name for the list | Yes |
| `name` | Choice value (stored) | Yes |
| `label::en` | Display text (English) | Yes |
| `label::fr` | Display text (French) | Optional |

### Standard Choice Lists

**Yes/No:**
```
list_name | name | label::en | label::fr
----------|------|-----------|----------
yes_no    | yes  | Yes       | Oui
yes_no    | no   | No        | Non
```

**Sex:**
```
list_name | name   | label::en | label::fr
----------|--------|-----------|----------
sex       | male   | Male      | Masculin
sex       | female | Female    | F\u00e9minin
```

**Tri-state:**
```
list_name | name    | label::en
----------|---------|----------
tri_state | yes     | Yes
tri_state | no      | No
tri_state | unknown | Unknown
```

### Cascading Choices

Use `choice_filter` for dependent dropdowns:

**Choices sheet:**
```
list_name | name     | label::en    | region
----------|----------|--------------|--------
regions   | north    | North Region |
regions   | south    | South Region |
districts | dist_a   | District A   | north
districts | dist_b   | District B   | north
districts | dist_c   | District C   | south
districts | dist_d   | District D   | south
```

**Survey sheet:**
```
type                | name     | label::en      | choice_filter
--------------------|----------|----------------|-------------------------
select_one regions  | region   | Select Region  |
select_one districts| district | Select District| region = ${region}
```

---

## Settings Sheet

### Required Fields

| Column | Description | Example |
|--------|-------------|---------|
| `form_title` | Display name | `Patient Assessment` |
| `form_id` | Unique identifier | `patient_assessment` |

### Optional Fields

| Column | Description | Example |
|--------|-------------|---------|
| `version` | Form version | `2024010101` |
| `default_language` | Default UI language | `en` |
| `style` | Form style | `pages` |
| `instance_name` | Submission name | `concat('Visit: ', ${patient_name})` |

### Example Settings

```
form_title        | form_id             | version     | default_language | instance_name
------------------|---------------------|-------------|------------------|---------------------------
Patient Assessment| patient_assessment  | 2024010101  | en               | concat('Assessment: ', ${patient_name})
```

---

## XPath Quick Reference

### Variable References

```
${field_name}           # Reference another field's value
.                       # Current field value (in constraints)
```

### Comparison Operators

```
=                       # Equal
!=                      # Not equal
<                       # Less than
>                       # Greater than
<=                      # Less than or equal
>=                      # Greater than or equal
```

### Logical Operators

```
and                     # Both conditions true
or                      # Either condition true
not()                   # Negate condition
```

### Core Functions

```
# Selection
selected(${multi_field}, 'value')    # Check if value selected in multi-select
count-selected(${multi_field})       # Count selected options

# Math
count(${repeat_group})               # Count repeat instances
sum(${repeat_group}/field)           # Sum values in repeat
round(${decimal_field}, 2)           # Round to decimal places
int(${value})                        # Convert to integer

# Conditional
if(condition, true_val, false_val)   # Conditional value
coalesce(${a}, ${b}, 'default')      # First non-empty value

# Date/Time
today()                              # Current date
now()                                # Current datetime
date(${date_field})                  # Convert to date
format-date(${date}, '%Y-%m-%d')     # Format date string
```

### String Functions

```
concat(${a}, ' ', ${b})              # Join strings
concat('ID: ', ${patient_id})        # String with literal

contains(${text}, 'search')          # Check if contains substring
starts-with(${text}, 'prefix')       # Check if starts with
ends-with(${text}, 'suffix')         # Check if ends with

string-length(${text})               # Character count
substring(${text}, 1, 5)             # Extract substring
translate(${text}, 'abc', 'ABC')     # Replace characters

normalize-space(${text})             # Trim and normalize whitespace
upper-case(${text})                  # Convert to uppercase (XForms)
lower-case(${text})                  # Convert to lowercase (XForms)
```

### Numeric Functions

```
number(${text})                      # Convert to number
floor(${decimal})                    # Round down
ceiling(${decimal})                  # Round up
abs(${number})                       # Absolute value
min(${a}, ${b})                      # Minimum value
max(${a}, ${b})                      # Maximum value
```

### Date Calculations

```
# Age calculation
int((today() - ${birth_date}) div 365.25)

# Days between dates
(${end_date} - ${start_date})

# Date arithmetic
${visit_date} + 7                    # Add 7 days

# Check date range
${visit_date} >= today() - 30       # Within last 30 days
```

---

## Common Patterns

### Age-Based Skip Logic

```
type        | name     | label::en          | relevant
------------|----------|--------------------|-----------------
begin group | adult    | Adult Questions    | ${age} >= 18
text        | occupation| Occupation        |
end group   |          |                    |
begin group | child    | Child Questions    | ${age} < 18
text        | school   | School Name        |
end group   |          |                    |
```

### Conditional Required

```
type    | name          | label::en        | required
--------|---------------|------------------|------------------
text    | other_specify | Please specify   | ${choice} = 'other'
```

### Calculated Summary

```
type      | name          | calculation
----------|---------------|---------------------------------------------
calculate | total_score   | ${q1} + ${q2} + ${q3} + ${q4} + ${q5}
calculate | risk_level    | if(${total_score} > 10, 'high', if(${total_score} > 5, 'medium', 'low'))
```

### Multi-Select Dependencies

```
type            | name     | label::en         | relevant
----------------|----------|-------------------|--------------------------------
select_multiple | symptoms | Symptoms          |
text            | fever_details | Fever details | selected(${symptoms}, 'fever')
text            | cough_details | Cough details | selected(${symptoms}, 'cough')
```

### Repeat Groups

```
type         | name          | label::en           | repeat_count
-------------|---------------|---------------------|-------------
begin repeat | household     | Household Members   | ${num_members}
text         | member_name   | Name                |
integer      | member_age    | Age                 |
select_one sex | member_sex  | Sex                 |
end repeat   |               |                     |
```

---

## Best Practices

1. **Always include inputs group** at the start of CHT forms
2. **Use calculate fields** for derived data instead of JavaScript
3. **Group related questions** using begin/end group
4. **Add constraints** for data validation
5. **Use meaningful names** that reflect the data stored
6. **Include hints** for complex questions
7. **Test relevant conditions** thoroughly
8. **Version your forms** in settings sheet
9. **Use choice_filter** for dependent dropdowns
10. **Keep field names short** but descriptive

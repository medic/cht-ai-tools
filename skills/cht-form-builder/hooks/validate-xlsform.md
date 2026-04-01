---
name: validate-xlsform
description: Validates XLSForm structure when files are written to forms/app/ directory
event: PostToolUse
tool: Write
match_pattern: "forms/app/.*\\.xlsx"
---

# XLSForm Validation Hook

When an XLSForm file is written to `forms/app/`, validate its structure.

## Validation Checks

### Structure
- File has 3 sheets: `survey`, `choices`, `settings`
- Survey starts with `begin group | inputs` with `relevant="./source='user'"`
- Every `begin group` has a matching `end group`
- `settings` sheet has `form_title` and `form_id`

### CHT-Specific
- Standard calculate fields present: `patient_id`, `patient_name` (or `patient_full_name`)
- Age calculations present if form references age: `patient_age_in_years`, `patient_age_in_months`, `patient_age_in_days`
- All `${field_name}` references in `relevant` and `calculation` columns point to fields that exist in the survey
- `properties.json` file exists alongside the `.xlsx` file

### Choice Lists
- Every `select_one X` and `select_multiple X` references a list `X` that exists in the `choices` sheet
- No duplicate field names in the survey

## Behavior

- **Warnings** — display but don't block: missing translations, labels over 80 characters
- **Errors** — report and suggest fix: missing inputs group, unmatched groups, undefined field references, missing properties.json

## Output Format

```
XLSForm Validation: forms/app/{form_name}.xlsx

  PASS: 3 sheets (survey, choices, settings)
  PASS: inputs group present
  PASS: 10 standard calculates
  PASS: all field references valid
  WARN: 3 labels exceed 80 characters
  WARN: missing properties.json — run form generator to create it

  Result: 4 passed, 2 warnings, 0 errors
```

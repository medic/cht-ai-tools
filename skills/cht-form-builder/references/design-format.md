# CHT Form Design Document Format

This document describes the expected format of design documents used to generate CHT XLSForms. Design documents are Excel files (.xlsx) that define form structure in a human-readable format.

---

## Column Structure

Design documents use the following columns:

| # | Column Name | Purpose | Required |
|---|-------------|---------|----------|
| 1 | Groupe Label | Group name for begin_group/end_group | No |
| 2 | Session | Sub-section with field-list appearance | No |
| 3 | Question | The label text (usually French) | Yes* |
| 4 | Type | XLSForm type | Yes |
| 5 | Obligatoire | Required field (yes/no) | No |
| 6+ | Option(s) | Choice options (multiple columns) | For select_* |
| N-1 | Condition | Natural language relevance condition | No |
| N | Observations | Constraints, hints, or notes | No |

*Question can be empty for option continuation rows (see Multi-Row Options below).

---

## Column Details

### 1. Groupe Label

Defines the start of a new group. When populated:
- Creates a `begin_group` row in XLSForm
- Group name is generated from the label text
- All subsequent questions belong to this group until the next Groupe Label

**Examples:**
```
Groupe Label
-------------------
Constantes et Plaintes
Examen Physique
Diagnostic
Traitement
```

**Generated XLSForm:**
```
type         | name                    | label::fr
begin_group  | constantes_et_plaintes  | Constantes et Plaintes
...questions...
end_group    | constantes_et_plaintes  |
```

### 2. Session

Creates a sub-grouping within a Groupe. Sessions:
- Create nested groups with `field-list` appearance
- Allow logical separation of related questions
- Show questions together on one screen in Enketo/Collect

**Examples:**
```
Session
-------------------
Prise de temperature
Evaluation des signes de danger
Examen de la peau
```

**Generated XLSForm:**
```
type         | name                  | label::fr              | appearance
begin_group  | prise_de_temperature  | Prise de temperature   | field-list
...questions...
end_group    | prise_de_temperature  |                        |
```

### 3. Question

The question text displayed to the user. Typically in French for Francophone projects.

**Rules:**
- Must be non-empty for new questions
- Empty Question with non-empty Option = continuation row (see Multi-Row Options)
- Used to generate unique field names via slugification
- May contain placeholders like `{{patient_name}}`

**Examples:**
```
Question
-------------------
Avez-vous un thermometre?
Quelle est la temperature de l'enfant?
L'enfant presente-t-il des signes de danger?
Le patient {{patient_name}} a-t-il de la fievre?
```

### 4. Type

XLSForm question type. Common types:

| Design Type | XLSForm Type | Description |
|-------------|--------------|-------------|
| `select_one` | `select_one [list]` | Single choice from list |
| `select_multiple` | `select_multiple [list]` | Multiple choices from list |
| `text` | `text` | Free text input |
| `integer` | `integer` | Whole number |
| `decimal` | `decimal` | Decimal number |
| `date` | `date` | Date picker |
| `note` | `note` | Display only (no input) |
| `calculate` | `calculate` | Hidden calculation |
| `image` | `image` | Photo capture |
| `geopoint` | `geopoint` | GPS location |

**Special handling:**
- `select_one` and `select_multiple` require options in Option columns
- `note` types often contain instructions or headers

### 5. Obligatoire

Indicates if the question is required.

| Design Value | XLSForm Required |
|--------------|------------------|
| `Oui` or `oui` | `yes` |
| `Non` or `non` | (empty) |
| `O` | `yes` |
| `N` | (empty) |
| (empty) | (empty) |

### 6+ Option Columns

Multiple columns for choice options. Column headers may vary:
- `Option 1`, `Option 2`, `Option 3`, ...
- `Options`, `Options 2`, `Options 3`, ...
- `Choix 1`, `Choix 2`, ...

**Rules:**
- Options are read left-to-right until empty cell
- Each option becomes a choice in the choice list
- Option names are slugified from the text

**Example row:**
```
| Question           | Type       | Option 1 | Option 2 | Option 3 |
|--------------------|------------|----------|----------|----------|
| Quel est le sexe?  | select_one | Masculin | Feminin  |          |
```

**Generated choices:**
```
list_name | name     | label::fr
sexe      | masculin | Masculin
sexe      | feminin  | Feminin
```

### Condition Column

Natural language relevance condition (usually in French). Describes when the question should be displayed.

**Common patterns:**

| French Pattern | Meaning | XPath Conversion |
|----------------|---------|------------------|
| `Si [field] = [value]` | If field equals value | `${field} = 'value'` |
| `Si [field] = Oui` | If field is yes | `${field} = 'yes'` |
| `Si [field] = Non` | If field is no | `${field} = 'no'` |
| `Si [field] > [n]` | If field greater than | `${field} > n` |
| `Si [field] < [n]` | If field less than | `${field} < n` |
| `Si [field] >= [n]` | If field >= | `${field} >= n` |
| `[cond1] ET [cond2]` | Both conditions | `(xpath1) and (xpath2)` |
| `[cond1] OU [cond2]` | Either condition | `(xpath1) or (xpath2)` |

**Examples:**
```
Condition
-------------------
Si Temperature > 37.5
Si L'enfant a de la fievre = Oui
Si Age < 2 mois
Si Temperature > 38 ET L'enfant tousse = Oui
Si Signes de danger = Oui OU Etat general altere = Oui
```

### Observations Column

Contains additional metadata:
- Constraints (validation rules)
- Hints (help text)
- Notes for developers
- Calculation formulas

**Examples:**
```
Observations
-------------------
Entre 35 et 42
Hint: Verifier avec le thermometre
Calculer automatiquement
Afficher en rouge si > 38
Ne pas afficher si deja renseigne
```

**Interpretation:**
- Numeric ranges become constraints: `constraint: . >= 35 and . <= 42`
- "Hint:" prefix becomes hint column
- Other text becomes developer notes (not in XLSForm)

---

## Special Patterns

### Multi-Row Options

When a select question has many options, they can span multiple rows:

```
| Question                  | Type       | Option 1         | Option 2    |
|---------------------------|------------|------------------|-------------|
| Quels symptomes presente? | select_mul | Fievre           | Toux        |
|                           |            | Vomissements     | Diarrhee    |
|                           |            | Maux de tete     | Fatigue     |
|                           |            | Perte d'appetit  |             |
```

**Rules:**
- First row has Question and Type
- Continuation rows have empty Question
- Empty Type on continuation row
- Options are collected from all rows until next non-empty Question
- Results in 7 choices: Fievre, Toux, Vomissements, Diarrhee, Maux de tete, Fatigue, Perte d'appetit

### Image URLs

Design documents may include image URLs (often Google Drive links) for:
- Visual aids for questions
- Reference images
- Instructional diagrams

**Handling:**
- Image URLs are stored in additional columns (Image, Lien image, etc.)
- Images must be downloaded separately
- XLSForm references local image path: `media::image`

**Example:**
```
| Question            | Type | Image URL                                    |
|---------------------|------|----------------------------------------------|
| Evaluation de l'IMC | note | https://drive.google.com/file/d/abc123/view  |
```

### Merged Cells

Some design documents use merged cells for:
- Group labels spanning multiple rows
- Section headers
- Visual grouping

**Handling:**
- Treat merged cells as applying to all spanned rows
- The value is associated with the first row
- Subsequent rows inherit the value until next non-empty cell

### Notes and Headers

`note` type rows often serve as section headers or instructions:

```
| Question                                    | Type |
|---------------------------------------------|------|
| === EXAMEN PHYSIQUE ===                     | note |
| Prenez les constantes vitales du patient... | note |
| Quelle est la temperature?                  | decimal |
```

**Handling:**
- Notes without options become display-only rows
- Can have conditions (only show note when relevant)
- Often styled differently in the form

---

## Complete Example

A sample design document structure:

```
| Groupe Label        | Session              | Question                        | Type           | Obligatoire | Option 1 | Option 2 | Option 3 | Condition                    | Observations       |
|---------------------|----------------------|---------------------------------|----------------|-------------|----------|----------|----------|------------------------------|--------------------|
| Identification      |                      | Nom du patient                  | text           | Oui         |          |          |          |                              |                    |
|                     |                      | Age en mois                     | integer        | Oui         |          |          |          |                              | Entre 0 et 59      |
|                     |                      | Sexe                            | select_one     | Oui         | Masculin | Feminin  |          |                              |                    |
| Constantes          | Temperature          | Avez-vous un thermometre?       | select_one     | Oui         | Oui      | Non      |          |                              |                    |
|                     |                      | Temperature (C)                 | decimal        | Oui         |          |          |          | Si Thermometre = Oui         | Entre 35 et 42     |
|                     |                      | L'enfant a le corps chaud?      | select_one     | Oui         | Oui      | Non      |          | Si Thermometre = Non         |                    |
|                     | Signes de danger     | L'enfant presente des convuls.? | select_one     | Oui         | Oui      | Non      |          |                              |                    |
|                     |                      | L'enfant est inconscient?       | select_one     | Oui         | Oui      | Non      |          |                              |                    |
| Diagnostic          |                      | Fievre detectee                 | calculate      |             |          |          |          |                              | Temp > 37.5        |
|                     |                      | Diagnostic principal            | select_one     | Oui         | Paludisme| IRA      | Diarrhee |                              |                    |
|                     |                      |                                 |                |             | Malnutr. | Autre    |          |                              |                    |
| Traitement          |                      | Traitement recommande           | select_mult    | Oui         | ACT      | Paracet. | SRO      | Si Diagnostic = Paludisme... |                    |
|                     |                      |                                 |                |             | Zinc     | Referer  |          |                              |                    |
```

---

## Edge Cases

### 1. Duplicate Question Text

When the same question text appears multiple times:
```
| Question               | Context    |
|------------------------|------------|
| Temperature?           | At home    |
| Temperature?           | At clinic  |
```

**Resolution:** Add suffix to generated name: `temperature`, `temperature_2`

### 2. Very Long Question Text

Questions exceeding reasonable length for field names:

**Solution:** Truncate slug to 30 characters, ensure uniqueness

### 3. Special Characters in Options

Options containing special characters:
```
Option: "N/A - Non applicable"
Option: "< 2 ans"
Option: "50% ou plus"
```

**Solution:** Slugify removes special characters: `n_a_non_applicable`, `moins_de_2_ans`, `50_ou_plus`

### 4. Empty Rows

Design documents may contain empty rows for visual spacing:

**Solution:** Skip rows where Question AND Type are both empty

### 5. Inconsistent Column Headers

Different design documents may use variations:
- "Question" vs "Questions" vs "Libelle"
- "Type" vs "Type de question"
- "Obligatoire" vs "Requis" vs "Required"

**Solution:** Match columns by common keywords, not exact text

### 6. Nested Conditions

Complex conditions with multiple levels:
```
Si (Temperature > 38 ET Toux = Oui) OU (Vomissements = Oui ET Diarrhee = Oui)
```

**Solution:** Parse parentheses, convert operators, maintain grouping

### 7. French Number Format

French uses comma as decimal separator:
```
Temperature > 37,5
```

**Solution:** Convert `37,5` to `37.5` in XPath

### 8. References to Future Questions

Condition references a question that appears later in the form:
```
Row 10: Si Diagnostic = Paludisme
Row 25: Diagnostic question
```

**Solution:** Two-pass parsing - collect all names first, then resolve conditions

---

## Validation Checklist

When parsing a design document, verify:

- [ ] All required columns present (Question, Type at minimum)
- [ ] No orphan option rows (options without a preceding select question)
- [ ] All conditions reference existing questions
- [ ] select_one/select_multiple have at least one option
- [ ] No duplicate question names after slugification
- [ ] Groups are properly opened and closed
- [ ] Required fields are not hidden by conditions that always hide them
- [ ] Numeric constraints are valid ranges

---

## See Also

- `condition-patterns.md` - Detailed natural language to XPath conversion
- `xlsform-reference.md` - XLSForm column specifications
- `SKILL.md` - Main skill documentation

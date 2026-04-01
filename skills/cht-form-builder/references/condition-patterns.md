# Condition Patterns Reference

Convert natural language conditions (French/English) to XPath expressions for XLSForm relevance fields.

---

## Table of Contents

1. [Keyword Mappings](#keyword-mappings)
2. [Basic Patterns](#basic-patterns)
3. [Comparison Operators](#comparison-operators)
4. [Boolean Logic](#boolean-logic)
5. [Complex Multi-Condition Examples](#complex-multi-condition-examples)
6. [CHT-Specific Patterns](#cht-specific-patterns)
7. [Edge Cases and Gotchas](#edge-cases-and-gotchas)

---

## Keyword Mappings

### French to XPath Keywords

| French | English | XPath |
|--------|---------|-------|
| Si | If | *(condition prefix, ignored)* |
| ET | AND | `and` |
| OU | OR | `or` |
| Oui | Yes | `'yes'` |
| Non | No | `'no'` |
| Vrai | True | `'true'` or `true()` |
| Faux | False | `'false'` or `false()` |
| contient | contains | `contains()` |
| est vide | is empty | `= ''` or `string-length() = 0` |
| n'est pas vide | is not empty | `!= ''` or `string-length() > 0` |
| est sélectionné | is selected | `selected()` |
| Autre | Other | `'other'` or `'autre'` |

### Value Translations

| French Value | XPath Value |
|--------------|-------------|
| Oui | `'yes'` |
| Non | `'no'` |
| Masculin | `'male'` or `'masculin'` |
| Féminin | `'female'` or `'feminin'` |
| Autre | `'other'` or `'autre'` |
| Inconnu | `'unknown'` |

**Note:** Value translations depend on choice list definitions. Check `choices` sheet for actual `name` values.

---

## Basic Patterns

### Equality Check

**Pattern:** `Si [Question] = [Value]`

```
Input:  Si La prise en charge est-elle faite aujourd'hui? = Non
Output: ${prise_en_charge_faite_aujourdhui} = 'no'
```

```
Input:  Si Plaintes = Autre
Output: ${plaintes} = 'autre'
```

### Boolean Questions (Oui/Non)

**Pattern:** `Si [Question] = Oui` or `Si [Question] = Non`

```
Input:  Si Avez-vous un thermomètre? = Oui
Output: ${avez_vous_un_thermometre} = 'yes'
```

```
Input:  Si Avez-vous un thermomètre? = Non
Output: ${avez_vous_un_thermometre} = 'no'
```

### Simple Field Reference

When condition just references a field (implied true/selected):

```
Input:  Si fièvre
Output: ${fievre} = 'yes'
```

---

## Comparison Operators

### Numeric Comparisons

| French | Symbol | XPath |
|--------|--------|-------|
| supérieur à / plus grand que | > | `>` |
| inférieur à / plus petit que | < | `<` |
| supérieur ou égal à | >= | `>=` |
| inférieur ou égal à | <= | `<=` |
| égal à | = | `=` |
| différent de | != | `!=` |

**Pattern:** `Si [Field] [operator] [number]`

```
Input:  Si Température > 37,5
Output: ${temperature} > 37.5
```

```
Input:  Si Température >= 38
Output: ${temperature} >= 38
```

```
Input:  Si Température < 35
Output: ${temperature} < 35
```

**Important:** French uses comma (`,`) for decimals. Convert to period (`.`) in XPath.

### Range Checks

```
Input:  Si Température entre 37 et 38
Output: ${temperature} >= 37 and ${temperature} <= 38
```

```
Input:  Si Age entre 2 et 5 ans
Output: ${age_in_years} >= 2 and ${age_in_years} <= 5
```

---

## Boolean Logic

### AND Conditions (ET)

**Pattern:** `[Condition1] ET [Condition2]`

```
Input:  Si Température > 37,5 ET Avez-vous un thermomètre? = Oui
Output: ${temperature} > 37.5 and ${avez_vous_un_thermometre} = 'yes'
```

### OR Conditions (OU)

**Pattern:** `[Condition1] OU [Condition2]`

```
Input:  Si Température > 37,5 OU L'enfant a t-il le corps chaud? = Oui
Output: ${temperature} > 37.5 or ${enfant_corps_chaud} = 'yes'
```

```
Input:  Si Avez-vous un thermomètre? = Non OU Si Température < 35
Output: ${avez_vous_un_thermometre} = 'no' or ${temperature} < 35
```

### Parentheses for Grouping

When mixing AND/OR, use parentheses:

```
Input:  Si (A = Oui ET B = Oui) OU C = Oui
Output: (${a} = 'yes' and ${b} = 'yes') or ${c} = 'yes'
```

```
Input:  Si A = Oui ET (B = Oui OU C = Oui)
Output: ${a} = 'yes' and (${b} = 'yes' or ${c} = 'yes')
```

### NOT Conditions

```
Input:  Si NOT fièvre
Output: not(${fievre} = 'yes')
```

```
Input:  Si Plaintes != Autre
Output: ${plaintes} != 'autre'
```

---

## Complex Multi-Condition Examples

### Example 1: Temperature with Fallback

**Design:** Show warning if fever detected by thermometer OR by touch

```
Input:  Si Température >37,5 OU L'enfant a t-il le corps chaud? = Oui
Output: ${temperature} > 37.5 or ${enfant_corps_chaud} = 'yes'
```

### Example 2: Conditional on No Thermometer

**Design:** Show body check question when no thermometer available

```
Input:  Si Avez-vous un thermomètre? = Non
Output: ${avez_vous_un_thermometre} = 'no'
```

### Example 3: Multiple OR Conditions

```
Input:  Si Avez-vous un thermomètre? = Non OU Si Température < 35
Output: ${avez_vous_un_thermometre} = 'no' or ${temperature} < 35
```

### Example 4: Age-Based Condition

```
Input:  Si Age < 2 mois (60 jours)
Output: ${age_in_days} < 60
```

### Example 5: Multiple Select Check

```
Input:  Si Plaintes contient Fièvre
Output: selected(${plaintes}, 'fievre')
```

### Example 6: Complex Nested Logic

```
Input:  Si (Température > 38 OU Corps chaud = Oui) ET Age < 5 ans
Output: (${temperature} > 38 or ${corps_chaud} = 'yes') and ${age_in_years} < 5
```

### Example 7: Chained Dependencies

```
Input:  Si Prise en charge = Non ET Raison = Refus
Output: ${prise_en_charge} = 'no' and ${raison} = 'refus'
```

---

## CHT-Specific Patterns

### Age Calculations

CHT forms typically calculate age from date of birth. Common patterns:

| Condition | XPath | Notes |
|-----------|-------|-------|
| Age < 2 mois | `${age_in_days} < 60` | ~60 days |
| Age < 5 ans | `${age_in_years} < 5` | Under 5 years |
| Age entre 2 et 12 mois | `${age_in_months} >= 2 and ${age_in_months} < 12` | |
| Nouveau-né | `${age_in_days} <= 28` | First 28 days |

**Typical age calculation fields:**
```
name: age_in_days
calculation: int((today() - ${date_of_birth}) div 86400000)

name: age_in_months
calculation: int(${age_in_days} div 30.4)

name: age_in_years
calculation: int(${age_in_days} div 365.25)
```

### Date Comparisons

| Pattern | XPath |
|---------|-------|
| Today's date | `today()` |
| Date in past | `${date_field} < today()` |
| Date in future | `${date_field} > today()` |
| Within last 7 days | `${date_field} >= today() - 7` |
| Same day | `format-date(${date_field}, '%Y-%m-%d') = format-date(today(), '%Y-%m-%d')` |

### Contact/Patient Fields

CHT forms often reference contact data via `inputs`:

```xpath
${inputs}/contact/name
${inputs}/contact/date_of_birth
${inputs}/contact/sex
${inputs}/contact/parent/_id
```

**Example:**
```
Input:  Si Patient est Femme
Output: ${inputs}/contact/sex = 'female'
```

### Previous Visit Data

```
Input:  Si dernière visite < 7 jours
Output: ${days_since_last_visit} < 7
```

### Pregnancy-Related

```
Input:  Si enceinte
Output: ${pregnancy_status} = 'yes' or ${inputs}/contact/pregnant = 'yes'

Input:  Si semaines de grossesse > 28
Output: ${gestational_weeks} > 28
```

---

## Edge Cases and Gotchas

### 1. Decimal Separator

**Problem:** French uses comma, XPath uses period.

```
WRONG:  ${temperature} > 37,5
RIGHT:  ${temperature} > 37.5
```

### 2. Empty String vs Null

**Problem:** Unfilled fields may be empty string or undefined.

```
# Check if field has any value
string-length(${field}) > 0

# Check if field is empty
${field} = '' or not(${field})
```

### 3. Selected() for Multi-Select

**Problem:** Using `=` on `select_multiple` only matches exact full value.

```
WRONG:  ${symptoms} = 'fever'           # Only matches if ONLY fever selected
RIGHT:  selected(${symptoms}, 'fever')   # Matches if fever is among selections
```

### 4. Case Sensitivity

XPath string comparisons are case-sensitive.

```
# If choice value is 'Oui' (capitalized)
${field} = 'Oui'     # Matches
${field} = 'oui'     # Does NOT match
```

**Best Practice:** Use lowercase for all choice `name` values.

### 5. Repeated "Si" Keyword

Design documents sometimes include "Si" multiple times:

```
Input:  Si Avez-vous un thermomètre? = Non OU Si Température < 35
        ^^                               ^^
        Both "Si" should be ignored

Output: ${avez_vous_un_thermometre} = 'no' or ${temperature} < 35
```

### 6. Question Text vs Field Name Matching

Natural language references the question label, not the field name.

```
Design Question: "L'enfant a t-il le corps chaud?"
Field Name:      enfant_corps_chaud

Input:  Si L'enfant a t-il le corps chaud? = Oui
Output: ${enfant_corps_chaud} = 'yes'
```

**Strategy:**
1. Build a mapping of question labels to field names
2. Fuzzy match condition text against question labels
3. Replace with corresponding `${field_name}`

### 7. Accented Characters in Field Names

Remove accents when generating field names:

```
Question: "Température de l'enfant"
Field:    temperature_de_lenfant

Question: "A-t-il des problèmes à téter?"
Field:    a_t_il_des_problemes_a_teter
```

### 8. Numeric Fields Without Quotes

Numbers should not be quoted:

```
WRONG:  ${age} = '5'
RIGHT:  ${age} = 5

WRONG:  ${temperature} > '37.5'
RIGHT:  ${temperature} > 37.5
```

### 9. String Values Need Quotes

Text values must be quoted:

```
WRONG:  ${status} = active
RIGHT:  ${status} = 'active'

WRONG:  ${response} = yes
RIGHT:  ${response} = 'yes'
```

### 10. Implicit Boolean Conditions

Sometimes conditions are implied:

```
Input:  Si fièvre présente
Output: ${fievre} = 'yes'

Input:  Si pas de fièvre
Output: ${fievre} = 'no' or ${fievre} = ''
```

### 11. Handling "Autre" with Specify Field

When "Autre" is selected, often need to show a text field:

```
Input:  Si Plaintes = Autre
Output: ${plaintes} = 'autre'

# Or for multi-select:
Input:  Si Plaintes contient Autre
Output: selected(${plaintes}, 'autre')
```

### 12. Cascading Conditions

When field B depends on field A, and field C depends on field B:

```
Field A: Avez-vous un thermomètre? (yes/no)
Field B: Température (relevant: ${thermometre} = 'yes')
Field C: Fever warning (relevant: ${temperature} > 37.5)

# Field C implicitly depends on Field A through Field B
# If thermometer = 'no', temperature is empty, so fever warning won't show
```

### 13. Coalesce for Optional Fields

When a field might not exist:

```xpath
coalesce(${optional_field}, 0) > 5
coalesce(${optional_field}, '') != ''
```

---

## Conversion Algorithm

```
1. TOKENIZE condition text
   - Split on ET, OU, AND, OR
   - Identify comparison operators (=, >, <, >=, <=, !=)
   - Extract field references and values

2. MAP field references
   - Match condition text to question labels
   - Get corresponding field names
   - Handle fuzzy matching for slight variations

3. TRANSLATE values
   - Oui → 'yes'
   - Non → 'no'
   - Numbers: keep as-is (convert comma to period)
   - Text: wrap in quotes, slugify if needed

4. BUILD XPath
   - Replace French operators with XPath operators
   - Add ${} around field names
   - Add quotes around string values
   - Add parentheses for complex logic

5. VALIDATE
   - Check all referenced fields exist
   - Verify XPath syntax
   - Flag ambiguous references for user confirmation
```

---

## Quick Reference Card

| French Pattern | XPath Template |
|----------------|----------------|
| `Si X = Oui` | `${x} = 'yes'` |
| `Si X = Non` | `${x} = 'no'` |
| `Si X = [text]` | `${x} = 'text'` |
| `Si X > N` | `${x} > N` |
| `Si X < N` | `${x} < N` |
| `A ET B` | `(A) and (B)` |
| `A OU B` | `(A) or (B)` |
| `Si X contient Y` | `selected(${x}, 'y')` |
| `Si X est vide` | `${x} = ''` |
| `Si Age < 2 mois` | `${age_in_days} < 60` |
| `Si Age < 5 ans` | `${age_in_years} < 5` |

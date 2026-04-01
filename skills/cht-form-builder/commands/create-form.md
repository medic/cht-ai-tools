---
name: create-form
description: Create, update, or compare CHT XLSForm app forms from design documents or conversational input
arguments:
  - name: file
    description: Path to design Excel file (optional — starts conversational mode if omitted)
    required: false
  - name: sheet
    description: Sheet name in the design Excel (optional — lists sheets if omitted)
    required: false
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# /create-form Command

Generate CHT XLSForm application forms.

## Usage

```
/create-form                              # Start conversational mode
/create-form design.xlsx                  # Parse design, list sheets
/create-form design.xlsx "PEC - 5 ans"   # Parse specific sheet
/create-form --compare design.xlsx form.xlsx  # Compare design to form
```

## Prerequisites

This command must be run from a CHT config project directory containing `app_settings.json` and `forms/`.

## Execution

Load and follow the orchestrator skill at `${CLAUDE_PLUGIN_ROOT}/SKILL.md`.

If `$ARGUMENTS.file` is provided, use Flow A (Excel design).
If no arguments, use Flow B (conversational).
If `--compare` flag detected, use Flow D (compare).

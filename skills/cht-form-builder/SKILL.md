---
name: cht-form-builder
description: Generate CHT application forms from Excel designs or conversational input, with a local deployment UI. Parses design documents, infers smart calculate fields, auto-translates, and validates against the project context.
---

# CHT Form Builder Plugin

Generate CHT (Community Health Toolkit) XLSForm application forms from:
- **Excel design documents** — French/English design sheets with questions, types, conditions
- **Conversational input** — describe the form you need and answer follow-up questions

## Features

- **Project-aware**: reads contact-summary, tasks, existing forms to avoid conflicts and reuse patterns
- **Smart calculates**: infers intermediate calculate fields from design structure (group aggregation, condition deduplication, derived classification)
- **Auto-translate**: detects project languages and translates all labels
- **Validation hook**: catches structural, CHT-specific, and cross-project errors on write
- **Deployment UI**: localhost web page for deploying with cht-conf — credentials never touch the AI

## Commands

- `/create-form [design.xlsx] [sheet-name]` — create or update a form from a design document or conversational flow
- `/create-form --compare design.xlsx form.xlsx` — compare a design to an existing form
- `/deploy` — launch the local deployment UI

## Requirements

- Must be run from a CHT config project directory (has `app_settings.json` and `forms/`)
- Python 3.10+ (dependencies auto-managed by `uv run`)
- Node.js 18+ (for deployment server)
- `cht-conf` installed globally (`npm install -g cht-conf`)

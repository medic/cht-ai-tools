# CHT Form Builder

Generate CHT (Community Health Toolkit) XLSForm application forms from Excel design documents or conversational input.

## Overview

The form builder takes a form design — either an Excel document from a health program designer or a conversational description — and produces a complete, deployable CHT XLSForm. It analyzes the existing project context (languages, contact types, existing forms, tasks) to avoid conflicts and reuse patterns.

## Commands

### `/create-form`

Create, update, or compare CHT forms.

```
/create-form                              # Conversational mode — describe the form you need
/create-form design.xlsx                  # Parse an Excel design, list available sheets
/create-form design.xlsx "PEC - 5 ans"   # Parse a specific sheet and generate the form
/create-form --compare design.xlsx form.xlsx  # Compare a design to an existing form
```

### `/deploy`

Launch a local web UI for deploying forms and config to a CHT instance using cht-conf. Credentials are entered in the browser and never touch the AI context.

```
/deploy
```

## How It Works

The form builder uses a pipeline of four specialized agents:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Project    │    │   Design     │    │    Form      │    │  Translator  │
│  Analyzer    │───▶│   Parser     │───▶│  Generator   │───▶│              │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
 Reads project       Parses Excel        Converts to         Translates to
 context (langs,     design into          XLSForm with       all project
 contacts, forms,    structured JSON      smart calculates   languages
 tasks, targets)     (groups, fields,     and CHT patterns
                      conditions)
```

### 1. Project Analyzer

Runs `analyze-project.py` against the CHT config directory to extract:
- Project languages
- Contact types and hierarchy
- Existing forms and choice lists
- Task and target definitions
- Contact-summary context variables

### 2. Design Parser

Runs `parse-design-sheet.py` against the Excel design file to produce structured JSON with:
- Groups and sessions
- Field types, labels, and conditions (French/English)
- Choice lists with multi-column options
- Image URLs and metadata

### 3. Form Generator

Converts the parsed design into a complete XLSForm:
- Translates French conditions to XPath expressions
- Infers intermediate calculate fields (group aggregation, condition deduplication, derived classification)
- Generates `survey`, `choices`, and `settings` sheets
- Creates the accompanying `properties.json`
- Runs `generate-xlsform.py` to produce the final `.xlsx` file

### 4. Translator

Reviews and translates all form content:
- Scans source text for typos and inconsistencies
- Translates labels, hints, and choice options to all project languages
- Presents translations for user validation before applying

## Validation Hook

A prompt-based hook (`validate-xlsform`) automatically validates XLSForm files when written to `forms/app/`. It checks:

- **Structure** — 3 required sheets, inputs group, matched begin/end groups
- **CHT-specific** — standard calculate fields, age calculations, field references
- **Choice lists** — all `select_one`/`select_multiple` references resolve

## Deployment

The `/deploy` command starts a local Node.js server (zero dependencies) that:

1. Serves a web UI on `127.0.0.1`
2. Lists available forms with checkboxes for selective upload
3. Executes cht-conf commands from the project directory
4. Streams output via SSE (Server-Sent Events)
5. Auto-shuts down after 30 minutes of inactivity

## Requirements

| Requirement | Purpose |
|-------------|---------|
| CHT config directory | Must contain `app_settings.json` and `forms/` |
| Python 3.10+ | Scripts use `uv run` with PEP 723 inline dependencies — no manual install needed |
| Node.js 18+ | Deployment server |
| cht-conf | Global install: `npm install -g cht-conf` |

## File Structure

```
skills/cht-form-builder/
├── SKILL.md                          # Plugin entry point
├── agents/
│   ├── project-analyzer.md           # Extracts project context
│   ├── design-parser.md              # Parses Excel designs
│   ├── form-generator.md             # Generates XLSForm output
│   └── translator.md                 # Translates to project languages
├── commands/
│   ├── create-form.md                # /create-form command
│   └── deploy.md                     # /deploy command
├── hooks/
│   └── validate-xlsform.md           # Post-write XLSForm validation
├── scripts/
│   ├── analyze-project.py            # Project context extraction
│   ├── parse-design-sheet.py         # Excel design parser
│   ├── generate-xlsform.py           # XLSForm file generator
│   ├── parse-xlsform.py              # XLSForm reader (for compare mode)
│   ├── deploy-server.js              # Local deployment web server
│   └── detect-project-languages.sh   # Language detection helper
├── references/
│   ├── cht-forms.md                  # CHT app form structure
│   ├── xlsform-reference.md          # XLSForm column specs
│   ├── calculate-patterns.md         # Standard calculate templates
│   ├── condition-patterns.md         # French → XPath conversion
│   ├── properties-json.md            # Properties file format
│   └── design-format.md             # Excel design conventions
└── templates/
    └── deploy-ui.html                # Deployment web UI
```

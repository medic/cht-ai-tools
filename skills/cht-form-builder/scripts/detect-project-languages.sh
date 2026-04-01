#!/bin/bash
#
# detect-project-languages.sh
# Detects CHT project structure and extracts supported languages
#
# Usage: ./detect-project-languages.sh [project_path]
#        If no path provided, uses current directory
#

set -euo pipefail

# Use provided path or current directory
PROJECT_PATH="${1:-.}"

# Resolve to absolute path
PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd)" || {
    echo "PROJECT: no"
    echo "ERROR: Directory does not exist: $1"
    exit 1
}

# Check for CHT project indicators
APP_SETTINGS="$PROJECT_PATH/app_settings.json"
FORMS_DIR="$PROJECT_PATH/forms"
TASKS_FILE="$PROJECT_PATH/tasks.js"

is_cht_project="no"

# A CHT project should have at least app_settings.json and forms directory
if [[ -f "$APP_SETTINGS" ]] && [[ -d "$FORMS_DIR" ]]; then
    is_cht_project="yes"
fi

echo "PROJECT: $is_cht_project"

# If not a CHT project, provide hints and exit
if [[ "$is_cht_project" == "no" ]]; then
    echo "LANGUAGES: none"
    echo "FORMS: none"
    echo ""
    echo "# Missing CHT project indicators:"
    [[ ! -f "$APP_SETTINGS" ]] && echo "#   - app_settings.json not found"
    [[ ! -d "$FORMS_DIR" ]] && echo "#   - forms/ directory not found"
    exit 0
fi

# Extract languages from app_settings.json
# Languages are typically in locales array or locale property
LANGUAGES=""

if command -v jq &>/dev/null; then
    # Try to extract locales array first (CHT 4.x format)
    LANGUAGES=$(jq -r '.locales // [] | if type == "array" then map(if type == "object" then .code else . end) | join(", ") else "" end' "$APP_SETTINGS" 2>/dev/null || echo "")

    # If empty, try locale property (older format)
    if [[ -z "$LANGUAGES" ]]; then
        LANGUAGES=$(jq -r '.locale // ""' "$APP_SETTINGS" 2>/dev/null || echo "")
    fi

    # Also check for languages in translations object keys
    if [[ -z "$LANGUAGES" ]]; then
        LANGUAGES=$(jq -r '.translations // {} | keys | join(", ")' "$APP_SETTINGS" 2>/dev/null || echo "")
    fi
else
    # Fallback: use grep to find locale patterns
    # Look for "locales": [...] pattern
    LANGUAGES=$(grep -oP '"locales"\s*:\s*\[\s*\K[^\]]+' "$APP_SETTINGS" 2>/dev/null | tr -d '"' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | paste -sd', ' || echo "")

    # If empty, try single locale
    if [[ -z "$LANGUAGES" ]]; then
        LANGUAGES=$(grep -oP '"locale"\s*:\s*"\K[^"]+' "$APP_SETTINGS" 2>/dev/null || echo "")
    fi
fi

# Default to "not detected" if we couldn't find languages
if [[ -z "$LANGUAGES" ]]; then
    LANGUAGES="not detected"
fi

echo "LANGUAGES: $LANGUAGES"

# List forms in forms/app/ directory
APP_FORMS_DIR="$FORMS_DIR/app"
FORMS_LIST=""

if [[ -d "$APP_FORMS_DIR" ]]; then
    # Find .xml files and extract form names (without extension)
    FORMS_LIST=$(find "$APP_FORMS_DIR" -maxdepth 1 -name "*.xml" -type f 2>/dev/null | xargs -I{} basename {} .xml | sort | paste -sd', ' || echo "")

    # If no XML files, check for directories (some projects organize forms in subdirs)
    if [[ -z "$FORMS_LIST" ]]; then
        FORMS_LIST=$(find "$APP_FORMS_DIR" -maxdepth 1 -type d ! -name "app" 2>/dev/null | xargs -I{} basename {} | sort | paste -sd', ' || echo "")
    fi
fi

# Also check forms/contact/ for contact forms
CONTACT_FORMS_DIR="$FORMS_DIR/contact"
CONTACT_FORMS=""

if [[ -d "$CONTACT_FORMS_DIR" ]]; then
    CONTACT_FORMS=$(find "$CONTACT_FORMS_DIR" -maxdepth 2 -name "*.xml" -type f 2>/dev/null | while read -r f; do
        # Extract relative path from contact dir
        rel_path="${f#$CONTACT_FORMS_DIR/}"
        dir_name=$(dirname "$rel_path")
        if [[ "$dir_name" != "." ]]; then
            echo "contact:$dir_name"
        fi
    done | sort -u | paste -sd', ' || echo "")
fi

# Combine forms lists
if [[ -n "$FORMS_LIST" ]] && [[ -n "$CONTACT_FORMS" ]]; then
    FORMS_LIST="$FORMS_LIST, $CONTACT_FORMS"
elif [[ -n "$CONTACT_FORMS" ]]; then
    FORMS_LIST="$CONTACT_FORMS"
fi

if [[ -z "$FORMS_LIST" ]]; then
    FORMS_LIST="none"
fi

echo "FORMS: $FORMS_LIST"

# Additional project info
echo ""
echo "# Project details:"
echo "#   Path: $PROJECT_PATH"
[[ -f "$TASKS_FILE" ]] && echo "#   tasks.js: found" || echo "#   tasks.js: not found"
[[ -f "$PROJECT_PATH/targets.js" ]] && echo "#   targets.js: found"
[[ -f "$PROJECT_PATH/contact-summary.templated.js" ]] && echo "#   contact-summary: found"
[[ -d "$PROJECT_PATH/resources" ]] && echo "#   resources/: found"

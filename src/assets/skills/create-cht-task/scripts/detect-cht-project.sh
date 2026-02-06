#!/bin/bash
# Detect CHT project structure and list available forms
# Usage: ./detect-cht-project.sh [project_path]

PROJECT_PATH="${1:-.}"

echo "=== CHT Project Detection ==="
echo "Path: $(cd "$PROJECT_PATH" && pwd)"
echo ""

# Check for key CHT files
IS_CHT_PROJECT=false

if [[ -f "$PROJECT_PATH/tasks.js" ]] || [[ -f "$PROJECT_PATH/app_settings.json" ]] || [[ -d "$PROJECT_PATH/forms/app" ]]; then
    IS_CHT_PROJECT=true
fi

if [[ "$IS_CHT_PROJECT" == "false" ]]; then
    echo "STATUS: NOT a CHT project"
    echo ""
    echo "Missing CHT project indicators:"
    [[ ! -f "$PROJECT_PATH/tasks.js" ]] && echo "  - tasks.js"
    [[ ! -f "$PROJECT_PATH/app_settings.json" ]] && echo "  - app_settings.json"
    [[ ! -d "$PROJECT_PATH/forms/app" ]] && echo "  - forms/app/ directory"
    exit 1
fi

echo "STATUS: CHT project detected"
echo ""

# List existing tasks.js content
if [[ -f "$PROJECT_PATH/tasks.js" ]]; then
    echo "=== Existing Tasks (tasks.js) ==="
    # Extract task names using grep
    TASK_NAMES=$(grep -oE "name:\s*['\"]([^'\"]+)['\"]" "$PROJECT_PATH/tasks.js" | sed "s/name:\s*['\"]//g" | sed "s/['\"]//g")
    if [[ -n "$TASK_NAMES" ]]; then
        echo "$TASK_NAMES" | while read -r name; do
            echo "  - $name"
        done
    else
        echo "  (no tasks defined yet)"
    fi
    echo ""
else
    echo "=== tasks.js ==="
    echo "  File does not exist (will need to create)"
    echo ""
fi

# List app forms
echo "=== App Forms (forms/app/) ==="
if [[ -d "$PROJECT_PATH/forms/app" ]]; then
    FORMS=$(find "$PROJECT_PATH/forms/app" -maxdepth 1 -name "*.xlsx" -o -name "*.xml" 2>/dev/null | sort)
    if [[ -n "$FORMS" ]]; then
        echo "$FORMS" | while read -r form; do
            BASENAME=$(basename "$form")
            FORMNAME="${BASENAME%.*}"
            EXT="${BASENAME##*.}"
            echo "  - $FORMNAME ($EXT)"
        done
    else
        echo "  (no forms found)"
    fi
else
    echo "  Directory does not exist"
fi
echo ""

# List contact forms
echo "=== Contact Forms (forms/contact/) ==="
if [[ -d "$PROJECT_PATH/forms/contact" ]]; then
    CONTACT_FORMS=$(find "$PROJECT_PATH/forms/contact" -maxdepth 1 -name "*.xlsx" -o -name "*.xml" 2>/dev/null | sort)
    if [[ -n "$CONTACT_FORMS" ]]; then
        echo "$CONTACT_FORMS" | while read -r form; do
            BASENAME=$(basename "$form")
            FORMNAME="${BASENAME%.*}"
            echo "  - $FORMNAME"
        done
    else
        echo "  (no contact forms found)"
    fi
else
    echo "  Directory does not exist"
fi
echo ""

# Check for contact types in app_settings
echo "=== Contact Types ==="
if [[ -f "$PROJECT_PATH/app_settings.json" ]]; then
    # Try to extract contact_types
    CONTACT_TYPES=$(grep -oE '"id":\s*"[^"]+"' "$PROJECT_PATH/app_settings.json" 2>/dev/null | head -10 | sed 's/"id":\s*"//g' | sed 's/"//g')
    if [[ -n "$CONTACT_TYPES" ]]; then
        echo "  (check app_settings.json for full list)"
    fi
fi
# Default CHT types
echo "  Default types: district_hospital, health_center, clinic, person"
echo ""

# Check for resources.json (icons)
echo "=== Available Icons (resources.json) ==="
if [[ -f "$PROJECT_PATH/resources.json" ]]; then
    ICONS=$(grep -oE '"[^"]+"\s*:' "$PROJECT_PATH/resources.json" | sed 's/"//g' | sed 's/\s*://g' | head -20)
    if [[ -n "$ICONS" ]]; then
        echo "$ICONS" | while read -r icon; do
            echo "  - $icon"
        done
        COUNT=$(echo "$ICONS" | wc -l | tr -d ' ')
        [[ $COUNT -ge 20 ]] && echo "  ... (truncated, see resources.json for full list)"
    else
        echo "  (no icons defined)"
    fi
else
    echo "  File does not exist"
fi
echo ""

# Check for translations
echo "=== Translations ==="
if [[ -d "$PROJECT_PATH/translations" ]]; then
    ls -1 "$PROJECT_PATH/translations"/*.properties 2>/dev/null | while read -r file; do
        echo "  - $(basename "$file")"
    done
else
    echo "  No translations directory"
fi

echo ""
echo "=== Summary ==="
echo "Project is ready for task configuration."

#!/bin/bash
# CHT Format Hook - auto-formats CHT configuration files after writes
#
# This hook runs after the Write tool and lint-fixes the written file
# if it is a CHT config file and ESLint is available.

# Only run if we're in a CHT project
if [[ ! -f "package.json" ]] || ! grep -q "cht-conf" package.json 2>/dev/null; then
  exit 0
fi

# Read the file path that was just written from stdin JSON
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Resolve to basename for comparison
FILE_NAME=$(basename "$FILE_PATH")

# Only format known CHT config files
CHT_FILES=(tasks.js targets.js contact-summary.templated.js purge.js)
IS_CHT_FILE=false
for cht_file in "${CHT_FILES[@]}"; do
  if [[ "$FILE_NAME" == "$cht_file" ]]; then
    IS_CHT_FILE=true
    break
  fi
done

if [[ "$IS_CHT_FILE" != true ]]; then
  exit 0
fi

# Use ESLint --fix if available
if command -v npx &> /dev/null && [[ -f "node_modules/.bin/eslint" ]]; then
  npx eslint --fix "$FILE_PATH" 2>/dev/null
fi

exit 0

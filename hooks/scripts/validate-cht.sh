#!/bin/bash
# CHT Validation Hook - validates CHT configuration files before operations
#
# This hook runs before Bash commands to validate CHT config syntax

# Only run validation if we're in a CHT project
if [[ ! -f "package.json" ]] || ! grep -q "cht-conf" package.json 2>/dev/null; then
  exit 0
fi

CHT_FILES=(tasks.js targets.js contact-summary.templated.js purge.js)

for file in "${CHT_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    if ! node --check "$file" 2>/dev/null; then
      echo "⚠️  Warning: $file has syntax errors"
    fi
  fi
done

exit 0

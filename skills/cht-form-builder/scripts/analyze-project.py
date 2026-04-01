#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["openpyxl"]
# ///
"""
CHT Project Analyzer - Read a CHT config directory and output complete project context as JSON.

Extracts languages, contact types, roles, contact summary context variables,
task definitions, existing forms, choice lists, icons, and translation key counts.

Usage:
    uv run scripts/analyze-project.py /path/to/cht-config --pretty
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Import the sibling parse_xlsform module (via symlink parse_xlsform.py -> parse-xlsform.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_xlsform import parse_xlsform


def extract_languages(app_settings: dict) -> tuple[list[str], str]:
    """
    Extract languages and default language from app_settings.json.

    Tries in order:
    1. locales array (objects with .code or plain strings)
    2. locale property (single default language)
    3. translations keys
    """
    languages = []

    # Try locales array first
    locales = app_settings.get("locales", [])
    if locales:
        for loc in locales:
            if isinstance(loc, dict):
                code = loc.get("code", "")
            elif isinstance(loc, str):
                code = loc
            else:
                continue
            if code and code not in languages:
                languages.append(code)

    # Fallback: locale property
    if not languages:
        locale = app_settings.get("locale", "")
        if locale:
            languages = [locale]

    # Fallback: translations keys
    if not languages:
        translations = app_settings.get("translations", {})
        if isinstance(translations, dict):
            languages = sorted(translations.keys())

    # Default language
    default_language = app_settings.get("locale", "")
    if not default_language and languages:
        default_language = languages[0]

    return languages, default_language


def extract_contact_types(app_settings: dict) -> tuple[list[str], list[dict], list[str]]:
    """
    Extract contact type IDs, detail objects, and person type IDs.
    """
    raw_types = app_settings.get("contact_types", [])
    ids = []
    details = []
    person_types = []

    for ct in raw_types:
        if not isinstance(ct, dict):
            continue
        ct_id = ct.get("id", "")
        if not ct_id:
            continue
        ids.append(ct_id)

        detail = {
            "id": ct_id,
            "person": ct.get("person", False),
            "parents": ct.get("parents", []),
            "name_key": ct.get("name_key", ""),
        }
        details.append(detail)

        if ct.get("person", False):
            person_types.append(ct_id)

    return ids, details, person_types


def extract_roles(app_settings: dict) -> list[str]:
    """Extract role keys from roles object."""
    roles = app_settings.get("roles", {})
    if isinstance(roles, dict):
        return sorted(roles.keys())
    return []


def extract_contact_summary_context(filepath: Path) -> tuple[list[str], list[str]]:
    """
    Parse contact-summary.templated.js for context variable names and card labels.

    Handles:
    - const context = { key1: ..., key2: ..., };
    - context['key'] = ...;
    - context.key = ...;
    - label: 'card.xxx.label'
    """
    if not filepath.exists():
        return [], []

    content = filepath.read_text(encoding="utf-8", errors="replace")

    context_vars = []

    # 1. Extract keys from `const context = { ... }` using brace-counting
    # This handles nested braces in arrow functions and object literals
    start_match = re.search(r'const\s+context\s*=\s*\{', content)
    if start_match:
        depth = 1
        pos = start_match.end()
        while pos < len(content) and depth > 0:
            if content[pos] == '{':
                depth += 1
            elif content[pos] == '}':
                depth -= 1
            pos += 1
        obj_body = content[start_match.end():pos - 1]
        # Match top-level keys: word at start of a property (before colon)
        for key_match in re.finditer(r'^\s*(\w+)\s*:', obj_body, re.MULTILINE):
            key = key_match.group(1)
            if key not in context_vars:
                context_vars.append(key)

    # 2. Extract context['key'] = ...;
    for m in re.finditer(r"context\[\s*['\"](\w+)['\"]\s*\]", content):
        key = m.group(1)
        if key not in context_vars:
            context_vars.append(key)

    # 3. Extract context.key = ...;
    for m in re.finditer(r"context\.(\w+)\s*=", content):
        key = m.group(1)
        if key not in context_vars:
            context_vars.append(key)

    # 4. Extract context[`template_${var}`] patterns (dynamic keys - just note them as template patterns)
    # We skip these as they are dynamic and can't be statically resolved

    # Extract card labels
    cards = []
    for m in re.finditer(r"label\s*:\s*['\"]([^'\"]*?card\.[^'\"]*?)['\"]", content):
        label = m.group(1)
        if label not in cards:
            cards.append(label)

    return context_vars, cards


def extract_task_definitions(filepath: Path) -> list[dict]:
    """
    Parse tasks.js for task definitions with name and form fields.

    Handles:
    - name: 'task.xxx' (literal name field)
    - form: FORMS.XXX (action form in actions array)
    - actionForm: FORMS.XXX (in defaultedTaskTemplate calls)
    - sourceForm: FORMS.XXX or [FORMS.X, FORMS.Y]
    """
    if not filepath.exists():
        return []

    content = filepath.read_text(encoding="utf-8", errors="replace")
    tasks = []

    # Strategy 1: Find literal `name:` and associated `form:` in the same block
    # This catches tasks defined directly (not via defaultedTaskTemplate)
    for m in re.finditer(r"name\s*:\s*['\"]([^'\"]+)['\"]", content):
        task_name = m.group(1)
        # Look nearby for form: in actions — limit to next task's name: to avoid cross-boundary matches
        next_name = re.search(r"name\s*:\s*['\"]", content[m.end():])
        window_end = m.end() + next_name.start() if next_name else m.start() + 2000
        search_area = content[m.start():min(window_end, m.start() + 2000)]
        form_match = re.search(r"form\s*:\s*(?:FORMS\.)?(\w+)", search_area)
        form_name = form_match.group(1) if form_match else None
        if form_name and form_name.startswith("FORMS"):
            form_name = None
        tasks.append({"name": task_name, "form": form_name})

    # Strategy 2: Find defaultedTaskTemplate calls with actionForm
    for m in re.finditer(r"defaultedTaskTemplate\s*\(\s*\{(.*?)\}\s*\)", content, re.DOTALL):
        block = m.group(1)

        # Extract actionForm
        action_match = re.search(r"actionForm\s*:\s*(?:FORMS\.)?(\w+)", block)
        action_form = action_match.group(1) if action_match else None

        # Extract sourceForm (could be array or single)
        source_match = re.search(r"sourceForm\s*:\s*\[([^\]]+)\]", block)
        if source_match:
            source_forms = re.findall(r"(?:FORMS\.)?(\w+)", source_match.group(1))
        else:
            source_match = re.search(r"sourceForm\s*:\s*(?:FORMS\.)?(\w+)", block)
            source_forms = [source_match.group(1)] if source_match else []

        # Extract name if present
        name_match = re.search(r"name\s*:\s*['\"]([^'\"]+)['\"]", block)

        # Check if this task was already captured by strategy 1
        if name_match:
            task_name = name_match.group(1)
            # Already captured, skip
            if any(t["name"] == task_name for t in tasks):
                continue
        else:
            # Generate name like the taskName function does:
            # source_yields_actionForm
            if source_forms and action_form:
                source_str = "_".join(source_forms)
                task_name = f"{source_str}_yields_{action_form}"
            else:
                task_name = None

        if task_name:
            tasks.append({"name": task_name, "form": action_form})

    # Deduplicate by name
    seen = set()
    unique_tasks = []
    for t in tasks:
        if t["name"] and t["name"] not in seen:
            seen.add(t["name"])
            unique_tasks.append(t)

    return unique_tasks


def extract_existing_forms(forms_dir: Path) -> tuple[list[str], list[str], dict[str, list[str]]]:
    """
    Extract form names, field names, and choice lists from all xlsx files in forms/app/.

    Skips temp files (~$xxx.xlsx).
    Returns (form_names, field_names, choice_lists).
    """
    form_names = []
    all_field_names = set()
    all_choice_lists: dict[str, list[str]] = {}

    if not forms_dir.exists():
        return [], [], {}

    xlsx_files = sorted(forms_dir.glob("*.xlsx"))

    for xlsx_path in xlsx_files:
        # Skip temp files
        if xlsx_path.name.startswith("~$"):
            continue

        form_name = xlsx_path.stem
        form_names.append(form_name)

        try:
            parsed = parse_xlsform(str(xlsx_path))

            # Collect field names
            for q in parsed.get("questions", []):
                name = q.get("name", "")
                if name:
                    all_field_names.add(name)

            # Collect choice lists
            for list_name, choices in parsed.get("choice_lists", {}).items():
                choice_names = [c.get("name", "") for c in choices if c.get("name")]
                if choice_names:
                    if list_name not in all_choice_lists:
                        all_choice_lists[list_name] = []
                    for cn in choice_names:
                        if cn not in all_choice_lists[list_name]:
                            all_choice_lists[list_name].append(cn)

        except Exception as e:
            print(f"Warning: Failed to parse {xlsx_path.name}: {e}", file=sys.stderr)

    return sorted(form_names), sorted(all_field_names), dict(sorted(all_choice_lists.items()))


def extract_icons(filepath: Path) -> list[str]:
    """Extract sorted list of icon keys from resources.json."""
    if not filepath.exists():
        return []

    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return sorted(data.keys())
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: Failed to parse resources.json: {e}", file=sys.stderr)

    return []


def count_translation_keys(translations_dir: Path) -> int:
    """Count unique keys across all messages-*.properties files."""
    if not translations_dir.exists():
        return 0

    all_keys = set()
    for prop_file in sorted(translations_dir.glob("messages-*.properties")):
        try:
            content = prop_file.read_text(encoding="utf-8", errors="replace")
            for line in content.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("!"):
                    continue
                # Properties format: key = value or key: value
                eq_pos = line.find("=")
                colon_pos = line.find(":")
                if eq_pos == -1 and colon_pos == -1:
                    continue
                if eq_pos == -1:
                    sep_pos = colon_pos
                elif colon_pos == -1:
                    sep_pos = eq_pos
                else:
                    sep_pos = min(eq_pos, colon_pos)
                key = line[:sep_pos].strip()
                if key:
                    all_keys.add(key)
        except OSError as e:
            print(f"Warning: Failed to read {prop_file.name}: {e}", file=sys.stderr)

    return len(all_keys)


def analyze_project(project_path: str) -> dict[str, Any]:
    """
    Analyze a CHT config directory and return the complete project context.
    """
    root = Path(project_path).resolve()

    # Key file paths
    app_settings_path = root / "app_settings.json"
    contact_summary_path = root / "contact-summary.templated.js"
    tasks_path = root / "tasks.js"
    targets_path = root / "targets.js"
    resources_path = root / "resources.json"
    translations_dir = root / "translations"
    forms_app_dir = root / "forms" / "app"

    # Check if this is a CHT project
    is_cht = app_settings_path.exists()

    result: dict[str, Any] = {
        "project_path": str(root),
        "is_cht_project": is_cht,
    }

    # Project files existence flags
    result["project_files"] = {
        "app_settings": app_settings_path.exists(),
        "contact_summary": contact_summary_path.exists(),
        "tasks": tasks_path.exists(),
        "targets": targets_path.exists(),
        "resources": resources_path.exists(),
        "translations_dir": translations_dir.exists() and translations_dir.is_dir(),
    }

    # Parse app_settings.json
    app_settings: dict = {}
    if app_settings_path.exists():
        try:
            app_settings = json.loads(app_settings_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: Failed to parse app_settings.json: {e}", file=sys.stderr)

    # Languages
    languages, default_language = extract_languages(app_settings)
    result["languages"] = languages
    result["default_language"] = default_language

    # Contact types
    contact_ids, contact_details, person_types = extract_contact_types(app_settings)
    result["contact_types"] = contact_ids
    result["contact_types_detail"] = contact_details
    result["person_types"] = person_types

    # Roles
    result["roles"] = extract_roles(app_settings)

    # Contact summary context and cards
    context_vars, cards = extract_contact_summary_context(contact_summary_path)
    result["contact_summary_context"] = context_vars
    result["contact_summary_cards"] = cards

    # Task definitions
    result["task_definitions"] = extract_task_definitions(tasks_path)

    # Existing forms, field names, and choice lists
    form_names, field_names, choice_lists = extract_existing_forms(forms_app_dir)
    result["existing_forms"] = form_names
    result["existing_field_names"] = field_names
    result["existing_choice_lists"] = choice_lists

    # Icons
    result["icons"] = extract_icons(resources_path)

    # Translation keys count
    result["translation_keys_count"] = count_translation_keys(translations_dir)

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Analyze a CHT config directory and output project context as JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example usage:
    uv run scripts/analyze-project.py /path/to/config --pretty
    uv run scripts/analyze-project.py . | jq '.contact_types'
        """,
    )
    parser.add_argument(
        "project_path",
        nargs="?",
        default=".",
        help="Path to the CHT config directory (default: current directory)",
    )
    parser.add_argument(
        "--pretty",
        "-p",
        action="store_true",
        help="Pretty-print JSON output with indentation",
    )

    args = parser.parse_args()

    try:
        result = analyze_project(args.project_path)

        if args.pretty:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(f"Error analyzing project: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

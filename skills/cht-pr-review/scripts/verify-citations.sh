#!/usr/bin/env bash
#
# Stop-hook check: every `file:line` citation in a review report must resolve
# against the tree the review ran over.
#
# Reads the Stop payload on stdin and takes the report from
# `last_assistant_message`, so it never parses the transcript. On an unresolved
# citation it exits 2 and Claude Code hands the stderr text back as the reason
# to keep working, so the report is corrected before it is final.
#
# Exit codes follow the hook contract: 2 sends the report back, 0 accepts it,
# and anything else is a non-blocking error whose first stderr line reaches the
# transcript. A check that could not run exits 1.

set -uo pipefail
export LC_ALL=C

bail() {
  echo "cht-pr-review citation check did not run: $*" >&2
  exit 1
}

input="$(cat)"

command -v jq >/dev/null 2>&1 || bail "jq is not on PATH"
command -v git >/dev/null 2>&1 || bail "git is not on PATH"

report="$(jq -r '.last_assistant_message // ""' <<<"$input" 2>/dev/null)" \
  || bail "the hook payload was not readable JSON"

grep -qaE '^#{1,6}[[:space:]]+Requirements[[:space:]]*$' <<<"$report" || exit 0

root="$(git rev-parse --show-toplevel 2>/dev/null)"
[[ -n "$root" ]] || root="$PWD"

citations="$(
  sed -E 's#[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]<>)"]*##g' <<<"$report" \
    | tr -c 'A-Za-z0-9._@+/:-' '\n' \
    | sed -E 's/[.,;:]+$//' \
    | grep -aE '^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*:[0-9]+(-[0-9]+)?$' \
    | grep -aE '[/.]' \
    | sort -u
)"

[[ -n "$citations" ]] || exit 0

problems=()
while IFS= read -r citation; do
  path="${citation%:*}"
  span="${citation##*:}"
  first="${span%%-*}"
  last="${span##*-}"

  if [[ ! -f "${root}/${path}" ]]; then
    problems+=("${citation} — no such file")
    continue
  fi

  total="$(awk 'END{print NR}' "${root}/${path}" 2>/dev/null)"
  [[ "$total" =~ ^[0-9]+$ ]] || total=0

  # Longer than any real file, and past what arithmetic should be handed.
  if (( ${#first} > 9 || ${#last} > 9 )); then
    problems+=("${citation} — line number is not plausible; file has ${total} lines")
  elif (( first < 1 || first > total || last > total )); then
    problems+=("${citation} — file has ${total} lines")
  elif (( last < first )); then
    problems+=("${citation} — the range runs backwards")
  fi
done <<<"$citations"

(( ${#problems[@]} == 0 )) && exit 0

# A report the agent cannot fix is not blocked forever: Claude Code overrides
# the hook and ends the turn after 8 consecutive blocks.
{
  echo "Citation check: these \`file:line\` citations in the report do not resolve against ${root}:"
  echo
  printf '  - %s\n' "${problems[@]}"
  echo
  echo "Re-locate each one: read the file and cite the line that actually supports the claim."
  echo "Do not settle this by deleting the citation, softening the wording, or moving the item"
  echo "to \"Pending verification\" — a claim with no line behind it is a wrong finding, so drop"
  echo "the finding itself rather than just its citation. Then output the corrected report in full."
} >&2
exit 2

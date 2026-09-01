#!/usr/bin/env bash
#
# Gather the stated intent for a pull request: its title, description and human
# comments, plus the same for every issue it references.
#
# Usage: pr-context.sh [pr-number]
#   With no argument, resolves the PR from the current branch.

set -euo pipefail

readonly IGNORED_USERS=(
  'github-actions'
)

die() {
  echo "pr-context.sh: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "the gh CLI is not on PATH"
command -v jq >/dev/null 2>&1 || die "jq is not on PATH"

gh_err="$(mktemp)"
trap 'rm -f "$gh_err"' EXIT
gh_error() { tr '\n' ' ' <"$gh_err"; }

ignored_json="$(jq -cn '$ARGS.positional' --args -- "${IGNORED_USERS[@]}")"
readonly ignored_json
readonly JQ_DROP_IGNORED='
  def drop_ignored:
    ((.author.login // "") | sub("\\[bot\\]$"; "")) as $login
    | select(($ignored | index($login)) == null);
'

pr="${1:-}"
[[ -z "$pr" || "$pr" =~ ^[0-9]+$ ]] || die "not a PR number: '$pr'"

# $pr is unquoted so that no argument leaves gh to resolve the current branch; it is either empty or digits.
pr_json="$(gh pr view $pr --json number,id,title,baseRefName,headRefOid,url,body,comments,reviews,closingIssuesReferences 2>"$gh_err")" \
  || die "could not read PR ${pr:+#}${pr:-for the current branch}: $(gh_error)"
pr="$(jq -r .number <<<"$pr_json")"

print_body_and_comments() {
  local json="$1"
  echo "--- description ---"
  jq -r 'if (.body // "") == "" then "(no description)" else .body end' <<<"$json"
  echo "--- comments ---"
  jq -r --argjson ignored "$ignored_json" "$JQ_DROP_IGNORED"'[ (.comments // [])[]
    | drop_ignored
    | "[\(.author.login // "deleted-user")] \(.body // "")" ]
    | if length == 0 then "(no comments)" else .[] end' <<<"$json"
}

echo "=== PR #${pr} ==="
jq -r '"title: \(.title)\nbase:  \(.baseRefName)\nhead:  \(.headRefOid)"' <<<"$pr_json"
print_body_and_comments "$pr_json"

# `gh pr view --json comments` returns only issue-style comments; the review bodies and the inline threads on the diff
# have to be asked for separately.
echo "--- reviews ---"
jq -r --argjson ignored "$ignored_json" "$JQ_DROP_IGNORED"'[ (.reviews // [])[]
  | drop_ignored
  | select((.body // "") != "")
  | "[\(.author.login // "deleted-user")] (\(.state))\n\(.body)" ]
  | if length == 0 then "(no reviews)" else .[] end' <<<"$pr_json"

# Threads come from GraphQL rather than /pulls/N/comments: only GraphQL reports
# whether a thread was resolved or has gone stale, and it groups replies.
echo "--- inline review comments ---"
if threads_json="$(gh api graphql -F id="$(jq -r .id <<<"$pr_json")" -f query='
  query($id:ID!) {
    node(id:$id) {
      ... on PullRequest {
        reviewThreads(first:100) {
          pageInfo { hasNextPage }
          nodes {
            isResolved isOutdated path line originalLine
            comments(first:50) {
              pageInfo { hasNextPage }
              nodes { author { login } body } } } } } } }' 2>"$gh_err")"; then
  jq -r --argjson ignored "$ignored_json" "$JQ_DROP_IGNORED"'
    (.data.node.reviewThreads // null) as $rt
    | if $rt == null then
        ["(could not be read: \((.errors // []) | map(.message) | join("; ")
           | if . == "" then "unexpected response" else . end))"]
      else
        [ $rt.nodes[]
          | { loc: "\(.path):\(.line // .originalLine // "?")",
              status: ([ (if .isResolved then "resolved" else "unresolved" end),
                         (if .isOutdated then "outdated" else empty end) ] | join(", ")),
              truncated: .comments.pageInfo.hasNextPage,
              comments: [ .comments.nodes[]
                          | drop_ignored
                          | "  [\(.author.login // "deleted-user")] \(.body)" ] }
          | select((.comments | length) > 0)
          | "\(.loc) (\(.status))\(if .truncated then " [further replies not shown]" else "" end)\n\(.comments | join("\n"))" ] as $t
        | if ($t | length) == 0 then ["(no inline review comments)"]
          else ["(outdated: the code the thread points at has since changed. resolved: the thread was marked resolved. Either can mean the point was already addressed; neither is proof.)"]
               + (if $rt.pageInfo.hasNextPage then ["(warning: this PR has more than 100 review threads; only the first 100 are shown.)"] else [] end)
               + $t
          end
      end
    | .[]' <<<"$threads_json"
else
  echo "(could not be read: $(gh_error))"
fi

closing_urls="$(jq -r '(.closingIssuesReferences // [])[].url' <<<"$pr_json")" \
  || die "could not read the issue references of PR #${pr}"

repo_url="$(jq -r '.url | sub("/pull/[0-9]+$"; "")' <<<"$pr_json")"

issues=()
if [[ -n "$closing_urls" ]]; then
  mapfile -t issues <<<"$closing_urls"
fi

title_num="$(jq -r '(.title // "") | capture("^\\S+\\(#(?<num>[0-9]+)\\)!?:") // {} | .num // empty' <<<"$pr_json")"
if [[ -n "$title_num" ]] && ! grep -qxF "${repo_url}/issues/${title_num}" <<<"$closing_urls"; then
  nwo="${repo_url#*://*/}"
  [[ "$nwo" =~ ^[^/]+/[^/]+$ ]] || die "could not read the repository from the URL of PR #${pr}"
  if ! kind="$(gh api "repos/${nwo}/issues/${title_num}" \
      --jq 'if .pull_request then "pr" else "issue" end' 2>"$gh_err")"; then
    echo "--- warning ---"
    echo "#${title_num}, from the title, could not be read: $(gh_error)"
    echo "It is included below without confirming that it is an issue rather than"
    echo "a pull request; weigh it accordingly and say so in the report."
    issues+=("${repo_url}/issues/${title_num}")
  elif [[ "$kind" == "pr" ]]; then
    echo "--- warning ---"
    echo "#${title_num}, from the title, is a pull request, not an issue. It is"
    echo "ignored: it is not a statement of intent for PR #${pr}. Say so in the report."
  else
    issues+=("${repo_url}/issues/${title_num}")
  fi
fi

if (( ${#issues[@]} == 0 )); then
  echo "--- linked issues: none ---"
  echo "No issue is referenced. The PR title and description are the sole"
  echo "statement of intent; say so explicitly in the report."
  exit 0
fi

echo "--- linked issues ---"
for url in "${issues[@]}"; do
  echo "=== issue ${url} ==="
  if ! issue_json="$(gh issue view "$url" --json title,body,comments 2>"$gh_err")"; then
    echo "(could not be read: $(gh_error))"
    continue
  fi
  jq -r '"title: \(.title)"' <<<"$issue_json"
  print_body_and_comments "$issue_json"
done

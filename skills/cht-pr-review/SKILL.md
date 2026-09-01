---
name: cht-pr-review
description: Review a pull request to confirm if it delivers what its linked issue and its own description promise. Checks requirement-by-requirement delivery, undisclosed changes, and whether an existing pattern in the repo solves it better. Use when asked whether a PR addresses its issue, matches its description, or could be solved a better way. Does not review code correctness or style. Requires the `gh` CLI and `jq`.
argument-hint: "[pr-number]"
# Keep these tools synced with what is configured in the CI workflow jobs using this skill
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(${CLAUDE_SKILL_DIR}/scripts/pr-context.sh:*)
  - Bash(${CLAUDE_SKILL_DIR}/scripts/pr-diff.sh:*)
disallowed-tools:
  - Edit
  - Write
  - NotebookEdit
---

# PR review: completeness

Review whether a pull request completely delivers what it claims to deliver.

This is **not** a code-quality review. Do not report style issues, nitpicks, or bugs here unless they mean a stated requirement is not actually met.

## 0. Gather the stated intent

```
${CLAUDE_SKILL_DIR}/scripts/pr-context.sh <pr>
```

Pass no argument to resolve the PR from the current branch. If the script exits non-zero, stop and report why rather than reviewing an arbitrary PR. Everything below refers to that PR as `<pr>`.

## 1. Restate the requirements

Write out the concrete requirements from those sources as a bullet list, in your own words, including sub-tasks and acceptance criteria.

Derive a requirement only from a statement about **behaviour** — what the code will do, or an acceptance criterion. Rationale and motivation ("this is faster", "this makes batch jobs possible") are not requirements.

Requirements come from the issue and the PR description only. Reviewer feedback — the `reviews` and `inline review comments` sections — is context, not a source of requirements: use it to clarify a requirement you already have, and in sections 4 and 5, but never turn a review comment into a bullet of its own. A thread marked `resolved` or `outdated` may already have been dealt with; treat neither marker as proof either way, and do not report an unresolved thread as a missing requirement.

## 2. Read the change, then follow it out of the diff

```
${CLAUDE_SKILL_DIR}/scripts/pr-diff.sh <pr>
```

It prints the patch. Generated files still appear by path, but their patch body is replaced by a note — an undisclosed change to one of them is still a finding. Its `diff --git` headers are the complete list of changed files, and the only file list you can obtain.

- Then read and search the working tree to follow the code **outward**: registration sites, exports, barrel files, command tables, call sites, and anything the new code must be wired into in order to actually run.
- A requirement counts as delivered only if the whole path from user entrypoint to new code is complete. New code that is never registered, exported, or called delivers nothing, even when it is correct in isolation.
- Trace only requirements that add user-facing surface (a command, endpoint, export, menu item), and name the registration site in the report. Reach for `Grep` before `Read`, and stop at the first site that proves the path rather than mapping the whole call graph.
- Where a requirement's delivery depends on a library or framework **default** rather than on code in the diff, do not assert the default from memory. Either cite documentation for it, or put the requirement in **Pending verification** and name the default you could not confirm.

## 3. Bucket every requirement

Put each requirement from section 1 into exactly one of these three buckets:

- **Delivered** — cite the `file:line` that satisfies it
- **Not delivered** — say what is missing
- **Pending verification** — a requirement whose delivery cannot be settled by reading code alone (e.g. behaviour against a live CouchDB, output rendering in a real terminal)

Then, separately, list **Preconditions to confirm**: operational facts the change depends on that are not requirements and belong to no bucket — a secret or environment variable that must exist, an external binary or service that must be reachable, a model or API version that must still be valid. These are a checklist for whoever merges, never folded into the counts above.

## 4. Undisclosed changes

Does the PR change anything its description never mentions? Report both directions, but this one matters most: an unmentioned change is the finding a human reviewer is most likely to miss. Do not include changes supporting a stated requirement (even if those changes were not explicitly mentioned).

Do not limit this to source files. Walk the full file list from the `diff --git` headers in section 2, including the files whose patch was excluded.

## 5. Better approach

Does an existing module, helper, or established pattern in this repo already solve this, or could it be updated to solve it better (more efficiently/simply)? Cite it by path.

"No better approach found" is a correct and expected answer — do not invent hypothetical designs to fill space.

## Output

Report sections 3, 4, and 5 under the headings "Requirements", "Undisclosed Changes", and "Alternative Approaches".

One line per item, in this shape:

- **Delivered** — <requirement> — `path/to/file.js:42`
- **Not delivered** — <requirement> — <what is missing>
- **Pending verification** — <requirement> — <what would settle it>

At most one sentence beyond the citation. Cite `file:line` for every claim. If there is nothing to report for a section, write "None" and nothing else.

No preamble, no closing summary, no overall verdict. Do not restate a requirement's rationale, explain why a citation satisfies it, or describe what was examined.

Use GitHub flavored Markdown. Write impersonally - report what the code does, never narrating yourself ("I traced…", "I confirmed…").

Return the report as your response and stop there. If you could not establish the PR's intent (section 0 or 1), say so plainly as the report.

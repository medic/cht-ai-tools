---
description: Review a pull request to confirm if it delivers what its linked issue and its own description promise. 
---

Invoke the `cht-pr-review` skill to review a pull request in a CHT project.

Checks requirement-by-requirement delivery, undisclosed changes, and whether an existing pattern in the repo solves it better. Use when asked whether a PR addresses its issue, matches its description, or could be solved a better way. Does not review code correctness or style. Requires the `gh` CLI and `jq`. Assumes the current working tree is at the head of the PR to be reviewed.

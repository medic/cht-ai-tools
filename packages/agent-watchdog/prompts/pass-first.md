Project: {{project_url}}
Run date: {{date}}
Analysis pass {{pass}} for this project.

Below are today's candidates (raised by code from the reviewed thresholds) and the computed
changes for every metric collected for this project. Examine each candidate: decide whether it is
worth a human's attention today, why it matters now, and what to check first. Use the tools to
confirm meaning, inspect series, match pattern cards and check history when it helps.

## Candidates

{{candidates}}

## Computed changes

{{changes}}

A change with `aggregate: increase` compares a counter's increase over each window, not its level; `restarts`
counts uptime resets in the current window; `excluded` metrics raise no candidate.

## Feedback on earlier briefs for this project

{{feedback}}

## Firing alerts for this project

{{alerts}}

## Instructions

- Emit one item per finding, each citing the candidate ids that support it.
- Quote only computed values in `evidence`; use the metric key exactly as given.
- Cite the window that matters first in `evidence`: the dashboard link is built from it by code.
- List every examined candidate you did not surface in `not_selected` with a reason.
- Leave `changes` empty on the first pass. Set `converged` to false.
- An item that explains a firing alert should say so in `why_now` and name the rule; never raise an item
  only because an alert fires, the computed changes must support it.

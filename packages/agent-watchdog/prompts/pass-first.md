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

## Feedback on earlier briefs for this project

{{feedback}}

## Firing alerts for this project

{{alerts}}

## Instructions

- Emit one item per finding, each citing the candidate ids that support it.
- Quote only computed values in `evidence`; use the metric key exactly as given.
- Set `dashboard_ref` to the dashboard uid and panel id the metric came from, with the window
  you want the reader to see.
- List every examined candidate you did not surface in `not_selected` with a reason.
- Leave `changes` empty on the first pass. Set `converged` to false.
- An item that explains a firing alert should say so in `why_now` and name the rule; never raise an item
  only because an alert fires, the computed changes must support it.

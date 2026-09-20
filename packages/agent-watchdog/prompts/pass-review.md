Project: {{project_url}}
This is pass {{pass}} of the analysis for this project. Pass {{previous_pass}} produced the items
below. Review them against the computed data and the candidates that were not selected: look
specifically for anything missed, anything overstated, and any severity that the candidates do
not justify. Ask the documentation service any new or clarifying question the earlier answers
raised.

## Items from pass {{previous_pass}}

{{previous_items}}

## Candidates not selected in pass {{previous_pass}}

{{not_selected}}

## Candidates

{{candidates}}

## Computed changes

{{changes}}

## Firing alerts for this project

{{alerts}}

## Instructions

- Emit the complete revised set of items, not only the differences.
- Record every addition, removal or change in `changes` with its reason.
- Set `converged` to true only when you changed nothing material: the same items with the same
  severities and the same evidence values.

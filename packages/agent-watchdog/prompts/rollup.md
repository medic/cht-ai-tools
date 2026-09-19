Run date: {{date}}
You are writing today's brief for the CHT Watchdog Slack channel read by Medic's technical
operations staff. Below are the accepted items across all projects, ranked by code, with the
counts of what was checked and the feedback and memory that shaped the ranking.

## Ranked items

{{items}}

## What was checked

{{checked}}

## Expected-load context

{{expected_load_notice}}

## Reference sources

{{reference_notice}}

## Feedback and memory

{{feedback}}

{{memory}}

## Instructions

- Write one headline and at most three bullets, one per item in rank order, each at most two
  lines of at most 120 characters. Metric names as recorded, values with units and the comparison
  window, dashboard and panel names as they appear in the watchdog, PromQL only inside backticks
  and only when it helps the reader confirm.
- Quote only values that appear in the items' evidence. Compose no URLs.
- Put every accepted item id in `thread_order`, highest rank first; the first three must be the
  bullets.
- In `memory_update.replace_with`, return the full memory text if something durable was learned
  today, otherwise null. Stay within the cap you were told.
- Propose skill, prompt or threshold changes only when today's evidence supports them, in
  pattern-level terms, without project hostnames or personal names.

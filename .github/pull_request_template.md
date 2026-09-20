## Summary

<!-- What changes and why; link the issue. Commit subjects follow `type(#issue): subject`. -->

## Checklist

- [ ] Lint is clean and unit tests pass with coverage no lower than `main`.
- [ ] `AGENTS.md` and `README.md` of the affected package reflect any changed behaviour.
- [ ] New dependencies are justified in the package's README dependency table.

### For `packages/agent-watchdog` changes

- [ ] Prompt, skill, schema or analysis change: the `agent-watchdog replay` comparison (findings before and after
      across the fixture set) is attached below, and `npm run replay:eval` passes.
- [ ] Nothing under `prompts/`, `skill/`, `schema/`, `agent/` or the policy files is written by a run.
- [ ] Contracts under `specs/001-watchdog-slack-loop/contracts/` were updated for any change to the environment
      variables, mounted files, run directory, Slack payload, exit codes or container image.
- [ ] `node scripts/scan-secrets.js` finds nothing.

## Replay comparison (prompt, skill or analysis changes only)

<!-- Paste the output of `agent-watchdog replay --date <date> --prompts <dir>` or the `--from/--to` summary. -->

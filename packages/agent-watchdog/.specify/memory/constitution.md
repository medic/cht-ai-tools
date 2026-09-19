# agent-watchdog Constitution

<!--
Scope note
Part I holds CHT-wide engineering principles shared by every CHT tool. It is written so it
can be lifted unchanged to the cht-ai-tools root when a second package adopts Spec Kit.
Part II holds principles specific to agent-watchdog.

AGENTS.md is the operational quick reference for coding agents. This document is the
authority when the two disagree, and AGENTS.md MUST be corrected in the same PR as any
amendment here.
-->

## Part I — CHT Engineering Principles

### I. CHT Conventions Are Not Optional

agent-watchdog is a CHT tool and MUST be indistinguishable in style from cht-core and cht-conf.

- Language: JavaScript, CommonJS. TypeScript is not used for server-side or scripting code.
- Runtime: Node.js 22 LTS, pinned in `.nvmrc` and in the container image.
- Style: 2-space indentation, single quotes, semicolons required, 120-column limit, opening
  braces on the same line, `const`/`let` only, strict equality, `lowerCamelCase` for
  functions and variables, `UpperCamelCase` for classes, `ALL_UPPERCASE` for hard-coded
  constants, UNIX newlines.
- Lint: `@medic/eslint-config`. `npm run lint` MUST pass with zero warnings before a PR opens.
- Tests: mocha, chai (with chai-as-promised), sinon, nyc. `test/` mirrors `src/`
  (`src/analyze/deltas.js` → `test/analyze/deltas.spec.js`).
- Commits and PR titles: Conventional Commits, `type(#issue): subject`, with `type` in
  `build feat fix perf refactor test chore docs`. PRs target `main` and reference an issue.
- Release: semantic-release derives the version from commit types; the container image is
  published on every release.
- License: AGPL-3.0, matching the other CHT tools.

Rationale: contributors move between CHT repositories; every deviation is a tax on all of them.

### II. Test-First and Replayable

- A unit test exists before the behaviour it covers (red → green → refactor).
- Anything that touches an external system (metrics store, Slack, model API, tracing) sits
  behind a small module boundary and is tested with sinon stubs and recorded fixtures under
  `test/fixtures/`. No test may reach the network.
- Every run persists enough of its inputs to be replayed offline. Replaying recorded runs
  is part of the definition of done for any change to analysis behaviour.
- Prompts are code. A change to a prompt, the embedded skill, or a model parameter MUST
  pass the replay fixtures and MUST NOT regress the labelled feedback set. It is reviewed
  in a PR like any other code, with the replay diff attached.

Rationale: the product improves by iterating on prompts; without replayable evaluation that
iteration is guesswork against production.

### III. Deterministic Before Generative

- Arithmetic, thresholds, baselines, calendar logic, scoping, redaction and escaping live in
  code with unit tests. The model interprets, prioritises and explains; it never computes
  what code can compute.
- The model is invoked for a bounded number of passes per unit of work, each a bounded tool
  loop (maximum passes, iterations, tokens and cost are configuration with hard caps in code)
  with a schema-validated structured output; later passes review earlier ones and stop early
  when nothing changes.
- Every model-dependent stage has a degraded-but-useful path when the model fails or
  returns invalid output, and that path says so in its output.
- Publication is gated by deterministic verification that runs in code, not in a prompt:
  schema validity, every number traceable to computed data, every project name known, every
  link resolvable and allow-listed, length and structure limits. A failed gate blocks the
  output, is returned to the model a bounded number of times, then degrades.
- The model composes no URLs. Links are built by code from structured references the model
  emits (dashboard, panel, project, window) or from addresses that appeared in tool results.

Rationale: numbers an operator will act on MUST be reproducible; the model's value is
judgement, not arithmetic.

### IV. Least Privilege and Explicit Trust Boundaries

- Credentials are read-only and scoped to the minimum: metrics read; Slack post and read on
  the single configured channel; tracing write. No credential grants write access to any CHT
  deployment or to the watchdog itself.
- The model's tools are an enumerated allow-list of read operations. No shell, no file
  write and no arbitrary HTTP tool is ever exposed to the model.
- All text fetched from outside (forum posts, documentation, dashboard annotations, Slack
  notes) is untrusted data: delimited and labelled in prompts, never executed as
  instructions, always rendered through escaping templates.
- The agent MUST NOT modify its own prompts, tools or skill. It may write only to its
  bounded memory (size-capped, every change stored as a diff) and to proposals that a human
  reviews before adoption.
- Secrets never appear in prompts, logs, posts, run records or the public repository.
  Personal data (for example recipient addresses) never lives in the public repository.
- Output destined for anyone outside Medic MUST pass code-level checks (link allow-list,
  cross-project hostname scan) that fail closed.

Rationale: this system reads production telemetry across many partners and speaks to humans
on Medic's behalf. A prompt is not a security control.

### V. Simple, Observable, Boring

- One process, one entrypoint, one scheduled run. No always-on service is introduced unless
  a spec demonstrates the scheduled model cannot meet a requirement.
- One engine. The same agent definition (skill, tools, reference sources, hooks, prompts,
  output schema) runs in production and on a contributor's machine and produces the same
  artefacts; the only difference is whether the final publish step executes. Each stage is
  runnable and inspectable on its own from stored files.
- Structured JSON logs bound to a run id; one trace per run with a span per stage; token
  usage and cost recorded per run and shown to the humans who read the output.
- Runs are idempotent by date and project; re-running is explicit and safe.
- Failure is loud: a failed run notifies the channel it would have posted to and exits
  non-zero. Silent skips are defects.
- Prefer Node built-ins (`fetch`, `node:util` `parseArgs`, `node:crypto`, `node:fs/promises`).
  Every new dependency carries a one-line justification in the PR and MUST be
  CommonJS-compatible.
- Configuration is twelve-factor. Secrets and per-environment scalars (model, effort, bounds,
  endpoints, paths, retention, logging) come from the environment; reviewed policy (project
  annotations, priorities, thresholds, calendar, prompts, schema) comes from versioned files;
  per-run choices come from flags. Safety rails are code, never configuration. Everything is
  validated at startup and the effective, redacted configuration is recorded with each run.

Rationale: a daily job nobody watches has to be diagnosable from its own artefacts.

## Part II — agent-watchdog Principles

### VI. Flag, Don't Act

The system exists to tell humans where to look. It MUST NOT remediate, restart, reconfigure
or open tickets against any deployment. It is not an alerting system: paging remains the job
of the existing monitoring stack; this tool summarises change and points at it.

### VII. Learn Only Through Review

Human feedback shapes the agent's memory automatically, within its cap. Anything that
changes how the agent is invoked — prompts, tool set, skill content, priorities, calendar,
thresholds — changes only through a reviewed pull request. Proposals the agent generates,
including pattern cards distilled from the knowledge corpus and threshold suggestions
backed by replayed evidence, are inputs to that review, never merges. Raw corpus material
stays private; only scrubbed, pattern-level distillations enter the public repository.

### VIII. One Audience per Output

Internal output (Slack, archives) may reference internal tooling and any project. Output for
a partner is scoped to that partner's project and self-contained: it MUST NOT link to systems
the recipient cannot log into and MUST NOT mention other projects. The audience is an
explicit parameter of every render and publish step, never inferred from context.

## Security Requirements

- Secrets are injected from the cluster secret manager at run time; none are baked into
  images or committed to any repository.
- Containers run as non-root with a read-only root filesystem, dropped capabilities and
  explicit CPU and memory limits. Network egress is restricted to the enumerated endpoints.
- Dependencies are kept current by an automated update bot; CI fails on known-vulnerable
  dependencies rated high or above.
- Model output is validated against a schema before use and escaped before display.
- Run records live on encrypted storage; retention limits are configuration, not code.

## Development Workflow and Quality Gates

1. `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` (which includes the
   Constitution Check) → `/speckit.analyze` → `/speckit.tasks` → implementation, tests first.
2. A PR is mergeable only when: lint is clean; unit tests pass with coverage no lower than
   `main`; replay evaluation passes for any analysis change; new dependencies are justified;
   `AGENTS.md` and `README.md` reflect any changed behaviour; the commit convention holds.
3. Prompt and skill changes attach the replay diff (findings before and after, across the
   fixture set) to the PR description.
4. Releases are cut by semantic-release. Deployment pins the released image tag in
   `medic-infrastructure` and bumps it by PR.

## Governance

- This constitution supersedes any other practice document in the package. Where
  `AGENTS.md` and this document disagree, this document wins and `AGENTS.md` is corrected.
- Amendments are made by PR with a rationale and a version bump: MAJOR for removing or
  redefining a principle, MINOR for adding a principle or section, PATCH for wording.
- Every `plan.md` includes a Constitution Check listing each principle and how the plan
  satisfies it. Any deviation is recorded in the plan's Complexity Tracking with a
  justification and an expiry.
- Part I MAY be promoted to the repository root when a second package adopts Spec Kit;
  Part II stays with the package.

**Version**: 1.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19

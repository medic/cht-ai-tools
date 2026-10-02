# Test fixtures

Recorded or synthesised inputs for the unit, replay and end-to-end tests. No test reaches the network.

- `runs/<case>/grafana/`: what the hosted watchdog's Grafana returns for one day. `search.json`,
  `dashboards/<uid>.json` (real cht-watchdog uids and panel ids), `annotations.json`, and
  `series.json`, a compact description from which `test/helpers/fake-grafana.js` synthesises
  deterministic Prometheus proxy responses for any window and step.
- `runs/<case>/expected.json`: which candidates the analysis must raise for that day.
- `runs/<case>/findings/`: recorded model output per project and pass, used in place of the model
  by replay evaluation and the end-to-end tests.
- `findings/`: small structured-output documents for schema tests.
- `slack/`: recorded Slack payloads for the feedback tests.
- `corpus/`: raw knowledge-corpus items for the index, distillation and User Story 6 tests (see
  `corpus/README.md`); `node test/fixtures/generate-corpus.js` rewrites its two synthetic files.
- `feedback-labels.json`: the labelled feedback set that prompt changes must not regress.

Regenerate the synthetic cases with `node test/fixtures/generate.js`. Real, scrubbed recordings are
refreshed from a watchdog with `node scripts/record-fixtures.js --date <date> --out test/fixtures/runs/<case>`
(hosts are replaced by `<n>.example.org` and every free-text field is dropped).

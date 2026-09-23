# Reference manifests

Reference only. `medic-infrastructure` owns the CronJob, ConfigMap, Secret, volume and network-policy
manifests it applies; these files show one way to satisfy
[`contracts/container.md`](../specs/001-watchdog-slack-loop/contracts/container.md) (FR-083, FR-086) with
placeholder hosts, and `test/container/deploy.spec.js` keeps them in step with the contract and with the
egress list the package builds from the same configuration.

- `cronjob.example.yaml`: a ConfigMap with the non-secret environment and the CronJob that runs the image
  once a day as user `10001:10001` with a read-only root filesystem, every capability dropped, no privilege
  escalation, the runtime's default seccomp profile, no service-account token, three mounts (`/data` volume,
  `/tmp` emptyDir, `/etc/agent-watchdog` ConfigMap read-only), requests and limits, `concurrencyPolicy:
  Forbid` and a deadline ten minutes past the run's own timeout. Secrets come from a Secret named
  `agent-watchdog-secrets` through `envFrom`; nothing is inline.
- `networkpolicy.example.yaml`: a default-deny egress `NetworkPolicy` that allows DNS, and a
  `CiliumNetworkPolicy` whose FQDN selectors are exactly what `agent-watchdog egress --format hosts` prints
  for the ConfigMap's configuration, on 443. A cluster without Cilium substitutes its own name-based egress
  mechanism; a plain `NetworkPolicy` selects CIDRs only.

Regenerate the host list after changing an endpoint:

```sh
node bin/agent-watchdog.js egress --format hosts
```

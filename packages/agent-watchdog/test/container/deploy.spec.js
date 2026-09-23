// FR-086 (revision 30): the reference manifests under deploy/ satisfy the container contract and agree with the
// egress list the package builds from the same configuration; placeholders only.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { buildEgress } = require('../../src/net/egress');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'deploy', rel), 'utf8');
const documents = (rel) => YAML.parseAllDocuments(read(rel)).map((d) => d.toJS());

describe('container: the reference manifests (FR-086, FR-083, deploy/)', () => {
  const workload = documents('cronjob.example.yaml');
  const configMap = workload.find((d) => d.kind === 'ConfigMap');
  const cronJob = workload.find((d) => d.kind === 'CronJob');
  const pod = cronJob.spec.jobTemplate.spec.template.spec;
  const [container] = pod.containers;
  const policies = documents('networkpolicy.example.yaml');

  it('runs as the fixed non-root user with root read-only, no capabilities, no escalation, default seccomp', () => {
    expect(pod.securityContext).to.deep.include({
      runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.securityContext).to.deep.equal({
      readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] },
    });
    expect(pod.automountServiceAccountToken).to.equal(false);
    expect(pod.hostNetwork).to.equal(undefined);
    expect(pod.hostPID).to.equal(undefined);
    expect(pod.hostIPC).to.equal(undefined);
    expect(container.ports).to.equal(undefined);
    expect(container.image).to.match(/^ghcr\.io\/medic\/agent-watchdog:/);
    expect(pod.restartPolicy).to.equal('Never');
  });

  it('mounts the data volume read-write, /tmp as an emptyDir and the policy files read-only, and nothing else', () => {
    const mounts = container.volumeMounts.map((m) => [m.mountPath, m.readOnly === true]);
    expect(mounts.sort()).to.deep.equal([['/data', false], ['/etc/agent-watchdog', true], ['/tmp', false]]);
    const byName = Object.fromEntries(pod.volumes.map((v) => [v.name, v]));
    const mountByPath = Object.fromEntries(container.volumeMounts.map((m) => [m.mountPath, m.name]));
    expect(byName[mountByPath['/data']].persistentVolumeClaim).to.be.an('object');
    expect(byName[mountByPath['/tmp']].emptyDir).to.be.an('object');
    expect(byName[mountByPath['/etc/agent-watchdog']].configMap).to.be.an('object');
    expect(pod.volumes).to.have.length(3);
  });

  it('states requests and limits, forbids concurrent runs and gives the run its own timeout plus ten minutes', () => {
    expect(container.resources.requests).to.deep.equal({ cpu: '500m', memory: '1Gi' });
    expect(container.resources.limits).to.deep.equal({ cpu: '2', memory: '2Gi' });
    expect(cronJob.spec.concurrencyPolicy).to.equal('Forbid');
    expect(cronJob.spec.startingDeadlineSeconds).to.be.a('number');
    const runTimeoutMs = Number(configMap.data.AGENT_WATCHDOG_RUN_TIMEOUT_MS || 3600000);
    expect(cronJob.spec.jobTemplate.spec.activeDeadlineSeconds).to.be.at.least(runTimeoutMs / 1000 + 600);
    expect(cronJob.spec.jobTemplate.spec.backoffLimit).to.equal(0);
    expect(container.args).to.deep.equal(['run']);
  });

  it('takes non-secrets from the ConfigMap and secrets from a Secret, never inline', () => {
    const sources = container.envFrom.map((e) => Object.keys(e)[0]).sort();
    expect(sources).to.deep.equal(['configMapRef', 'secretRef']);
    expect(container.env).to.equal(undefined);
    for (const key of ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'AGENT_WATCHDOG_GRAFANA_TOKEN', 'LANGFUSE_SECRET_KEY']) {
      expect(Object.keys(configMap.data), key).to.not.include(key);
    }
    expect(configMap.data.AGENT_WATCHDOG_DATA_DIR).to.equal('/data');
    expect(configMap.data.AGENT_WATCHDOG_CONFIG_DIR).to.equal('/etc/agent-watchdog');
  });

  it('allows egress only to DNS and to the destinations the package lists for that configuration, on 443', () => {
    const deny = policies.find((d) => d.kind === 'NetworkPolicy');
    expect(deny.spec.policyTypes).to.deep.equal(['Egress']);
    expect(deny.spec.ingress).to.equal(undefined);
    const dnsPorts = deny.spec.egress.flatMap((rule) => rule.ports || []).map((p) => `${p.protocol}/${p.port}`).sort();
    expect(dnsPorts).to.deep.equal(['TCP/53', 'UDP/53']);
    expect(deny.spec.egress).to.have.length(1);
    const cilium = policies.find((d) => d.kind === 'CiliumNetworkPolicy');
    const fqdns = cilium.spec.egress.flatMap((rule) => (rule.toFQDNs || []).map((f) => f.matchName)).sort();
    const env = configMap.data;
    const expected = buildEgress({
      endpoints: {
        grafanaUrl: env.AGENT_WATCHDOG_GRAFANA_URL, langfuseBaseUrl: env.LANGFUSE_BASE_URL,
        docsMcpUrl: env.AGENT_WATCHDOG_DOCS_MCP_URL, specsUrl: env.AGENT_WATCHDOG_SPECS_URL,
        configUrl: env.AGENT_WATCHDOG_CONFIG_URL,
      },
    }).endpoints.map((e) => e.host).sort();
    expect(fqdns).to.deep.equal(expected);
    for (const rule of cilium.spec.egress.filter((r) => r.toFQDNs)) {
      expect(rule.toPorts).to.deep.equal([{ ports: [{ port: '443', protocol: 'TCP' }] }]);
    }
    expect(cilium.spec.ingress).to.equal(undefined);
    const label = cronJob.spec.jobTemplate.spec.template.metadata.labels.app;
    expect(deny.spec.podSelector.matchLabels.app).to.equal(label);
    expect(cilium.spec.endpointSelector.matchLabels.app).to.equal(label);
  });

  it('names placeholder hosts and the fixed code hosts only, and no secret value', () => {
    const text = read('cronjob.example.yaml') + read('networkpolicy.example.yaml') + read('README.md');
    const hosts = [...text.matchAll(/(?:https:\/\/|matchName: )([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(hosts.length).to.be.at.least(9);
    const allowed = /(\.example\.org|communityhealthtoolkit\.org|slack\.com|anthropic\.com|github\.com)$/;
    for (const host of hosts) {
      expect(host, host).to.match(allowed);
    }
    expect(text).to.not.match(/xoxb-|glsa_|sk-ant-|pk-lf-|sk-lf-/);
  });
});

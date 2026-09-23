// FR-086 (revision 31): the local Compose setup runs the image under the constraints the CronJob applies, with the
// operator's own .env and policy files, and never carries a secret itself.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const text = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
const compose = YAML.parse(text, { merge: true });

describe('container: the local Compose setup (FR-086, contracts/container.md)', () => {
  const service = compose.services['agent-watchdog'];
  const offline = compose.services.offline;

  it('builds the same image as CI with the version and revision arguments, and runs it hardened', () => {
    expect(service.build).to.deep.equal({
      context: '.',
      args: { VERSION: '${AGENT_WATCHDOG_VERSION:-0.0.0-development}', REVISION: '${AGENT_WATCHDOG_REVISION:-local}' },
    });
    expect(service.image).to.equal('agent-watchdog:local');
    expect(service).to.deep.include({
      init: true, user: '10001:10001', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
      stop_grace_period: '2m',
    });
    expect(service.privileged).to.equal(undefined);
    expect(service.network_mode).to.equal(undefined);
    expect(service.ports).to.equal(undefined);
  });

  it('writes only to the data volume and a /tmp tmpfs, reads the policy files read-only, limits CPU and memory', () => {
    expect(service.tmpfs).to.deep.equal(['/tmp:size=1g,mode=1777']);
    expect(service.volumes).to.deep.equal([
      '${AGENT_WATCHDOG_COMPOSE_DATA:-data}:/data',
      '${AGENT_WATCHDOG_COMPOSE_CONFIG_DIR:-./config/local}:/etc/agent-watchdog:ro',
    ]);
    expect(compose.volumes).to.deep.equal({ data: { name: 'agent-watchdog-data' } });
    expect(service.deploy.resources.limits).to.deep.equal({ cpus: '2', memory: '2G', pids: 512 });
    expect(service.deploy.resources.reservations).to.deep.equal({ cpus: '0.5', memory: '1G' });
  });

  it('takes secrets and endpoints from the operator\'s .env and pins the container paths, with no value inline', () => {
    expect(service.env_file).to.equal('.env');
    expect(service.environment).to.deep.equal({
      AGENT_WATCHDOG_DATA_DIR: '/data',
      AGENT_WATCHDOG_CONFIG_DIR: '/etc/agent-watchdog',
      AGENT_WATCHDOG_CORPUS_RAW_DIR: '/data/knowledge-corpus/raw',
    });
    expect(text).to.not.match(/xoxb-|glsa_|sk-ant-|pk-lf-|sk-lf-|ANTHROPIC_API_KEY|SLACK_BOT_TOKEN/);
    expect(text).to.not.match(/medicmobile|echis|\.go\.ke|\.gov\.np/i);
  });

  it('previews by default, and offers an offline profile with no network for replay and single stages', () => {
    expect(service.command).to.deep.equal(['run', '--dry-run']);
    expect(offline.profiles).to.deep.equal(['offline']);
    expect(offline.network_mode).to.equal('none');
    expect(offline).to.deep.include({ user: '10001:10001', read_only: true, cap_drop: ['ALL'] });
    expect(offline.image).to.equal('agent-watchdog:local');
  });

  it('stays out of the image', () => {
    const ignored = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(ignored).to.include('compose.yaml');
  });
});

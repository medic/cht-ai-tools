// FR-086 (revisions 31 and 32): the local Compose setup runs the image under the constraints the CronJob applies,
// with the operator's own .env and policy files, never carries a secret itself, and keeps a contributor's own
// Claude login in a named volume for the CLI engine's login mode.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const text = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
const compose = YAML.parse(text, { merge: true });

describe('container: the local Compose setup (FR-086, contracts/container.md)', () => {
  const service = compose.services['agent-watchdog'];
  const offline = compose.services.offline;
  const login = compose.services.login;

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

  it('writes only to the data and login volumes and a /tmp tmpfs, reads policy files read-only, sets limits', () => {
    expect(service.tmpfs).to.deep.equal(['/tmp:size=1g,mode=1777']);
    expect(service.volumes).to.deep.equal([
      '${AGENT_WATCHDOG_COMPOSE_DATA:-data}:/data',
      '${AGENT_WATCHDOG_COMPOSE_CONFIG_DIR:-./config/local}:/etc/agent-watchdog:ro',
      'login:/home/watchdog',
    ]);
    expect(compose.volumes).to.deep.equal({
      data: { name: 'agent-watchdog-data' }, login: { name: 'agent-watchdog-login' },
    });
    expect(service.deploy.resources.limits).to.deep.equal({ cpus: '2', memory: '2G', pids: 512 });
    expect(service.deploy.resources.reservations).to.deep.equal({ cpus: '0.5', memory: '1G' });
  });

  it('takes secrets and endpoints from the operator\'s .env and pins the container paths, with no value inline', () => {
    expect(service.env_file).to.equal('.env');
    expect(service.environment).to.deep.equal({
      AGENT_WATCHDOG_DATA_DIR: '/data',
      AGENT_WATCHDOG_CONFIG_DIR: '/etc/agent-watchdog',
      AGENT_WATCHDOG_CORPUS_RAW_DIR: '/data/knowledge-corpus/raw',
      CLAUDE_CONFIG_DIR: '/home/watchdog/.claude',
    });
    // Variable names may be explained in comments; no secret value and no secret assignment is in the file.
    expect(text).to.not.match(/xoxb-|glsa_|sk-ant-|pk-lf-|sk-lf-/);
    const secretNames = ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'AGENT_WATCHDOG_GRAFANA_TOKEN', 'LANGFUSE_SECRET_KEY'];
    for (const name of secretNames) {
      expect(text, name).to.not.include(`  ${name}:`);
    }
    expect(text).to.not.match(/medicmobile|echis|\.go\.ke|\.gov\.np/i);
  });

  it('previews by default, and offers an offline profile with no network for the stages that need none', () => {
    expect(service.command).to.deep.equal(['run', '--dry-run']);
    expect(offline.profiles).to.deep.equal(['offline']);
    expect(offline.network_mode).to.equal('none');
    expect(offline.command).to.deep.equal(['run', '--dry-run', '--stage', 'analyze']);
    expect(offline).to.deep.include({ user: '10001:10001', read_only: true, cap_drop: ['ALL'] });
    expect(offline.image).to.equal('agent-watchdog:local');
    expect(text).to.not.match(/offline run --rm offline replay/);
  });

  it('logs a contributor in once through the bundled runtime, into the login volume, hardened alike', () => {
    expect(login.profiles).to.deep.equal(['login']);
    expect(login).to.deep.include({
      stdin_open: true, tty: true, entrypoint: ['claude'], command: ['auth', 'login'],
      user: '10001:10001', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    });
    expect(login.volumes).to.include('login:/home/watchdog');
    expect(login.environment.CLAUDE_CONFIG_DIR).to.equal('/home/watchdog/.claude');
    expect(login.network_mode).to.equal(undefined);
    // The login volume holds an OAuth token: a named volume, never a bind mount into the repository.
    expect(text).to.not.match(/\.claude[^\n]*:\/home\/watchdog/);
    expect(text).to.match(/auth logout/);
  });

  it('stays out of the image', () => {
    const ignored = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(ignored).to.include('compose.yaml');
  });
});

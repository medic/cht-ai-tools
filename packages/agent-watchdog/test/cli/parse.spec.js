const { Writable } = require('node:stream');
const { main, parseCommandLine, COMMANDS, USAGE } = require('../../src/cli/index');
const codes = require('../../src/cli/exit-codes');

const capture = () => {
  const chunks = []; return { stream: new Writable({ write(c, e, cb) {
    chunks.push(c.toString()); cb(); 
  } }), text: () => chunks.join('') }; 
};

describe('cli/parse', () => {
  it('knows the contract commands', () => {
    expect(COMMANDS).to.include.members([
      'run', 'replay', 'distill', 'calibrate', 'check', 'purge', 'egress', 'tools-server',
    ]);
    expect(USAGE).to.match(/egress\s+the destinations a run contacts/);
  });

  it('parses a repeatable --group beside --project and documents it in the usage text (revision 24)', async () => {
    const parsed = parseCommandLine([
      'run', '--group', 'North Programme', '--group', 'South Programme', '--project', 'a.org',
    ]);
    expect(parsed.flags.group).to.deep.equal(['North Programme', 'South Programme']);
    expect(parsed.flags.project).to.deep.equal(['a.org']);
    const out = capture();
    expect(await main(['--help'], { env: {}, stdout: out.stream, stderr: capture().stream })).to.equal(0);
    expect(out.text()).to.include('--group');
  });

  it('parses run flags including repeatable --project', () => {
    const parsed = parseCommandLine([
      'run', '--date', '2026-09-18', '--project', 'a.org', '--project', 'b.org', '--stage', 'collect',
      '--engine', 'cli', '--dry-run', '--force', '--since', '2026-09-10',
    ]);
    expect(parsed.command).to.equal('run');
    expect(parsed.flags).to.include({
      date: '2026-09-18', stage: 'collect', engine: 'cli', 'dry-run': true, force: true, since: '2026-09-10',
    });
    expect(parsed.flags.project).to.deep.equal(['a.org', 'b.org']);
  });



  it('parses the tools-server flags for the CLI engine', () => {
    const parsed = parseCommandLine([
      'tools-server', '--run-dir', '/data/runs/2026-09-18', '--data-dir', '/data', '--project', 'alpha-example-org',
      '--server', 'cht-docs', '--replay',
    ]);
    expect(parsed.command).to.equal('tools-server');
    expect(parsed.flags).to.include({
      'run-dir': '/data/runs/2026-09-18', 'data-dir': '/data', server: 'cht-docs', replay: true,
    });
    expect(parsed.flags.project).to.deep.equal(['alpha-example-org']);
  });

  it('rejects unknown flags with a usage error', () => {
    expect(() => parseCommandLine(['run', '--bogus'])).to.throw(codes.ExitError).with.property('code', codes.USAGE);
  });

  it('exits 64 for an unknown command and prints the reason on stderr', async () => {
    const out = capture(); const err = capture();
    const code = await main(['dance'], { env: {}, stdout: out.stream, stderr: err.stream });
    expect(code).to.equal(64);
    expect(err.text()).to.include('dance');
    expect(out.text()).to.equal('');
  });

  it('prints usage on stdout and exits 0 for --help and no command', async () => {
    const out = capture(); const err = capture();
    expect(await main(['--help'], { env: {}, stdout: out.stream, stderr: err.stream })).to.equal(0);
    expect(out.text()).to.include('agent-watchdog <command>');
    const out2 = capture();
    expect(await main([], { env: {}, stdout: out2.stream, stderr: err.stream })).to.equal(0);
    expect(out2.text()).to.include('run');
  });

  it('prints the package version for --version', async () => {
    const out = capture();
    expect(await main(['--version'], { env: {}, stdout: out.stream, stderr: capture().stream })).to.equal(0);
    expect(out.text().trim()).to.equal(require('../../package.json').version);
  });

  it('keeps logs on stderr and results on stdout', async () => {
    const out = capture(); const err = capture();
    await main(['dance'], { env: {}, stdout: out.stream, stderr: err.stream });
    expect(out.text()).to.equal('');
    const line = JSON.parse(err.text().trim().split('\n').pop());
    expect(line).to.include({ event: 'run.exit', code: 64 });
  });

  it('maps a thrown ExitError from a command to its code and anything else to 1', async () => {
    const err = capture();
    const failWith = (error) => ({ run: async () => {
      throw error; 
    } });
    const io = (commands) => ({ env: {}, stdout: capture().stream, stderr: err.stream, commands });
    const code = await main(['run'], io(failWith(new codes.ExitError(codes.DATAERR, 'missing changes.json'))));
    expect(code).to.equal(65);
    const code2 = await main(['run'], io(failWith(new Error('kaboom'))));
    expect(code2).to.equal(1);
  });
});

describe('cli/exit-codes', () => {
  it('defines the contract table', () => {
    expect(codes).to.include({
      OK: 0, FAILED: 1, USAGE: 64, DATAERR: 65, UNAVAILABLE: 69, IOERR: 74, TEMPFAIL: 75, CONFIG: 78,
    });
    expect(codes.nameOf(75)).to.equal('TEMPFAIL');
    const e = new codes.ExitError(codes.CONFIG, 'bad', { keys: ['X'] });
    expect(e.code).to.equal(78);
    expect(e.details).to.deep.equal({ keys: ['X'] });
  });
});

describe('cli/parse: the flags a command owns, the log flags and the image version (revision 35)', () => {
  const { envFor } = require('./helpers');
  const run = (argv, env = envFor('/tmp')) => {
    const out = capture();
    const err = capture();
    return main(argv, { env, stdout: out.stream, stderr: err.stream }).then((code) => ({ code, out, err }));
  };

  it('refuses a flag that is not the command\'s own with a usage error naming it, replay --stage first', async () => {
    const replay = await run(['replay', '--date', '2026-09-18', '--stage', 'agent']);
    expect(replay.code).to.equal(codes.USAGE);
    expect(replay.err.text()).to.include('--stage is not a flag of replay');
    const purge = await run(['purge', '--force']);
    expect(purge.code).to.equal(codes.USAGE);
    expect(purge.err.text()).to.include('--force is not a flag of purge');
    const egress = await run(['egress', '--week', '2026-W38']);
    expect(egress.code).to.equal(codes.USAGE);
    const global = await run(['egress', '--format', 'hosts', '--data-dir', '/tmp/x']);
    expect(global.code).to.equal(0);
    // `--engine` belongs to distill and calibrate as it does to run and replay (FR-050, revision 36).
    for (const command of ['distill', 'calibrate']) {
      const out = capture();
      const err = capture();
      const code = await main([command, '--engine', 'cli'], {
        env: envFor('/tmp'), stdout: out.stream, stderr: err.stream, commands: { [command]: async () => 0 },
      });
      expect(code, `${command} --engine`).to.equal(0);
      expect(err.text()).to.not.include('is not a flag of');
    }
  });

  it('applies --log-level and --log-format to the command\'s logger and refuses a bad value', async () => {
    const quiet = await run(['egress', '--log-level', 'error']);
    expect(quiet.code).to.equal(0);
    expect(quiet.err.text(), 'nothing below error is written').to.equal('');
    const pretty = await run(['egress', '--log-format', 'pretty']);
    expect(pretty.code).to.equal(0);
    expect(pretty.err.text()).to.match(/ info\s+/);
    expect(() => JSON.parse(pretty.err.text().trim().split('\n')[0])).to.throw();
    const bad = await run(['egress', '--log-level', 'loud']);
    expect(bad.code).to.equal(codes.USAGE);
    expect(bad.err.text()).to.include('--log-level');
    const badFormat = await run(['egress', '--log-format', 'xml']);
    expect(badFormat.code).to.equal(codes.USAGE);
  });

  it('prints the image\'s version for --version when the image set one', async () => {
    const image = await run(['--version'], { ...envFor('/tmp'), AGENT_WATCHDOG_VERSION: '1.4.0' });
    expect(image.out.text().trim()).to.equal('1.4.0');
    const dev = await run(['--version'], { ...envFor('/tmp'), AGENT_WATCHDOG_VERSION: '0.0.0-development' });
    expect(dev.out.text().trim()).to.equal(require('../../package.json').version);
  });
});

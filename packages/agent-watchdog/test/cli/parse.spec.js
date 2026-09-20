const { Writable } = require('node:stream');
const { main, parseCommandLine, COMMANDS } = require('../../src/cli/index');
const codes = require('../../src/cli/exit-codes');

const capture = () => {
  const chunks = []; return { stream: new Writable({ write(c, e, cb) {
    chunks.push(c.toString()); cb(); 
  } }), text: () => chunks.join('') }; 
};

describe('cli/parse', () => {
  it('knows the contract commands', () => {
    expect(COMMANDS).to.include.members(['run', 'replay', 'distill', 'calibrate', 'check', 'purge', 'tools-server']);
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

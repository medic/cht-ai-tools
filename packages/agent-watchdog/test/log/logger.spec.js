const { Writable } = require('node:stream');
const { createLogger } = require('../../src/log/logger');

const capture = () => {
  const lines = [];
  const stream = new Writable({ write(chunk, enc, cb) {
    lines.push(chunk.toString()); cb(); 
  } });
  return { stream, lines, json: () => lines.map((l) => JSON.parse(l)) };
};

describe('log/logger', () => {
  it('writes one JSON object per line with the mandatory fields', () => {
    const out = capture();
    const bindings = { run_id: '2026-09-18', stage: 'collect' };
    const log = createLogger({ level: 'info', format: 'json', stream: out.stream, bindings });
    log.info('collect.start', { projects: 3 });
    const [line] = out.json();
    expect(line).to.include({
      level: 'info',
      service: 'agent-watchdog',
      run_id: '2026-09-18',
      stage: 'collect',
      event: 'collect.start',
      projects: 3,
    });
    expect(line.ts).to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect(line.mono_ns).to.match(/^\d+$/);
    expect(out.lines[0].endsWith('\n')).to.equal(true);
  });

  it('records a monotonic timestamp that never decreases', () => {
    const out = capture();
    const log = createLogger({ stream: out.stream });
    log.info('a'); log.info('b');
    const [a, b] = out.json();
    expect(BigInt(b.mono_ns) >= BigInt(a.mono_ns)).to.equal(true);
  });

  it('filters events below the configured level', () => {
    const out = capture();
    const log = createLogger({ level: 'warn', stream: out.stream });
    log.debug('x'); log.info('y'); log.warn('z'); log.error('w');
    expect(out.json().map((l) => l.event)).to.deep.equal(['z', 'w']);
  });

  it('redacts secret-looking keys and configured keys at any depth', () => {
    const out = capture();
    const log = createLogger({ stream: out.stream, redact: ['channel_secret'] });
    log.info('cfg', {
      token: 'xoxb-1',
      nested: { apiKey: 'sk-ant', password: 'p', fine: 1 },
      channel_secret: 'C1',
      authorization: 'Bearer abc',
    });
    const [line] = out.json();
    expect(line.token).to.equal('[redacted]');
    expect(line.nested.apiKey).to.equal('[redacted]');
    expect(line.nested.password).to.equal('[redacted]');
    expect(line.nested.fine).to.equal(1);
    expect(line.channel_secret).to.equal('[redacted]');
    expect(line.authorization).to.equal('[redacted]');
  });

  it('creates children that inherit and extend bindings', () => {
    const out = capture();
    const log = createLogger({ stream: out.stream, bindings: { run_id: 'r' } });
    log.child({ stage: 'analyze' }).info('go');
    expect(out.json()[0]).to.include({ run_id: 'r', stage: 'analyze', event: 'go' });
  });

  it('serialises errors with name, message and stack', () => {
    const out = capture();
    const log = createLogger({ stream: out.stream });
    log.error('boom', { error: new TypeError('bad') });
    const [line] = out.json();
    expect(line.error).to.include({ name: 'TypeError', message: 'bad' });
    expect(line.error.stack).to.be.a('string');
  });

  it('renders a human-readable line in pretty format', () => {
    const out = capture();
    const log = createLogger({ format: 'pretty', stream: out.stream, bindings: { run_id: 'r', stage: 's' } });
    log.warn('slow', { ms: 12 });
    expect(out.lines[0]).to.match(/warn/);
    expect(out.lines[0]).to.include('r/s');
    expect(out.lines[0]).to.include('slow');
    expect(out.lines[0]).to.include('"ms":12');
  });
});

const { createTracer } = require('../../src/trace/langfuse');

const fakeSdk = () => {
  const observations = [];
  const makeObs = (name, attrs, opts) => {
    const obs = {
      name,
      attrs,
      type: opts && opts.asType,
      traceId: 'trace-1',
      id: `obs-${observations.length}`,
      ended: false,
      children: [],
    };
    obs.update = (a) => {
      Object.assign(obs.attrs, a); return obs; 
    };
    obs.end = () => {
      obs.ended = true; 
    };
    obs.startObservation = (n, a, o) => {
      const c = makeObs(n, a, o); obs.children.push(c); return c; 
    };
    observations.push(obs);
    return obs;
  };
  return {
    observations,
    tracing: {
      startObservation: (n, a, o) => makeObs(n, a, o),
      propagateAttributes: async (attrs, cb) => {
        observations.propagated = attrs; return cb(); 
      },
    },
    processor: { forceFlush: sinon.stub().resolves(), shutdown: sinon.stub().resolves() },
    otelSdk: { start: sinon.stub(), shutdown: sinon.stub().resolves() },
    client: { getTraceUrl: sinon.stub().resolves('https://langfuse.example.org/project/p1/traces/trace-1') },
  };
};

describe('trace/langfuse', () => {
  it('opens one root observation per run tagged with the run id and a span per stage', async () => {
    const sdk = fakeSdk();
    const tracer = createTracer({ sdk });
    await tracer.start({ runId: '2026-09-18', date: '2026-09-18', mode: 'scheduled' });
    expect(sdk.otelSdk.start).to.have.been.calledOnce;
    expect(sdk.observations.propagated).to.include({ traceName: 'daily-brief', sessionId: '2026-09-18' });
    const result = await tracer.stage('collect', async () => 42);
    expect(result).to.equal(42);
    const root = sdk.observations[0];
    expect(root.children.map((c) => c.name)).to.deep.equal(['collect']);
    expect(root.children[0].ended).to.equal(true);
    expect(tracer.traceId).to.equal('trace-1');
  });

  it('ends a stage span and rethrows when the stage fails', async () => {
    const sdk = fakeSdk();
    const tracer = createTracer({ sdk });
    await tracer.start({ runId: 'r', date: 'd', mode: 'manual' });
    await expect(tracer.stage('analyze', async () => {
      throw new Error('nope'); 
    })).to.be.rejectedWith('nope');
    const span = sdk.observations[0].children[0];
    expect(span.ended).to.equal(true);
    expect(span.attrs.level).to.equal('ERROR');
  });

  it('records a generation with usage and cost details from a runtime result', async () => {
    const sdk = fakeSdk();
    const tracer = createTracer({ sdk });
    await tracer.start({ runId: 'r', date: 'd', mode: 'manual' });
    tracer.generation({ name: 'pass-1', model: 'claude-fable-5-1', input: 'prompt', output: '{}', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }, costUsd: 0.05, durationMs: 1200, metadata: { project_url: 'https://a' } });
    const gen = sdk.observations[0].children[0];
    expect(gen.type).to.equal('generation');
    expect(gen.attrs.model).to.equal('claude-fable-5-1');
    expect(gen.attrs.usageDetails).to.deep.equal({
      input: 10, output: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1,
    });
    expect(gen.attrs.costDetails).to.deep.equal({ total: 0.05 });
    expect(gen.ended).to.equal(true);
  });

  it('resolves the trace URL through the client and flushes then shuts down on finish', async () => {
    const sdk = fakeSdk();
    const tracer = createTracer({ sdk });
    await tracer.start({ runId: 'r', date: 'd', mode: 'manual' });
    expect(await tracer.traceUrl()).to.equal('https://langfuse.example.org/project/p1/traces/trace-1');
    await tracer.finish();
    expect(sdk.observations[0].ended).to.equal(true);
    expect(sdk.processor.forceFlush).to.have.been.calledBefore(sdk.otelSdk.shutdown);
  });

  it('falls back to a base-url link when the client cannot resolve the trace URL', async () => {
    const sdk = fakeSdk();
    sdk.client.getTraceUrl.rejects(new Error('offline'));
    const tracer = createTracer({ sdk, baseUrl: 'https://langfuse.example.org' });
    await tracer.start({ runId: 'r', date: 'd', mode: 'manual' });
    expect(await tracer.traceUrl()).to.equal('https://langfuse.example.org/trace/trace-1');
  });
});

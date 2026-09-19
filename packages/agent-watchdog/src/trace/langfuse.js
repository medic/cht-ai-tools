'use strict';
// One trace per run with a span per stage and a generation per model call (FR-049, research.md R-8).
// The Langfuse v5 SDK pieces are injected so tests never touch the network.

const buildSdk = ({ publicKey, secretKey, baseUrl }) => {
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const tracing = require('@langfuse/tracing');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { LangfuseClient } = require('@langfuse/client');
  const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, exportMode: 'immediate' });
  const otelSdk = new NodeSDK({ spanProcessors: [processor] });
  const client = new LangfuseClient({ publicKey, secretKey, baseUrl });
  return { tracing, processor, otelSdk, client };
};

const usageDetails = (usage = {}) => {
  const details = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cache_read_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
  };
  return Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined && v !== null));
};

/**
 * @param {object} options
 * @param {object} [options.sdk] injected { tracing, processor, otelSdk, client }
 * @param {object} [options.config] full configuration (used to build the SDK when not injected)
 * @param {string} [options.baseUrl] Langfuse base URL for the fallback trace link
 */
const createTracer = ({ sdk = null, config = null, baseUrl = null } = {}) => {
  let s = sdk;
  let root = null;
  let traceId = null;
  const base = baseUrl || (config && config.endpoints && config.endpoints.langfuseBaseUrl) || null;

  const start = async ({ runId, date, mode, tags = [], metadata = {} }) => {
    if (!s) {
      s = buildSdk({
        publicKey: config.secrets.langfusePublicKey,
        secretKey: config.secrets.langfuseSecretKey,
        baseUrl: base,
      });
    }
    s.otelSdk.start();
    await s.tracing.propagateAttributes(
      {
        traceName: 'daily-brief',
        sessionId: runId,
        tags: ['agent-watchdog', mode, ...tags],
        metadata: { date, mode, ...metadata },
      },
      async () => {
        root = s.tracing.startObservation('daily-brief', { input: { run_id: runId, date, mode } }, { asType: 'span' });
      },
    );
    traceId = root.traceId;
    return { traceId };
  };

  const stage = async (name, fn) => {
    const span = root.startObservation(name, {}, { asType: 'span' });
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.update({ level: 'ERROR', statusMessage: error.message });
      span.end();
      throw error;
    }
  };

  const generation = ({ name, model, input, output, usage, costUsd, durationMs, metadata = {} }) => {
    const gen = root.startObservation(name, {
      model,
      input,
      output,
      usageDetails: usageDetails(usage),
      costDetails: { total: costUsd },
      metadata: { ...metadata, duration_ms: durationMs },
    }, { asType: 'generation' });
    gen.end();
    return gen;
  };

  const traceUrl = async () => {
    try {
      return await s.client.getTraceUrl(traceId);
    } catch {
      return base ? `${base.replace(/\/$/, '')}/trace/${traceId}` : null;
    }
  };

  const finish = async ({ output } = {}) => {
    if (root) {
      if (output) {
        root.update({ output });
      }
      root.end();
    }
    await s.processor.forceFlush();
    await s.otelSdk.shutdown();
  };

  return {
    start,
    stage,
    generation,
    traceUrl,
    finish,
    get traceId() {
      return traceId; 
    },
  };
};

module.exports = { createTracer, usageDetails };

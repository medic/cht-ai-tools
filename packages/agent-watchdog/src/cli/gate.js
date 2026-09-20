'use strict';
// Adapts the verification module to the per-project gate function the agent stage calls
// (contracts/agent-definition.md): fills in discovery, windows, allow-list, resolver and the attempt counter.
const { buildAllowlist } = require('../links/allowlist');
const { createResolver } = require('../links/resolve');

/**
 * @param {object} options
 * @param {object} options.gateModule the verification module ({ verifyFindings })
 * @param {import('../store/run-dir').RunDir} options.runDir
 * @param {object} options.config
 * @param {Function} [options.fetch] fetch used to resolve non-Grafana links
 * @param {string[]} [options.knownCards] merged pattern card ids
 * @param {boolean} [options.offline] replay: never resolve links over the network (links_resolve then reports
 *   "not resolved (offline)" and passes), so nothing outside the model API is contacted (FR-041)
 */
const createFindingsGate = ({
  gateModule, runDir, config, fetch = globalThis.fetch, knownCards = [], offline = false,
}) => {
  const attempts = new Map();
  const windowsCache = new Map();
  let discoveryPromise = null;
  let resolver = null;
  const allowlist = buildAllowlist(config);
  const grafanaUrl = config.endpoints.grafanaUrl;

  const discovery = () => {
    if (!discoveryPromise) {
      discoveryPromise = runDir.readJson('discovery.json');
    }
    return discoveryPromise;
  };

  const windowsFor = async (slug) => {
    if (!windowsCache.has(slug)) {
      const rel = `${slug}/inputs/windows.json.gz`;
      const doc = runDir.exists(rel) ? await runDir.readGz(rel) : { windows: [] };
      windowsCache.set(slug, Array.isArray(doc) ? doc : doc.windows || []);
    }
    return windowsCache.get(slug);
  };

  return async ({ findings, pass, project, candidates = [], changes = [], toolResultUrls = [] }) => {
    const disc = await discovery();
    if (!offline && !resolver) {
      resolver = createResolver({
        fetch, timeoutMs: config.bounds.httpTimeoutMs, discovery: disc, grafanaUrl, allowlist,
      });
    }
    const key = `${project.slug}#${pass}`;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    return gateModule.verifyFindings({
      findings,
      pass,
      project,
      discovery: disc,
      changes,
      candidates,
      windows: await windowsFor(project.slug),
      toolResultUrls: new Set(toolResultUrls),
      knownCards,
      allowlist,
      attempt,
      resolveLinks: offline ? null : resolver,
      grafanaUrl,
    });
  };
};

module.exports = { createFindingsGate };

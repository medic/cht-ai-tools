'use strict';
// The host allow-list for links is code, not configuration (constitution III, IV; data-model.md "Links").
const STATIC_ENTRIES = [
  'docs.communityhealthtoolkit.org',
  'forum.communityhealthtoolkit.org',
  { host: 'github.com', pathPrefix: '/medic/' },
];

const CONFIG_ENDPOINTS = ['grafanaUrl', 'langfuseBaseUrl', 'specsUrl', 'configUrl', 'docsMcpUrl'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const entryHost = (entry) => (typeof entry === 'string' ? entry : entry.host);

/** Build the allow-list from the static entries and the configured endpoints. */
const buildAllowlist = (config) => {
  const endpoints = (config && config.endpoints) || {};
  const entries = [...STATIC_ENTRIES];
  for (const key of CONFIG_ENDPOINTS) {
    const host = hostOf(endpoints[key]);
    if (host && !entries.some((entry) => entryHost(entry) === host)) {
      entries.push(host);
    }
  }
  return entries;
};

const allowedHosts = (allowlist) => (allowlist || []).map(entryHost);

/** Only https links to listed hosts pass; github.com only under /medic/. */
const isAllowed = (url, allowlist) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (allowlist || []).some((entry) => {
    if (typeof entry === 'string') {
      return entry === host;
    }
    return entry.host === host && parsed.pathname.startsWith(entry.pathPrefix);
  });
};

module.exports = { buildAllowlist, isAllowed, allowedHosts, hostOf, STATIC_ENTRIES };

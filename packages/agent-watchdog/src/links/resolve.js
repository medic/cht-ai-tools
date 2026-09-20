'use strict';
// Link resolution for the gate: Grafana links are checked against the collected dashboards (the UI redirects to
// login), every other link with HEAD then GET, accepting 2xx and 3xx unless the redirect leaves the allow-list.
const { isAllowed, hostOf } = require('./allowlist');
const { flatPanels } = require('../verify/metric-key');

const RETRY_WITH_GET = new Set([405, 501]);

const RULE_TERM = /rule:"([^"]+)"/g;
const INSTANCE_TERM = /label:instance=~"\^\(([^)]*)\)\$"/;

/**
 * An alert-list link resolves when every rule title and host it names was collected this run (FR-070), the same
 * way a dashboard link resolves against the collected dashboards; the UI page itself redirects to login.
 */
const resolveAlertList = (parsed, alerts) => {
  if (!alerts) {
    return { ok: false, status: null, reason: 'no alert data to resolve against' };
  }
  const search = parsed.searchParams.get('search') || '';
  const titles = new Set((alerts.rules || []).map((r) => r.title));
  const hosts = new Set((alerts.instances || []).map((i) => i.host).filter(Boolean));
  for (const match of search.matchAll(RULE_TERM)) {
    if (!titles.has(match[1])) {
      return { ok: false, status: null, reason: `unknown alert rule "${match[1]}"` };
    }
  }
  const instances = INSTANCE_TERM.exec(search);
  if (instances) {
    for (const escaped of instances[1].split('|')) {
      const host = escaped.replace(/\\(.)/g, '$1');
      if (!hosts.has(host)) {
        return { ok: false, status: null, reason: `unknown host ${host} in the alert link` };
      }
    }
  }
  return { ok: true, status: null, reason: 'alert rules and hosts found' };
};

const createResolver = ({ fetch, timeoutMs = 15000, discovery, grafanaUrl, allowlist = null, alerts = null }) => {
  const grafanaHost = hostOf(grafanaUrl);
  const dashboards = new Map(((discovery && discovery.dashboards) || []).map((d) => [d.uid, d]));

  const resolveGrafana = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/alerting/list') {
      return resolveAlertList(parsed, alerts);
    }
    const match = /^\/d\/([^/]+)/.exec(parsed.pathname);
    if (!match) {
      return { ok: false, status: null, reason: 'not a dashboard link' };
    }
    const dashboard = dashboards.get(match[1]);
    if (!dashboard) {
      return { ok: false, status: null, reason: `unknown dashboard ${match[1]}` };
    }
    const viewPanel = parsed.searchParams.get('viewPanel');
    if (viewPanel) {
      const id = Number(viewPanel.replace(/^panel-/, ''));
      if (!flatPanels(dashboard).some((p) => (p.panel_id === undefined ? p.id : p.panel_id) === id)) {
        return { ok: false, status: null, reason: `unknown panel ${id} on dashboard ${dashboard.uid}` };
      }
    }
    return { ok: true, status: null, reason: 'dashboard and panel found' };
  };

  const request = (url, method) => fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });

  const resolveHttp = async (url) => {
    try {
      let response = await request(url, 'HEAD');
      if (RETRY_WITH_GET.has(response.status)) {
        response = await request(url, 'GET');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        const target = location ? new URL(location, url).toString() : null;
        if (allowlist && target && !isAllowed(target, allowlist)) {
          return { ok: false, status: response.status, reason: 'redirected off the allow-list' };
        }
        return { ok: true, status: response.status, reason: 'redirect within the allow-list' };
      }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, reason: 'ok' };
      }
      return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    } catch (error) {
      const timedOut = error && error.name === 'TimeoutError';
      const reason = timedOut ? `timeout after ${timeoutMs}ms` : (error && error.message) || 'failed';
      return { ok: false, status: null, reason };
    }
  };

  return async (urls) => {
    const results = new Map();
    for (const url of new Set(urls || [])) {
      const result = hostOf(url) === grafanaHost ? resolveGrafana(url) : await resolveHttp(url);
      results.set(url, result);
    }
    return results;
  };
};

module.exports = { createResolver, resolveAlertList };

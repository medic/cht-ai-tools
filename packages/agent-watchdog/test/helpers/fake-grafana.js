'use strict';
// A fake Grafana behind global fetch: dashboards, search, annotations and the Prometheus datasource proxy,
// synthesised deterministically from a fixture directory (test/fixtures/runs/<case>/grafana/).
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400;

const crypto = require('node:crypto');

// Deterministic pseudo-random number in [0, 1) derived from a string seed.
const rand = (seed) => {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 4294967296;
};

const parseTime = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return Date.parse(value) / 1000;
};

const FUNCTION_NAMES = new Set([
  'rate', 'increase', 'sum', 'abs', 'max_over_time', 'min_over_time', 'avg_over_time', 'histogram_quantile',
  'time', 'by', 'on', 'without', 'irate', 'delta', 'count', 'max', 'min', 'avg',
]);

const metricNameOf = (expr) => {
  const matches = expr.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/g);
  for (const m of matches) {
    if (!FUNCTION_NAMES.has(m[1])) {
      return m[1];
    }
  }
  const bare = /^\s*([a-zA-Z_:][a-zA-Z0-9_:]*)\s*$/.exec(expr);
  return bare ? bare[1] : null;
};

const labelOf = (expr, label) => {
  const m = new RegExp(`${label}\\s*=~?\\s*"([^"]+)"`).exec(expr);
  return m ? m[1] : null;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const createFakeGrafana = ({
  fixtureDir, baseUrl = 'https://watchdog.example.org', token = 'glsa_test', datasourceUid = 'PBFA97CFB590B2093',
  runStart: runStartOverride = null,
}) => {
  const grafanaDir = path.join(fixtureDir, 'grafana');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(grafanaDir, name), 'utf8'));
  const series = read('series.json');
  // The fixture describes one day; an override replays the same day's shapes at another run start.
  const runStart = Date.parse(runStartOverride || series.run_start) / 1000;
  const calls = [];

  const levelFor = (host, metric, dayIndex) => {
    const def = series.metrics[metric];
    if (!def || !def.levels[host]) {
      return null;
    }
    const { base, noise } = def.levels[host];
    const r = rand(`${host}|${metric}|${dayIndex}`);
    return base * (1 + noise * (r - 0.5) * 2);
  };

  const anomalyFor = (host, metric) => {
    const def = series.metrics[metric];
    return def && def.anomaly && def.anomaly.host === host ? def.anomaly : null;
  };

  const sampleAt = (host, metric, ts) => {
    if (metric === 'up') {
      const down = (series.down || []).includes(host) && ts >= runStart - DAY;
      return down ? 0 : 1;
    }
    const level = levelFor(host, metric, Math.floor(ts / DAY));
    if (level === null || level === undefined) {
      return null;
    }
    const anomaly = anomalyFor(host, metric);
    if (anomaly) {
      const from = runStart - anomaly.hours * 3600;
      if (ts >= from && ts <= runStart) {
        const base = series.metrics[metric].levels[host].base;
        return base + (anomaly.to - base) * ((ts - from) / (anomaly.hours * 3600));
      }
    }
    const def = series.metrics[metric];
    const jitter = level * def.levels[host].noise * 0.25 * (rand(`${host}|${metric}|${ts}`) - 0.5);
    return level + jitter;
  };

  const dailyAt = (host, metric, ts) => {
    if (metric === 'up') {
      return sampleAt(host, metric, ts);
    }
    const anomaly = anomalyFor(host, metric);
    if (anomaly && Math.floor(ts / DAY) === Math.floor(runStart / DAY)) {
      return anomaly.to;
    }
    return levelFor(host, metric, Math.floor(ts / DAY));
  };

  const hostsFor = (expr) => {
    const wanted = labelOf(expr, 'instance');
    if (!wanted) {
      return series.hosts;
    }
    return series.hosts.filter((h) => h === wanted || new RegExp(`^${wanted}$`).test(h));
  };

  const matrix = (expr, start, end, step) => {
    const metric = metricNameOf(expr || '');
    if (!metric) {
      return [];
    }
    const daily = /max_over_time|avg_over_time|min_over_time/.test(expr) && step >= DAY;
    const result = [];
    for (const host of hostsFor(expr)) {
      const values = [];
      for (let ts = start; ts <= end; ts += step) {
        const v = daily ? dailyAt(host, metric, ts) : sampleAt(host, metric, ts);
        if (v !== null && v !== undefined) {
          values.push([ts, String(Number(v.toFixed(3)))]);
        }
      }
      if (values.length) {
        const job = metric === 'up' ? (labelOf(expr, 'job') || 'cht') : 'cht';
        const labels = { __name__: metric, instance: host, job };
        result.push({ metric: labels, values });
      }
    }
    return result;
  };

  const vector = (expr, time) => {
    const metric = metricNameOf(expr || '');
    const result = [];
    for (const host of hostsFor(expr)) {
      if (metric === 'cht_version') {
        const v = (series.versions || {})[host];
        if (v) {
          result.push({ metric: { __name__: metric, instance: host, job: 'cht', ...v }, value: [time, '1'] });
        }
      } else {
        const v = sampleAt(host, metric, time);
        if (v !== null && v !== undefined) {
          const labels = { __name__: metric, instance: host, job: 'cht' };
          result.push({ metric: labels, value: [time, String(Number(v.toFixed(3)))] });
        }
      }
    }
    return result;
  };

  const targets = () => ({
    status: 'success',
    data: {
      activeTargets: series.hosts.map((host) => {
        const down = (series.down || []).includes(host);
        return {
          discoveredLabels: { __address__: `https://${host}` },
          labels: { instance: host, job: 'cht' },
          scrapePool: 'cht',
          scrapeUrl: `http://json-exporter:7979/probe?module=default&target=https%3A%2F%2F${host}%2Fapi%2Fv2%2Fmonitoring`,
          globalUrl: `http://json-exporter:7979/probe?target=https://${host}`,
          lastError: down ? 'Failed to fetch JSON response. TARGET: https://' + host : '',
          lastScrape: new Date(runStart * 1000).toISOString(),
          lastScrapeDuration: 0.42,
          health: down ? 'down' : 'up',
          scrapeInterval: '5m',
          scrapeTimeout: '30s',
        };
      }),
      droppedTargets: [],
    },
  });

  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers((init && init.headers) || {});
    calls.push({
      url: url.toString(),
      method: (init && init.method) || 'GET',
      headers: Object.fromEntries(headers.entries()),
    });
    if (!url.toString().startsWith(baseUrl)) {
      return json({ message: 'unknown host' }, 502);
    }
    if (headers.get('authorization') !== `Bearer ${token}`) {
      return json({ message: 'Unauthorized' }, 401);
    }
    const p = url.pathname;
    const proxyPrefix = `/api/datasources/proxy/uid/${datasourceUid}`;
    if (p === '/api/search') {
      return json(read('search.json'));
    }
    const dash = /^\/api\/dashboards\/uid\/([^/]+)$/.exec(p);
    if (dash) {
      const file = path.join(grafanaDir, 'dashboards', `${dash[1]}.json`);
      if (!fs.existsSync(file)) {
        return json({ message: 'Dashboard not found' }, 404);
      }
      return json(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (p === '/api/annotations') {
      return json(read('annotations.json'));
    }
    if (p.startsWith('/api/datasources/proxy/uid/') && !p.startsWith(proxyPrefix)) {
      return json({ message: 'Data source not found' }, 404);
    }
    if (p === `${proxyPrefix}/api/v1/targets`) {
      return json(targets());
    }
    if (p === `${proxyPrefix}/api/v1/query_range`) {
      const q = url.searchParams;
      const start = parseTime(q.get('start'));
      const end = parseTime(q.get('end'));
      const step = Number(q.get('step')) || 300;
      const result = matrix(q.get('query'), start, end, step);
      return json({ status: 'success', data: { resultType: 'matrix', result } });
    }
    if (p === `${proxyPrefix}/api/v1/query`) {
      const q = url.searchParams;
      const time = parseTime(q.get('time')) || runStart;
      return json({ status: 'success', data: { resultType: 'vector', result: vector(q.get('query'), time) } });
    }
    if (p === `${proxyPrefix}/api/v1/label/instance/values`) {
      return json({ status: 'success', data: series.hosts });
    }
    return json({ message: `no fake route for ${p}` }, 404);
  };

  return { fetch, calls, series, baseUrl, token, datasourceUid, runStart };
};

module.exports = { createFakeGrafana, metricNameOf, labelOf };

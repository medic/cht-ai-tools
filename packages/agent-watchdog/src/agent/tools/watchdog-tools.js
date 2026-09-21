'use strict';
// The enumerated, read-only local tools the model may call (contracts/agent-definition.md).
const { z } = require('zod');
const { sameMetric } = require('../../verify/metric-key');
const { argsHash } = require('./args-hash');
const { enums } = require('../../model/schemas');

const BASE_METRICS = [
  'cht_version', 'cht_conflict_count', 'cht_connected_users_count', 'cht_couchdb_doc_total',
  'cht_couchdb_doc_del_total', 'cht_couchdb_fragmentation', 'cht_couchdb_size_bytes', 'cht_couchdb_update_sequence',
  'cht_couchdb_view_index_size_bytes', 'cht_couchdb_nouveau_index_size_bytes', 'cht_date_current_millis',
  'cht_date_uptime_seconds', 'cht_feedback_total', 'cht_messaging_outgoing_last_hundred',
  'cht_messaging_outgoing_total', 'cht_outbound_push_backlog_count', 'cht_replication_limit_count',
  'cht_sentinel_backlog_count', 'up',
];
// A bare metric name, which is what query_metric queries with.
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
// get_windows reads stored windows and its schema promises the key as the candidates and changes carry it, so it
// accepts a panel expression too, matched under the gate's own key forms (revision 19). The guard is size and
// shape: nothing multi-line, nothing longer than the longest key a dashboard could hold.
const METRIC_KEY_MAX = 200;
const WINDOWS = enums.WindowName.options;
const QUERY_CAP = 20;
const ROLE_LABEL = 'a reviewer';
const IDENTITY_KEYS = new Set(['author', 'user', 'user_id', 'author_id', 'user_name']);

const redactPeople = (value) => {
  if (Array.isArray(value)) {
    return value.map(redactPeople);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k, IDENTITY_KEYS.has(k) ? ROLE_LABEL : redactPeople(v)]);
    return Object.fromEntries(entries);
  }
  return value;
};

const text = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });

/**
 * @param {object} options
 * @param {object} options.deps getWindows(project, metric), queryWindow(project, metric, window),
 *   itemHistory(url, metric, card) and an optional metrics list
 * @param {object} options.project { host, url, slug }
 * @param {object} [options.discovery] { metrics: string[] }
 * @param {object} [options.patternCards] { index: string[] | { card_id }[], read(id) }
 * @param {object} [options.replay] { lookup(tool, argsHash) } to answer from recordings
 * @param {Function} [options.recorder] receives { tool, args, result } after every call
 */
const QUERY_DESCRIPTION = 'Fetch one named window of a metric not already collected for this project. '
  + `Only bare metric names and the windows ${WINDOWS.join(', ')}; at most ${QUERY_CAP} calls per session.`;
const WINDOWS_DESCRIPTION = 'The collected metric windows (current, previous day, previous week, previous cycle, '
  + 'trailing) and the computed change for one metric of this project.';

const createWatchdogTools = ({
  deps, project, discovery = {}, patternCards = { index: [], read: async () => '' }, replay = null, recorder = () => {},
}) => {
  const knownMetrics = new Set([...BASE_METRICS, ...(discovery.metrics || []), ...(deps.metrics || [])]);
  const cardIds = new Set((patternCards.index || []).map((entry) => (
    typeof entry === 'string' ? entry : entry.card_id
  )));
  let queries = 0;

  const run = async (tool, args, fn) => {
    let result;
    if (replay) {
      const recorded = replay.lookup(tool, argsHash(args));
      result = recorded === undefined ? { unavailable: true, reason: 'not recorded' } : recorded;
    } else {
      result = await fn();
    }
    recorder({ tool, args, result });
    return text(result);
  };

  const validMetric = (metric) => typeof metric === 'string' && METRIC_NAME.test(metric) && knownMetrics.has(metric);
  const collectedKey = (metric) => typeof metric === 'string'
    && metric.length <= METRIC_KEY_MAX
    && !/[\n\r]/.test(metric)
    && [...knownMetrics].some((known) => sameMetric(known, metric));

  return [
    {
      name: 'get_windows',
      description: WINDOWS_DESCRIPTION,
      schema: { metric: z.string().describe('Metric key as it appears in the candidates or computed changes') },
      handler: (args) => run('get_windows', args, async () => {
        if (!collectedKey(args.metric)) {
          return { error: `unknown metric: ${String(args.metric).slice(0, 80)}` };
        }
        return deps.getWindows(project, args.metric);
      }),
    },
    {
      name: 'query_metric',
      description: QUERY_DESCRIPTION,
      schema: {
        metric: z.string().describe('Bare metric name such as cht_conflict_count'),
        window: z.string().describe(`One of ${WINDOWS.join(', ')}`),
      },
      handler: (args) => run('query_metric', args, async () => {
        if (!validMetric(args.metric)) {
          return { error: `unknown metric: ${String(args.metric).slice(0, 80)}` };
        }
        if (!WINDOWS.includes(args.window)) {
          const expected = WINDOWS.join(', ');
          return { error: `unknown window: ${String(args.window).slice(0, 40)}; expected one of ${expected}` };
        }
        if (queries >= QUERY_CAP) {
          return { error: `query_metric call cap of ${QUERY_CAP} reached for this session` };
        }
        queries += 1;
        return deps.queryWindow(project, args.metric, args.window);
      }),
    },
    {
      name: 'read_pattern_card',
      description: 'The full text of a merged pattern card from the index in your system prompt.',
      schema: { card_id: z.string().describe('Card id from the pattern-card index') },
      handler: (args) => run('read_pattern_card', args, async () => {
        if (!cardIds.has(args.card_id)) {
          return { error: `unknown card: ${String(args.card_id).slice(0, 80)}` };
        }
        return { card_id: args.card_id, text: await patternCards.read(args.card_id) };
      }),
    },
    {
      name: 'get_item_history',
      description: 'Past accepted items and the feedback they received for this project, metric and pattern card.',
      schema: {
        metric: z.string().describe('Metric key'),
        pattern_card: z.string().nullable().describe('Card id or null'),
      },
      handler: (args) => run('get_item_history', args, async () => {
        const card = args.pattern_card === undefined ? null : args.pattern_card;
        const history = await deps.itemHistory(project.url, args.metric, card);
        return { history: redactPeople(history || []) };
      }),
    },
  ];
};

module.exports = { createWatchdogTools, argsHash, BASE_METRICS, WINDOWS, QUERY_CAP, redactPeople };

'use strict';
// `agent-watchdog egress [--format json|hosts]` (FR-083, contracts/cli.md): the destinations a run contacts, from
// the effective configuration, for the platform's network policy. Needs no secrets and no policy files; an endpoint
// left unset is left out. Exit 0; an unknown format is a usage error.
const codes = require('../exit-codes');
const { loadConfig } = require('../../config/load');
const { writeResult } = require('../streams');
const { egressDocument } = require('../../net/egress');

const FORMATS = ['json', 'hosts'];
const USAGE = 'usage: agent-watchdog egress [--format json|hosts]';

module.exports = async function egress({ flags = {}, env = process.env, stdout = process.stdout, logger = null }) {
  const format = flags.format || 'json';
  if (!FORMATS.includes(format)) {
    throw new codes.ExitError(codes.USAGE, `${USAGE}: unknown format "${format}"`);
  }
  const { config } = loadConfig({ env, flags, command: 'egress', withPolicy: false });
  const document = egressDocument(config, { version: require('../../../package.json').version });
  if (logger) {
    logger.info('egress.listed', { endpoints: document.endpoints.length, format });
  }
  writeResult(stdout, format === 'hosts' ? document.endpoints.map((e) => e.host).join('\n') : document);
  return codes.OK;
};

module.exports.FORMATS = FORMATS;

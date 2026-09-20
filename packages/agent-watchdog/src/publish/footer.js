'use strict';
// The brief footer (FR-019, US3 scenario 1): links to the prompts and the deployment configuration, the run's
// trace, and its cost in currency. Built by code from configuration; the model never sees or writes it.
const round6 = (value) => Number(Number(value || 0).toFixed(6));

/** @returns {{ prompts_url: string, config_url: string, trace_url: string|null, cost_usd: number }} */
const buildFooter = ({ config, traceUrl = null, costUsd = 0 }) => ({
  prompts_url: config.endpoints.promptsUrl,
  config_url: config.endpoints.configUrl,
  trace_url: traceUrl || null,
  cost_usd: round6(costUsd),
});

/** US dollars with two decimals, the way the footer shows cost. */
const formatCost = (costUsd) => `$${Number(costUsd || 0).toFixed(2)}`;

module.exports = { buildFooter, formatCost, round6 };

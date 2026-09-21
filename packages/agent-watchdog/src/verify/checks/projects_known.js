'use strict';
const { HOST_LIKE_PATTERN, isProjectLikeHost } = require('../patterns');
const { allowedHosts } = require('../../links/allowlist');
const { proseOnly } = require('../format');

const NAME = 'projects_known';

const discoveredHosts = (ctx) => new Set((ctx.discovery.projects || []).map((p) => p.host.toLowerCase()));

const exemptHosts = (ctx) => new Set([
  ...discoveredHosts(ctx),
  ...allowedHosts(ctx.allowlist || []).map((h) => h.toLowerCase()),
]);

/**
 * A host written as the leading two or more labels of a discovered host names that project (revision 23): a bullet
 * has 120 characters, and the model shortens `cht.north.prod.example.org` to `cht.north.prod`. A bare domain or the
 * trailing labels name no project.
 */
const namesDiscoveredHost = (token, discovered) => token.split('.').length >= 2
  && [...discovered].some((host) => host === token || host.startsWith(`${token}.`));

const undiscoveredHosts = (text, exempt, discovered = new Set()) => {
  const found = new Set();
  for (const match of proseOnly(text).matchAll(HOST_LIKE_PATTERN)) {
    const token = match[0].toLowerCase();
    if (isProjectLikeHost(token) && !exempt.has(token) && !namesDiscoveredHost(token, discovered)) {
      found.add(token);
    }
  }
  return [...found];
};

const check = (ctx) => {
  const reasons = [];
  const exempt = exemptHosts(ctx);
  const discovered = discoveredHosts(ctx);
  const texts = [];
  if (ctx.mode === 'brief') {
    texts.push(['headline', ctx.draft.headline]);
    (ctx.draft.bullets || []).forEach((b, i) => texts.push([`bullets[${i}]`, b.text]));
  } else {
    const urls = new Set((ctx.discovery.projects || []).map((p) => p.url));
    if (!urls.has(ctx.findings.project_url)) {
      reasons.push(`project_url ${ctx.findings.project_url} is not a discovered project`);
    }
    if (ctx.project && ctx.findings.project_url !== ctx.project.url) {
      reasons.push(`project_url ${ctx.findings.project_url} is not the project of this session (${ctx.project.url})`);
    }
    (ctx.items || []).forEach((item, i) => {
      texts.push([`items[${i}].why_now`, item.why_now]);
      texts.push([`items[${i}].suggested_check`, item.suggested_check]);
    });
    texts.push(['notes', ctx.findings.notes]);
  }
  for (const [where, text] of texts) {
    for (const host of undiscoveredHosts(text, exempt, discovered)) {
      reasons.push(`${where} names ${host}, which is not a discovered project`);
    }
  }
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons: [...new Set(reasons)] };
};

module.exports = { name: NAME, check, namesDiscoveredHost };

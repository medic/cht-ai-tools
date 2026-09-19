'use strict';
// URLs that appeared in tool results this run; only these may be cited as reference_urls (FR-016).
const SOURCE_LINE = /Source:\s*(https?:\/\/\S+)/g;
const MARKDOWN_LINK = /\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"')\]]+/g;

const clean = (url) => url.replace(/[.,;:]+$/, '');

const textOf = (call) => {
  const body = ['output', 'response', 'result', 'content'].map((key) => call[key]).find((v) => v !== undefined);
  if (body === undefined) {
    return '';
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
};

const collectToolResultUrls = (toolCalls) => {
  const urls = new Set();
  for (const call of toolCalls || []) {
    const text = textOf(call || {});
    for (const pattern of [SOURCE_LINE, MARKDOWN_LINK]) {
      for (const match of text.matchAll(pattern)) {
        urls.add(clean(match[1]));
      }
    }
    for (const match of text.matchAll(BARE_URL)) {
      urls.add(clean(match[0]));
    }
  }
  return urls;
};

module.exports = { collectToolResultUrls };

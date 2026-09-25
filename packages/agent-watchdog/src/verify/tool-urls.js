'use strict';
// URLs that appeared in tool results this run; only these may be cited as reference_urls (FR-016). Read from
// every text of a result, structured or plain (revision 34): a JSON encoding of a multi-line text would turn its
// line breaks into `\\n` and glue the next line onto a URL.
const SOURCE_LINE = /Source:\s*(https?:\/\/[^\s<>"')\]\\]+)/g;
const MARKDOWN_LINK = /\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"')\]\\]+/g;

const { walkStrings } = require('./walk');

const clean = (url) => url.replace(/[.,;:]+$/, '');

const RESULT_KEYS = ['output', 'response', 'result', 'content', 'tool_response'];

/** Every string of the call's result, depth first (the gate's walker, src/verify/walk.js). */
const textsOf = (call) => {
  const key = RESULT_KEYS.find((name) => call[name] !== undefined);
  const out = [];
  if (key !== undefined) {
    walkStrings(call[key], (text) => out.push(text));
  }
  return out;
};

const urlsInText = (text) => {
  const urls = new Set();
  for (const pattern of [SOURCE_LINE, MARKDOWN_LINK]) {
    for (const match of text.matchAll(pattern)) {
      urls.add(clean(match[1]));
    }
  }
  for (const match of text.matchAll(BARE_URL)) {
    urls.add(clean(match[0]));
  }
  return urls;
};

const collectToolResultUrls = (toolCalls) => {
  const urls = new Set();
  for (const call of toolCalls || []) {
    for (const text of textsOf(call || {})) {
      for (const url of urlsInText(text)) {
        urls.add(url);
      }
    }
  }
  return urls;
};

module.exports = { collectToolResultUrls };

'use strict';
const { EMAIL_PATTERN, phoneMatches } = require('../patterns');
const { walkStrings } = require('../walk');
const { allowedValues, givenNumerals } = require('./numbers_match');

const NAME = 'personal_data_absent';

const ITEM_PATH = /^\$\.items\[(\d+)\]/;
const BULLET_PATH = /^\$\.bullets\[(\d+)\]/;

/**
 * The computed values the item at this path may quote, as integers (revision 22): a run of nine or more digits that
 * equals one of them is a document or byte count, not a telephone number. Outside an item there is nothing to
 * compare with, so the set is empty and the rule is unchanged.
 */
const computedIntegersFor = (ctx, path) => {
  let item = null;
  const inItem = ITEM_PATH.exec(path);
  if (inItem) {
    item = (ctx.items || [])[Number(inItem[1])] || null;
  }
  const inBullet = BULLET_PATH.exec(path);
  if (inBullet && ctx.draft) {
    const bullet = (ctx.draft.bullets || [])[Number(inBullet[1])];
    item = bullet ? (ctx.items || []).find((i) => i.item_id === bullet.item_id) || null : null;
  }
  if (!item) {
    return new Set();
  }
  return new Set(allowedValues(item, ctx).map((a) => String(Math.round(Number(a.value)))));
};

/**
 * The numerals the model was given, as bare integers (revision 25): for findings every prompt and tool result of the
 * session (`givenText`); for a bullet the run-wide texts and its own item's entry (`itemTexts`), never a neighbour's.
 * A digit run the model read is a value it copied, not a telephone number, whatever its length.
 */
const givenIntegersFor = (ctx, path) => {
  const texts = [...(ctx.givenText || [])];
  const inBullet = BULLET_PATH.exec(path);
  if (inBullet && ctx.draft && ctx.itemTexts && typeof ctx.itemTexts.get === 'function') {
    const bullet = (ctx.draft.bullets || [])[Number(inBullet[1])];
    const own = bullet ? ctx.itemTexts.get(bullet.item_id) : null;
    if (own) {
      texts.push(own);
    }
  }
  return givenNumerals(texts);
};

/** The digits of each phone-shaped run in the text that is neither a computed value for its item nor a given one. */
const phoneNumbersIn = (text, computed, given = new Set()) => phoneMatches(text)
  .map((match) => match.replace(/\D/g, ''))
  .filter((digits) => !computed.has(digits) && !given.has(digits));

// Identifier fields hold hashes and ids the code derived; an all-digit hex id is not a phone number.
const ID_FIELD = /\.(candidate_ids?|item_id|thread_order|dashboard_uid|session_id|pattern_card)(\[\d+\])?$/;
const HEX_ID = /^[0-9a-f]{12,64}$/;

const publishedSurface = (draft) => ({
  headline: draft && draft.headline,
  bullets: draft && draft.bullets,
  expected_load_notice: draft && draft.expected_load_notice,
});

const check = (ctx) => {
  const reasons = [];
  const exempt = new Set((ctx.discovery && ctx.discovery.projects || []).map((p) => p.host));
  // A brief draft is checked on its published surface only: proposals and the memory update never reach
  // Slack, and code masks and flags identifiers in them instead of rejecting the brief (FR-033, US4 scenario 3).
  const document = ctx.mode === 'brief' ? publishedSurface(ctx.draft) : ctx.findings;
  walkStrings(document, (text, path) => {
    if (exempt.has(text) || ID_FIELD.test(path) || HEX_ID.test(text)) {
      return;
    }
    if (EMAIL_PATTERN.test(text)) {
      reasons.push(`e-mail address at ${path}`);
    }
    // The reason names the digits, so a revision can find what to remove (revision 25).
    for (const digits of phoneNumbersIn(text, computedIntegersFor(ctx, path), givenIntegersFor(ctx, path))) {
      reasons.push(`phone number ${digits} at ${path}`);
    }
  });
  return { name: NAME, status: reasons.length ? 'fail' : 'pass', reasons };
};

module.exports = { name: NAME, check };

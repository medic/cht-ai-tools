'use strict';
// The audience is an explicit parameter of every render and publish step, never inferred (constitution VIII).
const AUDIENCES = Object.freeze(['internal', 'partner']);
const SUPPORTED = Object.freeze(['internal']);

const assertAudience = (audience) => {
  if (!AUDIENCES.includes(audience)) {
    throw new Error(`unknown audience "${audience}"; expected one of ${AUDIENCES.join(', ')}`);
  }
  if (!SUPPORTED.includes(audience)) {
    throw new Error(`audience "${audience}" is not supported by this feature; partner output is feature 002`);
  }
  return audience;
};

module.exports = { AUDIENCES, SUPPORTED, assertAudience };

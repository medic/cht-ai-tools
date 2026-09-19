// Shared mocha setup: chai plugins, sinon sandbox restore, and a network guard.
// Root hooks use mocha's root-hook-plugin form because this file is loaded with --require.
const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(sinonChai);
chai.use(chaiAsPromised);

global.expect = chai.expect;
global.sinon = sinon;

const realFetch = global.fetch;
const networkGuard = () => {
  throw new Error('network access is not allowed in unit tests; stub fetch or use test/helpers');
};

// Tests that deliberately need the real fetch (none in the unit suite) can call this.
global.allowRealFetch = () => {
  global.fetch = realFetch; 
};

exports.mochaHooks = {
  beforeEach() {
    global.fetch = networkGuard; 
  },
  afterEach() {
    sinon.restore(); global.fetch = networkGuard; 
  },
};

const fs = require('node:fs');
const path = require('node:path');
const { renderImage } = require('../../src/render/browser');
const { tempDir, removeDir } = require('../helpers/fixtures');
const { quietLogger } = require('../rollup/factories');

const fakeLauncher = ({ screenshotError } = {}) => {
  const route = { abort: sinon.stub().resolves() };
  const screenshot = screenshotError
    ? sinon.stub().rejects(screenshotError)
    : sinon.stub().resolves(Buffer.from('PNG'));
  const locator = { screenshot };
  const page = {
    route: sinon.stub().resolves(),
    setContent: sinon.stub().resolves(),
    locator: sinon.stub().returns(locator),
  };
  const context = { newPage: sinon.stub().resolves(page), close: sinon.stub().resolves() };
  const browser = { newContext: sinon.stub().resolves(context), close: sinon.stub().resolves() };
  const launcher = { launch: sinon.stub().resolves(browser) };
  return { launcher, browser, context, page, locator, route };
};

describe('render/browser', () => {
  let dir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it('launches headless in an isolated context, blocks every request and screenshots the summary', async () => {
    const fake = fakeLauncher();
    const outputPath = path.join(dir, 'rollup', 'brief.png');
    await renderImage({
      html: '<html></html>',
      browserLauncher: fake.launcher,
      executablePath: '/usr/bin/chromium',
      outputPath,
      logger: quietLogger(),
    });
    expect(fake.launcher.launch).to.have.been.calledWithMatch({ headless: true, executablePath: '/usr/bin/chromium' });
    expect(fake.browser.newContext).to.have.been.calledWithMatch({ javaScriptEnabled: false, offline: true });
    expect(fake.page.route.firstCall.args[0]).to.equal('**/*');
    await fake.page.route.firstCall.args[1](fake.route);
    expect(fake.route.abort).to.have.been.calledOnce;
    expect(fake.page.setContent).to.have.been.calledWith('<html></html>', { waitUntil: 'load' });
    expect(fake.page.locator).to.have.been.calledWith('#brief-summary');
    expect(fake.locator.screenshot).to.have.been.calledWithMatch({ type: 'png' });
    expect(fs.readFileSync(outputPath).toString()).to.equal('PNG');
    expect(fake.browser.close).to.have.been.calledOnce;
  });

  it('omits executablePath when none is configured', async () => {
    const fake = fakeLauncher();
    await renderImage({
      html: '<p/>', browserLauncher: fake.launcher, outputPath: path.join(dir, 'x.png'), logger: quietLogger(),
    });
    expect(fake.launcher.launch.firstCall.args[0]).to.not.have.property('executablePath');
  });

  it('closes the browser and rethrows when the screenshot fails', async () => {
    const fake = fakeLauncher({ screenshotError: new Error('render failed') });
    const attempt = renderImage({
      html: '<p/>', browserLauncher: fake.launcher, outputPath: path.join(dir, 'x.png'), logger: quietLogger(),
    });
    await expect(attempt).to.be.rejectedWith('render failed');
    expect(fake.browser.close).to.have.been.calledOnce;
  });
});

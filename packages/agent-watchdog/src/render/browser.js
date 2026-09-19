'use strict';
// Screenshot of the report's summary element in a headless browser with scripting and network off (FR-023).
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_SELECTOR = '#brief-summary';

const defaultLauncher = () => require('playwright-core').chromium;

/**
 * Render `html` and screenshot `selector` to `outputPath`.
 * @param {object} options html, browserLauncher (a playwright BrowserType-like object), executablePath,
 *   outputPath, selector, logger
 * @returns {Promise<{ path: string, bytes: number }>}
 */
const renderImage = async ({
  html, browserLauncher = null, executablePath = null, outputPath, selector = DEFAULT_SELECTOR, logger = null,
}) => {
  const launcher = browserLauncher || defaultLauncher();
  const launchOptions = { headless: true };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  const browser = await launcher.launch(launchOptions);
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width: 900, height: 1400 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.locator(selector).screenshot({ type: 'png' });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);
    if (logger) {
      logger.info('render.image', { path: outputPath, bytes: buffer.length });
    }
    return { path: outputPath, bytes: buffer.length };
  } finally {
    await browser.close();
  }
};

module.exports = { renderImage, DEFAULT_SELECTOR };

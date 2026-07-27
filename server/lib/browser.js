import config from './config.js';
import { log } from './logger.js';

/**
 * Single shared Chromium instance.
 *
 * Both the scanner and the PDF renderer need a browser, and launching one costs
 * roughly 300-500ms plus ~120MB. Sharing one process across both — with a fresh
 * isolated context per job — keeps memory flat and makes report generation
 * effectively free once the first scan has warmed the browser.
 *
 * The instance is lazily created, health-checked on every use, and transparently
 * relaunched if it dies (OOM-killed containers are the usual cause).
 */

let browserPromise = null;

async function loadChromium() {
  try {
    // Present in local development; ships its own browser binary.
    return (await import('playwright')).chromium;
  } catch {
    // Production image supplies the binary via CHROMIUM_PATH.
    return (await import('playwright-core')).chromium;
  }
}

export async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing?.isConnected()) return existing;
    browserPromise = null;
  }

  browserPromise = (async () => {
    const chromium = await loadChromium();
    const browser = await chromium.launch({
      executablePath: config.scanner.executablePath,
      args: [
        // Required in most containers, which lack the kernel features the
        // sandbox needs. Safe here because every page we open is isolated and
        // untrusted content never shares a context with our own.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--site-per-process',
        '--disable-background-networking',
        '--disable-extensions',
        '--mute-audio',
      ],
    });
    browser.on('disconnected', () => {
      log.warn('Chromium disconnected — will relaunch on next use');
      browserPromise = null;
    });
    log.info('Chromium launched');
    return browser;
  })();

  return browserPromise;
}

/** Alias that documents intent at the PDF call site. */
export const getBrowserForRendering = getBrowser;

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}

export default { getBrowser, getBrowserForRendering, closeBrowser };

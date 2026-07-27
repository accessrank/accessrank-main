import config, { assertProductionConfig, readiness } from './lib/config.js';
import { log } from './lib/logger.js';
import { getStore } from './lib/store.js';
import { closeBrowser } from './lib/browser.js';
import app from './app.js';

/**
 * Production entry point: validate configuration, listen, and shut down cleanly.
 * The app itself is built in app.js so it can be mounted by tests without any
 * of this happening.
 */

assertProductionConfig();

const server = app.listen(config.port, () => {
  const status = readiness();
  log.info(`Accessrank listening on :${config.port}`, { env: config.env, site: config.siteUrl });
  if (status.missing.length && !config.isProd) {
    log.warn(`Running with reduced functionality. Unset: ${status.missing.join(', ')}`);
  }
});

// Warm the store at boot so a bad DATABASE_URL fails now, not on a visitor's request.
getStore().catch((err) => {
  log.error('store unavailable at boot', { err: err.message });
  if (config.isProd) process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down`);

  // Stop accepting connections, then release Chromium and the connection pool.
  await new Promise((resolve) => server.close(resolve));
  await closeBrowser();
  const store = await getStore().catch(() => null);
  if (store?.close) await store.close().catch(() => {});

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));

export default app;

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config, { assertProductionConfig, readiness } from './lib/config.js';
import { log, requestId } from './lib/logger.js';
import { getStore } from './lib/store.js';
import { closeBrowser } from './lib/browser.js';
import api from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

assertProductionConfig();

const app = express();
app.disable('x-powered-by');

/**
 * Trust exactly as many proxy hops as are actually in front of us.
 *
 * `trust proxy: true` would accept any X-Forwarded-For a client sends, letting
 * anyone mint unlimited quota by spoofing the header. A fixed hop count means
 * only the address our own load balancer appended is believed.
 */
app.set('trust proxy', config.trustProxy);

/* ------------------------------------------------------------- headers --- */

const scriptSrc = ["'self'"];
const frameSrc = ["'none'"];
const connectSrc = ["'self'"];

if (config.turnstile.enabled) {
  scriptSrc.push('https://challenges.cloudflare.com');
  frameSrc.length = 0;
  frameSrc.push('https://challenges.cloudflare.com');
  connectSrc.push('https://challenges.cloudflare.com');
}
if (config.analytics.plausibleDomain) {
  const origin = new URL(config.analytics.plausibleSrc).origin;
  scriptSrc.push(origin);
  connectSrc.push(origin);
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      // Fonts are self-hosted, so no font CDN needs allowing — which also keeps
      // visitor IPs from reaching a third party, as the privacy policy promises.
      fontSrc: ["'self'"],
      // No inline styles: the build emits one hashed stylesheet.
      styleSrc: ["'self'"],
      scriptSrc,
      scriptSrcAttr: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc,
      frameSrc,
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

/* ----------------------------------------------------------- plumbing --- */

app.use((req, res, next) => {
  req.id = requestId();
  res.setHeader('X-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || res.statusCode >= 400) {
      log.debug('request', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
    }
  });
  next();
});

// A 100kB ceiling is far above any legitimate form and far below anything that
// could be used to exhaust memory.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

/**
 * Reject cross-origin API calls. The forms are same-origin, so anything else is
 * either a misconfiguration or someone else's page driving our endpoints.
 */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const allowed = new Set([config.siteUrl, ...config.security.allowedOrigins]);
  const origin = req.get('origin');
  if (!origin) return next(); // curl and server-to-server callers send none.
  if (allowed.has(origin.replace(/\/+$/, ''))) return next();
  if (!config.isProd && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return next();

  log.warn('cross-origin API call refused', { origin });
  return res.status(403).json({ ok: false, code: 'bad_origin', error: 'Request blocked.' });
});

/* -------------------------------------------------------- rate limits --- */

const ipKey = (req) => req.ip ?? 'unknown';

// Coarse ceiling so no single address can flood the API, independent of the
// business quotas enforced in the database.
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { ok: false, code: 'too_many_requests', error: 'Too many requests. Please slow down.' },
}));

// Scans are the expensive path: a burst cap on top of the daily quota.
app.use('/api/scan', rateLimit({
  windowMs: 60_000,
  limit: config.limits.scanBurstPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: {
    ok: false,
    code: 'scan_burst_limit',
    error: 'That is a lot of scans at once. Wait a minute and try again.',
  },
}));

app.use('/api/report', rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { ok: false, code: 'too_many_requests', error: 'Too many attempts. Please wait a moment.' },
}));

/* ---------------------------------------------------------------- api --- */

app.use('/api', api);

/* ------------------------------------------------------------- static --- */

if (!fs.existsSync(DIST)) {
  log.warn(`dist/ not found at ${DIST} — run "npm run build" to generate the site.`);
}

// Hashed assets are immutable; everything else revalidates.
app.use('/assets', express.static(path.join(DIST, 'assets'), {
  maxAge: '1y',
  immutable: true,
  fallthrough: true,
}));

app.use(express.static(DIST, {
  extensions: ['html'],
  maxAge: '1h',
  redirect: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  },
}));

/** Serve /about from dist/about/index.html without a trailing-slash redirect. */
app.get(/^\/[\w/-]*$/, (req, res, next) => {
  const candidate = path.join(DIST, req.path, 'index.html');
  if (candidate.startsWith(DIST) && fs.existsSync(candidate)) return res.sendFile(candidate);
  return next();
});

app.use((req, res) => {
  const notFound = path.join(DIST, '404.html');
  res.status(404);
  if (fs.existsSync(notFound)) return res.sendFile(notFound);
  return res.type('text/plain').send('Not found');
});

app.use((err, req, res, _next) => {
  log.error('unhandled error', { err: err.message, id: req.id, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  res.status(500).json({ ok: false, error: 'Something went wrong on our side.' });
});

/* -------------------------------------------------------------- boot --- */

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

async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  server.close();
  await closeBrowser();
  const store = await getStore().catch(() => null);
  if (store?.close) await store.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));

export default app;

/**
 * Express application, with no side effects on import.
 *
 * Kept separate from index.js so the integration tests can mount the real app
 * on an ephemeral port without starting the production listener, the store
 * warm-up or the signal handlers.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config, { readiness } from './lib/config.js';
import { log, requestId } from './lib/logger.js';
import api from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

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

/**
 * The build inlines the stylesheet into every page's <head> to cut the
 * render-blocking request, and records the block's sha256 in dist/csp.json.
 * Allowing that exact hash — never 'unsafe-inline' — keeps the "no inline
 * styles except the one the build produced" guarantee. If the manifest is
 * missing (dist not built yet), style-src stays 'self' alone and the health
 * endpoint's site:false will already be flagging the missing build.
 */
const styleSrc = ["'self'"];
let builtWithTurnstile = false;
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'csp.json'), 'utf8'));
  if (typeof manifest.styleHash === 'string' && /^sha256-[A-Za-z0-9+/=]+$/.test(manifest.styleHash)) {
    styleSrc.push(`'${manifest.styleHash}'`);
  }
  builtWithTurnstile = manifest.turnstileInMarkup === true;
} catch { /* no dist yet — dev without a build, or tests that never serve pages */ }

// CSP must match what the SERVED PAGES contain, and the widget markup is baked
// at build time — so the build's manifest gets a vote, not only this server's
// own env. Otherwise a keyed build behind a keyless server (integration tests,
// local smoke runs) logs a CSP violation on every page load.
if (config.turnstile.enabled || builtWithTurnstile) {
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
      // 'self' plus the sha256 of the one <style> block the build inlines.
      styleSrc,
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

/**
 * These are burst ceilings only — the business quotas from the brief live in the
 * database (server/lib/quota.js), because they must survive a restart and be
 * consistent across processes.
 *
 * The default key generator is used deliberately. A custom `req.ip` key looks
 * equivalent but groups IPv6 by full address, and a residential IPv6 subscriber
 * holds an entire /64 — so a single visitor could rotate through addresses and
 * never hit the limit. The library's default buckets IPv6 by subnet.
 */
const burst = (limit, code, error) => rateLimit({
  windowMs: 60_000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code, error },
});

// Coarse ceiling so no single address can flood the API.
app.use('/api', burst(config.limits.apiBurstPerMinute, 'too_many_requests', 'Too many requests. Please slow down.'));

// Scans are the expensive path: a burst cap on top of the daily quota.
app.use('/api/scan', burst(
  config.limits.scanBurstPerMinute,
  'scan_burst_limit',
  'That is a lot of scans at once. Wait a minute and try again.',
));

app.use('/api/report', burst(
  config.limits.reportBurstPerMinute,
  'too_many_requests',
  'Too many attempts. Please wait a moment.',
));

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

export default app;

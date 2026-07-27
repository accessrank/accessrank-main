import 'dotenv/config';

/**
 * Central configuration. Every tunable lives here so nothing is hardcoded
 * deep in a handler. Values are read once at boot and frozen.
 *
 * The app is designed to boot and serve the marketing site even when the
 * optional integrations (Postgres, Resend, Turnstile) are unconfigured —
 * in that case the audit funnel degrades gracefully instead of 500-ing.
 * `config.readiness` reports exactly what is missing.
 */

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const list = (v, fallback = []) =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
    ? (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    : fallback;

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const config = Object.freeze({
  env: NODE_ENV,
  isProd,
  port: int(env.PORT, 3000),

  /** Public origin, used for canonical URLs, OG tags, sitemap and PDF asset resolution. */
  siteUrl: (env.SITE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, ''),

  /** Number of reverse proxies in front of the app. Critical for correct client IPs.
   *  Fly.io / Render / Railway / Cloudflare all put exactly 1 hop in front. */
  trustProxy: int(env.TRUST_PROXY, 1),

  db: {
    url: env.DATABASE_URL || '',
    /** Supabase and most managed PG require TLS but present a non-public CA chain. */
    ssl: bool(env.DATABASE_SSL, /supabase|neon|render|railway|amazonaws/.test(env.DATABASE_URL || '')),
    maxConnections: int(env.DATABASE_POOL_MAX, 8),
  },

  email: {
    provider: env.EMAIL_PROVIDER || 'resend',
    resendApiKey: env.RESEND_API_KEY || '',
    from: env.EMAIL_FROM || 'Accessrank <reports@accessrank.ai>',
    replyTo: env.EMAIL_REPLY_TO || 'info@accessrank.ai',
    /** Internal address that receives a copy of every new lead. */
    salesInbox: env.SALES_INBOX || 'info@accessrank.ai',
  },

  turnstile: {
    siteKey: env.TURNSTILE_SITE_KEY || '',
    secretKey: env.TURNSTILE_SECRET_KEY || '',
    get enabled() {
      return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
    },
  },

  scanner: {
    /** Hard ceiling on a single page load. Chromium is the expensive resource. */
    navigationTimeoutMs: int(env.SCAN_NAV_TIMEOUT_MS, 20_000),
    /** Total budget for one scan including axe execution. */
    totalTimeoutMs: int(env.SCAN_TOTAL_TIMEOUT_MS, 45_000),
    /** Concurrent scans. Each holds a browser context (~80-150MB). */
    concurrency: int(env.SCAN_CONCURRENCY, 2),
    /** Depth of the crawl. 1 = the submitted page only. */
    maxPages: int(env.SCAN_MAX_PAGES, 3),
    viewport: { width: int(env.SCAN_VIEWPORT_W, 1440), height: int(env.SCAN_VIEWPORT_H, 900) },
    userAgent:
      env.SCAN_USER_AGENT ||
      'Mozilla/5.0 (compatible; AccessrankBot/1.0; +https://accessrank.ai/bot)',
    /** Reuse a scan result for the same origin for this long. Protects cost and latency. */
    cacheTtlHours: int(env.SCAN_CACHE_TTL_HOURS, 24),
    /** Chromium executable. Empty = use the Playwright-managed download. */
    executablePath: env.CHROMIUM_PATH || undefined,
  },

  limits: {
    /** Lifetime cap on emailed reports per normalized email address. */
    reportsPerEmail: int(env.LIMIT_REPORTS_PER_EMAIL, 1),
    /** Rolling-24h cap on report requests per client IP. */
    reportsPerIpPerDay: int(env.LIMIT_REPORTS_PER_IP_PER_DAY, 3),
    /** Rolling-24h cap on scans per client IP. Scans are free to the user but not to us. */
    scansPerIpPerDay: int(env.LIMIT_SCANS_PER_IP_PER_DAY, 8),
    /** Burst protection, independent of the daily quotas. */
    scanBurstPerMinute: int(env.LIMIT_SCAN_BURST_PER_MIN, 3),
    reportBurstPerMinute: int(env.LIMIT_REPORT_BURST_PER_MIN, 5),
    apiBurstPerMinute: int(env.LIMIT_API_BURST_PER_MIN, 60),
  },

  security: {
    /** Salt for hashing client IPs. MUST be set in production and MUST NOT rotate
     *  casually — rotating it resets every per-IP quota. */
    ipHashSalt: env.IP_HASH_SALT || '',
    /** Bearer token guarding /api/admin/*. */
    adminToken: env.ADMIN_TOKEN || '',
    /** Hosts the scanner is never allowed to touch, on top of the IP-range blocklist. */
    scanBlocklist: list(env.SCAN_HOST_BLOCKLIST, []),
    /** When set, only these origins may call the API (browser CORS + Origin check). */
    allowedOrigins: list(env.ALLOWED_ORIGINS, []),

    /**
     * Allow the scanner to reach loopback and private addresses.
     *
     * This exists solely so the integration tests can scan a fixture server on
     * 127.0.0.1. It is ANDed with `!isProd`, so setting SCAN_ALLOW_PRIVATE=1 in
     * a production environment has no effect — the SSRF guard cannot be turned
     * off on a deployed instance even by mistake.
     */
    allowPrivateTargets: !isProd && bool(env.SCAN_ALLOW_PRIVATE, false),
  },

  analytics: {
    /** Cookieless analytics only — a cookie banner would be required otherwise. */
    plausibleDomain: env.PLAUSIBLE_DOMAIN || '',
    plausibleSrc: env.PLAUSIBLE_SRC || 'https://plausible.io/js/script.js',
  },

  features: {
    /** Social proof stays off until real, attributable customer quotes exist. */
    testimonials: bool(env.FEATURE_TESTIMONIALS, false),
  },
});

/** Machine-readable picture of which subsystems are usable. Surfaced at /api/health. */
export function readiness() {
  const missing = [];
  if (!config.db.url) missing.push('DATABASE_URL');
  if (!config.email.resendApiKey) missing.push('RESEND_API_KEY');
  if (!config.security.ipHashSalt) missing.push('IP_HASH_SALT');
  if (config.isProd && !config.turnstile.enabled) missing.push('TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY');
  if (config.isProd && !config.security.adminToken) missing.push('ADMIN_TOKEN');

  return {
    site: true,
    scanner: true,
    database: Boolean(config.db.url),
    email: Boolean(config.email.resendApiKey),
    captcha: config.turnstile.enabled,
    /** The lead funnel needs storage + delivery + a stable IP salt to be honest about limits. */
    leadFunnel: Boolean(config.db.url && config.email.resendApiKey && config.security.ipHashSalt),
    missing,
  };
}

/** Fail fast in production rather than silently running an insecure or lossy deployment. */
export function assertProductionConfig() {
  if (!config.isProd) return;
  const fatal = [];
  if (!config.db.url) fatal.push('DATABASE_URL is required in production (leads would be dropped).');
  if (!config.security.ipHashSalt) fatal.push('IP_HASH_SALT is required in production (per-IP limits would be unenforceable).');
  if (config.security.ipHashSalt && config.security.ipHashSalt.length < 32) {
    fatal.push('IP_HASH_SALT must be at least 32 characters.');
  }
  if (!config.email.resendApiKey) fatal.push('RESEND_API_KEY is required in production (reports could not be delivered).');
  if (!config.security.adminToken) fatal.push('ADMIN_TOKEN is required in production (lead export would be public).');
  if (config.security.adminToken && config.security.adminToken.length < 24) {
    fatal.push('ADMIN_TOKEN must be at least 24 characters.');
  }
  if (!/^https:\/\//.test(config.siteUrl)) fatal.push('SITE_URL must be an https:// origin in production.');

  /**
   * Turnstile is the only real bot defence. The honeypot is trivially skipped by
   * anything that reads the DOM, and the timing check is deliberately advisory.
   * Without a challenge, the per-IP quota is all that stands between a botnet
   * and the report endpoint — and a botnet has more IPs than we have limits.
   *
   * Forgetting these two variables is an easy deploy mistake that produces no
   * visible symptom, so it fails the boot instead. ALLOW_NO_CAPTCHA=1 is the
   * documented, deliberate opt-out for anyone who genuinely wants to run
   * without it.
   */
  if (!config.turnstile.enabled && !bool(env.ALLOW_NO_CAPTCHA, false)) {
    fatal.push(
      'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are required in production. '
      + 'Without a challenge the abuse limits are the only bot defence. '
      + 'Set ALLOW_NO_CAPTCHA=1 to override deliberately.',
    );
  }

  if (fatal.length) {
    throw new Error(`Refusing to start in production:\n  - ${fatal.join('\n  - ')}`);
  }
}

export default config;

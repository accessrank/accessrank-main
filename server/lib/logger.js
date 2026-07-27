import crypto from 'node:crypto';
import config from './config.js';

/**
 * Minimal structured logger.
 *
 * JSON lines in production (so a log shipper can parse them), human-readable in
 * development. Deliberately dependency-free.
 *
 * Anything that could identify a visitor is redacted before it reaches a log
 * sink: the site promises data minimisation, and access logs are the most
 * common place that promise is quietly broken.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (config.isProd ? LEVELS.info : LEVELS.debug);

const SENSITIVE_KEYS = /^(email|phone|name|password|token|authorization|cookie|ip|secret|api[_-]?key)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? mask(v) : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Keep enough to correlate two log lines, not enough to identify a person. */
function mask(value) {
  if (value == null) return value;
  const str = String(value);
  if (!str) return str;
  return `redacted:${crypto.createHash('sha256').update(str).digest('hex').slice(0, 8)}`;
}

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const safe = redact(fields);
  if (config.isProd) {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...safe })}\n`);
    return;
  }
  const detail = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  const tag = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }[level];
  process.stdout.write(`${tag} ${message}${detail}\n`);
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/** Short correlation id attached to each request and echoed in error responses. */
export const requestId = () => crypto.randomBytes(8).toString('hex');

export default log;

import crypto from 'node:crypto';
import net from 'node:net';
import config from './config.js';
import { log } from './logger.js';

/**
 * Shared bucket for clients whose address cannot be determined. Deliberately a
 * real key rather than null, so quotas still apply. See hashIp().
 */
export const UNKNOWN_CLIENT = 'unknown-client';

/**
 * Identity normalization for quota enforcement.
 *
 * "One report per email" and "three reports per IP per day" are only meaningful
 * if the key we count against cannot be trivially reshaped by the visitor.
 * Naively storing the raw address means all of these look like distinct people:
 *
 *   carlos@gmail.com   carlos+1@gmail.com   c.a.r.l.o.s@gmail.com
 *   Carlos@Gmail.com   carlos@googlemail.com
 *
 * They are one Gmail inbox. So we store a normalized key alongside the address
 * the visitor actually typed (which is what we must send mail to and display back).
 */

/* --------------------------------------------------------------- email --- */

/** Providers where dots in the local part are not significant. */
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

/** Domains that are aliases of a single mail system. */
const DOMAIN_ALIASES = new Map([
  ['googlemail.com', 'gmail.com'],
  ['pm.me', 'protonmail.com'],
  ['proton.me', 'protonmail.com'],
]);

/**
 * Sub-addressing separators by domain. `+` is near-universal; Fastmail and
 * Yahoo use `-`. Applied conservatively: only where the provider documents it,
 * because stripping a literal `-` elsewhere would merge unrelated people.
 */
const TAG_SEPARATORS = new Map([
  ['gmail.com', ['+']],
  ['outlook.com', ['+']],
  ['hotmail.com', ['+']],
  ['live.com', ['+']],
  ['protonmail.com', ['+']],
  ['icloud.com', ['+']],
  ['me.com', ['+']],
  ['yahoo.com', ['-']],
  ['fastmail.com', ['+', '-']],
]);

const DEFAULT_TAG_SEPARATORS = ['+'];

/**
 * Throwaway-inbox domains. A visitor using one is knowingly opting out of
 * receiving the report, which is the entire deliverable — so we reject rather
 * than burn a scan and a send. This is a high-traffic subset; extend via
 * DISPOSABLE_EMAIL_DOMAINS (comma-separated) without a code change.
 */
const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com', '10minutemail.com', '10minutemail.net', '20minutemail.com', '33mail.com',
  'anonbox.net', 'armyspy.com', 'burnermail.io', 'byom.de', 'cock.li',
  'deadaddress.com', 'discard.email', 'discardmail.com', 'dispostable.com', 'dropmail.me',
  'e4ward.com', 'email-fake.com', 'emailondeck.com', 'emailtemporanea.com', 'emltmp.com',
  'fake-box.com', 'fakeinbox.com', 'fakemail.net', 'fakemailgenerator.com', 'fleckens.hu',
  'get2mail.fr', 'getairmail.com', 'getnada.com', 'grr.la', 'guerrillamail.biz',
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxalias.com',
  'inboxbear.com', 'incognitomail.com', 'jetable.org', 'ku.fyi', 'linshiyouxiang.net',
  'mail-temporaire.fr', 'mail.tm', 'mail7.io', 'mailbox52.ga', 'maildrop.cc',
  'mailedu.de', 'mailenator.com', 'mailforspam.com', 'mailinator.com', 'mailinator.net',
  'mailinator.org', 'mailnesia.com', 'mailnull.com', 'mailsac.com', 'mailtemp.info',
  'mailtothis.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'monumentmail.com',
  'mt2015.com', 'mytemp.email', 'mytrashmail.com', 'nada.email', 'no-spam.ws',
  'nowmymail.com', 'objectmail.com', 'onetimemail.org', 'pokemail.net', 'proxymail.eu',
  'rcpt.at', 'sharklasers.com', 'shitmail.me', 'sofimail.com', 'spam4.me',
  'spamavert.com', 'spambog.com', 'spambox.us', 'spamdecoy.net', 'spamfree24.org',
  'spamgourmet.com', 'spamhole.com', 'spaml.de', 'spamspot.com', 'superrito.com',
  'tempail.com', 'tempemail.net', 'tempinbox.com', 'tempmail.altmails.com', 'tempmail.com',
  'tempmail.de', 'tempmail.plus', 'tempmailer.com', 'tempmailo.com', 'tempr.email',
  'temp-mail.io', 'temp-mail.org', 'temp-mail.ru', 'throwam.com', 'throwawaymail.com',
  'tmail.ws', 'tmpeml.com', 'tmpmail.net', 'trashmail.com', 'trashmail.de',
  'trashmail.me', 'trashmail.net', 'trbvm.com', 'vomoto.com', 'wegwerfmail.de',
  'wegwerfmail.net', 'wegwerfmail.org', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'zetmail.com',
  ...(process.env.DISPOSABLE_EMAIL_DOMAINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

/**
 * RFC 5322 is far looser than anything a real signup should accept. This is the
 * deliberately pragmatic subset: one @, a sane local part, a dotted domain.
 */
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class InvalidEmailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvalidEmailError';
    this.code = code;
    this.public = true;
  }
}

/**
 * @param {string} raw
 * @returns {{ email: string, normalized: string, domain: string }}
 *   `email` is the deliverable address (lowercased, trimmed);
 *   `normalized` is the quota key and must be the UNIQUE column in the database.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') throw new InvalidEmailError('Enter your email address.', 'email_required');

  // NFKC folds visually identical Unicode forms (e.g. fullwidth ＠) together.
  let value = raw.normalize('NFKC').trim().toLowerCase();
  if (!value) throw new InvalidEmailError('Enter your email address.', 'email_required');
  if (value.length > 254) throw new InvalidEmailError('That email address is too long.', 'email_too_long');
  // Strip a display-name wrapper: "Carlos <c@x.com>".
  const angle = value.match(/^[^<]*<([^>]+)>$/);
  if (angle) value = angle[1].trim();

  if (!EMAIL_RE.test(value)) {
    throw new InvalidEmailError('Enter a valid email address.', 'email_invalid');
  }

  const at = value.lastIndexOf('@');
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);

  if (local.length > 64) throw new InvalidEmailError('Enter a valid email address.', 'email_invalid');

  domain = DOMAIN_ALIASES.get(domain) ?? domain;

  if (DISPOSABLE_DOMAINS.has(domain)) {
    throw new InvalidEmailError(
      'Please use a permanent email address — the report is delivered to your inbox.',
      'email_disposable',
    );
  }

  let normalizedLocal = local;
  for (const sep of TAG_SEPARATORS.get(domain) ?? DEFAULT_TAG_SEPARATORS) {
    const idx = normalizedLocal.indexOf(sep);
    // Guard against an address that is entirely a tag ("+foo@x.com" is invalid anyway).
    if (idx > 0) normalizedLocal = normalizedLocal.slice(0, idx);
  }
  if (DOT_INSENSITIVE.has(domain)) normalizedLocal = normalizedLocal.replaceAll('.', '');

  if (!normalizedLocal) throw new InvalidEmailError('Enter a valid email address.', 'email_invalid');

  return { email: value, normalized: `${normalizedLocal}@${domain}`, domain };
}

export const isDisposableDomain = (domain) => DISPOSABLE_DOMAINS.has(String(domain).toLowerCase());

/* ------------------------------------------------------------------ IP --- */

/**
 * Reduce an address to the unit a single household or person controls.
 *
 * IPv4: the full address.
 * IPv6: the /64 prefix. ISPs delegate a /64 (often a /56) per subscriber, so a
 *   visitor can cycle through 18 quintillion addresses inside their own prefix.
 *   Counting full IPv6 addresses would make the per-IP quota meaningless.
 */
export function normalizeIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  let value = ip.trim();

  // Idempotence. normalizeIp("2a00:1450::/64") must return the same string, not
  // null: an IPv6 /64 prefix is not a parseable literal, so a second pass used
  // to reject its own output. Because callers guard with `if (ipHash)`, that
  // null silently DISABLED the per-IP quota for every IPv6 visitor.
  if (/^[0-9a-f:]+::\/64$/i.test(value)) return value.toLowerCase();

  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

  // ::ffff:1.2.3.4 — an IPv4 client seen through a dual-stack socket.
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) value = mapped[1];

  const version = net.isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  const groups = expandIpv6(value);
  if (!groups) return null;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

function expandIpv6(addr) {
  const halves = addr.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parse = (chunk) => (chunk === '' ? [] : chunk.split(':').map((g) => Number.parseInt(g, 16)));
  let groups;
  if (halves.length === 2) {
    const head = parse(halves[0]);
    const tail = parse(halves[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = parse(halves[0]);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) return null;
  return groups;
}

/**
 * Stable, non-reversible identifier for a client.
 *
 * We must count requests per visitor, but the privacy policy promises we do not
 * retain more personal data than necessary — and a raw IP is personal data under
 * GDPR. An HMAC keyed with a server-only salt gives an equality-comparable token
 * that cannot be turned back into an address if the database leaks.
 *
 * The salt is deployment-stable on purpose: rotating it resets every quota.
 */
export function hashIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    // Fail CLOSED. Returning null here makes every caller's `if (ipHash)` guard
    // skip the quota entirely, which is how an unparseable address became an
    // unlimited one. An unidentifiable client shares one bucket instead.
    log.warn('client address could not be normalized — using the shared quota bucket', {
      raw: typeof ip === 'string' ? ip.slice(0, 60) : typeof ip,
    });
    return UNKNOWN_CLIENT;
  }
  const salt = config.security.ipHashSalt;
  if (!salt) {
    // Never silently fall back to an unsalted digest — that would be reversible
    // by rainbow table over the whole IPv4 space in minutes.
    if (config.isProd) throw new Error('IP_HASH_SALT is not configured; refusing to hash client IPs.');
    return `dev:${normalized}`;
  }
  return crypto.createHmac('sha256', salt).update(normalized).digest('base64url').slice(0, 32);
}

/**
 * Extract the client address, UNMODIFIED.
 *
 * Returns the raw address rather than the quota-normalized form. Two reasons:
 *   - callers do `hashIp(clientIp(req))`, and hashIp normalizes internally;
 *     returning a pre-normalized value made that a double normalization
 *   - Cloudflare Turnstile's `remoteip` parameter wants a real address, not a
 *     /64 prefix string
 *
 * Express populates `req.ip` from X-Forwarded-For according to the configured
 * `trust proxy` hop count, so this must never read the raw header itself — that
 * is spoofable and would let anyone mint unlimited quota by sending
 * `X-Forwarded-For: <random>`.
 */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

/* ---------------------------------------------------------------- misc --- */

/**
 * Clean a free-text field for storage.
 *
 * Angle brackets are STRIPPED, not escaped. Escaping at write time would be the
 * wrong fix: it corrupts the data (a company called "Ben & Co" must not be stored
 * as "Ben &amp; Co" and then reach an email that way), and correct output encoding
 * already happens at every render point — PDF, email and HTML all run values
 * through escapeHtml().
 *
 * But a name or company has no legitimate reason to contain markup, so removing
 * the characters means a stored-XSS payload never exists in the database at all.
 * A future admin dashboard that forgets to escape then cannot be the only thing
 * standing between a public lead form and script execution.
 */
export function cleanText(raw, maxLength = 200) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Phone numbers arrive in every conceivable format and we serve an international
 * audience, so we validate loosely (digit count) and store E.164-ish text rather
 * than rejecting valid foreign numbers with a US-shaped regex.
 */
export function normalizePhone(raw) {
  const cleaned = cleanText(raw, 40);
  if (!cleaned) return null;
  const digits = cleaned.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const plus = /^\s*\+/.test(cleaned) ? '+' : '';
  return `${plus}${digits}`;
}

export default { normalizeEmail, normalizeIp, hashIp, clientIp, cleanText, normalizePhone, isDisposableDomain };

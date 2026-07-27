import { z } from 'zod';
import config from './config.js';
import { log } from './logger.js';
import { normalizeEmail, normalizePhone, cleanText, InvalidEmailError } from './identity.js';

/**
 * Request validation and bot defence.
 *
 * Rate limits alone do not stop abuse: a script that solves nothing can still
 * burn three reports per IP across a botnet. Four independent layers apply, in
 * increasing cost order, so cheap rejections happen first:
 *
 *   1. schema validation      malformed input never reaches business logic
 *   2. honeypot field         a hidden input a human never fills in
 *   3. submission timing      a form completed in under 2s was not typed
 *   4. Cloudflare Turnstile   real challenge, only when configured
 */

export class ValidationError extends Error {
  constructor(message, { code = 'invalid_input', field = null, status = 400 } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
    this.status = status;
    this.public = true;
  }
}

/* ------------------------------------------------------------- schemas --- */

const trimmed = (max) => z.string().trim().max(max);

export const scanSchema = z.object({
  url: trimmed(2000).min(1, 'Enter the address of the store you want to check.'),
  turnstileToken: z.string().max(4096).optional().nullable(),
});

export const reportSchema = z.object({
  scanId: z.string().uuid('That scan has expired — run the check again.'),
  name: trimmed(120).min(2, 'Enter your name.'),
  email: trimmed(254).min(3, 'Enter your email address.'),
  phone: trimmed(40).min(5, 'Enter a phone number we can reach you on.'),
  consent: z.union([z.boolean(), z.literal('on'), z.literal('true')]).refine(
    (v) => v === true || v === 'on' || v === 'true',
    'Please agree to the privacy policy so we can send your report.',
  ),
  marketingOptIn: z.union([z.boolean(), z.string()]).optional().nullable(),
  // Bot traps.
  company_website: z.string().max(200).optional().nullable(), // honeypot
  formLoadedAt: z.union([z.number(), z.string()]).optional().nullable(),
  turnstileToken: z.string().max(4096).optional().nullable(),
});

export const leadSchema = z.object({
  source: z.enum(['signup', 'contact_sales']),
  firstName: trimmed(80).min(1, 'Enter your first name.'),
  lastName: trimmed(80).optional().nullable(),
  email: trimmed(254).min(3, 'Enter your email address.'),
  phone: trimmed(40).optional().nullable(),
  company: trimmed(160).optional().nullable(),
  website: trimmed(2000).optional().nullable(),
  plan: z.enum(['starter', 'growth', 'enterprise']).optional().nullable(),
  platform: trimmed(60).optional().nullable(),
  pages: trimmed(60).optional().nullable(),
  intent: trimmed(60).optional().nullable(),
  message: trimmed(4000).optional().nullable(),
  consent: z.union([z.boolean(), z.literal('on'), z.literal('true')]).refine(
    (v) => v === true || v === 'on' || v === 'true',
    'Please agree to the privacy policy so we can get back to you.',
  ),
  marketingOptIn: z.union([z.boolean(), z.string()]).optional().nullable(),
  company_website: z.string().max(200).optional().nullable(),
  formLoadedAt: z.union([z.number(), z.string()]).optional().nullable(),
  turnstileToken: z.string().max(4096).optional().nullable(),
});

/** Turn a Zod failure into a single visitor-facing message plus the field to focus. */
export function parseOrThrow(schema, payload) {
  const result = schema.safeParse(payload ?? {});
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const field = issue?.path?.[0] ?? null;
  const message = issue?.message && !/^Invalid|^Required|^Expected/.test(issue.message)
    ? issue.message
    : 'Please check the highlighted field and try again.';
  throw new ValidationError(message, { field, code: 'invalid_input' });
}

/* ----------------------------------------------------------- bot traps --- */

const MIN_FORM_SECONDS = 2;

/**
 * A hidden field named like something a password manager or naive bot will fill
 * ("company_website"). Real users never see it, so any value means automation.
 * Returns silently-succeeding `false` so the caller can decide whether to
 * pretend success rather than reveal the trap.
 */
export function honeypotTripped(payload) {
  const value = payload?.company_website;
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Suspiciously fast submission.
 *
 * IMPORTANT: this is a SIGNAL, not a gate. Callers must not silently drop a
 * submission because of it.
 *
 * A password manager or browser autofill can legitimately complete a three-field
 * form in well under two seconds, and the failure mode of blocking is the worst
 * one available: the visitor is shown success, no report is sent, and a real
 * lead is lost with no error anywhere. The honeypot has effectively no false
 * positives and does gate; Turnstile is the actual bot defence in production.
 * This only earns a log line.
 */
export function submittedTooFast(payload) {
  const raw = payload?.formLoadedAt;
  if (raw == null || raw === '') return false;
  const loadedAt = Number(raw);
  if (!Number.isFinite(loadedAt) || loadedAt <= 0) return false;
  // Clock skew or a stale tab should never flag a real person.
  const elapsedSeconds = (Date.now() - loadedAt) / 1000;
  if (elapsedSeconds < 0 || elapsedSeconds > 86_400) return false;
  return elapsedSeconds < MIN_FORM_SECONDS;
}

/* ----------------------------------------------------------- turnstile --- */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Cloudflare Turnstile token.
 *
 * When Turnstile is not configured the check is skipped, so the site works out
 * of the box in development. `assertProductionConfig` makes missing keys a fatal
 * boot error in production, so "unconfigured" cannot silently mean "unprotected"
 * on a deployed instance — unless the operator sets ALLOW_NO_CAPTCHA=1, which is
 * the explicit, logged opt-out.
 */
export async function verifyTurnstile(token, remoteIp) {
  if (!config.turnstile.enabled) return { ok: true, skipped: true };

  if (!token || typeof token !== 'string') {
    throw new ValidationError('Please complete the verification check and try again.', {
      code: 'captcha_required', field: 'turnstileToken', status: 400,
    });
  }

  const body = new URLSearchParams({ secret: config.turnstile.secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  let data;
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(8000),
    });
    data = await response.json();
  } catch (err) {
    // Failing closed on a Cloudflare outage would take the whole funnel down.
    // Log loudly and let the request through; the quotas still bound the damage.
    log.error('Turnstile verification unreachable — allowing request', { err: err.message });
    return { ok: true, degraded: true };
  }

  if (!data.success) {
    log.warn('Turnstile rejected a submission', { codes: data['error-codes'] });
    throw new ValidationError('That verification check expired. Please try again.', {
      code: 'captcha_failed', field: 'turnstileToken', status: 400,
    });
  }

  return { ok: true };
}

/* ---------------------------------------------------------- normalizing --- */

/** Validate and normalize the contact fields shared by every lead-producing form. */
export function normalizeContact({ name, email, phone }, { requirePhone = true } = {}) {
  const cleanName = cleanText(name, 120);
  if (cleanName.length < 2) {
    throw new ValidationError('Enter your name.', { field: 'name', code: 'name_required' });
  }
  // A name that is only punctuation or digits is not a name.
  if (!/[\p{L}]{2}/u.test(cleanName)) {
    throw new ValidationError('Enter your name.', { field: 'name', code: 'name_invalid' });
  }

  let identity;
  try {
    identity = normalizeEmail(email);
  } catch (err) {
    if (err instanceof InvalidEmailError) {
      throw new ValidationError(err.message, { field: 'email', code: err.code });
    }
    throw err;
  }

  const cleanPhone = normalizePhone(phone);
  if (requirePhone && !cleanPhone) {
    throw new ValidationError('Enter a phone number we can reach you on.', {
      field: 'phone', code: 'phone_invalid',
    });
  }

  return { name: cleanName, identity, phone: cleanPhone };
}

/** Capture attribution without storing anything identifying. */
export function marketingContext(req) {
  const referer = req.get('referer');
  const utm = {};
  try {
    const url = new URL(req.get('referer') || '', config.siteUrl);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid']) {
      const value = url.searchParams.get(key);
      if (value) utm[key] = value.slice(0, 120);
    }
  } catch { /* a malformed referer is not worth failing a lead over */ }

  const body = req.body ?? {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid']) {
    if (typeof body[key] === 'string' && body[key]) utm[key] = body[key].slice(0, 120);
  }

  return {
    referer: referer ? String(referer).slice(0, 500) : null,
    userAgent: (req.get('user-agent') || '').slice(0, 400) || null,
    utm: Object.keys(utm).length ? utm : null,
  };
}

export const isTruthy = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;

export default {
  scanSchema, reportSchema, leadSchema, parseOrThrow,
  honeypotTripped, submittedTooFast, verifyTurnstile,
  normalizeContact, marketingContext, ValidationError, isTruthy,
};

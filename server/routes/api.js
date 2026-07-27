import express from 'express';
import config, { readiness } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { getStore, QuotaError, isUuid } from '../lib/store.js';
import { consumeScanQuota, reserveReport, releaseReport, quotaStatus } from '../lib/quota.js';
import { runScan, ScanError, AXE_VERSION } from '../lib/scanner.js';
import { BlockedTargetError, normalizeTargetUrl } from '../lib/ssrf.js';
import { hashIp, clientIp, cleanText } from '../lib/identity.js';
import {
  scanSchema, reportSchema, leadSchema, parseOrThrow, honeypotTripped, submittedTooFast,
  verifyTurnstile, normalizeContact, marketingContext, ValidationError, isTruthy,
} from '../lib/validate.js';
import { generateReportPdf, buildReportContext } from '../lib/pdf.js';
import { sendReport, notifySales } from '../lib/email.js';

const router = express.Router();

const CONSENT_TEXT =
  'I agree to Accessrank contacting me about this report and accept the privacy policy.';

/** Wrap an async handler so a rejected promise reaches the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------- health --- */

router.get('/health', wrap(async (req, res) => {
  const status = readiness();
  res.status(status.leadFunnel || !config.isProd ? 200 : 503).json({
    ok: true,
    env: config.env,
    axe: AXE_VERSION,
    ...status,
    // Never leak which variables are missing to the public internet.
    missing: config.isProd ? undefined : status.missing,
  });
}));

/* --------------------------------------------------------------- scan --- */

/**
 * POST /api/scan  { url, turnstileToken? }
 *
 * Runs the real audit and returns the result plus a scanId. The scanId is what
 * the lead-capture step exchanges for a PDF, so the visitor never re-submits a
 * URL and we never re-scan for the report.
 */
router.post('/scan', wrap(async (req, res) => {
  const input = parseOrThrow(scanSchema, req.body);
  const store = await getStore();
  const ip = clientIp(req);
  const ipHash = hashIp(ip);

  await verifyTurnstile(input.turnstileToken, ip);

  // Reject obviously bad input before spending a quota unit or a browser.
  let target;
  try {
    target = normalizeTargetUrl(input.url);
  } catch (err) {
    if (err instanceof BlockedTargetError) throw err;
    throw new ValidationError("That doesn't look like a valid web address.", { field: 'url' });
  }

  // Serving a cached result costs nothing, so it must not consume the quota.
  const cached = await store.findCachedScan(target.origin, config.scanner.cacheTtlHours);
  if (cached?.result) {
    log.info('scan served from cache', { origin: target.origin });
    const row = await store.insertScan({
      requestedUrl: input.url,
      finalUrl: cached.final_url,
      origin: cached.origin,
      status: 'ok',
      scoreOverall: cached.score_overall,
      scoreA11y: cached.score_a11y,
      scoreSeo: cached.score_seo,
      violationsTotal: cached.violations_total,
      violationsCritical: cached.violations_critical,
      violationsSerious: cached.violations_serious,
      violationsModerate: cached.violations_moderate,
      violationsMinor: cached.violations_minor,
      pagesScanned: cached.pages_scanned,
      result: cached.result,
      engineVersion: cached.engine_version,
      axeVersion: cached.axe_version,
      durationMs: 0,
      ipHash,
      userAgent: (req.get('user-agent') || '').slice(0, 400),
      servedFromCache: true,
      cachedFrom: cached.id,
    });
    return res.json({ ok: true, scanId: row.id, cached: true, ...publicScan(cached.result) });
  }

  await consumeScanQuota(store, ipHash);

  const started = Date.now();
  let result;
  try {
    result = await runScan(input.url);
  } catch (err) {
    // Record the failure so repeated attempts against a dead domain are visible,
    // and so the visitor's quota unit is not silently spent on our error.
    await store.insertScan({
      requestedUrl: input.url,
      origin: target.origin,
      status: err instanceof BlockedTargetError ? 'blocked' : 'failed',
      errorCode: err.code ?? 'unknown',
      errorDetail: String(err.message).slice(0, 500),
      durationMs: Date.now() - started,
      ipHash,
      userAgent: (req.get('user-agent') || '').slice(0, 400),
    }).catch(() => {});
    throw err;
  }

  const row = await store.insertScan({
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    origin: result.origin,
    status: 'ok',
    scoreOverall: result.scores.overall,
    scoreA11y: result.scores.accessibility,
    scoreSeo: result.scores.seo,
    violationsTotal: result.accessibility.violationsTotal,
    violationsCritical: result.accessibility.counts.critical,
    violationsSerious: result.accessibility.counts.serious,
    violationsModerate: result.accessibility.counts.moderate,
    violationsMinor: result.accessibility.counts.minor,
    pagesScanned: result.pagesScanned,
    result,
    engineVersion: result.engineVersion,
    axeVersion: result.axeVersion,
    durationMs: result.durationMs,
    ipHash,
    userAgent: (req.get('user-agent') || '').slice(0, 400),
  });

  res.json({ ok: true, scanId: row.id, cached: false, ...publicScan(result) });
}));

/**
 * Shape the scan for the browser: enough to be genuinely useful and to motivate
 * the report request, without shipping the full node-level payload.
 */
function publicScan(result) {
  return {
    url: result.finalUrl ?? result.requestedUrl,
    origin: result.origin,
    pagesScanned: result.pagesScanned,
    scores: result.scores,
    accessibility: {
      criteriaEvaluated: result.accessibility.criteriaEvaluated,
      criteriaMet: result.accessibility.criteriaMet,
      criteriaFailed: result.accessibility.criteriaFailed,
      criteriaReview: result.accessibility.criteriaReview,
      failedCriteria: result.accessibility.failedCriteria,
      violationsTotal: result.accessibility.violationsTotal,
      counts: result.accessibility.counts,
      issues: (result.accessibility.issues ?? []).slice(0, 6).map((issue) => ({
        id: issue.id,
        impact: issue.impact,
        help: issue.help,
        nodes: issue.nodes,
        criteria: issue.criteria,
        level: issue.level,
        helpUrl: issue.helpUrl,
      })),
      totalIssues: (result.accessibility.issues ?? []).length,
    },
    seo: {
      score: result.seo.score,
      passed: result.seo.passed,
      total: result.seo.total,
      checks: result.seo.checks,
    },
    axeVersion: result.axeVersion,
  };
}

/* ------------------------------------------------------------- report --- */

/**
 * POST /api/report  { scanId, name, email, phone, consent, ... }
 *
 * The lead-capture step. Enforces both quotas, records the lead with the full
 * scan result, then generates the PDF and emails it.
 *
 * The PDF is never returned in the response. Delivering only by email is what
 * makes "one report per email address" self-enforcing — a throwaway address
 * yields no report — and it is the entire point of the capture.
 */
router.post('/report', wrap(async (req, res) => {
  const input = parseOrThrow(reportSchema, req.body);
  const store = await getStore();
  const ip = clientIp(req);
  const ipHash = hashIp(ip);

  // The honeypot gates: a filled hidden field means automation, and revealing
  // the trap would only teach the next attempt. Timing does NOT gate — see
  // submittedTooFast — because autofill would cost us real leads silently.
  if (honeypotTripped(input)) {
    log.warn('report request rejected by honeypot', { ipHash });
    return res.json({ ok: true, status: 'sent' });
  }
  if (submittedTooFast(input)) log.warn('report submitted suspiciously fast', { ipHash });

  await verifyTurnstile(input.turnstileToken, ip);

  const contact = normalizeContact(input, { requirePhone: true });

  if (!isUuid(input.scanId)) {
    throw new ValidationError('That scan has expired — run the check again.', { field: 'scanId', code: 'scan_missing' });
  }
  const scan = await store.getScan(input.scanId);
  if (!scan || scan.status !== 'ok' || !scan.result) {
    throw new ValidationError('That scan has expired — run the check again.', { field: 'scanId', code: 'scan_missing' });
  }

  const result = typeof scan.result === 'string' ? JSON.parse(scan.result) : scan.result;
  const context = marketingContext(req);

  const { lead, report } = await reserveReport(store, {
    identity: contact.identity,
    ipHash,
    scan,
    lead: {
      name: contact.name,
      email: contact.identity.email,
      emailNormalized: contact.identity.normalized,
      emailDomain: contact.identity.domain,
      phone: contact.phone,
      website: result.finalUrl ?? result.requestedUrl,
      websiteOrigin: result.origin,
      source: 'audit_report',
      ipHash,
      userAgent: context.userAgent,
      referer: context.referer,
      utm: context.utm,
      consentAt: new Date().toISOString(),
      consentText: CONSENT_TEXT,
      marketingOptIn: isTruthy(input.marketingOptIn),
    },
  });

  // Everything below is delivery. A failure here refunds the quota so the
  // visitor is not charged their single allowed report for our outage.
  try {
    const pdf = await generateReportPdf(
      buildReportContext({ scan, result, lead, reportId: report.id }),
    );
    const sent = await sendReport({ lead, result, pdf });
    await store.markReportSent(report.id, {
      provider: sent.provider, providerId: sent.id, pdfBytes: pdf.length,
    });
    log.info('report delivered', { reportId: report.id, origin: result.origin });
    notifySales({ lead, result, kind: 'audit_report' });
  } catch (err) {
    log.error('report delivery failed', { err: err.message, reportId: report.id });
    await releaseReport(store, { report, ipHash, reason: err.message });
    const failure = new Error("We couldn't email your report just now. Please try again in a few minutes.");
    failure.public = true;
    failure.status = 502;
    failure.code = 'delivery_failed';
    throw failure;
  }

  res.json({
    ok: true,
    status: 'sent',
    // Echo the domain, not the address, so a shoulder-surfer learns nothing.
    deliveredTo: contact.identity.email.replace(/^(.).*(@.*)$/, '$1***$2'),
  });
}));

/* --------------------------------------------------------------- lead --- */

/** POST /api/lead — signup and contact-sales forms. No scan attached. */
router.post('/lead', wrap(async (req, res) => {
  const input = parseOrThrow(leadSchema, req.body);
  const store = await getStore();
  const ipHash = hashIp(clientIp(req));

  if (honeypotTripped(input)) {
    log.warn('lead request rejected by honeypot', { ipHash });
    return res.json({ ok: true, status: 'received' });
  }
  if (submittedTooFast(input)) log.warn('lead submitted suspiciously fast', { ipHash });

  await verifyTurnstile(input.turnstileToken, clientIp(req));

  const fullName = [input.firstName, input.lastName].filter(Boolean).join(' ');
  const contact = normalizeContact(
    { name: fullName, email: input.email, phone: input.phone },
    { requirePhone: false },
  );
  const context = marketingContext(req);

  let websiteOrigin = null;
  try {
    if (input.website) websiteOrigin = normalizeTargetUrl(input.website).origin;
  } catch { /* a mistyped store URL should not block a sales enquiry */ }

  const lead = await store.tx((client) => store.upsertLead(client, {
    name: contact.name,
    email: contact.identity.email,
    emailNormalized: contact.identity.normalized,
    emailDomain: contact.identity.domain,
    phone: contact.phone,
    company: cleanText(input.company, 160) || null,
    website: input.website ? cleanText(input.website, 400) : null,
    websiteOrigin,
    source: input.source,
    intent: input.intent ? cleanText(input.intent, 60) : null,
    plan: input.plan ?? null,
    platform: input.platform ? cleanText(input.platform, 60) : null,
    message: input.message ? cleanText(input.message, 4000) : null,
    ipHash,
    userAgent: context.userAgent,
    referer: context.referer,
    utm: context.utm,
    consentAt: new Date().toISOString(),
    consentText: CONSENT_TEXT,
    marketingOptIn: isTruthy(input.marketingOptIn),
  }));

  log.info('lead captured', { source: input.source, leadId: lead.id });
  notifySales({ lead, kind: input.source });

  res.json({ ok: true, status: 'received' });
}));

/* -------------------------------------------------------------- quota --- */

/** Lets the UI show remaining allowance before someone fills in a form. */
router.get('/quota', wrap(async (req, res) => {
  const store = await getStore();
  const status = await quotaStatus(store, hashIp(clientIp(req)));
  res.json({ ok: true, quota: status });
}));

/* -------------------------------------------------------------- admin --- */

function requireAdmin(req, res, next) {
  const token = config.security.adminToken;
  if (!token) return res.status(503).json({ ok: false, error: 'Admin API is not configured.' });

  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Length-first comparison avoids the timing-unsafe path in timingSafeEqual.
  if (provided.length !== token.length) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  let equal = 0;
  for (let i = 0; i < token.length; i += 1) equal |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  if (equal !== 0) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  return next();
}

/** GET /api/admin/leads?format=csv — everything the brief asked to be recorded. */
router.get('/admin/leads', requireAdmin, wrap(async (req, res) => {
  const store = await getStore();
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const rows = await store.listLeads({ limit });

  if (req.query.format === 'csv') {
    const columns = [
      'created_at', 'client_name', 'email', 'phone', 'company', 'website', 'source',
      'score_overall', 'score_accessibility', 'score_seo',
      'violations_total', 'violations_critical', 'violations_serious', 'pages_scanned',
      'marketing_opt_in', 'consent_at', 'report_status', 'report_delivered_at',
    ];
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      // Neutralise spreadsheet formula injection in a file an operator will open.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="accessrank-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  }

  res.json({ ok: true, count: rows.length, leads: rows });
}));

/* ------------------------------------------------------------- errors --- */

router.use((err, req, res, _next) => {
  const status = err.status ?? (err instanceof QuotaError ? 429 : err instanceof ScanError ? 400 : 500);
  const isPublic = err.public === true;

  if (status >= 500) {
    log.error('api error', { err: err.message, code: err.code, path: req.path, stack: err.stack?.split('\n')[1] });
  } else {
    log.info('api rejected', { code: err.code, path: req.path, status });
  }

  res.status(status).json({
    ok: false,
    code: err.code ?? 'error',
    field: err.field ?? undefined,
    // A non-public error message may contain internals; never echo it.
    error: isPublic ? err.message : 'Something went wrong on our side. Please try again.',
    ...(err.details?.retryAt ? { retryAt: err.details.retryAt } : {}),
  });
});

export default router;

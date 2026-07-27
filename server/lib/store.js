import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import config from './config.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Persistence + quota enforcement.
 *
 * Two interchangeable implementations behind one interface:
 *   PostgresStore  production. Quotas are serialized with transaction-scoped
 *                  advisory locks so concurrent requests cannot both pass a
 *                  check-then-insert.
 *   MemoryStore    development and tests. Same semantics, single process, data
 *                  lost on restart. Refused in production by config.assertProductionConfig().
 *
 * Quota rules implemented here (from the brief):
 *   - one emailed report per email address, ever
 *   - three report requests per client IP per rolling 24 hours
 *   - a scan cap per IP per rolling 24 hours, to protect the Chromium budget
 */

export class QuotaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    this.details = details;
    this.public = true;
    this.status = 429;
  }
}

/** Stable 64-bit key for pg_advisory_xact_lock from an arbitrary string. */
function lockKey(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest();
  // Signed 64-bit, which is what the advisory lock functions take.
  return digest.readBigInt64BE(0);
}

/* ====================================================================== */
/*                              PostgresStore                             */
/* ====================================================================== */

class PostgresStore {
  constructor(pool) {
    this.pool = pool;
    this.kind = 'postgres';
  }

  static async create() {
    const pool = new pg.Pool({
      connectionString: config.db.url,
      max: config.db.maxConnections,
      ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => log.error('pg pool error', { err: err.message }));
    // Fail fast if the URL is wrong, rather than at the first visitor request.
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    return new PostgresStore(pool);
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async tx(fn) {
    return this.txWithLocks([], fn);
  }

  /**
   * Run `fn` in a transaction while holding an exclusive lock on each key.
   *
   * This is the single primitive every quota is built on. Locks are taken in
   * sorted order so two transactions that need the same pair of keys can never
   * deadlock by acquiring them in opposite orders. `pg_advisory_xact_lock`
   * releases automatically at COMMIT or ROLLBACK, so a crashed request cannot
   * leave a quota wedged.
   */
  async txWithLocks(keys, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const key of [...keys].sort()) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey('lock', key)]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate() {
    const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    await this.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await this.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const ran = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await this.query(sql);
      ran.push(version);
    }
    return ran;
  }

  /* ------------------------------------------------------------ scans --- */

  async findCachedScan(origin, ttlHours) {
    const { rows } = await this.query(
      `SELECT * FROM scans
        WHERE origin = $1 AND status = 'ok' AND served_from_cache = false
          AND created_at > now() - ($2 || ' hours')::interval
        ORDER BY created_at DESC LIMIT 1`,
      [origin, String(ttlHours)],
    );
    return rows[0] ?? null;
  }

  async insertScan(scan) {
    const { rows } = await this.query(
      `INSERT INTO scans (
         requested_url, final_url, origin, status, error_code, error_detail,
         score_overall, score_a11y, score_seo,
         violations_total, violations_critical, violations_serious,
         violations_moderate, violations_minor, pages_scanned,
         result, engine_version, axe_version, duration_ms,
         ip_hash, user_agent, served_from_cache, cached_from
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
       ) RETURNING *`,
      [
        scan.requestedUrl, scan.finalUrl ?? null, scan.origin, scan.status,
        scan.errorCode ?? null, scan.errorDetail ?? null,
        scan.scoreOverall ?? null, scan.scoreA11y ?? null, scan.scoreSeo ?? null,
        scan.violationsTotal ?? 0, scan.violationsCritical ?? 0, scan.violationsSerious ?? 0,
        scan.violationsModerate ?? 0, scan.violationsMinor ?? 0, scan.pagesScanned ?? 0,
        scan.result ?? null, scan.engineVersion ?? null, scan.axeVersion ?? null,
        scan.durationMs ?? null, scan.ipHash ?? null, scan.userAgent ?? null,
        scan.servedFromCache ?? false, scan.cachedFrom ?? null,
      ],
    );
    return rows[0];
  }

  async getScan(id) {
    if (!isUuid(id)) return null;
    const { rows } = await this.query('SELECT * FROM scans WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  /* ------------------------------------------------------- rate events --- */

  async countRecent(scope, subject, hours, client = null) {
    const runner = client ?? this.pool;
    const { rows } = await runner.query(
      `SELECT count(*)::int AS n FROM rate_events
        WHERE scope = $1 AND subject = $2 AND created_at > now() - ($3 || ' hours')::interval`,
      [scope, subject, String(hours)],
    );
    return rows[0].n;
  }

  async recordRateEvent(scope, subject, meta = null, client = null) {
    const runner = client ?? this.pool;
    await runner.query(
      'INSERT INTO rate_events (scope, subject, meta) VALUES ($1, $2, $3)',
      [scope, subject, meta],
    );
  }

  /**
   * Consume one unit of a rolling-window quota.
   *
   * PRECONDITION: the caller must already hold the lock for `${scope}:${subject}`
   * via txWithLocks. Without it this is a check-then-insert and two concurrent
   * requests can both pass at the limit boundary.
   */
  async consumeRollingQuota(client, { scope, subject, limit, windowHours, meta }) {
    const used = await this.countRecent(scope, subject, windowHours, client);
    if (used >= limit) {
      const { rows } = await client.query(
        `SELECT min(created_at) AS oldest FROM rate_events
          WHERE scope = $1 AND subject = $2 AND created_at > now() - ($3 || ' hours')::interval`,
        [scope, subject, String(windowHours)],
      );
      const retryAt = rows[0]?.oldest
        ? new Date(new Date(rows[0].oldest).getTime() + windowHours * 3600_000)
        : null;
      return { allowed: false, used, limit, retryAt };
    }
    await this.recordRateEvent(scope, subject, meta, client);
    return { allowed: true, used: used + 1, limit, retryAt: null };
  }

  async releaseRollingQuota(scope, subject) {
    // Refund the most recent unit — used when delivery failed and the visitor
    // should not be charged for our error.
    await this.query(
      `DELETE FROM rate_events WHERE id = (
         SELECT id FROM rate_events WHERE scope = $1 AND subject = $2
          ORDER BY created_at DESC LIMIT 1
       )`,
      [scope, subject],
    );
  }

  /* ------------------------------------------------------------ leads --- */

  async findLeadByNormalizedEmail(normalized, client = null) {
    const runner = client ?? this.pool;
    const { rows } = await runner.query('SELECT * FROM leads WHERE email_normalized = $1', [normalized]);
    return rows[0] ?? null;
  }

  async upsertLead(client, lead) {
    const { rows } = await client.query(
      `INSERT INTO leads (
         name, email, email_normalized, email_domain, phone, company,
         website, website_origin, source, intent, plan, platform, message,
         ip_hash, user_agent, referer, utm,
         consent_at, consent_text, marketing_opt_in
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (email_normalized) DO UPDATE SET
         name           = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
         phone          = COALESCE(NULLIF(EXCLUDED.phone, ''), leads.phone),
         company        = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
         website        = COALESCE(NULLIF(EXCLUDED.website, ''), leads.website),
         website_origin = COALESCE(NULLIF(EXCLUDED.website_origin, ''), leads.website_origin),
         intent         = COALESCE(EXCLUDED.intent, leads.intent),
         plan           = COALESCE(EXCLUDED.plan, leads.plan),
         platform       = COALESCE(EXCLUDED.platform, leads.platform),
         message        = COALESCE(NULLIF(EXCLUDED.message, ''), leads.message),
         marketing_opt_in = leads.marketing_opt_in OR EXCLUDED.marketing_opt_in,
         updated_at     = now()
       RETURNING *`,
      [
        lead.name, lead.email, lead.emailNormalized, lead.emailDomain ?? null,
        lead.phone ?? null, lead.company ?? null,
        lead.website ?? null, lead.websiteOrigin ?? null,
        lead.source ?? 'audit_report', lead.intent ?? null, lead.plan ?? null,
        lead.platform ?? null, lead.message ?? null,
        lead.ipHash ?? null, lead.userAgent ?? null, lead.referer ?? null, lead.utm ?? null,
        lead.consentAt ?? null, lead.consentText ?? null, lead.marketingOptIn ?? false,
      ],
    );
    return rows[0];
  }

  async countReportsForLead(client, leadId) {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM reports WHERE lead_id = $1 AND status <> 'failed'",
      [leadId],
    );
    return rows[0].n;
  }

  async createReport(client, report) {
    const { rows } = await client.query(
      `INSERT INTO reports (lead_id, scan_id, status, ip_hash) VALUES ($1,$2,'pending',$3) RETURNING *`,
      [report.leadId, report.scanId, report.ipHash ?? null],
    );
    return rows[0];
  }

  async attachScanToLead(client, leadId, scan) {
    await client.query(
      `UPDATE leads SET last_scan_id = $2, last_score_overall = $3,
              last_score_a11y = $4, last_score_seo = $5, reports_sent = reports_sent + 1
        WHERE id = $1`,
      [leadId, scan.id, scan.score_overall ?? null, scan.score_a11y ?? null, scan.score_seo ?? null],
    );
  }

  async markReportSent(id, { provider, providerId, pdfBytes }) {
    await this.query(
      `UPDATE reports SET status='sent', delivered_at=now(), provider=$2,
              provider_id=$3, pdf_bytes=$4, attempts = attempts + 1 WHERE id = $1`,
      [id, provider ?? null, providerId ?? null, pdfBytes ?? null],
    );
  }

  async markReportFailed(id, errorDetail) {
    await this.query(
      `UPDATE reports SET status='failed', error_detail=$2, attempts = attempts + 1 WHERE id = $1`,
      [id, String(errorDetail).slice(0, 1000)],
    );
    await this.query('UPDATE leads SET reports_sent = GREATEST(reports_sent - 1, 0) WHERE id = (SELECT lead_id FROM reports WHERE id = $1)', [id]);
  }

  async listLeads({ limit = 500, since = null } = {}) {
    const { rows } = await this.query(
      `SELECT * FROM lead_export ${since ? 'WHERE created_at >= $2' : ''}
        ORDER BY created_at DESC LIMIT $1`,
      since ? [limit, since] : [limit],
    );
    return rows;
  }

  async purgeOldRateEvents(days = 7) {
    const { rowCount } = await this.query(
      `DELETE FROM rate_events WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return rowCount;
  }

  async close() {
    await this.pool.end();
  }
}

/* ====================================================================== */
/*                               MemoryStore                              */
/* ====================================================================== */

/**
 * Development/test implementation. Single-process, so a plain async mutex gives
 * the same serialization guarantee the advisory locks give in Postgres.
 */
class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.scans = new Map();
    this.leads = new Map();       // id -> lead
    this.leadsByEmail = new Map();// email_normalized -> id
    this.reports = new Map();
    this.rateEvents = [];
    this._locks = new Map();
  }

  static async create() {
    log.warn('No DATABASE_URL set — using in-memory store. Data will be lost on restart.');
    return new MemoryStore();
  }

  async migrate() { return []; }
  async close() {}

  /** Serialize by key, mirroring pg_advisory_xact_lock semantics. */
  async _withLock(key, fn) {
    const previous = this._locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this._locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === current) this._locks.delete(key);
    }
  }

  async tx(fn) {
    return this.txWithLocks([], fn);
  }

  /**
   * Same contract as PostgresStore.txWithLocks: hold every key exclusively for
   * the duration of `fn`, acquiring in sorted order to avoid deadlock.
   * There is no rollback in memory, which is acceptable for dev and tests.
   */
  async txWithLocks(keys, fn) {
    const ordered = [...keys].sort();
    const run = async (i) => (i >= ordered.length ? fn(this) : this._withLock(ordered[i], () => run(i + 1)));
    return run(0);
  }

  async query() { throw new Error('MemoryStore does not support raw SQL'); }

  async findCachedScan(origin, ttlHours) {
    const cutoff = Date.now() - ttlHours * 3600_000;
    const matches = [...this.scans.values()]
      .filter((s) => s.origin === origin && s.status === 'ok' && !s.served_from_cache && new Date(s.created_at).getTime() > cutoff)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return matches[0] ?? null;
  }

  async insertScan(scan) {
    const row = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      requested_url: scan.requestedUrl,
      final_url: scan.finalUrl ?? null,
      origin: scan.origin,
      status: scan.status,
      error_code: scan.errorCode ?? null,
      error_detail: scan.errorDetail ?? null,
      score_overall: scan.scoreOverall ?? null,
      score_a11y: scan.scoreA11y ?? null,
      score_seo: scan.scoreSeo ?? null,
      violations_total: scan.violationsTotal ?? 0,
      violations_critical: scan.violationsCritical ?? 0,
      violations_serious: scan.violationsSerious ?? 0,
      violations_moderate: scan.violationsModerate ?? 0,
      violations_minor: scan.violationsMinor ?? 0,
      pages_scanned: scan.pagesScanned ?? 0,
      result: scan.result ?? null,
      engine_version: scan.engineVersion ?? null,
      axe_version: scan.axeVersion ?? null,
      duration_ms: scan.durationMs ?? null,
      ip_hash: scan.ipHash ?? null,
      user_agent: scan.userAgent ?? null,
      served_from_cache: scan.servedFromCache ?? false,
      cached_from: scan.cachedFrom ?? null,
    };
    this.scans.set(row.id, row);
    return row;
  }

  async getScan(id) { return this.scans.get(id) ?? null; }

  async countRecent(scope, subject, hours) {
    const cutoff = Date.now() - hours * 3600_000;
    return this.rateEvents.filter((e) => e.scope === scope && e.subject === subject && e.createdAt > cutoff).length;
  }

  async recordRateEvent(scope, subject, meta = null) {
    this.rateEvents.push({ scope, subject, meta, createdAt: Date.now() });
  }

  /** PRECONDITION: caller holds the `${scope}:${subject}` lock via txWithLocks. */
  async consumeRollingQuota(_client, { scope, subject, limit, windowHours, meta }) {
    const used = await this.countRecent(scope, subject, windowHours);
    if (used >= limit) {
      const cutoff = Date.now() - windowHours * 3600_000;
      const oldest = this.rateEvents
        .filter((e) => e.scope === scope && e.subject === subject && e.createdAt > cutoff)
        .reduce((min, e) => Math.min(min, e.createdAt), Infinity);
      return {
        allowed: false, used, limit,
        retryAt: Number.isFinite(oldest) ? new Date(oldest + windowHours * 3600_000) : null,
      };
    }
    await this.recordRateEvent(scope, subject, meta);
    return { allowed: true, used: used + 1, limit, retryAt: null };
  }

  async releaseRollingQuota(scope, subject) {
    for (let i = this.rateEvents.length - 1; i >= 0; i -= 1) {
      if (this.rateEvents[i].scope === scope && this.rateEvents[i].subject === subject) {
        this.rateEvents.splice(i, 1);
        return;
      }
    }
  }

  async findLeadByNormalizedEmail(normalized) {
    const id = this.leadsByEmail.get(normalized);
    return id ? this.leads.get(id) : null;
  }

  async upsertLead(_client, lead) {
    const existingId = this.leadsByEmail.get(lead.emailNormalized);
    if (existingId) {
      const row = this.leads.get(existingId);
      Object.assign(row, {
        name: lead.name || row.name,
        phone: lead.phone || row.phone,
        company: lead.company || row.company,
        website: lead.website || row.website,
        website_origin: lead.websiteOrigin || row.website_origin,
        marketing_opt_in: row.marketing_opt_in || Boolean(lead.marketingOptIn),
        updated_at: new Date().toISOString(),
      });
      return row;
    }
    const row = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: lead.name,
      email: lead.email,
      email_normalized: lead.emailNormalized,
      email_domain: lead.emailDomain ?? null,
      phone: lead.phone ?? null,
      company: lead.company ?? null,
      website: lead.website ?? null,
      website_origin: lead.websiteOrigin ?? null,
      source: lead.source ?? 'audit_report',
      intent: lead.intent ?? null,
      plan: lead.plan ?? null,
      platform: lead.platform ?? null,
      message: lead.message ?? null,
      ip_hash: lead.ipHash ?? null,
      user_agent: lead.userAgent ?? null,
      referer: lead.referer ?? null,
      utm: lead.utm ?? null,
      consent_at: lead.consentAt ?? null,
      consent_text: lead.consentText ?? null,
      marketing_opt_in: Boolean(lead.marketingOptIn),
      reports_sent: 0,
      last_scan_id: null,
      last_score_overall: null,
      last_score_a11y: null,
      last_score_seo: null,
      notes: null,
    };
    this.leads.set(row.id, row);
    this.leadsByEmail.set(row.email_normalized, row.id);
    return row;
  }

  async countReportsForLead(_client, leadId) {
    return [...this.reports.values()].filter((r) => r.lead_id === leadId && r.status !== 'failed').length;
  }

  async createReport(_client, report) {
    const row = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      lead_id: report.leadId,
      scan_id: report.scanId,
      status: 'pending',
      delivered_at: null,
      provider: null,
      provider_id: null,
      error_detail: null,
      attempts: 0,
      pdf_bytes: null,
      ip_hash: report.ipHash ?? null,
    };
    this.reports.set(row.id, row);
    return row;
  }

  async attachScanToLead(_client, leadId, scan) {
    const lead = this.leads.get(leadId);
    if (!lead) return;
    lead.last_scan_id = scan.id;
    lead.last_score_overall = scan.score_overall ?? null;
    lead.last_score_a11y = scan.score_a11y ?? null;
    lead.last_score_seo = scan.score_seo ?? null;
    lead.reports_sent += 1;
  }

  async markReportSent(id, { provider, providerId, pdfBytes }) {
    const row = this.reports.get(id);
    if (!row) return;
    Object.assign(row, {
      status: 'sent', delivered_at: new Date().toISOString(),
      provider: provider ?? null, provider_id: providerId ?? null,
      pdf_bytes: pdfBytes ?? null, attempts: row.attempts + 1,
    });
  }

  async markReportFailed(id, errorDetail) {
    const row = this.reports.get(id);
    if (!row) return;
    Object.assign(row, { status: 'failed', error_detail: String(errorDetail).slice(0, 1000), attempts: row.attempts + 1 });
    const lead = this.leads.get(row.lead_id);
    if (lead) lead.reports_sent = Math.max(0, lead.reports_sent - 1);
  }

  async listLeads({ limit = 500 } = {}) {
    return [...this.leads.values()]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit)
      .map((l) => {
        const scan = l.last_scan_id ? this.scans.get(l.last_scan_id) : null;
        const report = [...this.reports.values()]
          .filter((r) => r.lead_id === l.id)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        return {
          created_at: l.created_at,
          client_name: l.name,
          email: l.email,
          phone: l.phone,
          company: l.company,
          website: l.website,
          source: l.source,
          score_overall: l.last_score_overall,
          score_accessibility: l.last_score_a11y,
          score_seo: l.last_score_seo,
          violations_total: scan?.violations_total ?? null,
          violations_critical: scan?.violations_critical ?? null,
          violations_serious: scan?.violations_serious ?? null,
          pages_scanned: scan?.pages_scanned ?? null,
          marketing_opt_in: l.marketing_opt_in,
          consent_at: l.consent_at,
          report_status: report?.status ?? null,
          report_delivered_at: report?.delivered_at ?? null,
        };
      });
  }

  async purgeOldRateEvents(days = 7) {
    const cutoff = Date.now() - days * 86_400_000;
    const before = this.rateEvents.length;
    this.rateEvents = this.rateEvents.filter((e) => e.createdAt >= cutoff);
    return before - this.rateEvents.length;
  }
}

/* ====================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

let instance = null;

export async function getStore() {
  if (instance) return instance;
  instance = config.db.url ? await PostgresStore.create() : await MemoryStore.create();
  log.info(`Store ready (${instance.kind})`);
  return instance;
}

/** Test hook: swap in a fresh MemoryStore. */
export function _setStoreForTests(store) {
  instance = store;
}

export { PostgresStore, MemoryStore };

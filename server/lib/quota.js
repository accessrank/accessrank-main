import config from './config.js';
import { QuotaError } from './store.js';

/**
 * The abuse rules from the brief, in one place:
 *
 *   1. one emailed report per email address, ever
 *   2. three report requests per client IP per rolling 24 hours
 *   3. (added) a scan cap per IP per rolling 24 hours + a short burst cap,
 *      because a scan spins up headless Chromium and is the expensive operation
 *      even though it is free to the visitor
 *
 * Rules 1 and 2 are checked and consumed inside ONE transaction that holds a
 * lock on both the email and the IP. Checking them in separate transactions
 * would let a burst of concurrent requests pass rule 2 simultaneously.
 *
 * Lock ordering is handled by txWithLocks (sorted), so the email+IP pair can
 * never deadlock against another request holding the same pair.
 */

export const SCOPE = {
  REPORT_IP: 'report_ip',
  SCAN_IP: 'scan_ip',
};

const WINDOW_HOURS = 24;

/** Human phrasing for when the visitor may try again. */
function retryPhrase(retryAt) {
  if (!retryAt) return 'in 24 hours';
  const ms = new Date(retryAt).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) return 'in about an hour';
  return `in about ${hours} hours`;
}

/**
 * Gate a scan request. Consumes one unit of the per-IP scan quota.
 * Cache hits should NOT call this — serving a cached result costs nothing.
 */
export async function consumeScanQuota(store, ipHash) {
  if (!ipHash) return { allowed: true, used: 0, limit: config.limits.scansPerIpPerDay };

  return store.txWithLocks([`${SCOPE.SCAN_IP}:${ipHash}`], async (client) => {
    const result = await store.consumeRollingQuota(client, {
      scope: SCOPE.SCAN_IP,
      subject: ipHash,
      limit: config.limits.scansPerIpPerDay,
      windowHours: WINDOW_HOURS,
    });
    if (!result.allowed) {
      throw new QuotaError(
        'scan_ip_limit',
        `You've used all ${result.limit} free scans for today. You can run more ${retryPhrase(result.retryAt)}.`,
        { limit: result.limit, retryAt: result.retryAt },
      );
    }
    return result;
  });
}

/**
 * Reserve a report: enforce both quotas, create/attach the lead, and create the
 * report row in 'pending' — all atomically. Delivery happens afterwards outside
 * the transaction, and failure is refunded via releaseReport().
 *
 * @returns {{ lead: object, report: object }}
 */
export async function reserveReport(store, { identity, lead: leadInput, scan, ipHash }) {
  const locks = [`lead:${identity.normalized}`];
  if (ipHash) locks.push(`${SCOPE.REPORT_IP}:${ipHash}`);

  return store.txWithLocks(locks, async (client) => {
    // --- Rule 1: one report per email, ever -------------------------------
    const lead = await store.upsertLead(client, leadInput);
    const alreadySent = await store.countReportsForLead(client, lead.id);

    if (alreadySent >= config.limits.reportsPerEmail) {
      throw new QuotaError(
        'email_limit',
        config.limits.reportsPerEmail === 1
          ? "We've already sent a report to this address — check your inbox (and your spam folder). Need another site audited? Talk to our team."
          : `This address has already received ${alreadySent} reports.`,
        { limit: config.limits.reportsPerEmail, alreadySent },
      );
    }

    // --- Rule 2: three reports per IP per rolling 24h ----------------------
    if (ipHash) {
      const ipResult = await store.consumeRollingQuota(client, {
        scope: SCOPE.REPORT_IP,
        subject: ipHash,
        limit: config.limits.reportsPerIpPerDay,
        windowHours: WINDOW_HOURS,
        meta: { origin: scan.origin ?? null },
      });
      if (!ipResult.allowed) {
        throw new QuotaError(
          'ip_limit',
          `This network has requested the maximum of ${ipResult.limit} reports today. You can request another ${retryPhrase(ipResult.retryAt)}.`,
          { limit: ipResult.limit, retryAt: ipResult.retryAt },
        );
      }
    }

    const report = await store.createReport(client, {
      leadId: lead.id,
      scanId: scan.id,
      ipHash,
    });
    await store.attachScanToLead(client, lead.id, scan);

    return { lead, report };
  });
}

/**
 * Refund the quota when delivery failed on our side. Without this, an outage in
 * the mail provider would permanently burn the visitor's one allowed report.
 *
 * Deliberately does NOT refund the email rule by deleting the lead — the lead is
 * still a real lead worth keeping. It clears the report row (marked failed, so
 * countReportsForLead ignores it) and returns the IP unit.
 */
export async function releaseReport(store, { report, ipHash, reason }) {
  await store.markReportFailed(report.id, reason);
  if (ipHash) await store.releaseRollingQuota(SCOPE.REPORT_IP, ipHash);
}

/** Read-only view of remaining allowance, for the UI and for /api/health. */
export async function quotaStatus(store, ipHash) {
  if (!ipHash) return null;
  const [scansUsed, reportsUsed] = await Promise.all([
    store.countRecent(SCOPE.SCAN_IP, ipHash, WINDOW_HOURS),
    store.countRecent(SCOPE.REPORT_IP, ipHash, WINDOW_HOURS),
  ]);
  return {
    scans: { used: scansUsed, limit: config.limits.scansPerIpPerDay },
    reports: { used: reportsUsed, limit: config.limits.reportsPerIpPerDay },
  };
}

export { QuotaError };

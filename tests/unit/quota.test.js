import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, QuotaError } from '../../server/lib/store.js';
import { reserveReport, releaseReport, consumeScanQuota, quotaStatus } from '../../server/lib/quota.js';
import { normalizeEmail } from '../../server/lib/identity.js';
import config from '../../server/lib/config.js';

const IP_A = 'hash-ip-aaaa';
const IP_B = 'hash-ip-bbbb';

async function freshStore() {
  return MemoryStore.create();
}

async function makeScan(store, origin = 'https://shop.example') {
  return store.insertScan({
    requestedUrl: origin, origin, status: 'ok',
    scoreOverall: 61, scoreA11y: 54, scoreSeo: 72,
    violationsTotal: 18, violationsCritical: 2, violationsSerious: 6,
    pagesScanned: 3,
  });
}

function leadInput(rawEmail, extra = {}) {
  const identity = normalizeEmail(rawEmail);
  return {
    identity,
    lead: {
      name: 'Test Person',
      email: identity.email,
      emailNormalized: identity.normalized,
      emailDomain: identity.domain,
      phone: '+15550100000',
      website: 'https://shop.example',
      websiteOrigin: 'https://shop.example',
      source: 'audit_report',
      consentAt: new Date().toISOString(),
      ...extra,
    },
  };
}

/* ------------------------------------------------------- rule 1: email --- */

test('one report per email address', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);
  const { identity, lead } = leadInput('buyer@example.com');

  const first = await reserveReport(store, { identity, lead, scan, ipHash: IP_A });
  assert.ok(first.report.id);

  await assert.rejects(
    () => reserveReport(store, { identity, lead, scan, ipHash: IP_B }),
    (err) => err instanceof QuotaError && err.code === 'email_limit',
    'the same address must not get a second report even from a different IP',
  );
});

test('plus-tagging and gmail dots cannot buy a second report', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);

  const a = leadInput('carlos@gmail.com');
  await reserveReport(store, { identity: a.identity, lead: a.lead, scan, ipHash: IP_A });

  for (const variant of ['carlos+promo@gmail.com', 'c.a.r.l.o.s@gmail.com', 'CARLOS@googlemail.com']) {
    const v = leadInput(variant);
    await assert.rejects(
      () => reserveReport(store, { identity: v.identity, lead: v.lead, scan, ipHash: IP_B }),
      (err) => err instanceof QuotaError && err.code === 'email_limit',
      `${variant} must collapse to the original address`,
    );
  }
});

/* ---------------------------------------------------------- rule 2: IP --- */

test('three reports per IP per day, then blocked', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);

  for (let i = 0; i < config.limits.reportsPerIpPerDay; i += 1) {
    const { identity, lead } = leadInput(`person${i}@example.com`);
    await reserveReport(store, { identity, lead, scan, ipHash: IP_A });
  }

  const extra = leadInput('one-too-many@example.com');
  await assert.rejects(
    () => reserveReport(store, { identity: extra.identity, lead: extra.lead, scan, ipHash: IP_A }),
    (err) => err instanceof QuotaError && err.code === 'ip_limit',
  );

  // A different network is unaffected.
  const other = leadInput('different-network@example.com');
  const ok = await reserveReport(store, { identity: other.identity, lead: other.lead, scan, ipHash: IP_B });
  assert.ok(ok.report.id);
});

/* ------------------------------------------------------------ races ----- */

test('concurrent requests for the same email yield exactly one report', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);
  const { identity, lead } = leadInput('racer@example.com');

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => reserveReport(store, { identity, lead, scan, ipHash: IP_A })),
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent request may win');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'email_limit'));
});

test('concurrent requests from one IP respect the daily cap exactly', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);

  const attempts = Array.from({ length: 15 }, (_, i) => {
    const { identity, lead } = leadInput(`racer${i}@example.com`);
    return () => reserveReport(store, { identity, lead, scan, ipHash: IP_A });
  });

  const results = await Promise.allSettled(attempts.map((fn) => fn()));
  const fulfilled = results.filter((r) => r.status === 'fulfilled');

  assert.equal(
    fulfilled.length,
    config.limits.reportsPerIpPerDay,
    `expected exactly ${config.limits.reportsPerIpPerDay} winners, got ${fulfilled.length}`,
  );
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ip_limit'));
});

/* ---------------------------------------------------------- refunding --- */

test('a failed delivery refunds the IP unit but keeps the lead', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);

  const first = leadInput('bounce@example.com');
  const reserved = await reserveReport(store, { identity: first.identity, lead: first.lead, scan, ipHash: IP_A });

  await releaseReport(store, { report: reserved.report, ipHash: IP_A, reason: 'smtp timeout' });

  const status = await quotaStatus(store, IP_A);
  assert.equal(status.reports.used, 0, 'IP allowance is returned');

  // The lead itself is still recorded — it is a real lead regardless of delivery.
  const stored = await store.findLeadByNormalizedEmail(first.identity.normalized);
  assert.ok(stored, 'lead is retained');

  // And the visitor may retry, because the failed report is not counted.
  const retry = await reserveReport(store, { identity: first.identity, lead: first.lead, scan, ipHash: IP_A });
  assert.ok(retry.report.id, 'retry after our own failure is allowed');
});

/* -------------------------------------------------------- scan quota ---- */

test('scan quota caps per IP and is independent of the report quota', async () => {
  const store = await freshStore();
  for (let i = 0; i < config.limits.scansPerIpPerDay; i += 1) {
    await consumeScanQuota(store, IP_A);
  }
  await assert.rejects(
    () => consumeScanQuota(store, IP_A),
    (err) => err instanceof QuotaError && err.code === 'scan_ip_limit',
  );

  const status = await quotaStatus(store, IP_A);
  assert.equal(status.scans.used, config.limits.scansPerIpPerDay);
  assert.equal(status.reports.used, 0, 'scanning does not consume report allowance');
});

test('concurrent scans respect the cap exactly', async () => {
  const store = await freshStore();
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () => consumeScanQuota(store, IP_B)),
  );
  assert.equal(
    results.filter((r) => r.status === 'fulfilled').length,
    config.limits.scansPerIpPerDay,
  );
});

test('quota errors carry a visitor-safe message and a 429', async () => {
  const store = await freshStore();
  const scan = await makeScan(store);
  const { identity, lead } = leadInput('once@example.com');
  await reserveReport(store, { identity, lead, scan, ipHash: IP_A });

  try {
    await reserveReport(store, { identity, lead, scan, ipHash: IP_A });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 429);
    assert.equal(err.public, true);
    assert.match(err.message, /already sent a report/i);
  }
});

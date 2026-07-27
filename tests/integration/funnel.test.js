import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end test of the funnel described in the brief:
 *
 *   scan a site  ->  capture name/email/phone  ->  record the lead with its
 *   results  ->  email the PDF  ->  enforce 1 report per email and 3 per IP/day
 *
 * Runs against the real Express app over real HTTP, with the real scanner and
 * real PDF generation. Only the mail transport is captured rather than sent.
 */

process.env.SCAN_ALLOW_PRIVATE = '1';
process.env.NODE_ENV = 'test';
process.env.IP_HASH_SALT = 'test-salt-that-is-long-enough-to-be-valid-32';
// The per-minute burst ceilings are transport-level guards, exercised separately.
// Left at their defaults they would throttle the suite itself, since every test
// scans from the same address inside one minute. The DAILY quotas under test
// here are untouched.
process.env.LIMIT_SCAN_BURST_PER_MIN = '500';
process.env.LIMIT_SCANS_PER_IP_PER_DAY = '500';
process.env.LIMIT_REPORT_BURST_PER_MIN = '500';
process.env.LIMIT_API_BURST_PER_MIN = '2000';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

const app = (await import('../../server/app.js')).default;
const { getStore, MemoryStore, _setStoreForTests } = await import('../../server/lib/store.js');
const { getTransport } = await import('../../server/lib/email.js');
const { closeBrowser } = await import('../../server/lib/browser.js');
const config = (await import('../../server/lib/config.js')).default;

let fixtureServer;
let fixtureBase;
let apiServer;
let apiBase;
const sent = [];

before(async () => {
  fixtureServer = http.createServer((req, res) => {
    const name = req.url === '/' ? 'broken.html' : path.basename(req.url.split('?')[0]);
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

  apiServer = http.createServer(app);
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;

  // Capture outbound mail instead of sending it.
  const transport = await getTransport();
  transport.send = async (message) => {
    sent.push(message);
    return { id: `test-${sent.length}`, provider: 'test' };
  };
});

after(async () => {
  await closeBrowser();
  await new Promise((r) => fixtureServer.close(r));
  await new Promise((r) => apiServer.close(r));
});

beforeEach(async () => {
  // A fresh store per test keeps quota assertions independent.
  _setStoreForTests(await MemoryStore.create());
  sent.length = 0;
});

/* ------------------------------------------------------------- helpers --- */

async function post(pathname, body, { ip = '203.0.113.10' } = {}) {
  const response = await fetch(apiBase + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // trust proxy = 1, so this is the address Express will believe.
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const scanFixture = (file = 'broken.html', opts) => post('/api/scan', { url: `${fixtureBase}/${file}` }, opts);

const reportBody = (scanId, over = {}) => ({
  scanId,
  name: 'Dana Fields',
  email: 'dana@example.com',
  phone: '+1 555 010 4477',
  consent: true,
  ...over,
});

/* ---------------------------------------------------------------- scan --- */

test('POST /api/scan returns a real audit and a scanId', async () => {
  const { status, body } = await scanFixture();

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.scanId, /^[0-9a-f-]{36}$/);
  assert.ok(body.scores.overall < 60, 'the broken fixture must score badly');
  assert.ok(body.accessibility.failedCriteria.includes('1.1.1'));
  assert.ok(body.accessibility.issues.length > 0);
  assert.ok(body.seo.checks.length === 14);
  assert.ok(body.axeVersion.startsWith('4.'));

  // Node-level payloads must not leak into the public response.
  assert.equal(body.accessibility.issues[0].sample, undefined);
});

test('a malformed URL is rejected with a helpful message', async () => {
  const { status, body } = await post('/api/scan', { url: 'not a url' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /valid web address/i);
});

test('the second scan of an origin is served from cache and is free', async () => {
  const first = await scanFixture();
  assert.equal(first.body.cached, false);

  const second = await scanFixture();
  assert.equal(second.body.cached, true, 'same origin within the TTL should hit cache');
  assert.equal(second.body.scores.overall, first.body.scores.overall);

  // A cache hit must not consume the daily scan allowance.
  const quota = await (await fetch(`${apiBase}/api/quota`, { headers: { 'X-Forwarded-For': '203.0.113.10' } })).json();
  assert.equal(quota.quota.scans.used, 1, 'only the uncached scan is counted');
});

/* -------------------------------------------------------------- report --- */

test('the full funnel records the lead and emails the PDF', async () => {
  const scan = await scanFixture();
  const { status, body } = await post('/api/report', reportBody(scan.body.scanId));

  assert.equal(status, 200);
  assert.equal(body.status, 'sent');
  assert.match(body.deliveredTo, /^d\*\*\*@example\.com$/, 'the address is masked in the response');

  // The report reached the visitor with a PDF attached.
  const toLead = sent.find((m) => m.to === 'dana@example.com');
  assert.ok(toLead, 'a message was addressed to the lead');
  assert.equal(toLead.attachments.length, 1);
  assert.match(toLead.attachments[0].filename, /\.pdf$/);
  assert.ok(toLead.attachments[0].content.length > 20_000, 'the PDF has real content');
  assert.ok(toLead.attachments[0].content.subarray(0, 5).toString() === '%PDF-', 'it is a real PDF');
  assert.match(toLead.subject, /accessibility report/i);

  // Everything the brief asked to be recorded is in the lead row.
  const store = await getStore();
  const leads = await store.listLeads({});
  assert.equal(leads.length, 1);
  const lead = leads[0];
  assert.equal(lead.client_name, 'Dana Fields');
  assert.equal(lead.email, 'dana@example.com');
  assert.equal(lead.phone, '+15550104477');
  assert.ok(lead.website.startsWith('http://127.0.0.1'), 'the audited website is recorded');
  assert.equal(typeof lead.score_overall, 'number');
  assert.equal(typeof lead.score_accessibility, 'number');
  assert.equal(typeof lead.score_seo, 'number');
  assert.ok(lead.violations_total > 0, 'the results it got are recorded');
  assert.equal(lead.report_status, 'sent');
  assert.ok(lead.consent_at, 'consent is timestamped');
});

test('the PDF is never returned to the browser, only emailed', async () => {
  const scan = await scanFixture();
  const { body } = await post('/api/report', reportBody(scan.body.scanId));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('%PDF'), 'no PDF bytes in the response');
  assert.equal(body.pdf, undefined);
  assert.equal(body.downloadUrl, undefined);
});

test('a stale or unknown scanId is refused', async () => {
  const { status, body } = await post('/api/report', reportBody('11111111-2222-3333-4444-555555555555'));
  assert.equal(status, 400);
  assert.match(body.error, /expired/i);
});

test('missing consent is refused', async () => {
  const scan = await scanFixture();
  const { status, body } = await post('/api/report', reportBody(scan.body.scanId, { consent: false }));
  assert.equal(status, 400);
  assert.match(body.error, /privacy policy/i);
});

test('a disposable address is refused, because delivery is the product', async () => {
  const scan = await scanFixture();
  const { status, body } = await post('/api/report', reportBody(scan.body.scanId, { email: 'x@mailinator.com' }));
  assert.equal(status, 400);
  assert.equal(body.field, 'email');
  assert.match(body.error, /permanent email/i);
});

/* -------------------------------------------------------------- limits --- */

test('one report per email address, even from a different IP', async () => {
  const scan = await scanFixture();
  const first = await post('/api/report', reportBody(scan.body.scanId), { ip: '203.0.113.20' });
  assert.equal(first.status, 200);

  const second = await post('/api/report', reportBody(scan.body.scanId), { ip: '198.51.100.99' });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'email_limit');
  assert.match(second.body.error, /already sent a report/i);
});

test('plus-tagging the same inbox does not earn a second report', async () => {
  const scan = await scanFixture();
  await post('/api/report', reportBody(scan.body.scanId, { email: 'growth@gmail.com' }), { ip: '203.0.113.30' });

  const retry = await post(
    '/api/report',
    reportBody(scan.body.scanId, { email: 'g.r.o.w.t.h+audit@googlemail.com' }),
    { ip: '198.51.100.31' },
  );
  assert.equal(retry.status, 429);
  assert.equal(retry.body.code, 'email_limit');
});

test('three reports per IP per day, then blocked', async () => {
  const ip = '203.0.113.77';
  const scan = await scanFixture('broken.html', { ip });

  for (let i = 0; i < config.limits.reportsPerIpPerDay; i += 1) {
    const res = await post('/api/report', reportBody(scan.body.scanId, { email: `person${i}@example.com` }), { ip });
    assert.equal(res.status, 200, `report ${i + 1} should succeed`);
  }

  const blocked = await post('/api/report', reportBody(scan.body.scanId, { email: 'fourth@example.com' }), { ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'ip_limit');

  // A different network is unaffected.
  const other = await post('/api/report', reportBody(scan.body.scanId, { email: 'elsewhere@example.com' }), { ip: '198.51.100.5' });
  assert.equal(other.status, 200);
});

/**
 * REGRESSION — the per-IP cap was completely inert over IPv6.
 *
 * `clientIp()` returned an already-normalized value and the routes then called
 * `hashIp(clientIp(req))`, normalizing twice. An IPv6 /64 prefix is not a
 * parseable literal, so the second pass returned null, and every quota check
 * (`if (ipHash)`) silently skipped. Any visitor on IPv6 — most residential and
 * mobile connections — had unlimited reports, with no attacker effort at all.
 *
 * The IPv4 tests above all passed throughout, which is exactly why this needs
 * its own test at the HTTP level.
 */
test('the per-IP cap applies over IPv6, not just IPv4', async () => {
  const ipv6 = '2a00:1450:4001:80f:abcd:1234:5678:9abc';
  const scan = await scanFixture('broken.html', { ip: ipv6 });

  for (let i = 0; i < config.limits.reportsPerIpPerDay; i += 1) {
    const res = await post('/api/report', reportBody(scan.body.scanId, { email: `v6user${i}@example.com` }), { ip: ipv6 });
    assert.equal(res.status, 200, `IPv6 report ${i + 1} should succeed`);
  }

  const blocked = await post(
    '/api/report',
    reportBody(scan.body.scanId, { email: 'v6-too-many@example.com' }),
    { ip: ipv6 },
  );
  assert.equal(blocked.status, 429, 'the fourth IPv6 report must be refused');
  assert.equal(blocked.body.code, 'ip_limit');
});

test('rotating the host part of an IPv6 address does not buy more reports', async () => {
  // A subscriber owns an entire /64 — billions of addresses. Counting full
  // addresses would make the cap meaningless.
  const prefix = '2001:db8:1234:5678';
  const scan = await scanFixture('broken.html', { ip: `${prefix}::1` });

  for (let i = 0; i < config.limits.reportsPerIpPerDay; i += 1) {
    const res = await post(
      '/api/report',
      reportBody(scan.body.scanId, { email: `rot${i}@example.com` }),
      { ip: `${prefix}:aaaa:bbbb:cccc:${1000 + i}` },
    );
    assert.equal(res.status, 200);
  }

  const blocked = await post(
    '/api/report',
    reportBody(scan.body.scanId, { email: 'rot-extra@example.com' }),
    { ip: `${prefix}:ffff:eeee:dddd:9999` },
  );
  assert.equal(blocked.status, 429, 'a different address in the same /64 is the same client');
  assert.equal(blocked.body.code, 'ip_limit');

  // A genuinely different /64 is a different client.
  const other = await post(
    '/api/report',
    reportBody(scan.body.scanId, { email: 'other-prefix@example.com' }),
    { ip: '2001:db8:1234:9999::1' },
  );
  assert.equal(other.status, 200);
});

test('a bot-trapped submission gets a fake success and records nothing', async () => {
  const scan = await scanFixture();
  const { status, body } = await post('/api/report', {
    ...reportBody(scan.body.scanId),
    company_website: 'http://spam.example',
  });

  assert.equal(status, 200);
  assert.equal(body.status, 'sent', 'the bot is told it worked');

  const store = await getStore();
  assert.equal((await store.listLeads({})).length, 0, 'but no lead was created');
  assert.equal(sent.length, 0, 'and nothing was emailed');
});

/* ---------------------------------------------------------------- lead --- */

test('POST /api/lead captures a sales enquiry', async () => {
  const { status, body } = await post('/api/lead', {
    source: 'contact_sales',
    firstName: 'Sam',
    lastName: 'Okonkwo',
    email: 'sam@brand.example',
    company: 'Brand Co',
    website: 'https://brand.example',
    platform: 'Shopify Plus',
    message: 'We were served last week.',
    consent: true,
  });

  assert.equal(status, 200);
  assert.equal(body.status, 'received');

  const store = await getStore();
  const leads = await store.listLeads({});
  assert.equal(leads[0].client_name, 'Sam Okonkwo');
  assert.equal(leads[0].source, 'contact_sales');
});

test('a signup lead never carries a password', async () => {
  await post('/api/lead', {
    source: 'signup',
    firstName: 'Rae',
    email: 'rae@brand.example',
    website: 'https://brand.example',
    plan: 'growth',
    password: 'hunter2-should-be-ignored',
    consent: true,
  });

  const store = await getStore();
  const lead = await store.findLeadByNormalizedEmail('rae@brand.example');
  assert.ok(lead);
  assert.equal(lead.password, undefined);
  assert.ok(!JSON.stringify(lead).includes('hunter2'), 'no password is persisted anywhere on the lead');
});

/* --------------------------------------------------------------- admin --- */

test('the lead export is not readable without the admin token', async () => {
  const res = await fetch(`${apiBase}/api/admin/leads`);
  assert.ok([401, 503].includes(res.status), `expected 401/503, got ${res.status}`);
});

/* -------------------------------------------------------------- health --- */

test('GET /api/health reports subsystem readiness', async () => {
  const res = await fetch(`${apiBase}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.scanner, true);
  assert.ok(body.axe.startsWith('4.'));
});

/* ------------------------------------------------------------ security --- */

test('security headers are set on HTML responses', async () => {
  const res = await fetch(`${apiBase}/api/health`);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('permissions-policy') ?? '', /geolocation=\(\)/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('a cross-origin API call is refused', async () => {
  const res = await fetch(`${apiBase}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'bad_origin');
});

test('the scanner refuses internal addresses even though tests allow loopback', async () => {
  // SCAN_ALLOW_PRIVATE is on for the fixture server, so assert on the rules that
  // remain active regardless: scheme and shape.
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'javascript:alert(1)']) {
    const { status, body } = await post('/api/scan', { url });
    assert.equal(status, 400, `${url} must be refused`);
    assert.equal(body.ok, false);
  }
});

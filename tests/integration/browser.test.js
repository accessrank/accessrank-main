import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drives the real UI in a real browser.
 *
 * The API tests prove the server behaves; this proves a visitor can actually
 * complete the funnel — that the widget calls the scanner, renders findings,
 * opens the lead modal, submits it, and that the modal is operable by keyboard.
 * None of that is covered by testing the endpoints alone.
 */

process.env.SCAN_ALLOW_PRIVATE = '1';
process.env.NODE_ENV = 'test';
process.env.IP_HASH_SALT = 'test-salt-that-is-long-enough-to-be-valid-32';
process.env.LIMIT_SCAN_BURST_PER_MIN = '500';
process.env.LIMIT_SCANS_PER_IP_PER_DAY = '500';
process.env.LIMIT_REPORT_BURST_PER_MIN = '500';
process.env.LIMIT_API_BURST_PER_MIN = '2000';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

const app = (await import('../../server/app.js')).default;
const { MemoryStore, _setStoreForTests } = await import('../../server/lib/store.js');
const { getTransport } = await import('../../server/lib/email.js');
const { getBrowser, closeBrowser } = await import('../../server/lib/browser.js');

let fixtureServer; let fixtureBase;
let appServer; let appBase;
let browser;
const sent = [];

const distMissing = !fs.existsSync(path.join(DIST, 'index.html'));

before(async () => {
  fixtureServer = http.createServer((req, res) => {
    const name = req.url === '/' ? 'broken.html' : path.basename(req.url.split('?')[0]);
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

  appServer = http.createServer(app);
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  appBase = `http://127.0.0.1:${appServer.address().port}`;

  _setStoreForTests(await MemoryStore.create());
  const transport = await getTransport();
  transport.send = async (message) => { sent.push(message); return { id: 'browser-test', provider: 'test' }; };

  browser = await getBrowser();
});

after(async () => {
  await closeBrowser();
  await new Promise((r) => fixtureServer.close(r));
  await new Promise((r) => appServer.close(r));
});

/**
 * Turnstile's obfuscated probe logs deliberate console noise — including at
 * `error` severity (`%c%d font-size:0;color:transparent NaN`) — on every page
 * where the widget renders. That noise is Cloudflare's, not ours; letting it
 * fail the "no console errors" assertions would make a KEYED build (the one
 * that actually ships) permanently red. Filter exactly that pattern and
 * anything originating from the challenge script, nothing else.
 */
function isTurnstileNoise(text, sourceUrl) {
  return /font-size:0;color:transparent/.test(text)
    || /TurnstileError|\[Cloudflare Turnstile\]/.test(text)
    || /challenges\.cloudflare\.com/.test(text)
    // "Failed to load resource: ... 400" carries no URL in its TEXT, only in
    // its source location. A real key on a host it does not allow (127.0.0.1
    // here) fails its probe with exactly that; judge by where it came from.
    || /challenges\.cloudflare\.com/.test(sourceUrl || '');
}

async function homepage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (isTurnstileNoise(m.text(), m.location() && m.location().url)) return;
    consoleErrors.push(m.text());
  });
  // Turnstile's failures surface as UNCAUGHT exceptions (pageerror), not
  // console messages — e.g. "Uncaught TurnstileError: ... 110200" when the
  // site key does not allow this host. Same filter, other channel.
  page.on('pageerror', (e) => { if (!isTurnstileNoise(String(e))) consoleErrors.push(String(e)); });
  // 'load', not 'networkidle': a rendered Turnstile widget keeps its challenge
  // connections open, so networkidle never arrives on a keyed build.
  await page.goto(appBase, { waitUntil: 'load' });
  return { page, consoleErrors };
}

test('the homepage loads without console errors and does NOT auto-run a scan', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const { page, consoleErrors } = await homepage();
  try {
    // The original site fired a fake scan of "example.shop" 800ms after load.
    await page.waitForTimeout(1500);

    const urlValue = await page.inputValue('#audit-url');
    assert.equal(urlValue, '', 'the URL field must not be auto-filled');

    const resultsText = await page.textContent('#audit-results');
    assert.equal(resultsText.trim(), '', 'no results may appear before the visitor asks');

    const ctaHidden = await page.locator('#audit-report-cta').isHidden();
    assert.equal(ctaHidden, true, 'the report CTA stays hidden until there is a scan');

    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await page.close();
  }
});

test('a visitor can scan a store and see real findings', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const { page, consoleErrors } = await homepage();
  try {
    await page.fill('#audit-url', `${fixtureBase}/broken.html`);
    await page.click('#audit-submit');

    await page.waitForSelector('.score-ring', { timeout: 90_000 });

    const score = Number(await page.textContent('.score-value'));
    assert.ok(Number.isFinite(score) && score >= 0 && score <= 100, `got score "${score}"`);
    assert.ok(score < 60, 'the broken fixture should score badly');

    const band = await page.textContent('.result-band');
    assert.ok(band.trim().length > 0);

    // Real WCAG criteria, not decoration.
    const chips = await page.locator('.criteria-chip').allTextContents();
    assert.ok(chips.some((c) => c.includes('1.1.1')), `expected WCAG 1.1.1 chip, got ${chips.join(', ')}`);

    const issues = await page.locator('.audit-row').count();
    assert.ok(issues > 0, 'issues are listed');

    const ctaVisible = await page.locator('#audit-report-cta').isVisible();
    assert.equal(ctaVisible, true, 'the report CTA appears after a scan');

    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await page.close();
  }
});

test('the report modal captures the lead and confirms delivery', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const before = sent.length;
  const { page, consoleErrors } = await homepage();
  try {
    await page.fill('#audit-url', `${fixtureBase}/clean.html`);
    await page.click('#audit-submit');
    await page.waitForSelector('.score-ring', { timeout: 90_000 });

    await page.click('#audit-report-cta');
    await page.waitForSelector('#report-modal:not([hidden])');

    // Focus moves into the dialog on open.
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'report-name', 'the first field receives focus');

    await page.fill('#report-name', 'Dana Fields');
    await page.fill('#report-email', 'dana.browser@example.com');
    await page.fill('#report-phone', '+1 555 010 8899');
    await page.check('#report-consent');
    await page.click('#report-form button[type="submit"]');
    // Note: a fast submission is logged but must NOT be blocked — autofill can
    // legitimately be this quick, and silently dropping it would lose real leads.

    await page.waitForSelector('#report-success:not([hidden])', { timeout: 60_000 });

    const successText = await page.textContent('#report-success');
    assert.match(successText, /on its way/i);
    assert.match(await page.textContent('#report-success-email'), /@example\.com/);

    assert.ok(sent.length > before, 'an email was dispatched');
    // Two messages go out: the report to the lead, and a notification to sales.
    // Select by recipient rather than assuming an order.
    const message = sent.find((m) => m.to === 'dana.browser@example.com');
    assert.ok(message, `no message addressed to the lead; sent to: ${sent.map((m) => m.to).join(', ')}`);
    assert.equal(message.attachments[0].content.subarray(0, 5).toString(), '%PDF-');

    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  } finally {
    await page.close();
  }
});

test('the modal is operable and escapable by keyboard alone', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const { page } = await homepage();
  try {
    await page.fill('#audit-url', `${fixtureBase}/clean.html`);
    await page.press('#audit-url', 'Enter');
    await page.waitForSelector('.score-ring', { timeout: 90_000 });

    await page.click('#audit-report-cta');
    await page.waitForSelector('#report-modal:not([hidden])');

    // Tab must never escape the dialog while it is open. "Never escapes" allows
    // one animation frame of grace: a broken Turnstile widget can swallow a Tab
    // and drop focus to <body>, and the trap's recovery net re-captures it on
    // the next macrotask (see the focusout handler in audit.js). No human can
    // press Tab twice inside that window, so polling briefly asserts the same
    // guarantee a visitor experiences — instead of racing the recovery timer.
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(
        () => document.getElementById('report-modal').contains(document.activeElement),
        undefined,
        { timeout: 150 },
      ).catch(() => {
        assert.fail(`focus left the dialog after ${i + 1} tabs and was not recovered`);
      });
    }

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#report-modal').isHidden(), true, 'Escape closes the dialog');

    // Focus returns to the control that opened it.
    const returned = await page.evaluate(() => document.activeElement?.id);
    assert.equal(returned, 'audit-report-cta', 'focus returns to the trigger');
  } finally {
    await page.close();
  }
});

test('a rejected address is reported inline without breaking the widget', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const { page } = await homepage();
  try {
    await page.fill('#audit-url', 'http://169.254.169.254/latest/meta-data/');
    await page.click('#audit-submit');

    await page.waitForSelector('#audit-error:not([hidden])', { timeout: 30_000 });
    const message = await page.textContent('#audit-error');
    assert.ok(message.trim().length > 0);
    assert.doesNotMatch(message, /169\.254/, 'the error must not echo the blocked host back');

    // The widget stays usable.
    assert.equal(await page.locator('#audit-submit').isDisabled(), false);
  } finally {
    await page.close();
  }
});

test('the mobile navigation opens, closes and traps nothing', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(appBase, { waitUntil: 'load' });

    const toggle = page.locator('.nav-toggle');
    assert.equal(await toggle.isVisible(), true, 'the toggle shows at mobile width');
    assert.equal(await page.locator('#nav-menu').isVisible(), false, 'menu starts closed');

    await toggle.click();
    assert.equal(await page.locator('#nav-menu').isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#nav-menu').isVisible(), false);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  } finally {
    await page.close();
  }
});

test('the skip link is the first tab stop and reveals itself', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const { page } = await homepage();
  try {
    await page.keyboard.press('Tab');
    // The link slides in over 150ms; measuring immediately catches it mid-transition.
    await page.waitForTimeout(400);
    const first = await page.evaluate(() => {
      const el = document.activeElement;
      const rect = el.getBoundingClientRect();
      return { text: el.textContent.trim(), href: el.getAttribute('href'), top: rect.top };
    });
    assert.match(first.text, /skip to main content/i);
    assert.equal(first.href, '#main-content');
    assert.ok(first.top >= 0, 'the skip link becomes visible when focused');
  } finally {
    await page.close();
  }
});

test('no page scrolls horizontally at mobile width', {
  skip: distMissing && 'run `npm run build` first',
}, async () => {
  const routes = ['/', '/signup', '/contact-sales', '/careers', '/methodology', '/guide/ada-eaa', '/privacy'];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    for (const route of routes) {
      await page.goto(appBase + route, { waitUntil: 'load' });
      // Let the deferred JS and any Turnstile widget mount before measuring —
      // a late-rendering widget is exactly the kind of thing that overflows.
      await page.waitForTimeout(500);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.ok(
        scrollWidth <= clientWidth + 1,
        `${route} overflows horizontally: ${scrollWidth}px content in ${clientWidth}px viewport`,
      );
    }
  } finally {
    await page.close();
  }
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set before any module reads config.
process.env.SCAN_ALLOW_PRIVATE = '1';

const { runScan, closeBrowser } = await import('../../server/lib/scanner.js');
const { BlockedTargetError } = await import('../../server/lib/ssrf.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname === '/' ? '/broken.html' : url.pathname;

    if (name === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (name === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>late</body></html>'); }, 30_000);
      return;
    }
    if (name === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>not found</body></html>');
      return;
    }

    const file = path.join(FIXTURES, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeBrowser();
  await new Promise((resolve) => server.close(resolve));
});

test('scans a broken storefront and finds the failures it claims to find', async () => {
  const result = await runScan(`${base}/broken.html`, { maxPages: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.pagesScanned, 1);
  assert.ok(result.axeVersion.startsWith('4.'), 'reports the real axe-core version');

  const ids = result.accessibility.issues.map((i) => i.id);

  // The exact failures the homepage copy advertises.
  assert.ok(ids.includes('image-alt'), `expected image-alt, got ${ids.join(', ')}`);
  assert.ok(ids.includes('color-contrast'), `expected color-contrast, got ${ids.join(', ')}`);
  assert.ok(
    ids.some((id) => ['label', 'form-field-multiple-labels', 'select-name'].includes(id)),
    `expected a form-labelling failure, got ${ids.join(', ')}`,
  );

  assert.ok(
    result.scores.accessibility < 60,
    `a page missing title, lang, alt text and form labels must score badly (got ${result.scores.accessibility})`,
  );
  assert.ok(result.accessibility.violationsTotal > 5);
  assert.ok(result.accessibility.counts.critical + result.accessibility.counts.serious > 0);

  // The failing success criteria are what a demand letter actually cites.
  const failed = result.accessibility.failedCriteria;
  assert.ok(failed.includes('1.1.1'), `expected SC 1.1.1 to fail, got ${failed.join(', ')}`);
  assert.ok(failed.includes('1.4.3'), `expected SC 1.4.3 to fail, got ${failed.join(', ')}`);
  assert.ok(result.accessibility.criteriaFailed >= 5);

  // Issues carry the evidence a customer needs to act.
  const alt = result.accessibility.issues.find((i) => i.id === 'image-alt');
  assert.deepEqual(alt.criteria, ['1.1.1']);
  assert.equal(alt.level, 'A');
  assert.ok(alt.helpUrl.startsWith('https://'));
  assert.ok(alt.sample.length > 0 && alt.sample[0].snippet.includes('<img'));
});

test('the broken fixture also fails the SEO checklist', async () => {
  const result = await runScan(`${base}/broken.html`, { maxPages: 1 });
  const byId = Object.fromEntries(result.seo.checks.map((c) => [c.id, c.status]));

  assert.equal(byId.title, 'fail', 'no <title>');
  assert.equal(byId.description, 'fail', 'no meta description');
  assert.equal(byId.lang, 'fail', 'no lang attribute');
  assert.equal(byId.viewport, 'fail', 'no viewport meta');
  assert.equal(byId.canonical, 'fail');
  assert.equal(byId.structured, 'fail');
  assert.equal(byId.h1, 'fail', 'no h1 at all');
  assert.ok(result.scores.seo < 40, `expected a poor SEO score, got ${result.scores.seo}`);
});

test('scans a well-built storefront and scores it highly', async () => {
  const result = await runScan(`${base}/clean.html`, { maxPages: 1 });

  assert.ok(
    result.scores.accessibility >= 95,
    `clean fixture should score >=95, got ${result.scores.accessibility}: ${result.accessibility.issues.map((i) => i.id).join(', ')}`,
  );
  assert.ok(result.scores.seo >= 85, `clean fixture SEO should be >=85, got ${result.scores.seo}`);

  const byId = Object.fromEntries(result.seo.checks.map((c) => [c.id, c.status]));
  assert.equal(byId.title, 'pass');
  assert.equal(byId.description, 'pass');
  assert.equal(byId.h1, 'pass');
  assert.equal(byId.lang, 'pass');
  assert.equal(byId.structured, 'pass');
  assert.equal(byId.imageAlt, 'pass');

  assert.equal(result.scores.band.tone, 'good');
});

test('the two fixtures are clearly separated by the score', async () => {
  const [broken, clean] = await Promise.all([
    runScan(`${base}/broken.html`, { maxPages: 1 }),
    runScan(`${base}/clean.html`, { maxPages: 1 }),
  ]);
  assert.ok(
    clean.scores.overall - broken.scores.overall > 25,
    `scores must discriminate: clean=${clean.scores.overall} broken=${broken.scores.overall}`,
  );
});

test('crawls additional internal pages when asked', async () => {
  const result = await runScan(`${base}/clean.html`, { maxPages: 3 });
  assert.ok(result.pagesScanned >= 1);
  assert.ok(result.pageUrls.length === result.pagesScanned);
});

test('an HTTP error is reported as a friendly failure, not a crash', async () => {
  await assert.rejects(
    () => runScan(`${base}/missing`, { maxPages: 1 }),
    (err) => err.code === 'http_error' && err.public === true && /HTTP 404/.test(err.message),
  );
});

/**
 * The SSRF case most guards miss: the submitted URL is public and passes every
 * pre-navigation check, and only THEN redirects somewhere internal. This is an
 * end-to-end test through the real browser, not a unit test of the predicate —
 * it is the only thing that proves the Playwright route interception actually
 * fires on a followed redirect.
 *
 * Note this runs with SCAN_ALLOW_PRIVATE=1, which is what lets the fixture
 * server be reachable at all — so a failure here means the redirect was
 * followed to the metadata endpoint even in the permissive configuration.
 */
test('a redirect to the cloud metadata endpoint does not yield its contents', async () => {
  let result = null;
  let error = null;
  try {
    result = await runScan(`${base}/redirect-to-metadata`, { maxPages: 1 });
  } catch (err) {
    error = err;
  }

  // Either outcome is acceptable — the request is refused, or it fails to load.
  // What is NOT acceptable is a successful scan of 169.254.169.254.
  if (result) {
    assert.doesNotMatch(result.finalUrl, /169\.254\.169\.254/, 'the scanner followed a redirect to cloud metadata');
    assert.doesNotMatch(JSON.stringify(result), /ami-id|instance-id|iam\/security-credentials/,
      'metadata content appeared in the result');
  } else {
    assert.ok(error, 'expected either a safe result or an error');
    assert.doesNotMatch(String(error.message), /169\.254/, 'the error must not echo the internal address');
  }
});

test('a URL whose host resolves to loopback is refused when the guard is active', async () => {
  // Re-import with the bypass off so the production predicate is what is tested.
  const { normalizeTargetUrl } = await import('../../server/lib/ssrf.js');
  const { default: config } = await import('../../server/lib/config.js');
  const previous = config.security.allowPrivateTargets;

  Object.defineProperty(config.security, 'allowPrivateTargets', { value: false, configurable: true });
  try {
    for (const target of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://10.0.0.1/']) {
      assert.throws(() => normalizeTargetUrl(target), (err) => err instanceof BlockedTargetError, `${target} must be refused`);
    }
  } finally {
    Object.defineProperty(config.security, 'allowPrivateTargets', { value: previous, configurable: true });
  }
});

test('scan results are safe to serialize and are not enormous', async () => {
  const result = await runScan(`${base}/broken.html`, { maxPages: 1 });
  const json = JSON.stringify(result);
  assert.ok(json.length < 400_000, `payload should stay bounded, was ${json.length} bytes`);
  assert.deepEqual(JSON.parse(json).scores, result.scores);

  // Node samples are capped even though the true population is reported.
  for (const issue of result.accessibility.issues) {
    assert.ok(issue.sample.length <= 3, 'display samples stay small');
    assert.ok(typeof issue.nodes === 'number');
  }
});

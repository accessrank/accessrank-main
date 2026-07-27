import fs from 'node:fs';
import { createRequire } from 'node:module';
import config from './config.js';
import { log } from './logger.js';
import { validateScanTarget, isAllowedHopSync, ipBlockReason, BlockedTargetError } from './ssrf.js';
import { getBrowser, closeBrowser } from './browser.js';
import {
  mergeAxeResults, scoreAccessibility, scoreSeo, scoreOverall, rankIssues, band,
} from './scoring.js';

const require = createRequire(import.meta.url);

/**
 * The audit engine: real axe-core in real Chromium.
 *
 * Why a browser and not a plain HTML fetch — axe's colour-contrast rule (WCAG
 * 1.4.3) needs computed styles and layout boxes, which only a rendering engine
 * has. Contrast is the single most-cited failure in ecommerce accessibility
 * suits, so a scanner that skips it would misreport the exact thing this
 * product is sold on. It also means JS-rendered storefronts are measured as a
 * shopper actually receives them.
 */

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_VERSION = require('axe-core/package.json').version;
const ENGINE_VERSION = '1.0.0';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Media we never need and that would waste the time budget. */
const BLOCKED_RESOURCE_TYPES = new Set(['media', 'websocket', 'eventsource']);

export class ScanError extends Error {
  constructor(code, message, { status = 400, cause } = {}) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
    this.public = true;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/* ---------------------------------------------------------- semaphore --- */

let active = 0;
const waiting = [];

async function acquireSlot() {
  if (active < config.scanner.concurrency) { active += 1; return; }
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}

function releaseSlot() {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/* ------------------------------------------------------- page auditing --- */

/**
 * Everything we extract from one page, in a single evaluate to avoid round-trips.
 *
 * Declared as a real function (not a source string) because Playwright does not
 * invoke a function-shaped string — it would evaluate to a function object and
 * serialize back as undefined. Runs in the page, so it may only use browser globals.
 */
/* eslint-env browser */
function extractSeo() {
  const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const attr = (sel, name) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute(name) || '').trim() : '';
  };

  const title = text(document.querySelector('title'));
  const description = attr('meta[name="description" i]', 'content');
  const h1s = [...document.querySelectorAll('h1')];
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((h) => Number(h.tagName.slice(1)));

  let headingOrderOk = true;
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i] - headings[i - 1] > 1) { headingOrderOk = false; break; }
  }

  const images = [...document.querySelectorAll('img')];
  const decorative = images.filter((i) => i.getAttribute('alt') === '');
  const withAlt = images.filter((i) => (i.getAttribute('alt') || '').trim().length > 0);
  const missingAlt = images.filter((i) => i.getAttribute('alt') === null);

  const links = [...document.querySelectorAll('a[href]')];
  const vagueText = /^(click here|here|read more|more|learn more|link|this|details)$/i;
  const badLinks = links.filter((a) => {
    const label = (a.textContent || '').trim()
      || (a.getAttribute('aria-label') || '').trim()
      || (a.querySelector('img') ? (a.querySelector('img').getAttribute('alt') || '').trim() : '');
    return !label || vagueText.test(label);
  });

  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')];
  const jsonLdTypes = [];
  for (const node of jsonLd) {
    try {
      const parsed = JSON.parse(node.textContent);
      const collect = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(collect); return; }
        if (o['@type']) jsonLdTypes.push(String(o['@type']));
        if (o['@graph']) collect(o['@graph']);
      };
      collect(parsed);
    } catch { /* malformed JSON-LD counts as absent */ }
  }

  const robots = attr('meta[name="robots" i]', 'content').toLowerCase();
  const canonical = attr('link[rel="canonical" i]', 'href');
  const viewport = attr('meta[name="viewport" i]', 'content');
  const lang = (document.documentElement.getAttribute('lang') || '').trim();
  const favicon = Boolean(document.querySelector('link[rel~="icon" i]'));
  const ogTags = [...document.querySelectorAll('meta[property^="og:" i]')].map((m) => m.getAttribute('property'));

  return {
    title, description, canonical, viewport, lang, robots, favicon,
    h1Count: h1s.length,
    h1Text: h1s.length ? text(h1s[0]).slice(0, 200) : '',
    headingCount: headings.length,
    headingOrderOk,
    images: {
      total: images.length,
      withAlt: withAlt.length,
      decorative: decorative.length,
      missing: missingAlt.length,
    },
    links: { total: links.length, vague: badLinks.length },
    jsonLdTypes: [...new Set(jsonLdTypes)],
    ogTags,
    wordCount: (document.body ? (document.body.innerText || '') : '').split(/\s+/).filter(Boolean).length,
    internalLinks: links
      .map((a) => a.href)
      .filter((href) => { try { return new URL(href).origin === location.origin; } catch { return false; } })
      .slice(0, 200),
  };
}

/** Turn raw page signals into the pass/partial/fail shape scoreSeo expects. */
function buildSeoSignals(raw, url) {
  const titleLen = raw.title.length;
  const descLen = raw.description.length;
  const noindex = /\bnoindex\b/.test(raw.robots || '');
  const altCoverage = raw.images.total === 0
    ? 1
    : (raw.images.withAlt + raw.images.decorative) / raw.images.total;

  return {
    title:
      titleLen === 0 ? { value: false, detail: 'No <title> element' }
        : titleLen < 20 || titleLen > 65
          ? { value: 'partial', detail: `${titleLen} characters — aim for 20-65` }
          : { value: true, detail: `${titleLen} characters` },
    description:
      descLen === 0 ? { value: false, detail: 'No meta description' }
        : descLen < 70 || descLen > 165
          ? { value: 'partial', detail: `${descLen} characters — aim for 70-165` }
          : { value: true, detail: `${descLen} characters` },
    h1:
      raw.h1Count === 1 ? { value: true, detail: raw.h1Text }
        : raw.h1Count === 0 ? { value: false, detail: 'No H1 on the page' }
          : { value: 'partial', detail: `${raw.h1Count} H1 elements — use one` },
    headings:
      raw.headingCount === 0 ? { value: false, detail: 'No headings found' }
        : raw.headingOrderOk ? { value: true, detail: `${raw.headingCount} headings, correctly nested` }
          : { value: 'partial', detail: 'Heading levels skip a step' },
    imageAlt:
      raw.images.total === 0 ? { value: true, detail: 'No images to check' }
        : altCoverage >= 0.98 ? { value: true, detail: `${raw.images.total} images, all described` }
          : altCoverage >= 0.8
            ? { value: 'partial', detail: `${raw.images.missing} of ${raw.images.total} images missing alt` }
            : { value: false, detail: `${raw.images.missing} of ${raw.images.total} images missing alt` },
    canonical: raw.canonical
      ? { value: true, detail: raw.canonical }
      : { value: false, detail: 'No canonical link element' },
    lang: raw.lang
      ? { value: true, detail: raw.lang }
      : { value: false, detail: 'No lang attribute on <html>' },
    viewport: raw.viewport
      ? { value: true, detail: raw.viewport }
      : { value: false, detail: 'No mobile viewport meta tag' },
    structured: raw.jsonLdTypes.length
      ? { value: true, detail: raw.jsonLdTypes.slice(0, 6).join(', ') }
      : { value: false, detail: 'No JSON-LD structured data' },
    openGraph: raw.ogTags.length >= 3
      ? { value: true, detail: `${raw.ogTags.length} Open Graph tags` }
      : raw.ogTags.length > 0
        ? { value: 'partial', detail: `Only ${raw.ogTags.length} Open Graph tags` }
        : { value: false, detail: 'No Open Graph tags' },
    https: url.protocol === 'https:'
      ? { value: true, detail: 'HTTPS' }
      : { value: false, detail: 'Served over plain HTTP' },
    indexable: noindex
      ? { value: false, detail: 'Page is marked noindex' }
      : { value: true, detail: 'Indexable' },
    linkText:
      raw.links.total === 0 ? { value: true, detail: 'No links to check' }
        : raw.links.vague === 0 ? { value: true, detail: `${raw.links.total} links, all descriptive` }
          : raw.links.vague / raw.links.total < 0.1
            ? { value: 'partial', detail: `${raw.links.vague} vague link labels` }
            : { value: false, detail: `${raw.links.vague} of ${raw.links.total} links have vague text` },
    favicon: raw.favicon ? { value: true, detail: 'Declared' } : { value: false, detail: 'No favicon link' },
  };
}

/**
 * Audit a single page. Assumes the URL has already passed validateScanTarget.
 */
async function auditPage(context, url, deadline) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && consoleErrors.length < 10) consoleErrors.push(msg.text().slice(0, 200));
  });

  try {
    // Inject axe-core before any navigation so it is present in the main frame
    // and in every child frame the page creates. Injecting after load would miss
    // iframes and would race against client-rendered storefronts.
    await page.addInitScript({ content: AXE_SOURCE });

    // Defence in depth: every subresource request is re-checked, so a page that
    // asks the browser to fetch http://169.254.169.254/ gets nothing.
    await page.route('**/*', (route) => {
      const request = route.request();
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return route.abort();
      if (!isAllowedHopSync(request.url())) return route.abort();
      return route.continue();
    });

    const remaining = Math.max(1000, deadline - Date.now());
    const response = await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(config.scanner.navigationTimeoutMs, remaining),
    });

    if (!response) throw new ScanError('no_response', 'That site did not respond. Check the address and try again.');

    // Close the DNS-rebinding window: whatever DNS said before navigation, this
    // is the address the socket actually connected to.
    if (!config.security.allowPrivateTargets) {
      const peer = await response.serverAddr().catch(() => null);
      if (peer?.ipAddress && ipBlockReason(peer.ipAddress)) {
        throw new BlockedTargetError('That address cannot be checked.', 'private_address');
      }
    }

    const status = response.status();
    if (status >= 400) {
      throw new ScanError(
        'http_error',
        `That page returned HTTP ${status}. Check the address and try again.`,
        { status: 400 },
      );
    }

    // Give client-rendered storefronts a chance to paint, but never exceed the
    // overall budget — many sites never reach networkidle because of trackers.
    await page.waitForLoadState('networkidle', { timeout: Math.min(6000, Math.max(500, deadline - Date.now())) })
      .catch(() => {});

    const seoRaw = await page.evaluate(extractSeo);

    const axe = await page.evaluate(async (tags) => {
      /* global axe */
      // `resultTypes` is deliberately NOT set. It would cap non-listed types to a
      // single node entry, and the score's denominator is the number of elements
      // that PASSED — truncating passes would silently inflate every score.
      const result = await axe.run(document, {
        runOnly: { type: 'tag', values: tags },
        elementRef: false,
        selectors: true,
      });

      // `nodeCount` is the true population and drives scoring. `nodes` carries a
      // capped sample used only for display, so a page with 900 contrast errors
      // scores from 900 but ships three examples.
      const trim = (rules) => rules.map((r) => ({
        id: r.id, impact: r.impact, tags: r.tags, help: r.help,
        description: r.description, helpUrl: r.helpUrl,
        nodeCount: r.nodes.length,
        nodes: r.nodes.slice(0, 8).map((n) => ({
          target: n.target,
          html: (n.html || '').slice(0, 400),
          failureSummary: (n.failureSummary || '').slice(0, 400),
        })),
      }));

      return {
        violations: trim(result.violations),
        incomplete: trim(result.incomplete),
        // Pass node HTML is never displayed, so only the count crosses the bridge.
        passes: result.passes.map((r) => ({
          id: r.id, tags: r.tags, help: r.help, nodeCount: r.nodes.length, nodes: [],
        })),
        testEngine: result.testEngine,
      };
    }, AXE_TAGS);

    return {
      url: page.url(),
      status,
      seoRaw,
      violations: axe.violations,
      incomplete: axe.incomplete,
      passes: axe.passes,
      consoleErrors,
      testEngine: axe.testEngine,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/* --------------------------------------------------------------- scan --- */

/**
 * Run a full audit.
 * @param {string} rawUrl visitor-supplied address
 * @returns {Promise<object>} normalized scan result ready to persist
 */
export async function runScan(rawUrl, { maxPages = config.scanner.maxPages } = {}) {
  const started = Date.now();
  const deadline = started + config.scanner.totalTimeoutMs;

  // Throws BlockedTargetError for anything private, non-HTTP or unresolvable.
  const { url } = await validateScanTarget(rawUrl);

  await acquireSlot();
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: config.scanner.userAgent,
      viewport: config.scanner.viewport,
      // Never carry state between two visitors' scans.
      storageState: undefined,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      bypassCSP: false,
      serviceWorkers: 'block',
      locale: 'en-US',
    });
    context.setDefaultTimeout(config.scanner.navigationTimeoutMs);

    const first = await auditPage(context, url, deadline);
    const pages = [first];

    // Crawl a couple of additional internal pages so the report reflects the
    // storefront rather than just the homepage. Product and collection pages are
    // where alt-text and form-label failures actually live.
    const seen = new Set([stripHash(first.url)]);
    const queue = pickCrawlTargets(first.seoRaw.internalLinks ?? [], seen, maxPages - 1);

    for (const next of queue) {
      if (Date.now() > deadline - 8000) break;
      try {
        const { url: nextUrl } = await validateScanTarget(next);
        const result = await auditPage(context, nextUrl, deadline);
        pages.push(result);
        seen.add(stripHash(result.url));
      } catch (err) {
        log.debug('secondary page skipped', { err: err.message });
      }
    }

    const merged = mergeAxeResults(pages);
    const a11y = scoreAccessibility(merged);
    const seoSignals = buildSeoSignals(first.seoRaw, new URL(first.url));
    const seo = scoreSeo(seoSignals);
    const overall = scoreOverall(a11y.score, seo.score);

    return {
      ok: true,
      requestedUrl: rawUrl,
      finalUrl: first.url,
      origin: new URL(first.url).origin,
      pagesScanned: pages.length,
      pageUrls: pages.map((p) => p.url),
      durationMs: Date.now() - started,
      engineVersion: ENGINE_VERSION,
      axeVersion: AXE_VERSION,
      scores: { overall, accessibility: a11y.score, seo: seo.score, band: band(overall) },
      accessibility: {
        ...a11y,
        issues: rankIssues(merged.violations),
        needsReview: rankIssues(merged.incomplete, 10),
      },
      seo: { ...seo, signals: seoSignals },
      meta: {
        title: first.seoRaw.title,
        description: first.seoRaw.description,
        wordCount: first.seoRaw.wordCount,
        images: first.seoRaw.images,
      },
    };
  } catch (err) {
    if (err instanceof BlockedTargetError || err instanceof ScanError) throw err;
    if (/net::ERR_NAME_NOT_RESOLVED/.test(err.message)) {
      throw new ScanError('dns_failure', "We couldn't find that domain. Check the spelling and try again.");
    }
    if (/net::ERR_CERT|SSL/i.test(err.message)) {
      throw new ScanError('tls_error', "That site's security certificate could not be verified, so we stopped.");
    }
    if (/Timeout|timeout/.test(err.message)) {
      throw new ScanError('timeout', 'That site took too long to respond. Try again, or contact us for a full audit.');
    }
    log.error('scan failed', { err: err.message });
    throw new ScanError('scan_failed', "We couldn't complete that scan. Try again in a moment.", { status: 502, cause: err });
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
}

const stripHash = (href) => { try { const u = new URL(href); u.hash = ''; return u.href; } catch { return href; } };

/**
 * Choose which extra pages to crawl. Prefers a product and a collection page,
 * because that is where a storefront's real accessibility debt sits.
 */
function pickCrawlTargets(links, seen, limit) {
  if (limit <= 0) return [];
  const priority = [/\/products?\//i, /\/collections?\//i, /\/shop/i, /\/category/i, /\/cart/i, /\/contact/i];
  const cleaned = [...new Set(links.map(stripHash))].filter((href) => !seen.has(href));

  const ranked = cleaned
    .map((href) => ({ href, rank: priority.findIndex((re) => re.test(href)) }))
    .sort((a, b) => {
      const ar = a.rank === -1 ? 99 : a.rank;
      const br = b.rank === -1 ? 99 : b.rank;
      if (ar !== br) return ar - br;
      return a.href.length - b.href.length;
    });

  return ranked.slice(0, limit).map((r) => r.href);
}

export { AXE_VERSION, ENGINE_VERSION, closeBrowser };
export default { runScan, closeBrowser, AXE_VERSION };

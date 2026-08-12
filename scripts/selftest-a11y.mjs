#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../server/lib/browser.js';

/**
 * Audit our own site with the same engine we sell.
 *
 * A company that sells WCAG 2.2 AA remediation cannot ship a marketing site with
 * accessibility violations on it. This runs axe-core over every built page and
 * fails the build on any violation — the same bar we hold customers to.
 *
 * Usage: npm run test:a11y
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
};

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run "npm run build" first.');
  process.exit(1);
}

/** Every built page, as site-relative URLs. */
function collectPages(dir = DIST, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'assets') continue;
      out.push(...collectPages(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === 'index.html') {
      out.push(prefix === '' ? '/' : prefix);
    } else if (entry.name.endsWith('.html')) {
      out.push(`${prefix}/${entry.name}`);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath = path.join(DIST, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  if (!fs.existsSync(filePath)) filePath = path.join(DIST, '404.html');
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const pages = collectPages();

console.log(`\nAuditing ${pages.length} pages against WCAG 2.2 AA (axe-core)\n`);

const browser = await getBrowser();
let totalViolations = 0;
const failures = [];

// Both viewports matter: reflow, target size and the mobile nav only exist at one of them.
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

try {
  for (const route of pages) {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await page.addInitScript({ content: AXE });
        // 'load', not 'networkidle': a build with the Turnstile key ships a
        // widget that keeps its challenge connections open, so networkidle
        // never arrives and the whole gate times out. The settle wait below
        // gives deferred scripts and the widget a beat to mount before axe runs.
        const response = await page.goto(base + route, { waitUntil: 'load', timeout: 20_000 });
        await page.waitForTimeout(700);
        if (!response || response.status() >= 400) {
          failures.push({ route, viewport: viewport.name, id: 'http', help: `HTTP ${response?.status()}`, nodes: 0 });
          continue;
        }

        const results = await page.evaluate(async (tags) => {
          /* global axe */
          const r = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
          return r.violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
            nodes: v.nodes.length,
            targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
          }));
        }, TAGS);

        const label = `${route} [${viewport.name}]`;
        if (results.length === 0) {
          console.log(`  PASS  ${label}`);
        } else {
          const count = results.reduce((a, v) => a + v.nodes, 0);
          totalViolations += count;
          console.log(`  FAIL  ${label}  ${results.length} rule(s), ${count} element(s)`);
          for (const v of results) {
            console.log(`          ${v.impact.padEnd(9)} ${v.id} — ${v.help}`);
            for (const t of v.targets) console.log(`            ${t}`);
            failures.push({ route, viewport: viewport.name, ...v });
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  }
} finally {
  await closeBrowser();
  server.close();
}

console.log('');
if (totalViolations === 0) {
  console.log(`All ${pages.length} pages pass WCAG 2.2 AA automated checks at both viewports.\n`);
  process.exit(0);
}

console.error(`${totalViolations} accessibility violation(s) across ${new Set(failures.map((f) => f.route)).size} page(s).`);
console.error('An accessibility company cannot ship these. Fix them before deploying.\n');
process.exit(1);

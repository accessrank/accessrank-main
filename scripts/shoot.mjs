#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../server/lib/browser.js';

/**
 * Screenshot built pages from dist/ for visual review.
 *   node scripts/shoot.mjs /            full page, desktop
 *   node scripts/shoot.mjs / --mobile
 *   node scripts/shoot.mjs / --fold     just the first viewport
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const args = process.argv.slice(2);
const routes = args.filter((a) => !a.startsWith('--'));
const mobile = args.includes('--mobile');
const fold = args.includes('--fold');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 };

const browser = await getBrowser();
try {
  for (const route of routes.length ? routes : ['/']) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.goto(base + route, { waitUntil: 'networkidle', timeout: 20_000 });
      // Settle entrance animations before capturing.
      await page.waitForTimeout(700);
      const name = `shot${route.replace(/\//g, '-') || '-home'}${mobile ? '-mobile' : ''}${fold ? '-fold' : ''}.png`;
      await page.screenshot({ path: name, fullPage: !fold });
      const { width, height } = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      const overflow = width > viewport.width + 1 ? `  HORIZONTAL OVERFLOW: ${width}px > ${viewport.width}px` : '';
      console.log(`  ${name}  ${width}x${height}${overflow}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await closeBrowser();
  server.close();
}

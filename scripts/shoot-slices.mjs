#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../server/lib/browser.js';

/**
 * Screenshot built pages from dist/ in viewport-height slices for readable detail.
 *   node scripts/shoot-slices.mjs /            desktop slices
 *   node scripts/shoot-slices.mjs / --mobile   mobile slices
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const OUT = path.join(__dirname, '..', 'slices');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const args = process.argv.slice(2);
const routes = args.filter((a) => !a.startsWith('--'));
const mobile = args.includes('--mobile');

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
const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };

const browser = await getBrowser();
try {
  for (const route of routes.length ? routes : ['/']) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await page.goto(base + route, { waitUntil: 'networkidle', timeout: 20_000 });
      await page.waitForTimeout(700);
      const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const slug = (route.replace(/\//g, '-') || '-home') + (mobile ? '-mobile' : '');
      let y = 0;
      let i = 0;
      while (y < totalHeight) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(200);
        const name = path.join(OUT, `${slug}-${String(i).padStart(2, '0')}.png`);
        await page.screenshot({ path: name });
        console.log(`  ${name}`);
        y += viewport.height;
        i += 1;
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await closeBrowser();
  server.close();
}

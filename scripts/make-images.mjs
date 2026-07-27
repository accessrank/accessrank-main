#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from '../server/lib/browser.js';

/**
 * Generate the raster brand assets (social card, touch icon) from HTML.
 *
 * Uses the Chromium the app already depends on, so there is no image toolchain
 * to install and the assets stay in sync with the design tokens by construction.
 * Run with `npm run images`; output is committed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'assets', 'img');

const MARK = `<svg viewBox="0 0 32 32" width="100%" height="100%">
  <rect width="32" height="32" rx="8" fill="#FFD23F"/>
  <path d="M9 16.5 L14 21.5 L23 11" fill="none" stroke="#14142A" stroke-width="3.6"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const shared = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:#14142A;
    font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    color:#fff; -webkit-font-smoothing:antialiased;
  }
  .glow {
    position:absolute; border-radius:50%; filter:blur(90px); opacity:.5;
  }
`;

const OG_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${shared}
  body { width:1200px; height:630px; position:relative; overflow:hidden; }
  .g1 { width:620px; height:620px; background:#2563EB; top:-200px; right:-140px; }
  .g2 { width:520px; height:520px; background:#7C3AED; bottom:-240px; left:-120px; }
  .g3 { width:380px; height:380px; background:#FFD23F; top:220px; right:180px; opacity:.18; }
  .wrap { position:relative; padding:76px 80px; height:100%; display:flex; flex-direction:column; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:16px; }
  .mark { width:54px; height:54px; }
  .name { font-size:34px; font-weight:700; letter-spacing:-.5px; }
  h1 { font-size:74px; line-height:1.04; font-weight:800; letter-spacing:-2.4px; max-width:930px; }
  h1 em { font-style:normal; color:#FFD23F; }
  p { font-size:27px; color:#D4D0C5; margin-top:24px; max-width:820px; line-height:1.42; }
  .foot { display:flex; gap:14px; align-items:center; }
  .pill {
    border:1px solid rgba(255,210,63,.42); color:#FFD23F; border-radius:100px;
    padding:9px 20px; font-size:19px; font-weight:600;
  }
  .rule { height:1px; background:rgba(240,237,229,.22); flex:1; }
</style></head><body>
  <span class="glow g1"></span><span class="glow g2"></span><span class="glow g3"></span>
  <div class="wrap">
    <div class="brand"><span class="mark">${MARK}</span><span class="name">Accessrank</span></div>
    <div>
      <h1>Higher rank.<br><em>Wider reach.</em></h1>
      <p>WCAG 2.2 AA remediation in your source code — not an overlay widget — for DTC ecommerce.</p>
    </div>
    <div class="foot">
      <span class="pill">Free accessibility check</span>
      <span class="rule"></span>
      <span class="pill">accessrank.ai</span>
    </div>
  </div>
</body></html>`;

const ICON_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${shared}
  body { width:180px; height:180px; display:flex; align-items:center; justify-content:center; }
  .mark { width:132px; height:132px; }
</style></head><body><span class="mark">${MARK}</span></body></html>`;

async function shoot(browser, html, { width, height, file }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const dest = path.join(OUT, file);
    await page.screenshot({ path: dest, type: 'png' });
    console.log(`  ${file.padEnd(24)} ${width}x${height}  ${(fs.statSync(dest).size / 1024).toFixed(1)} kB`);
  } finally {
    await page.close();
  }
}

const browser = await getBrowser();
try {
  fs.mkdirSync(OUT, { recursive: true });
  await shoot(browser, OG_HTML, { width: 1200, height: 630, file: 'og-image.png' });
  await shoot(browser, ICON_HTML, { width: 180, height: 180, file: 'apple-touch-icon.png' });
  await shoot(browser, ICON_HTML, { width: 32, height: 32, file: 'favicon-32.png' });
} finally {
  await closeBrowser();
}

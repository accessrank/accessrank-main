import fs from 'node:fs';
import { getBrowser, closeBrowser } from '../server/lib/browser.js';

// Render report-preview.html with print media emulation and slice it into
// A4-sized images so pagination and print CSS can be eyeballed.
const A4 = { width: 794, height: 1123 };
const pages = Number(process.argv[2] || 4);

const browser = await getBrowser();
const page = await browser.newPage({ viewport: A4, deviceScaleFactor: 1 });
try {
  await page.goto(`file://${process.cwd().replace(/\\/g, '/')}/report-preview.html`, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`content height ${height}px = ~${(height / A4.height).toFixed(1)} A4 pages`);

  for (let i = 0; i < Math.min(pages, Math.ceil(height / A4.height)); i += 1) {
    // Scroll rather than clip: a clip beyond the viewport's composited area
    // fails once the document is taller than Chromium's screenshot surface.
    await page.evaluate((y) => window.scrollTo(0, y), i * A4.height);
    await page.screenshot({ path: `pdfshot-${i + 1}.png` });
    console.log(`  pdfshot-${i + 1}.png`);
  }
} finally {
  await page.close();
  await closeBrowser();
}

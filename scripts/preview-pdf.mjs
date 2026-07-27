#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * Generate a sample report PDF without sending an email.
 *
 *   npm run preview:pdf                 # uses the broken fixture
 *   npm run preview:pdf -- --fixture clean
 *   npm run preview:pdf -- https://example.com
 *
 * Writes ./report-preview.pdf and ./report-preview.html so the print CSS can be
 * inspected in a browser as well as on paper.
 */

process.env.SCAN_ALLOW_PRIVATE = process.env.SCAN_ALLOW_PRIVATE || '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fixtureFlag = args.indexOf('--fixture');
let target = args.find((a) => !a.startsWith('--') && a !== args[fixtureFlag + 1]);
let server;

if (!target) {
  const name = fixtureFlag !== -1 ? args[fixtureFlag + 1] || 'broken' : 'broken';
  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(dir, `${name}.html`)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Using the "${name}" fixture.`);
}

const { runScan } = await import('../server/lib/scanner.js');
const { generateReportPdf, buildReportContext, renderReportHtml } = await import('../server/lib/pdf.js');
const { closeBrowser } = await import('../server/lib/browser.js');

try {
  console.log(`Scanning ${target} …`);
  const result = await runScan(target, { maxPages: 1 });

  const context = buildReportContext({
    scan: { id: 'preview-0000' },
    result,
    lead: { name: 'Dana Fields', email: 'dana@example.com' },
    reportId: 'preview-0000',
  });

  const html = await renderReportHtml(context);
  fs.writeFileSync('report-preview.html', html);

  const pdf = await generateReportPdf(context);
  fs.writeFileSync('report-preview.pdf', pdf);

  console.log(`\n  Overall ${result.scores.overall} · a11y ${result.scores.accessibility} · SEO ${result.scores.seo}`);
  console.log(`  report-preview.pdf   ${(pdf.length / 1024).toFixed(0)} kB`);
  console.log('  report-preview.html  (open in a browser, then print-preview to check pagination)\n');
} finally {
  await closeBrowser();
  if (server) server.close();
}

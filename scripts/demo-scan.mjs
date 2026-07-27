#!/usr/bin/env node
/**
 * Scan a URL from the command line and print the report the API would return.
 *   node scripts/demo-scan.mjs https://example.com
 *   node scripts/demo-scan.mjs --fixture broken
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const fixtureIndex = args.indexOf('--fixture');
let target = args.find((a) => !a.startsWith('--'));
let server;

if (fixtureIndex !== -1) {
  process.env.SCAN_ALLOW_PRIVATE = '1';
  const name = args[fixtureIndex + 1] || 'broken';
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
  server = http.createServer((req, res) => {
    const file = path.join(dir, `${name}.html`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${server.address().port}/`;
}

if (!target) {
  console.error('usage: node scripts/demo-scan.mjs <url> | --fixture <broken|clean>');
  process.exit(1);
}

const { runScan, closeBrowser } = await import('../server/lib/scanner.js');

const pad = (s, n) => String(s).padEnd(n);
const bar = (n) => '#'.repeat(Math.round((n ?? 0) / 4)).padEnd(25, '.');

try {
  const result = await runScan(target, { maxPages: Number(process.env.MAX_PAGES || 1) });

  console.log(`\n  ${result.finalUrl}`);
  console.log(`  ${result.pagesScanned} page(s) - ${result.durationMs}ms - axe ${result.axeVersion}\n`);
  console.log(`  Overall        ${bar(result.scores.overall)} ${result.scores.overall}   ${result.scores.band.label}`);
  console.log(`  Accessibility  ${bar(result.scores.accessibility)} ${result.scores.accessibility}`);
  console.log(`  SEO            ${bar(result.scores.seo)} ${result.scores.seo}\n`);

  const c = result.accessibility.counts;
  console.log(`  Failing elements: ${result.accessibility.violationsTotal}`);
  console.log(`    critical ${c.critical}   serious ${c.serious}   moderate ${c.moderate}   minor ${c.minor}`);
  console.log(`  Rules: ${result.accessibility.rulesFailed} failed / ${result.accessibility.rulesPassed} passed / ${result.accessibility.rulesIncomplete} need review\n`);

  console.log('  Top accessibility issues');
  for (const issue of result.accessibility.issues.slice(0, 8)) {
    const wcag = issue.criteria.length ? `WCAG ${issue.criteria.join(', ')} (${issue.level})` : issue.level;
    console.log(`    ${pad(issue.impact, 9)} ${pad(issue.nodes + 'x', 6)} ${pad(issue.id, 26)} ${wcag}`);
    console.log(`              ${issue.help}`);
  }

  console.log('\n  SEO checklist');
  for (const check of result.seo.checks) {
    const mark = check.status === 'pass' ? '[ok]  ' : check.status === 'partial' ? '[~]   ' : '[FAIL]';
    console.log(`    ${mark} ${pad(check.label, 42)} ${check.detail ?? ''}`);
  }
  console.log();
} finally {
  await closeBrowser();
  if (server) server.close();
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verify every internal link resolves, and that no dead `href="#"` survives.
 *
 * The original site shipped eleven dead links — four `href="#"` placeholders in
 * a footer repeated on every page, and four job listings that all pointed at the
 * pricing anchor. This makes that class of defect a build failure.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run "npm run build" first.');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const files = walk(DIST);
const problems = [];

/** Map a site-relative URL to the file that would serve it. */
function resolves(href) {
  const clean = href.split('#')[0].split('?')[0];
  if (clean === '' || clean === '/') return fs.existsSync(path.join(DIST, 'index.html'));

  const rel = clean.replace(/^\//, '');
  const candidates = [
    path.join(DIST, rel),
    path.join(DIST, rel, 'index.html'),
    path.join(DIST, `${rel}.html`),
  ];
  return candidates.some((c) => c.startsWith(DIST) && fs.existsSync(c) && fs.statSync(c).isFile());
}

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const route = `/${path.relative(DIST, file).replace(/\\/g, '/')}`;

  // Collect anchors that exist on this page, for fragment validation.
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)) {
    const href = match[1].trim();

    if (href === '' || href === '#') {
      problems.push({ route, href, why: 'dead placeholder link' });
      continue;
    }
    if (/^(https?:|mailto:|tel:)/i.test(href)) continue;

    if (href.startsWith('#')) {
      if (!ids.has(href.slice(1))) problems.push({ route, href, why: 'fragment target not found on page' });
      continue;
    }
    if (!href.startsWith('/')) {
      problems.push({ route, href, why: 'relative link — use a site-absolute path' });
      continue;
    }

    // A cross-page fragment must exist on the target page.
    const [pathPart, fragment] = href.split('#');
    if (!resolves(pathPart)) {
      problems.push({ route, href, why: 'no page at this path' });
      continue;
    }
    if (fragment) {
      const targetFile = [
        path.join(DIST, pathPart.replace(/^\//, ''), 'index.html'),
        path.join(DIST, `${pathPart.replace(/^\//, '')}.html`),
        path.join(DIST, 'index.html'),
      ].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (targetFile) {
        const targetHtml = fs.readFileSync(targetFile, 'utf8');
        if (!new RegExp(`\\sid="${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(targetHtml)) {
          problems.push({ route, href, why: `fragment #${fragment} not found on target page` });
        }
      }
    }
  }

  // Assets referenced by src/href must exist too.
  for (const match of html.matchAll(/\s(?:src|href)="(\/assets\/[^"]+)"/gi)) {
    const asset = path.join(DIST, match[1].replace(/^\//, ''));
    if (!fs.existsSync(asset)) problems.push({ route, href: match[1], why: 'asset missing from dist' });
  }
}

console.log(`\nChecked ${files.length} pages\n`);

if (problems.length === 0) {
  console.log('No broken links. Every internal href resolves.\n');
  process.exit(0);
}

const byRoute = new Map();
for (const p of problems) {
  if (!byRoute.has(p.route)) byRoute.set(p.route, []);
  byRoute.get(p.route).push(p);
}
for (const [route, items] of byRoute) {
  console.error(`  ${route}`);
  for (const item of items) console.error(`      ${item.href.padEnd(40)} ${item.why}`);
}
console.error(`\n${problems.length} broken link(s).\n`);
process.exit(1);

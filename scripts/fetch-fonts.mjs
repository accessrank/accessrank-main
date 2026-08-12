#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Download Inter and JetBrains Mono for self-hosting, and generate fonts.css.
 *
 * The original site loaded these from fonts.googleapis.com. That sends every
 * visitor's IP address to Google on page load, which a German court has already
 * held to be an unlawful transfer under the GDPR — an awkward liability for a
 * site whose product is legal compliance, and one its own privacy policy does
 * not disclose. Self-hosting removes the transfer and the render-blocking
 * third-party round trip at the same time.
 *
 * Both families are SIL Open Font Licensed, so redistribution is permitted.
 * Run once with `npm run fonts`; the output is committed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', 'src', 'assets', 'fonts');
const CSS_FILE = path.join(__dirname, '..', 'src', 'assets', 'css', 'fonts.css');

// A modern browser UA is required or the API serves legacy TTF instead of woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FAMILIES = [
  { css: 'Inter', slug: 'inter', query: 'Inter:wght@400;500;600;700;800' },
  { css: 'JetBrains Mono', slug: 'jetbrains-mono', query: 'JetBrains+Mono:wght@400;500;600' },
];

// Latin + latin-ext covers the site's copy; skipping Cyrillic/Greek keeps the
// payload to a few tens of kB.
const WANTED_SUBSETS = new Set(['latin', 'latin-ext']);

async function fetchCss(query) {
  const url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`Google Fonts returned ${response.status} for ${query}`);
  return response.text();
}

/** Split a Google Fonts stylesheet into per-subset @font-face blocks. */
function parseFaces(css) {
  const faces = [];
  const blockRe = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let match;
  while ((match = blockRe.exec(css)) !== null) {
    const [, subset, body] = match;
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '400';
    const style = /font-style:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? 'normal';
    const src = /src:\s*url\(([^)]+)\)\s*format\('woff2'\)/.exec(body)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? null;
    if (src) faces.push({ subset, weight, style, src, unicodeRange });
  }
  return faces;
}

async function download(url, dest) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  fs.mkdirSync(FONT_DIR, { recursive: true });
  const blocks = [];
  let downloaded = 0;
  let bytes = 0;

  for (const family of FAMILIES) {
    const css = await fetchCss(family.query);
    const faces = parseFaces(css).filter((f) => WANTED_SUBSETS.has(f.subset));
    if (!faces.length) throw new Error(`No woff2 faces parsed for ${family.css}`);

    // Dedupe by content: Google serves the same variable-font bytes for every
    // weight of a family+subset, under a different URL each time. Writing one
    // file per weight made the browser download identical bytes five times per
    // page (URLs differ, so HTTP caching cannot merge them), and the hero's
    // weight-800 copy arrived last — dragging LCP. One file per unique content,
    // shared by every weight's @font-face block, keeps rendering semantics
    // identical while collapsing five requests into one.
    const seenByHash = new Map();

    for (const face of faces) {
      const suffix = face.subset === 'latin' ? 'latin' : 'latin-ext';
      const filename = `${family.slug}-${suffix}-${face.weight}.woff2`;
      const dest = path.join(FONT_DIR, filename);

      let servedAs = filename;
      const tmp = `${dest}.tmp`;
      await download(face.src, tmp);
      const content = fs.readFileSync(tmp);
      const digest = crypto.createHash('sha256').update(content).digest('hex');

      if (seenByHash.has(digest)) {
        servedAs = seenByHash.get(digest);
        fs.rmSync(tmp);
        // A stale per-weight copy from an older run must not linger — nothing
        // will reference it, and its presence invites re-adding the bug.
        if (fs.existsSync(dest)) fs.rmSync(dest);
      } else {
        seenByHash.set(digest, filename);
        fs.renameSync(tmp, dest);
        downloaded += 1;
        bytes += content.length;
      }

      blocks.push([
        '@font-face {',
        `  font-family: '${family.css}';`,
        `  font-style: ${face.style};`,
        `  font-weight: ${face.weight};`,
        '  font-display: swap;',
        `  src: url('/assets/fonts/${servedAs}') format('woff2');`,
        face.unicodeRange ? `  unicode-range: ${face.unicodeRange};` : null,
        '}',
      ].filter(Boolean).join('\n'));

      const note = servedAs === filename ? '' : `  (same bytes as ${servedAs})`;
      console.log(`  ${filename.padEnd(36)} ${(content.length / 1024).toFixed(1)} kB${note}`);
    }
  }

  const header = [
    '/* fonts.css — GENERATED by scripts/fetch-fonts.mjs. Do not edit by hand.',
    ' *',
    ' * Inter and JetBrains Mono, self-hosted under the SIL Open Font License.',
    ' * Self-hosted rather than loaded from fonts.googleapis.com so that no',
    ' * visitor IP address is transferred to a third party on page load.',
    ' *',
    ' * Every weight of a family+subset points at ONE file: Google serves the',
    ' * same variable-font bytes per weight, and distinct URLs made the browser',
    ' * download them five times over (~194 kB wasted per page).',
    ' */',
    '',
    '/* Metric-compatible stand-in shown while Inter downloads. Arial re-shaped',
    ' * to Inter metrics so the swap cannot reflow the page: the aurora blobs',
    ' * position off document height, and a few pixels of text reflow used to',
    ' * move every blob and score as layout shift. */',
    '@font-face {',
    "  font-family: 'Inter-fallback';",
    "  src: local('Arial');",
    '  size-adjust: 107.4%;',
    '  ascent-override: 90.2%;',
    '  descent-override: 22.48%;',
    '  line-gap-override: 0%;',
    '}',
    '',
  ].join('\n');

  fs.writeFileSync(CSS_FILE, `${header}${blocks.join('\n\n')}\n`);
  console.log(`\n  ${downloaded} new file(s), ${(bytes / 1024).toFixed(0)} kB total`);
  console.log(`  wrote ${path.relative(process.cwd(), CSS_FILE)}`);
}

main().catch((err) => {
  console.error(`\nFont download failed: ${err.message}`);
  console.error('The site still builds — it will fall back to system fonts until this succeeds.\n');
  // Leave a valid stylesheet behind so the build never breaks on a network blip.
  if (!fs.existsSync(CSS_FILE)) {
    fs.writeFileSync(CSS_FILE, '/* fonts.css — run "npm run fonts" to self-host Inter and JetBrains Mono. */\n');
  }
  process.exitCode = 1;
});

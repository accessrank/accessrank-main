#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { render as renderTemplate } from './server/lib/template.js';
import { minifyCss } from './server/lib/minify.js';

/**
 * Static site build.
 *
 * The original site repeated its <head>, nav and footer verbatim across seven
 * files and defined the same design tokens in two places. That is the defect
 * this fixes: pages are authored as body fragments, chrome comes from partials,
 * and CSS/JS are bundled once with a content hash for cache busting.
 *
 * Output is plain static HTML with no client-side framework and no runtime
 * templating — it can be served by this app, or dropped on any CDN.
 *
 * Template syntax (deliberately tiny):
 *   {{ value }}          HTML-escaped interpolation
 *   {{{ value }}}        raw interpolation
 *   {{> partial }}       include src/partials/<partial>.html
 *   {{#if value}}…{{/if}}          conditional
 *   {{#unless value}}…{{/unless}}  negated conditional
 *   {{#each list}}…{{/each}}       iteration, {{ this.prop }} inside
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

const site = JSON.parse(fs.readFileSync(path.join(SRC, 'data', 'site.json'), 'utf8'));
const SITE_URL = (process.env.SITE_URL || 'https://accessrank.ai').replace(/\/+$/, '');

/* ------------------------------------------------------------ template --- */

// One renderer, shared with the PDF report, so both behave identically.
const PARTIALS = path.join(SRC, 'partials');
const render = (template, context) => renderTemplate(template, context, { partialsDir: PARTIALS });

/* -------------------------------------------------------------- assets --- */

const hashOf = (content) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);

function bundle(files, baseDir) {
  return files
    .map((file) => {
      const full = path.join(baseDir, file);
      if (!fs.existsSync(full)) {
        console.warn(`  ! missing ${file} — skipped`);
        return '';
      }
      return `/* ---- ${file} ---- */\n${fs.readFileSync(full, 'utf8')}`;
    })
    .filter(Boolean)
    .join('\n\n');
}


function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dst);
    else { fs.copyFileSync(src, dst); count += 1; }
  }
  return count;
}

/* --------------------------------------------------------------- build --- */

function structuredData(page) {
  const blocks = [];
  const types = page.schema ?? [];

  if (types.includes('Organization')) {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: site.name,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/assets/img/logo.svg`,
      email: site.email,
      description: site.description,
      foundingDate: String(site.foundingYear),
      contactPoint: [{
        '@type': 'ContactPoint',
        email: site.email,
        contactType: 'sales',
        availableLanguage: ['English'],
      }],
    });
  }

  if (types.includes('Service')) {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'Service',
      serviceType: 'Web accessibility remediation and SEO',
      provider: { '@type': 'Organization', name: site.name, url: `${SITE_URL}/` },
      areaServed: ['US', 'EU'],
      description:
        'WCAG 2.2 AA source-code remediation for DTC ecommerce storefronts, with ongoing regression monitoring and SEO improvement.',
      audience: { '@type': 'BusinessAudience', audienceType: 'DTC ecommerce brands' },
    });
  }

  if (types.includes('FAQPage') && Array.isArray(page.faq) && page.faq.length) {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    });
  }

  if (page.url !== '/') {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: page.title.split(' — ')[0], item: `${SITE_URL}${page.url}` },
      ],
    });
  }

  return blocks
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>`)
    .join('\n  ');
}

function build() {
  const started = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // --- assets -------------------------------------------------------------
  const cssDir = path.join(SRC, 'assets', 'css');
  const jsDir = path.join(SRC, 'assets', 'js');

  // Order is the cascade. a11y.css is deliberately last so a component rule
  // cannot silently override a conformance requirement.
  const cssSource = bundle(
    ['tokens.css', 'fonts.css', 'base.css', 'layout.css', 'home.css', 'pages.css', 'components.css', 'a11y.css'],
    cssDir,
  );
  const css = minifyCss(cssSource);
  const cssName = `site.${hashOf(css)}.css`;

  const jsSource = bundle(['site.js', 'audit.js'], jsDir);
  const jsName = `site.${hashOf(jsSource)}.js`;

  fs.mkdirSync(path.join(DIST, 'assets', 'css'), { recursive: true });
  fs.mkdirSync(path.join(DIST, 'assets', 'js'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'assets', 'css', cssName), css);
  fs.writeFileSync(path.join(DIST, 'assets', 'js', jsName), jsSource);

  // The stylesheet is inlined into every page's <head> (see shell.html), which
  // removes the one render-blocking request from the critical path. CSP must
  // then allow exactly that block and nothing else: the build records the
  // sha256 of the inlined text here, and server/app.js folds it into
  // style-src. The hash covers the <style> element's exact contents, so any
  // drift between what was built and what is served fails closed — the page
  // loses its styles rather than the policy quietly widening.
  const styleHash = `sha256-${crypto.createHash('sha256').update(css, 'utf8').digest('base64')}`;
  // Whether the built pages ship the Turnstile <script> + widgets is a
  // BUILD-time fact, so it is recorded here and the server's CSP follows it.
  // Deciding from the server's own env instead caused a real mismatch: a keyed
  // build served by a keyless server (integration tests, local runs) blocked
  // challenges.cloudflare.com and every page logged a CSP violation.
  const turnstileInMarkup = Boolean(process.env.TURNSTILE_SITE_KEY);
  fs.writeFileSync(path.join(DIST, 'csp.json'), JSON.stringify({ styleHash, turnstileInMarkup }, null, 2));

  const copied =
    copyDir(path.join(SRC, 'assets', 'img'), path.join(DIST, 'assets', 'img')) +
    copyDir(path.join(SRC, 'assets', 'fonts'), path.join(DIST, 'assets', 'fonts')) +
    copyDir(path.join(SRC, 'assets', 'static'), DIST);

  console.log(`  css  ${cssName} (${(css.length / 1024).toFixed(1)} kB, from ${(cssSource.length / 1024).toFixed(1)} kB)`);
  console.log(`  js   ${jsName} (${(jsSource.length / 1024).toFixed(1)} kB)`);
  console.log(`  copy ${copied} static files`);

  // --- pages --------------------------------------------------------------
  const shell = fs.readFileSync(path.join(SRC, 'partials', 'shell.html'), 'utf8');
  const written = [];

  for (const page of site.pages) {
    const source = path.join(SRC, 'pages', page.file);
    if (!fs.existsSync(source)) {
      console.warn(`  ! ${page.file} not found — skipping ${page.url}`);
      continue;
    }

    const context = {
      site,
      page,
      nav: site.nav,
      footer: site.footer,
      jobs: site.jobs,
      inlineCss: css,
      jsHref: `/assets/js/${jsName}`,
      canonical: `${SITE_URL}${page.url === '/' ? '/' : page.url}`,
      siteUrl: SITE_URL,
      year: new Date().getFullYear(),
      isHome: page.url === '/',
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
      plausibleDomain: process.env.PLAUSIBLE_DOMAIN || '',
      plausibleSrc: process.env.PLAUSIBLE_SRC || 'https://plausible.io/js/script.js',
    };

    const body = render(fs.readFileSync(source, 'utf8'), context);
    const html = render(shell, { ...context, body, structuredData: structuredData(page) });

    // Extensionless URLs: / -> index.html, /about -> about/index.html
    const outPath = page.url === '/'
      ? path.join(DIST, 'index.html')
      : page.url === '/404'
        ? path.join(DIST, '404.html')
        : path.join(DIST, page.url.replace(/^\//, ''), 'index.html');

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
    written.push({ page, outPath });
  }

  // --- job detail pages ---------------------------------------------------
  const jobTemplatePath = path.join(SRC, 'pages', '_job.html');
  if (fs.existsSync(jobTemplatePath)) {
    const jobTemplate = fs.readFileSync(jobTemplatePath, 'utf8');
    for (const job of site.jobs) {
      const page = {
        url: `/careers/${job.slug}`,
        title: `${job.title} — Careers at Accessrank`,
        description: job.summary,
        layout: 'page',
        priority: '0.4',
        changefreq: 'monthly',
      };
      const context = {
        site, page, job, nav: site.nav, footer: site.footer,
        inlineCss: css, jsHref: `/assets/js/${jsName}`,
        canonical: `${SITE_URL}${page.url}`, siteUrl: SITE_URL,
        year: new Date().getFullYear(), isHome: false,
        turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
        plausibleDomain: process.env.PLAUSIBLE_DOMAIN || '',
        plausibleSrc: process.env.PLAUSIBLE_SRC || 'https://plausible.io/js/script.js',
      };
      const body = render(jobTemplate, context);
      const html = render(shell, { ...context, body, structuredData: structuredData(page) });
      const outPath = path.join(DIST, 'careers', job.slug, 'index.html');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
      written.push({ page, outPath });
    }
  }

  // --- sitemap & robots ---------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const urls = written
    .filter(({ page }) => !page.excludeFromSitemap && !page.noindex)
    .map(({ page }) => `  <url>
    <loc>${SITE_URL}${page.url === '/' ? '/' : page.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq ?? 'monthly'}</changefreq>
    <priority>${page.priority ?? '0.5'}</priority>
  </url>`)
    .join('\n');

  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );

  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    [
      'User-agent: *',
      'Allow: /',
      // The audit endpoint is a POST API; keep crawlers out of it entirely.
      'Disallow: /api/',
      '',
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      '',
    ].join('\n'),
  );

  console.log(`  html ${written.length} pages`);
  console.log(`\nBuilt to dist/ in ${Date.now() - started}ms`);

  return written;
}

build();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { log } from './logger.js';
import { render } from './template.js';
import { getBrowserForRendering } from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'templates', 'report.html');

/**
 * PDF generation.
 *
 * The report is rendered by the same Chromium the scanner already runs, so PDF
 * output costs no extra dependency and no extra binary in the image.
 *
 * `setContent` is used rather than navigating to a URL: the template is fully
 * self-contained (inlined CSS, inline SVG, no web fonts), so the renderer never
 * makes a network request. That keeps generation deterministic and offline, and
 * means a slow CDN can never stall a customer's report.
 */

/** WCAG 2.2 success criteria referenced by the axe rules we run. */
const CRITERION_NAMES = {
  '1.1.1': { name: 'Non-text Content', level: 'A' },
  '1.2.1': { name: 'Audio-only and Video-only (Prerecorded)', level: 'A' },
  '1.2.2': { name: 'Captions (Prerecorded)', level: 'A' },
  '1.3.1': { name: 'Info and Relationships', level: 'A' },
  '1.3.2': { name: 'Meaningful Sequence', level: 'A' },
  '1.3.4': { name: 'Orientation', level: 'AA' },
  '1.3.5': { name: 'Identify Input Purpose', level: 'AA' },
  '1.4.1': { name: 'Use of Colour', level: 'A' },
  '1.4.2': { name: 'Audio Control', level: 'A' },
  '1.4.3': { name: 'Contrast (Minimum)', level: 'AA' },
  '1.4.4': { name: 'Resize Text', level: 'AA' },
  '1.4.10': { name: 'Reflow', level: 'AA' },
  '1.4.11': { name: 'Non-text Contrast', level: 'AA' },
  '1.4.12': { name: 'Text Spacing', level: 'AA' },
  '1.4.13': { name: 'Content on Hover or Focus', level: 'AA' },
  '2.1.1': { name: 'Keyboard', level: 'A' },
  '2.1.2': { name: 'No Keyboard Trap', level: 'A' },
  '2.2.1': { name: 'Timing Adjustable', level: 'A' },
  '2.2.2': { name: 'Pause, Stop, Hide', level: 'A' },
  '2.4.1': { name: 'Bypass Blocks', level: 'A' },
  '2.4.2': { name: 'Page Titled', level: 'A' },
  '2.4.3': { name: 'Focus Order', level: 'A' },
  '2.4.4': { name: 'Link Purpose (In Context)', level: 'A' },
  '2.4.5': { name: 'Multiple Ways', level: 'AA' },
  '2.4.6': { name: 'Headings and Labels', level: 'AA' },
  '2.4.7': { name: 'Focus Visible', level: 'AA' },
  '2.4.11': { name: 'Focus Not Obscured (Minimum)', level: 'AA' },
  '2.5.3': { name: 'Label in Name', level: 'A' },
  '2.5.7': { name: 'Dragging Movements', level: 'AA' },
  '2.5.8': { name: 'Target Size (Minimum)', level: 'AA' },
  '3.1.1': { name: 'Language of Page', level: 'A' },
  '3.1.2': { name: 'Language of Parts', level: 'AA' },
  '3.2.1': { name: 'On Focus', level: 'A' },
  '3.2.2': { name: 'On Input', level: 'A' },
  '3.2.6': { name: 'Consistent Help', level: 'A' },
  '3.3.1': { name: 'Error Identification', level: 'A' },
  '3.3.2': { name: 'Labels or Instructions', level: 'A' },
  '3.3.3': { name: 'Error Suggestion', level: 'AA' },
  '3.3.4': { name: 'Error Prevention (Legal, Financial, Data)', level: 'AA' },
  '3.3.7': { name: 'Redundant Entry', level: 'A' },
  '3.3.8': { name: 'Accessible Authentication (Minimum)', level: 'AA' },
  '4.1.2': { name: 'Name, Role, Value', level: 'A' },
  '4.1.3': { name: 'Status Messages', level: 'AA' },
};

export function describeCriteria(ids = []) {
  return ids.map((id) => ({
    id,
    name: CRITERION_NAMES[id]?.name ?? 'Success criterion',
    level: CRITERION_NAMES[id]?.level ?? 'AA',
  }));
}

const formatDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(date);

/**
 * Build the template context from a persisted scan row plus the lead.
 * Kept separate from rendering so it can be unit-tested without Chromium.
 */
export function buildReportContext({ scan, result, lead, reportId }) {
  const a11y = result.accessibility ?? {};
  const seo = result.seo ?? {};

  return {
    report: {
      id: (reportId ?? scan?.id ?? '').toString().slice(0, 8),
      generatedAt: formatDate(),
    },
    site: {
      url: result.finalUrl ?? result.requestedUrl,
      origin: result.origin,
      title: result.meta?.title || result.origin,
      pagesScanned: result.pagesScanned ?? 1,
      pageUrls: result.pageUrls ?? [],
    },
    lead: {
      name: lead?.name ?? 'there',
      email: lead?.email ?? '',
    },
    scores: result.scores ?? {},
    a11y: {
      ...a11y,
      failedCriteriaDetailed: describeCriteria(a11y.failedCriteria ?? []),
      issues: a11y.issues ?? [],
      needsReview: a11y.needsReview ?? [],
      counts: a11y.counts ?? { critical: 0, serious: 0, moderate: 0, minor: 0 },
    },
    seo: {
      ...seo,
      checks: seo.checks ?? [],
    },
    engine: {
      name: 'Accessrank audit engine',
      version: result.engineVersion ?? '1.0.0',
      axeVersion: result.axeVersion ?? '',
    },
    site_url: config.siteUrl,
    contactEmail: config.email.replyTo,
  };
}

/**
 * @returns {Promise<Buffer>} the rendered PDF
 */
export async function generateReportPdf(context) {
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(`Report template missing at ${TEMPLATE}`);
  }
  const html = render(fs.readFileSync(TEMPLATE, 'utf8'), context);

  const browser = await getBrowserForRendering();
  const page = await browser.newPage();
  try {
    // Nothing in the template is remote, so 'load' resolves without network.
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    // Force print styles: without this, Chromium renders the screen stylesheet
    // and the @page rules never apply.
    await page.emulateMedia({ media: 'print' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    log.info('report pdf generated', { bytes: pdf.length });
    return pdf;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Escape-hatch used by tests and by `npm run preview:pdf`. */
export async function renderReportHtml(context) {
  return render(fs.readFileSync(TEMPLATE, 'utf8'), context);
}

export default { generateReportPdf, buildReportContext, renderReportHtml, describeCriteria };

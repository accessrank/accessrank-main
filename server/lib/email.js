import config from './config.js';
import { log } from './logger.js';
import { escapeHtml } from './template.js';

/**
 * Transactional email.
 *
 * Provider-agnostic behind a two-method interface so Resend can be swapped for
 * SES/Postmark/SMTP without touching the routes. In development, with no API key
 * configured, messages are written to the log instead of sent — so the whole
 * funnel is exercisable locally without a mail account or a real inbox.
 */

class ConsoleTransport {
  constructor() { this.name = 'console'; }

  async send({ to, subject, attachments = [] }) {
    log.warn('EMAIL NOT SENT — no provider configured. Message logged instead.', {
      to, subject, attachments: attachments.map((a) => `${a.filename} (${a.content?.length ?? 0} bytes)`),
    });
    return { id: `console-${Date.now()}`, provider: 'console' };
  }
}

class ResendTransport {
  constructor(client) { this.client = client; this.name = 'resend'; }

  static async create() {
    const { Resend } = await import('resend');
    return new ResendTransport(new Resend(config.email.resendApiKey));
  }

  async send({ to, subject, html, text, attachments = [], replyTo }) {
    const { data, error } = await this.client.emails.send({
      from: config.email.from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      replyTo: replyTo ?? config.email.replyTo,
      attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
    });

    if (error) {
      const err = new Error(error.message || 'Email provider rejected the message');
      err.provider = 'resend';
      err.providerError = error;
      throw err;
    }
    return { id: data?.id ?? null, provider: 'resend' };
  }
}

let transportPromise = null;

export async function getTransport() {
  if (!transportPromise) {
    transportPromise = config.email.resendApiKey
      ? ResendTransport.create()
      : Promise.resolve(new ConsoleTransport());
  }
  return transportPromise;
}

/* ---------------------------------------------------------- templates --- */

const brandShell = (title, bodyHtml) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e5ea;">
  <tr><td style="background:#14142A;padding:22px 28px;">
    <span style="display:inline-block;width:22px;height:22px;background:#FFD23F;border-radius:6px;vertical-align:middle;"></span>
    <span style="color:#ffffff;font:600 17px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;vertical-align:middle;margin-left:9px;">Accessrank</span>
  </td></tr>
  <tr><td style="padding:30px 28px 34px;font:400 15px/1.62 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#23262F;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:18px 28px;background:#fafbfc;border-top:1px solid #e3e5ea;font:400 12px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#6a6f7d;">
    Accessrank &middot; <a href="${config.siteUrl}" style="color:#6a6f7d;">${escapeHtml(config.siteUrl.replace(/^https?:\/\//, ''))}</a><br>
    You received this because you requested an accessibility report for your website.
    <a href="${config.siteUrl}/privacy" style="color:#6a6f7d;">Privacy</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

const scoreRow = (label, value) => `
  <tr>
    <td style="padding:7px 0;font:400 14px/1.4 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#4a4f5c;">${escapeHtml(label)}</td>
    <td align="right" style="padding:7px 0;font:700 20px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14142A;">${value == null ? '—' : escapeHtml(String(value))}</td>
  </tr>`;

/**
 * The report delivery email. The PDF is the payload; the body gives enough of
 * the result that the message is useful even if the attachment is stripped by a
 * corporate mail filter.
 */
export function reportEmail({ lead, result }) {
  const origin = result.origin ?? result.finalUrl ?? '';
  const scores = result.scores ?? {};
  const failed = result.accessibility?.failedCriteria ?? [];
  const firstName = (lead.name || '').split(' ')[0] || 'there';

  const html = brandShell(`Your accessibility report for ${origin}`, `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 20px;">Your accessibility and SEO report for
      <strong>${escapeHtml(origin)}</strong> is attached as a PDF.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid #e3e5ea;border-radius:10px;padding:6px 16px;margin:0 0 20px;">
      ${scoreRow('Overall score', scores.overall)}
      ${scoreRow('Accessibility', scores.accessibility)}
      ${scoreRow('SEO', scores.seo)}
    </table>

    ${failed.length ? `<p style="margin:0 0 8px;font-weight:600;">WCAG success criteria not met</p>
    <p style="margin:0 0 20px;color:#4a4f5c;">${escapeHtml(failed.join(', '))}</p>` : ''}

    <p style="margin:0 0 20px;">We scanned ${escapeHtml(String(result.pagesScanned ?? 1))} page(s) with
      axe-core ${escapeHtml(result.axeVersion ?? '')} against WCAG 2.2 Level AA. The PDF lists every
      finding, the elements affected, and how to fix each one.</p>

    <p style="margin:0 0 26px;">Automated testing reliably catches somewhere between a third and a half of
      real accessibility barriers. A full conformance claim also needs manual and
      assistive-technology testing — that is what our paid audit covers.</p>

    <p style="margin:0 0 26px;">
      <a href="${config.siteUrl}/contact-sales"
         style="display:inline-block;background:#FFD23F;color:#14142A;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Talk to us about fixing this</a>
    </p>

    <p style="margin:0;color:#4a4f5c;">Reply to this email if you want us to walk you through the findings.</p>
  `);

  const text = [
    `Hi ${firstName},`,
    '',
    `Your accessibility and SEO report for ${origin} is attached as a PDF.`,
    '',
    `Overall score:  ${scores.overall ?? '—'}`,
    `Accessibility:  ${scores.accessibility ?? '—'}`,
    `SEO:            ${scores.seo ?? '—'}`,
    '',
    failed.length ? `WCAG criteria not met: ${failed.join(', ')}` : '',
    '',
    `We scanned ${result.pagesScanned ?? 1} page(s) with axe-core ${result.axeVersion ?? ''} against WCAG 2.2 Level AA.`,
    'Automated testing catches roughly a third to a half of real accessibility barriers;',
    'a full conformance claim also needs manual and assistive-technology testing.',
    '',
    `Talk to us: ${config.siteUrl}/contact-sales`,
    '',
    'Accessrank',
    config.siteUrl,
  ].filter((line) => line !== undefined).join('\n');

  return { subject: `Your accessibility report for ${origin}`, html, text };
}

/** Internal notification so a new lead is visible without opening the database. */
export function leadNotificationEmail({ lead, result = null, kind = 'audit_report' }) {
  const rows = [
    ['Name', lead.name],
    ['Email', lead.email],
    ['Phone', lead.phone],
    ['Company', lead.company],
    ['Website', lead.website],
    ['Source', kind],
    ['Plan', lead.plan],
    ['Platform', lead.platform],
    ['Overall score', result?.scores?.overall],
    ['Accessibility', result?.scores?.accessibility],
    ['SEO', result?.scores?.seo],
    ['Failed criteria', result?.accessibility?.failedCriteria?.join(', ')],
    ['Message', lead.message],
  ].filter(([, value]) => value != null && value !== '');

  const html = brandShell('New lead', `
    <p style="margin:0 0 16px;font-weight:600;">New ${escapeHtml(kind.replace('_', ' '))} lead</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font:400 14px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:6px 12px 6px 0;color:#6a6f7d;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:6px 0;color:#23262F;">${escapeHtml(String(v))}</td>
      </tr>`).join('')}
    </table>
  `);

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject: `New lead — ${lead.email}${result?.scores?.overall != null ? ` (score ${result.scores.overall})` : ''}`, html, text };
}

/* ------------------------------------------------------------- sending --- */

export async function sendReport({ lead, result, pdf }) {
  const transport = await getTransport();
  const { subject, html, text } = reportEmail({ lead, result });
  const safeHost = (result.origin ?? 'site').replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '-');

  return transport.send({
    to: lead.email,
    subject,
    html,
    text,
    attachments: [{ filename: `accessrank-report-${safeHost}.pdf`, content: pdf }],
  });
}

/** Best-effort: a failure here must never fail the visitor's request. */
export async function notifySales(payload) {
  if (!config.email.salesInbox) return null;
  try {
    const transport = await getTransport();
    const { subject, html, text } = leadNotificationEmail(payload);
    return await transport.send({ to: config.email.salesInbox, subject, html, text });
  } catch (err) {
    log.error('sales notification failed', { err: err.message });
    return null;
  }
}

export default { getTransport, sendReport, notifySales, reportEmail, leadNotificationEmail };

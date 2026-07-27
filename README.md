# Accessrank

Marketing site and live accessibility audit service for a WCAG 2.2 AA remediation
business selling to DTC ecommerce brands.

> **Picking this up cold?** Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first. It
> covers why the design decisions are what they are, and documents six bugs that
> produced no error message at all — including one that silently disabled the
> per-IP quota for every IPv6 visitor while all the tests stayed green.

One Node process serves the static marketing site **and** the audit API. One
`docker run` gives you the whole product.

---

## What it does

A visitor enters their store URL in the hero. The server loads that page in real
headless Chromium, runs **axe-core** against WCAG 2.2 Level AA, extracts on-page
SEO signals from the same page load, scores it, and shows the result immediately.

If they want the full report, a small modal collects **name, email and phone**.
That lead is written to Postgres alongside the complete scan result, a PDF is
generated, and it is **emailed** to the address they gave.

### Why the PDF is email-only

It is never offered as a browser download. That single decision is what makes
"one report per email address" enforceable — a throwaway address yields no
report — and it is the entire point of the lead capture.

---

## Quick start

```bash
npm install
npm run setup      # installs Chromium, self-hosts fonts, generates images, builds
npm start          # http://localhost:3000
```

That works with **no configuration at all**. Without `DATABASE_URL` the app uses
an in-memory store, and without `RESEND_API_KEY` emails are written to the log
instead of sent — so you can exercise the entire funnel locally, including the
quotas, before you have any accounts.

Try the scanner from the command line:

```bash
npm run scan -- https://example.com
npm run scan -- --fixture broken     # a deliberately broken storefront
npm run preview:pdf                  # writes report-preview.pdf
```

---

## How the score works

Documented in full at `/methodology`, because the PDF cites it.

**Accessibility — a conformance-criterion pass rate.** axe rules are grouped onto
the WCAG success criteria they test. A criterion is met or it is not; weight is
Level A = 3, Level AA = 2, best practice = 1.

```
score = weighted criteria met / weighted criteria evaluated x 100
```

It is deliberately **not** element-weighted. Under an element-weighted model a
storefront with no page title, no `lang` attribute, five images without alt text
and an unlabelled form scored **75** — because thousands of unrelated elements
happened to pass other checks. That understates real legal exposure to a buyer.
Under the criterion model the same page scores **39**. Failing SC 1.1.1 on five
images means you fail 1.1.1; passing markup elsewhere does not earn it back.

Element counts are still reported — they indicate the *size of the remediation
job*, not the score.

**SEO** — a weighted checklist of 14 on-page signals from the same page load.
**Overall** — 60% accessibility, 40% SEO.

Items axe cannot decide without a human count half. A site with nothing
measurable is reported as unscored, never as 100.

---

## Abuse protection

| Rule | Where enforced |
|---|---|
| 1 emailed report per email address, ever | `leads.email_normalized` UNIQUE + a locked transaction |
| 3 report requests per IP per rolling 24h | `rate_events` + `pg_advisory_xact_lock` |
| 8 scans per IP per rolling 24h | same |
| 3 scans per IP per minute | `express-rate-limit` |
| 24h per-origin scan cache | cache hits cost nothing and do not consume quota |

**Email normalization matters.** `carlos+promo@gmail.com`, `c.a.r.l.o.s@gmail.com`
and `CARLOS@googlemail.com` all collapse to `carlos@gmail.com`, so plus-tagging
cannot buy a second report. Gmail dot-stripping applies only to Gmail, where dots
genuinely are insignificant.

**IPv6 is normalized to the /64 prefix.** ISPs delegate a /64 per subscriber, so
counting full IPv6 addresses would make the per-IP quota meaningless.

**IP identity fails closed.** An address that cannot be parsed maps to a shared
bucket, never to "no limit". A pre-launch audit found the opposite: `clientIp()`
returned an already-normalized value and the routes normalized it a second time,
which turned every IPv6 `/64` string into `null` — and because the quota code
guards with `if (ipHash)`, that silently disabled the per-IP cap for every IPv6
visitor. The IPv4 tests passed the whole time. There are now HTTP-level tests
asserting the cap over IPv6 and across address rotation inside one `/64`.

**IPs are never stored in the clear** — only an HMAC-SHA256 keyed with
`IP_HASH_SALT`. Equality-comparable, not reversible. Rotating that salt resets
every quota, so treat it as permanent.

Quotas are consumed inside a transaction holding locks on both the email and the
IP, acquired in sorted order so concurrent requests cannot deadlock. The tests
fire 12 simultaneous same-email requests and assert exactly one wins.

If delivery fails on our side, the quota is **refunded** — an outage at the mail
provider must not burn the visitor's one allowed report.

Also active: Cloudflare Turnstile, a hidden honeypot field, and a minimum
form-completion time. Bot-trapped submissions receive a fake success response
rather than an error, so a script learns nothing.

---

## SSRF

The scanner fetches attacker-supplied URLs, so `server/lib/ssrf.js` is a real
security boundary, not a formality. Blocked: every spelling of loopback
(`127.1`, `0177.0.0.1`, `2130706433`, `[::1]`, `[::ffff:127.0.0.1]`), all RFC1918
and CGNAT ranges, `169.254.169.254` and the cloud metadata hostnames, IPv6
tunnels that embed a private IPv4 (`64:ff9b::`, `2002::`), non-HTTP schemes,
credentials in the URL, non-standard ports, and internal-looking suffixes.

Checks run at three points: before navigation (parse + DNS, requiring **every**
A/AAAA answer to be public), on every redirect hop and subresource request, and
against the socket's actual peer IP after the response — which is what closes the
DNS-rebinding window. Error messages never reveal whether an internal host exists.

`SCAN_ALLOW_PRIVATE` exists so integration tests can scan a loopback fixture. It
is ANDed with `!isProd` in config, so it cannot weaken a deployed instance even
if set.

---

## Layout

```
build.mjs              static site build (partials -> dist/)
src/
  pages/               page bodies (fragments, no <html>)
  partials/            shell, nav, footer, audit widget
  data/site.json       nav, footer, page manifest, job listings
  assets/css/          tokens -> base -> layout -> home/pages
  assets/js/           site.js (shared), audit.js (funnel)
server/
  index.js             express app: static + API + CSP
  routes/api.js        /api/scan, /api/report, /api/lead, /api/health, admin
  lib/
    ssrf.js            URL validation (security boundary)
    identity.js        email/IP normalization for quotas
    quota.js           the abuse rules
    store.js           Postgres + in-memory adapters
    scanner.js         Playwright + axe-core
    scoring.js         the scoring model
    pdf.js  email.js   report generation and delivery
    template.js        renderer shared by the site build and the PDF
db/migrations/         SQL
tests/                 unit + integration
legacy/                the original hand-written site, kept for reference
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Build the static site into `dist/` |
| `npm start` / `npm run dev` | Serve site + API |
| `npm test` | Unit + integration tests |
| `npm run test:a11y` | **Audit our own site with axe-core; fails on any violation** |
| `npm run test:links` | Fail if any internal link is dead |
| `npm run verify` | All of the above |
| `npm run migrate` | Apply SQL migrations |
| `npm run fonts` / `npm run images` | Regenerate self-hosted fonts / brand images |

`npm run test:a11y` runs every built page through axe-core at desktop and mobile
viewports and fails on a single violation. A company selling WCAG conformance
cannot ship a marketing site that fails it.

---

## Deploying

Secrets are never baked into the image. `SITE_URL` **is** baked in at build time
because it appears in canonical tags and the sitemap.

```bash
fly launch --no-deploy
fly secrets set \
  DATABASE_URL="postgres://..." \
  RESEND_API_KEY="re_..." \
  IP_HASH_SALT="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  TURNSTILE_SECRET_KEY="0x..." \
  ADMIN_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
fly deploy
fly ssh console -C "node scripts/migrate.mjs"
```

Set `TURNSTILE_SITE_KEY` in `fly.toml` under `[build.args]` — it is public and
must be present at build time to render into the forms.

The same image runs on Render, Railway, or any VPS. Give it **2GB of RAM**:
Chromium will be OOM-killed mid-scan on 512MB.

In production the app **refuses to boot** without `DATABASE_URL`, `IP_HASH_SALT`,
`RESEND_API_KEY`, `ADMIN_TOKEN`, both Turnstile keys, and an `https://` `SITE_URL`.
That is deliberate — a deploy that silently drops leads or runs without bot
defence is worse than one that fails loudly. Turnstile in particular produces no
visible symptom when missing, so it is a boot failure rather than a warning;
`ALLOW_NO_CAPTCHA=1` is the explicit opt-out.

---

## Getting the leads out

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://accessrank.ai/api/admin/leads?format=csv" -o leads.csv
```

Columns: date, client name, email, phone, company, website, source, overall /
accessibility / SEO scores, violation counts, pages scanned, marketing opt-in,
consent timestamp, and delivery status — everything the brief asked to be
recorded. In SQL it is the `lead_export` view.

Values beginning `=`, `+`, `-` or `@` are prefixed with an apostrophe so a
malicious lead cannot inject a spreadsheet formula into a file an operator opens.

---

## Things that were deliberately removed

- **The fake hero scan.** The original ran a simulated audit of `example.shop`
  800ms after page load, for every visitor, with hardcoded results identical for
  any URL entered. It is now a real scan that only runs when asked.
- **The fabricated testimonial.** "Henry Lovejoy, FresheMeals.com" — no photo, no
  link, unverifiable. Social proof is now config-gated
  (`FEATURE_TESTIMONIALS`) and stays off until real, attributable quotes exist.
- **The signup password field.** It was required, validated, then silently
  discarded; no account was created. Collecting a credential that goes nowhere is
  a liability. The page is now honestly a lead form.
- **Web3Forms.** Both forms POSTed to a third party with a hardcoded key. They now
  post to `/api/lead`.
- **Google Fonts CDN.** It sent every visitor's IP to Google on page load, which a
  German court has held unlawful under the GDPR — awkward for a compliance
  product, and undisclosed in its own privacy policy. Fonts are self-hosted.
- **Eleven dead links**, including four footer `href="#"` placeholders repeated on
  every page and four job listings that all pointed at the pricing anchor.
  `npm run test:links` now makes that class of defect a build failure.

---

## Known limitations

Stated here and on `/methodology` because the product is sold on honesty about risk.

- Automated testing detects roughly **a third to a half** of real accessibility
  barriers. It cannot judge whether alt text is *meaningful*, whether focus order
  is *logical*, or whether an error message is *helpful*. A conformance claim
  requires manual and assistive-technology testing.
- The free check reads up to 3 pages. A storefront's real debt is spread across
  product, collection and checkout templates.
- A good score is not a legal guarantee, and nothing here is legal advice.

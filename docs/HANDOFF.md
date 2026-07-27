# Handoff

Context for anyone — human or AI — picking this project up cold.

`README.md` explains **what the system does**. This file explains **why it is the
way it is**, what was already tried, and which decisions will otherwise get
re-litigated and quietly reverted.

**Last updated:** 27 July 2026
**Repo:** `criercomm/ARnewpricing` · **State:** merged to `main` at `319f77a`

---

## 1. Where things stand

The original repo was 8 hand-written static files. It is now a Node 22
application that serves the marketing site and a real accessibility-audit API
from one process. Merged via PR #1 with CI green.

**Done and verified:** everything in the original brief.
**Not done:** the site is not deployed. No infrastructure exists yet — no
database, no email account, no host. See §7.

The original 8 files are preserved untouched in `legacy/` and are also reachable
at commit `f7d2be6`.

---

## 2. The brief, as given

Verbatim intent, so it can be checked against later:

1. A working accessibility test on the homepage hero that really tests the
   visitor's site against WCAG — not a simulation.
2. Before exporting the report as PDF, a **small** lead-capture popup with
   name, phone and email.
3. The PDF with the results is **emailed** to the lead's address.
4. Leads recorded somewhere: client name, website, email, phone, and the report
   results they got.
5. Prevent more than **1 report per email** and **3 reports per IP per day**.
6. Production-ready. "Make an awesome website."

All six are met. §4 explains the parts that are easy to get wrong.

---

## 3. Layout

```
build.mjs              static build: partials -> dist/
src/
  pages/               page bodies (fragments — no <html>, no nav, no footer)
  partials/            shell.html, nav, footer, audit-widget (the funnel UI)
  data/site.json       nav, footer, page manifest, FAQ, job listings
  assets/css/          CASCADE ORDER MATTERS — see §5
  assets/js/           site.js (shared) · audit.js (the whole funnel)
server/
  app.js               express app, no side effects on import (tests mount it)
  index.js             boot, config guard, graceful shutdown
  routes/api.js        /api/scan /report /lead /health /quota /admin/leads
  lib/
    ssrf.js            security boundary — read before touching
    identity.js        email + IP normalization (quota correctness lives here)
    quota.js           the abuse rules
    store.js           PostgresStore + MemoryStore, same interface
    scanner.js         Playwright + axe-core
    scoring.js         the scoring model
    browser.js         one shared Chromium for scanner AND pdf
    template.js        renderer shared by site build and PDF
    pdf.js  email.js   report generation and delivery
    minify.js          CSS minifier (has a painful history — §6)
db/migrations/         SQL
tests/                 116 tests: unit, integration, real-browser E2E
legacy/                the original site, untouched
docs/RUNBOOK.md        operations, incidents, GDPR erasure
```

---

## 4. Decisions that must not be casually reverted

These each look like arbitrary choices and are not. Each has a reason that cost
real effort to discover.

### 4.1 Accessibility scoring is per WCAG criterion, NOT per element

`server/lib/scoring.js`. Rules are grouped onto the success criteria they test.
A criterion is met or not met. Weight: Level A = 3, AA = 2, best practice = 1.

The obvious implementation — element-weighted pass rate — was built first and
**scored a deliberately broken storefront at 75/100**, because thousands of
unrelated passing elements offset five images with no alt text. That understates
legal exposure to a buyer, which for a compliance product is not a rounding
error. The criterion model scores the same page **39**, and a well-built one
**96**.

Element counts are still reported, as the *size of the remediation job*.
Public at `/methodology` because the PDF cites it. If you change the model,
change that page too.

### 4.2 The PDF is email-only, never a download

This is what makes "one report per email" self-enforcing — a throwaway address
yields no report — and it is the entire point of the lead capture. There is a
test asserting no PDF bytes appear in the HTTP response. Do not add a download
button "for convenience".

### 4.3 Email normalization collapses aliases

`carlos+promo@gmail.com`, `c.a.r.l.o.s@gmail.com` and `CARLOS@googlemail.com`
are one inbox and one quota key. Dot-stripping applies **only** to Gmail, where
dots genuinely are insignificant — applying it elsewhere would merge unrelated
people. `leads.email_normalized` is UNIQUE; that constraint is the real
enforcement, not application logic.

### 4.4 IPv6 is bucketed by /64, and IP identity fails closed

ISPs delegate a /64 (often a /56) per subscriber. Counting full IPv6 addresses
would make the per-IP quota meaningless — a subscriber has ~18 quintillion of
them. An address that cannot be parsed maps to a **shared bucket**, never to
"no limit". See §6.5 for why that matters more than it sounds.

### 4.5 The timing bot-trap is advisory, not a gate

`submittedTooFast()` only logs. The honeypot gates; timing does not. Autofill
can legitimately complete a three-field form in under two seconds, and blocking
means the visitor sees success, gets no report, and a real lead vanishes with no
error anywhere. This was caught by an E2E test that filled the form too fast and
got a silent fake success. **Do not "tighten" this into a gate.**

### 4.6 Turnstile is a fatal boot error in production

A missing CAPTCHA produces no visible symptom, so it fails the boot instead.
`ALLOW_NO_CAPTCHA=1` is the documented opt-out. This was originally only claimed
in a comment while not actually being enforced — an audit caught the lie.

### 4.7 No invented social proof

The original site had a fabricated testimonial ("Henry Lovejoy ·
FresheMeals.com" — no photo, no link, unverifiable). It was removed and **not
replaced**. Social proof is config-gated behind `FEATURE_TESTIMONIALS`, off
until real attributable quotes exist. Two independent reviews specifically
checked for fake customers, logos and statistics and found none. Keep it that way.

Every statistic on the site carries a named source. If you add one, cite it.

### 4.8 Free-text is stripped of angle brackets at write time, not escaped

Escaping on write corrupts data — "Ben & Co" must not reach an email as
"Ben &amp; Co". Output encoding at every render point is the real defence.
Stripping `<` and `>` from names and companies just means a stored-XSS payload
never exists in the database, so a future admin dashboard that forgets to escape
cannot be the only thing standing between a public form and script execution.

### 4.9 Fonts are self-hosted

The original loaded them from `fonts.googleapis.com`, which sends every
visitor's IP to Google on page load — a GDPR problem a German court has already
ruled on, undisclosed in the site's own privacy policy, on a product sold as
legal compliance. `npm run fonts` regenerates them. Do not "simplify" back to
the CDN.

---

## 5. CSS cascade order is load-bearing

`build.mjs` concatenates in this exact order:

```
tokens · fonts · base · layout · home · pages · components · a11y
```

- **`components.css` after `pages.css`** — these are *new* components (modal,
  consent checkboxes, form status, ghost button, the scan result panel). Placed
  in `layout.css` originally, they lost every equal-specificity collision to
  `pages.css`, and consent checkboxes rendered above their labels.
- **`a11y.css` last** — accessibility rules are conformance requirements, not
  styling preferences. Nothing may override them. The inline-link underline rule
  (WCAG 1.4.1) lived in `base.css` and was silently beaten by a `.doc a` rule,
  failing the self-audit on 11 pages.

Also: section-heading defaults use `:where()` for **zero specificity**. Written
as `.site h2` (0,1,1) they outranked every single-class heading rule —
`.hero-title` and `.audit-title` both lost to it. A default must never beat the
component that opts out of it.

---

## 6. Bugs already found — and the pattern behind them

Every one of these produced **no error anywhere**. That is the failure mode this
codebase is prone to, so treat "the tests pass" as necessary and not sufficient.

**6.1 — The CSS minifier broke `calc()`.** Stripping whitespace around `+`
turned `calc((100% - 1280px) / 2 + 64px)` into `2+64px`, which is invalid. That
invalidated `--edge`, which invalidated every `padding: 50px var(--edge) 64px`,
which **silently collapsed all section spacing site-wide to zero**. Nothing
errored. `server/lib/minify.js` is now deliberately timid and has 10 regression
tests. Do not make it cleverer.

**6.2 — The template engine could not nest `{{#each}}`.** A non-greedy regex
closed the outer block at the inner `{{/each}}`, so the customer-facing PDF
printed literal `{{#each criteria}}` and `[object Object]`. Now uses a
depth-tracking scanner; interpolating an object throws rather than shipping
`[object Object]`.

**6.3 — The scan result panel had no CSS at all.** The entire renderer was
written in JS and not one of its 23 classes was styled. The flagship "the check
is real" moment showed `Accessibility93` as run-together text with no progress
bars. **The a11y gate passed** (unstyled text still has contrast) and the E2E
test passed (it asserted DOM values, never appearance). Only a human-style
visual review caught it.

**6.4 — The timing trap silently swallowed real submissions.** See §4.5.

**6.5 — The per-IP quota was completely inert over IPv6.** `clientIp()` returned
an already-normalized value and every route called `hashIp(clientIp(req))`,
normalizing twice. An IPv6 `/64` is not a parseable literal, so the second pass
returned `null` — and the quota guards are written `if (ipHash)`, so `null` meant
*skip the check*. Any visitor on IPv6 had unlimited reports, no attacker effort
required. **Every IPv4 test passed throughout**, because the tests only ever sent
IPv4 in `X-Forwarded-For`.

> **The lesson:** when a guard is written `if (x) { enforce }`, a bug that makes
> `x` falsy silently disables the rule. Prefer failing closed, and test the
> boring variant (IPv6, autofill, empty input) — that is where these hide.

---

## 7. What is left: deployment

Nothing in the code. Only accounts and infrastructure.

1. **Postgres** — Supabase/Neon free tier. Use the pooler connection string.
2. **Resend** — verify the sending domain, or every send fails silently.
   *Requires DNS access for whatever domain sends the reports.*
3. **Cloudflare Turnstile** — free, two keys.
4. **Two generated secrets** — `IP_HASH_SALT` (32+ chars) and `ADMIN_TOKEN`.
5. **Host with 2 GB RAM.** On 512 MB Chromium is OOM-killed mid-scan and the
   symptom looks like a mysterious timeout, not an out-of-memory error.
6. `node scripts/migrate.mjs` once after the first deploy.
7. Send one real report end to end before announcing.

`docs/RUNBOOK.md` has the exact commands, incident procedures and a GDPR
erasure runbook.

**`IP_HASH_SALT` is effectively permanent.** Rotating it re-keys every hash and
resets all per-IP quotas to zero. Store it where it will not be lost.

An email drafting these steps for the stakeholder was written on 27 July 2026
and is not stored in the repo.

---

## 8. Verification gates

```
npm run verify     # build + tests + a11y self-audit + link check
```

- **116 tests** — unit, integration, and real-browser E2E driving
  scan → modal → PDF → email
- **`npm run test:a11y`** — every built page through axe-core at desktop and
  mobile; fails on a single violation. A company selling WCAG conformance must
  not ship a site failing its own audit. **This is not optional.**
- **`npm run test:links`** — the original shipped 11 dead links; this keeps them
  from returning.

Useful during development:

```
npm run scan -- --fixture broken      # scan a deliberately broken storefront
npm run preview:pdf                   # generate a sample report PDF
node scripts/shoot.mjs / --mobile     # screenshot pages (PowerShell, not Git Bash —
                                      # Git Bash mangles a leading "/" into a path)
```

`tests/fixtures/broken.html` and `clean.html` are calibrated: broken should score
~39, clean ~96. If those move a lot, the scoring model changed — check whether
that was intended.

---

## 9. Open items and known limitations

**Not done, deliberately:**

- **Plain-English rewriting of axe rule labels.** Findings still read as
  "Document should have one main landmark". Fixing it means maintaining a
  translation table for ~90 rules, and a wrong translation on a compliance
  report is worse than an accurate technical one. The PDF carries the full
  explanation.
- **The hero says "about 20 seconds".** A trivial page returns in ~2s; a real
  storefront with 3 pages crawled takes longer. Deliberately under-promising.
- **No customer/case-study page.** Cannot be written without real customers.

**Honest limitations, stated on `/methodology`, in the email and in the PDF:**

Automated testing detects roughly a third to a half of real accessibility
barriers. It cannot judge whether alt text is *meaningful*, whether focus order
is *logical*, or whether an error message is *helpful*. A conformance claim needs
manual and assistive-technology testing. A good score is not a legal guarantee.

Keep these caveats. They are the difference between this product and the overlay
vendors it criticises.

**Minor:** `legacy/` still contains the original Web3Forms key. It is public by
design in that service and nothing uses it any more, but it can be rotated or
disabled in their panel.

---

## 10. Git and access notes

- Two GitHub accounts are on this machine. The stored Windows credential is
  `cmarruffo1982`, which has **no access** to this repo. The one with access is
  **`go3601981`**. The remote URL embeds the username
  (`https://go3601981@github.com/...`) so git requests the right credential —
  do not strip it.
- A classic PAT needs both **`repo`** and **`workflow`** scopes. Without
  `workflow`, any push touching `.github/workflows/` is rejected *after*
  uploading everything.
- Local history was grafted onto the remote's: the initial snapshot tree was
  byte-identical to `origin/main`, so the work replayed on top with no conflicts
  and a genuine common ancestor. There is no force-push in this history.

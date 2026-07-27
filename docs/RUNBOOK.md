# Runbook

Operational reference for the Accessrank site and audit service.

---

## Health

`GET /api/health` reports which subsystems are usable:

```json
{ "ok": true, "site": true, "scanner": true, "database": true,
  "email": true, "captcha": true, "leadFunnel": true, "axe": "4.12.1" }
```

`leadFunnel: false` means reports cannot be delivered — check `database`,
`email` and that `IP_HASH_SALT` is set. The endpoint returns **503** in
production when `leadFunnel` is false, so a load balancer will pull the instance.

It never lists which environment variables are missing in production; that detail
appears only in development logs.

---

## Common incidents

### "Reports are not arriving"

1. `GET /api/health` → is `email: true`?
2. Check logs for `report delivery failed`. The visitor's quota is **automatically
   refunded** on delivery failure, so they can retry once the cause is fixed.
3. Verify the sending domain is verified in Resend. An unverified domain fails
   every send.
4. Query recent failures:
   ```sql
   SELECT created_at, status, error_detail, attempts
   FROM reports WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;
   ```

### "Scans are timing out"

- The total budget is `SCAN_TOTAL_TIMEOUT_MS` (default 45s) and navigation is
  `SCAN_NAV_TIMEOUT_MS` (20s). Very slow storefronts legitimately exceed these.
- If *all* scans fail, Chromium probably died. Look for
  `Chromium disconnected` in the logs; it relaunches on the next request.
- Under memory pressure Chromium is OOM-killed mid-scan. **2GB minimum.** Lower
  `SCAN_CONCURRENCY` before adding memory.

### "A visitor says they were blocked"

Distinguish the three cases by the error `code`:

| Code | Meaning | Action |
|---|---|---|
| `email_limit` | That address already received its one report | Intended. Send them to `/contact-sales`. |
| `ip_limit` | 3 reports from that network in 24h | Intended. Common on office/shared NAT — see below. |
| `scan_ip_limit` | 8 scans in 24h | Intended. |
| `blocked_target` / `private_address` | SSRF guard | Intended, unless they gave a genuine public URL — then investigate. |

To clear a quota for a specific person (support exception):

```sql
-- Find the lead. You cannot search by IP: only a one-way hash is stored.
SELECT id, email, reports_sent, created_at FROM leads WHERE email = 'them@example.com';

-- Allow one more report for that lead.
UPDATE reports SET status = 'failed', error_detail = 'support override'
WHERE lead_id = '<lead-id>' AND status = 'sent';
```

`countReportsForLead` ignores `failed` rows, so this grants exactly one retry
while leaving an audit trail.

For a shared-office IP, raise `LIMIT_REPORTS_PER_IP_PER_DAY` rather than clearing
rows — the per-email rule is the one doing the real work.

### "The site is up but pages 404"

`dist/` was not built. The Dockerfile builds it; if you are running from source,
`npm run build`. Look for `dist/ not found` in the boot log.

---

## Data

### Getting leads out

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://accessrank.ai/api/admin/leads?format=csv&limit=5000" -o leads.csv
```

Or in SQL, `SELECT * FROM lead_export ORDER BY created_at DESC;`

### A GDPR erasure request

```sql
-- Scans are retained (they are about a website, not a person) but are unlinked.
UPDATE leads SET last_scan_id = NULL WHERE email_normalized = '<normalized>';
DELETE FROM leads WHERE email_normalized = '<normalized>';  -- cascades to reports
```

Deleting the lead frees that address to request a report again. That is the
correct outcome: erasure means we no longer hold a record that they used it.

Find the normalized form with:
`node -e "import('./server/lib/identity.js').then(m=>console.log(m.normalizeEmail('THEIR@email.com').normalized))"`

### Housekeeping

`rate_events` grows with traffic and only the last 24h is ever read.

```sql
DELETE FROM rate_events WHERE created_at < now() - interval '7 days';
```

Run weekly. `store.purgeOldRateEvents(7)` does the same from code.

Scan `result` payloads are the bulk of the database. To trim old ones while
keeping the headline numbers and the lead linkage:

```sql
UPDATE scans SET result = NULL
WHERE created_at < now() - interval '180 days'
  AND id NOT IN (SELECT scan_id FROM reports);
```

---

## Rotating secrets

| Secret | Safe to rotate? |
|---|---|
| `RESEND_API_KEY` | Yes, any time. |
| `ADMIN_TOKEN` | Yes, any time. |
| `TURNSTILE_SECRET_KEY` | Yes — rotate the site key with it and rebuild. |
| `DATABASE_URL` | Yes. |
| **`IP_HASH_SALT`** | **Effectively no.** Rotating it re-keys every hash, which resets all per-IP quotas to zero. Only rotate if you believe the salt leaked, and expect a window of unlimited per-IP reports. The per-email rule still holds during that window. |

---

## Tuning

| Symptom | Change |
|---|---|
| Scans queue behind each other | Raise `SCAN_CONCURRENCY` (needs ~150MB RAM each) |
| Chromium OOM | Lower `SCAN_CONCURRENCY`, or raise the VM to 4GB |
| Too much Chromium load | Raise `SCAN_CACHE_TTL_HOURS`; repeat scans of one origin become free |
| Reports too thin | Raise `SCAN_MAX_PAGES` (linear cost in time) |
| Legitimate users hitting limits | Raise `LIMIT_REPORTS_PER_IP_PER_DAY`; keep `LIMIT_REPORTS_PER_EMAIL=1` |

---

## Deploy checklist

1. `npm run verify` passes (build, tests, self-a11y audit, link check).
2. `SITE_URL` build arg is the real public origin — it is baked into canonical
   tags and the sitemap.
3. `TURNSTILE_SITE_KEY` build arg set (public), `TURNSTILE_SECRET_KEY` as a secret.
4. All production secrets set. The app refuses to boot without them.
5. `node scripts/migrate.mjs` after first deploy and after any schema change.
6. `GET /api/health` returns `leadFunnel: true`.
7. Send yourself one real report end-to-end before announcing.

---

## What the CI gate protects

`npm run test:a11y` audits every built page with axe-core at desktop and mobile
and fails on a single violation. Do not merge past it — the product is WCAG
conformance, and a marketing site that fails its own audit is the one defect
customers will notice first.

`npm run test:links` fails on any dead internal link. The original site shipped
eleven; this is what keeps them from coming back.

-- Accessrank — initial schema
--
-- Design notes that matter for correctness:
--
-- * Quotas are enforced in the database, not the application, because the app
--   runs multiple processes and two concurrent requests would otherwise both
--   pass a check-then-insert. Every quota has either a UNIQUE constraint or a
--   transaction-scoped advisory lock behind it.
--
-- * Client IPs are never stored in the clear. `ip_hash` is an HMAC-SHA256 keyed
--   with a server-side salt. It is equality-comparable (which is all a quota
--   needs) but not reversible, so a database leak does not expose visitor IPs.
--
-- * `email_normalized` is the quota key and is UNIQUE. `email` is what we
--   actually send to. carlos+a@gmail.com and c.arlos@gmail.com collapse to the
--   same normalized key; see server/lib/identity.js.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- scans ----

CREATE TABLE IF NOT EXISTS scans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- What was asked for, and the canonical origin used as the cache key.
  requested_url     text        NOT NULL,
  final_url         text,
  origin            text        NOT NULL,

  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','ok','failed','blocked')),
  error_code        text,
  error_detail      text,

  -- Headline numbers, denormalized out of `result` for cheap querying/export.
  score_overall     smallint CHECK (score_overall BETWEEN 0 AND 100),
  score_a11y        smallint CHECK (score_a11y   BETWEEN 0 AND 100),
  score_seo         smallint CHECK (score_seo    BETWEEN 0 AND 100),
  violations_total  integer  NOT NULL DEFAULT 0,
  violations_critical integer NOT NULL DEFAULT 0,
  violations_serious  integer NOT NULL DEFAULT 0,
  violations_moderate integer NOT NULL DEFAULT 0,
  violations_minor    integer NOT NULL DEFAULT 0,
  pages_scanned     smallint NOT NULL DEFAULT 0,

  -- Full axe-core + SEO payload. Kept so a report can be regenerated later
  -- without re-scanning the customer's site.
  result            jsonb,

  engine_version    text,
  axe_version       text,
  duration_ms       integer,

  ip_hash           text,
  user_agent        text,

  -- Populated when this scan was served from an earlier scan of the same origin.
  served_from_cache boolean NOT NULL DEFAULT false,
  cached_from       uuid REFERENCES scans(id) ON DELETE SET NULL
);

-- Cache lookup: newest successful scan for an origin.
CREATE INDEX IF NOT EXISTS scans_origin_recent_idx
  ON scans (origin, created_at DESC)
  WHERE status = 'ok' AND served_from_cache = false;

CREATE INDEX IF NOT EXISTS scans_ip_recent_idx  ON scans (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_created_at_idx ON scans (created_at DESC);

-- ---------------------------------------------------------------- leads ----

CREATE TABLE IF NOT EXISTS leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  name               text NOT NULL,
  email              text NOT NULL,
  -- The quota key. UNIQUE is what makes "one report per email" unbypassable by
  -- plus-tagging or gmail dot tricks.
  email_normalized   text NOT NULL UNIQUE,
  email_domain       text,
  phone              text,
  company            text,

  -- The site the lead asked us to audit. This is the "website" field.
  website            text,
  website_origin     text,

  -- 'audit_report' | 'signup' | 'contact_sales'
  source             text NOT NULL DEFAULT 'audit_report',
  intent             text,
  plan               text,
  platform           text,
  message            text,

  ip_hash            text,
  user_agent         text,
  referer            text,
  utm                jsonb,

  -- GDPR: record that consent was given, when, and to what text.
  consent_at         timestamptz,
  consent_text       text,
  marketing_opt_in   boolean NOT NULL DEFAULT false,

  reports_sent       integer NOT NULL DEFAULT 0,
  last_scan_id       uuid REFERENCES scans(id) ON DELETE SET NULL,

  -- Denormalized headline result, so a CSV export answers
  -- "which score did this lead get?" without a join.
  last_score_overall smallint,
  last_score_a11y    smallint,
  last_score_seo     smallint,

  notes              text
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_ip_recent_idx  ON leads (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_source_idx     ON leads (source, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_website_idx    ON leads (website_origin);

-- -------------------------------------------------------------- reports ----

CREATE TABLE IF NOT EXISTS reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),

  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scan_id        uuid NOT NULL REFERENCES scans(id) ON DELETE RESTRICT,

  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','failed')),
  delivered_at   timestamptz,
  provider       text,
  provider_id    text,
  error_detail   text,
  attempts       integer NOT NULL DEFAULT 0,

  pdf_bytes      integer,
  ip_hash        text
);

CREATE INDEX IF NOT EXISTS reports_lead_idx    ON reports (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_ip_recent_idx ON reports (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON reports (status, created_at DESC);

-- --------------------------------------------------------- rate limiting ----

-- Append-only event log backing the rolling-window quotas. A rolling 24h window
-- is used rather than a calendar-day counter: a calendar day would let someone
-- take 3 reports at 23:59 and 3 more at 00:01.
CREATE TABLE IF NOT EXISTS rate_events (
  id         bigserial PRIMARY KEY,
  scope      text        NOT NULL,   -- 'report_ip' | 'scan_ip' | 'report_email'
  subject    text        NOT NULL,   -- ip_hash or normalized email
  created_at timestamptz NOT NULL DEFAULT now(),
  meta       jsonb
);

CREATE INDEX IF NOT EXISTS rate_events_lookup_idx
  ON rate_events (scope, subject, created_at DESC);

-- ------------------------------------------------------------- triggers ----

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- views ----

-- The operator-facing lead list: everything the brief asked to be recorded,
-- in one place — client name, website, email, phone, and the score they got.
CREATE OR REPLACE VIEW lead_export AS
SELECT
  l.created_at,
  l.name              AS client_name,
  l.email,
  l.phone,
  l.company,
  l.website,
  l.source,
  l.last_score_overall AS score_overall,
  l.last_score_a11y    AS score_accessibility,
  l.last_score_seo     AS score_seo,
  s.violations_total,
  s.violations_critical,
  s.violations_serious,
  s.pages_scanned,
  l.marketing_opt_in,
  l.consent_at,
  r.status            AS report_status,
  r.delivered_at      AS report_delivered_at
FROM leads l
LEFT JOIN scans   s ON s.id = l.last_scan_id
LEFT JOIN LATERAL (
  SELECT status, delivered_at
  FROM reports
  WHERE lead_id = l.id
  ORDER BY created_at DESC
  LIMIT 1
) r ON true;

INSERT INTO schema_migrations (version) VALUES ('001_init')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- BUS TZ PAWA — Schema v2 (Claude-powered agent additions)
-- Run AFTER db_schema.sql (v1).
-- Idempotent — safe to re-run.
--
-- What this adds:
--   1. call_requests columns used by 06_outbound_caller and the new
--      `trigger_outbound_call` agent tool (ticket_code, vapi_call_id,
--      context, purpose, created_by).
--   2. scheduled_reminders — agent schedules a future SMS / call.
--   3. manager_actions — audit log of escalations & manager-level
--      actions the agent took on a customer's behalf.
--   4. agent_actions_log — every tool call the agent made (debug +
--      compliance trail).
--   5. customer_history view — joins bookings by phone for "look up
--      this caller" tool.
--   6. parcel_quotes — freight quote cache so the cargo flow can
--      reference a specific quote later in the conversation.
--   7. Static seed for outbound-call purposes & reminder channels.
--
-- Ticketing tables (routes/trips/seats/bookings) come from v1.
-- Cargo tables (shipments/agents/buses) live in the website Supabase
-- project — see bus web/supabase/schema.sql. The agent calls them
-- through a separate Postgres credential.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Bring call_requests up to the columns agent tools need.
--    The base table comes from bus web/supabase/schema_v7.sql:
--      call_requests(id, phone, requested_at, status)
--    If you're running n8n against a separate Postgres that doesn't
--    have call_requests yet, the CREATE below creates it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_requests (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'pending'
);

ALTER TABLE call_requests
  ADD COLUMN IF NOT EXISTS ticket_code   TEXT,
  ADD COLUMN IF NOT EXISTS vapi_call_id  TEXT,
  ADD COLUMN IF NOT EXISTS purpose       TEXT,
  ADD COLUMN IF NOT EXISTS context       JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by    TEXT DEFAULT 'agent',  -- 'agent' | 'staff' | 'web'
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error    TEXT;

CREATE INDEX IF NOT EXISTS idx_call_requests_status_time
  ON call_requests (status, requested_at);

-- ------------------------------------------------------------
-- 2. scheduled_reminders
--    Agent tool `schedule_reminder` writes here. Workflow 04
--    (lifecycle messages) or a new sweeper picks them up at fire_at.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  id              BIGSERIAL PRIMARY KEY,
  booking_ref     TEXT,
  tracking_code   TEXT,
  phone           TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','call')),
  message         TEXT NOT NULL,
  fire_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed','cancelled')),
  sent_at         TIMESTAMPTZ,
  last_error      TEXT,
  created_by      TEXT DEFAULT 'agent',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON scheduled_reminders (status, fire_at);

-- ------------------------------------------------------------
-- 3. manager_actions
--    Audit log of manager-level actions the agent invoked on the
--    customer's behalf: escalations, refund triggers, free reschedules
--    beyond policy, special bookings, etc. Helps managers audit what
--    the agent did between their meetings.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manager_actions (
  id            BIGSERIAL PRIMARY KEY,
  action_type   TEXT NOT NULL,             -- 'escalate' | 'refund_request' | 'free_reschedule' | 'goodwill_credit' | 'service_gap' | 'callback'
  booking_ref   TEXT,
  tracking_code TEXT,
  phone         TEXT,
  summary       TEXT,
  payload       JSONB DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manager_actions_status
  ON manager_actions (status, created_at);

-- ------------------------------------------------------------
-- 4. agent_actions_log
--    One row per Claude tool call. Lets you replay a conversation,
--    diagnose loops, and bill per-tenant in slice 2.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_actions_log (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,                    -- VAPI call ID or web session
  channel         TEXT,                    -- 'voice' | 'web' | 'whatsapp'
  tool_name       TEXT NOT NULL,
  arguments       JSONB,
  result_summary  TEXT,
  latency_ms      INTEGER,
  ok              BOOLEAN,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_log_conv
  ON agent_actions_log (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_log_tool
  ON agent_actions_log (tool_name, created_at);

-- ------------------------------------------------------------
-- 5. customer_history view
--    Used by `customer_history` tool. Joins all bookings + complaints
--    a phone has had so the agent can greet returning customers
--    intelligently ("I see your last trip was Dar→Mbeya last month").
-- ------------------------------------------------------------
-- View groups by phone within a tenant. The tenant_slug column is
-- added to bookings by db_schema_v3_tenants.sql; this CREATE OR REPLACE
-- recompiles the view AFTER v3 has run so the column is exposed.
CREATE OR REPLACE VIEW customer_history_v AS
SELECT
  COALESCE(b.tenant_slug, 'bus-tz-pawa') AS tenant_slug,
  b.phone,
  b.passenger_name,
  COUNT(*) AS bookings_count,
  COUNT(*) FILTER (WHERE b.status = 'CONFIRMED' OR b.status = 'COMPLETED') AS confirmed_count,
  COUNT(*) FILTER (WHERE b.status = 'CANCELLED') AS cancelled_count,
  MAX(b.created_at) AS last_booking_at,
  MAX(b.amount)     AS max_spend,
  SUM(b.amount) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')) AS total_spend,
  ARRAY_AGG(DISTINCT b.payment_method) AS payment_methods_used,
  ARRAY_AGG(DISTINCT b.ref ORDER BY b.ref DESC)
    FILTER (WHERE b.created_at > NOW() - INTERVAL '90 days') AS recent_refs
FROM bookings b
GROUP BY COALESCE(b.tenant_slug, 'bus-tz-pawa'), b.phone, b.passenger_name;

-- ------------------------------------------------------------
-- 6. parcel_quotes
--    Cargo flow: when the agent computes a freight quote, it writes
--    a row here so a follow-up message can reference it by quote_ref
--    when the sender is ready to confirm.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parcel_quotes (
  quote_ref          TEXT PRIMARY KEY,    -- e.g. PQ-2026-AB12CD
  sender_phone       TEXT,
  origin_region      TEXT,
  destination_region TEXT,
  weight_kg          NUMERIC(8,2),
  declared_value_tzs NUMERIC(12,2),
  size_class         TEXT CHECK (size_class IN ('small','medium','large')),
  base_tzs           NUMERIC(12,2),
  per_kg_tzs         NUMERIC(12,2),
  maintenance_pct    NUMERIC(5,2),
  total_tzs          NUMERIC(12,2),
  insurance_tzs      NUMERIC(12,2),       -- 80% of declared value
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','converted','expired','cancelled')),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parcel_quotes_phone
  ON parcel_quotes (sender_phone, created_at DESC);

-- ------------------------------------------------------------
-- 7. SMS/WhatsApp send log (so the agent can answer
--    "did the SMS go through?" without hitting Africa's Talking again)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_log (
  id           BIGSERIAL PRIMARY KEY,
  channel      TEXT NOT NULL CHECK (channel IN ('sms','whatsapp')),
  to_phone     TEXT NOT NULL,
  body         TEXT NOT NULL,
  provider     TEXT,                       -- 'africastalking' | 'twilio' | ...
  provider_ref TEXT,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','delivered','failed')),
  cost_units   NUMERIC(8,4),
  sent_by      TEXT DEFAULT 'agent',
  related_ref  TEXT,                       -- booking_ref or tracking_code
  raw_response JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_log_phone
  ON message_log (to_phone, created_at DESC);

-- ------------------------------------------------------------
-- 8. Helpful seed: extend nearest_hubs with a few that workflow
--    coverage may have missed.
-- ------------------------------------------------------------
INSERT INTO nearest_hubs (district, hub, alt_hub, notes) VALUES
  ('Pangani','Tanga',NULL,NULL),
  ('Bagamoyo','Dar es Salaam',NULL,NULL),
  ('Kibaha','Dar es Salaam',NULL,NULL),
  ('Korogwe','Tanga',NULL,NULL),
  ('Karatu','Arusha City',NULL,NULL),
  ('Bunda','Musoma',NULL,NULL),
  ('Magu','Mwanza',NULL,NULL),
  ('Sengerema','Mwanza',NULL,NULL),
  ('Misungwi','Mwanza',NULL,NULL)
ON CONFLICT (district) DO NOTHING;

-- ------------------------------------------------------------
-- 9. Convenience: a function the agent can call to mint booking
--    refs without round-tripping. Returns PAWA-YYYY-XXXXXX.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mint_booking_ref()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out_ref  TEXT;
  i        INT;
BEGIN
  LOOP
    out_ref := 'PAWA-' || EXTRACT(YEAR FROM NOW())::TEXT || '-';
    FOR i IN 1..6 LOOP
      out_ref := out_ref || SUBSTR(alphabet,
                                    1 + FLOOR(RANDOM() * LENGTH(alphabet))::INT,
                                    1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE ref = out_ref);
  END LOOP;
  RETURN out_ref;
END $$;

-- ------------------------------------------------------------
-- 10. Convenience: same for parcel quotes (PQ-YYYY-XXXXXX).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mint_quote_ref()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out_ref  TEXT;
  i        INT;
BEGIN
  LOOP
    out_ref := 'PQ-' || EXTRACT(YEAR FROM NOW())::TEXT || '-';
    FOR i IN 1..6 LOOP
      out_ref := out_ref || SUBSTR(alphabet,
                                    1 + FLOOR(RANDOM() * LENGTH(alphabet))::INT,
                                    1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM parcel_quotes WHERE quote_ref = out_ref);
  END LOOP;
  RETURN out_ref;
END $$;

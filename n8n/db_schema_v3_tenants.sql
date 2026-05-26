-- ============================================================
-- BUS TZ PAWA — n8n booking DB tenancy migration
-- Run AFTER db_schema.sql + db_schema_v2.sql.
-- Idempotent.
--
-- The n8n booking DB is separate from the website Supabase project;
-- the system of record for tenant identity is the website DB. Here we
-- only need a "tenant_id" column on each booking table so the agent
-- tools can filter their queries. Stored as TEXT (the tenant slug)
-- to avoid cross-DB FK headaches.
-- ============================================================

\set DEMO_SLUG 'bus-tz-pawa'

DO $$
DECLARE
  t text;
  ticketing_tables text[] := array[
    'routes',
    'buses',
    'trips',
    'seats',
    'bookings',
    'payments',
    'complaints',
    'service_gaps',
    'scheduled_reminders',
    'manager_actions',
    'agent_actions_log',
    'message_log',
    'parcel_quotes'
  ];
BEGIN
  FOREACH t IN ARRAY ticketing_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=t
    ) THEN
      EXECUTE format($f$
        ALTER TABLE public.%I
        ADD COLUMN IF NOT EXISTS tenant_slug TEXT NOT NULL DEFAULT 'bus-tz-pawa'
      $f$, t);

      EXECUTE format($f$
        CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_slug)
      $f$, 'idx_'||t||'_tenant_slug', t);

      RAISE NOTICE 'tenant_slug added to public.%', t;
    END IF;
  END LOOP;
END $$;

-- The agent tools (n8n workflow 01b_extended_tools.json and the
-- original 01_vapi_tools.json) need to be updated in a follow-up
-- pass to read $env.TENANT_SLUG (or the per-call tenant_slug variable
-- value forwarded by VAPI) and add `WHERE tenant_slug = $X` to every
-- query. See SLICE_2_RUNBOOK.md "Updating tool workflows".

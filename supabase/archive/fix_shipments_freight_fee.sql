-- ============================================================================
-- Fix: restore product_freight_fee on shipments (idempotent).
--
-- Symptom: admin approval failed with
--   "Could not find the 'product_freight_fee' column of 'shipments' in the
--    schema cache"
-- meaning the live DB is behind schema_master.sql (which defines this column
-- at line 276). Safe to run multiple times.
-- ============================================================================

alter table public.shipments
  add column if not exists product_freight_fee numeric(14,2) not null default 0;

-- Helpful indexes (also idempotent, mirror schema_master).
create index if not exists shipments_freight_fee_idx
  on public.shipments (product_freight_fee)
  where product_freight_fee > 0;

create index if not exists shipments_status_freight_fee_idx
  on public.shipments (status, product_freight_fee);

-- Tell PostgREST to refresh its schema cache so the column becomes
-- queryable immediately (otherwise the API may keep returning the same error
-- for ~10 minutes until the cache TTL expires).
notify pgrst, 'reload schema';

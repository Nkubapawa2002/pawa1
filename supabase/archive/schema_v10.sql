-- =====================================================================
-- Pawa Bus Cargo — Schema v10: Price-Agreement Flow
-- Adds:
--   1. product_size_category  — small / medium / large
--   2. product_suggested_fee  — system-calculated estimate shown to agent
--   3. product_freight_fee    — final transport fee agreed by agent
--   4. Expands shipments.status check to include:
--        'Awaiting Price', 'Collected', 'Needs Revision'
-- Run in Supabase SQL Editor (safe to re-run — all use IF NOT EXISTS / DO blocks).
-- =====================================================================

-- -----------------------------------------------------------------------
-- 1. Add product_size_category
-- -----------------------------------------------------------------------
alter table public.shipments
  add column if not exists product_size_category text
  check (product_size_category in ('small','medium','large'));

-- -----------------------------------------------------------------------
-- 2. Add product_suggested_fee  (system estimate, filled by sender's form)
-- -----------------------------------------------------------------------
alter table public.shipments
  add column if not exists product_suggested_fee numeric(14,2) not null default 0;

-- -----------------------------------------------------------------------
-- 3. Add product_freight_fee  (final price confirmed by agent)
-- -----------------------------------------------------------------------
alter table public.shipments
  add column if not exists product_freight_fee numeric(14,2) not null default 0;

-- -----------------------------------------------------------------------
-- 4. Expand the status check constraint
--    PostgreSQL requires dropping the old constraint before recreating it.
-- -----------------------------------------------------------------------
do $$
begin
  -- Drop the existing check constraint (name may vary — try both)
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'shipments'
      and constraint_type = 'CHECK'
      and constraint_name = 'shipments_status_check'
  ) then
    alter table public.shipments drop constraint shipments_status_check;
  end if;

  -- Also try the pattern Postgres auto-generates
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'shipments'
      and c.contype = 'c'
      and c.conname like '%status%'
  ) then
    execute (
      select 'alter table public.shipments drop constraint ' || quote_ident(c.conname)
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'shipments'
        and c.contype = 'c'
        and c.conname like '%status%'
      limit 1
    );
  end if;
end $$;

alter table public.shipments
  add constraint shipments_status_check
  check (status in (
    'Awaiting Price',
    'Needs Revision',
    'Registered',
    'Collected',
    'Picked Up',
    'In Transit',
    'Arrived',
    'Delivered'
  ));

-- -----------------------------------------------------------------------
-- 5. Update default status to 'Awaiting Price' for new inserts
-- -----------------------------------------------------------------------
alter table public.shipments
  alter column status set default 'Awaiting Price';

-- -----------------------------------------------------------------------
-- 6. Index on the new fee columns (useful for accounting queries)
-- -----------------------------------------------------------------------
create index if not exists shipments_freight_fee_idx
  on public.shipments (product_freight_fee)
  where product_freight_fee > 0;

create index if not exists shipments_status_freight_idx
  on public.shipments (status, product_freight_fee);

-- -----------------------------------------------------------------------
-- 7. Realtime: ensure shipments is published so the sender's price panel
--    receives live updates when the agent confirms the price.
-- -----------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'shipments'
  ) then
    alter publication supabase_realtime add table public.shipments;
  end if;
end $$;

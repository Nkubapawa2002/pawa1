-- =====================================================================
-- BUS TZ PAWA — Multi-tenant migration (data tables)
-- Run AFTER tenants_schema.sql.
--
-- Phase 1 (this file, default ON):
--   • Adds tenant_id UUID FK to every data table.
--   • Backfills existing rows with the demo tenant id.
--   • Makes tenant_id NOT NULL with a default of the demo tenant so
--     legacy clients keep working until they're updated to set it.
--   • Indexes tenant_id for scan performance.
--
-- Phase 2 (commented at the bottom, opt-in):
--   • Tightens RLS so each row is only visible to members of its tenant.
--   • Run only AFTER updating browser code to pass tenant_id on every
--     insert. Until then leave Phase 2 off — the open RLS in earlier
--     migrations stays in force.
--
-- Idempotent.
-- =====================================================================

\set DEMO_TENANT '00000000-0000-0000-0000-000000000001'

-- ---------------------------------------------------------------------
-- Helper: add tenant_id to a table with backfill, NOT NULL, FK, index.
-- A DO block per table because plain ALTER TABLE doesn't accept the
-- "skip if column exists" semantics inline.
-- ---------------------------------------------------------------------
do $migration$
declare
  t text;
  tenant_tables text[] := array[
    -- Cargo / website domain
    'shipments',
    'shipment_messages',
    'buses',
    'agents',
    'agent_applications',
    'agent_reviews',
    'call_requests',
    'cash_retargets',
    'bookings',
    'payments',
    'payment_callbacks',
    'org_expenses',
    'tax_rates',
    'meet_rooms',
    'live_locations',
    'ride_requests',
    'ride_drivers',
    'ride_messages',
    'drivers_online'
  ];
begin
  foreach t in array tenant_tables loop
    -- Only operate if the table actually exists in this DB (some are
    -- created by optional schemas like rides_schema.sql).
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then

      -- 1. Add column with default = demo tenant id
      execute format($f$
        alter table public.%I
        add column if not exists tenant_id uuid
          not null default '00000000-0000-0000-0000-000000000001'
          references public.tenants(id) on delete restrict
      $f$, t);

      -- 2. Index
      execute format($f$
        create index if not exists %I on public.%I (tenant_id)
      $f$, 'idx_'||t||'_tenant', t);

      raise notice 'tenant_id added to public.%', t;
    else
      raise notice 'skipping % (not present)', t;
    end if;
  end loop;
end $migration$;

-- ---------------------------------------------------------------------
-- Drop the demo-tenant default once everything is backfilled, so future
-- inserts MUST specify tenant_id explicitly. Comment this out if you
-- want a longer transitional period.
-- ---------------------------------------------------------------------
do $defaults$
declare t text; tenant_tables text[] := array[
  'shipments','shipment_messages','buses','agents',
  'agent_applications','agent_reviews','call_requests','cash_retargets',
  'bookings','payments','payment_callbacks','org_expenses','tax_rates',
  'meet_rooms','live_locations','ride_requests','ride_drivers',
  'ride_messages','drivers_online'
];
begin
  foreach t in array tenant_tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=t and column_name='tenant_id'
    ) then
      -- Keep default for now (Phase 1) so old clients still work.
      -- After clients are updated, run:
      --   alter table public.<t> alter column tenant_id drop default;
      null;
    end if;
  end loop;
end $defaults$;

-- ---------------------------------------------------------------------
-- Composite indexes that pair tenant_id with the most-queried column.
-- ---------------------------------------------------------------------
do $idx$
begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='shipments') then
    create index if not exists idx_shipments_tenant_status
      on public.shipments (tenant_id, status);
    create index if not exists idx_shipments_tenant_created
      on public.shipments (tenant_id, tracking_code);
  end if;

  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='bookings') then
    create index if not exists idx_bookings_tenant_status
      on public.bookings (tenant_id, status);
  end if;

  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='call_requests') then
    create index if not exists idx_call_requests_tenant_status
      on public.call_requests (tenant_id, status, requested_at);
  end if;

  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='agents') then
    create index if not exists idx_agents_tenant_region
      on public.agents (tenant_id, region);
  end if;
end $idx$;

-- =====================================================================
-- PHASE 2 (opt-in) — tighten RLS so each tenant only sees its own rows.
-- Uncomment the block below and run separately after the website code
-- has been updated to pass tenant_id on writes and filter on reads.
-- =====================================================================
--
-- do $rls$
-- declare
--   t text;
--   tenant_tables text[] := array[
--     'shipments','shipment_messages','buses','agents',
--     'agent_applications','agent_reviews','call_requests','cash_retargets',
--     'bookings','payments','payment_callbacks','org_expenses','tax_rates',
--     'meet_rooms','live_locations','ride_requests','ride_drivers',
--     'ride_messages','drivers_online'
--   ];
-- begin
--   foreach t in array tenant_tables loop
--     if not exists (select 1 from information_schema.tables
--                    where table_schema='public' and table_name=t) then
--       continue;
--     end if;
--
--     execute format('alter table public.%I enable row level security', t);
--
--     execute format($p$
--       drop policy if exists "tenant scoped read" on public.%I;
--       create policy "tenant scoped read" on public.%I for select
--       to authenticated, anon
--       using (
--         tenant_id in (select public.current_user_tenant_ids())
--         or public.is_super_admin()
--       );
--     $p$, t, t);
--
--     execute format($p$
--       drop policy if exists "tenant scoped write" on public.%I;
--       create policy "tenant scoped write" on public.%I for all
--       to authenticated
--       using (
--         tenant_id in (select public.current_user_tenant_ids())
--         or public.is_super_admin()
--       )
--       with check (
--         tenant_id in (select public.current_user_tenant_ids())
--         or public.is_super_admin()
--       );
--     $p$, t, t);
--
--     raise notice 'RLS tenant policies applied to public.%', t;
--   end loop;
-- end $rls$;

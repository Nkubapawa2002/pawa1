-- ============================================================================
-- FIX: Add tenant_id to all data tables
-- Run this in your Supabase SQL Editor to fix the
-- "Could not find the 'tenant_id' column" error.
-- Idempotent — safe to run multiple times.
-- ============================================================================

-- Step 1: Ensure demo tenant exists (required for FK default)
insert into public.tenants (id, slug, display_name, legal_name, contact_email, status, approved_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'bus-tz-pawa','Bus TZ PAWA','Bus TZ PAWA Limited','pawa4761@gmail.com','active',now()
) on conflict (id) do nothing;

-- Step 2: Add tenant_id to every data table (skips if column already exists)
do $tenant_cols$
declare
  t text;
  tenant_tables text[] := array[
    'buses','agents','agent_applications','agent_reviews',
    'shipments','shipment_messages',
    'bookings','payments','payment_callbacks',
    'call_requests','cash_retargets',
    'org_expenses','tax_rates',
    'meet_rooms','live_locations',
    'ride_requests','ride_drivers','ride_messages','drivers_online'
  ];
begin
  foreach t in array tenant_tables loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise notice 'skipping % (table not present)', t;
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'tenant_id'
    ) then
      execute format($f$
        alter table public.%I
        add column tenant_id uuid
          not null default '00000000-0000-0000-0000-000000000001'
          references public.tenants(id) on delete restrict
      $f$, t);
      raise notice 'tenant_id added to %', t;
    else
      raise notice 'tenant_id already exists on %', t;
    end if;

    execute format($f$
      create index if not exists %I on public.%I (tenant_id)
    $f$, 'idx_' || t || '_tenant', t);
  end loop;
end $tenant_cols$;

-- Step 3: Composite indexes
do $cidx$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='shipments' and column_name='tenant_id') then
    create index if not exists idx_shipments_tenant_status   on public.shipments (tenant_id, status);
    create index if not exists idx_shipments_tenant_tracking on public.shipments (tenant_id, tracking_code);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bookings' and column_name='tenant_id') then
    create index if not exists idx_bookings_tenant_status    on public.bookings  (tenant_id, status);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='agents' and column_name='tenant_id') then
    create index if not exists idx_agents_tenant_region      on public.agents    (tenant_id, region);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='call_requests' and column_name='tenant_id') then
    create index if not exists idx_call_requests_tenant_status on public.call_requests (tenant_id, status, requested_at);
  end if;
end $cidx$;

-- Step 4: Tenant SaaS write policies (allow company owners/admins to manage their data)

-- BUSES
drop policy if exists "buses tenant write" on public.buses;
create policy "buses tenant write" on public.buses
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- AGENTS
drop policy if exists "agents tenant write" on public.agents;
create policy "agents tenant write" on public.agents
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- AGENT APPLICATIONS
drop policy if exists "applications read tenant" on public.agent_applications;
create policy "applications read tenant" on public.agent_applications
  for select to authenticated
  using (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

drop policy if exists "applications update tenant" on public.agent_applications;
create policy "applications update tenant" on public.agent_applications
  for update to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- SHIPMENTS
drop policy if exists "shipments tenant write" on public.shipments;
create policy "shipments tenant write" on public.shipments
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  )
  with check (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

-- ORG EXPENSES
drop policy if exists "org_expenses tenant write" on public.org_expenses;
create policy "org_expenses tenant write" on public.org_expenses
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- ============================================================================
-- Done. Reload your browser and refresh the Supabase schema cache if needed:
-- Go to Supabase Dashboard → Database → Schema → click "Reload schema"
-- ============================================================================

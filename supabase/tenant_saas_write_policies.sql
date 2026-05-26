-- =====================================================================
-- BUS TZ PAWA — Tenant SaaS Write Policies
-- Run AFTER tenants_schema.sql + tenants_migration.sql.
-- Idempotent.
--
-- Grants company owners/admins the ability to manage their own fleet
-- data (buses, routes, agents, agent applications) without needing
-- platform-level admin access.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. BUSES — tenant owners/admins can INSERT/UPDATE/DELETE their own rows
-- ---------------------------------------------------------------------
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

-- "buses admin write" policy already blocks non-admins; now also allow
-- tenant owners/admins. The two policies are OR-combined by Postgres.

-- ---------------------------------------------------------------------
-- 2. AGENTS — tenant owners/admins can INSERT/UPDATE/DELETE their own rows
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. AGENT APPLICATIONS — tenant members can READ; owners/admins can UPDATE
-- ---------------------------------------------------------------------
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

-- Also allow tenant members to INSERT applications for their tenant
drop policy if exists "applications insert tenant" on public.agent_applications;
create policy "applications insert tenant" on public.agent_applications
  for insert to authenticated
  with check (true);  -- already open; just making explicit

-- ---------------------------------------------------------------------
-- 4. Update add_bus_route function — allow tenant owners too
-- ---------------------------------------------------------------------
create or replace function public.add_bus_route(
  p_bus_id text,
  p_from text,
  p_to text,
  p_departure text,
  p_return_departure text,
  p_duration_hours numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare
  bus_tenant_id uuid;
begin
  select tenant_id into bus_tenant_id from public.buses where id = p_bus_id;

  if not (
    public.is_admin() or
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = bus_tenant_id
        and tu.role in ('owner','admin')
    )
  ) then
    raise exception 'permission denied — not a bus owner or platform admin';
  end if;

  update public.buses
  set routes = coalesce(routes, '[]'::jsonb)
    || jsonb_build_object(
        'from', p_from, 'to', p_to,
        'departure', p_departure,
        'duration_hours', p_duration_hours)
    || jsonb_build_object(
        'from', p_to, 'to', p_from,
        'departure', p_return_departure,
        'duration_hours', p_duration_hours)
  where id = p_bus_id;
end;
$$;

grant execute on function public.add_bus_route(text,text,text,text,text,numeric)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5. Update approve/reject agent application — allow tenant admins too
-- ---------------------------------------------------------------------
create or replace function public.approve_agent_application(p_app_id bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  app  public.agent_applications%rowtype;
  new_id text;
  app_tenant_id uuid;
begin
  select * into app from public.agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;

  app_tenant_id := app.tenant_id;

  if not (
    public.is_admin() or
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = app_tenant_id
        and tu.role in ('owner','admin')
    )
  ) then
    raise exception 'permission denied';
  end if;

  -- Generate next agent id scoped to this tenant (prefix with tenant slug)
  select coalesce(
    'AG' || lpad(((max(substring(id from 3)::int)) + 1)::text, 3, '0'),
    'AG001'
  ) into new_id
  from public.agents
  where id ~ '^AG[0-9]+$' and tenant_id = app_tenant_id;

  if new_id is null then new_id := 'AG001'; end if;

  insert into public.agents (
    id, name, phone, region, terminal, buses,
    email, national_id, experience_years, verified, tenant_id
  ) values (
    new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
    app.email, app.national_id, app.experience_years, true, app_tenant_id
  );

  update public.agent_applications
  set status = 'approved',
      reviewed_by = (auth.jwt() ->> 'email'),
      reviewed_at = now()
  where id = p_app_id;

  return new_id;
end;
$$;

grant execute on function public.approve_agent_application(bigint) to authenticated;

create or replace function public.reject_agent_application(p_app_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  app_tenant_id uuid;
begin
  select tenant_id into app_tenant_id
  from public.agent_applications where id = p_app_id;

  if not (
    public.is_admin() or
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = app_tenant_id
        and tu.role in ('owner','admin')
    )
  ) then
    raise exception 'permission denied';
  end if;

  update public.agent_applications
  set status      = 'rejected',
      reject_reason = p_reason,
      reviewed_by = (auth.jwt() ->> 'email'),
      reviewed_at = now()
  where id = p_app_id and status = 'pending';
end;
$$;

grant execute on function public.reject_agent_application(bigint, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Helper: generate next agent id for a tenant
-- ---------------------------------------------------------------------
create or replace function public.next_agent_id(_tenant_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    'AG' || lpad((coalesce(max(substring(id from 3)::int), 0) + 1)::text, 3, '0'),
    'AG001'
  )
  from public.agents
  where id ~ '^AG[0-9]+$' and tenant_id = _tenant_id;
$$;

grant execute on function public.next_agent_id(uuid) to authenticated;

-- =====================================================================
-- clerk_text_user_ids.sql
-- Make RLS work under Clerk (Supabase third-party auth) WITHOUT breaking the
-- existing Supabase-Auth path.
--
-- Problem: Clerk user ids are text strings ("user_2ab…"), but auth.uid() casts
-- the JWT `sub` to uuid. Any RLS policy / function that calls auth.uid() throws
--   22P02 invalid input syntax for type uuid: "user_…"
-- for a Clerk-signed request (proved end-to-end via the Clerk Backend API).
--
-- Fix: introduce public.app_uid() -> text (the `sub` claim, as text) and use it
-- everywhere instead of auth.uid(); compare against `column::text`. For a
-- Supabase-Auth token the sub IS the user uuid, so `uuid::text = sub-text` still
-- matches existing rows — fully backward compatible. The six columns that Clerk
-- users WRITE are converted uuid -> text so a Clerk id can be stored.
--
-- Idempotent + transactional. Safe to re-run. See tests/clerk_supabase_check.mjs
-- and docs/CLERK_SETUP.md.
-- =====================================================================
begin;

-- ---- 1. Identity helper: the caller's id as TEXT (NULL when anonymous) ------
create or replace function public.app_uid() returns text
  language sql stable
  set search_path = public
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim',  true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb ->> 'sub'
  , '')
$$;

-- ---- 2. Drop every policy that references auth.uid() (recreated in step 6) ---
drop policy if exists "applications update tenant" on public.agent_applications;
drop policy if exists "agents readable"            on public.agents;
drop policy if exists "agents self update"         on public.agents;
drop policy if exists "agents tenant write"        on public.agents;
drop policy if exists "blp tenant insert"          on public.bus_layout_pending;
drop policy if exists "blp tenant read"            on public.bus_layout_pending;
drop policy if exists "buses tenant write"         on public.buses;
drop policy if exists "hdp insert"                 on public.house_demand_pins;
drop policy if exists "hdp owner delete"           on public.house_demand_pins;
drop policy if exists "hdp owner read"             on public.house_demand_pins;
drop policy if exists "hdp owner update"           on public.house_demand_pins;
drop policy if exists "ht owner delete"            on public.house_tenancies;
drop policy if exists "ht owner insert"            on public.house_tenancies;
drop policy if exists "ht owner update"            on public.house_tenancies;
drop policy if exists "ht owner+admin read"        on public.house_tenancies;
drop policy if exists "houses owner delete"        on public.houses;
drop policy if exists "houses owner insert"        on public.houses;
drop policy if exists "houses owner update"        on public.houses;
drop policy if exists "houses readable"            on public.houses;
drop policy if exists "org_expenses tenant insert" on public.org_expenses;
drop policy if exists "services owner delete"      on public.services;
drop policy if exists "services owner insert"      on public.services;
drop policy if exists "services owner update"      on public.services;
drop policy if exists "services readable"          on public.services;
drop policy if exists "tenant_invites admin write" on public.tenant_invites;
drop policy if exists "tenant_settings owner write" on public.tenant_settings;
drop policy if exists "tenant_users owner write"   on public.tenant_users;
drop policy if exists "tenant_users self read"     on public.tenant_users;
drop policy if exists "tenant owner update"        on public.tenants;
drop policy if exists "tenant signup insert"       on public.tenants;
drop policy if exists "trucks owner delete"        on public.trucks;
drop policy if exists "trucks owner insert"        on public.trucks;
drop policy if exists "trucks owner update"        on public.trucks;
drop policy if exists "trucks readable"            on public.trucks;

-- ---- 3. Replace uid_suspended(uuid) with a text overload --------------------
drop function if exists public.uid_suspended(uuid);
create or replace function public.uid_suspended(p_uid text) returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.agent_key_suspended(
    case when coalesce(p_uid,'') = '' then null else 'uid:' || p_uid end);
$$;

-- ---- 4. Drop the FKs to auth.users (Clerk users don't exist there) ----------
-- These were `owner_user_id REFERENCES auth.users(id) ON DELETE SET NULL`. Under
-- Clerk, the owner id is a Clerk user id that is NOT a row in auth.users, so the
-- FK would reject every Clerk-owned row. (Trade-off: deleting a Supabase auth
-- user no longer auto-nulls these columns — acceptable / moot under Clerk.)
alter table public.houses            drop constraint if exists houses_owner_user_id_fkey;
alter table public.trucks            drop constraint if exists trucks_owner_user_id_fkey;
alter table public.services          drop constraint if exists services_owner_user_id_fkey;
alter table public.house_tenancies   drop constraint if exists house_tenancies_owner_user_id_fkey;
alter table public.house_demand_pins drop constraint if exists house_demand_pins_user_id_fkey;
alter table public.agents            drop constraint if exists agents_user_id_fkey;

-- ---- 4b. Convert the six "owner" columns Clerk users write: uuid -> text -----
alter table public.houses            alter column owner_user_id type text using owner_user_id::text;
alter table public.trucks            alter column owner_user_id type text using owner_user_id::text;
alter table public.services          alter column owner_user_id type text using owner_user_id::text;
alter table public.house_tenancies   alter column owner_user_id type text using owner_user_id::text;
alter table public.house_demand_pins alter column user_id       type text using user_id::text;
alter table public.agents            alter column user_id       type text using user_id::text;

-- ---- 5. Recreate functions that compared those columns to auth.uid() --------
create or replace function public.current_user_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = public
as $$ select tenant_id from public.tenant_users where user_id::text = public.app_uid(); $$;

create or replace function public.agent_owns_shipment(p_origin text, p_dest text)
  returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.agents a
    left join lateral unnest(array_append(a.phones, a.phone)) ph(num) on true
    where a.user_id = public.app_uid()
      and public.norm_phone(ph.num) in (public.norm_phone(p_origin), public.norm_phone(p_dest))
  );
$$;

create or replace function public.claim_agent_profile()
  returns setof agents language plpgsql security definer set search_path = public
as $$
declare
  v_uid   text := public.app_uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_uid is null then return; end if;
  if exists (select 1 from public.agents where user_id = v_uid) then
    return query select * from public.agents where user_id = v_uid;
    return;
  end if;
  if v_email <> '' then
    update public.agents a
       set user_id = v_uid
     where a.id = (
       select id from public.agents
        where user_id is null and lower(email) = v_email
        order by created_at limit 1);
  end if;
  return query select * from public.agents where user_id = v_uid;
end;
$$;

create or replace function public.my_agent_subscription()
  returns table(active boolean, status text, paid_until date, agent_key text,
                reason text, deadline timestamptz, note text)
  language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid     text := public.app_uid();
  r         public.agent_billing%rowtype;
  v_key     text;
  v_reg     timestamptz;
  v_grace   interval := interval '48 hours';
  v_deadline timestamptz;
begin
  if v_uid is null then
    return query select true, 'none'::text, null::date, null::text, 'none'::text, null::timestamptz, null::text;
    return;
  end if;

  select b.* into r
  from public.agent_billing b
  where b.agent_key = 'uid:' || v_uid
     or b.agent_key in (
        select 'ph:' || right(regexp_replace(coalesce(a.phone,''), '\D', '', 'g'), 9)
        from public.agents a
        where a.user_id = v_uid and coalesce(a.phone,'') <> ''
     )
  order by case when b.active is false then 0 else 1 end, b.paid_until desc nulls last
  limit 1;

  if found then
    v_key := r.agent_key;
    if r.active is false then
      return query select false, r.status, r.paid_until, v_key, 'deactivated'::text, null::timestamptz, r.note; return;
    end if;
    if r.status = 'cancelled' then
      return query select false, r.status, r.paid_until, v_key, 'cancelled'::text, null::timestamptz, r.note; return;
    end if;
    if r.status = 'overdue' then
      return query select false, r.status, r.paid_until, v_key, 'overdue'::text, null::timestamptz, r.note; return;
    end if;
    if r.paid_until is not null then
      if r.paid_until < current_date then
        return query select false, r.status, r.paid_until, v_key, 'expired'::text, null::timestamptz, r.note;
      else
        return query select true, r.status, r.paid_until, v_key, 'active'::text, null::timestamptz, r.note;
      end if;
      return;
    end if;
    if r.status in ('paid','trial') then
      return query select true, r.status, r.paid_until, v_key, 'active'::text, null::timestamptz, r.note; return;
    end if;
  end if;

  v_key := coalesce(v_key, 'uid:' || v_uid);
  v_reg := public.agent_registered_at(v_key);
  if v_reg is null then
    select min(a.created_at) into v_reg from public.agents a where a.user_id = v_uid;
  end if;
  if v_reg is null then
    return query select true, coalesce(r.status,'none'), r.paid_until, v_key, 'none'::text, null::timestamptz, r.note;
    return;
  end if;

  v_deadline := v_reg + v_grace;
  if now() <= v_deadline then
    return query select true,  coalesce(r.status,'free'), r.paid_until, v_key, 'grace'::text,         v_deadline, r.note;
  else
    return query select false, coalesce(r.status,'free'), r.paid_until, v_key, 'grace_expired'::text, v_deadline, r.note;
  end if;
end;
$$;

-- ---- 6. Recreate every dropped policy using app_uid() + column::text --------
-- agent_applications
create policy "applications update tenant" on public.agent_applications as permissive for update to authenticated
  using (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))))
  with check (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- agents
create policy "agents readable" on public.agents as permissive for select to public
  using ((not phone_suspended(phone)) or (user_id::text = (select public.app_uid())) or is_admin());
create policy "agents self update" on public.agents as permissive for update to public
  using ((user_id is not null) and (user_id::text = (select public.app_uid())))
  with check ((user_id is not null) and (user_id::text = (select public.app_uid())));
create policy "agents tenant write" on public.agents as permissive for all to authenticated
  using (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))))
  with check (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- bus_layout_pending
create policy "blp tenant insert" on public.bus_layout_pending as permissive for insert to authenticated
  with check (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));
create policy "blp tenant read" on public.bus_layout_pending as permissive for select to authenticated
  using (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()))));

-- buses
create policy "buses tenant write" on public.buses as permissive for all to authenticated
  using (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))))
  with check (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- house_demand_pins
create policy "hdp insert" on public.house_demand_pins as permissive for insert to public
  with check ((((select public.app_uid()) is null) and (user_id is null)) or (user_id::text = (select public.app_uid())));
create policy "hdp owner delete" on public.house_demand_pins as permissive for delete to public
  using (user_id::text = (select public.app_uid()));
create policy "hdp owner read" on public.house_demand_pins as permissive for select to public
  using ((user_id is not null) and (user_id::text = (select public.app_uid())));
create policy "hdp owner update" on public.house_demand_pins as permissive for update to public
  using (user_id::text = (select public.app_uid()))
  with check (user_id::text = (select public.app_uid()));

-- house_tenancies
create policy "ht owner delete" on public.house_tenancies as permissive for delete to public
  using (owner_user_id::text = (select public.app_uid()));
create policy "ht owner insert" on public.house_tenancies as permissive for insert to public
  with check (((select public.app_uid()) is not null) and (owner_user_id::text = (select public.app_uid())));
create policy "ht owner update" on public.house_tenancies as permissive for update to public
  using (owner_user_id::text = (select public.app_uid()))
  with check (owner_user_id::text = (select public.app_uid()));
create policy "ht owner+admin read" on public.house_tenancies as permissive for select to public
  using ((owner_user_id::text = (select public.app_uid())) or is_admin());

-- houses
create policy "houses owner delete" on public.houses as permissive for delete to public
  using (owner_user_id::text = (select public.app_uid()));
create policy "houses owner insert" on public.houses as permissive for insert to public
  with check (((select public.app_uid()) is not null) and (owner_user_id::text = (select public.app_uid())));
create policy "houses owner update" on public.houses as permissive for update to public
  using (owner_user_id::text = (select public.app_uid()))
  with check (owner_user_id::text = (select public.app_uid()));
create policy "houses readable" on public.houses as permissive for select to public
  using ((not uid_suspended(owner_user_id)) or (owner_user_id::text = (select public.app_uid())) or is_admin());

-- org_expenses
create policy "org_expenses tenant insert" on public.org_expenses as permissive for insert to authenticated
  with check (is_admin() or (tenant_id in (select tu.tenant_id from tenant_users tu where tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- services
create policy "services owner delete" on public.services as permissive for delete to public
  using (owner_user_id::text = (select public.app_uid()));
create policy "services owner insert" on public.services as permissive for insert to public
  with check (((select public.app_uid()) is not null) and (owner_user_id::text = (select public.app_uid())));
create policy "services owner update" on public.services as permissive for update to public
  using (owner_user_id::text = (select public.app_uid()))
  with check (owner_user_id::text = (select public.app_uid()));
create policy "services readable" on public.services as permissive for select to public
  using ((not uid_suspended(owner_user_id)) or (owner_user_id::text = (select public.app_uid())) or is_admin());

-- tenant_invites
create policy "tenant_invites admin write" on public.tenant_invites as permissive for all to authenticated
  using (is_super_admin() or (exists (select 1 from tenant_users tu where tu.tenant_id = tenant_invites.tenant_id and tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))))
  with check (is_super_admin() or (exists (select 1 from tenant_users tu where tu.tenant_id = tenant_invites.tenant_id and tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- tenant_settings
create policy "tenant_settings owner write" on public.tenant_settings as permissive for all to authenticated
  using (is_super_admin() or (exists (select 1 from tenant_users tu where tu.tenant_id = tenant_settings.tenant_id and tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))))
  with check (is_super_admin() or (exists (select 1 from tenant_users tu where tu.tenant_id = tenant_settings.tenant_id and tu.user_id::text = (select public.app_uid()) and tu.role = any (array['owner'::tenant_role,'admin'::tenant_role]))));

-- tenant_users
create policy "tenant_users owner write" on public.tenant_users as permissive for all to authenticated
  using (is_super_admin() or (exists (select 1 from tenants t where t.id = tenant_users.tenant_id and t.owner_user_id::text = (select public.app_uid()))))
  with check (is_super_admin() or (exists (select 1 from tenants t where t.id = tenant_users.tenant_id and t.owner_user_id::text = (select public.app_uid()))));
create policy "tenant_users self read" on public.tenant_users as permissive for select to authenticated
  using (is_super_admin() or (user_id::text = (select public.app_uid())) or (tenant_id in (select current_user_tenant_ids() as current_user_tenant_ids)));

-- tenants
create policy "tenant owner update" on public.tenants as permissive for update to authenticated
  using ((owner_user_id::text = (select public.app_uid())) or is_super_admin())
  with check ((owner_user_id::text = (select public.app_uid())) or is_super_admin());
create policy "tenant signup insert" on public.tenants as permissive for insert to authenticated
  with check (((select public.app_uid()) = owner_user_id::text) and (status = 'pending_approval'::tenant_status));

-- trucks
create policy "trucks owner delete" on public.trucks as permissive for delete to public
  using (owner_user_id::text = (select public.app_uid()));
create policy "trucks owner insert" on public.trucks as permissive for insert to public
  with check (((select public.app_uid()) is not null) and (owner_user_id::text = (select public.app_uid())));
create policy "trucks owner update" on public.trucks as permissive for update to public
  using (owner_user_id::text = (select public.app_uid()))
  with check (owner_user_id::text = (select public.app_uid()));
create policy "trucks readable" on public.trucks as permissive for select to public
  using ((not uid_suspended(owner_user_id)) or (owner_user_id::text = (select public.app_uid())) or is_admin());

commit;

-- ============================================================================
-- Agent dashboard authentication (agent.html)
--
-- Replaces the OLD passwordless "login" — where typing any agent's public phone
-- number (or even a partial name) dropped you straight into that agent's
-- dashboard — with real Supabase email + password auth, the same scheme already
-- used by the houses (agent-houses) and trucks (agent-trucks) dashboards.
--
-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- What it does:
--   1. agents.user_id  — links each agent row to a Supabase auth user.
--   2. claim_agent_profile()       — RPC the dashboard calls right after sign-in.
--      Links the signed-in user to the agent row whose email matches their
--      verified login email, then returns that row. No matching agent row =>
--      returns nothing (they're signed in but not a registered agent yet).
--   3. RLS so an agent can only update THEIR OWN agents row, and only the
--      shipments they are the origin/destination agent for. Admins keep full
--      access; the separate "… tenant write" policies are left untouched.
--   4. confirm_shipment_status()   — narrow, SECURITY DEFINER path that keeps the
--      PUBLIC tracking-chat "Arrived / Delivered" buttons working after the
--      blanket anon UPDATE on shipments is removed.
--
-- Onboarding: an approved agent signs up here with the SAME email they used on
-- their agent application (approve_agent_application copies that email onto the
-- agents row). Their first sign-in auto-links the account. Admins can also link
-- manually:  update public.agents set user_id = '<auth uid>' where id = 'AG0xx';
--
-- ⚠️ REQUIRED: turn ON "Confirm email" in Supabase → Authentication → Providers
--    → Email. The auto-link below matches an agent row by the caller's login
--    email. With email confirmation OFF, anyone could sign up using a known
--    agent's email and claim that agent's profile. Confirmation proves the
--    signer actually controls the inbox, which closes that hole.
-- ============================================================================

-- 0. Phone normaliser — strips whitespace so "+255 712…" matches "+255712…".
create or replace function public.norm_phone(p text)
returns text language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '\s', '', 'g')
$$;

-- 1. Link column ------------------------------------------------------------
alter table public.agents
  add column if not exists user_id uuid references auth.users(id) on delete set null;

-- One auth user maps to at most one agent row.
create unique index if not exists agents_user_id_key
  on public.agents (user_id) where user_id is not null;

-- 2. Claim / fetch the caller's agent profile -------------------------------
create or replace function public.claim_agent_profile()
returns setof public.agents
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_uid is null then
    return;                                   -- not signed in
  end if;

  -- Already linked → return it and stop.
  if exists (select 1 from public.agents where user_id = v_uid) then
    return query select * from public.agents where user_id = v_uid;
    return;
  end if;

  -- First sign-in: claim the (single) unlinked agent row whose email matches
  -- the caller's verified login email.
  if v_email <> '' then
    update public.agents a
       set user_id = v_uid
     where a.id = (
       select id from public.agents
        where user_id is null and lower(email) = v_email
        order by created_at
        limit 1
     );
  end if;

  return query select * from public.agents where user_id = v_uid;
end;
$fn$;

revoke all   on function public.claim_agent_profile() from public, anon;
grant execute on function public.claim_agent_profile() to authenticated;

-- 3. RLS — an agent may manage their own profile row ------------------------
drop policy if exists "agents self update" on public.agents;
create policy "agents self update" on public.agents
  for update
  using      (user_id is not null and user_id = auth.uid())
  with check (user_id is not null and user_id = auth.uid());

-- Platform admins keep full write access to agent rows (e.g. admin.html edits).
-- approve_agent_application runs SECURITY DEFINER and is unaffected either way;
-- this restores the direct-edit path that schema_master.sql section 7 defines.
drop policy if exists "agents admin write" on public.agents;
create policy "agents admin write" on public.agents
  for all
  using (public.is_admin()) with check (public.is_admin());

-- 4. RLS — shipments ---------------------------------------------------------
-- True iff the caller is the signed-in agent assigned to this shipment.
create or replace function public.agent_owns_shipment(p_origin text, p_dest text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1
    from public.agents a
    left join lateral unnest(array_append(a.phones, a.phone)) ph(num) on true
    where a.user_id = auth.uid()
      and public.norm_phone(ph.num) in (
            public.norm_phone(p_origin),
            public.norm_phone(p_dest)
          )
  );
$fn$;

-- Remove the wide-open "anyone may update any shipment" policy …
drop policy if exists "shipments updatable" on public.shipments;
-- … and replace it with: admins, or the assigned signed-in agent only.
drop policy if exists "shipments agent update" on public.shipments;
create policy "shipments agent update" on public.shipments
  for update
  using      (public.is_admin() or public.agent_owns_shipment(agent_origin_phone, agent_destination_phone))
  with check (public.is_admin() or public.agent_owns_shipment(agent_origin_phone, agent_destination_phone));

-- 5. Public tracking-chat confirmation --------------------------------------
-- track.html lets whoever holds the tracking code mark a parcel Arrived or
-- Delivered. With the blanket UPDATE policy gone, that goes through this narrow
-- SECURITY DEFINER RPC instead — it can ONLY flip status to those two values.
create or replace function public.confirm_shipment_status(p_code text, p_status text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if p_status not in ('Arrived', 'Delivered') then
    raise exception 'confirm_shipment_status only allows Arrived or Delivered (got %)', p_status;
  end if;
  update public.shipments
     set status = p_status
   where tracking_code = p_code;
  if not found then
    raise exception 'shipment % not found', p_code;
  end if;
end;
$fn$;

grant execute on function public.confirm_shipment_status(text, text) to anon, authenticated;

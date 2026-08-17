-- ============================================================================
-- Agent APPROVAL gate — "live for 7 days, then admin must approve"
-- ----------------------------------------------------------------------------
-- Every newly registered agent goes live IMMEDIATELY, but only for a 7-day
-- preview window. An admin must APPROVE them within those 7 days; if they don't,
-- the account auto-inactivates (listings/profile hidden) until an admin approves
-- it. Approval is a one-time gate, separate from the monthly subscription:
-- once approved, the normal billing rules (paid_until / status) take over.
--
-- This REPLACES the old 48-hour pay-or-pause grace as the new-agent window —
-- there is now a single, clearer initial gate (approve-or-pause).
--
-- SAFE ROLLOUT: every agent who ALREADY exists when this runs is grandfathered
-- in as approved (approved_at backfilled to their earliest registration), so
-- applying this never hides current agents. Only sign-ups AFTER this migration
-- enter the 7-day approval window.
--
-- Depends on: agent_billing.sql, agent_subscription.sql, agent_grace_active.sql
--             (provides agent_registered_at()). Run once. Idempotent.
-- ============================================================================

-- 1. Approval columns
alter table public.agent_billing
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text;

-- 2. Grandfather everyone who already exists ---------------------------------
-- (a) every current agent IDENTITY (uid + phone keys) gets a billing row with
--     approved_at = their earliest registration (fallback: now()).
insert into public.agent_billing (agent_key, approved_at, approved_by)
select ids.key,
       coalesce(public.agent_registered_at(ids.key), now()),
       'grandfathered'
from (
  select distinct 'uid:' || owner_user_id::text as key from public.houses   where owner_user_id is not null
  union select distinct 'uid:' || owner_user_id::text       from public.trucks   where owner_user_id is not null
  union select distinct 'uid:' || owner_user_id::text       from public.services where owner_user_id is not null
  union select distinct 'uid:' || user_id::text             from public.agents   where user_id is not null
  union select distinct 'ph:'  || right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 9)
        from public.agents where coalesce(phone,'') <> ''
) ids
where ids.key not in ('uid:', 'ph:')
on conflict (agent_key) do update
  set approved_at = coalesce(public.agent_billing.approved_at, excluded.approved_at),
      approved_by = coalesce(public.agent_billing.approved_by, excluded.approved_by);

-- (b) any pre-existing billing row still missing approved_at → grandfather it.
update public.agent_billing
   set approved_at = coalesce(approved_at, public.agent_registered_at(agent_key), created_at),
       approved_by = coalesce(approved_by, 'grandfathered')
 where approved_at is null;

-- 3. Suspension predicate — approval gate, THEN billing ----------------------
-- Order:
--   • admin-deactivated / cancelled / overdue        → suspended
--   • NOT approved: live for 7 days from registration, then suspended
--   • approved: suspended once paid_until lapses; otherwise active
create or replace function public.agent_key_suspended(p_key text)
returns boolean language plpgsql stable security definer set search_path = public as $fn$
declare
  r        public.agent_billing%rowtype;
  v_found  boolean;
  v_reg    timestamptz;
  v_window interval := interval '7 days';
begin
  if p_key is null or p_key = '' then return false; end if;

  select * into r from public.agent_billing b where b.agent_key = p_key;
  v_found := found;

  if v_found then
    if r.active is false then return true; end if;                 -- admin deactivated
    if r.status in ('cancelled','overdue') then return true; end if;
  end if;

  -- Approval gate (applies until approved).
  if not (v_found and r.approved_at is not null) then
    v_reg := public.agent_registered_at(p_key);
    if v_reg is null then return false; end if;        -- unknown registration → don't lock out
    return now() > v_reg + v_window;                   -- live 7 days, then pause
  end if;

  -- Approved → normal billing.
  if r.paid_until is not null then
    return r.paid_until < current_date;                -- lapsed?
  end if;
  return false;                                        -- approved, no expiry set → active
end;
$fn$;

-- 4. Agent self-check (adds 'preview' + 'approval_expired' reasons) ----------
drop function if exists public.my_agent_subscription();
create or replace function public.my_agent_subscription()
returns table(active boolean, status text, paid_until date, agent_key text,
              reason text, deadline timestamptz, note text)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid     text := public.app_uid();   -- Clerk-safe identity (sub as text)
  r         public.agent_billing%rowtype;
  v_found   boolean;
  v_key     text;
  v_reg     timestamptz;
  v_window  interval := interval '7 days';
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
  v_found := found;
  v_key   := coalesce(r.agent_key, 'uid:' || v_uid);

  if v_found then
    if r.active is false then
      return query select false, r.status, r.paid_until, v_key, 'deactivated'::text, null::timestamptz, r.note; return;
    end if;
    if r.status = 'cancelled' then
      return query select false, r.status, r.paid_until, v_key, 'cancelled'::text, null::timestamptz, r.note; return;
    end if;
    if r.status = 'overdue' then
      return query select false, r.status, r.paid_until, v_key, 'overdue'::text, null::timestamptz, r.note; return;
    end if;
  end if;

  -- Approval gate.
  if not (v_found and r.approved_at is not null) then
    v_reg := public.agent_registered_at(v_key);
    if v_reg is null then
      select min(a.created_at) into v_reg from public.agents a where a.user_id = v_uid;
    end if;
    if v_reg is null then
      -- Registration unknown → don't lock out (safe).
      return query select true, coalesce(r.status,'none'), r.paid_until, v_key, 'none'::text, null::timestamptz, r.note; return;
    end if;
    v_deadline := v_reg + v_window;
    if now() <= v_deadline then
      return query select true,  coalesce(r.status,'free'), r.paid_until, v_key, 'preview'::text,          v_deadline, r.note;
    else
      return query select false, coalesce(r.status,'free'), r.paid_until, v_key, 'approval_expired'::text, v_deadline, r.note;
    end if;
    return;
  end if;

  -- Approved → billing.
  if r.paid_until is not null then
    if r.paid_until < current_date then
      return query select false, r.status, r.paid_until, v_key, 'expired'::text, null::timestamptz, r.note;
    else
      return query select true,  r.status, r.paid_until, v_key, 'active'::text,  null::timestamptz, r.note;
    end if;
    return;
  end if;
  return query select true, coalesce(r.status,'paid'), r.paid_until, v_key, 'active'::text, null::timestamptz, r.note;
end;
$fn$;

revoke all    on function public.my_agent_subscription() from public, anon;
grant execute on function public.my_agent_subscription() to authenticated;

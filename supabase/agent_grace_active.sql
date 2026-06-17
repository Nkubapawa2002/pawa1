-- ============================================================================
-- Agent activation switch + 48-hour pay-or-pause grace timer
--
-- Extends supabase/agent_subscription.sql with two admin-controlled rules:
--
--   1. EXPLICIT ACTIVATE / DEACTIVATE
--      A new agent_billing.active flag. When an admin deactivates an agent
--      (active = false) their public listings/profile vanish immediately and
--      their dashboard shows a "deactivated by admin — contact admin" notice,
--      regardless of payment status.
--
--   2. 48-HOUR GRACE FROM REGISTRATION
--      Every agent must pay within 48 hours of registering. Until the deadline
--      they stay active (dashboard shows a live countdown demanding payment).
--      Once 48h pass with no paid coverage their account auto-pauses (listings
--      hidden, dashboard shows a paywall) until the admin records a payment.
--
--  ROLLOUT IMPACT: this makes unpaid agents who registered more than 48h ago
--    pause as soon as you run it. To keep specific existing agents active,
--    first set them to status='paid'/'trial' (or record a payment) in the
--    admin "All Agents" tab. Agents you've already enrolled (paid_until in the
--    future) are unaffected.
--
-- Depends on: supabase/agent_billing.sql, supabase/agent_subscription.sql
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ---- 1. Activation flag ----------------------------------------------------
alter table public.agent_billing
  add column if not exists active boolean not null default true;

-- ---- 2. Earliest registration time for an agent identity -------------------
-- agent_key matches the admin tracker's identity strings:
--   "uid:<owner_user_id>"  (house/truck owners, account-linked bus agents)
--   "ph:<last 9 digits>"   (bus agents matched by phone)
-- Returns the EARLIEST created_at across all of that identity's records, so the
-- grace clock starts when they first appeared on the platform.
create or replace function public.agent_registered_at(p_key text)
returns timestamptz language sql stable security definer set search_path = public as $fn$
  select min(c) from (
    select h.created_at as c from public.houses h
      where p_key like 'uid:%' and h.owner_user_id::text = substring(p_key from 5)
    union all
    select tr.created_at from public.trucks tr
      where p_key like 'uid:%' and tr.owner_user_id::text = substring(p_key from 5)
    union all
    select sv.created_at from public.services sv
      where p_key like 'uid:%' and sv.owner_user_id::text = substring(p_key from 5)
    union all
    select a.created_at from public.agents a
      where p_key like 'uid:%' and a.user_id::text = substring(p_key from 5)
    union all
    select a.created_at from public.agents a
      where p_key like 'ph:%'
        and right(regexp_replace(coalesce(a.phone,''), '\D', '', 'g'), 9) = substring(p_key from 4)
  ) t;
$fn$;

-- ---- 3. Suspension predicate (now: deactivation + grace) -------------------
-- Used by the houses/trucks/agents SELECT policies (via uid_suspended /
-- phone_suspended). Order of checks:
--   • explicit admin deactivation       → suspended
--   • cancelled / overdue               → suspended
--   • has paid_until                    → suspended once it lapses
--   • paid / trial with no expiry       → active
--   • otherwise (no paid coverage yet)  → active for 48h after registration,
--                                          then suspended (pay-or-pause)
create or replace function public.agent_key_suspended(p_key text)
returns boolean language plpgsql stable security definer set search_path = public as $fn$
declare
  r       public.agent_billing%rowtype;
  v_reg   timestamptz;
  v_grace interval := interval '48 hours';
begin
  if p_key is null or p_key = '' then return false; end if;

  select * into r from public.agent_billing b where b.agent_key = p_key;
  if found then
    if r.active is false then return true; end if;                 -- deactivated by admin
    if r.status in ('cancelled','overdue') then return true; end if;
    if r.paid_until is not null then
      return r.paid_until < current_date;                          -- lapsed?
    end if;
    if r.status in ('paid','trial') then return false; end if;     -- active, no expiry set
    -- status 'free' with no paid_until → fall through to the grace check
  end if;

  -- No paid coverage → 48-hour grace from registration.
  v_reg := public.agent_registered_at(p_key);
  if v_reg is null then return false; end if;   -- unknown registration → don't suspend (safe)
  return now() > v_reg + v_grace;
end;
$fn$;

-- ---- 4. Agent self-check (richer: reason + grace deadline) -----------------
-- The agent dashboards call this to render the right banner:
--   reason: 'active' | 'grace' | 'grace_expired' | 'deactivated'
--           | 'expired' | 'cancelled' | 'overdue' | 'none'
--   deadline: when the 48h grace ends (only for reason='grace'/'grace_expired')
-- Drop first: this adds columns to the return type, which CREATE OR REPLACE
-- alone can't do (Postgres: "cannot change return type of existing function").
drop function if exists public.my_agent_subscription();
create or replace function public.my_agent_subscription()
returns table(active boolean, status text, paid_until date, agent_key text,
              reason text, deadline timestamptz, note text)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid     uuid := auth.uid();
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

  -- The caller's billing row: by uid key, or by the phone key of any agents
  -- row they own. Prefer a deactivated row, then the latest expiry.
  select b.* into r
  from public.agent_billing b
  where b.agent_key = 'uid:' || v_uid::text
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
    -- status 'free', no expiry → fall through to grace
  end if;

  v_key := coalesce(v_key, 'uid:' || v_uid::text);
  v_reg := public.agent_registered_at(v_key);
  if v_reg is null then
    select min(a.created_at) into v_reg from public.agents a where a.user_id = v_uid;
  end if;
  if v_reg is null then
    -- Registration unknown → treat as active (safe, don't lock anyone out).
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
$fn$;

revoke all    on function public.my_agent_subscription() from public, anon;
grant execute on function public.my_agent_subscription() to authenticated;

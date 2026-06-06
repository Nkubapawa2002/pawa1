-- ============================================================================
-- Agent monthly subscription + auto-suspend
--
-- Every agent (bus/cargo agent, house owner, truck owner) is expected to pay a
-- monthly subscription. The admin records each payment in the "All Agents" tab
-- (agent_billing: status='paid', amount, paid_until = +1 month). When paid_until
-- passes, the agent AUTO-SUSPENDS: their public listings/directory entry vanish
-- and their dashboard shows a "subscription expired" paywall — until the admin
-- records the next payment.
--
-- SAFE ROLLOUT: an identity is treated as ACTIVE unless it has an EXPLICIT
-- billing row that has lapsed (paid_until < today) or been cancelled/overdue.
-- An agent with NO billing row yet stays active, so applying this never blanks
-- the platform. Admin enrols agents over time; they suspend only once a set
-- paid_until lapses.
--
-- Depends on: supabase/agent_billing.sql (the agent_billing table).
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
-- ============================================================================

-- ---- Suspension predicates ------------------------------------------------
-- agent_key matches the admin tracker's identity strings:
--   "uid:<owner_user_id>"  (house/truck owners)   "ph:<last 9 digits>" (bus agents)
-- SECURITY DEFINER so the RLS policies below can read the admin-only
-- agent_billing table; they only ever expose a boolean.

create or replace function public.agent_key_suspended(p_key text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select case
    when p_key is null or p_key = '' then false
    else exists (
      select 1 from public.agent_billing b
      where b.agent_key = p_key
        and ( b.status in ('cancelled','overdue')
           or (b.paid_until is not null and b.paid_until < current_date) )
    )
  end;
$fn$;

create or replace function public.uid_suspended(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select public.agent_key_suspended(
    case when p_uid is null then null else 'uid:' || p_uid::text end);
$fn$;

create or replace function public.phone_suspended(p_phone text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select public.agent_key_suspended(
    case when coalesce(p_phone,'') = '' then null
         else 'ph:' || right(regexp_replace(p_phone, '\D', '', 'g'), 9) end);
$fn$;

-- ---- Enforcement: hide suspended agents' listings / directory entry --------
-- Each policy still lets the owner see their OWN rows (so they can renew) and
-- admins see everything.

drop policy if exists "houses readable" on public.houses;
create policy "houses readable" on public.houses for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id = auth.uid()
  or public.is_admin()
);

drop policy if exists "trucks readable" on public.trucks;
create policy "trucks readable" on public.trucks for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id = auth.uid()
  or public.is_admin()
);

drop policy if exists "agents readable" on public.agents;
create policy "agents readable" on public.agents for select using (
  not public.phone_suspended(phone)
  or user_id = auth.uid()
  or public.is_admin()
);

-- ---- Agent self-check: does my account have an active subscription? --------
-- Called by the agent dashboards (agent.html / agent-houses / agent-trucks) to
-- show a paywall when suspended. Resolves the caller's identity to its uid key
-- and the phone key of any agents row they own, and reports the most relevant
-- billing row.

create or replace function public.my_agent_subscription()
returns table(active boolean, status text, paid_until date, agent_key text)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  r public.agent_billing%rowtype;
begin
  if v_uid is null then
    return query select true, 'none'::text, null::date, null::text;
    return;
  end if;

  select b.* into r
  from public.agent_billing b
  where b.agent_key = 'uid:' || v_uid::text
     or b.agent_key in (
        select 'ph:' || right(regexp_replace(coalesce(a.phone,''), '\D', '', 'g'), 9)
        from public.agents a
        where a.user_id = v_uid and coalesce(a.phone,'') <> ''
     )
  order by b.paid_until desc nulls last
  limit 1;

  if not found then
    return query select true, 'none'::text, null::date, null::text;  -- not enrolled → active (grace)
    return;
  end if;

  return query select
    not ( r.status in ('cancelled','overdue')
          or (r.paid_until is not null and r.paid_until < current_date) ),
    r.status, r.paid_until, r.agent_key;
end;
$fn$;

revoke all   on function public.my_agent_subscription() from public, anon;
grant execute on function public.my_agent_subscription() to authenticated;

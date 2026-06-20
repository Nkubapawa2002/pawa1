-- ============================================================================
-- agent_billing_setup.sql — ONE-SHOT admin-controlled agent billing
-- ============================================================================
-- Brings up (or repairs) the ENTIRE agent monetization / subscription system in
-- a single run. Paste this one file into the Supabase SQL editor. Idempotent and
-- transactional — safe to re-run any time.
--
-- MODEL: admin-controlled, NO payment gateway. There is no self-serve checkout.
--   • A new agent is LIVE immediately for a short preview window.
--   • An admin APPROVES them in admin.html → "All Agents" (one-time gate).
--   • When an agent pays the admin (cash / mobile money / however), the admin
--     records it; the AMOUNT sets how long coverage lasts (fee = 1 month).
--   • When paid_until lapses the account auto-suspends (listings + directory
--     entry hidden, dashboard shows a paywall) until the admin records the next
--     payment. Admins can also deactivate/reactivate at will with a reason.
--
-- WHY THIS FILE EXISTS: the behaviour used to be spread across agent_billing.sql,
-- agent_subscription.sql, agent_grace_active.sql, agent_billing_anchor.sql and
-- agent_approval.sql, several of which REDEFINE the same two functions
-- (my_agent_subscription / agent_key_suspended). The live behaviour therefore
-- depended on apply ORDER — re-running an older file silently reverted the
-- approval gate. This file is the single authoritative definition: it always
-- leaves the system in the correct final state regardless of what ran before.
-- The individual files are kept only for historical reference.
--
-- Clerk-safe: every identity check uses public.app_uid() (text), so it works for
-- both Supabase-Auth and Clerk JWTs. Does NOT depend on the payments table.
--
-- Depends only on shared primitives that already exist in schema_master.sql:
--   public.is_admin(), public.touch_updated_at() (both created defensively below
--   if somehow missing, so this file stands alone).
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 0. Shared primitives (defensive — normally already present)
-- ----------------------------------------------------------------------------

-- Caller identity as TEXT (NULL when anonymous). For a Supabase-Auth token the
-- `sub` claim IS the user uuid as text, so this matches legacy uuid rows too.
create or replace function public.app_uid() returns text
  language sql stable set search_path = public
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim',  true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb ->> 'sub'
  , '')
$$;

-- Keep an updated_at column fresh on UPDATE (shared trigger fn).
create or replace function public.touch_updated_at() returns trigger
  language plpgsql set search_path = public
as $$ begin new.updated_at := now(); return new; end; $$;

-- ----------------------------------------------------------------------------
-- 1. agent_billing table — one row per de-duplicated agent identity
-- ----------------------------------------------------------------------------
-- agent_key matches the admin tracker's identity string, one of:
--   "uid:<owner_user_id>"  (house/truck/service agents — preferred)
--   "ph:<last 9 digits>"   (bus/cargo agents matched by phone)
--   "nm:<lowercased name>" (last-resort fallback)
create table if not exists public.agent_billing (
  agent_key   text primary key,
  name        text,                       -- denormalised for readability/export
  phone       text,
  status      text not null default 'free'
                check (status in ('free','trial','paid','overdue','cancelled')),
  plan        text,                       -- free-text tier, e.g. 'basic','pro'
  amount_tzs  bigint not null default 0 check (amount_tzs >= 0),
  paid_until  date,                       -- subscription / access expiry
  note        text,                       -- admin message the agent sees
  updated_by  text,                       -- admin email who last changed it
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Columns added by later migrations — additive, so re-running is safe.
alter table public.agent_billing
  add column if not exists active      boolean not null default true,  -- admin on/off switch
  add column if not exists started_on  date,                           -- billing anchor / approved day
  add column if not exists approved_at timestamptz,                    -- one-time approval stamp
  add column if not exists approved_by text;

create index if not exists agent_billing_status_idx     on public.agent_billing (status);
create index if not exists agent_billing_paid_until_idx on public.agent_billing (paid_until);

drop trigger if exists set_agent_billing_updated_at on public.agent_billing;
create trigger set_agent_billing_updated_at
  before update on public.agent_billing
  for each row execute function public.touch_updated_at();

-- Admin-only: billing is sensitive (PII + money), never world-readable.
alter table public.agent_billing enable row level security;
drop policy if exists "agent_billing admin read"  on public.agent_billing;
drop policy if exists "agent_billing admin write" on public.agent_billing;
create policy "agent_billing admin read" on public.agent_billing
  for select using (public.is_admin());
create policy "agent_billing admin write" on public.agent_billing
  for all using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 2. agent_registered_at — earliest moment an identity appeared on the platform
-- ----------------------------------------------------------------------------
-- Drives the approval window's clock. owner_user_id / user_id are TEXT after the
-- Clerk migration; substring()/::text comparisons work for both uuid and Clerk.
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

-- ----------------------------------------------------------------------------
-- 3. Suspension predicate — APPROVAL gate, then billing (the final behaviour)
-- ----------------------------------------------------------------------------
-- Order of checks:
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

  -- Approval gate (applies until an admin approves).
  if not (v_found and r.approved_at is not null) then
    v_reg := public.agent_registered_at(p_key);
    if v_reg is null then return false; end if;        -- unknown registration → don't lock out
    return now() > v_reg + v_window;                   -- live 7 days, then pause
  end if;

  -- Approved → normal billing.
  if r.paid_until is not null then
    return r.paid_until < current_date;                -- lapsed?
  end if;
  return false;                                        -- approved, no expiry → active
end;
$fn$;

-- Identity-typed wrappers used by the listing RLS policies. owner_user_id is now
-- TEXT, so uid_suspended takes text (the uuid overload is dropped if present).
drop function if exists public.uid_suspended(uuid);
create or replace function public.uid_suspended(p_uid text) returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.agent_key_suspended(
    case when coalesce(p_uid,'') = '' then null else 'uid:' || p_uid end);
$$;

create or replace function public.phone_suspended(p_phone text) returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.agent_key_suspended(
    case when coalesce(p_phone,'') = '' then null
         else 'ph:' || right(regexp_replace(p_phone, '\D', '', 'g'), 9) end);
$$;

-- ----------------------------------------------------------------------------
-- 4. agent_next_due — shared renewal arithmetic (admin panel preview / cron)
-- ----------------------------------------------------------------------------
-- Next monthly date anchored to p_anchor's day-of-month, strictly after p_after.
-- Day-of-month clamped for short months (31st → 30th/28th where needed).
create or replace function public.agent_next_due(p_anchor date, p_after date)
returns date language plpgsql stable as $fn$
declare
  v_day  int;
  v_due  date;
  v_base date := coalesce(p_after, current_date);
begin
  if p_anchor is null then
    return (v_base + interval '1 month')::date;   -- no anchor → plain +1 month
  end if;
  v_day := extract(day from p_anchor)::int;
  v_due := date_trunc('month', v_base + interval '1 month')::date;
  v_due := v_due
         + (least(v_day, extract(day from (date_trunc('month', v_due)
                                           + interval '1 month - 1 day'))::int) - 1);
  return v_due;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 5. Enforcement — hide suspended agents' listings / directory entry
-- ----------------------------------------------------------------------------
-- Each policy still lets the OWNER see their own rows (so they can renew) and
-- admins see everything. Recreated here (app_uid + column::text) so a suspended
-- house / truck / service / bus agent disappears from public browse.
drop policy if exists "houses readable" on public.houses;
create policy "houses readable" on public.houses for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id::text = (select public.app_uid())
  or public.is_admin()
);

drop policy if exists "trucks readable" on public.trucks;
create policy "trucks readable" on public.trucks for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id::text = (select public.app_uid())
  or public.is_admin()
);

drop policy if exists "services readable" on public.services;
create policy "services readable" on public.services for select using (
  not public.uid_suspended(owner_user_id)
  or owner_user_id::text = (select public.app_uid())
  or public.is_admin()
);

drop policy if exists "agents readable" on public.agents;
create policy "agents readable" on public.agents for select using (
  not public.phone_suspended(phone)
  or user_id::text = (select public.app_uid())
  or public.is_admin()
);

-- ----------------------------------------------------------------------------
-- 6. Agent self-check — drives the dashboard banner/paywall
-- ----------------------------------------------------------------------------
-- reason: 'preview' (in approval window) | 'approval_expired' | 'active'
--         | 'expired' | 'deactivated' | 'cancelled' | 'overdue' | 'none'
-- Drop first: the return type can't be altered by CREATE OR REPLACE alone.
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

-- ----------------------------------------------------------------------------
-- 7. Grandfather everyone who already exists → APPROVED (safe rollout)
-- ----------------------------------------------------------------------------
-- So applying this never hides current agents. Only sign-ups AFTER this runs
-- enter the 7-day approval window. Also backfills started_on for the cycle anchor.
insert into public.agent_billing (agent_key, approved_at, approved_by, started_on)
select ids.key,
       coalesce(public.agent_registered_at(ids.key), now()),
       'grandfathered',
       coalesce(public.agent_registered_at(ids.key)::date, current_date)
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
      approved_by = coalesce(public.agent_billing.approved_by, excluded.approved_by),
      started_on  = coalesce(public.agent_billing.started_on,  excluded.started_on);

-- Any pre-existing row still missing approval / anchor → backfill it.
update public.agent_billing
   set approved_at = coalesce(approved_at, public.agent_registered_at(agent_key), created_at),
       approved_by = coalesce(approved_by, 'grandfathered'),
       started_on  = coalesce(started_on, public.agent_registered_at(agent_key)::date, created_at::date)
 where approved_at is null or started_on is null;

-- ----------------------------------------------------------------------------
-- 8. agent_payments — the LEDGER of money the admin actually received
-- ----------------------------------------------------------------------------
-- Until the automatic payment gateway is wired up, agents pay the admin offline
-- (cash / mobile money / bank) and the admin records each receipt here. This is
-- the audit trail: one immutable row per payment, so "how much has this agent
-- ever paid / when / who recorded it" is answerable, and platform revenue
-- ("Total collected") is a real sum of receipts — NOT a guess from monthly
-- rates. agent_billing.paid_until is the *derived* coverage; this table is the
-- *source of truth* for cash in. Keyed by the same agent_key as agent_billing.
create table if not exists public.agent_payments (
  id           bigint generated always as identity primary key,
  agent_key    text not null,
  name         text,                     -- denormalised snapshot for export
  phone        text,
  amount_tzs   bigint not null check (amount_tzs > 0),
  months       integer not null default 1 check (months >= 1),
  method       text,                     -- 'cash' | 'mobile' | 'bank' | free text
  reference    text,                     -- receipt / transaction id (optional)
  covers_from  date,                     -- coverage start this payment extended from
  paid_until   date,                     -- coverage expiry AFTER this payment
  note         text,
  recorded_by  text,                     -- admin email who logged it
  created_at   timestamptz not null default now()
);
create index if not exists agent_payments_key_idx     on public.agent_payments (agent_key);
create index if not exists agent_payments_created_idx on public.agent_payments (created_at);

-- Admin-only (money + PII). Insert is normally done via the RPC below (which is
-- security definer), but a direct admin insert/read is allowed too.
alter table public.agent_payments enable row level security;
drop policy if exists "agent_payments admin read"  on public.agent_payments;
drop policy if exists "agent_payments admin write" on public.agent_payments;
create policy "agent_payments admin read" on public.agent_payments
  for select using (public.is_admin());
create policy "agent_payments admin write" on public.agent_payments
  for all using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 9. record_agent_payment — the ONE place a received payment is applied
-- ----------------------------------------------------------------------------
-- Atomically, server-side (so admin + any future gateway agree to the day):
--   • work out how many whole months the amount buys (amount ÷ monthly rate,
--     rounded, minimum 1) — "how much they pay sets how long it lasts";
--   • roll coverage forward from the current expiry if still active (paying
--     early stacks, no lost days) else from today;
--   • mark the agent paid + active + APPROVED (recording a payment is the admin
--     confirming them) and remember their monthly rate;
--   • write the immutable ledger row.
-- Returns the new paid_until, the months bought and the amount, so the UI can
-- confirm without re-deriving anything.
create or replace function public.record_agent_payment(
  p_key         text,
  p_amount      bigint,
  p_monthly_fee bigint  default 10000,
  p_method      text    default null,
  p_reference   text    default null,
  p_note        text    default null,
  p_name        text    default null,
  p_phone       text    default null
) returns table(paid_until date, months integer, amount_tzs bigint, rate_tzs bigint)
language plpgsql security definer set search_path = public as $fn$
declare
  v_email  text;
  r        public.agent_billing%rowtype;
  v_name   text;
  v_phone  text;
  v_rate   bigint;
  v_months int;
  v_base   date;
  v_until  date;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_key is null or p_key = '' then
    raise exception 'agent_key is required';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'amount must be a positive number';
  end if;

  v_email := nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim',  true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb ->> 'email'
  , '');

  select * into r from public.agent_billing b where b.agent_key = p_key;

  -- Prefer the name/phone already on the billing row; fall back to what the UI
  -- passed (so a first-ever payment still produces a self-describing receipt).
  v_name  := coalesce(r.name,  nullif(trim(p_name),  ''));
  v_phone := coalesce(r.phone, nullif(trim(p_phone), ''));

  -- The agent's monthly rate: their stored custom fee, else the platform fee.
  v_rate   := case when coalesce(r.amount_tzs, 0) > 0 then r.amount_tzs
                   else greatest(coalesce(p_monthly_fee, 10000), 1) end;
  v_months := greatest(1, round(p_amount::numeric / v_rate)::int);
  v_base   := case when r.paid_until is not null and r.paid_until > current_date
                   then r.paid_until else current_date end;
  -- Calendar-month add clamps short months (Jan 31 + 1mo = Feb 28), matching the
  -- admin UI's _aaAddMonths and Postgres `+ interval '1 month'`.
  v_until  := (v_base + (v_months || ' months')::interval)::date;

  insert into public.agent_billing as ab
    (agent_key, name, phone, status, active, amount_tzs, paid_until,
     approved_at, approved_by, started_on, updated_by)
  values
    (p_key, v_name, v_phone, 'paid', true, v_rate, v_until,
     coalesce(r.approved_at, now()), coalesce(r.approved_by, v_email),
     coalesce(r.started_on, current_date), v_email)
  on conflict (agent_key) do update set
    name        = coalesce(ab.name, v_name),
    phone       = coalesce(ab.phone, v_phone),
    status      = 'paid',
    active      = true,
    amount_tzs  = case when coalesce(ab.amount_tzs, 0) > 0 then ab.amount_tzs else v_rate end,
    paid_until  = v_until,
    approved_at = coalesce(ab.approved_at, now()),
    approved_by = coalesce(ab.approved_by, v_email),
    started_on  = coalesce(ab.started_on, current_date),
    updated_by  = v_email;

  insert into public.agent_payments
    (agent_key, name, phone, amount_tzs, months, method, reference,
     covers_from, paid_until, note, recorded_by)
  values
    (p_key, v_name, v_phone, p_amount, v_months, p_method, p_reference,
     v_base, v_until, p_note, v_email);

  return query select v_until, v_months, p_amount, v_rate;
end;
$fn$;

revoke all    on function public.record_agent_payment(text,bigint,bigint,text,text,text,text,text) from public, anon;
grant execute on function public.record_agent_payment(text,bigint,bigint,text,text,text,text,text) to authenticated;

commit;

-- ============================================================================
-- Done. Verify in admin.html → "All Agents":
--   • existing agents show "Approved · active" (grandfathered)
--   • a brand-new agent shows "Preview · 7d to approve" until you Approve
--   • "Record payment" logs a row in agent_payments, extends paid_until and
--     approves+activates the agent; once paid_until lapses they auto-suspend
--   • the summary's "Collected (all time)" / "This month" read real receipts
--     from agent_payments — not a guess from monthly rates
-- ============================================================================

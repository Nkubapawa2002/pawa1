-- ============================================================================
-- Agent SELF-SERVE subscription (mobile money)
-- ----------------------------------------------------------------------------
-- Lets an agent pay their OWN monthly subscription through the existing
-- mobile-money rail (create-payment / payment-callback), instead of waiting for
-- an admin to record the payment by hand. Identity (Clerk or Supabase) keys the
-- subscription; access stays gated in Supabase by agent_subscription.sql +
-- agent_grace_active.sql (unchanged).
--
-- FLOW
--   1. The dashboard reads my_agent_subscription() → gets the caller's agent_key
--      (e.g. 'uid:<clerk-or-supabase-user-id>') and the monthly fee from config.
--   2. The agent taps "Renew" → POST create-payment {
--          reference:      '<agent_key>|<unique>',   -- unique suffix per attempt
--          reference_type: 'agent_subscription',
--          amount_tzs:     <fee>, method, phone }
--   3. When that payment flips to 'completed' — the demo auto-confirm inside
--      create-payment OR a real provider webhook via payment-callback — the
--      trigger below extends agent_billing.paid_until by ONE MONTH for the
--      agent_key embedded in the reference.
--
-- WHY a unique reference suffix: payments.payments_reference_active_idx is a
-- UNIQUE index over reference for status in (pending, awaiting_payment,
-- processing, completed). A recurring subscription reuses the same agent_key, so
-- last month's COMPLETED row would collide with this month's new row. We append
-- '|<unique>' per attempt and recover the key with split_part(reference,'|',1).
--
-- Depends on: agent_billing.sql, agent_subscription.sql, agent_grace_active.sql,
--             schema_master.sql (payments). Run once in the Supabase SQL editor.
-- Idempotent — safe to re-run.
-- ============================================================================

-- 1. Allow the new reference_type on payments.
alter table public.payments drop constraint if exists payments_reference_type_check;
alter table public.payments add  constraint payments_reference_type_check
  check (reference_type in
    ('booking','shipment','agent_topup','agent_subscription','reschedule','other'));

-- 2. Fulfilment trigger: extend the agent's coverage by one month when a
--    subscription payment completes. SECURITY DEFINER so it can write the
--    admin-only agent_billing table; it only ever touches the single row keyed
--    by the agent_key embedded in the payment reference.
create or replace function public.apply_agent_subscription_payment()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_key  text;
  v_from date;
begin
  if new.reference_type <> 'agent_subscription' then return new; end if;
  if new.status <> 'completed' then return new; end if;
  -- Only act on the transition INTO completed (never re-apply).
  if tg_op = 'UPDATE' and old.status = 'completed' then return new; end if;

  v_key := split_part(coalesce(new.reference, ''), '|', 1);
  if v_key is null or v_key = '' then return new; end if;

  -- Renew from the later of today / the current expiry, so paying early stacks
  -- the extra month rather than wasting the remaining days.
  select greatest(coalesce(b.paid_until, current_date), current_date)
    into v_from
  from public.agent_billing b
  where b.agent_key = v_key;
  if v_from is null then v_from := current_date; end if;

  insert into public.agent_billing as b
    (agent_key, name, phone, status, active, amount_tzs, paid_until,
     note, updated_by, updated_at)
  values
    (v_key, nullif(new.customer_name, ''), nullif(new.customer_phone, ''),
     'paid', true, coalesce(new.amount_tzs, 0)::bigint,
     (v_from + interval '1 month')::date,
     'Self-serve mobile-money subscription', 'self-serve', now())
  on conflict (agent_key) do update set
    status     = 'paid',
    active     = true,
    amount_tzs = coalesce(nullif(excluded.amount_tzs, 0), b.amount_tzs),
    paid_until = (v_from + interval '1 month')::date,
    name       = coalesce(b.name, excluded.name),
    phone      = coalesce(b.phone, excluded.phone),
    note       = 'Self-serve mobile-money subscription',
    updated_by = 'self-serve',
    updated_at = now();

  return new;
end;
$fn$;

drop trigger if exists trg_agent_subscription_paid on public.payments;
create trigger trg_agent_subscription_paid
  after insert or update on public.payments
  for each row execute function public.apply_agent_subscription_payment();

-- 3. Convenience read for the dashboard: the caller's agent_key + the live
--    status, so the browser never has to guess the key. (my_agent_subscription
--    already returns agent_key; this is a thin, explicitly-named alias kept for
--    clarity and forward use.)
create or replace function public.my_subscription_key()
returns text language sql stable security definer set search_path = public as $fn$
  select 'uid:' || auth.uid()::text where auth.uid() is not null;
$fn$;
revoke all    on function public.my_subscription_key() from public, anon;
grant execute on function public.my_subscription_key() to authenticated;

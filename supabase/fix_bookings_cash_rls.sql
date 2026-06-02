-- Security hardening: bookings + cash_retargets.
--
-- Context: agents are NOT authenticated (the agent dashboard "logs in" by
-- phone lookup as the anon role), so these tables were left wide open. We tier
-- the fix to what's safe without breaking the public booking flow:
--
--  cash_retargets — used ONLY by the agent dashboard, no realtime, no finance
--    portal use. Lock the table: anon can no longer read or update it directly.
--    The two agent operations move to SECURITY DEFINER RPCs keyed by ticket.
--
--  bookings — powers the anonymous booking/seat-hold/checkout flow, so anon
--    INSERT and (scoped) UPDATE/SELECT must stay. We close the INTEGRITY hole:
--    previously anon could UPDATE *any* booking (USING true) — including
--    cancelling or tampering with someone else's CONFIRMED/PAID ticket. Now
--    anon UPDATE only targets unpaid holds and can't elevate a row to
--    confirmed/paid (payment confirmation is server-side via service_role).
--
--  NOTE (deferred): the bookings *PII read* leak (anon can read passenger
--    name/phone/ID of all rows, and the realtime seat channel broadcasts full
--    rows) is NOT fully closed here. Closing it needs realtime sanitisation +
--    read RPCs + real agent auth — a separate, tested change. See the runbook.
--
-- Idempotent. Safe to re-run.

-- ===========================================================================
-- 1. cash_retargets — lock the table, expose agent ops via RPCs
-- ===========================================================================
-- List the cash payers still waiting to be recorded (non-PII-minimal; the
-- agent needs the phone to call them).
create or replace function public.cash_retargets_pending(p_limit int default 20)
returns table (
  id              bigint,
  ticket_code     text,
  bus_name        text,
  route           text,
  seat_number     text,
  passenger_phone text,
  fare_tzs        numeric,
  retarget_status text,
  created_at      timestamptz
)
language sql stable security definer set search_path = public as $$
  select id, ticket_code, bus_name, route, seat_number,
         passenger_phone, fare_tzs, retarget_status, created_at
  from public.cash_retargets
  where retarget_status = 'pending_record'
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
grant execute on function public.cash_retargets_pending(int) to anon, authenticated;

-- Record one cash payment against its ticket (the only write the agent makes).
create or replace function public.cash_retargets_record(
  p_ticket text, p_name text, p_phone text, p_recorded_by text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.cash_retargets
     set customer_name   = p_name,
         customer_phone   = p_phone,
         retarget_status  = 'recorded',
         recorded_by      = p_recorded_by,
         recorded_at      = now()
   where ticket_code = p_ticket
     and retarget_status = 'pending_record';
end;
$$;
grant execute on function public.cash_retargets_record(text, text, text, text) to anon, authenticated;

-- Close the open read/update policies. Keep INSERT (rows are created by the
-- checkout/server when a rider pays cash). Add a finance read for audit.
drop policy if exists "anon read cash_retargets"          on public.cash_retargets;
drop policy if exists "cash_retargets public read"        on public.cash_retargets;
drop policy if exists "cash_retargets public update"      on public.cash_retargets;
drop policy if exists "authenticated update cash_retargets" on public.cash_retargets;
drop policy if exists "cash_retargets finance read"       on public.cash_retargets;
create policy "cash_retargets finance read" on public.cash_retargets for select to authenticated
  using (is_finance_user());

-- ===========================================================================
-- 2. bookings — close the UPDATE integrity hole (keep the public flow working)
-- ===========================================================================
-- Remove the blanket "update anything" policies.
drop policy if exists "bookings public update" on public.bookings;
drop policy if exists "bookings updatable"     on public.bookings;
drop policy if exists "bookings hold update"   on public.bookings;
-- Anon/users may only modify UNPAID holds, and may never mark a row
-- confirmed/paid (that comes from the payment callback via service_role).
create policy "bookings hold update" on public.bookings for update to anon, authenticated
  using (status in ('pending', 'awaiting_payment'))
  with check (status not in ('confirmed', 'paid'));
-- ("bookings admin update" (is_admin) and "bookings admin delete" stay as-is.)

-- Dedupe the redundant duplicate read/insert policies (cosmetic; behaviour
-- unchanged — one of each pair remains, still public).
drop policy if exists "bookings public read"   on public.bookings;   -- keep "bookings readable"
drop policy if exists "bookings public insert"  on public.bookings;   -- keep "bookings insertable"

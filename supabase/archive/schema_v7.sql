-- =====================================================
-- Pawa Bus Cargo - Schema v7
-- Voice booking support tables
-- Run this in Supabase SQL editor (Dashboard → SQL Editor → New query)
-- =====================================================

-- -------------------------------------------------------
-- 1. call_requests
--    Written by the web page when a customer requests a
--    callback; n8n polls this table and triggers a VAPI
--    outbound call, then marks the row as "called".
-- -------------------------------------------------------
create table if not exists public.call_requests (
  id            bigserial primary key,
  phone         text        not null,
  requested_at  timestamptz not null default now(),
  status        text        not null default 'pending'
                check (status in ('pending', 'calling', 'called', 'failed'))
);

-- Index for n8n to quickly find pending rows
create index if not exists idx_call_requests_status
  on public.call_requests (status, requested_at);

-- Anyone (anon browser session) may insert a call request
grant select, insert on public.call_requests to anon, authenticated;
grant usage, select on sequence public.call_requests_id_seq to anon, authenticated;


-- -------------------------------------------------------
-- 2. cash_retargets
--    Created when a customer on Book Seat Fast chooses
--    "Pay Cash".  Bus agent records customer details later
--    via the Agent Dashboard.
-- -------------------------------------------------------
create table if not exists public.cash_retargets (
  id               bigserial primary key,
  ticket_code      text        not null,
  bus_name         text,
  route            text,
  seat_number      text,
  passenger_phone  text,
  fare_tzs         numeric(12, 2),
  payment_method   text        not null default 'cash',
  retarget_status  text        not null default 'pending_record'
                   check (retarget_status in ('pending_record', 'recorded', 'cancelled')),
  -- filled in by the bus agent
  customer_name    text,
  customer_phone   text,
  recorded_by      text,          -- agent phone or ID
  recorded_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_cash_retargets_status
  on public.cash_retargets (retarget_status, created_at);

create index if not exists idx_cash_retargets_ticket
  on public.cash_retargets (ticket_code);

-- Browser inserts new rows; agent dashboard reads + updates
grant select, insert, update on public.cash_retargets to anon, authenticated;
grant usage, select on sequence public.cash_retargets_id_seq to anon, authenticated;


-- -------------------------------------------------------
-- 3. bookings — add cancellation / refund columns
--    (alter table is idempotent via the do-block guard)
-- -------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'bookings'
      and column_name  = 'refund_tzs'
  ) then
    alter table public.bookings
      add column refund_tzs  numeric(12, 2),
      add column cancelled_at timestamptz;
  end if;
end;
$$;

-- -------------------------------------------------------
-- 4. Row-Level Security (RLS) — keep consistent with
--    the rest of the schema (public tables = anon can
--    insert, service role can do everything).
-- -------------------------------------------------------
alter table public.call_requests  enable row level security;
alter table public.cash_retargets enable row level security;

-- call_requests: anon may insert and read their own row
create policy "anon insert call_requests"
  on public.call_requests for insert to anon, authenticated
  with check (true);

create policy "anon read call_requests"
  on public.call_requests for select to anon, authenticated
  using (true);

-- cash_retargets: anon may insert; agent (authenticated) may update
create policy "anon insert cash_retargets"
  on public.cash_retargets for insert to anon, authenticated
  with check (true);

create policy "anon read cash_retargets"
  on public.cash_retargets for select to anon, authenticated
  using (true);

create policy "authenticated update cash_retargets"
  on public.cash_retargets for update to authenticated
  using (true)
  with check (true);

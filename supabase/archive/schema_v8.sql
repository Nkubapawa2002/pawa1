-- =====================================================================
-- Pawa Bus Cargo — Schema v8: Full write-access fix
-- Fixes all tables so the browser (anon) can read and write data.
--
-- Problems this resolves:
--   1. bookings.status CHECK is too narrow (missing expired / rescheduled /
--      refund_initiated / awaiting_payment) → inserts/updates were rejected
--   2. bookings RLS only allowed admins to UPDATE → expiry & cancellation
--      in book-fast.js silently failed
--   3. buses.payment_note column missing (referenced in agent prompt)
--   4. Gaps in agent_applications / call_requests write policies
--
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run — uses IF NOT EXISTS / DO-blocks / DROP POLICY IF EXISTS.
-- =====================================================================

-- -----------------------------------------------------------------------
-- 1. Widen bookings.status CHECK constraint
-- -----------------------------------------------------------------------
-- Drop the old constraint and replace it with the full set of values the
-- app actually uses.  The DO-block makes this idempotent.
do $$
begin
  -- Drop the old named constraint if it exists (Postgres auto-names it
  -- "bookings_status_check").
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'bookings'
      and constraint_name = 'bookings_status_check'
  ) then
    alter table public.bookings drop constraint bookings_status_check;
  end if;
end;
$$;

alter table public.bookings
  add constraint bookings_status_check
  check (status in (
    'pending',
    'awaiting_payment',
    'confirmed',
    'boarded',
    'cancelled',
    'rescheduled',
    'refund_initiated',
    'expired'
  ));

-- -----------------------------------------------------------------------
-- 2. Add missing columns to bookings (idempotent)
-- -----------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name = 'refund_tzs'
  ) then
    alter table public.bookings add column refund_tzs numeric(12,2);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name = 'cancelled_at'
  ) then
    alter table public.bookings add column cancelled_at timestamptz;
  end if;
end;
$$;

-- -----------------------------------------------------------------------
-- 3. Fix bookings RLS — open anon read + write
-- -----------------------------------------------------------------------
-- The old policy "bookings admin update" blocked the browser from updating
-- bookings on expiry and cancellation.  Replace it with open anon access
-- (matching the demo posture of the rest of the schema).

drop policy if exists "bookings admin update"  on public.bookings;
drop policy if exists "bookings readable"      on public.bookings;
drop policy if exists "bookings insertable"    on public.bookings;
drop policy if exists "bookings updatable"     on public.bookings;

create policy "bookings readable"
  on public.bookings for select to anon, authenticated
  using (true);

create policy "bookings insertable"
  on public.bookings for insert to anon, authenticated
  with check (true);

create policy "bookings updatable"
  on public.bookings for update to anon, authenticated
  using (true) with check (true);

-- Keep a tighter admin-only delete for safety
drop policy if exists "bookings admin delete" on public.bookings;
create policy "bookings admin delete"
  on public.bookings for delete to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email()));

-- -----------------------------------------------------------------------
-- 4. Add payment_note to buses (for bus-specific payment instructions)
-- -----------------------------------------------------------------------
alter table public.buses add column if not exists payment_note text;

-- -----------------------------------------------------------------------
-- 5. Ensure agent_applications allows anon to read own status
-- -----------------------------------------------------------------------
-- (Already handled by check_application_status() security-definer RPC in v5,
--  but explicitly allow authenticated users to read all pending apps they own.)

-- Nothing extra needed — the RPC from v5 covers this.

-- -----------------------------------------------------------------------
-- 6. call_requests — ensure service_role can update status
-- -----------------------------------------------------------------------
-- n8n uses service_role which bypasses RLS, so no extra policy is needed.
-- But add anon UPDATE just in case the workflow runs as anon:
drop policy if exists "anon update call_requests" on public.call_requests;
create policy "anon update call_requests"
  on public.call_requests for update to anon, authenticated
  using (true) with check (true);

-- -----------------------------------------------------------------------
-- 7. shipments — ensure anon can update (for status changes from agents)
-- -----------------------------------------------------------------------
drop policy if exists "shipments updatable" on public.shipments;
create policy "shipments updatable"
  on public.shipments for update to anon, authenticated
  using (true) with check (true);

-- -----------------------------------------------------------------------
-- 8. Grant explicit table-level permissions (belt-and-suspenders)
--    Uses DO-blocks for optional tables so the script doesn't fail if
--    rides_schema.sql or meet_schema.sql haven't been run yet.
-- -----------------------------------------------------------------------

-- Core tables (always present after schema.sql → schema_v7.sql)
grant select, insert, update on public.bookings           to anon, authenticated;
grant select, insert, update on public.shipments          to anon, authenticated;
grant select, insert, update on public.call_requests      to anon, authenticated;
grant select, insert, update on public.cash_retargets     to anon, authenticated;
grant select, insert         on public.agent_applications to anon, authenticated;
grant select                 on public.buses              to anon, authenticated;
grant select                 on public.agents             to anon, authenticated;
grant select                 on public.regions            to anon, authenticated;
grant select, insert         on public.shipment_messages  to anon, authenticated;
grant select, insert         on public.agent_reviews      to anon, authenticated;

-- Sequences for core tables
grant usage, select on sequence public.call_requests_id_seq      to anon, authenticated;
grant usage, select on sequence public.cash_retargets_id_seq     to anon, authenticated;
grant usage, select on sequence public.bookings_id_seq           to anon, authenticated;
grant usage, select on sequence public.shipment_messages_id_seq  to anon, authenticated;
grant usage, select on sequence public.agent_applications_id_seq to anon, authenticated;
grant usage, select on sequence public.agent_reviews_id_seq      to anon, authenticated;

-- Optional tables (payments_schema.sql, meet_schema.sql, rides_schema.sql)
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'payments','payment_callbacks','meet_rooms','live_locations',
    'drivers_online','ride_requests','ride_drivers','ride_messages'
  ] loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = tbl
    ) then
      execute format(
        'grant select, insert, update on public.%I to anon, authenticated', tbl
      );
    end if;
  end loop;
end;
$$;

-- Sequences for optional tables
do $$
declare seq text;
begin
  foreach seq in array array[
    'live_locations_id_seq','ride_messages_id_seq',
    'payment_callbacks_id_seq'
  ] loop
    if exists (
      select 1 from information_schema.sequences
      where sequence_schema = 'public' and sequence_name = seq
    ) then
      execute format(
        'grant usage, select on sequence public.%I to anon, authenticated', seq
      );
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------
-- 9. Realtime for bookings (idempotent)
-- -----------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_requests'
  ) then
    alter publication supabase_realtime add table public.call_requests;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cash_retargets'
  ) then
    alter publication supabase_realtime add table public.cash_retargets;
  end if;
end $$;

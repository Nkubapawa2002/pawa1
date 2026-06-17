-- ============================================================================
-- Pawa Houses — tenant / customer tracking + rent-expiry follow-up
--
-- For every rented house, the owning agent records the CUSTOMER (tenant) name +
-- phone and the rental START date and length in MONTHS (defaults to the house's
-- minimum rental period, houses.min_months). The END date is computed by the DB.
-- The platform owner (admin) monitors all tenancies sorted by soonest end date,
-- so "we" can contact customers near expiry.
--
-- PRIVACY: customer phone is PII, so (unlike public houses) this table is NOT
-- world-readable — only the owning agent and admins can read it.
--
-- Idempotent. Safe to re-run. Apply in the Supabase SQL editor or scripts/run_sql.mjs.
-- ============================================================================

create table if not exists public.house_tenancies (
  id              text primary key,                                   -- client-generated, like houses
  house_id        text references public.houses(id) on delete set null,
  house_label     text,                                               -- snapshot "Title — Area" (survives listing deletion)
  owner_user_id   uuid references auth.users(id) on delete set null,  -- the agent who owns the listing
  customer_name   text not null,
  customer_phone  text not null,
  start_date      date not null default current_date,
  months          int  not null default 1 check (months >= 1),       -- defaults to house.min_months
  end_date        date generated always as ((start_date + make_interval(months => months))::date) stored,
  status          text not null default 'active'
                    check (status in ('active','ended','renewed','cancelled')),
  contacted       boolean not null default false,                     -- admin flips once they've reached out
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ht_end_idx   on public.house_tenancies (end_date);
create index if not exists ht_owner_idx  on public.house_tenancies (owner_user_id);
create index if not exists ht_house_idx  on public.house_tenancies (house_id);

alter table public.house_tenancies enable row level security;

drop policy if exists "ht owner+admin read" on public.house_tenancies;
drop policy if exists "ht owner insert"     on public.house_tenancies;
drop policy if exists "ht owner update"     on public.house_tenancies;
drop policy if exists "ht admin update"     on public.house_tenancies;
drop policy if exists "ht owner delete"     on public.house_tenancies;

-- Read: only the owning agent or an admin (phone is PII — never world-readable).
create policy "ht owner+admin read" on public.house_tenancies for select
  using (owner_user_id = auth.uid() or public.is_admin());
-- Write: the owning agent manages their own tenant records.
create policy "ht owner insert" on public.house_tenancies for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "ht owner update" on public.house_tenancies for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
-- Admin may update (e.g. flip the `contacted` flag during follow-up).
create policy "ht admin update" on public.house_tenancies for update
  using (public.is_admin()) with check (public.is_admin());
create policy "ht owner delete" on public.house_tenancies for delete
  using (owner_user_id = auth.uid());

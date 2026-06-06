-- ============================================================================
-- PAWA BUS TZ — Master Schema
-- Single file, replaces all schema_v*.sql files.
-- Safe to run on a fresh project or re-run on an existing database.
-- ============================================================================

-- ============================================================================
-- 0. Extensions
-- ============================================================================
create extension if not exists pgcrypto;

-- ============================================================================
-- 1. Shared utility trigger
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

-- ============================================================================
-- 2. Enum types (guarded)
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_type where typname = 'tenant_status') then
    create type tenant_status as enum (
      'pending_approval','active','suspended','rejected'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tenant_role') then
    create type tenant_role as enum ('owner','admin','agent','staff');
  end if;
end $$;

-- ============================================================================
-- 3. admins  (defined first — all helper functions depend on it)
-- ============================================================================
create table if not exists public.admins (
  email      text primary key,
  full_name  text,
  role       text not null default 'admin'
    check (role in ('admin','accountant','auditor')),
  created_at timestamptz not null default now()
);

insert into public.admins (email, full_name, role)
values ('pawa4761@gmail.com', 'Owner', 'admin')
on conflict (email) do nothing;

alter table public.admins enable row level security;

-- ============================================================================
-- 4. Helper functions  (defined before any table policy that uses them)
-- ============================================================================

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
  );
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
  );
$$;

create or replace function public.is_finance_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
      and role in ('admin','accountant','auditor')
  );
$$;

-- Uses PL/pgSQL so table validation is lazy (tenant_users created later)
create or replace function public.current_user_tenant_ids()
returns setof uuid language plpgsql stable security definer set search_path = public as $$
begin
  return query select tenant_id from public.tenant_users where user_id = auth.uid();
end;
$$;

-- admins RLS (needs is_admin which is now defined)
drop policy if exists "admins read self" on public.admins;
drop policy if exists "admins write"     on public.admins;
create policy "admins read self" on public.admins for select using (public.is_admin());
create policy "admins write"     on public.admins for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 5. regions
-- ============================================================================
create table if not exists public.regions (
  name text primary key
);

alter table public.regions enable row level security;
drop policy if exists "regions readable"    on public.regions;
drop policy if exists "regions admin write" on public.regions;
create policy "regions readable"    on public.regions for select using (true);
create policy "regions admin write" on public.regions for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 6. buses
-- ============================================================================
create table if not exists public.buses (
  id            text primary key,
  name          text not null,
  contact       text not null default '',
  contacts      jsonb not null default '[]'::jsonb,
  routes        jsonb not null default '[]'::jsonb,
  about         text,
  hq            text,
  website       text,
  year_founded  int,
  seats_total   int not null default 50,
  fare_per_km   numeric not null default 80,
  payment_note  text,
  photo_path    text,
  verified      boolean not null default true,
  ticket_prefix text,
  ticket_seq    bigint not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists buses_ticket_prefix_key
  on public.buses (ticket_prefix) where ticket_prefix is not null;

alter table public.buses enable row level security;
drop policy if exists "buses readable"    on public.buses;
drop policy if exists "buses admin write" on public.buses;
create policy "buses readable"    on public.buses for select using (true);
create policy "buses admin write" on public.buses for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 7. agents
-- ============================================================================
create table if not exists public.agents (
  id               text primary key,
  name             text not null,
  phone            text not null,
  phones           text[] not null default '{}',
  region           text not null references public.regions(name) on update cascade,
  terminal         text,
  buses            text[] not null default '{}',
  email            text,
  national_id      text,
  experience_years int not null default 1,
  about            text,
  photo_path       text,
  verified         boolean not null default true,
  rating_avg       numeric not null default 0,
  rating_count     int not null default 0,
  created_at       timestamptz not null default now()
);

alter table public.agents enable row level security;
drop policy if exists "agents readable"    on public.agents;
drop policy if exists "agents admin write" on public.agents;
create policy "agents readable"    on public.agents for select using (true);
create policy "agents admin write" on public.agents for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 8. agent_applications
-- ============================================================================
create table if not exists public.agent_applications (
  id               bigserial primary key,
  full_name        text not null,
  phone            text not null,
  phones           text[] not null default '{}',
  email            text,
  region           text not null references public.regions(name) on update cascade,
  terminal         text not null,
  buses            text[] not null default '{}',
  experience_years int not null default 1 check (experience_years >= 1),
  national_id      text,
  about            text,
  status           text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reject_reason    text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint app_buses_nonempty check (array_length(buses, 1) >= 1)
);

create index if not exists agent_apps_status_idx
  on public.agent_applications (status, created_at);

alter table public.agent_applications enable row level security;
drop policy if exists "applications insert public" on public.agent_applications;
drop policy if exists "applications read admin"    on public.agent_applications;
drop policy if exists "applications update admin"  on public.agent_applications;
create policy "applications insert public" on public.agent_applications
  for insert with check (true);
create policy "applications read admin" on public.agent_applications
  for select using (public.is_admin());
create policy "applications update admin" on public.agent_applications
  for update using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- 9. agent_reviews
-- ============================================================================
create table if not exists public.agent_reviews (
  id             bigserial primary key,
  agent_id       text not null references public.agents(id) on delete cascade,
  tracking_code  text,
  rater_phone    text not null,
  rater_name     text,
  rating         int not null check (rating between 1 and 5),
  comment        text,
  created_at     timestamptz not null default now(),
  unique (agent_id, tracking_code, rater_phone)
);

create index if not exists agent_reviews_agent_idx
  on public.agent_reviews (agent_id, created_at);

alter table public.agent_reviews enable row level security;
drop policy if exists "reviews readable"     on public.agent_reviews;
drop policy if exists "reviews insertable"   on public.agent_reviews;
drop policy if exists "reviews admin delete" on public.agent_reviews;
create policy "reviews readable"     on public.agent_reviews for select using (true);
create policy "reviews insertable"   on public.agent_reviews for insert with check (true);
create policy "reviews admin delete" on public.agent_reviews
  for delete using (public.is_admin());

create or replace function public.recompute_agent_rating(p_agent_id text)
returns void language sql as $$
  update public.agents a
  set rating_avg   = coalesce((select avg(rating)::numeric(3,2)
                               from public.agent_reviews where agent_id = p_agent_id), 0),
      rating_count = (select count(*) from public.agent_reviews where agent_id = p_agent_id)
  where a.id = p_agent_id;
$$;

create or replace function public.trg_agent_review_changed()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform public.recompute_agent_rating(old.agent_id); return old;
  else perform public.recompute_agent_rating(new.agent_id); return new;
  end if;
end;
$$;

drop trigger if exists agent_reviews_aiud on public.agent_reviews;
create trigger agent_reviews_aiud
  after insert or update or delete on public.agent_reviews
  for each row execute function public.trg_agent_review_changed();

-- ============================================================================
-- 10. shipments
-- ============================================================================
create table if not exists public.shipments (
  tracking_code           text primary key,
  sender_name             text not null,
  sender_phone            text not null,
  sender_region           text not null,
  receiver_name           text not null,
  receiver_phone          text not null,
  receiver_region         text not null,
  product_description     text not null,
  product_weight_kg       numeric not null,
  product_size_category   text check (product_size_category in ('small','medium','large')),
  product_suggested_fee   numeric(14,2) not null default 0,
  product_freight_fee     numeric(14,2) not null default 0,
  product_value_tzs       numeric not null default 0,
  insured                 boolean not null default true,
  bus_name                text not null,
  bus_route               text not null,
  bus_departure           text not null,
  agent_origin_name       text,
  agent_origin_phone      text,
  agent_destination_name  text,
  agent_destination_phone text,
  status                  text not null default 'Awaiting Price'
    check (status in (
      'Awaiting Price','Needs Revision',
      'Registered','Collected','Picked Up',
      'In Transit','Arrived','Delivered'
    )),
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists shipments_sender_phone_idx   on public.shipments (sender_phone);
create index if not exists shipments_receiver_phone_idx on public.shipments (receiver_phone);
create index if not exists shipments_status_idx         on public.shipments (status);

alter table public.shipments enable row level security;
drop policy if exists "shipments readable"   on public.shipments;
drop policy if exists "shipments insertable" on public.shipments;
drop policy if exists "shipments updatable"  on public.shipments;
create policy "shipments readable"   on public.shipments for select using (true);
create policy "shipments insertable" on public.shipments for insert with check (true);
create policy "shipments updatable"  on public.shipments for update using (true);

drop trigger if exists trg_shipments_updated on public.shipments;
create trigger trg_shipments_updated
  before update on public.shipments
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 11. shipment_messages
-- ============================================================================
create table if not exists public.shipment_messages (
  id             bigserial primary key,
  tracking_code  text not null references public.shipments(tracking_code) on delete cascade,
  from_role      text not null
    check (from_role in ('sender','receiver','agent_origin','agent_destination','system')),
  from_name      text not null,
  message        text not null,
  created_at     timestamptz not null default now()
);

create index if not exists shipment_messages_code_idx
  on public.shipment_messages (tracking_code, created_at);

alter table public.shipment_messages enable row level security;
drop policy if exists "messages readable"   on public.shipment_messages;
drop policy if exists "messages insertable" on public.shipment_messages;
create policy "messages readable"   on public.shipment_messages for select using (true);
create policy "messages insertable" on public.shipment_messages for insert with check (true);

-- ============================================================================
-- 12. bookings
-- ============================================================================
create table if not exists public.bookings (
  ticket_code      text primary key,
  bus_id           text,
  bus_name         text not null,
  origin           text not null,
  destination      text not null,
  travel_date      date not null,
  departure_time   text,
  seat_number      int,
  passenger_name   text not null,
  passenger_phone  text not null,
  passenger_id_no  text,
  whatsapp_phone   text,
  fare_tzs         numeric not null default 0,
  trip_purpose     text,
  return_duration  text,
  status           text not null default 'pending'
    check (status in (
      'pending','confirmed','expired','cancelled',
      'rescheduled','refund_initiated','boarded','completed'
    )),
  refund_tzs       numeric not null default 0,
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Idempotent column add: the VAPI reserve-seat workflow writes expires_at
-- so the dashboard "Pending holds" card can show how long is left on each hold.
alter table public.bookings add column if not exists expires_at timestamptz;
create index if not exists bookings_expires_idx on public.bookings (expires_at)
  where status = 'pending';

create index if not exists bookings_phone_idx    on public.bookings (passenger_phone);
create index if not exists bookings_status_idx   on public.bookings (status, travel_date);
create index if not exists bookings_bus_date_idx on public.bookings (bus_id, travel_date, departure_time);
-- Prevents two active bookings for the same seat on the same trip
create unique index if not exists bookings_active_seat_idx
  on public.bookings (bus_id, travel_date, seat_number)
  where status not in ('expired','cancelled','refunded');

alter table public.bookings enable row level security;
drop policy if exists "bookings public read"   on public.bookings;
drop policy if exists "bookings public insert" on public.bookings;
drop policy if exists "bookings public update" on public.bookings;
create policy "bookings public read"   on public.bookings for select using (true);
create policy "bookings public insert" on public.bookings for insert with check (true);
create policy "bookings public update" on public.bookings for update using (true);

drop trigger if exists trg_bookings_updated on public.bookings;
create trigger trg_bookings_updated
  before update on public.bookings
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 13. call_requests
-- ============================================================================
create table if not exists public.call_requests (
  id            bigserial primary key,
  phone         text not null,
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending'
    check (status in ('pending','dialing','started','handled','failed')),
  ticket_code   text,
  context       jsonb,
  at_session_id text,
  vapi_call_id  text,
  attempt_count int not null default 0,
  created_at    timestamptz not null default now()
);

-- Idempotent column additions for existing deployments
alter table public.call_requests add column if not exists ticket_code   text;
alter table public.call_requests add column if not exists context       jsonb;
alter table public.call_requests add column if not exists at_session_id text;
alter table public.call_requests add column if not exists vapi_call_id  text;
alter table public.call_requests add column if not exists attempt_count int not null default 0;
alter table public.call_requests add column if not exists last_error    text;
alter table public.call_requests add column if not exists purpose       text;
alter table public.call_requests add column if not exists created_by    text;

create index if not exists call_requests_status_idx
  on public.call_requests (status, requested_at);

alter table public.call_requests enable row level security;
drop policy if exists "call_requests public insert" on public.call_requests;
drop policy if exists "call_requests admin read"    on public.call_requests;
drop policy if exists "call_requests admin update"  on public.call_requests;
create policy "call_requests public insert" on public.call_requests for insert with check (true);
create policy "call_requests admin read"    on public.call_requests for select using (public.is_admin());
create policy "call_requests admin update"  on public.call_requests for update using (public.is_admin());

-- ============================================================================
-- 14. cash_retargets
-- ============================================================================
create table if not exists public.cash_retargets (
  id               bigserial primary key,
  ticket_code      text not null,
  bus_name         text,
  route            text,
  seat_number      int,
  passenger_phone  text,
  fare_tzs         numeric not null default 0,
  trip_purpose     text,
  return_duration  text,
  payment_method   text not null default 'cash',
  retarget_status  text not null default 'pending_record'
    check (retarget_status in ('pending_record','recorded','cancelled')),
  customer_name    text,
  customer_phone   text,
  recorded_by      text,
  recorded_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists cash_retargets_status_idx on public.cash_retargets (retarget_status, created_at);
create index if not exists cash_retargets_ticket_idx on public.cash_retargets (ticket_code);

alter table public.cash_retargets enable row level security;
drop policy if exists "cash_retargets public insert" on public.cash_retargets;
drop policy if exists "cash_retargets public read"   on public.cash_retargets;
drop policy if exists "cash_retargets public update" on public.cash_retargets;
create policy "cash_retargets public insert" on public.cash_retargets for insert with check (true);
create policy "cash_retargets public read"   on public.cash_retargets for select using (true);
create policy "cash_retargets public update" on public.cash_retargets for update using (true);

-- ============================================================================
-- 15. payments
-- ============================================================================
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null,
  reference_type  text not null
    check (reference_type in ('booking','shipment','agent_topup','reschedule','other')),
  amount_tzs      numeric(12,2) not null check (amount_tzs > 0),
  currency        text not null default 'TZS',
  customer_name   text,
  customer_phone  text not null,
  customer_email  text,
  method          text not null check (method in (
    'mpesa','tigopesa','airtel','halopesa','azampesa',
    'nmb','crdb','nbc','equity','stanbic','other_bank',
    'card','cash','bank_transfer'
  )),
  provider        text check (provider in (
    'selcom','clickpesa','azampay','flutterwave',
    'pesapal','manual','vapi','cash','demo'
  )),
  provider_ref    text,
  ussd_session    text,
  external_ref    text,
  bank_reference  text,
  payment_url     text,
  instructions    text,
  status          text not null default 'pending' check (status in (
    'pending','awaiting_payment','processing',
    'completed','failed','cancelled','refunded','expired'
  )),
  paid_at         timestamptz,
  expires_at      timestamptz not null default (now() + interval '15 minutes'),
  attempts        int not null default 0,
  error_message   text,
  raw_request     jsonb,
  raw_response    jsonb,
  raw_callback    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists payments_reference_active_idx
  on public.payments (reference)
  where status in ('pending','awaiting_payment','processing','completed');
create index if not exists payments_status_created_idx on public.payments (status, created_at desc);
create index if not exists payments_reference_idx      on public.payments (reference);
create index if not exists payments_provider_ref_idx   on public.payments (provider_ref)
  where provider_ref is not null;
create index if not exists payments_phone_idx          on public.payments (customer_phone);

alter table public.payments enable row level security;
drop policy if exists "anon_insert_payments"    on public.payments;
drop policy if exists "anon_select_payments"    on public.payments;
drop policy if exists "service_update_payments" on public.payments;
drop policy if exists "admin_update_payments"   on public.payments;
create policy "anon_insert_payments"
  on public.payments for insert to anon, authenticated with check (true);
create policy "anon_select_payments"
  on public.payments for select to anon, authenticated using (true);
create policy "service_update_payments"
  on public.payments for update to service_role using (true) with check (true);
create policy "admin_update_payments"
  on public.payments for update to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email()))
  with check (exists (select 1 from public.admins a where a.email = auth.email()));

drop trigger if exists trg_payments_updated on public.payments;
create trigger trg_payments_updated
  before update on public.payments
  for each row execute function public.touch_updated_at();

create or replace function public.handle_payment_completion()
returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and (old.status is null or old.status <> 'completed') then
    if new.paid_at is null then new.paid_at := now(); end if;
    if new.reference_type in ('booking','reschedule') then
      update public.bookings set status = 'confirmed'
      where ticket_code = new.reference and status in ('pending','awaiting_payment');
    elsif new.reference_type = 'shipment' then
      update public.shipments
      set notes = coalesce(notes,'') || E'\n[paid '
            || to_char(now(),'YYYY-MM-DD HH24:MI') || ' via ' || new.method
            || ' — ' || coalesce(new.provider_ref,'manual') || ']'
      where tracking_code = new.reference;
    end if;
  end if;
  if new.status = 'refunded' and (old.status is null or old.status <> 'refunded') then
    if new.reference_type in ('booking','reschedule') then
      update public.bookings set status = 'cancelled',
        cancelled_at = coalesce(cancelled_at, now())
      where ticket_code = new.reference;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_complete on public.payments;
create trigger trg_payment_complete
  before insert or update on public.payments
  for each row execute function public.handle_payment_completion();

-- ============================================================================
-- 16. payment_callbacks
-- ============================================================================
create table if not exists public.payment_callbacks (
  id           bigserial primary key,
  payment_id   uuid references public.payments(id) on delete set null,
  provider     text,
  event_type   text,
  signature_ok boolean default true,
  http_status  int,
  ip_address   text,
  raw_headers  jsonb,
  raw_body     jsonb,
  received_at  timestamptz not null default now()
);

create index if not exists payment_callbacks_payment_idx
  on public.payment_callbacks (payment_id, received_at desc);
create index if not exists payment_callbacks_provider_idx
  on public.payment_callbacks (provider, received_at desc);

alter table public.payment_callbacks enable row level security;
drop policy if exists "service_insert_callbacks" on public.payment_callbacks;
drop policy if exists "admin_select_callbacks"   on public.payment_callbacks;
create policy "service_insert_callbacks"
  on public.payment_callbacks for insert to service_role with check (true);
create policy "admin_select_callbacks"
  on public.payment_callbacks for select to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email()));

-- ============================================================================
-- 17. tax_rates
-- ============================================================================
create table if not exists public.tax_rates (
  id          text primary key,
  name        text not null,
  rate_pct    numeric(6,3) not null,
  applies_to  text,
  description text,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

insert into public.tax_rates (id, name, rate_pct, applies_to, description) values
  ('vat',          'Value Added Tax (VAT)',          18, 'revenue',  'Standard VAT — bus tickets and cargo.'),
  ('vat_zero',     'VAT Zero-Rated',                  0, 'revenue',  'Zero-rated goods (foodstuffs, medicines).'),
  ('wht_services', 'Withholding Tax — Services',      5, 'services', 'WHT on service payments.'),
  ('wht_rent',     'Withholding Tax — Rent',         10, 'rent',     'WHT on rental payments.'),
  ('wht_dividend', 'Withholding Tax — Dividends',    10, 'dividend', 'WHT on dividends.'),
  ('corporate_tax','Corporate Income Tax (CIT)',      30, 'profit',   'CIT on annual taxable profit.'),
  ('paye_a',       'PAYE Band A (≤272,500/mo)',       0, 'salaries', 'No PAYE.'),
  ('paye_b',       'PAYE Band B (272,501–620,000)',   9, 'salaries', '9% PAYE.'),
  ('paye_c',       'PAYE Band C (620,001–1,200,000)',20, 'salaries', '20% PAYE.'),
  ('paye_d',       'PAYE Band D (1.2M–3.45M)',       25, 'salaries', '25% PAYE.'),
  ('paye_e',       'PAYE Band E (>3.45M/mo)',        30, 'salaries', '30% PAYE.'),
  ('skills_levy',  'Skills & Development Levy (SDL)', 4, 'salaries', '4% of gross salaries to VETA.')
on conflict (id) do nothing;

alter table public.tax_rates enable row level security;
drop policy if exists "tax_rates readable"      on public.tax_rates;
drop policy if exists "tax_rates finance write" on public.tax_rates;
create policy "tax_rates readable"
  on public.tax_rates for select to anon, authenticated using (true);
create policy "tax_rates finance write"
  on public.tax_rates for all to authenticated
  using (public.is_finance_user()) with check (public.is_finance_user());

-- ============================================================================
-- 18. org_expenses
-- ============================================================================
create table if not exists public.org_expenses (
  id              bigserial primary key,
  bus_company_id  text references public.buses(id) on delete set null,
  category        text not null check (category in (
    'fuel','salaries','maintenance','insurance','marketing',
    'office','tax_payment','licensing','repairs','other'
  )),
  description     text not null,
  amount_tzs      numeric(14,2) not null check (amount_tzs > 0),
  period_date     date not null,
  recorded_by     text not null,
  notes           text,
  receipt_ref     text,
  created_at      timestamptz not null default now()
);

create index if not exists org_expenses_date_idx on public.org_expenses (period_date desc);
create index if not exists org_expenses_bus_idx  on public.org_expenses (bus_company_id, period_date desc);
create index if not exists org_expenses_cat_idx  on public.org_expenses (category, period_date desc);

alter table public.org_expenses enable row level security;
drop policy if exists "expenses finance read"      on public.org_expenses;
drop policy if exists "expenses accountant write"  on public.org_expenses;
drop policy if exists "expenses accountant update" on public.org_expenses;
drop policy if exists "expenses admin delete"      on public.org_expenses;
create policy "expenses finance read"
  on public.org_expenses for select to authenticated using (public.is_finance_user());
create policy "expenses accountant write"
  on public.org_expenses for insert to authenticated with check (public.is_finance_user());
-- UPDATE/DELETE intentionally NOT exposed via RLS to authenticated users.
-- Originals are immutable from the API; corrections go through the
-- ledger_adjustments overlay. Admins can still fix data via the Supabase
-- dashboard (service_role bypasses RLS). Belt-and-braces: we also revoke the
-- table-level grant below, so even if a permissive policy is added later,
-- the role itself lacks the UPDATE/DELETE privilege.
revoke update, delete on public.org_expenses from authenticated;
revoke update, delete on public.org_expenses from anon;

grant select, insert on public.org_expenses to authenticated;
grant usage, select on sequence public.org_expenses_id_seq to authenticated;
grant select on public.tax_rates to anon, authenticated;

-- ============================================================================
-- 18b. org_adjustments (editable company-level adjustments: bonuses, deductions, etc.)
-- ============================================================================
create table if not exists public.org_adjustments (
  id              bigserial primary key,
  tenant_id       uuid references public.tenants(id) on delete cascade,
  bus_company_id  text references public.buses(id) on delete set null,
  type            text not null check (type in (
    'bonus','allowance','commission','overtime','deduction','penalty','correction','other'
  )),
  direction       text not null default 'debit' check (direction in ('debit','credit')),
  staff_name      text,
  description     text not null,
  amount_tzs      numeric(14,2) not null check (amount_tzs > 0),
  reference_no    text,
  notes           text,
  recorded_by     text not null,
  approved_by     text,
  period_date     date not null,
  created_at      timestamptz not null default now()
);

create index if not exists org_adj_date_idx on public.org_adjustments (period_date desc);
create index if not exists org_adj_bus_idx  on public.org_adjustments (bus_company_id, period_date desc);
create index if not exists org_adj_type_idx on public.org_adjustments (type, period_date desc);

alter table public.org_adjustments enable row level security;
create policy "adj_all" on public.org_adjustments for all using (true) with check (true);

grant select, insert, update, delete on public.org_adjustments to authenticated;
grant usage, select on sequence public.org_adjustments_id_seq to authenticated;

-- ============================================================================
-- 18c. ledger_adjustments (per-record corrections — editable overlay on top of
--      bookings / shipments / payments. Originals stay untouched; reports
--      sum original + adjustment so an accountant can fix a single fare
--      without rewriting the source row.)
-- ============================================================================
create table if not exists public.ledger_adjustments (
  id           bigserial primary key,
  tenant_id    uuid references public.tenants(id) on delete cascade,
  entity_type  text not null check (entity_type in ('booking','shipment','payment','expense')),
  entity_ref   text,
  data         jsonb not null default '{}'::jsonb,
  amount_tzs   numeric(14,2),
  reason       text,
  recorded_by  text not null,
  period_date  date not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists ledger_adj_period_idx on public.ledger_adjustments (period_date desc);
create index if not exists ledger_adj_entity_idx on public.ledger_adjustments (entity_type, entity_ref);
create index if not exists ledger_adj_tenant_idx on public.ledger_adjustments (tenant_id, period_date desc);

drop trigger if exists trg_ledger_adj_updated on public.ledger_adjustments;
create trigger trg_ledger_adj_updated
  before update on public.ledger_adjustments
  for each row execute function public.touch_updated_at();

alter table public.ledger_adjustments enable row level security;
drop policy if exists "ledger_adj all" on public.ledger_adjustments;
create policy "ledger_adj all" on public.ledger_adjustments for all using (true) with check (true);

grant select, insert, update, delete on public.ledger_adjustments to authenticated;
grant usage, select on sequence public.ledger_adjustments_id_seq to authenticated;

-- ============================================================================
-- 19. meet_rooms
-- ============================================================================
create table if not exists public.meet_rooms (
  id             bigserial primary key,
  code           text not null unique,
  purpose        text,
  tracking_code  text references public.shipments(tracking_code) on delete set null,
  created_by     text,
  status         text not null default 'active'
    check (status in ('active','closed')),
  expires_at     timestamptz not null default (now() + interval '24 hours'),
  created_at     timestamptz not null default now()
);

create index if not exists meet_rooms_code_idx on public.meet_rooms (code);

alter table public.meet_rooms enable row level security;
drop policy if exists "meet_rooms public read"   on public.meet_rooms;
drop policy if exists "meet_rooms public insert" on public.meet_rooms;
drop policy if exists "meet_rooms public update" on public.meet_rooms;
create policy "meet_rooms public read"   on public.meet_rooms for select using (true);
create policy "meet_rooms public insert" on public.meet_rooms for insert with check (true);
create policy "meet_rooms public update" on public.meet_rooms for update using (true);

-- ============================================================================
-- 20. live_locations
-- ============================================================================
create table if not exists public.live_locations (
  id            bigserial primary key,
  room_code     text not null,
  user_id       text not null,
  display_name  text,
  phone         text,
  role          text not null default 'guest',
  lat           double precision not null,
  lng           double precision not null,
  accuracy_m    double precision,
  heading       double precision,
  speed_mps     double precision,
  battery_pct   int,
  status_text   text,
  last_seen     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (room_code, user_id)
);

create index if not exists live_locations_room_idx on public.live_locations (room_code, last_seen);

alter table public.live_locations enable row level security;
drop policy if exists "live_locations public all" on public.live_locations;
create policy "live_locations public all"
  on public.live_locations for all using (true) with check (true);

-- ============================================================================
-- 21. ride_drivers
-- ============================================================================
create table if not exists public.ride_drivers (
  driver_id          text primary key,
  full_name          text not null,
  phone              text not null,
  vehicle_type       text not null,
  vehicle_label      text,
  plate              text,
  license_no         text,
  national_id        text,
  experience_years   int not null default 1,
  selfie_path        text,
  vehicle_photo_path text,
  plate_photo_path   text,
  license_photo_path text,
  captured_lat       double precision,
  captured_lng       double precision,
  rating             numeric not null default 0,
  verified           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.ride_drivers enable row level security;
drop policy if exists "ride_drivers public read"   on public.ride_drivers;
drop policy if exists "ride_drivers public insert" on public.ride_drivers;
drop policy if exists "ride_drivers public update" on public.ride_drivers;
create policy "ride_drivers public read"   on public.ride_drivers for select using (true);
create policy "ride_drivers public insert" on public.ride_drivers for insert with check (true);
create policy "ride_drivers public update" on public.ride_drivers for update using (true);

drop trigger if exists trg_ride_drivers_updated on public.ride_drivers;
create trigger trg_ride_drivers_updated
  before update on public.ride_drivers
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 22. drivers_online
-- ============================================================================
create table if not exists public.drivers_online (
  driver_id     text primary key,
  display_name  text,
  phone         text,
  vehicle_type  text,
  vehicle_label text,
  plate         text,
  lat           double precision,
  lng           double precision,
  heading       double precision,
  status        text not null default 'online'
    check (status in ('online','busy','offline')),
  rating        numeric not null default 0,
  last_seen     timestamptz not null default now()
);

create index if not exists drivers_online_status_idx
  on public.drivers_online (status, last_seen);

alter table public.drivers_online enable row level security;
drop policy if exists "drivers_online public all" on public.drivers_online;
create policy "drivers_online public all"
  on public.drivers_online for all using (true) with check (true);

-- ============================================================================
-- 23. ride_requests
-- ============================================================================
create table if not exists public.ride_requests (
  id              uuid primary key default gen_random_uuid(),
  rider_id        text not null,
  rider_name      text not null,
  rider_phone     text not null,
  pickup_lat      double precision not null,
  pickup_lng      double precision not null,
  pickup_addr     text,
  dropoff_lat     double precision not null,
  dropoff_lng     double precision not null,
  dropoff_addr    text,
  vehicle_type    text not null,
  notes           text,
  distance_km     numeric,
  fare_tzs        numeric not null default 0,
  status          text not null default 'requested'
    check (status in ('requested','accepted','started','completed','cancelled')),
  driver_id       text references public.ride_drivers(driver_id) on delete set null,
  driver_lat      double precision,
  driver_lng      double precision,
  driver_heading  double precision,
  driver_seen_at  timestamptz,
  requested_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ride_requests_status_idx on public.ride_requests (status, requested_at);
create index if not exists ride_requests_rider_idx  on public.ride_requests (rider_id);
create index if not exists ride_requests_driver_idx on public.ride_requests (driver_id);

alter table public.ride_requests enable row level security;
drop policy if exists "ride_requests public all" on public.ride_requests;
create policy "ride_requests public all"
  on public.ride_requests for all using (true) with check (true);

drop trigger if exists trg_ride_requests_updated on public.ride_requests;
create trigger trg_ride_requests_updated
  before update on public.ride_requests
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 24. ride_messages
-- ============================================================================
create table if not exists public.ride_messages (
  id         uuid primary key default gen_random_uuid(),
  ride_id    uuid not null references public.ride_requests(id) on delete cascade,
  from_role  text not null check (from_role in ('driver','rider','system')),
  from_name  text,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists ride_messages_ride_idx on public.ride_messages (ride_id, created_at);

alter table public.ride_messages enable row level security;
drop policy if exists "ride_messages public all" on public.ride_messages;
create policy "ride_messages public all"
  on public.ride_messages for all using (true) with check (true);

-- ============================================================================
-- 25. tenants
-- ============================================================================
create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique
                  check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$'),
  display_name    text not null,
  legal_name      text,
  contact_email   text not null,
  contact_phone   text,
  country         text not null default 'TZ',
  status          tenant_status not null default 'pending_approval',
  owner_user_id   uuid,   -- no FK: owner may not have an auth account yet
  approved_by     uuid,   -- no FK: stores admin's auth.uid() loosely
  approved_at     timestamptz,
  rejection_note  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tenants_status on public.tenants (status);
create index if not exists idx_tenants_owner  on public.tenants (owner_user_id);

drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated
  before update on public.tenants
  for each row execute function public.touch_updated_at();

alter table public.tenants enable row level security;
drop policy if exists "tenant members read"  on public.tenants;
drop policy if exists "tenant signup insert" on public.tenants;
drop policy if exists "tenant admin insert"  on public.tenants;
drop policy if exists "tenant owner update"  on public.tenants;
drop policy if exists "tenant admin delete"  on public.tenants;
create policy "tenant members read" on public.tenants for select to authenticated
  using (public.is_admin() or id in (select public.current_user_tenant_ids()));
create policy "tenant signup insert" on public.tenants for insert to authenticated
  with check (
    (auth.uid() = owner_user_id and status = 'pending_approval')
    or public.is_admin()
  );
create policy "tenant owner update" on public.tenants for update to authenticated
  using  (owner_user_id = auth.uid() or public.is_admin())
  with check (owner_user_id = auth.uid() or public.is_admin());
create policy "tenant admin delete" on public.tenants for delete to authenticated
  using (public.is_admin());

grant select, insert on public.tenants to anon, authenticated;

-- ============================================================================
-- 26. tenant_users
-- ============================================================================
create table if not exists public.tenant_users (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null,   -- no FK: user may not have an auth account yet
  role       tenant_role not null default 'staff',
  invited_by uuid,            -- no FK: stores inviter's auth.uid() loosely
  joined_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_tenant_users_user on public.tenant_users (user_id);

alter table public.tenant_users enable row level security;
drop policy if exists "tenant_users self read"    on public.tenant_users;
drop policy if exists "tenant_users owner write"  on public.tenant_users;
create policy "tenant_users self read" on public.tenant_users for select to authenticated
  using (public.is_super_admin() or user_id = auth.uid()
         or tenant_id in (select public.current_user_tenant_ids()));
create policy "tenant_users owner write" on public.tenant_users for all to authenticated
  using (public.is_super_admin() or exists (
    select 1 from public.tenants t
    where t.id = tenant_users.tenant_id and t.owner_user_id = auth.uid()
  ))
  with check (public.is_super_admin() or exists (
    select 1 from public.tenants t
    where t.id = tenant_users.tenant_id and t.owner_user_id = auth.uid()
  ));

grant select on public.tenant_users to anon, authenticated;

-- ============================================================================
-- 27. tenant_settings
-- ============================================================================
create table if not exists public.tenant_settings (
  tenant_id                  uuid primary key references public.tenants(id) on delete cascade,
  anthropic_api_key_enc      bytea,
  anthropic_model            text not null default 'claude-opus-4-7',
  vapi_private_key_enc       bytea,
  vapi_public_key            text,
  vapi_assistant_id          text,
  vapi_phone_number_id       text,
  at_api_key_enc             bytea,
  at_username                text,
  at_sender_id               text,
  at_whatsapp_number         text,
  payment_gateway            text,
  payment_gateway_token_enc  bytea,
  payment_gateway_secret_enc bytea,
  branding                   jsonb not null default jsonb_build_object(
    'logo_url', null, 'primary_color', '#0B6E4F',
    'company_name_display', null, 'agent_name', 'PAWA', 'tagline', null
  ),
  languages                  text[] not null default array['sw','en'],
  default_language           text not null default 'sw',
  system_prompt_overrides    text,
  monthly_call_quota         integer,
  monthly_sms_quota          integer,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

drop trigger if exists trg_tenant_settings_updated on public.tenant_settings;
create trigger trg_tenant_settings_updated
  before update on public.tenant_settings
  for each row execute function public.touch_updated_at();

alter table public.tenant_settings enable row level security;
drop policy if exists "tenant_settings read"        on public.tenant_settings;
drop policy if exists "tenant_settings owner write" on public.tenant_settings;
create policy "tenant_settings read" on public.tenant_settings for select to authenticated
  using (public.is_super_admin() or tenant_id in (select public.current_user_tenant_ids()));
create policy "tenant_settings owner write" on public.tenant_settings for all to authenticated
  using (public.is_super_admin() or exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_settings.tenant_id
      and tu.user_id = auth.uid() and tu.role in ('owner','admin')
  ))
  with check (public.is_super_admin() or exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_settings.tenant_id
      and tu.user_id = auth.uid() and tu.role in ('owner','admin')
  ));

grant select on public.tenant_settings to authenticated;

-- ============================================================================
-- 28. tenant_invites
-- ============================================================================
create table if not exists public.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  role        tenant_role not null default 'staff',
  token       text not null unique default encode(gen_random_bytes(24),'hex'),
  invited_by  uuid references auth.users(id),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_tenant_invites_email  on public.tenant_invites (email);
create index if not exists idx_tenant_invites_tenant on public.tenant_invites (tenant_id);

alter table public.tenant_invites enable row level security;
drop policy if exists "tenant_invites read"        on public.tenant_invites;
drop policy if exists "tenant_invites admin write" on public.tenant_invites;
create policy "tenant_invites read" on public.tenant_invites for select to authenticated
  using (public.is_super_admin() or tenant_id in (select public.current_user_tenant_ids()));
create policy "tenant_invites admin write" on public.tenant_invites for all to authenticated
  using (public.is_super_admin() or exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_invites.tenant_id
      and tu.user_id = auth.uid() and tu.role in ('owner','admin')
  ))
  with check (public.is_super_admin() or exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_invites.tenant_id
      and tu.user_id = auth.uid() and tu.role in ('owner','admin')
  ));

grant select, insert on public.tenant_invites to authenticated;

-- ============================================================================
-- 29. tenant_secret_status
-- ============================================================================
create table if not exists public.tenant_secret_status (
  tenant_id                 uuid primary key references public.tenants(id) on delete cascade,
  anthropic_configured      boolean not null default false,
  vapi_private_configured   boolean not null default false,
  vapi_assistant_configured boolean not null default false,
  at_configured             boolean not null default false,
  payment_configured        boolean not null default false,
  updated_at                timestamptz not null default now()
);

alter table public.tenant_secret_status enable row level security;
drop policy if exists "tenant_secret_status member read" on public.tenant_secret_status;
create policy "tenant_secret_status member read"
  on public.tenant_secret_status for select
  using (public.is_super_admin()
         or tenant_id in (select public.current_user_tenant_ids()));

-- ============================================================================
-- 30. Encryption helpers (Edge Function use only)
-- ============================================================================
create or replace function public.tenant_encrypt(plaintext text, passphrase text)
returns bytea language sql immutable as $$
  select case when plaintext is null or plaintext = '' then null
              else pgp_sym_encrypt(plaintext, passphrase) end;
$$;

create or replace function public.tenant_decrypt(ciphertext bytea, passphrase text)
returns text language sql immutable as $$
  select case when ciphertext is null then null
              else pgp_sym_decrypt(ciphertext, passphrase) end;
$$;

-- ============================================================================
-- 31. RPC — Bus route management
-- ============================================================================
create or replace function public.add_bus_route(
  p_bus_id text, p_from text, p_to text,
  p_departure text, p_return_departure text, p_duration_hours numeric
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'only admins can add routes'; end if;
  update buses set routes = coalesce(routes,'[]'::jsonb)
    || jsonb_build_object('from',p_from,'to',p_to,'departure',p_departure,'duration_hours',p_duration_hours)
    || jsonb_build_object('from',p_to,'to',p_from,'departure',p_return_departure,'duration_hours',p_duration_hours)
  where id = p_bus_id;
end;
$$;

create or replace function public.remove_bus_route(
  p_bus_id text, p_from text, p_to text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'only admins can remove routes'; end if;
  update buses b set routes = coalesce((
    select jsonb_agg(r) from jsonb_array_elements(b.routes) r
    where not ((r->>'from' = p_from and r->>'to' = p_to)
            or (r->>'from' = p_to   and r->>'to' = p_from))
  ),'[]'::jsonb)
  where b.id = p_bus_id;
end;
$$;

-- ============================================================================
-- 31b. RPC — Tenant status change (admin-only, bypasses RLS via SECURITY DEFINER)
-- ============================================================================
drop function if exists public.set_tenant_status(uuid, text, text);
create or replace function public.set_tenant_status(
  p_tenant_id uuid,
  p_status    text,
  p_note      text default null
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_status tenant_status;
begin
  if not public.is_admin() then
    raise exception 'only admins can change tenant status';
  end if;
  if p_status not in ('active','pending_approval','suspended','rejected') then
    raise exception 'invalid status: %', p_status;
  end if;
  v_status := p_status::tenant_status;
  update public.tenants t
     set status         = v_status,
         approved_at    = case when v_status = 'active'   then now()       else t.approved_at end,
         approved_by    = case when v_status = 'active'   then auth.uid()  else t.approved_by end,
         rejection_note = case when v_status = 'rejected' then p_note      else null end
   where t.id = p_tenant_id;
  if not found then
    raise exception 'tenant not found: %', p_tenant_id;
  end if;
  return p_status;
end;
$$;

grant execute on function public.set_tenant_status(uuid, text, text) to authenticated;

-- ============================================================================
-- 32. RPC — Agent application workflow
-- ============================================================================
create or replace function public.approve_agent_application(p_app_id bigint, p_initial_rating int default null)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  app    agent_applications%rowtype;
  new_id text;
begin
  if not is_admin() then raise exception 'only admins can approve'; end if;
  select * into app from agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;
  if p_initial_rating is not null and (p_initial_rating < 1 or p_initial_rating > 5) then
    raise exception 'rating must be between 1 and 5';
  end if;
  select 'AG' || lpad((coalesce(max(substring(id from 3)::int), 0) + 1)::text, 3, '0')
    into new_id from agents where id ~ '^AG[0-9]+$';
  if new_id is null then new_id := 'AG001'; end if;
  -- tenant_id MUST be carried from the application, otherwise agents.tenant_id
  -- falls back to its demo-tenant default and approved agents vanish from the
  -- approving tenant's dashboard (see supabase/fix_approve_agent_overload.sql).
  insert into agents
    (id, name, phone, region, terminal, buses,
     email, national_id, experience_years, about, verified, photo_path,
     tenant_id, rating_avg, rating_count)
  values
    (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
     app.email, app.national_id, app.experience_years, app.about, true, app.photo_path,
     app.tenant_id,
     coalesce(p_initial_rating, 0),
     case when p_initial_rating is not null then 1 else 0 end);
  update agent_applications
     set status = 'approved',
         reviewed_by = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at = now()
   where id = p_app_id;
  return new_id;
end;
$fn$;
grant execute on function public.approve_agent_application(bigint, int) to authenticated;

create or replace function public.reject_agent_application(p_app_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not is_admin() then raise exception 'only admins can reject'; end if;
  update agent_applications
     set status        = 'rejected',
         reject_reason = p_reason,
         reviewed_by   = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at   = now()
   where id = p_app_id and status = 'pending';
  if not found then raise exception 'application not found or already reviewed'; end if;
end;
$fn$;
grant execute on function public.reject_agent_application(bigint, text) to authenticated;

create or replace function public.check_application_status(p_phone text)
returns table(status text, reject_reason text)
language sql stable security definer set search_path = public as $$
  select a.status, a.reject_reason from agent_applications a
  where a.phone = p_phone or replace(a.phone,' ','') = replace(p_phone,' ','')
  order by a.created_at desc limit 1;
$$;

-- ============================================================================
-- 33. RPC — Shipment tracking code
-- ============================================================================
create or replace function public.generate_tracking_code(p_origin text, p_dest text)
returns text language plpgsql as $$
declare v_o text; v_d text;
begin
  v_o := upper(left(regexp_replace(coalesce(p_origin,''),'[^A-Za-z]','','g'),3));
  if length(v_o)<3 then v_o := rpad(v_o,3,'X'); end if;
  v_d := upper(left(regexp_replace(coalesce(p_dest,''),'[^A-Za-z]','','g'),3));
  if length(v_d)<3 then v_d := rpad(v_d,3,'X'); end if;
  return 'TZ-'||v_o||'-'||v_d||'-'||to_char(now(),'YYYYMMDD')||'-'
    ||lpad((floor(random()*9000+1000))::text,4,'0');
end;
$$;

-- ============================================================================
-- 34. RPC — Agent photo
-- ============================================================================
create or replace function public.update_agent_photo(p_phone text, p_photo_path text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update agents set photo_path = p_photo_path
  where phone = p_phone
     or phone = regexp_replace(p_phone,'\s','','g')
     or p_phone = any(phones);
  return found;
end;
$$;
grant execute on function public.update_agent_photo(text, text) to anon, authenticated;
grant execute on function public.check_application_status(text)  to anon, authenticated;
grant execute on function public.generate_tracking_code(text,text) to anon, authenticated;
grant execute on function public.add_bus_route(text,text,text,text,numeric)  to authenticated;
grant execute on function public.remove_bus_route(text,text)                 to authenticated;
grant execute on function public.update_tenant_branding(uuid,jsonb,text[],text,text) to authenticated;
grant execute on function public.register_ride_driver(text,text,text,text,int,text,text,text,text) to anon, authenticated;
grant execute on function public.driver_heartbeat(text,numeric,numeric) to anon, authenticated;
grant execute on function public.recompute_agent_rating(text) to authenticated;

-- ============================================================================
-- 35. RPC — Tenant branding
-- ============================================================================
create or replace function public.update_tenant_branding(
  _tenant_id uuid, _branding jsonb, _languages text[],
  _default_language text, _system_prompt_overrides text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() and not exists (
    select 1 from tenant_users tu
    where tu.tenant_id = _tenant_id and tu.user_id = auth.uid() and tu.role='admin'
  ) then raise exception 'only tenant admins can update branding'; end if;
  insert into tenant_settings (tenant_id,branding,languages,default_language,system_prompt_overrides,updated_at)
  values (_tenant_id,_branding,_languages,_default_language,_system_prompt_overrides,now())
  on conflict (tenant_id) do update set
    branding=excluded.branding, languages=excluded.languages,
    default_language=excluded.default_language,
    system_prompt_overrides=excluded.system_prompt_overrides, updated_at=now();
end;
$$;

-- ============================================================================
-- 36. RPC — Ride driver registration and heartbeat
-- ============================================================================
create or replace function public.register_ride_driver(
  p_driver_id text, p_full_name text, p_phone text, p_vehicle_type text,
  p_vehicle_label text, p_plate text, p_license_no text, p_national_id text,
  p_experience_years int, p_selfie_path text, p_vehicle_photo_path text,
  p_plate_photo_path text, p_license_photo_path text,
  p_captured_lat double precision, p_captured_lng double precision
) returns text language plpgsql as $$
begin
  insert into ride_drivers (
    driver_id,full_name,phone,vehicle_type,vehicle_label,plate,
    license_no,national_id,experience_years,
    selfie_path,vehicle_photo_path,plate_photo_path,license_photo_path,
    captured_lat,captured_lng
  ) values (
    p_driver_id,p_full_name,p_phone,p_vehicle_type,p_vehicle_label,p_plate,
    p_license_no,p_national_id,p_experience_years,
    p_selfie_path,p_vehicle_photo_path,p_plate_photo_path,p_license_photo_path,
    p_captured_lat,p_captured_lng
  )
  on conflict (driver_id) do update set
    full_name=excluded.full_name, phone=excluded.phone,
    vehicle_type=excluded.vehicle_type, vehicle_label=excluded.vehicle_label,
    plate=excluded.plate, license_no=excluded.license_no,
    national_id=excluded.national_id, experience_years=excluded.experience_years,
    selfie_path=coalesce(excluded.selfie_path,ride_drivers.selfie_path),
    vehicle_photo_path=coalesce(excluded.vehicle_photo_path,ride_drivers.vehicle_photo_path),
    plate_photo_path=coalesce(excluded.plate_photo_path,ride_drivers.plate_photo_path),
    license_photo_path=coalesce(excluded.license_photo_path,ride_drivers.license_photo_path),
    captured_lat=excluded.captured_lat, captured_lng=excluded.captured_lng, updated_at=now();
  return p_driver_id;
end;
$$;

create or replace function public.driver_heartbeat(
  p_driver_id text, p_display_name text, p_phone text,
  p_vehicle_type text, p_vehicle_label text, p_plate text,
  p_lat double precision, p_lng double precision,
  p_heading double precision, p_status text
) returns void language plpgsql as $$
begin
  insert into drivers_online (
    driver_id,display_name,phone,vehicle_type,vehicle_label,plate,
    lat,lng,heading,status,last_seen
  ) values (
    p_driver_id,p_display_name,p_phone,p_vehicle_type,p_vehicle_label,p_plate,
    p_lat,p_lng,p_heading,p_status,now()
  )
  on conflict (driver_id) do update set
    display_name=excluded.display_name, phone=excluded.phone,
    vehicle_type=excluded.vehicle_type, vehicle_label=excluded.vehicle_label,
    plate=excluded.plate, lat=excluded.lat, lng=excluded.lng,
    heading=excluded.heading, status=excluded.status, last_seen=now();
end;
$$;

-- ============================================================================
-- 37. RPC — Scheduled cleanup (call via pg_cron or n8n)
-- ============================================================================
create or replace function public.expire_stale_ride_requests()
returns void language sql as $$
  update public.ride_requests set status='cancelled'
  where status='requested' and requested_at < now() - interval '10 minutes';
$$;

create or replace function public.expire_stale_drivers()
returns void language sql as $$
  update public.drivers_online set status='offline'
  where status in ('online','busy') and last_seen < now() - interval '3 minutes';
$$;

create or replace function public.expire_meet_rooms()
returns void language sql as $$
  update public.meet_rooms set status='closed'
  where status='active' and expires_at < now();
$$;

-- ============================================================================
-- 38. Realtime publications (guarded — safe to re-run)
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='shipments') then
    alter publication supabase_realtime add table public.shipments; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='shipment_messages') then
    alter publication supabase_realtime add table public.shipment_messages; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='agent_applications') then
    alter publication supabase_realtime add table public.agent_applications; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='agent_reviews') then
    alter publication supabase_realtime add table public.agent_reviews; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='bookings') then
    alter publication supabase_realtime add table public.bookings; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='call_requests') then
    alter publication supabase_realtime add table public.call_requests; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='cash_retargets') then
    alter publication supabase_realtime add table public.cash_retargets; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='payments') then
    alter publication supabase_realtime add table public.payments; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='live_locations') then
    alter publication supabase_realtime add table public.live_locations; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='drivers_online') then
    alter publication supabase_realtime add table public.drivers_online; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='ride_requests') then
    alter publication supabase_realtime add table public.ride_requests; end if; end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='ride_messages') then
    alter publication supabase_realtime add table public.ride_messages; end if; end $$;

-- ============================================================================
-- 39. Admin dashboard view
-- ============================================================================
create or replace view public.payments_overview as
select p.id, p.reference, p.reference_type, p.amount_tzs, p.method, p.provider,
  p.status, p.customer_name, p.customer_phone, p.provider_ref,
  p.external_ref, p.paid_at, p.created_at,
  case
    when p.reference_type in ('booking','reschedule')
      then (select b.bus_name||' · '||b.origin||' → '||b.destination
            from public.bookings b where b.ticket_code = p.reference)
    when p.reference_type = 'shipment'
      then (select s.sender_name||' → '||s.receiver_name
            from public.shipments s where s.tracking_code = p.reference)
    else null
  end as link_summary
from public.payments p order by p.created_at desc;

grant select on public.payments_overview to anon, authenticated;

-- ============================================================================
-- 40. Demo tenant seed
-- ============================================================================
insert into public.tenants (id, slug, display_name, legal_name, contact_email, status, approved_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'bus-tz-pawa','Bus TZ PAWA','Bus TZ PAWA Limited','pawa4761@gmail.com','active',now()
) on conflict (slug) do nothing;

insert into public.tenant_settings (tenant_id, anthropic_model, branding, languages, default_language)
values (
  '00000000-0000-0000-0000-000000000001', 'claude-opus-4-7',
  jsonb_build_object('logo_url',null,'primary_color','#0B6E4F',
    'company_name_display','Bus TZ PAWA','agent_name','PAWA',
    'tagline','Tunakufanya usafiri kwa urahisi, usalama, na starehe.'),
  array['sw','en'], 'sw'
) on conflict (tenant_id) do nothing;

insert into public.tenant_secret_status (tenant_id)
values ('00000000-0000-0000-0000-000000000001')
on conflict (tenant_id) do nothing;

-- ============================================================================
-- 41. Multi-tenant column backfill
--     Adds tenant_id FK to every data table that doesn't already have it.
--     Must run AFTER section 40 so the demo tenant row exists for the default.
--     Idempotent — safe to re-run.
-- ============================================================================
do $tenant_cols$
declare
  t text;
  tenant_tables text[] := array[
    'buses','agents','agent_applications','agent_reviews',
    'shipments','shipment_messages',
    'bookings','payments','payment_callbacks',
    'call_requests','cash_retargets',
    'org_expenses','tax_rates',
    'meet_rooms','live_locations',
    'ride_requests','ride_drivers','ride_messages','drivers_online'
  ];
begin
  foreach t in array tenant_tables loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise notice 'skipping % (table not present)', t;
      continue;
    end if;

    -- Add column only if missing
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'tenant_id'
    ) then
      execute format($f$
        alter table public.%I
        add column tenant_id uuid
          not null default '00000000-0000-0000-0000-000000000001'
          references public.tenants(id) on delete restrict
      $f$, t);
      raise notice 'tenant_id added to public.%', t;
    end if;

    -- Index
    execute format($f$
      create index if not exists %I on public.%I (tenant_id)
    $f$, 'idx_' || t || '_tenant', t);

  end loop;
end $tenant_cols$;

-- Composite indexes for common query patterns
do $cidx$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='shipments' and column_name='tenant_id') then
    create index if not exists idx_shipments_tenant_status   on public.shipments (tenant_id, status);
    create index if not exists idx_shipments_tenant_tracking on public.shipments (tenant_id, tracking_code);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bookings' and column_name='tenant_id') then
    create index if not exists idx_bookings_tenant_status    on public.bookings  (tenant_id, status);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='agents' and column_name='tenant_id') then
    create index if not exists idx_agents_tenant_region      on public.agents    (tenant_id, region);
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='call_requests' and column_name='tenant_id') then
    create index if not exists idx_call_requests_tenant_status on public.call_requests (tenant_id, status, requested_at);
  end if;
end $cidx$;

-- ============================================================================
-- 42. Tenant SaaS write policies
--     Grants company owners/admins the ability to manage their own rows
--     without needing platform-level admin access.
--     Idempotent — safe to re-run.
-- ============================================================================

-- BUSES — tenant owners/admins can INSERT/UPDATE/DELETE their own rows
drop policy if exists "buses tenant write" on public.buses;
create policy "buses tenant write" on public.buses
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- AGENTS — tenant owners/admins can INSERT/UPDATE/DELETE their own rows
drop policy if exists "agents tenant write" on public.agents;
create policy "agents tenant write" on public.agents
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- AGENT APPLICATIONS — tenant members can READ; owners/admins can UPDATE
drop policy if exists "applications read tenant" on public.agent_applications;
create policy "applications read tenant" on public.agent_applications
  for select to authenticated
  using (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

drop policy if exists "applications update tenant" on public.agent_applications;
create policy "applications update tenant" on public.agent_applications
  for update to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  )
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- SHIPMENTS — tenant members can read/write their own shipments
drop policy if exists "shipments tenant write" on public.shipments;
create policy "shipments tenant write" on public.shipments
  for all to authenticated
  using (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  )
  with check (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

-- ORG EXPENSES — tenant owners/admins only
-- Tenant-scoped INSERT only. UPDATE/DELETE on org_expenses are intentionally
-- not exposed via RLS to authenticated users (see section 18); corrections
-- go through ledger_adjustments. Admins use the Supabase dashboard
-- (service_role bypasses RLS) for genuine deletes.
drop policy if exists "org_expenses tenant write" on public.org_expenses;
create policy "org_expenses tenant insert" on public.org_expenses
  for insert to authenticated
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

-- ============================================================================
-- 43. claim_ticket — atomic seat booking with per-company ticket numbering
--     Increments company sequence, generates PREFIX-YYMMDD-SSSSS code,
--     inserts booking. Unique partial index prevents double-booking same seat.
-- ============================================================================
create or replace function public.claim_ticket(
  p_bus_id          text,
  p_seat_number     int,
  p_travel_date     date,
  p_departure_time  text    default null,
  p_origin          text    default null,
  p_destination     text    default null,
  p_passenger_name  text    default null,
  p_passenger_phone text    default null,
  p_fare_tzs        numeric default 0,
  p_passenger_id_no text    default null,
  p_trip_purpose    text    default 'manual',
  p_return_duration text    default 'one-way'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_bus     buses%rowtype;
  v_prefix  text;
  v_seq     bigint;
  v_ticket  text;
begin
  select * into v_bus from buses where id = p_bus_id for update;
  if not found then raise exception 'Bus not found: %', p_bus_id; end if;

  v_prefix := coalesce(
    v_bus.ticket_prefix,
    upper(left(regexp_replace(v_bus.name, '[^A-Za-z]', '', 'g'), 4))
  );
  if v_prefix is null or v_prefix = '' then v_prefix := 'TK'; end if;

  update buses set ticket_seq = ticket_seq + 1
  where id = p_bus_id returning ticket_seq into v_seq;

  v_ticket := v_prefix
    || '-' || to_char(p_travel_date, 'YYMMDD')
    || '-' || lpad(v_seq::text, 5, '0');

  insert into bookings (
    ticket_code,      bus_id,          bus_name,
    origin,           destination,
    travel_date,      departure_time,  seat_number,
    passenger_name,   passenger_phone, passenger_id_no,
    fare_tzs,         trip_purpose,    return_duration,  status
  ) values (
    v_ticket,         p_bus_id,        v_bus.name,
    p_origin,         p_destination,
    p_travel_date,    p_departure_time, p_seat_number,
    p_passenger_name, p_passenger_phone, p_passenger_id_no,
    p_fare_tzs,
    coalesce(p_trip_purpose,    'manual'),
    coalesce(p_return_duration, 'one-way'),
    'pending'
  );

  return jsonb_build_object(
    'ticket_code', v_ticket, 'bus_name', v_bus.name,
    'bus_id',      p_bus_id, 'seat_number', p_seat_number,
    'travel_date', p_travel_date::text, 'prefix', v_prefix, 'seq', v_seq
  );
exception
  when unique_violation then
    raise exception 'Seat % on this trip is already booked — please choose another seat.', p_seat_number;
end;
$$;
grant execute on function public.claim_ticket(text,int,date,text,text,text,text,text,numeric,text,text,text)
  to anon, authenticated;

-- ============================================================================
-- 44. claim_reschedule_ticket — atomic free reschedule
--     Marks original booking rescheduled, generates PREFIX-R-YYMMDD-SSSSS code,
--     inserts confirmed replacement booking. Seat uniqueness enforced by index.
-- ============================================================================
create or replace function public.claim_reschedule_ticket(
  p_original_ticket text,
  p_new_seat        int,
  p_new_date        date,
  p_passenger_name  text default null,
  p_passenger_phone text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_orig   bookings%rowtype;
  v_bus    buses%rowtype;
  v_prefix text;
  v_seq    bigint;
  v_ticket text;
begin
  select * into v_orig from bookings where ticket_code = p_original_ticket;
  if not found then raise exception 'Booking not found: %', p_original_ticket; end if;
  if v_orig.status not in ('pending','confirmed','awaiting_payment') then
    raise exception 'Booking % cannot be rescheduled (status: %)', p_original_ticket, v_orig.status;
  end if;

  select * into v_bus from buses where id = v_orig.bus_id for update;
  if not found then raise exception 'Bus not found'; end if;

  v_prefix := coalesce(v_bus.ticket_prefix,
    upper(left(regexp_replace(v_bus.name, '[^A-Za-z]', '', 'g'), 4)));
  if v_prefix is null or v_prefix = '' then v_prefix := 'TK'; end if;

  update buses set ticket_seq = ticket_seq + 1
  where id = v_orig.bus_id returning ticket_seq into v_seq;

  -- Reschedule ticket: PREFIX-R-YYMMDD-SSSSS
  v_ticket := v_prefix || '-R-' || to_char(p_new_date, 'YYMMDD')
              || '-' || lpad(v_seq::text, 5, '0');

  update bookings set status = 'rescheduled', cancelled_at = now()
  where ticket_code = p_original_ticket;

  insert into bookings (
    ticket_code, bus_id, bus_name, origin, destination,
    travel_date, departure_time, seat_number,
    passenger_name, passenger_phone, fare_tzs,
    trip_purpose, return_duration, status
  ) values (
    v_ticket, v_orig.bus_id, v_orig.bus_name, v_orig.origin, v_orig.destination,
    p_new_date, v_orig.departure_time, p_new_seat,
    coalesce(p_passenger_name, v_orig.passenger_name),
    coalesce(p_passenger_phone, v_orig.passenger_phone),
    v_orig.fare_tzs, 'reschedule', v_orig.return_duration, 'confirmed'
  );

  return jsonb_build_object(
    'ticket_code',   v_ticket, 'original_code', p_original_ticket,
    'bus_name',      v_bus.name, 'prefix', v_prefix, 'seq', v_seq,
    'seat_number',   p_new_seat, 'travel_date', p_new_date::text,
    'is_reschedule', true
  );
exception
  when unique_violation then
    raise exception 'Seat % on % is already booked — choose another seat.', p_new_seat, p_new_date;
end;
$$;
grant execute on function public.claim_reschedule_ticket(text,int,date,text,text)
  to anon, authenticated;

-- ============================================================================
-- 45. authorize_payment — manual payment collection by agents
--     Validates booking, records payment as completed, triggers SMS ticket.
-- ============================================================================
create or replace function public.authorize_payment(
  p_ticket_code    text,
  p_method         text,
  p_bank_ref       text default null,
  p_customer_phone text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking  bookings%rowtype;
  v_phone    text;
  v_pay_id   uuid;
begin
  select * into v_booking from bookings where ticket_code = p_ticket_code;
  if not found then raise exception 'Booking not found: %', p_ticket_code; end if;
  if v_booking.status not in ('pending','awaiting_payment') then
    raise exception 'Booking already %', v_booking.status;
  end if;
  v_phone := coalesce(p_customer_phone, v_booking.passenger_phone);
  if v_phone is null or v_phone = '' then
    raise exception 'Phone number required to send the ticket';
  end if;
  if p_method in ('nmb','crdb','nbc','equity','stanbic','other_bank','bank_transfer')
     and (p_bank_ref is null or p_bank_ref = '') then
    raise exception 'Bank reference number required for bank payments';
  end if;
  if p_customer_phone is not null and p_customer_phone <> coalesce(v_booking.passenger_phone,'') then
    update bookings set passenger_phone = p_customer_phone where ticket_code = p_ticket_code;
  end if;
  -- try to update an existing pending payment row first
  update payments
     set status         = 'completed',
         provider_ref   = coalesce(p_bank_ref, provider_ref),
         bank_reference = coalesce(p_bank_ref, bank_reference),
         customer_phone = v_phone,
         paid_at        = now(),
         updated_at     = now()
   where reference = p_ticket_code
     and status in ('pending','awaiting_payment','processing')
  returning id into v_pay_id;
  -- if no existing row, insert a new completed payment (trigger fires → booking confirmed)
  if v_pay_id is null then
    insert into payments (reference, reference_type, amount_tzs, customer_name, customer_phone,
                          method, provider, provider_ref, bank_reference, status, paid_at)
    values (p_ticket_code, 'booking', v_booking.fare_tzs, v_booking.passenger_name, v_phone,
            p_method, 'manual', p_bank_ref, p_bank_ref, 'completed', now())
    returning id into v_pay_id;
  end if;
  return jsonb_build_object(
    'success',         true,
    'payment_id',      v_pay_id,
    'ticket_code',     p_ticket_code,
    'passenger_phone', v_phone,
    'method',          p_method
  );
end;
$$;
grant execute on function public.authorize_payment(text,text,text,text) to anon, authenticated;

-- ============================================================================
-- 46. Trip cancellations — two-step authorization
--     A designated team member requests; company admin approves.
--     Approval bulk-cancels all active bookings for that trip.
-- ============================================================================

-- Per-user cancellation authority flag
alter table public.tenant_users
  add column if not exists can_cancel_trips boolean not null default false;

-- Cancellation request log
create table if not exists public.trip_cancellation_requests (
  id                bigserial primary key,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  bus_id            text not null,
  travel_date       date not null,
  departure_time    text,
  route_from        text,
  route_to          text,
  reason            text not null,
  requested_by_uid  uuid not null,
  requested_by_name text,
  status            text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by_uid   uuid,
  reviewed_at       timestamptz,
  review_note       text,
  affected_count    int,
  created_at        timestamptz not null default now()
);

create index if not exists idx_trip_cancel_tenant
  on public.trip_cancellation_requests (tenant_id, status, created_at desc);

alter table public.trip_cancellation_requests enable row level security;

drop policy if exists "trip_cancel tenant read" on public.trip_cancellation_requests;
create policy "trip_cancel tenant read" on public.trip_cancellation_requests
  for select to authenticated
  using (
    public.is_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

-- ── request_trip_cancellation ────────────────────────────────────────────────
-- Caller must have can_cancel_trips = true on their tenant_users row.
create or replace function public.request_trip_cancellation(
  p_bus_id          text,
  p_travel_date     date,
  p_departure_time  text  default null,
  p_route_from      text  default null,
  p_route_to        text  default null,
  p_reason          text  default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid;
  v_can    boolean;
  v_name   text;
  v_id     bigint;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select tu.tenant_id, tu.can_cancel_trips
    into v_tenant, v_can
    from tenant_users tu
   where tu.user_id = v_uid
   limit 1;

  if v_tenant is null then raise exception 'You are not a member of any company'; end if;
  if not coalesce(v_can, false) then
    raise exception 'You do not have permission to request trip cancellations. Ask your company admin to grant you this access in the Team tab.';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A cancellation reason is required';
  end if;

  select coalesce(raw_user_meta_data->>'full_name', email)
    into v_name from auth.users where id = v_uid;

  insert into trip_cancellation_requests
    (tenant_id, bus_id, travel_date, departure_time, route_from, route_to,
     reason, requested_by_uid, requested_by_name)
  values
    (v_tenant, p_bus_id, p_travel_date,
     nullif(trim(coalesce(p_departure_time,'')), ''),
     nullif(trim(coalesce(p_route_from,'')), ''),
     nullif(trim(coalesce(p_route_to,'')), ''),
     trim(p_reason), v_uid, v_name)
  returning id into v_id;

  return v_id;
end;
$$;
grant execute on function public.request_trip_cancellation(text,date,text,text,text,text) to authenticated;

-- ── approve_trip_cancellation ────────────────────────────────────────────────
-- Admin-only. Bulk-cancels all active bookings; marks request approved.
create or replace function public.approve_trip_cancellation(
  p_request_id bigint,
  p_note       text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req    trip_cancellation_requests%rowtype;
  v_count  int;
  v_phones text[];
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  select * into v_req from trip_cancellation_requests where id = p_request_id;
  if not found       then raise exception 'Cancellation request not found'; end if;
  if v_req.status <> 'pending' then
    raise exception 'Request is already %', v_req.status;
  end if;

  -- Collect affected passengers before cancelling
  select count(*), array_agg(distinct passenger_phone)
    into v_count, v_phones
    from bookings
   where bus_id      = v_req.bus_id
     and travel_date = v_req.travel_date
     and status not in ('expired','cancelled','refunded')
     and (v_req.departure_time is null or departure_time = v_req.departure_time)
     and (v_req.route_from     is null or origin         = v_req.route_from)
     and (v_req.route_to       is null or destination    = v_req.route_to);

  -- Bulk-cancel
  update bookings
     set status     = 'cancelled',
         updated_at = now()
   where bus_id      = v_req.bus_id
     and travel_date = v_req.travel_date
     and status not in ('expired','cancelled','refunded')
     and (v_req.departure_time is null or departure_time = v_req.departure_time)
     and (v_req.route_from     is null or origin         = v_req.route_from)
     and (v_req.route_to       is null or destination    = v_req.route_to);

  update trip_cancellation_requests
     set status          = 'approved',
         reviewed_by_uid = auth.uid(),
         reviewed_at     = now(),
         review_note     = p_note,
         affected_count  = v_count
   where id = p_request_id;

  return jsonb_build_object(
    'approved',        true,
    'affected_count',  coalesce(v_count, 0),
    'passenger_phones', coalesce(v_phones, '{}'::text[])
  );
end;
$$;
grant execute on function public.approve_trip_cancellation(bigint,text) to authenticated;

-- ── reject_trip_cancellation ─────────────────────────────────────────────────
create or replace function public.reject_trip_cancellation(
  p_request_id bigint,
  p_note       text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  update trip_cancellation_requests
     set status          = 'rejected',
         reviewed_by_uid = auth.uid(),
         reviewed_at     = now(),
         review_note     = p_note
   where id = p_request_id and status = 'pending';

  if not found then raise exception 'Request not found or already reviewed'; end if;
end;
$$;
grant execute on function public.reject_trip_cancellation(bigint,text) to authenticated;

-- ============================================================================
-- 51. Bus seat-layout pending edits
--     Tenant edits to bus seat layouts go into a review queue. A platform
--     admin must approve before the change is applied to the live `buses`
--     row. Admins editing themselves write through directly.
--     Idempotent — safe to re-run.
-- ============================================================================

create table if not exists public.bus_layout_pending (
  id                uuid primary key default gen_random_uuid(),
  bus_id            text not null references public.buses(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  proposed_by       uuid references auth.users(id),
  proposed_by_email text,
  proposed_at       timestamptz not null default now(),
  seats_total       int  not null,
  seat_names        jsonb not null default '{}'::jsonb,
  seat_layout       jsonb not null,
  status            text not null default 'pending',
  reviewed_by       uuid references auth.users(id),
  reviewed_at       timestamptz,
  review_note       text,
  constraint bus_layout_pending_status_chk
    check (status in ('pending','approved','rejected'))
);

create index if not exists idx_blp_bus    on public.bus_layout_pending (bus_id);
create index if not exists idx_blp_status on public.bus_layout_pending (status, proposed_at desc);
create index if not exists idx_blp_tenant on public.bus_layout_pending (tenant_id);

alter table public.bus_layout_pending enable row level security;

drop policy if exists "blp tenant insert" on public.bus_layout_pending;
create policy "blp tenant insert" on public.bus_layout_pending
  for insert to authenticated
  with check (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.role in ('owner','admin')
    )
  );

drop policy if exists "blp tenant read" on public.bus_layout_pending;
create policy "blp tenant read" on public.bus_layout_pending
  for select to authenticated
  using (
    public.is_admin() or
    tenant_id in (
      select tu.tenant_id from public.tenant_users tu
      where tu.user_id = auth.uid()
    )
  );

drop policy if exists "blp admin update" on public.bus_layout_pending;
create policy "blp admin update" on public.bus_layout_pending
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "blp admin delete" on public.bus_layout_pending;
create policy "blp admin delete" on public.bus_layout_pending
  for delete to authenticated
  using (public.is_admin());

-- Guard: a tenant can change other fields on a bus row, but NOT the seat
-- structure columns. They must go through bus_layout_pending + admin approval.
-- The approve_bus_layout RPC bypasses this guard via SECURITY DEFINER.
create or replace function public.guard_bus_layout_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if new.seat_layout is distinct from old.seat_layout
     or new.seat_names  is distinct from old.seat_names
     or new.seats_total is distinct from old.seats_total then
    raise exception 'Seat layout edits must be submitted for admin approval'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_bus_layout_update on public.buses;
create trigger trg_guard_bus_layout_update
  before update on public.buses
  for each row execute function public.guard_bus_layout_update();

-- ── approve_bus_layout ──────────────────────────────────────────────────────
create or replace function public.approve_bus_layout(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row bus_layout_pending%rowtype;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  select * into v_row from bus_layout_pending
   where id = p_request_id and status = 'pending'
   for update;

  if not found then raise exception 'Pending edit not found or already reviewed'; end if;

  update buses
     set seats_total = v_row.seats_total,
         seat_names  = v_row.seat_names,
         seat_layout = v_row.seat_layout
   where id = v_row.bus_id;

  update bus_layout_pending
     set status      = 'approved',
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_request_id;
end;
$$;
grant execute on function public.approve_bus_layout(uuid) to authenticated;

-- ── reject_bus_layout ───────────────────────────────────────────────────────
create or replace function public.reject_bus_layout(p_request_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;

  update bus_layout_pending
     set status      = 'rejected',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   where id = p_request_id and status = 'pending';

  if not found then raise exception 'Pending edit not found or already reviewed'; end if;
end;
$$;
grant execute on function public.reject_bus_layout(uuid,text) to authenticated;

-- ============================================================================
-- 52. Trip reminder calls
--     Every confirmed booking gets an auto reminder call (default: 2 h
--     before scheduled departure). Riders can override via the UI to
--     pick a different time for personal preparation. A pg_cron job runs
--     every minute, finds bookings whose reminder time has arrived, and
--     enqueues a `call_requests` row — the existing
--     n8n/06_outbound_caller.json workflow then dials the rider via VAPI.
--     Idempotent — safe to re-run.
-- ============================================================================

create extension if not exists pg_cron;

alter table public.bookings
  add column if not exists reminder_call_at timestamptz,
  add column if not exists reminded_at      timestamptz,
  add column if not exists reminder_skipped boolean not null default false;

create index if not exists idx_bookings_reminder_due
  on public.bookings (reminder_call_at)
  where status = 'confirmed' and reminded_at is null and reminder_skipped = false;

-- Parse "06:00" / "07:30" style departure_time text into a timestamptz on a
-- given travel_date. Returns NULL if the format is unrecognised so the cron
-- can skip the row rather than crash.
create or replace function public.booking_departure_ts(p_date date, p_dep text)
returns timestamptz language plpgsql immutable as $$
declare hh int; mm int;
begin
  if p_date is null or p_dep is null then return null; end if;
  begin
    hh := (regexp_match(p_dep, '(\d{1,2}):(\d{2})'))[1]::int;
    mm := (regexp_match(p_dep, '(\d{1,2}):(\d{2})'))[2]::int;
  exception when others then return null;
  end;
  return (p_date::timestamp + make_interval(hours => hh, mins => mm)) at time zone 'Africa/Dar_es_Salaam';
end $$;

-- Trigger: when a booking flips to 'confirmed' AND no explicit
-- reminder_call_at is set, populate the default (2 h before departure).
create or replace function public.set_default_reminder() returns trigger
language plpgsql as $$
declare dep timestamptz;
begin
  if new.status = 'confirmed'
     and new.reminder_call_at is null
     and new.reminder_skipped = false then
    dep := public.booking_departure_ts(new.travel_date, new.departure_time);
    if dep is not null then
      new.reminder_call_at := dep - interval '2 hours';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_set_default_reminder on public.bookings;
create trigger trg_set_default_reminder
  before insert or update of status, reminder_call_at, reminder_skipped
  on public.bookings
  for each row execute function public.set_default_reminder();

-- The cron worker: scan due reminders, enqueue a call_requests row per
-- booking. Returns the count of newly enqueued rows for observability.
create or replace function public.enqueue_due_trip_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_enqueued int := 0;
  r record;
begin
  for r in
    select b.id, b.ticket_code, b.passenger_phone, b.bus_name,
           b.origin, b.destination, b.travel_date, b.departure_time,
           b.seat_number, b.tenant_id
    from bookings b
    where b.status = 'confirmed'
      and b.reminded_at is null
      and b.reminder_skipped = false
      and b.reminder_call_at is not null
      and b.reminder_call_at <= now()
      and b.reminder_call_at >  now() - interval '30 minutes'   -- safety: don't redial ancient ones
      and b.passenger_phone is not null
      and b.passenger_phone <> ''
    order by b.reminder_call_at
    limit 100
  loop
    insert into call_requests (phone, status, ticket_code, purpose, context, created_by, tenant_id, requested_at)
    values (
      r.passenger_phone, 'pending', r.ticket_code, 'trip_reminder',
      jsonb_build_object(
        'ticket_code',    r.ticket_code,
        'bus_name',       r.bus_name,
        'origin',         r.origin,
        'destination',    r.destination,
        'travel_date',    r.travel_date,
        'departure_time', r.departure_time,
        'seat_number',    r.seat_number
      ),
      'cron_reminder', r.tenant_id, now()
    );
    update bookings set reminded_at = now() where id = r.id;
    v_enqueued := v_enqueued + 1;
  end loop;
  return v_enqueued;
end $$;

grant execute on function public.enqueue_due_trip_reminders() to authenticated;

-- Schedule the cron. cron.schedule is idempotent on (jobname) — re-running
-- the migration is safe.
select cron.unschedule('pawa_trip_reminders') where exists (
  select 1 from cron.job where jobname = 'pawa_trip_reminders'
);
select cron.schedule(
  'pawa_trip_reminders',
  '* * * * *',                            -- every minute
  $$ select public.enqueue_due_trip_reminders(); $$
);

-- Convenience RPC for the UI: rider picks a new reminder time. Bounded so
-- riders can't queue a reminder for the past or for after the trip itself.
create or replace function public.set_booking_reminder(p_booking_id bigint, p_at timestamptz)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_dep timestamptz;
begin
  select public.booking_departure_ts(travel_date, departure_time) into v_dep
    from bookings where id = p_booking_id;
  if v_dep is null then raise exception 'Booking departure time unknown'; end if;
  if p_at is null or p_at <= now() then raise exception 'Reminder must be in the future'; end if;
  if p_at >= v_dep then raise exception 'Reminder must be before departure'; end if;
  update bookings
     set reminder_call_at = p_at,
         reminded_at      = null,
         reminder_skipped = false
   where id = p_booking_id and status = 'confirmed';
  return p_at;
end $$;
grant execute on function public.set_booking_reminder(bigint,timestamptz) to authenticated;

-- Convenience RPC: rider opts OUT of the reminder.
create or replace function public.skip_booking_reminder(p_booking_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update bookings
     set reminder_skipped = true,
         reminder_call_at = null,
         reminded_at      = null
   where id = p_booking_id and status = 'confirmed';
end $$;
grant execute on function public.skip_booking_reminder(bigint) to authenticated;

-- ============================================================================
-- 53. Multi-reminder trip notifications + post-payment confirmation SMS
--     Supersedes the single bookings.reminder_call_at column from section
--     52. Each confirmed booking now gets a guaranteed "default" reminder
--     2 h before departure that the rider CANNOT skip. The rider can
--     additionally set ONE "custom" reminder for their own preparation —
--     it fires in addition to, not instead of, the default.
--
--     The trigger also queues a confirmation SMS in scheduled_reminders
--     as soon as a booking flips to 'confirmed' (i.e. as soon as the
--     payment gateway reports the rider's PIN was accepted).
--     Idempotent — safe to re-run.
-- ============================================================================

create table if not exists public.trip_reminders (
  id              bigserial primary key,
  booking_id      bigint not null references public.bookings(id) on delete cascade,
  kind            text   not null check (kind in ('default','custom')),
  fire_at         timestamptz not null,
  fired_at        timestamptz,
  cancelled       boolean not null default false,
  call_request_id bigint references public.call_requests(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (booking_id, kind)
);

create index if not exists idx_trip_reminders_due
  on public.trip_reminders (fire_at)
  where fired_at is null and cancelled = false;
create index if not exists idx_trip_reminders_booking
  on public.trip_reminders (booking_id);

alter table public.trip_reminders enable row level security;
drop policy if exists "trip_reminders read"  on public.trip_reminders;
drop policy if exists "trip_reminders write" on public.trip_reminders;
-- Anon (the book-fast.html unauthenticated visitor) needs to read its own
-- reminder rows to render the picker. The booking_id is opaque so this
-- doesn't enumerate other bookings' state in practice.
create policy "trip_reminders read"  on public.trip_reminders for select to anon, authenticated using (true);
create policy "trip_reminders write" on public.trip_reminders for all    to authenticated using (true) with check (true);

-- Migrate any data sitting in the now-deprecated bookings columns.
insert into public.trip_reminders (booking_id, kind, fire_at, fired_at, cancelled)
select b.id, 'default', b.reminder_call_at, b.reminded_at, coalesce(b.reminder_skipped, false)
  from public.bookings b
 where b.reminder_call_at is not null
on conflict (booking_id, kind) do nothing;

-- Replace the trigger function. It now:
--   1. Inserts the mandatory 'default' reminder (departure − 2 h).
--   2. Queues a confirmation SMS in scheduled_reminders (fire_at = now).
-- Both happen only on the transition INTO 'confirmed' so they don't fire
-- on every UPDATE.
create or replace function public.set_default_reminder() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_dep timestamptz;
begin
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status is null or old.status <> 'confirmed') then

    v_dep := public.booking_departure_ts(new.travel_date, new.departure_time);
    if v_dep is not null and v_dep > now() then
      insert into public.trip_reminders (booking_id, kind, fire_at)
      values (new.id, 'default', v_dep - interval '2 hours')
      on conflict (booking_id, kind) do update
         set fire_at = excluded.fire_at,
             fired_at = null,
             cancelled = false;
    end if;

    if new.passenger_phone is not null and new.passenger_phone <> '' then
      insert into public.scheduled_reminders
        (booking_ref, phone, channel, message, fire_at, status, created_by)
      values (
        new.ticket_code, new.passenger_phone, 'sms',
        'Tiketi ya Pawa Bus: ' || new.ticket_code || E'\n' ||
        new.bus_name || ' · Kiti ' || coalesce(new.seat_number::text,'?') || E'\n' ||
        new.origin || ' -> ' || new.destination || E'\n' ||
        coalesce(new.travel_date::text,'') || ' ' || coalesce(new.departure_time,'') || E'\n' ||
        'Nauli: TZS ' || to_char(coalesce(new.fare_tzs,0), 'FM999,999'),
        now(), 'pending', 'system_confirmation'
      );
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_set_default_reminder on public.bookings;
create trigger trg_set_default_reminder
  after insert or update of status
  on public.bookings
  for each row execute function public.set_default_reminder();

-- Replace the cron worker: scan trip_reminders, not bookings.
create or replace function public.enqueue_due_trip_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_enqueued int := 0;
  r record;
  v_call_id bigint;
begin
  for r in
    select tr.id as reminder_id, tr.kind,
           b.id as booking_id, b.ticket_code, b.passenger_phone,
           b.bus_name, b.origin, b.destination,
           b.travel_date, b.departure_time, b.seat_number, b.tenant_id
      from trip_reminders tr
      join bookings b on b.id = tr.booking_id
     where b.status = 'confirmed'
       and tr.fired_at is null
       and tr.cancelled = false
       and tr.fire_at <= now()
       and tr.fire_at > now() - interval '30 minutes'
       and b.passenger_phone is not null
       and b.passenger_phone <> ''
     order by tr.fire_at
     limit 100
  loop
    insert into call_requests
      (phone, status, ticket_code, purpose, context, created_by, tenant_id, requested_at)
    values (
      r.passenger_phone, 'pending', r.ticket_code,
      'trip_reminder_' || r.kind,
      jsonb_build_object(
        'kind',           r.kind,
        'ticket_code',    r.ticket_code,
        'bus_name',       r.bus_name,
        'origin',         r.origin,
        'destination',    r.destination,
        'travel_date',    r.travel_date,
        'departure_time', r.departure_time,
        'seat_number',    r.seat_number
      ),
      'cron_reminder_' || r.kind, r.tenant_id, now()
    )
    returning id into v_call_id;

    update trip_reminders
       set fired_at = now(),
           call_request_id = v_call_id
     where id = r.reminder_id;

    v_enqueued := v_enqueued + 1;
  end loop;
  return v_enqueued;
end $$;
grant execute on function public.enqueue_due_trip_reminders() to authenticated;

-- New RPC: set the rider's optional CUSTOM reminder. Default is untouched.
create or replace function public.set_custom_reminder(p_booking_id bigint, p_at timestamptz)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_dep timestamptz;
begin
  select public.booking_departure_ts(travel_date, departure_time) into v_dep
    from bookings where id = p_booking_id;
  if v_dep is null then raise exception 'Booking departure time unknown'; end if;
  if p_at is null or p_at <= now() then raise exception 'Reminder must be in the future'; end if;
  if p_at >= v_dep then raise exception 'Reminder must be before departure'; end if;

  insert into trip_reminders (booking_id, kind, fire_at)
  values (p_booking_id, 'custom', p_at)
  on conflict (booking_id, kind) do update
     set fire_at = excluded.fire_at,
         fired_at = null,
         cancelled = false;
  return p_at;
end $$;
grant execute on function public.set_custom_reminder(bigint, timestamptz) to authenticated;

-- New RPC: cancel only the custom reminder. Default keeps firing.
create or replace function public.cancel_custom_reminder(p_booking_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update trip_reminders
     set cancelled = true
   where booking_id = p_booking_id and kind = 'custom';
end $$;
grant execute on function public.cancel_custom_reminder(bigint) to authenticated;

-- Keep the older RPC names working as aliases so any caller mid-flight
-- doesn't break. Deprecated; remove once the UI has migrated off them.
create or replace function public.set_booking_reminder(p_booking_id bigint, p_at timestamptz)
returns timestamptz language sql security definer set search_path = public as $$
  select public.set_custom_reminder(p_booking_id, p_at);
$$;
grant execute on function public.set_booking_reminder(bigint, timestamptz) to authenticated;

create or replace function public.skip_booking_reminder(p_booking_id bigint)
returns void language sql security definer set search_path = public as $$
  select public.cancel_custom_reminder(p_booking_id);
$$;
grant execute on function public.skip_booking_reminder(bigint) to authenticated;

-- ============================================================================
-- 54. find_next_available_trip — cascade fallback when a trip is full
--     Given (origin, destination, current_date, current_departure), walks
--     the next chronological trips on the same route up to N attempts
--     (default 5) and returns the first one with at least one free seat.
--     Used by the web booking UI ("Bus full — open next") and the VAPI
--     agent's find_next_available tool.
--     Idempotent — safe to re-run.
-- ============================================================================

create or replace function public.find_next_available_trip(
  p_origin         text,
  p_destination    text,
  p_travel_date    date,
  p_departure_time text,
  p_max_attempts   int default 5,
  p_day_horizon    int default 14
) returns table (
  bus_id          text,
  bus_name        text,
  trip_date       date,
  departure_time  text,
  available_seats int,
  seats_total     int,
  suggested_fare  numeric,
  hops_searched   int
) language sql stable security definer set search_path = public as $$
  with route_legs as (
    select b.id              as bus_id,
           b.name            as bus_name,
           b.seats_total,
           b.fare_per_km,
           r->>'departure'   as departure_time
    from buses b,
         jsonb_array_elements(b.routes) r
    where lower(r->>'from') = lower(coalesce(p_origin,''))
      and lower(r->>'to')   = lower(coalesce(p_destination,''))
  ),
  candidates as (
    -- Cross route legs with each day in the horizon, then drop:
    --   (a) past departures on the current day (departure_time <= p_departure_time),
    --   (b) the current trip itself.
    select rl.bus_id, rl.bus_name, rl.seats_total, rl.fare_per_km,
           rl.departure_time,
           (p_travel_date + n::int) as trip_date
    from route_legs rl,
         generate_series(0, greatest(p_day_horizon,1)) as gs(n)
    where not (n = 0 and rl.departure_time <= coalesce(p_departure_time,'00:00'))
  ),
  occupied as (
    select bus_id, travel_date, departure_time, count(*) as taken
    from bookings
    where status in ('pending','awaiting_payment','confirmed','rescheduled','held')
    group by 1,2,3
  ),
  ranked as (
    select c.bus_id, c.bus_name, c.trip_date, c.departure_time,
           c.seats_total::int                                       as seats_total,
           (c.seats_total - coalesce(o.taken,0))::int               as available_seats,
           greatest(c.fare_per_km * 200, 15000)::numeric            as suggested_fare,
           row_number() over (order by c.trip_date, c.departure_time, c.bus_id) as rn
    from candidates c
    left join occupied o
      on o.bus_id         = c.bus_id
     and o.travel_date    = c.trip_date
     and o.departure_time = c.departure_time
  ),
  first_n as (
    select * from ranked
    order by trip_date, departure_time, bus_id
    limit greatest(p_max_attempts, 1)
  )
  select bus_id, bus_name, trip_date, departure_time,
         available_seats, seats_total, suggested_fare,
         rn::int as hops_searched
  from first_n
  where available_seats > 0
  order by trip_date, departure_time, bus_id
  limit 1;
$$;

grant execute on function public.find_next_available_trip(text,text,date,text,int,int) to anon, authenticated;

-- ============================================================================
-- 55. Generic admin approval queue (shipments / buses / agents CRUD)
--     Public-facing forms submit changes here instead of writing directly to
--     the live tables. Admins approve from admin.html, which then applies the
--     payload to the target table. Distinct from bus_layout_pending (section
--     51), which is specifically for seat-layout proposals.
--     Idempotent — safe to re-run.
-- ============================================================================

create table if not exists public.pending_changes (
  id              bigserial primary key,
  entity_type     text        not null,
  action          text        not null check (action in ('insert','update','delete')),
  entity_id       text,
  payload         jsonb       not null default '{}'::jsonb,
  requested_by    text,
  requested_at    timestamptz not null default now(),
  status          text        not null default 'pending'
                    check (status in ('pending','approved','rejected')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  reject_reason   text
);

-- Backfill columns for older databases where the table predates this section.
alter table public.pending_changes add column if not exists review_note text;
alter table public.pending_changes add column if not exists reject_reason text;

create index if not exists pending_changes_status_idx
  on public.pending_changes (status, requested_at desc);

alter table public.pending_changes enable row level security;

drop policy if exists "pending_changes insertable" on public.pending_changes;
create policy "pending_changes insertable"
  on public.pending_changes for insert with check (true);

drop policy if exists "pending_changes selectable" on public.pending_changes;
create policy "pending_changes selectable"
  on public.pending_changes for select using (true);

drop policy if exists "pending_changes updatable" on public.pending_changes;
create policy "pending_changes updatable"
  on public.pending_changes for update using (true);

-- ============================================================================
-- 34. houses  (House Booking TZ — property listings, public read)
-- ============================================================================
create table if not exists public.houses (
  id                text primary key,
  title             text not null,
  type              text not null check (type in ('apartment','house','plot','office')),
  listing           text not null check (listing in ('rent','sale')),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text default 'month',         -- 'month' for rent, 'total' for sale
  bedrooms          int  not null default 0,
  bathrooms         int  not null default 0,
  size_sqm          int,
  region            text references public.regions(name) on update cascade,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  amenities         text[] not null default '{}',
  furnished         text default 'no',  -- free-text since 2026-05 (e.g. "fridge, gas cooker")
  photo             text,                          -- storage path OR external URL
  description       text,
  verified          boolean not null default false,
  available_from    date,
  agent             jsonb not null default '{}'::jsonb,
  -- Owner / agent linkage for the agent dashboard step we'll build next.
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists houses_region_idx     on public.houses (region);
create index if not exists houses_area_idx       on public.houses (area);
create index if not exists houses_type_idx       on public.houses (type);
create index if not exists houses_listing_idx    on public.houses (listing);
create index if not exists houses_price_idx      on public.houses (price_tzs);
create index if not exists houses_lat_lng_idx    on public.houses (lat, lng);

drop trigger if exists set_houses_updated_at on public.houses;
create trigger set_houses_updated_at
  before update on public.houses
  for each row execute function public.touch_updated_at();

alter table public.houses enable row level security;
drop policy if exists "houses readable"      on public.houses;
drop policy if exists "houses owner insert"  on public.houses;
drop policy if exists "houses owner update"  on public.houses;
drop policy if exists "houses owner delete"  on public.houses;
drop policy if exists "houses admin write"   on public.houses;

-- Anyone (signed in or anonymous) can browse listings.
create policy "houses readable" on public.houses for select using (true);

-- Owners can insert their own listings (must set owner_user_id = their uid).
create policy "houses owner insert" on public.houses for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());

-- Owners can edit / delete only their own listings.
create policy "houses owner update" on public.houses for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "houses owner delete" on public.houses for delete
  using (owner_user_id = auth.uid());

-- Admins can do anything.
create policy "houses admin write" on public.houses for all
  using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 34b. house-photos storage bucket (public-read, 20 MB max, jpg/png/webp)
-- Run this in the SQL editor; the storage extension auto-loads on Supabase.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'house-photos', 'house-photos', true, 20971520,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can read the photos (the bucket is public anyway, but be explicit).
drop policy if exists "house-photos readable" on storage.objects;
create policy "house-photos readable" on storage.objects for select
  using (bucket_id = 'house-photos');

-- Signed-in users can upload to the bucket; admins can manage everything.
drop policy if exists "house-photos upload" on storage.objects;
create policy "house-photos upload" on storage.objects for insert
  with check (bucket_id = 'house-photos' and auth.uid() is not null);

drop policy if exists "house-photos admin write" on storage.objects;
create policy "house-photos admin write" on storage.objects for all
  using (bucket_id = 'house-photos' and public.is_admin())
  with check (bucket_id = 'house-photos' and public.is_admin());

-- ----------------------------------------------------------------------------
-- 34c. Multi-photo + video support for house listings.
--     Owners can attach up to 12 photos and 2 short video clips per listing.
--     Storage paths land in the same `house-photos` bucket (renamed
--     conceptually to "house media" but kept as the same bucket so existing
--     paths still resolve). The single legacy `photo` column is retained as
--     the cover/thumbnail.
--     Idempotent — safe to re-run.
-- ----------------------------------------------------------------------------
alter table public.houses
  add column if not exists photos text[] not null default '{}'::text[],
  add column if not exists videos text[] not null default '{}'::text[],
  add column if not exists nearby jsonb  not null default '{}'::jsonb,
  -- Additional costs/bills shown to clients: [{label, amount, billing}].
  add column if not exists extra_costs jsonb not null default '[]'::jsonb;

-- Allow free-text furnishing notes (e.g. "fridge, gas cooker"). If an older
-- CHECK constraint still exists on a re-run database, drop it.
do $$
declare con record;
begin
  for con in
    select c.conname
    from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%furnished%'
  loop
    execute 'alter table public.houses drop constraint if exists "' || con.conname || '"';
  end loop;
end $$;

-- Backfill the photos array from the legacy single-photo column on rows
-- that haven't been edited yet, so the gallery has something to show.
update public.houses
   set photos = array[photo]
 where photo is not null and photo <> '' and coalesce(array_length(photos, 1), 0) = 0;

-- Bump the bucket size limit to 60 MB so a 60-second 1080p clip (~45 MB at
-- average bitrate) fits with headroom. Whitelist the same image formats plus
-- the three video formats browsers can record (mp4 / webm / quicktime).
update storage.buckets
   set file_size_limit = 62914560,   -- 60 MB
       allowed_mime_types = array[
         'image/jpeg','image/png','image/webp',
         'video/mp4','video/webm','video/quicktime'
       ]
 where id = 'house-photos';

-- ============================================================================
-- 35. trucks  (Moving Trucks — hire-truck listings, public read)
--     The "move my goods to the new home" companion to houses. An owner
--     registers a truck at its base location with photos; users find the
--     truck nearest them. Mirrors section 34 (houses): public read, owner
--     writes, admin override. Full standalone copy lives in supabase/trucks.sql.
-- ============================================================================
create table if not exists public.trucks (
  id                text primary key,
  title             text not null,
  truck_type        text not null default 'canter'
                      check (truck_type in ('pickup','canter','3ton','7ton','10ton_plus','other')),
  capacity_tonnes   numeric check (capacity_tonnes is null or capacity_tonnes >= 0),
  price_tzs         bigint not null default 0 check (price_tzs >= 0),
  currency          text not null default 'TZS',
  period            text not null default 'trip',
  negotiable        boolean not null default true,
  driver_included   boolean not null default true,
  loaders_included  boolean not null default false,
  service_area      text not null default 'within_city'
                      check (service_area in ('within_city','region_wide','cross_region')),
  region            text references public.regions(name) on update cascade,
  area              text,
  address           text,
  lat               double precision,
  lng               double precision,
  photo             text,
  photos            text[] not null default '{}'::text[],
  description       text,
  verified          boolean not null default false,
  owner             jsonb not null default '{}'::jsonb,
  owner_user_id     uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists trucks_region_idx   on public.trucks (region);
create index if not exists trucks_area_idx      on public.trucks (area);
create index if not exists trucks_type_idx      on public.trucks (truck_type);
create index if not exists trucks_service_idx   on public.trucks (service_area);
create index if not exists trucks_price_idx     on public.trucks (price_tzs);
create index if not exists trucks_lat_lng_idx   on public.trucks (lat, lng);

drop trigger if exists set_trucks_updated_at on public.trucks;
create trigger set_trucks_updated_at
  before update on public.trucks
  for each row execute function public.touch_updated_at();

alter table public.trucks enable row level security;
drop policy if exists "trucks readable"     on public.trucks;
drop policy if exists "trucks owner insert" on public.trucks;
drop policy if exists "trucks owner update" on public.trucks;
drop policy if exists "trucks owner delete" on public.trucks;
drop policy if exists "trucks admin write"  on public.trucks;

create policy "trucks readable" on public.trucks for select using (true);
create policy "trucks owner insert" on public.trucks for insert
  with check (auth.uid() is not null and owner_user_id = auth.uid());
create policy "trucks owner update" on public.trucks for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy "trucks owner delete" on public.trucks for delete
  using (owner_user_id = auth.uid());
create policy "trucks admin write" on public.trucks for all
  using (public.is_admin()) with check (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'truck-photos', 'truck-photos', true, 20971520,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "truck-photos readable" on storage.objects;
create policy "truck-photos readable" on storage.objects for select
  using (bucket_id = 'truck-photos');
drop policy if exists "truck-photos upload" on storage.objects;
create policy "truck-photos upload" on storage.objects for insert
  with check (bucket_id = 'truck-photos' and auth.uid() is not null);
drop policy if exists "truck-photos admin write" on storage.objects;
create policy "truck-photos admin write" on storage.objects for all
  using (bucket_id = 'truck-photos' and public.is_admin())
  with check (bucket_id = 'truck-photos' and public.is_admin());

-- ============================================================================
-- Done — 35 tables, 31 RPCs, pg_cron reminders + payment-confirmation SMS, full RLS, realtime, seed data, and multi-tenant.
-- ============================================================================

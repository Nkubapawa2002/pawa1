-- =====================================================================
-- Pawa Bus Cargo — Schema v9: Accounting & Finance
-- Adds:
--   1. role column on admins (admin | accountant | auditor)
--   2. org_expenses — manual expense ledger
--   3. tax_rates    — Tanzania tax configuration
--   4. RLS + grants for finance tables
-- Run in Supabase SQL Editor.
-- =====================================================================

-- -----------------------------------------------------------------------
-- 1. Extend admins with a role column
-- -----------------------------------------------------------------------
alter table public.admins add column if not exists role text
  not null default 'admin'
  check (role in ('admin','accountant','auditor'));

-- Helper: is the current user an accountant or higher?
create or replace function public.is_finance_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins a
    where a.email = (auth.jwt() ->> 'email')
      and a.role in ('admin','accountant','auditor')
  );
$$;

-- -----------------------------------------------------------------------
-- 2. Tax rates (Tanzania Revenue Authority defaults)
-- -----------------------------------------------------------------------
create table if not exists public.tax_rates (
  id           text primary key,
  name         text not null,
  rate_pct     numeric(6,3) not null,
  applies_to   text,
  description  text,
  active       boolean not null default true,
  updated_at   timestamptz not null default now()
);

insert into public.tax_rates (id, name, rate_pct, applies_to, description) values
  ('vat',          'Value Added Tax (VAT)',           18,   'revenue',  'Standard VAT rate in Tanzania (TRA). Applies to bus tickets and cargo.'),
  ('vat_zero',     'VAT Zero-Rated',                   0,   'revenue',  'Zero-rated goods (basic foodstuffs, medicines, etc.).'),
  ('wht_services', 'Withholding Tax — Services',       5,   'services', 'WHT on payments for services rendered to the company.'),
  ('wht_rent',     'Withholding Tax — Rent',          10,   'rent',     'WHT on rental payments.'),
  ('wht_dividend', 'Withholding Tax — Dividends',     10,   'dividend', 'WHT on dividends paid to shareholders.'),
  ('corporate_tax','Corporate Income Tax (CIT)',       30,   'profit',   'CIT on annual taxable profit — Tanzania mainland rate.'),
  ('paye_a',       'PAYE Band A (0–3.27M TZS/yr)',     0,   'salaries', 'Monthly salary ≤ TZS 272,500 — no PAYE.'),
  ('paye_b',       'PAYE Band B (3.27M–7.44M)',        9,   'salaries', 'Monthly salary TZS 272,501–620,000.'),
  ('paye_c',       'PAYE Band C (7.44M–14.4M)',       20,   'salaries', 'Monthly salary TZS 620,001–1,200,000.'),
  ('paye_d',       'PAYE Band D (14.4M–41.4M)',       25,   'salaries', 'Monthly salary TZS 1,200,001–3,450,000.'),
  ('paye_e',       'PAYE Band E (>41.4M TZS/yr)',     30,   'salaries', 'Monthly salary > TZS 3,450,000.'),
  ('skills_levy',  'Skills & Development Levy (SDL)',   4,   'salaries', '4% of gross salaries paid to VETA.')
on conflict (id) do nothing;

alter table public.tax_rates enable row level security;

drop policy if exists "tax_rates readable" on public.tax_rates;
create policy "tax_rates readable"
  on public.tax_rates for select to anon, authenticated using (true);

drop policy if exists "tax_rates finance write" on public.tax_rates;
create policy "tax_rates finance write"
  on public.tax_rates for all to authenticated
  using (is_finance_user()) with check (is_finance_user());

-- -----------------------------------------------------------------------
-- 3. Expense ledger
-- -----------------------------------------------------------------------
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

create index if not exists org_expenses_date_idx
  on public.org_expenses (period_date desc);
create index if not exists org_expenses_bus_idx
  on public.org_expenses (bus_company_id, period_date desc);
create index if not exists org_expenses_cat_idx
  on public.org_expenses (category, period_date desc);

alter table public.org_expenses enable row level security;

drop policy if exists "expenses finance read" on public.org_expenses;
create policy "expenses finance read"
  on public.org_expenses for select to authenticated
  using (is_finance_user());

drop policy if exists "expenses accountant write" on public.org_expenses;
create policy "expenses accountant write"
  on public.org_expenses for insert to authenticated
  with check (
    exists (
      select 1 from public.admins a
      where a.email = (auth.jwt() ->> 'email')
        and a.role in ('admin','accountant')
    )
  );

drop policy if exists "expenses accountant update" on public.org_expenses;
create policy "expenses accountant update"
  on public.org_expenses for update to authenticated
  using (
    exists (
      select 1 from public.admins a
      where a.email = (auth.jwt() ->> 'email')
        and a.role in ('admin','accountant')
    )
  );

drop policy if exists "expenses admin delete" on public.org_expenses;
create policy "expenses admin delete"
  on public.org_expenses for delete to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email() and a.role = 'admin'));

grant select, insert, update on public.org_expenses to authenticated;
grant usage, select on sequence public.org_expenses_id_seq to authenticated;
grant select on public.tax_rates to anon, authenticated;

-- -----------------------------------------------------------------------
-- 4. Seed: add default finance users (update emails as needed)
--    To add accountant: UPDATE admins SET role='accountant' WHERE email='...';
-- -----------------------------------------------------------------------
-- The owner (pawa4761@gmail.com) keeps role='admin' by default.
-- Add more rows here for your accountant / auditor team members.

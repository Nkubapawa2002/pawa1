-- ============================================================================
--  Pawa Bus Cargo — Database AUDIT + REPAIR for login / register / finance
-- ----------------------------------------------------------------------------
--  WHAT THIS IS
--    A safe, idempotent script you paste into the Supabase SQL editor
--    (Dashboard → SQL editor → New query → paste → Run). It does two things:
--
--      PART A — AUDIT (read-only): prints a report of every table, whether RLS
--               is on, how many policies it has, the admins roster, and the
--               auth users. Run this first to SEE the state of your DB.
--
--      PART B — REPAIR (idempotent writes): re-creates the auth helper
--               functions, re-asserts the finance Row-Level-Security policies
--               and grants, and seeds your owner account into `admins`. Safe to
--               run repeatedly — it only adds what's missing / fixes what's wrong.
--
--    None of this DROPS data. It only (re)creates functions, policies, grants
--    and one admin row. If a whole table is missing, run `schema_master.sql`
--    first (it is the authoritative schema) — then run this to verify.
--
--  IMPORTANT — the #1 cause of "create account / sign-in not working":
--    Supabase → Authentication → Providers → Email → "Confirm email".
--    If that toggle is ON, a brand-new sign-up cannot sign in until the user
--    clicks an email link. For an internal finance tool, turn it OFF. This
--    SQL cannot change that setting — it lives in the dashboard UI.
--
--  Set your owner email once here:
-- ============================================================================
\set owner_email 'pawa4761@gmail.com'
-- (If your SQL editor doesn't support \set, just replace :'owner_email' below
--  with your email in quotes, e.g. 'pawa4761@gmail.com'.)


-- ============================================================================
--  PART A — AUDIT  (read-only; nothing is changed)
-- ============================================================================

-- A1. Every public table + is RLS enabled?
select
  c.relname                                   as table_name,
  c.relrowsecurity                            as rls_enabled,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- A2. The exact tables the finance page reads — confirm they all exist.
select t.expected as finance_table,
       (to_regclass('public.' || t.expected) is not null) as exists
from (values
  ('admins'),('buses'),('bookings'),('shipments'),('payments'),
  ('org_expenses'),('org_adjustments'),('ledger_adjustments'),('tax_rates')
) as t(expected)
order by exists, finance_table;

-- A3. Who can sign into finance/admin? (the admins roster + their roles)
select email, role, full_name, created_at from public.admins order by created_at;

-- A4. Auth users that exist vs. whether each is in admins (helps spot the
--     "signed up but forbidden" case — account exists in auth but not in admins).
select u.email,
       u.created_at,
       (u.email_confirmed_at is not null) as email_confirmed,
       (a.email is not null)              as is_admin_listed,
       a.role
from auth.users u
left join public.admins a on lower(a.email) = lower(u.email)
order by u.created_at desc;

-- A5. Do the helper functions exist? (finance RLS depends on them)
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_admin','is_super_admin','is_finance_user')
order by p.proname;

-- A6. Finance-table policies in detail.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('admins','org_expenses','org_adjustments','ledger_adjustments','tax_rates','payments')
order by tablename, policyname;


-- ============================================================================
--  PART B — REPAIR  (idempotent; safe to re-run)
-- ============================================================================

-- B1. admins table (no-op if it already exists) + your owner account.
create table if not exists public.admins (
  email      text primary key,
  full_name  text,
  role       text not null default 'admin'
    check (role in ('admin','accountant','auditor')),
  created_at timestamptz not null default now()
);

insert into public.admins (email, full_name, role)
values (:'owner_email', 'Owner', 'admin')
on conflict (email) do update set role = 'admin';

alter table public.admins enable row level security;

-- B2. Auth helper functions (SECURITY DEFINER so they bypass RLS and can't
--     recurse). These are what every finance policy calls.
create or replace function public.is_admin()
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

-- B3. admins RLS — a signed-in admin can read the roster (so the finance gate's
--     `select role from admins where email = ...` succeeds).
drop policy if exists "admins read self" on public.admins;
drop policy if exists "admins write"     on public.admins;
create policy "admins read self" on public.admins for select using (public.is_admin());
create policy "admins write"     on public.admins for all
  using (public.is_admin()) with check (public.is_admin());

-- B4. Finance read/write RLS (matches schema_master.sql §18). Re-assert so a
--     half-applied migration can't leave the finance user locked out.
alter table public.org_expenses enable row level security;
drop policy if exists "expenses finance read"     on public.org_expenses;
drop policy if exists "expenses accountant write"  on public.org_expenses;
create policy "expenses finance read"
  on public.org_expenses for select to authenticated using (public.is_finance_user());
create policy "expenses accountant write"
  on public.org_expenses for insert to authenticated with check (public.is_finance_user());
grant select, insert on public.org_expenses to authenticated;
grant usage, select on sequence public.org_expenses_id_seq to authenticated;

alter table public.org_adjustments enable row level security;
drop policy if exists "adj_all" on public.org_adjustments;
create policy "adj_all" on public.org_adjustments for all using (true) with check (true);
grant select, insert, update, delete on public.org_adjustments to authenticated;
grant usage, select on sequence public.org_adjustments_id_seq to authenticated;

alter table public.ledger_adjustments enable row level security;
drop policy if exists "ledger_adj all" on public.ledger_adjustments;
create policy "ledger_adj all" on public.ledger_adjustments for all using (true) with check (true);
grant select, insert, update, delete on public.ledger_adjustments to authenticated;
grant usage, select on sequence public.ledger_adjustments_id_seq to authenticated;

-- tax_rates is read-only reference data the finance page needs.
grant select on public.tax_rates to anon, authenticated;


-- ============================================================================
--  POST-REPAIR VERIFY — re-run A3/A4 mentally, or this one line:
--  Expect your owner email to come back with role='admin'.
-- ============================================================================
select 'You can sign in as: ' || string_agg(email || ' (' || role || ')', ', ')
       as finance_logins
from public.admins;

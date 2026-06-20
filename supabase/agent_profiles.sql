-- ============================================================================
-- agent_profiles — where each agent BELONGS and OPERATES
-- ============================================================================
-- Every agent on the platform (house / truck / service / cargo) declares, right
-- after registering, two things:
--   • region              — the region they belong to (one of public.regions)
--   • area_of_operations  — where they actually work: a WARD, a DISTRICT or a
--                            STREET name — whichever the agent gives.
--
-- Why a separate table (not columns on each listing): the identity is the
-- AGENT, not the listing. The admin "All Agents" tracker keys every agent by
-- their auth user id (owner_user_id → "uid:<id>"); this table hangs off that
-- same id, so an agent's home region + operating area follows them across all
-- their houses / trucks / services. The dashboards also stamp these onto new
-- listings (region/area) so a searcher in that area finds the agent's services.
--
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- NOTE: identity is the Clerk user id (a TEXT string like "user_2ab…"), exactly
-- like houses/trucks/services after supabase/clerk_text_user_ids.sql. So user_id
-- is TEXT (not uuid) with NO FK to auth.users, and every policy compares
-- user_id::text against public.app_uid() instead of auth.uid(). For a plain
-- Supabase-Auth token the `sub` claim IS the uuid as text, so this still matches
-- legacy rows — fully backward compatible.
-- ----------------------------------------------------------------------------

-- Identity helper: the caller's id as TEXT (NULL when anonymous). Defined in
-- clerk_text_user_ids.sql; recreated here so this file stands alone.
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

create table if not exists public.agent_profiles (
  user_id            text primary key,
  name               text,
  phone              text,
  -- The region the agent belongs to (FK keeps it spelled like everywhere else).
  region             text references public.regions(name) on update cascade,
  -- The agent's own words for where they operate: a ward, district or street.
  area_of_operations text,
  -- How that area was classified, so search can match at the right level.
  area_kind          text check (area_kind in ('ward','district','street','area')),
  -- Structured admin area when we could resolve it (lets search match precisely
  -- and lets admin group agents by district/ward, not just free text).
  district           text,
  ward               text,
  -- The point the agent picked for their operating area (optional).
  lat                double precision,
  lng                double precision,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

-- ---- Upgrade an existing uuid table to the Clerk-text identity --------------
-- If this table was first created with `user_id uuid references auth.users(id)`
-- (the pre-Clerk shape), convert it in place. No-ops once already text.
-- Old policies reference user_id, so they must be dropped BEFORE the type change
-- (Postgres won't alter a column used in a policy). They're recreated below.
drop policy if exists "agent_profiles self read"    on public.agent_profiles;
drop policy if exists "agent_profiles self insert"  on public.agent_profiles;
drop policy if exists "agent_profiles self update"  on public.agent_profiles;
drop policy if exists "agent_profiles admin write"  on public.agent_profiles;
alter table public.agent_profiles drop constraint if exists agent_profiles_user_id_fkey;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_profiles'
      and column_name = 'user_id' and data_type = 'uuid'
  ) then
    alter table public.agent_profiles alter column user_id type text using user_id::text;
  end if;
end $$;

create index if not exists agent_profiles_region_idx   on public.agent_profiles (region);
create index if not exists agent_profiles_district_idx on public.agent_profiles (district);
create index if not exists agent_profiles_ward_idx     on public.agent_profiles (ward);

-- Keep updated_at fresh on every change (reuses the shared trigger fn).
drop trigger if exists set_agent_profiles_updated_at on public.agent_profiles;
create trigger set_agent_profiles_updated_at
  before update on public.agent_profiles
  for each row execute function public.touch_updated_at();

-- ---- RLS -------------------------------------------------------------------
-- A profile carries the agent's phone (PII), so it is NOT world-readable: an
-- agent reads/writes only their own row; admins read & write every row. Agents
-- are surfaced to searchers through their LISTINGS (which carry region/area),
-- never through this table directly, so no public read is needed.
alter table public.agent_profiles enable row level security;

drop policy if exists "agent_profiles self read"    on public.agent_profiles;
drop policy if exists "agent_profiles self insert"  on public.agent_profiles;
drop policy if exists "agent_profiles self update"  on public.agent_profiles;
drop policy if exists "agent_profiles admin write"  on public.agent_profiles;

create policy "agent_profiles self read" on public.agent_profiles
  for select using (user_id::text = (select public.app_uid()) or public.is_admin());

create policy "agent_profiles self insert" on public.agent_profiles
  for insert with check (user_id::text = (select public.app_uid()));

create policy "agent_profiles self update" on public.agent_profiles
  for update using (user_id::text = (select public.app_uid())) with check (user_id::text = (select public.app_uid()));

create policy "agent_profiles admin write" on public.agent_profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
--  p_message_lists.sql — a set of people you can name and use again.
-- ============================================================================
--  The picker made "these eleven people" possible. It did not make it cheap:
--  the basket lives exactly as long as the dialog does, so the same room next
--  week is eleven taps again, and an agent who advertises to the same tenants
--  every month re-picks them every month. That is the difference between a
--  feature somebody can use and one they will.
--
--  A list is ids and a name. Nothing else, and deliberately:
--
--  A LIST IS A PLAN, NOT A PERMISSION. pm_list_add accepts anybody holding a
--  key. It does NOT ask whether you may reach them, and pm_group_create /
--  pm_broadcast re-check every id at the moment they are used, every time.
--  Two reasons, and the second is the one that matters:
--    · a relationship can end and a block can land after a list was saved, so
--      a permission recorded at save time would be a stale permission
--    · refusing to save an unreachable id would leak, at save time, whether
--      somebody has blocked you
--  So pm_list_people() returns may_cast and may_room PER ROW, computed now,
--  and the picker greys what it must. The list survives; the act is fenced.
--
--  WHERE IT LIVES. Both tables have RLS on and NOT ONE POLICY, and are revoked
--  from anon and authenticated — the pm_presence and pm_blocks pattern. Every
--  read goes through a SECURITY DEFINER function scoped to owner_id =
--  app_uid(), which keeps the pg_policies invariant (no write policy on any
--  pm_ table) true by having no policy of any kind.
--
--  THERE IS NO pm_room_from_list() AND NO pm_cast_to_list(). The client reads
--  pm_list_people, pre-ticks the reachable rows and calls the existing
--  pm_group_create / pm_broadcast with the resulting array. One write path
--  means one place the cap, the daily limit and the fence live; a second entry
--  point would be a second place to forget them.
--
--  Idempotent. Safe to re-run. Depends on p_message.sql and, for the reach
--  columns, p_message_audience.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_lists.sql
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.pm_may_room_with(text)') is null then
    raise exception 'Apply supabase/features/message/p_message_audience.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The tables
-- ---------------------------------------------------------------------------
create table if not exists public.pm_lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  name       text not null check (length(name) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pm_lists_owner_idx on public.pm_lists (owner_id, updated_at desc);
-- Two lists called "Mwanza truck owners" is a person losing track of their own
-- lists, not a use case. Case-insensitive, because "Tenants" and "tenants" are
-- the same mistake.
create unique index if not exists pm_lists_owner_name_idx
  on public.pm_lists (owner_id, lower(name));

create table if not exists public.pm_list_members (
  list_id  uuid not null references public.pm_lists(id) on delete cascade,
  user_id  text not null,
  added_at timestamptz not null default now(),
  primary key (list_id, user_id)
);

alter table public.pm_lists        enable row level security;
alter table public.pm_list_members enable row level security;

-- Said out loud rather than left implied, the same way p_message_presence.sql
-- says it: the containment argument is that there is no policy here.
drop policy if exists "pm_lists own read"        on public.pm_lists;
drop policy if exists "pm_lists own write"       on public.pm_lists;
drop policy if exists "pm_list_members own read" on public.pm_list_members;

revoke all on public.pm_lists        from anon, authenticated;
revoke all on public.pm_list_members from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. How many, and how big
-- ---------------------------------------------------------------------------
create or replace function public.pm_lists_max() returns int
  language sql immutable as $$ select 50 $$;

create or replace function public.pm_list_max() returns int
  language sql immutable as $$ select 500 $$;

-- ---------------------------------------------------------------------------
-- 3. Making and changing one
-- ---------------------------------------------------------------------------
-- One helper, used by create and by set, so "who is actually in this list"
-- has one definition. Guests are excluded here as everywhere: a list belongs
-- to an account, and a guest session is a browser tab.
create or replace function public.pm_list_own(p_list uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select exists (
    select 1 from public.pm_lists l
     where l.id = p_list
       and l.owner_id = public.app_uid()
       and coalesce(public.app_uid(), '') <> '');
$fn$;

create or replace function public.pm_list_create(p_name text, p_members jsonb default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_id   uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_n    int;
begin
  if coalesce(v_uid, '') = '' then raise exception 'Sign in first'; end if;
  if public.app_is_guest() then
    raise exception 'A guest session cannot keep a list. Sign in to keep one.';
  end if;
  if v_name is null then raise exception 'Give the list a name'; end if;
  if length(v_name) > 60 then raise exception 'That name is too long'; end if;

  select count(*) into v_n from public.pm_lists where owner_id = v_uid;
  if v_n >= public.pm_lists_max() then
    raise exception 'You can keep % lists. Delete one first.', public.pm_lists_max();
  end if;

  if exists (select 1 from public.pm_lists
              where owner_id = v_uid and lower(name) = lower(v_name)) then
    raise exception 'You already have a list called that';
  end if;

  insert into public.pm_lists (owner_id, name) values (v_uid, v_name) returning id into v_id;
  if p_members is not null and jsonb_array_length(p_members) > 0 then
    perform public.pm_list_set(v_id, p_members);
  end if;
  return v_id;
end $fn$;

-- REPLACES the membership rather than appending to it. The picker hands over a
-- set, not a diff, and "save what is on screen" is the only gesture there is.
create or replace function public.pm_list_set(p_list uuid, p_members jsonb)
  returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_n int;
begin
  if not public.pm_list_own(p_list) then raise exception 'That is not your list'; end if;

  select count(distinct m.uid) into v_n
  from (select jsonb_array_elements_text(coalesce(p_members, '[]'::jsonb)) as uid) m
  join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false);

  if v_n > public.pm_list_max() then
    raise exception 'A list holds at most % people.', public.pm_list_max();
  end if;

  delete from public.pm_list_members where list_id = p_list;
  insert into public.pm_list_members (list_id, user_id)
  select distinct p_list, m.uid
  from (select jsonb_array_elements_text(coalesce(p_members, '[]'::jsonb)) as uid) m
  join public.pm_keys k on k.user_id = m.uid and not coalesce(k.is_guest, false)
  on conflict do nothing;
  update public.pm_lists set updated_at = now() where id = p_list;
  return v_n;
end $fn$;

create or replace function public.pm_list_rename(p_list uuid, p_name text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if not public.pm_list_own(p_list) then raise exception 'That is not your list'; end if;
  if v_name is null then raise exception 'Give the list a name'; end if;
  if length(v_name) > 60 then raise exception 'That name is too long'; end if;
  if exists (select 1 from public.pm_lists
              where owner_id = public.app_uid() and lower(name) = lower(v_name) and id <> p_list) then
    raise exception 'You already have a list called that';
  end if;
  update public.pm_lists set name = v_name, updated_at = now() where id = p_list;
end $fn$;

create or replace function public.pm_list_delete(p_list uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_n int;
begin
  if not public.pm_list_own(p_list) then raise exception 'That is not your list'; end if;
  with del as (delete from public.pm_lists where id = p_list returning 1)
  select count(*)::int into v_n from del;
  return v_n > 0;
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. Reading them
-- ---------------------------------------------------------------------------
create or replace function public.pm_lists_mine()
  returns table (id uuid, name text, n_members int, updated_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select l.id, l.name,
         (select count(*)::int from public.pm_list_members m where m.list_id = l.id),
         l.updated_at
    from public.pm_lists l
   where l.owner_id = public.app_uid()
     and coalesce(public.app_uid(), '') <> ''
   order by l.updated_at desc;
$fn$;

-- The finder's own columns, plus the two answers the picker draws with. A
-- filter over pm_agent_finder rather than a second copy of its counting logic,
-- the same way pm_my_people is.
--
-- may_cast / may_room are computed NOW, not stored. That is the whole design:
-- a list is a plan and the act is fenced when it happens.
create or replace function public.pm_list_people(p_list uuid)
  returns table (
    user_id        text,
    display_name   text,
    region         text,
    area           text,
    area_kind      text,
    district       text,
    ward           text,
    wards          text[],
    districts      text[],
    lat            double precision,
    lng            double precision,
    is_agent       boolean,
    reachable      boolean,
    public_key     text,
    fingerprint    text,
    n_houses       int,
    n_services     int,
    n_trucks       int,
    n_jobs         int,
    n_verified     int,
    last_listed_at timestamptz,
    last_seen_at   timestamptz,
    kinds          text[],
    phone          text,
    may_cast       boolean,
    may_room       boolean
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select f.user_id, f.display_name, f.region, f.area, f.area_kind, f.district, f.ward,
         f.wards, f.districts, f.lat, f.lng,
         f.is_agent, f.reachable, f.public_key, f.fingerprint,
         f.n_houses, f.n_services, f.n_trucks, f.n_jobs, f.n_verified, f.last_listed_at,
         f.last_seen_at, f.kinds, f.phone,
         public.pm_may_cast_to(f.user_id),
         public.pm_may_room_with(f.user_id)
    from public.pm_agent_finder(null, null, null, 500) f
    join public.pm_list_members m on m.user_id = f.user_id
   where m.list_id = p_list
     and public.pm_list_own(p_list)
   order by f.display_name nulls last;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
-- The revoke of PUBLIC is here because Postgres grants EXECUTE to PUBLIC on
-- every new function; the fence that actually holds is inside each one, where
-- app_uid() is null for a caller with no session and pm_list_own() is false.
revoke execute on function public.pm_list_own(uuid)            from public;
revoke execute on function public.pm_list_create(text, jsonb)  from public;
revoke execute on function public.pm_list_set(uuid, jsonb)     from public;
revoke execute on function public.pm_list_rename(uuid, text)   from public;
revoke execute on function public.pm_list_delete(uuid)         from public;
revoke execute on function public.pm_lists_mine()              from public;
revoke execute on function public.pm_list_people(uuid)         from public;

grant execute on function public.pm_list_create(text, jsonb) to authenticated;
grant execute on function public.pm_list_set(uuid, jsonb)    to authenticated;
grant execute on function public.pm_list_rename(uuid, text)  to authenticated;
grant execute on function public.pm_list_delete(uuid)        to authenticated;
grant execute on function public.pm_lists_mine()             to authenticated;
grant execute on function public.pm_list_people(uuid)        to authenticated;
grant execute on function public.pm_lists_max()              to anon, authenticated;
grant execute on function public.pm_list_max()               to anon, authenticated;

commit;

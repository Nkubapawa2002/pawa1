-- ============================================================================
-- p_message_guests.sql — let someone without an account chat with an agent,
-- with exactly the same encryption, and fence off everything that opens up.
-- ============================================================================
-- A person browsing rooms has no reason to make an account before asking "is
-- this still available?". They now get an ANONYMOUS Supabase session: a real
-- auth user with a real `sub`, so app_uid() works, RLS works, and P-Message's
-- encryption is bit-for-bit the same as it is for a signed-in agent. Nothing
-- about the crypto is weakened for guests; the only difference is that nobody
-- has proved who they are.
--
-- THE PART THAT MATTERS MORE THAN THE FEATURE
-- Turning on anonymous sign-ins means "authenticated" no longer implies "has
-- an email address". Every policy of the form
--     with check (app_uid() is not null and owner_user_id = app_uid())
-- was, until today, a policy only a real account could satisfy. Left alone,
-- anyone could now post house listings, services and trucks without so much as
-- an email — free, unlimited, untraceable spam in the actual catalogue.
--
-- So this migration does two things and they are not separable:
--   1. app_is_guest() — reads the is_anonymous claim from the JWT;
--   2. every content-creating policy gains `and not app_is_guest()`, which
--      restores exactly the posture that existed before anonymous sign-ins.
--
-- The rule going forward: a guest may hold a key, read the agent directory,
-- open a thread with an AGENT, and send messages. Nothing else.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Who is a guest
-- ---------------------------------------------------------------------------
-- Supabase stamps `is_anonymous` into the JWT of an anonymous session. Read it
-- defensively: a missing claim means "not a guest", so a signed-in user or a
-- service role is never accidentally treated as one.
create or replace function public.app_is_guest()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(
    nullif(
      coalesce(
        nullif(current_setting('request.jwt.claim',  true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb ->> 'is_anonymous'
    , '')::boolean
  , false);
$$;

grant execute on function public.app_is_guest() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Fence every content-creating policy
-- ---------------------------------------------------------------------------
-- These are the policies whose meaning changes the moment "authenticated" stops
-- implying "gave us an email". Each one keeps its original condition and gains
-- one clause. Listings, agent identities, tenancies and tenant signup are all
-- things a real account does.
do $fence$
declare
  r record;
begin
  -- houses / services / trucks: the catalogue itself.
  execute $sql$
    drop policy if exists "houses owner insert" on public.houses;
    create policy "houses owner insert" on public.houses for insert
      with check ((select public.app_uid()) is not null
                  and not (select public.app_is_guest())
                  and owner_user_id = (select public.app_uid()));

    drop policy if exists "services owner insert" on public.services;
    create policy "services owner insert" on public.services for insert
      with check ((select public.app_uid()) is not null
                  and not (select public.app_is_guest())
                  and owner_user_id = (select public.app_uid()));
  $sql$;

  -- trucks may or may not exist with this exact policy name across branches.
  if exists (select 1 from pg_policies where schemaname = 'public'
               and tablename = 'trucks' and policyname = 'trucks owner insert') then
    execute $sql$
      drop policy if exists "trucks owner insert" on public.trucks;
      create policy "trucks owner insert" on public.trucks for insert
        with check ((select public.app_uid()) is not null
                    and not (select public.app_is_guest())
                    and owner_user_id = (select public.app_uid()));
    $sql$;
  end if;

  -- agent_profiles: a guest has no business claiming to be an agent.
  execute $sql$
    drop policy if exists "agent_profiles self insert" on public.agent_profiles;
    create policy "agent_profiles self insert" on public.agent_profiles for insert
      with check (user_id::text = (select public.app_uid())
                  and not (select public.app_is_guest()));
  $sql$;

  if exists (select 1 from pg_policies where schemaname = 'public'
               and tablename = 'house_tenancies' and policyname = 'ht owner insert') then
    execute $sql$
      drop policy if exists "ht owner insert" on public.house_tenancies;
      create policy "ht owner insert" on public.house_tenancies for insert
        with check ((select public.app_uid()) is not null
                    and not (select public.app_is_guest())
                    and owner_user_id = (select public.app_uid()));
    $sql$;
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
               and tablename = 'tenants' and policyname = 'tenant signup insert') then
    execute $sql$
      drop policy if exists "tenant signup insert" on public.tenants;
      create policy "tenant signup insert" on public.tenants for insert
        with check ((select public.app_uid()) is not null
                    and not (select public.app_is_guest()));
    $sql$;
  end if;
end $fence$;

-- ---------------------------------------------------------------------------
-- 3. Guests in P-Message
-- ---------------------------------------------------------------------------
alter table public.pm_keys add column if not exists is_guest boolean not null default false;

-- Publishing a key, now recording whether the publisher is a guest. An agent
-- seeing "Guest" on a thread is seeing something true and useful: this person
-- has not proved who they are.
create or replace function public.pm_publish_key(
  p_public_key   text,
  p_fingerprint  text,
  p_display_name text default null,
  p_region       text default null
) returns public.pm_keys
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    text := public.app_uid();
  v_guest  boolean := public.app_is_guest();
  v_name   text;
  v_region text;
  v_agent  boolean := false;
  v_row    public.pm_keys;
begin
  if v_uid is null then
    raise exception 'Sign in before publishing a key';
  end if;
  if coalesce(p_public_key, '') = '' or coalesce(p_fingerprint, '') = '' then
    raise exception 'A public key and its fingerprint are both required';
  end if;

  if not v_guest then
    select ap.name, ap.region, true into v_name, v_region, v_agent
    from public.agent_profiles ap where ap.user_id = v_uid;
  end if;

  insert into public.pm_keys (user_id, public_key, fingerprint, display_name, region, is_agent, is_guest)
  values (
    v_uid, p_public_key, p_fingerprint,
    coalesce(nullif(trim(coalesce(p_display_name, '')), ''), v_name),
    coalesce(v_region, p_region),
    coalesce(v_agent, false),
    v_guest
  )
  on conflict (user_id) do update set
    public_key   = excluded.public_key,
    fingerprint  = excluded.fingerprint,
    display_name = coalesce(excluded.display_name, public.pm_keys.display_name),
    region       = coalesce(excluded.region, public.pm_keys.region),
    is_agent     = excluded.is_agent,
    is_guest     = excluded.is_guest,
    updated_at   = now()
  returning * into v_row;

  return v_row;
end $$;

-- The directory lists people you might want to write to. Guests are not that:
-- they are people who wrote to YOU, and they arrive in the inbox. Listing them
-- would turn the directory into a roll of every anonymous visitor.
create or replace function public.pm_directory(
  p_region text default null,
  p_query  text default null,
  p_limit  int  default 200
) returns table (
  user_id      text,
  display_name text,
  region       text,
  area         text,
  area_kind    text,
  district     text,
  ward         text,
  is_agent     boolean,
  reachable    boolean,
  public_key   text,
  fingerprint  text
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with people as (
    select
      ap.user_id,
      coalesce(k.display_name, ap.name)              as display_name,
      coalesce(k.region, ap.region)                  as region,
      ap.area_of_operations                          as area,
      ap.area_kind, ap.district, ap.ward,
      true                                           as is_agent,
      (k.public_key is not null)                     as reachable,
      k.public_key, k.fingerprint
    from public.agent_profiles ap
    left join public.pm_keys k on k.user_id = ap.user_id
    union
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
      and not k.is_guest
  )
  select * from people
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%'
    )
    -- Signed-in callers only, guests included: a guest is signed in, just not
    -- identified. What stays shut out is the public anon key on its own.
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

-- Starting a conversation, with two rules that only apply to guests.
create or replace function public.pm_start_direct(p_other text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    text := public.app_uid();
  v_guest  boolean := public.app_is_guest();
  v_id     uuid;
  v_recent int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_other is null or p_other = v_uid then raise exception 'Pick someone else'; end if;
  if not exists (select 1 from public.pm_keys where user_id = p_other) then
    raise exception 'That person has not set up P-Message yet';
  end if;

  if v_guest then
    -- A guest writes to AGENTS. Guest-to-guest threads would be a free,
    -- unidentified channel between two people who are both unidentified —
    -- a spam network with our name on it, serving nobody the site exists for.
    if not exists (select 1 from public.pm_keys where user_id = p_other and is_agent) then
      raise exception 'Guests can only message agents. Sign in to message anyone.';
    end if;
    -- And a limited number of them per hour. Costless account creation plus
    -- unlimited new threads is the whole spam recipe.
    select count(*) into v_recent
    from public.pm_threads t
    where t.created_by = v_uid and t.created_at > now() - interval '1 hour';
    if v_recent >= 5 then
      raise exception 'Too many new conversations in one hour. Try again later, or sign in.';
    end if;
  end if;

  select t.id into v_id
  from public.pm_threads t
  where t.kind = 'direct'
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = v_uid)
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = p_other)
    and (select count(*) from public.pm_members m where m.thread_id = t.id) = 2
  limit 1;

  if v_id is not null then return v_id; end if;

  insert into public.pm_threads (kind, created_by) values ('direct', v_uid) returning id into v_id;
  insert into public.pm_members (thread_id, user_id, role) values
    (v_id, v_uid, 'owner'), (v_id, p_other, 'member');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Who am I talking to
-- ---------------------------------------------------------------------------
-- The safety number of the person on the other side of a thread. This exists
-- because the directory is the wrong place to look one up: a guest is not in
-- it, so an agent verifying a guest would have found nothing. Restricted to
-- people you actually share a thread with — the public keys are world-readable
-- anyway, but a bulk roster of everyone is not something to hand out.
create or replace function public.pm_peer(p_user_id text)
  returns table (user_id text, display_name text, fingerprint text, is_agent boolean, is_guest boolean, region text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select k.user_id, coalesce(k.display_name, ap.name), k.fingerprint, k.is_agent, k.is_guest,
         coalesce(k.region, ap.region)
  from public.pm_keys k
  left join public.agent_profiles ap on ap.user_id = k.user_id
  where k.user_id = p_user_id
    and exists (
      select 1
      from public.pm_members mine
      join public.pm_members theirs on theirs.thread_id = mine.thread_id
      where mine.user_id = public.app_uid() and theirs.user_id = p_user_id
    );
$$;

grant execute on function public.pm_peer(text) to anon, authenticated;

-- The inbox needs to say when the other party is a guest, so an agent knows
-- who they are dealing with before they answer. Dropped first: adding a column
-- to the returned row changes the function signature, and CREATE OR REPLACE
-- cannot do that.
drop function if exists public.pm_inbox();
create or replace function public.pm_inbox()
  returns table (
    thread_id    uuid,
    kind         text,
    title        text,
    region       text,
    other_id     text,
    other_name   text,
    other_region text,
    other_area   text,
    other_guest  boolean,
    last_at      timestamptz,
    unread       int
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  with me as (select public.app_uid() as uid),
  mine as (
    select m.thread_id, m.last_read_at
    from public.pm_members m, me
    where m.user_id = me.uid
  )
  select
    t.id, t.kind, t.title, t.region,
    o.user_id, coalesce(k.display_name, ap.name), coalesce(k.region, ap.region),
    ap.area_of_operations,
    coalesce(k.is_guest, false),
    t.last_at,
    (select count(*)::int from public.pm_messages msg
      where msg.thread_id = t.id
        and msg.sender_id <> (select uid from me)
        and (mine.last_read_at is null or msg.sent_at > mine.last_read_at))
  from mine
  join public.pm_threads t on t.id = mine.thread_id
  left join lateral (
    select m2.user_id from public.pm_members m2
    where m2.thread_id = t.id and m2.user_id <> (select uid from me) and t.kind = 'direct'
    limit 1
  ) o on true
  left join public.pm_keys k on k.user_id = o.user_id
  left join public.agent_profiles ap on ap.user_id = o.user_id
  order by t.last_at desc;
$$;

-- Broadcasts go to accounts, not to passers-by. A guest session is a browser
-- tab; announcing to it is announcing into a wastebasket, and it would inflate
-- "sent to 900 people" into a number that means nothing.
create or replace function public.pm_recipients(p_region text default null)
  returns table (user_id text, public_key text, display_name text, region text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select k.user_id, k.public_key, k.display_name, k.region
  from public.pm_keys k
  where public.is_admin()
    and not k.is_guest
    and k.user_id <> coalesce(public.app_uid(), '')
    and (p_region is null or p_region = '' or k.region = p_region)
  order by k.region nulls last, k.display_name nulls last;
$$;

grant execute on function public.pm_inbox() to anon, authenticated;

commit;

-- ============================================================================
-- Done. Remember the other half of this change: anonymous sign-ins must be
-- enabled on the project (Auth → Providers → Anonymous, or the Management API
-- field external_anonymous_users_enabled). Without it the client call fails
-- and guests simply cannot start; with it and WITHOUT this file, anyone can
-- post listings without an email.
-- ============================================================================

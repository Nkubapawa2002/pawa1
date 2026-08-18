-- ============================================================================
-- p_message.sql — P-Message: end-to-end encrypted chat.
-- ============================================================================
-- The database here is deliberately a dumb, blind post office. It stores
-- ciphertext, an IV, and one wrapped key per recipient. It cannot read a
-- message, and it never holds a private key — those live only on people's
-- devices (js/lib/p-crypto.js does the sealing and opening).
--
-- What that buys, and what it does not:
--   · Nobody with database access — us included — can read a body.
--   · Everybody with database access can see WHO wrote to WHOM and WHEN.
--     Metadata is not encrypted and this schema does not pretend otherwise.
--   · Public keys are served from this same database, so key distribution is
--     trust-on-first-use. The fingerprint column exists so two people can
--     compare safety numbers out of band; that comparison is what closes the
--     gap, and no amount of SQL can do it for them.
--
-- Five tables:
--   pm_keys          who can be written to, and the public key to write with
--   pm_threads       a conversation (direct, or an admin broadcast)
--   pm_members       who is in it
--   pm_messages      the sealed body — ciphertext + IV, nothing else
--   pm_message_keys  the content key, wrapped once per recipient
--
-- RLS NOTE. Membership policies are the classic place to write an infinitely
-- recursive policy (a policy on pm_members that reads pm_members). Every
-- membership test here goes through public.pm_is_member(), which is SECURITY
-- DEFINER and therefore does not re-enter RLS. app_uid()/is_admin() are called
-- as scalar sub-selects — `(select public.app_uid())` — so the planner runs
-- them once per query instead of once per row.
--
-- Idempotent. Safe to re-run. Depends on app_uid(), is_admin(),
-- touch_updated_at() and public.regions, all already in the schema.
-- Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. pm_keys — the public directory of reachable people
-- ---------------------------------------------------------------------------
-- World-readable ON PURPOSE: a public key is public, and hiding it would only
-- stop people from being able to write to each other. The row carries no phone
-- number and no email — the identifiers that make agent_profiles private.
create table if not exists public.pm_keys (
  user_id      text primary key,
  public_key   text not null,          -- base64url SPKI, ECDH P-256
  fingerprint  text not null,          -- the 12-digit safety number, for display
  display_name text,                   -- what to call them in a thread list
  -- The region is what makes "message everyone in Mwanza" possible. Agents get
  -- theirs from agent_profiles on publish; everyone else picks one.
  region       text references public.regions(name) on update cascade,
  is_agent     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pm_keys_region_idx on public.pm_keys (region);

drop trigger if exists set_pm_keys_updated_at on public.pm_keys;
create trigger set_pm_keys_updated_at
  before update on public.pm_keys
  for each row execute function public.touch_updated_at();

alter table public.pm_keys enable row level security;

drop policy if exists "pm_keys readable"    on public.pm_keys;
drop policy if exists "pm_keys self write"  on public.pm_keys;
drop policy if exists "pm_keys self update" on public.pm_keys;
drop policy if exists "pm_keys admin all"   on public.pm_keys;

create policy "pm_keys readable" on public.pm_keys for select using (true);

create policy "pm_keys self write" on public.pm_keys for insert
  with check (user_id = (select public.app_uid()));

-- Rotating your own key is allowed; rewriting somebody else's is the whole
-- attack this schema has to prevent, so the check is on both sides.
create policy "pm_keys self update" on public.pm_keys for update
  using (user_id = (select public.app_uid()))
  with check (user_id = (select public.app_uid()));

-- Admins may remove a key (abuse, a lost device) but note they cannot usefully
-- REPLACE one: a swapped key changes the fingerprint, which is exactly what
-- the safety number is there to expose.
create policy "pm_keys admin all" on public.pm_keys for delete
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- 2. pm_threads / pm_members
-- ---------------------------------------------------------------------------
create table if not exists public.pm_threads (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'direct' check (kind in ('direct', 'broadcast')),
  -- Broadcasts only: a plaintext label ("All of Tanzania", "Mwanza") so the
  -- list can say what a thread IS without opening it. Direct threads have no
  -- title — naming them would leak what a private conversation is about.
  title      text,
  region     text references public.regions(name) on update cascade,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_at    timestamptz not null default now()
);

create index if not exists pm_threads_last_idx on public.pm_threads (last_at desc);

create table if not exists public.pm_members (
  thread_id    uuid not null references public.pm_threads(id) on delete cascade,
  user_id      text not null,
  role         text not null default 'member' check (role in ('member', 'owner')),
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (thread_id, user_id)
);

create index if not exists pm_members_user_idx on public.pm_members (user_id);

-- The membership test every policy below leans on. SECURITY DEFINER so it does
-- NOT re-enter RLS on pm_members — without that, "members are visible to
-- members" is an infinitely recursive policy.
create or replace function public.pm_is_member(p_thread uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.pm_members m
    where m.thread_id = p_thread and m.user_id = public.app_uid()
  );
$$;

alter table public.pm_threads enable row level security;
alter table public.pm_members enable row level security;

drop policy if exists "pm_threads member read" on public.pm_threads;
drop policy if exists "pm_threads insert self" on public.pm_threads;
drop policy if exists "pm_members read"        on public.pm_members;
drop policy if exists "pm_members self update" on public.pm_members;

-- Note what admins deliberately do NOT get: a read policy on other people's
-- threads. It would be pointless (the bodies are ciphertext they cannot open)
-- and it would put "the admin can see your conversations" into the schema,
-- which is the opposite of what this feature says on the tin.
create policy "pm_threads member read" on public.pm_threads for select
  using (public.pm_is_member(id));

create policy "pm_threads insert self" on public.pm_threads for insert
  with check (created_by = (select public.app_uid()));

create policy "pm_members read" on public.pm_members for select
  using (public.pm_is_member(thread_id));

-- Marking your own place in a thread. Membership itself is only ever written by
-- the SECURITY DEFINER functions below, so nobody can add themselves to a
-- conversation they were not invited to.
create policy "pm_members self update" on public.pm_members for update
  using (user_id = (select public.app_uid()))
  with check (user_id = (select public.app_uid()));

-- ---------------------------------------------------------------------------
-- 3. pm_messages / pm_message_keys — the sealed post
-- ---------------------------------------------------------------------------
create table if not exists public.pm_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.pm_threads(id) on delete cascade,
  sender_id  text not null,
  alg        text not null default 'ECDH-P256+A256GCM',
  iv         text not null,
  ciphertext text not null,
  sent_at    timestamptz not null default now()
);

create index if not exists pm_messages_thread_idx on public.pm_messages (thread_id, sent_at desc);

create table if not exists public.pm_message_keys (
  message_id  uuid not null references public.pm_messages(id) on delete cascade,
  user_id     text not null,
  epk         text not null,           -- the message's ephemeral public key
  wrapped_key text not null,           -- content key, sealed to this recipient
  primary key (message_id, user_id)
);

create index if not exists pm_message_keys_user_idx on public.pm_message_keys (user_id);

alter table public.pm_messages enable row level security;
alter table public.pm_message_keys enable row level security;

drop policy if exists "pm_messages member read" on public.pm_messages;
drop policy if exists "pm_keys own wraps"       on public.pm_message_keys;

create policy "pm_messages member read" on public.pm_messages for select
  using (public.pm_is_member(thread_id));

-- You can fetch YOUR wrap and nobody else's. Reading another person's wrapped
-- key would not help — it is sealed to their private key — but there is no
-- reason to hand it over, and a smaller surface is a smaller surface.
create policy "pm_keys own wraps" on public.pm_message_keys for select
  using (user_id = (select public.app_uid()));

-- Writes go exclusively through pm_send()/pm_broadcast(): no insert policy on
-- pm_messages at all, so a message cannot be forged into a thread by anyone
-- who merely holds the anon key.

-- ---------------------------------------------------------------------------
-- 4. Publishing a key
-- ---------------------------------------------------------------------------
-- Region and name are taken from agent_profiles when the caller has one, so an
-- agent's thread list entry matches the identity they already registered under
-- rather than a second, drifting copy of it.
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

  select ap.name, ap.region, true into v_name, v_region, v_agent
  from public.agent_profiles ap where ap.user_id = v_uid;

  insert into public.pm_keys (user_id, public_key, fingerprint, display_name, region, is_agent)
  values (
    v_uid, p_public_key, p_fingerprint,
    coalesce(nullif(trim(coalesce(p_display_name, '')), ''), v_name),
    coalesce(v_region, p_region),
    coalesce(v_agent, false)
  )
  on conflict (user_id) do update set
    public_key   = excluded.public_key,
    fingerprint  = excluded.fingerprint,
    display_name = coalesce(excluded.display_name, public.pm_keys.display_name),
    region       = coalesce(excluded.region, public.pm_keys.region),
    is_agent     = excluded.is_agent,
    updated_at   = now()
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The directory — every agent, with where they work
-- ---------------------------------------------------------------------------
-- agent_profiles is NOT world-readable, because it carries a phone number. So
-- the directory is a SECURITY DEFINER view over it that returns the working
-- identity (name, region, area of operations) and never the phone. Same
-- privacy model the demand-pin RPCs already use.
--
-- `reachable` is the honest signal: an agent who has never opened P-Message has
-- no published key, so there is nothing to encrypt to. The UI says so rather
-- than offering a chat that would silently fail.
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
    -- People who are not agents but have opened P-Message are reachable too;
    -- a directory that only lists agents cannot answer "who wrote to me?".
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
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
    -- Signed-in callers only. The names and operating areas of every agent
    -- in the country are exactly the list a scraper with the public anon key
    -- would want, and a signed-out visitor has nobody to message anyway.
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

-- ---------------------------------------------------------------------------
-- 6. Starting a conversation
-- ---------------------------------------------------------------------------
-- Idempotent: tapping someone twice returns the SAME thread rather than
-- scattering a conversation across duplicates. Membership is written here,
-- under SECURITY DEFINER, because pm_members has no insert policy — that is
-- what stops anyone adding themselves to a thread they were not invited to.
create or replace function public.pm_start_direct(p_other text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid text := public.app_uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_other is null or p_other = v_uid then raise exception 'Pick someone else'; end if;
  if not exists (select 1 from public.pm_keys where user_id = p_other) then
    raise exception 'That person has not set up P-Message yet';
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
-- 7. Sending
-- ---------------------------------------------------------------------------
-- p_keys is [{"user_id":"…","epk":"…","wrapped_key":"…"}], one entry per member,
-- produced by PMCrypto.seal() in the browser. The server checks membership and
-- writes; it has no way to produce or verify the contents, which is the point.
--
-- Wraps addressed to non-members are dropped rather than stored: the sender
-- decides who can read a message, but the THREAD decides who is in it, and a
-- stray row would be a quiet way to smuggle a reader in.
create or replace function public.pm_send(
  p_thread     uuid,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid text := public.app_uid();
  v_msg uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'A message needs at least one wrapped key';
  end if;

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (p_thread, v_uid, p_iv, p_ciphertext)
  returning id into v_msg;

  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = p_thread and m.user_id = k->>'user_id'
  )
  on conflict (message_id, user_id) do nothing;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Admin broadcast — the whole country, or one region
-- ---------------------------------------------------------------------------
-- Who the admin can reach, with the keys to reach them. Admin-only, and it
-- returns public keys — which are public anyway — never contact details.
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
    and k.user_id <> coalesce(public.app_uid(), '')
    and (p_region is null or p_region = '' or k.region = p_region)
  order by k.region nulls last, k.display_name nulls last;
$$;

-- One call writes the thread, its members, the single sealed body and every
-- wrapped key. A national broadcast is otherwise hundreds of round trips from
-- a phone on a Tanzanian mobile network — the difference between a feature and
-- a thing nobody can finish sending.
create or replace function public.pm_broadcast(
  p_title      text,
  p_region     text,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb,
  -- The thread id is chosen by the CALLER, because the body is sealed with the
  -- thread id as authenticated data and the sealing happens before this call.
  -- Without it a broadcast would have to be sealed against a placeholder, and
  -- then broadcasts and direct messages would need two different open() paths.
  p_thread     uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    text := public.app_uid();
  v_thread uuid;
  v_msg    uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'Nobody in that scope has set up P-Message yet';
  end if;

  insert into public.pm_threads (id, kind, title, region, created_by)
  values (coalesce(p_thread, gen_random_uuid()), 'broadcast',
          coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Announcement'),
          nullif(p_region, ''), v_uid)
  returning id into v_thread;

  -- Everyone the message was sealed for becomes a member, so it lands in their
  -- thread list. The admin joins as owner.
  insert into public.pm_members (thread_id, user_id, role)
  select v_thread, k->>'user_id', 'member' from jsonb_array_elements(p_keys) k
  on conflict do nothing;
  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (v_thread, v_uid, p_iv, p_ciphertext)
  returning id into v_msg;

  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  on conflict (message_id, user_id) do nothing;

  return v_thread;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Reading
-- ---------------------------------------------------------------------------
-- The thread list. `preview` is deliberately absent: there is no such thing as
-- a server-rendered preview of a message the server cannot read. The client
-- decrypts the last message itself.
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
    t.last_at,
    (select count(*)::int from public.pm_messages msg
      where msg.thread_id = t.id
        and msg.sender_id <> (select uid from me)
        and (mine.last_read_at is null or msg.sent_at > mine.last_read_at))
  from mine
  join public.pm_threads t on t.id = mine.thread_id
  -- The other party, for direct threads only. A broadcast has hundreds of
  -- members and is identified by its title instead.
  left join lateral (
    select m2.user_id from public.pm_members m2
    where m2.thread_id = t.id and m2.user_id <> (select uid from me) and t.kind = 'direct'
    limit 1
  ) o on true
  left join public.pm_keys k on k.user_id = o.user_id
  left join public.agent_profiles ap on ap.user_id = o.user_id
  order by t.last_at desc;
$$;

-- A page of messages, each already joined to MY wrapped key — one round trip
-- instead of one per message.
create or replace function public.pm_thread_messages(
  p_thread uuid,
  p_limit  int default 100
) returns table (
  id          uuid,
  thread_id   uuid,
  sender_id   text,
  sender_name text,
  iv          text,
  ciphertext  text,
  epk         text,
  wrapped_key text,
  sent_at     timestamptz
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select
    msg.id, msg.thread_id, msg.sender_id,
    coalesce(k.display_name, ap.name),
    msg.iv, msg.ciphertext, mk.epk, mk.wrapped_key, msg.sent_at
  from public.pm_messages msg
  join public.pm_message_keys mk
    on mk.message_id = msg.id and mk.user_id = public.app_uid()
  left join public.pm_keys k on k.user_id = msg.sender_id
  left join public.agent_profiles ap on ap.user_id = msg.sender_id
  where msg.thread_id = p_thread
    and exists (
      select 1 from public.pm_members m
      where m.thread_id = p_thread and m.user_id = public.app_uid()
    )
  order by msg.sent_at
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

create or replace function public.pm_mark_read(p_thread uuid)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update public.pm_members set last_read_at = now()
  where thread_id = p_thread and user_id = public.app_uid();
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants + realtime
-- ---------------------------------------------------------------------------
grant execute on function public.pm_publish_key(text, text, text, text) to anon, authenticated;
grant execute on function public.pm_directory(text, text, int)          to anon, authenticated;
grant execute on function public.pm_start_direct(text)                  to anon, authenticated;
grant execute on function public.pm_send(uuid, text, text, jsonb)       to anon, authenticated;
grant execute on function public.pm_recipients(text)                    to anon, authenticated;
grant execute on function public.pm_broadcast(text, text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.pm_inbox()                             to anon, authenticated;
grant execute on function public.pm_thread_messages(uuid, int)          to anon, authenticated;
grant execute on function public.pm_mark_read(uuid)                     to anon, authenticated;
grant execute on function public.pm_is_member(uuid)                     to anon, authenticated;

-- Live delivery. RLS still applies to realtime, so a subscriber is only ever
-- pushed rows from threads they belong to — and the payload is ciphertext.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.pm_messages;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

commit;

-- ============================================================================
-- Done. The client flow:
--   1. PMCrypto.generateIdentity()  -> pm_publish_key()      (once per device)
--   2. pm_directory(region)         -> pick someone reachable
--   3. pm_start_direct(them)        -> thread id
--   4. PMCrypto.seal(...)           -> pm_send(thread, iv, ct, keys)
--   5. pm_thread_messages(thread)   -> PMCrypto.open(row, me)
-- Admin: pm_recipients(region) -> seal once for all of them -> pm_broadcast().
-- ============================================================================

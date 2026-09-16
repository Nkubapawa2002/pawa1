-- ============================================================================
--  notify_cleared.sql — "I have seen this" survives the device it was seen on.
-- ============================================================================
--  THE COMPLAINT THIS ANSWERS
--  "The notifications still show past information that I already saw."
--
--  The feature was not missing. js/lib/notify-clear.js has done exactly the
--  right thing since it shipped: it remembers the IDENTITY of each row that
--  was cleared, so clearing four rooms does not mute rooms and does not come
--  back the moment a fifth is listed. Its own header argues that at length and
--  the argument is correct.
--
--  It kept the answer in localStorage.
--
--  That is one browser profile on one device. Open the app on a phone after
--  clearing on a laptop, reinstall the PWA, clear site data, use the Android
--  build and the browser, or simply let the OS reclaim storage, and every
--  cleared row is new again. Nothing was broken; the answer was just written
--  somewhere that does not travel with the account.
--
--  WHAT THIS ADDS, AND WHAT IT DOES NOT REPLACE
--  localStorage stays, and stays first. It is synchronous, it works offline,
--  and the bell filters a catalogue on every poll: a network round trip in
--  that path would make the panel slower for the sake of a fact that almost
--  never differs. This table is the DURABLE copy, merged in on load and
--  written through on every clear.
--
--  So the client keeps a union: anything cleared on any device, ever. A clear
--  is not reversible by design (there is no "un-clear" in the UI) so the two
--  stores can never disagree in a way that needs resolving. They only differ
--  in what they have heard about yet.
--
--  IDENTITY, NOT A WATERMARK. kind is the group the bell counts ('houses',
--  'messages', 'trust', ...) and item_id is whatever that group decided names
--  one row: a house id, a conversation id plus the time of its last message, a
--  peer plus the moment their key changed. js/core/notify.js owns those
--  decisions and this table stores them without knowing what they mean.
--
--  GUESTS ARE ALLOWED. app_uid() is stable for the life of an anonymous
--  session, so a guest who clears a row and navigates to another page keeps it
--  cleared. It costs a handful of rows and it is the same promise everybody
--  else gets. The purge below keeps it from accumulating.
--
--  Idempotent. Safe to re-run. Depends on public.app_uid().
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/account/notify_cleared.sql
-- ============================================================================

begin;

create table if not exists public.notify_cleared (
  user_id    text not null,
  kind       text not null,
  item_id    text not null,
  cleared_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

-- Two columns rather than one "houses:abc123" string, because an item_id is
-- opaque and may contain anything the counting code chose, colons included.
-- A composite key cannot be ambiguous; a joined one eventually is.
create index if not exists notify_cleared_mine_idx
  on public.notify_cleared (user_id, cleared_at desc);

alter table public.notify_cleared enable row level security;

drop policy if exists "notify_cleared own read"   on public.notify_cleared;
drop policy if exists "notify_cleared own write"  on public.notify_cleared;
drop policy if exists "notify_cleared own delete" on public.notify_cleared;

-- Your own rows and nobody else's, in all three directions. There is nothing
-- here worth reading about somebody else, and "which notifications has this
-- person dismissed" is a behavioural record: it stays theirs.
create policy "notify_cleared own read" on public.notify_cleared for select
  using (user_id = (select public.app_uid()));

create policy "notify_cleared own write" on public.notify_cleared for insert
  with check (user_id = (select public.app_uid()));

-- Clearing is not reversible in the UI, so this exists for the purge and for
-- an account deleting its own history, not for an "un-clear" button.
create policy "notify_cleared own delete" on public.notify_cleared for delete
  using (user_id = (select public.app_uid()));

grant select, insert, delete on public.notify_cleared to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Reading what this account has already dismissed
-- ---------------------------------------------------------------------------
-- Capped, newest first. The client merges these into the list it already holds
-- rather than replacing it, so a low cap loses nothing that device knows: it
-- only limits what a NEW device is told about. Four hundred matches the MAX in
-- js/lib/notify-clear.js, deliberately, so neither side silently truncates
-- what the other considers current.
create or replace function public.notify_cleared_mine(p_limit int default 400)
  returns table (kind text, item_id text)
  language sql
  stable
  security invoker
  set search_path = public
as $fn$
  select c.kind, c.item_id
    from public.notify_cleared c
   where c.user_id = (select public.app_uid())
   order by c.cleared_at desc
   limit greatest(1, least(coalesce(p_limit, 400), 1000));
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Writing a dismissal down
-- ---------------------------------------------------------------------------
-- Takes the whole batch the button cleared, in one call. The bell clears a
-- GROUP at a time -- every room in the "new rooms" row, all at once -- so a
-- call per id would be forty round trips for one tap.
--
-- SILENT ON CONFLICT. Clearing something already cleared is not an error, it
-- is what happens when two devices clear the same row, and the first
-- cleared_at is the honest one.
create or replace function public.notify_clear_remember(
  p_kind  text,
  p_items jsonb
) returns int
  language plpgsql
  security invoker
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_n   int;
begin
  if coalesce(v_uid, '') = '' then return 0; end if;
  if p_kind is null or p_kind = '' then return 0; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return 0; end if;

  with incoming as (
    select distinct left(e.id, 200) as item_id
      from jsonb_array_elements_text(p_items) as e(id)
     where coalesce(e.id, '') <> ''
     limit 500                       -- one tap cannot clear more than a screen
  ), ins as (
    insert into public.notify_cleared (user_id, kind, item_id)
    select v_uid, left(p_kind, 60), i.item_id from incoming i
    on conflict (user_id, kind, item_id) do nothing
    returning 1
  )
  select count(*)::int into v_n from ins;

  -- Keep this account's own list bounded, oldest out first. Done here rather
  -- than by a cron because it is cheap, it is exact, and a table that only
  -- grows is a table somebody has to remember to look at.
  delete from public.notify_cleared c
   where c.user_id = v_uid
     and c.ctid not in (
       select c2.ctid from public.notify_cleared c2
        where c2.user_id = v_uid
        order by c2.cleared_at desc
        limit 400
     );

  return v_n;
end $fn$;

grant execute on function public.notify_cleared_mine(int)          to anon, authenticated;
grant execute on function public.notify_clear_remember(text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- Video space — one community video per region, live for 9 hours.
--
-- WHAT IT IS
--   The bottom of index.html used to hold the brand manifesto. It now holds a
--   video: whoever claims their region's slot first gets their clip shown to
--   everyone browsing that region for 9 hours. When the 9 hours are up (or no
--   one has claimed it), the slot falls back to a default video posted by an
--   admin.
--
-- THE ONE INVARIANT
--   At most ONE active video per region. That is not enforced in application
--   code — it is a partial unique index, so the database itself is the arbiter:
--
--       create unique index ... on region_videos (region)
--         where status in ('claiming','live');
--
--   Two users hitting "upload" in the same millisecond both reach the INSERT;
--   exactly one succeeds and the other gets a unique_violation, which the claim
--   RPC turns into a friendly "slot busy until HH:MM". This is the "first
--   upload wins" rule, and it needs no locks, no queue and no coordinator.
--
-- CLAIM BEFORE UPLOAD (why two phases)
--   The slot is claimed BEFORE the bytes are sent, so the loser of a race finds
--   out in ~50ms instead of after pushing 40 MB up a Tanzanian mobile link. A
--   claim that is never completed would wedge the region for 9 hours, so claims
--   carry a short claim_expires_at and are released automatically.
--
-- EXPIRY IS READ-TIME, NOT CRON-TIME
--   Every read filters on expires_at > now(), and the claim RPC releases aged
--   rows before it inserts. The cron sweep (region_video_ttl_cron.sql) only
--   deletes the storage blobs. So if the sweep is late or fails, viewers still
--   never see a stale video and the slot still frees on schedule — the cron is
--   a janitor, never a correctness dependency.
--
-- Idempotent. Run in the SQL editor or via scripts/db/run_sql.mjs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The slot log. Append-only in spirit: a row per claim, never updated in
--    place except to move status forward (claiming -> live -> expired).
-- ---------------------------------------------------------------------------
create table if not exists public.region_videos (
  id               uuid primary key default gen_random_uuid(),
  region           text        not null references public.regions(name) on update cascade,
  owner_user_id    uuid        not null references auth.users(id) on delete cascade,

  -- claiming = slot held, bytes not uploaded yet. live = playable. expired = done.
  status           text        not null default 'claiming'
                     check (status in ('claiming', 'live', 'expired')),

  storage_path     text,                      -- set at publish time
  duration_s       numeric,                   -- post-trim, as reported by the gateway
  bytes            bigint,
  mime             text,

  claimed_at       timestamptz not null default now(),
  claim_expires_at timestamptz not null default now() + interval '10 minutes',
  published_at     timestamptz,
  expires_at       timestamptz,               -- published_at + 9h

  created_at       timestamptz not null default now()
);

-- THE invariant. Partial, so expired rows pile up harmlessly as history.
create unique index if not exists region_videos_one_active
  on public.region_videos (region)
  where status in ('claiming', 'live');

-- The public read path: "what is live in this region right now".
create index if not exists region_videos_live_idx
  on public.region_videos (region, expires_at desc)
  where status = 'live';

-- The rate-limit lookup and the user's own history.
create index if not exists region_videos_owner_idx
  on public.region_videos (owner_user_id, created_at desc);

-- The sweep's scan.
create index if not exists region_videos_expiry_idx
  on public.region_videos (expires_at)
  where status in ('claiming', 'live');

-- ---------------------------------------------------------------------------
-- 2. Admin-posted defaults. One per region, plus a global fallback stored
--    under region = null, used by any region without its own default.
-- ---------------------------------------------------------------------------
create table if not exists public.region_video_defaults (
  id            uuid primary key default gen_random_uuid(),
  region        text references public.regions(name) on update cascade,
  storage_path  text        not null,
  label         text,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

-- One default per region, and exactly one global (region is null). A plain
-- unique constraint would treat every null as distinct — two global defaults
-- would both be accepted — so the global slot needs its own partial index over
-- an expression that is constant across exactly the rows the index covers.
create unique index if not exists region_video_defaults_region_uniq
  on public.region_video_defaults (region) where region is not null;
create unique index if not exists region_video_defaults_global_uniq
  on public.region_video_defaults ((region is null)) where region is null;

-- ---------------------------------------------------------------------------
-- 3. RLS. Reads are public (the video space is public). Writes go exclusively
--    through the SECURITY DEFINER RPCs below, so no client can invent a 'live'
--    row, hand itself someone else's slot, or set its own expires_at.
-- ---------------------------------------------------------------------------
alter table public.region_videos          enable row level security;
alter table public.region_video_defaults  enable row level security;

drop policy if exists "region_videos public read" on public.region_videos;
create policy "region_videos public read" on public.region_videos
  for select using (status = 'live' and expires_at > now());

-- A user may always see their own rows (so "your video expires at…" works even
-- after it has gone).
drop policy if exists "region_videos owner read" on public.region_videos;
create policy "region_videos owner read" on public.region_videos
  for select using (owner_user_id = auth.uid());

-- Owner may retire their own video early. Nothing else is client-writable.
drop policy if exists "region_videos owner delete" on public.region_videos;
create policy "region_videos owner delete" on public.region_videos
  for delete using (owner_user_id = auth.uid());

drop policy if exists "region_videos admin all" on public.region_videos;
create policy "region_videos admin all" on public.region_videos
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "region_video_defaults public read" on public.region_video_defaults;
create policy "region_video_defaults public read" on public.region_video_defaults
  for select using (true);

drop policy if exists "region_video_defaults admin write" on public.region_video_defaults;
create policy "region_video_defaults admin write" on public.region_video_defaults
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. Storage bucket. Separate from house-photos on purpose: the video space is
--    public, unauthenticated-readable and short-lived, and must not inherit the
--    listing bucket's policies (or be swept by the listing TTL job).
--
--    50 MB ceiling: 2m39s of phone video at a sane bitrate lands well under it,
--    and the gateway trims before upload, so anything near the cap is already
--    suspect. Videos only — no image types, so this bucket can never become a
--    second photo store.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('region-videos', 'region-videos', true, 52428800,
        array['video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public             = true,
      file_size_limit    = 52428800,
      allowed_mime_types = array['video/mp4', 'video/webm', 'video/quicktime'];

-- Anyone may watch. Only a signed-in user may write, and only under a prefix
-- that is their own uid — so nobody can overwrite another user's clip.
drop policy if exists "region-videos public read" on storage.objects;
create policy "region-videos public read" on storage.objects
  for select using (bucket_id = 'region-videos');

drop policy if exists "region-videos owner insert" on storage.objects;
create policy "region-videos owner insert" on storage.objects
  for insert with check (
    bucket_id = 'region-videos'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "region-videos owner delete" on storage.objects;
create policy "region-videos owner delete" on storage.objects
  for delete using (bucket_id = 'region-videos' and owner = auth.uid());

drop policy if exists "region-videos admin write" on storage.objects;
create policy "region-videos admin write" on storage.objects
  for all using (bucket_id = 'region-videos' and public.is_admin())
       with check (bucket_id = 'region-videos' and public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Release aged rows for one region. Called at the top of every claim so the
--    slot frees itself on read, with no dependency on the cron.
-- ---------------------------------------------------------------------------
create or replace function public.release_expired_region_videos(p_region text default null)
returns integer
language sql security definer set search_path = public as $$
  with released as (
    update public.region_videos
       set status = 'expired'
     where status in ('claiming', 'live')
       and (p_region is null or region = p_region)
       -- a live row dies at expires_at; an unfinished claim at claim_expires_at
       and coalesce(expires_at, claim_expires_at) <= now()
    returning 1
  )
  select count(*)::integer from released;
$$;

-- ---------------------------------------------------------------------------
-- 6. Claim the slot. Returns {ok:true, claim_id, expires_at} to the winner, or
--    {ok:false, reason:'slot_busy', free_at} to everyone else.
--
--    The unique index is what decides. We do NOT pre-check "is the slot free?"
--    and then insert — that read-then-write is exactly the race this design
--    exists to avoid.
-- ---------------------------------------------------------------------------
create or replace function public.claim_region_video_slot(p_region text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_free   timestamptz;
  v_recent timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth_required');
  end if;

  if p_region is null or not exists (select 1 from public.regions where name = p_region) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_region');
  end if;

  -- Free anything that has aged out in this region first.
  perform public.release_expired_region_videos(p_region);

  -- Rate limit: one published video per user per 9 hours, platform-wide. Without
  -- this a single user could hop regions and hold every slot in the country.
  select max(published_at) into v_recent
    from public.region_videos
   where owner_user_id = v_uid and published_at is not null;
  if v_recent is not null and v_recent > now() - interval '9 hours' then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
                              'retry_at', v_recent + interval '9 hours');
  end if;

  begin
    insert into public.region_videos (region, owner_user_id)
    values (p_region, v_uid)
    returning id into v_id;
  exception when unique_violation then
    select coalesce(expires_at, claim_expires_at) into v_free
      from public.region_videos
     where region = p_region and status in ('claiming', 'live')
     limit 1;
    return jsonb_build_object('ok', false, 'reason', 'slot_busy', 'free_at', v_free);
  end;

  return jsonb_build_object(
    'ok', true,
    'claim_id', v_id,
    'claim_expires_at', now() + interval '10 minutes'
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Publish: attach the uploaded object to the claim and start the 9 hours.
--    expires_at is computed HERE, server-side — the client never supplies it.
-- ---------------------------------------------------------------------------
create or replace function public.publish_region_video(
  p_claim_id   uuid,
  p_path       text,
  p_duration_s numeric default null,
  p_bytes      bigint  default null,
  p_mime       text    default null
)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_exp timestamptz := now() + interval '9 hours';
  v_hit integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth_required');
  end if;

  -- The path must live under the caller's own uid prefix. Storage RLS already
  -- enforces this on write; re-checking here stops a caller from pointing their
  -- claim at somebody else's object.
  if p_path is null or split_part(p_path, '/', 1) <> v_uid::text then
    return jsonb_build_object('ok', false, 'reason', 'bad_path');
  end if;

  -- 159s + a small grace for keyframe-aligned cuts. The gateway is the real
  -- enforcer; this rejects a client that skipped it.
  if p_duration_s is not null and p_duration_s > 165 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;

  update public.region_videos
     set status       = 'live',
         storage_path = p_path,
         duration_s   = p_duration_s,
         bytes        = p_bytes,
         mime         = p_mime,
         published_at = now(),
         expires_at   = v_exp
   where id = p_claim_id
     and owner_user_id = v_uid
     and status = 'claiming'
     and claim_expires_at > now();

  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    -- Claim was reaped, already published, or never belonged to this caller.
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. The read. One call returns whatever should play in a region right now:
--    the live community video, else the region default, else the global
--    default, else nothing.
-- ---------------------------------------------------------------------------
create or replace function public.current_region_video(p_region text default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v jsonb;
  d record;
begin
  select jsonb_build_object(
           'source', 'community', 'path', storage_path, 'region', region,
           'published_at', published_at, 'expires_at', expires_at,
           'duration_s', duration_s)
    into v
    from public.region_videos
   where status = 'live'
     and expires_at > now()
     and (p_region is null or region = p_region)
   order by published_at desc
   limit 1;

  if v is not null then
    return v;
  end if;

  -- Region default, then global default.
  select * into d from public.region_video_defaults
   where region is not distinct from p_region limit 1;
  if not found then
    select * into d from public.region_video_defaults where region is null limit 1;
  end if;
  if not found then
    return jsonb_build_object('source', 'none');
  end if;

  return jsonb_build_object('source', 'default', 'path', d.storage_path,
                            'region', d.region, 'label', d.label);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. Grants. Reads are open; the write RPCs need a signed-in caller (each one
--    re-checks auth.uid() itself, so anon calls fail closed).
-- ---------------------------------------------------------------------------
revoke all on function public.release_expired_region_videos(text) from public, anon;
grant execute on function public.current_region_video(text)          to anon, authenticated;
grant execute on function public.claim_region_video_slot(text)       to authenticated;
grant execute on function public.publish_region_video(uuid, text, numeric, bigint, text)
                                                                     to authenticated;

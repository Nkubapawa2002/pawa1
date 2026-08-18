-- ============================================================================
-- Hourly janitor for the video space (see region_video_space.sql).
--
-- Fires purge-expired-videos, which deletes the blobs behind expired slots and
-- sweeps orphans. Hourly rather than daily because these videos live 9 hours,
-- not 15 days — a daily sweep would leave up to a day of dead bytes in the
-- bucket.
--
-- This job is a storage optimisation, NOT a correctness dependency: expiry is
-- enforced at read time, so if pg_cron is unavailable the space still behaves
-- correctly and only the bucket grows. Separated from the core file so that,
-- if pg_cron isn't preloaded on this project yet, only THIS file fails (enable
-- "pg_cron" under Database -> Extensions, then re-run).
-- Idempotent. Run in the SQL editor or via scripts/db/run_sql.mjs.
-- ============================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- The entry point, mirroring delete_expired_houses(): release aged rows in SQL
-- (cheap, immediate, and the part that actually matters), then hand the blob
-- deletion to the Edge Function, because Supabase forbids direct SQL deletes on
-- storage.objects.
drop function if exists public.purge_expired_region_videos();
create or replace function public.purge_expired_region_videos()
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  v_url    text := 'https://kkdpacoiwntrcukgwksh.supabase.co/functions/v1/purge-expired-videos';
  v_secret text := '';
  v_req    bigint;
begin
  -- Free every aged slot right now, regardless of what the Edge Function does.
  perform public.release_expired_region_videos(null);

  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'purge_secret' limit 1;
  exception when others then
    v_secret := '';
  end;

  select net.http_post(
    url                  := v_url,
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'x-purge-key', coalesce(v_secret, '')),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_req;

  return v_req;
end;
$fn$;

revoke all on function public.purge_expired_region_videos() from public, anon, authenticated;

-- Replace any prior definition of the job, then (re)schedule it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-expired-region-videos') then
    perform cron.unschedule('purge-expired-region-videos');
  end if;
end $$;

-- :23 past the hour — off the top so it doesn't pile onto every other cron.
select cron.schedule(
  'purge-expired-region-videos',
  '23 * * * *',
  $$ select public.purge_expired_region_videos(); $$
);

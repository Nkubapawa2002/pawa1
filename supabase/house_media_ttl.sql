-- ============================================================================
-- House listings — 15-day Time-To-Live (rooms are ephemeral).
--
-- Every house/room listing lives for 15 days from the day it was posted
-- (houses.created_at). After that the WHOLE listing is removed automatically:
-- its media files (cover photo + photos[] + videos[]) are deleted from the
-- house-photos bucket via the Storage API, and the row itself is deleted. An
-- agent may delete their own listing (and its media) at any time before that.
--
-- WHY AN EDGE FUNCTION? Supabase forbids direct SQL deletes on storage.objects
-- ("Use the Storage API instead"), and a row-only delete would leave the photos
-- still downloadable by public URL. So the real purge runs in the
-- purge-expired-houses Edge Function (service role → Storage API). This SQL just
-- TRIGGERS it; the daily schedule lives in house_media_ttl_cron.sql.
--
-- Rental history is preserved: house_tenancies.house_id is ON DELETE SET NULL
-- and keeps a house_label snapshot.
-- Idempotent. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================

create extension if not exists pg_net;

-- Helps the public "hide expired" filter and the function's own scan.
create index if not exists houses_created_idx on public.houses (created_at);

-- ---------------------------------------------------------------------------
-- Storage: let an owner delete their OWN house-photos objects (so the agent's
-- "delete listing" Storage-API removal actually works — today no delete policy
-- exists, so those removals silently fail and orphan/expose the blobs). Admins
-- manage all. (These govern the Storage API; the raw-SQL delete ban is separate.)
-- ---------------------------------------------------------------------------
drop policy if exists "house-photos owner delete" on storage.objects;
create policy "house-photos owner delete" on storage.objects for delete
  using (bucket_id = 'house-photos' and owner = auth.uid());

drop policy if exists "house-photos admin write" on storage.objects;
create policy "house-photos admin write" on storage.objects for all
  using (bucket_id = 'house-photos' and public.is_admin())
  with check (bucket_id = 'house-photos' and public.is_admin());

-- ---------------------------------------------------------------------------
-- The daily sweep entry point. Fires the purge-expired-houses Edge Function via
-- pg_net (async) and returns the pg_net request id. If a 'purge_secret' exists
-- in Vault it is sent as x-purge-key so the endpoint can reject strangers.
-- (return type changed from the earlier version, so drop first.)
-- ---------------------------------------------------------------------------
drop function if exists public.delete_expired_houses();
create or replace function public.delete_expired_houses()
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  v_url    text := 'https://kkdpacoiwntrcukgwksh.supabase.co/functions/v1/purge-expired-houses';
  v_secret text := '';
  v_req    bigint;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'purge_secret' limit 1;
  exception when others then
    v_secret := '';
  end;

  -- 30s timeout: the purge can be slow on a cold start / many files. (pg_net only
  -- waits this long for the RESPONSE — the function runs to completion regardless.)
  select net.http_post(
    url                    := v_url,
    headers                := jsonb_build_object('Content-Type', 'application/json',
                                                 'x-purge-key', coalesce(v_secret, '')),
    body                   := '{}'::jsonb,
    timeout_milliseconds   := 30000
  ) into v_req;

  return v_req;
end;
$fn$;

-- Only the owner (postgres, via cron) and admins trigger a platform-wide sweep.
revoke all on function public.delete_expired_houses() from public, anon, authenticated;

-- ============================================================================
-- Daily schedule for the orphan-media garbage collector (gc-orphan-media edge
-- function — see supabase/functions/gc-orphan-media/index.ts). Sweeps every
-- directory bucket (house/truck/agent/service photos) for files no live row
-- references and deletes them via the Storage API.
--
-- Mirrors delete_expired_houses(): the SQL just TRIGGERS the function via pg_net
-- (the function holds the service role). Runs daily at 03:27 UTC.
-- Idempotent. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.gc_orphan_media()
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  v_url    text := 'https://kkdpacoiwntrcukgwksh.supabase.co/functions/v1/gc-orphan-media';
  v_secret text := '';
  v_req    bigint;
begin
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

revoke all on function public.gc_orphan_media() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'gc-orphan-media') then
    perform cron.unschedule('gc-orphan-media');
  end if;
end $$;

select cron.schedule('gc-orphan-media', '27 3 * * *', $$ select public.gc_orphan_media(); $$);

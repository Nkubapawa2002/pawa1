-- ============================================================================
-- Daily schedule for the house 15-day TTL sweep (see house_media_ttl.sql).
--
-- Runs delete_expired_houses() once a day at 03:17 UTC. Separated from the core
-- so that, if pg_cron isn't preloaded on this project yet, only THIS file fails
-- (enable "pg_cron" under Database → Extensions in the Supabase dashboard, then
-- re-run this file).
-- Idempotent. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================
create extension if not exists pg_cron;

-- Replace any prior definition of the job, then (re)schedule it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'delete-expired-houses') then
    perform cron.unschedule('delete-expired-houses');
  end if;
end $$;

select cron.schedule(
  'delete-expired-houses',
  '17 3 * * *',
  $$ select public.delete_expired_houses(); $$
);

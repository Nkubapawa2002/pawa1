-- ============================================================================
--  agent_notices_cron.sql — the renewal reminder, on a clock.
-- ============================================================================
--  agent_notices.sql gave the console a button that writes to every agent whose
--  subscription runs out inside a window. A button is the right thing to have
--  and the wrong thing to depend on: the whole point of a reminder is that it
--  arrives on the Tuesday nobody was thinking about renewals.
--
--  So it runs daily, at 06:41 UTC — 09:41 in Tanzania, which is a working
--  morning rather than the middle of the night, because the sentence it sends
--  ends with "pay the admin", and an admin who is awake can answer the phone
--  call it causes.
--
--  WHY pg_cron AND NOT n8n. This project already runs three jobs here
--  (delete-expired-houses, gc-orphan-media, purge-expired-region-videos) and
--  the extension is installed. The sweep is one SQL call against the same
--  database, so scheduling it anywhere else would mean a network hop, a
--  service-role key in a third place, and a second thing that can be down
--  while looking fine. n8n earns its keep where a workflow leaves the
--  database, which this one never does.
--
--  n8n/07_renewal_reminders.json is the same job as an importable workflow, for
--  an instance that wants it there instead. Running both is harmless -- the
--  dedupe key means the second one writes nothing -- but pick one, or the
--  cron.job entry below is the one to unschedule.
--
--  SAFE TO RUN EVERY DAY, and that is a property of the sweep rather than of
--  this schedule: agent_notices_remind() keys each reminder by the expiry date
--  it is warning about, so a week of runs writes one row per agent. It is also
--  what makes this file safe to re-run: unschedule, reschedule, nothing else.
--
--  Separated from agent_notices.sql so that a project without pg_cron
--  preloaded fails only HERE (enable "pg_cron" under Database → Extensions,
--  then re-run this file), exactly as house_media_ttl_cron.sql is separated
--  from house_media_ttl.sql.
--
--  Idempotent. Depends on agent_notices.sql.
-- ============================================================================

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'remind-expiring-agents') then
    perform cron.unschedule('remind-expiring-agents');
  end if;
end $$;

-- SEVEN DAYS, matching two things it must not disagree with: the default the
-- console's own button offers, and RENEW_DAYS in js/core/notify.js, which is
-- when the bell starts showing the subscription row. The written reminder and
-- the badge should appear together, not a week apart.
select cron.schedule(
  'remind-expiring-agents',
  '41 6 * * *',
  $$ select public.agent_notices_remind(7); $$
);

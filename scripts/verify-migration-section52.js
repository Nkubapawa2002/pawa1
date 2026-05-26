const PAT = process.env.SUPABASE_PAT;
const url = "https://api.supabase.com/v1/projects/kkdpacoiwntrcukgwksh/database/query";
async function q(s) { return fetch(url, { method:"POST", headers:{Authorization:`Bearer ${PAT}`,"Content-Type":"application/json"}, body: JSON.stringify({query:s}) }).then(r=>r.json()); }
(async () => {
  const Q = "'";
  const checks = [
    ["columns",      `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='bookings' and column_name in ('reminder_call_at','reminded_at','reminder_skipped') order by column_name`],
    ["index",        `select indexname from pg_indexes where schemaname='public' and tablename='bookings' and indexname='idx_bookings_reminder_due'`],
    ["trigger",      `select tgname from pg_trigger where tgrelid='public.bookings'::regclass and tgname='trg_set_default_reminder'`],
    ["functions",    `select proname from pg_proc where proname in ('booking_departure_ts','set_default_reminder','enqueue_due_trip_reminders','set_booking_reminder','skip_booking_reminder') order by proname`],
    ["cron job",     `select jobname, schedule, command from cron.job where jobname='pawa_trip_reminders'`],
    ["dry-run enqueue", `select public.enqueue_due_trip_reminders() as enqueued_count`],
  ];
  for (const [label, sql] of checks) {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(await q(sql), null, 2));
  }
})();

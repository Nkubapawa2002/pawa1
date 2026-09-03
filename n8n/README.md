# n8n workflows

## What is actually running

**Nothing here is, yet.** `APP_CONFIG.N8N_WEBHOOK_BASE` in `js/core/config.js`
is still `https://your-n8n.yourdomain.com`, and the bus-era workflows the older
docs list (`01_vapi_tools.json` and friends) have never been in this repo. This
folder holds workflows that are ready to import when there is an instance to
import them into.

The scheduled job they describe **is** running, in the database:

```sql
select jobname, schedule, active from cron.job;
--  delete-expired-houses        17 3 * * *
--  gc-orphan-media              27 3 * * *
--  purge-expired-region-videos  23 * * * *
--  remind-expiring-agents       41 6 * * *   <- this one
```

`supabase/features/agent/agent_notices_cron.sql` schedules it with pg_cron,
which this project already uses for the other three. It is one SQL call against
the same database, so scheduling it anywhere else means a network hop, a
service-role key in a third place, and a second thing that can be down while
looking fine.

**So import the workflow below only if you want the job to live in n8n
instead** — for example because you want the run to show up in the same
execution log as everything else, or to hang a Slack message off it. Then
unschedule the database one:

```sql
select cron.unschedule('remind-expiring-agents');
```

Running both is harmless: `agent_notices_remind()` keys each reminder by the
expiry date it is warning about, so whichever runs second writes nothing. But
two schedules for one job is two things to remember, and the point of the
reminder is that nobody has to remember it.

---

## 07_renewal_reminders.json

Writes a renewal reminder to every agent whose subscription ends inside seven
days: the date, and to pay the admin. It lands in their notification bell, on
their dashboard and on their Profile tab.

**Import**

1. n8n → Workflows → Import from File → `07_renewal_reminders.json`.
2. Settings → Environment Variables, if they are not already set:
   - `SUPABASE_URL` — `https://kkdpacoiwntrcukgwksh.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → service_role
3. Activate.

**Why the service-role key and not the anon one.** `agent_notices_remind()`
accepts an admin, a caller with no JWT at all (pg_cron, a migration), or the
role claim `service_role`. An anon or an ordinary signed-in session is refused,
because an agent must not be able to make the platform write to eighty
accounts. The check reads the JWT ROLE CLAIM rather than `current_user`: inside
a `SECURITY DEFINER` function `current_user` is the function's owner, which
would have been true for every caller alive.

**The key is a server secret.** It bypasses RLS entirely. It belongs in n8n's
environment variables and nowhere near `js/core/config.js`.

**Verify** without waiting for the morning:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/agent_notices_remind" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_days": 7}'
```

It returns a number: how many agents were newly reminded. **Zero is a normal
answer** — either nobody is close to expiring, or everybody who is has already
been told. It is not a failure, and treating it as one would have somebody
running it again.

**Seven days** is not arbitrary and should not be changed here alone. It
matches the default the admin console's own button offers and `RENEW_DAYS` in
`js/core/notify.js`, which is when the bell starts showing the subscription
row. The written reminder and the badge should appear together, not a week
apart.

Full write-up: `docs/NOTICES_AND_ADMIN.md`.

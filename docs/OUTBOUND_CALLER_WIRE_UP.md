# Wire up `06_outbound_caller.json` in n8n

This is the worker that turns rows in `call_requests` into actual phone
calls (booking reminders, agent callbacks, manager escalations). It polls
every 30 seconds, claims pending rows atomically, fires the VAPI
outbound-call API, and reconciles the row with whether VAPI accepted or
rejected the request.

Prerequisites (one-time):
- n8n instance running (cloud or self-hosted).
- A Supabase **direct** Postgres connection string (the pooler URL won't
  work for n8n's transactional Postgres node).
- A VAPI account with: a published assistant, a Twilio phone number
  attached, and a private (server) API key.

---

## 1. Import the workflow

n8n → **Workflows → Import from File** → pick
`n8n/06_outbound_caller.json` from the repo.

After import, leave it **inactive** until credentials are wired.

---

## 2. Create the Postgres credential

**Credentials → New → Postgres** with the name `Pawa Supabase Postgres`
(the workflow searches by this exact name — if you call it something
else, you'll have to bind it manually on each of the four Postgres
nodes).

Connection details from
**Supabase Dashboard → Project Settings → Database → Connection string**:

| Field | Value |
|---|---|
| Host | `db.kkdpacoiwntrcukgwksh.supabase.co` |
| Port | `5432` |
| Database | `postgres` |
| User | `postgres` |
| Password | (from Supabase dashboard) |
| SSL | `require` |

Click **Test** — it should say *Connection successful*.

> If you'd rather not click through every node, edit the workflow JSON
> before importing: find/replace `REPLACE_PG_CREDENTIAL_ID` with the
> internal id of your saved Postgres credential. n8n shows the id in the
> URL when you open the credential.

After saving the credential, re-open the workflow and confirm each of
the four Postgres nodes (`Fetch pending`, `Claim row`, `Mark started`,
`Mark failed`) shows `Pawa Supabase Postgres` selected. If not, click
each one and pick it from the dropdown.

---

## 3. Set three n8n environment variables

In n8n cloud: **Settings → Environment Variables**. In self-hosted:
edit your `docker-compose.yml` / systemd unit and set them on the n8n
process.

```
VAPI_PRIVATE_KEY=<your VAPI server / private key, starts with `vapi_priv_...`>
VAPI_ASSISTANT_ID=<assistant id from the VAPI dashboard>
VAPI_PHONE_NUMBER_ID=<phoneNumberId of the Twilio number you bought inside VAPI>
```

**Restart n8n** after setting these (cloud restarts itself; self-hosted
needs a `docker-compose restart` or `systemctl restart n8n`).

---

## 4. Activate

Open the workflow → toggle **Active** in the top-right.

You should immediately see the trigger fire every 30 seconds in the
**Executions** tab. With no rows in `call_requests` they'll be no-op
runs (Fetch pending returns 0 items, splitInBatches does nothing).

---

## 5. Test with a real call

Open `book-fast.html`, hold a seat, pay it through to confirmation. The
trip reminder is auto-armed for `departure − 2 h`. To exercise the
caller without waiting hours, you can yank the reminder back to "now"
with one SQL query (run in Supabase SQL editor or via the management
API):

```sql
update bookings
   set reminder_call_at = now() - interval '30 seconds',
       reminded_at      = null
 where ticket_code = '<your test ticket>';
```

Within ~90 seconds (pg_cron tick + n8n tick) your phone should ring,
VAPI's assistant should greet you with the reminder script, and the
`call_requests` row should show `status='started'` with a populated
`vapi_call_id`.

If the call **fails** (typical reasons: VAPI's outbound is rate-limited,
the phone is unreachable, the assistantId is wrong), the row flips to
`status='failed'` and `last_error` carries the VAPI response. The
workflow keeps running for the next row in the batch — one bad call
won't stall the queue.

---

## 6. Observability

Quick queries to sanity-check the pipeline:

```sql
-- last 10 calls and where they ended up
select id, phone, purpose, status, vapi_call_id,
       attempt_count, requested_at, last_error
  from call_requests
 order by requested_at desc
 limit 10;

-- anything stuck in 'dialing' for more than 2 minutes is a bug
select id, phone, requested_at, last_error
  from call_requests
 where status = 'dialing'
   and requested_at < now() - interval '2 minutes';

-- error rate over the last hour
select status, count(*)
  from call_requests
 where requested_at > now() - interval '1 hour'
 group by status;
```

---

## What the worker passes to VAPI

For each call, n8n POSTs to `https://api.vapi.ai/call/phone` with:

```jsonc
{
  "phoneNumberId":  "<VAPI_PHONE_NUMBER_ID>",
  "assistantId":    "<VAPI_ASSISTANT_ID>",
  "customer":       { "number": "<E.164 phone from call_requests>" },
  "assistantOverrides": {
    "variableValues": {
      "call_request_id": 4711,
      "ticket_code":     "BK260514-001",
      "purpose":         "trip_reminder",        // or "booking_follow_up", "manager_escalation"…
      "context": {
        "bus_name":       "Simba Coach",
        "origin":         "Dar es Salaam",
        "destination":    "Mwanza",
        "travel_date":    "2026-05-16",
        "departure_time": "06:00",
        "seat_number":    27
      }
    }
  }
}
```

In your VAPI assistant prompt you can reference these as
`{{variableValues.purpose}}`, `{{variableValues.context.bus_name}}` etc.
For trip reminders, branch the opening message on
`purpose === "trip_reminder"`:

> *"Habari, ni Pawa. Ukumbusho tu — basi lako {{variableValues.context.bus_name}}
> kutoka {{variableValues.context.origin}} kwenda
> {{variableValues.context.destination}} linaondoka {{variableValues.context.departure_time}}.
> Kiti chako ni namba {{variableValues.context.seat_number}}, tiketi
> {{variableValues.ticket_code}}. Safari njema!"*

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow says "Could not connect to Postgres" | Wrong host, password, or SSL not set to `require` | Re-test in the credential page |
| All rows flip to `failed` immediately | `VAPI_PRIVATE_KEY` missing or wrong | Verify in n8n env vars; redeploy |
| `failed` with `last_error` mentioning "phone number" | `VAPI_PHONE_NUMBER_ID` wrong (should be the *internal* id, not the E.164 number) | Copy the `phoneNumberId` from VAPI → Phone Numbers list, not the human-readable number |
| Rows stay `pending` and never get picked up | n8n workflow not Active, or cron not inserting (`select * from cron.job where jobname='pawa_trip_reminders'`) | Toggle Active; re-run `enqueue_due_trip_reminders()` manually to test |
| Caller can't hear anything | Assistant audio settings / Deepgram language wrong | Open the assistant in VAPI dashboard → Voice tab |

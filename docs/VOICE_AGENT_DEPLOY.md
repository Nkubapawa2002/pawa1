# Voice Agent Deployment Runbook

End-to-end checklist for pasting the n8n workflow into your n8n instance,
uploading the VAPI assistant, and going live. Follow top to bottom.

Scope of this runbook: **minimum voice booking** — search trips → reserve
seat → create payment → poll status → send ticket → cancel/refund. SMS is
wired but disabled until you add Africa's Talking credentials.

---

## Prerequisites you must have ready

| What | Where you'll paste it |
|---|---|
| n8n instance URL (cloud or self-hosted) | every `${N8N_HOST}` placeholder |
| VAPI account + public key | `bus web/js/config.js → VAPI_PUBLIC_KEY` |
| Supabase Postgres direct connection string | one n8n credential called `Pawa Supabase Postgres` |
| (later) Africa's Talking username + API key + sender ID | three n8n env vars: `AT_USERNAME`, `AT_API_KEY`, `AT_SHORTCODE` |
| (later) Twilio number bought inside VAPI dashboard | `VAPI_PHONE_NUMBER_ID` in config.js |

---

## 1. Import the n8n workflow

1. Open n8n → **Workflows** → **Import from File**.
2. Pick `n8n/10_vapi_tools_v2.json`.
3. The workflow lands with 36 nodes in 7 chains (one chain per VAPI tool).
4. **Don't activate yet** — credentials need to be set first.

### Create the Postgres credential

1. n8n → **Credentials** → **New** → **Postgres**.
2. Name: `Pawa Supabase Postgres` (the workflow looks for this exact name).
3. Host: from Supabase → Project Settings → Database → **Connection string**
   (use the direct connection, not the pooler, for transactional INSERTs).
4. Port: `5432` · Database: `postgres` · User: `postgres` · Password: from Supabase.
5. SSL: `require`.
6. Save.

### Bind it to each Postgres node

1. Open the workflow.
2. Click each `db_*` node (there are 7).
3. Under **Credential to connect with**, pick `Pawa Supabase Postgres`.
4. Save the workflow.

> If you'd rather do this once: open the workflow JSON, find/replace
> `REPLACE_PG_CREDENTIAL_ID` with your credential's internal id (visible in
> the credential's URL), then re-import.

### Africa's Talking SMS (deferred)

The node `at_send_sms_DISABLED` is intentionally disabled. When you have AT
credentials:

1. Set three n8n env vars on your instance: `AT_USERNAME`, `AT_API_KEY`,
   `AT_SHORTCODE`.
2. Click the node → toggle **Disable** off → rename to `at_send_sms`.
3. Save and re-activate the workflow.

### Activate

Toggle **Active** in the top-right. The webhooks listed below become live:

| Tool | Webhook URL (replace `${N8N_HOST}`) |
|---|---|
| search_trips | `${N8N_HOST}/webhook/vapi/search-trips` |
| reserve_seat | `${N8N_HOST}/webhook/vapi/reserve-seat` |
| get_payment_status | `${N8N_HOST}/webhook/vapi/payment-status` |
| send_ticket_sms | `${N8N_HOST}/webhook/vapi/send-ticket` |
| cancel_booking | `${N8N_HOST}/webhook/vapi/cancel-booking` |
| create_meet_room | `${N8N_HOST}/webhook/vapi/create-meet-room` |
| track_shipment | `${N8N_HOST}/webhook/vapi/track-shipment` |

> Verify with curl: `curl -X POST ${N8N_HOST}/webhook/vapi/search-trips -d '{"arguments":{"origin":"Dar es Salaam","destination":"Mwanza","date":"2026-08-01"}}' -H 'Content-Type: application/json'`

---

## 2. Configure the VAPI assistant

1. Open `bus web/voice/vapi-assistant.json` in an editor.
2. **Find/replace** `${N8N_HOST}` → your real n8n base URL (e.g.
   `https://pawa.app.n8n.cloud`). There are 7 occurrences (one per non-payment tool).
3. The `create_payment` URL is already pinned to the live project ref —
   leave it alone.
4. Open VAPI dashboard → **Assistants → Create** → paste the JSON.
5. After save, copy:
   - Assistant ID → `config.js → VAPI_ASSISTANT_ID`
   - Public key → `config.js → VAPI_PUBLIC_KEY`
6. Buy a Twilio number inside VAPI → copy its `phoneNumberId` →
   `config.js → VAPI_PHONE_NUMBER_ID`.

---

## 3. Update `bus web/js/config.js`

Set these five fields with the real values from step 2:

```js
N8N_WEBHOOK_BASE: "https://YOUR_N8N_BASE",   // same host you put into the assistant
VAPI_PUBLIC_KEY: "pk_...",
VAPI_ASSISTANT_ID: "asst_...",
VAPI_PHONE_NUMBER_ID: "...",                  // the Twilio phone-number id from VAPI
VIRTUAL_PHONE_NUMBER: "+255...",              // the number callers dial
```

---

## 4. Smoke test (end-to-end)

1. Open the dashboard → Buses & Routes → confirm at least one bus has a
   route entry (e.g. Dar es Salaam → Mwanza, departure 06:00). Without
   routes, `search_trips` returns nothing.
2. Click the VAPI call widget on `book-fast.html` and try:
   > "Habari, ninataka tiketi Dar kwenda Mwanza tarehe 2026-08-01."
3. In another tab run:
   ```
   SUPABASE_PAT=... node -e 'fetch("https://api.supabase.com/v1/projects/kkdpacoiwntrcukgwksh/database/query", { method:"POST", headers:{Authorization:`Bearer ${process.env.SUPABASE_PAT}`,"Content-Type":"application/json"}, body: JSON.stringify({query:"select ticket_code, status, expires_at from bookings order by created_at desc limit 3"}) }).then(r=>r.json()).then(console.log)'
   ```
   You should see a new row with `status='pending'` and an `expires_at`
   ~12 minutes in the future right after the AI says "Nimekuhifadhia kiti…".

---

## Browser payment flow (book-fast.html)

The booking page now has a self-serve **Pay & confirm** section that
appears as soon as a seat is held. It calls the `create-payment` edge
function directly — no voice agent required.

### Edge function: already deployed

`create-payment` is live at:
```
https://kkdpacoiwntrcukgwksh.functions.supabase.co/create-payment
```

`verify_jwt:false` so the browser anon key is enough. Re-deploy after any
code edit:
```bash
SUPABASE_PAT=sbp_... node scripts/deploy-create-payment.js
```

### Demo mode (current default)

Without any provider secrets, the function uses the `demo` provider:
1. Browser sends `{ reference, amount_tzs, method, phone }`.
2. Function inserts a `payments` row.
3. Function calls `demo.initiate()` (no real gateway hit).
4. Function auto-confirms: flips `payments.status = 'completed'` and
   `bookings.status = 'confirmed'`, sets the booking's `fare_tzs`.
5. The book-fast page's poller sees `confirmed` and reveals the ticket.

This lets you smoke-test the full booking → payment → confirmation flow
without any gateway credentials. To disable the auto-confirm later, set
`DEMO_AUTO_CONFIRM=false` in Supabase → Edge Functions → secrets.

### Going live with a real Tanzania provider

Add the secrets for whichever aggregator(s) you've signed up with via
Supabase Dashboard → Edge Functions → secrets:

| Provider | Required env vars |
|---|---|
| **Selcom** (M-Pesa, Tigo Pesa, Airtel, Halopesa, AzamPesa, NMB, CRDB, NBC, card) | `SELCOM_API_KEY`, `SELCOM_API_SECRET`, `SELCOM_VENDOR` |
| **ClickPesa** (M-Pesa, Tigo Pesa, Airtel) | `CLICKPESA_CLIENT_ID`, `CLICKPESA_API_KEY`, `CLICKPESA_WEBHOOK_SECRET` |
| **AzamPay** (M-Pesa, Tigo, Airtel, Halotel + banks) | `AZAMPAY_TOKEN` OR `AZAMPAY_CLIENT_ID` + `AZAMPAY_CLIENT_SECRET` + `AZAMPAY_APP_NAME` |
| **Flutterwave** (card + rails) | `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH` |

Then set `PRIMARY_PROVIDER` to one of `selcom | clickpesa | azampay | flutterwave`,
and optionally `PROVIDER_MPESA=clickpesa` etc. for per-method overrides.
Once a real provider is configured the auto-confirm shortcut is bypassed —
the booking only flips to `confirmed` once the gateway's HMAC-signed
callback hits the `payment-callback` workflow (not yet deployed in this
scope).

### Test the flow manually

1. Open `book-fast.html`, pick a bus and route, click a green seat.
2. The hold banner appears with the 12 min 54 sec countdown, then the
   Pay section opens below.
3. Pick "M-Pesa", confirm the prefilled amount, enter the paying phone.
4. Tap **Send USSD push & pay** → demo path immediately confirms.
5. Within 3 s the poller sees `bookings.status='confirmed'` and the
   ticket card unhides at the bottom of the page.

---

## What's NOT in this deploy (deferred)

The following workflows still target the old `trips/routes/seats` schema
and will throw if activated against the live DB:

- `01_vapi_tools.json` (the original; superseded by `10_vapi_tools_v2.json`)
- `01b_extended_tools.json` (cargo + freight quote + manager tools)
- `02_payment_callback.json` (HMAC verification + ticket SMS)
- `03_seat_hold_expiry.json` (cron: release HELD bookings after expiry)
- `04_lifecycle_messages.json` (pre-trip / mid-trip / feedback SMS)
- `05_retargeting.json` (7-day re-engagement SMS)

Mark them **inactive** in n8n until they're rewritten. For now, replace
the lifecycle cron with a simpler Postgres SQL job:

```sql
-- run every minute: release any HELD booking past its expiry
update bookings
   set status = 'cancelled', cancelled_at = now()
 where status = 'pending' and expires_at < now();
```

Schedule via Supabase → SQL editor → pg_cron, or via a tiny n8n workflow
with a 1-minute schedule trigger and a single Postgres node containing
the SQL above.

---

## Re-generating the workflow

If the schema changes (column renames, etc.) edit
`scripts/build-vapi-workflow.js` and run:

```
node scripts/build-vapi-workflow.js
```

That rewrites `n8n/10_vapi_tools_v2.json`. Re-import in n8n.

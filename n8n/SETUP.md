# n8n Setup Guide

This folder contains every n8n workflow Pawa uses today. Workflows that reference
the deprecated schema (with `trips`, `routes`, `seats` tables and uppercase
booking statuses) have been moved to `n8n/archive/` — do **not** re-import them.

---

## TL;DR — Import order for n8n Cloud

Do these phases in order. Inside a phase the order of individual workflows
doesn't matter, but the phases themselves are sequential — credentials before
workflows, workflows before activation, etc.

### Phase 0 · Database (one-time)
Run `supabase/schema_master.sql` in the Supabase SQL editor first. The
workflows below depend on columns this script adds (`call_requests.last_error`,
`call_requests.purpose`, `bookings.expires_at`, etc.).

### Phase 1 · Credentials in n8n Cloud
n8n Cloud → **Credentials → New** — create these *before* importing, otherwise
every imported node will sit there with a red "credential missing" badge.

1. **Pawa Supabase Postgres** — type "Postgres". Host, port, db, user, password
   from Supabase → Project Settings → Database. SSL = "Require".
2. **VAPI Bearer Auth** — type "HTTP Bearer Auth". Token = your VAPI private key (`vapi_priv_…`).
3. **Google Sheets OAuth2** — type "Google Sheets OAuth2". *(Optional — only if you keep workflows 2/3/4.)*

### Phase 2 · Env vars in n8n Cloud
n8n Cloud → **Settings → Variables** (or via the project's Environments tab).
Add: `VAPI_PRIVATE_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_ASSISTANT_ID`,
`AT_API_KEY`, `AT_USERNAME`, `AT_SENDER_ID`, `AT_CALLER_ID`, `AT_AGENT_PHONE`,
`SUPABASE_SERVICE_KEY`, `N8N_WEBHOOK_BASE`. Full descriptions in section 3 below.

### Phase 3 · Import workflows — in this exact order

n8n Cloud → **Workflows → top-right `…` → Import from File** — pick each JSON.
After importing each one, open every Postgres / VAPI / Google Sheets node and
re-select the credential (n8n doesn't auto-link by name across imports).
**Leave every workflow *inactive* for now** — we activate them in Phase 5.

| # | File | Group | Why this position |
|---|------|-------|-------------------|
| **1** | `10_vapi_tools_v2.json` | **A · VAPI tools (assistant brain)** | The VAPI assistant calls these. Import first so the URLs exist before you paste them into the VAPI dashboard. |
| **2** | `09_inbound_call_handler.json` | **B · Phone routing** | Virtual number → VAPI. Handles incoming calls from Africa's Talking / Twilio. |
| **3** | `07_agent_call_webhook.json` | B · Phone routing | Receives `/webhook/agent-call` from the web app and queues a real phone call. |
| **4** | `08_agent_call_answer.json` | B · Phone routing | The AT-Voice callback for #3 (returns the XML that connects the customer to the human agent). Import right after #3 — its URL is referenced inside #3's HTTP node. |
| **5** | `06_outbound_caller.json` | B · Phone routing | Cron worker (every 30 s) that drains the `call_requests` queue into VAPI calls. |
| **6** | `02_dashboard_metrics.json` | **C · Dashboard endpoints** | Powers the "Booking metrics" card on the company dashboard. |
| **7** | `workflow-1-active-calls.json` | **D · AI Logs viewer** | Powers the "Active calls" widget. Uses the VAPI Bearer credential, not Postgres. |
| **8** | `workflow-2-call-history.json` | D · AI Logs viewer | Reads "Calls Log" Google Sheet. *Skip 7–10 entirely if you're not using Google Sheets logging.* |
| **9** | `workflow-3-messages.json` | D · AI Logs viewer | Reads "Messages Log" Google Sheet. |
| **10** | `workflow-4-ai-responses.json` | D · AI Logs viewer | Reads "AI Responses" Google Sheet. |

### Phase 4 · Per-workflow fixups (after import, before activate)

- **All workflows** — re-select credentials on every Postgres / VAPI / Sheets node.
- **#1 `10_vapi_tools_v2.json`** — nothing extra; all 7 webhook URLs are now live as drafts.
- **#3 `07_agent_call_webhook.json`** — the inner HTTP node calls `{{ $env.N8N_WEBHOOK_BASE }}/webhook/agent-call-answer`. Confirm the env var is set so the AT callback URL is built correctly.
- **#8–#10 (sheet workflows)** — replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your sheet ID, and confirm the tab names match: `Calls Log`, `Messages Log`, `AI Responses`.

### Phase 5 · Activate

Toggle each workflow to **Active** in the same order as Phase 3 (top-down). Webhook URLs only work when active.

### Phase 6 · External hookups (one-time, per provider)

- Copy the URL from workflow **#2 (`09_inbound_call_handler`)** → paste into:
  - **Africa's Talking** Dashboard → Voice → Phone Numbers → *Action URL* (POST), **or**
  - **Twilio** Phone Numbers → Active Numbers → Voice → *A call comes in* → Webhook (POST).
- For each tool in workflow **#1 (`10_vapi_tools_v2`)**, copy the webhook URL into the matching tool's `server.url` field inside your VAPI assistant config (`voice/` folder). Map: `vapi/search-trips` → `search_trips`, `vapi/reserve-seat` → `reserve_seat`, `vapi/payment-status` → `payment_status`, `vapi/send-ticket` → `send_ticket`, `vapi/cancel-booking` → `cancel_booking`, `vapi/create-meet-room` → `create_meet_room`, `vapi/track-shipment` → `track_shipment`.
- In `js/config.js`, set `N8N_WEBHOOK_BASE` to your n8n Cloud workspace URL (no trailing slash). Reload the web app.

### Phase 7 · Smoke test

| Test | How |
|------|-----|
| Tools endpoint | `curl -X POST $N8N_WEBHOOK_BASE/webhook/vapi/search-trips -H 'Content-Type: application/json' -d '{"tenant_slug":"bus-tz-pawa","origin":"Dar es Salaam","destination":"Arusha","date":"2026-06-01"}'` — should return Swahili "Mabasi yanayopatikana…" |
| Dashboard metrics | Open `dashboard.html` → "Booking metrics" card → click Refresh. Card should populate without "Could not reach n8n". |
| Real-call webhook | Click the " Call me" button on `book-fast.html`. A row should appear in `call_requests` and the AT-Voice call should fire. |
| Inbound number | Dial the virtual number. You should hear the Swahili+English hold message and get a VAPI callback within ~10 s. |

---

## Workflows in this folder

| File | Webhook path(s) | Purpose | Trigger |
|---|---|---|---|
| `02_dashboard_metrics.json` | `/webhook/vapi/today-bookings-summary`<br>`/webhook/vapi/pending-holds` | Powers the dashboard "Booking metrics" card. | HTTP (called by `dashboard.js`) |
| `06_outbound_caller.json` | — | Picks up `call_requests` rows with `status='pending'`, dials them via VAPI. | Schedule (every 30 s) |
| `07_agent_call_webhook.json` | `/webhook/agent-call` | Front-end "request a real phone call" — inserts `call_requests`, dials customer via Africa's Talking Voice. | HTTP (called by `book-fast.js`, `calling-agent.js`) |
| `08_agent_call_answer.json` | `/webhook/agent-call-answer` | AT Voice callback when the customer picks up — connects them to the human agent number. | HTTP (from Africa's Talking) |
| `09_inbound_call_handler.json` | `/webhook/inbound-call` | Virtual phone number → triggers VAPI outbound to caller. | HTTP (from Africa's Talking / Twilio) |
| `10_vapi_tools_v2.json` | `/webhook/vapi/search-trips`<br>`/webhook/vapi/reserve-seat`<br>`/webhook/vapi/payment-status`<br>`/webhook/vapi/send-ticket`<br>`/webhook/vapi/cancel-booking`<br>`/webhook/vapi/create-meet-room`<br>`/webhook/vapi/track-shipment` | The VAPI assistant's tool endpoints. | HTTP (from VAPI assistant) |
| `workflow-1-active-calls.json` | `/webhook/ai/active-calls` | Returns live VAPI calls for the dashboard AI Logs tab. | HTTP (from `dashboard.js`) |
| `workflow-2-call-history.json` | `/webhook/ai/call-history` | Reads the "Calls Log" Google Sheet. | HTTP (from `dashboard.js`) |
| `workflow-3-messages.json` | `/webhook/ai/messages` | Reads the "Messages Log" Google Sheet. | HTTP (from `dashboard.js`) |
| `workflow-4-ai-responses.json` | `/webhook/ai/responses` | Reads the "AI Responses" Google Sheet. | HTTP (from `dashboard.js`) |

Everything else has been moved to `archive/` — see the note at the bottom.

---

## 1. Set your n8n base URL

Edit `js/config.js`:

```js
N8N_WEBHOOK_BASE: "https://n8n.yourdomain.com",   // no trailing slash
```

All front-end calls go to `N8N_WEBHOOK_BASE + /webhook/<path>`.

---

## 2. Credentials to create in n8n

| Credential | Type | Used by |
|---|---|---|
| **Pawa Supabase Postgres** | Postgres | 02, 06, 07, 08, 09, 10 |
| **VAPI Bearer Auth** | HTTP Bearer Auth (token = your VAPI private key) | workflow-1 |
| **Google Sheets OAuth2** | Google Sheets OAuth2 | workflow-2, 3, 4 |

After importing each workflow, re-open every node and re-pick the credential — n8n
won't auto-link them because the imported JSON has `REPLACE_PG_CREDENTIAL_ID` placeholders.

### Supabase Postgres connection details

From Supabase: **Project Settings → Database → Connection string** (Session pooler or direct).

- Host: `db.kkdpacoiwntrcukgwksh.supabase.co` (or your project's host)
- Port: 5432 (direct) or 6543 (pooler)
- Database: `postgres`
- User: `postgres`
- Password: your DB password
- SSL: required (n8n: "Allow" or "Require")

---

## 3. Environment variables to set in n8n

Open n8n's `.env` (or the docker `environment:` block) and add:

```bash
# VAPI
VAPI_PRIVATE_KEY=vapi_priv_...
VAPI_PHONE_NUMBER_ID=...
VAPI_ASSISTANT_ID=...

# Africa's Talking (SMS + Voice)
AT_API_KEY=...
AT_USERNAME=...                 # sandbox or your live username
AT_SENDER_ID=Pawa               # SMS sender ID / shortcode
AT_CALLER_ID=+255XXXXXXXXX      # AT Voice caller ID for outbound dials
AT_AGENT_PHONE=+255XXXXXXXXX    # human agent phone (08_agent_call_answer dials this)

# Supabase (for the inbound-call workflow's HTTP nodes)
SUPABASE_SERVICE_KEY=eyJ...     # service_role key, NOT the anon key

# n8n self-reference (for AT Voice callback URLs)
N8N_WEBHOOK_BASE=https://n8n.yourdomain.com
```

Restart n8n after editing env vars.

---

## 4. Import & activate workflows

In n8n: **Workflows → Import from file** for each JSON.

After importing each one:
1. Open every Postgres node → pick the **Pawa Supabase Postgres** credential.
2. (`workflow-1` only) Open the "VAPI Get Active Calls" node → pick **VAPI Bearer Auth**.
3. (`workflow-2/3/4` only) Open the Google Sheets node → pick **Google Sheets OAuth2** and replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your sheet ID.
4. Toggle the workflow to **Active**.

---

## 5. External hookups

### Africa's Talking voice number → inbound-call

AT Dashboard → Voice → Phone Numbers → set **Action URL** to:
```
https://n8n.yourdomain.com/webhook/inbound-call    (POST)
```

(Twilio alternative: Phone Numbers → Active Numbers → Voice → A call comes in → Webhook with the same URL.)

### VAPI assistant → tools

In the VAPI assistant config (`voice/` folder), each tool's `server.url` should
point to the matching `/webhook/vapi/...` path on your n8n. The seven tools that
match `10_vapi_tools_v2.json` are: `search_trips`, `reserve_seat`, `payment_status`,
`send_ticket`, `cancel_booking`, `create_meet_room`, `track_shipment`.

### Google Sheets logging (optional)

The AI Logs tab is purely a viewer — it reads from sheets. To populate them,
add a "Google Sheets → Append Row" node at the end of whichever workflow handles
your real VAPI / SMS / WhatsApp events, with these column shapes:

**Calls Log**
```
call_id | phone_number | direction | status | duration_seconds | summary | created_at | ended_at | tenant_slug
```

**Messages Log**
```
message_id | phone_number | channel | direction | content | ai_reply | sent_at | tenant_slug
```
`channel`: `sms` | `whatsapp`. `direction`: `inbound` | `outbound`.

**AI Responses**
```
session_id | phone_number | channel | user_message | ai_response | intent | model | timestamp | tenant_slug
```

The `tenant_slug` column is critical — the dashboard filters by it.

---

## 6. Schema dependencies

These workflows expect the live schema in `supabase/schema_master.sql`. The
columns they read or write:

- **bookings**: `ticket_code`, `bus_id`, `bus_name`, `origin`, `destination`,
  `travel_date`, `departure_time`, `seat_number`, `passenger_name`, `passenger_phone`,
  `fare_tzs`, `status` (lowercase: `pending`/`confirmed`/`cancelled`/`expired`/…),
  `expires_at`, `tenant_id`.
- **buses**: `id`, `name`, `seats_total`, `fare_per_km`, `routes` (jsonb),
  `ticket_prefix`, `tenant_id`.
- **call_requests**: `phone`, `status`, `ticket_code`, `purpose`, `context`,
  `at_session_id`, `vapi_call_id`, `attempt_count`, `last_error`, `tenant_id`.
- **tenants**: `id`, `slug`.

If `call_requests.last_error`, `purpose`, or `created_by` don't exist in your DB
yet, re-run `supabase/schema_master.sql` (they're idempotent `add column if not exists`).

---

## Archive

`n8n/archive/` holds the prior generation of workflows that targeted the
pre-tenant schema (with `seats`, `trips`, `routes` tables and `HELD`/`CONFIRMED`
booking statuses). They will fail on import because the tables they reference
no longer exist. Replacements:

| Archived | Replaced by |
|---|---|
| `01_vapi_tools.json` | `10_vapi_tools_v2.json` |
| `01b_extended_tools.json` | `02_dashboard_metrics.json` (only the two endpoints the dashboard actually uses) |
| `02_payment_callback.json` | Supabase Edge Function `payment-callback` (in `supabase/functions/`) |
| `03_seat_hold_expiry.json` | `bookings.expires_at` + DB-side cleanup (the live schema makes holds expire by timestamp, not by a seats table) |
| `04_lifecycle_messages.json` | `trip_reminders` table + `pg_cron` job `pawa_trip_reminders` (see schema section 53) |
| `05_retargeting.json` | (not yet ported — open an issue if you need 7-day re-engagement SMS) |
| `db_schema*.sql` | `supabase/schema_master.sql` |

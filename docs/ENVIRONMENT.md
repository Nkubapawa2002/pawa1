# BUS TZ PAWA — Environment Manifest

> Single source of truth for every credential, secret, and configuration value the Claude-powered voice agent needs. If a value isn't on this list, the agent doesn't depend on it.

System topology:

```
[Customer phone / WhatsApp / Web]
            │
            ▼
       VAPI assistant ── (LLM = Anthropic Claude) ── ANTHROPIC_API_KEY
            │
            ▼  HTTPS webhooks
       n8n workflows ── tool execution
            │
            ├── Postgres BUS TZ PAWA (booking + agent-orchestration tables)
            ├── Postgres Pawa Website (Supabase: cargo, agents, buses, regions, shipments)
            ├── Africa's Talking      (SMS + WhatsApp)
            ├── Selcom / ClickPesa    (mobile money USSD push)
            ├── VAPI outbound call API (agent-initiated callbacks)
            └── SMTP                  (manager email alerts)
```

---

## 1. Credential checklist

Each row is one secret you must set. **Owner** = where it lives. **Set with** = exact command or UI path.

| # | Key | Owner | Set with | Used by |
|---|---|---|---|---|
| 1 | `ANTHROPIC_API_KEY` | VAPI assistant + n8n env | VAPI → Provider Keys → Anthropic; `n8n` → Settings → Environment Variables | Claude inference for every voice/chat turn |
| 2 | `SUPABASE_URL` | Browser (`bus web/js/config.js`) + Edge Functions | Edit `bus web/js/config.js`; `supabase secrets set SUPABASE_URL=...` | Frontend + Edge Functions |
| 3 | `SUPABASE_ANON_KEY` | Browser (`bus web/js/config.js`) | Edit `bus web/js/config.js` | Public RLS-protected reads/writes |
| 4 | `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions only | `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...` | Server-side bypass for Edge Functions |
| 5 | Postgres BUS TZ PAWA — host/db/user/pass/port | n8n credential `Postgres BUS TZ PAWA` | n8n → Settings → Credentials → New → Postgres | All booking tools (workflow 01) + extended tools (01b) |
| 6 | Postgres Pawa Website — host/db/user/pass/port | n8n credential `Postgres Pawa Website` | n8n → Settings → Credentials → New → Postgres (point at the website's Supabase) | Cargo tools in 01b (`find_agents`, `find_buses_for_route`, `track_shipment`, `register_shipment`) |
| 7 | `AT_API_KEY` | n8n env | `Settings → Env Vars` | SMS + WhatsApp send |
| 8 | `AT_USERNAME` | n8n env | same | Africa's Talking auth |
| 9 | `AT_SENDER_ID` | n8n env | same | SMS sender display name (≤ 11 chars, requires AT approval) |
| 10 | `AT_WHATSAPP_NUMBER` | n8n env | same | `send_whatsapp` tool |
| 11 | `PAYMENT_GATEWAY_URL` | n8n env | same | `initiate_payment` tool |
| 12 | `PAYMENT_GATEWAY_TOKEN` | n8n env | same | Bearer auth to gateway |
| 13 | `PAYMENT_GATEWAY_SECRET` | n8n env | same | HMAC verification on payment callback |
| 14 | `VAPI_PRIVATE_KEY` | n8n env | same | Outbound call API auth |
| 15 | `VAPI_PHONE_NUMBER_ID` | n8n env | same | Originating number for outbound calls |
| 16 | `VAPI_ASSISTANT_ID` | n8n env + browser config | n8n env vars; `bus web/js/config.js` for the in-browser voice widget | Wires outbound call to the PAWA assistant |
| 17 | `VAPI_PUBLIC_KEY` | Browser config | `bus web/js/config.js` | In-browser voice widget |
| 18 | `MANAGER_PHONE` | n8n env | same | Target of `manager_escalation` outbound calls |
| 19 | `MANAGER_EMAILS` | n8n env | same | Recipients of payment-confirmation email |
| 20 | `MANAGER_FROM_EMAIL` | n8n env | same | From address |
| 21 | `MANAGER_NOTIFY_URL` | n8n env | same | Slack/Telegram/internal webhook for `escalate` tool |
| 22 | `MANAGER_NOTIFY_TOKEN` | n8n env | same | Bearer for `MANAGER_NOTIFY_URL` |
| 23 | SMTP credential | n8n credential `SMTP BUS TZ PAWA` | n8n → Credentials → SMTP | Manager email alerts (workflow 02) |
| 24 | Selcom / ClickPesa / AzamPay / Flutterwave keys | Supabase Edge Function secrets | `supabase secrets set SELCOM_API_KEY=...` etc. | `bus web/supabase/functions/create-payment` |
| 25 | `MAPBOX_TOKEN` | Browser config | `bus web/js/config.js` | Optional — meet/track maps |

**What is NOT a credential** (don't put it on this list): tenant-specific runtime data (routes, buses, prices), seeded reference tables (`nearest_hubs`), or values that can be derived from the database.

---

## 2. Provisioning order

Do these in sequence. Each step has a verify-then-proceed gate.

### Step 1 — Get the Anthropic key

```bash
# Anthropic dashboard → API keys → Create key
# Name it: "BUS TZ PAWA — VAPI"
# Set Workspace usage limit (e.g. $200/mo) so a runaway loop can't drain you.
```

**Verify:** `curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"claude-opus-4-7","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'` returns 200.

### Step 2 — Create the two Postgres databases (or one if you're consolidating)

- **Booking DB** (`bustanzania`): run `n8n/db_schema.sql` then `n8n/db_schema_v2.sql`.
- **Website DB** (your existing Supabase project): already has the website schema. No change needed unless you want `call_requests` columns from v2 — in that case, run only the `ALTER TABLE call_requests` block from `db_schema_v2.sql` against it.

**Verify (booking DB):** `SELECT mint_booking_ref();` returns a `PAWA-…` string.

### Step 3 — Configure n8n credentials & env vars

1. Create both Postgres credentials with their real IDs.
2. In every workflow JSON, replace `REPLACE_PG_CREDENTIAL_ID` and `REPLACE_PG_WEBSITE_CREDENTIAL_ID` before importing.
3. Paste every n8n env var from the checklist (rows 7–22).

**Verify:** open `01b_extended_tools.json` post-import → click `DB Today Summary` → "Test step" → returns row with zero counts (assuming no bookings today).

### Step 4 — Import & activate workflows

```
01_vapi_tools.json
01b_extended_tools.json
02_payment_callback.json
03_seat_hold_expiry.json
04_lifecycle_messages.json
05_retargeting.json
06_outbound_caller.json
```

Activate each via the toggle. Note the production webhook URLs.

**Verify:** `curl -X POST https://your-n8n.com/webhook/vapi/today-bookings-summary -H "Content-Type: application/json" -d '{}'` returns the today-summary payload.

### Step 5 — Wire VAPI

1. Create assistant `PAWA — Bus TZ Booking Agent`.
2. Paste full system prompt from `BUS_TZ_PAWA_AGENT_PROMPT.md`.
3. Provider = **Anthropic**, model = `claude-opus-4-7`, temperature `0.3`, max tokens `500`.
4. Add **all 24 tools** (9 from `01_vapi_tools.json` + 15 from `01b_extended_tools.json`) — see SETUP_GUIDE.md sections 10 and "Tools 10–24".
5. Provision an inbound phone number in VAPI; copy `phoneNumberId` → `VAPI_PHONE_NUMBER_ID`.

**Verify:** in VAPI dashboard → "Test" the assistant. Say *"Habari, niambie buki za leo"*. Claude should call `today_bookings_summary` and read the result aloud.

### Step 6 — Africa's Talking

Sender ID approval can take 24–48 h in Tanzania. Until approved, use sandbox: `AT_USERNAME=sandbox`, `AT_SENDER_ID=AFTKTEST`.

**Verify:** `curl -X POST https://your-n8n.com/webhook/vapi/send-sms -H "Content-Type: application/json" -d '{"to":"0712345678","message":"Test from PAWA"}'` returns `SMS imetumwa kwa +255712345678.`

### Step 7 — Payment gateway

Set the gateway's callback URL to `https://your-n8n.com/webhook/vapi/payment-callback`. Set the same HMAC secret in both places (`PAYMENT_GATEWAY_SECRET` in n8n env, gateway dashboard config).

**Verify:** simulated callback in SETUP_GUIDE.md test 4 returns `{ "ok": true }` and writes a row to `payments`.

### Step 8 — Strip browser-side secrets

Open `bus web/js/config.js` and confirm `ANTHROPIC_API_KEY` is empty. Claude lives in VAPI/n8n now; the browser must never ship the key.

---

## 3. Daily smoke test

Run this once after any environment change:

```bash
# 1. Booking summary tool — proves DB + n8n + agent log path
curl -sX POST $N8N/webhook/vapi/today-bookings-summary -H "Content-Type: application/json" -d '{}' | jq

# 2. SMS tool — proves Africa's Talking auth
curl -sX POST $N8N/webhook/vapi/send-sms -H "Content-Type: application/json" \
  -d '{"to":"0712345678","message":"Smoke test from PAWA env check"}' | jq

# 3. Trigger outbound — proves VAPI outbound path (will actually call the number!)
# curl -sX POST $N8N/webhook/vapi/trigger-outbound-call -H "Content-Type: application/json" \
#   -d '{"to":"0712345678","purpose":"smoke_test"}' | jq

# 4. Cargo tool — proves the website Postgres credential
curl -sX POST $N8N/webhook/vapi/find-agents -H "Content-Type: application/json" \
  -d '{"region":"Dar es Salaam"}' | jq
```

If 1, 2, and 4 succeed, the agent has full operational power. Step 3 is dangerous in prod — only run with a phone you own.

---

## 4. Rotation & hygiene

- **Anthropic key:** rotate every 90 days; bind a usage cap in the Anthropic dashboard.
- **VAPI private key:** rotate on staff turnover.
- **Africa's Talking key:** rotate if the sender-ID changes.
- **Postgres passwords:** rotate via the host (Supabase, Railway, etc.) and update n8n credential.
- **Never commit** real secrets to the repo. `.env.example` is safe; `.env` is `.gitignore`d.
- **Audit:** `agent_actions_log` is your replay tape. `manager_actions` is your accountability ledger.

---

## 5. Failure modes & where to look

| Symptom | First place to check |
|---|---|
| Claude says "tool failed" generically | `agent_actions_log` for the call's `conversation_id` |
| Customer didn't get SMS | `message_log` filtered by phone — was it `sent` or `failed`? |
| Outbound call never fires | `call_requests` row stuck in `pending` → workflow 06 inactive, or `VAPI_PRIVATE_KEY` invalid |
| Manager not notified | `manager_actions` row exists but `MANAGER_NOTIFY_URL` returned non-200 |
| Cargo tool errors | wrong `Postgres Pawa Website` credential or website schema not migrated |
| All tools 404 | n8n workflow not activated (toggle off) |

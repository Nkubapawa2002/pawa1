# BUS TZ PAWA — Complete Setup & Connection Guide
## n8n + VAPI + PostgreSQL + Africa's Talking + Email

> This guide walks you through every step to go from a fresh server to a fully working AI-powered booking system. Follow the sections in order.

---

## TABLE OF CONTENTS

1. [Prerequisites & Accounts](#1-prerequisites--accounts)
2. [Database Setup (PostgreSQL)](#2-database-setup-postgresql)
3. [n8n Instance Setup](#3-n8n-instance-setup)
4. [n8n Credentials Configuration](#4-n8n-credentials-configuration)
5. [n8n Environment Variables](#5-n8n-environment-variables)
6. [Import & Activate Workflows](#6-import--activate-workflows)
7. [Workflow 01 — VAPI Tools (Node-by-Node Guide)](#7-workflow-01--vapi-tools-node-by-node-guide)
8. [Workflow 02 — Payment Callback & Ticket Delivery](#8-workflow-02--payment-callback--ticket-delivery)
9. [VAPI Assistant Configuration](#9-vapi-assistant-configuration)
10. [VAPI Tools — Webhook Connection per Tool](#10-vapi-tools--webhook-connection-per-tool)
11. [Africa's Talking SMS Setup](#11-africas-talking-sms-setup)
12. [SMTP Email Setup (Manager Notifications)](#12-smtp-email-setup-manager-notifications)
13. [Payment Gateway Setup](#13-payment-gateway-setup)
14. [End-to-End Testing Checklist](#14-end-to-end-testing-checklist)
15. [Troubleshooting Reference](#15-troubleshooting-reference)

---

## 1. Prerequisites & Accounts

You need the following before starting:

| Service | Purpose | URL |
|---|---|---|
| **n8n** | Workflow automation engine | https://n8n.io (cloud) or self-host |
| **PostgreSQL** | Database for bookings, seats, trips | Any Postgres 13+ host (Supabase, Railway, self-host) |
| **VAPI** | AI voice/chat agent | https://vapi.ai |
| **Africa's Talking** | SMS delivery to passengers | https://africastalking.com |
| **Payment Gateway** | USSD push (Selcom, Azampay, or similar) | Your provider's dashboard |
| **SMTP Server** | Email to managers after payment | Gmail, Zoho, SendGrid, or your own |

---

## 2. Database Setup (PostgreSQL)

### Step 1: Create the database

```sql
CREATE DATABASE bustanzania;
```

### Step 2: Run the schemas

Run **both** files against your database, in order:

1. `n8n/db_schema.sql` — base ticketing schema (routes, trips, seats, bookings, payments, complaints, service_gaps, nearest_hubs).
2. `n8n/db_schema_v2.sql` — Claude-agent additions (call_requests columns, scheduled_reminders, manager_actions, agent_actions_log, message_log, parcel_quotes, customer_history view, mint_*_ref helpers).

`db_schema_v2.sql` is idempotent — re-running it is safe. The base file creates:

| Table | Purpose |
|---|---|
| `routes` | Origin/destination pairs with base price |
| `buses` | Bus fleet (plate, class, seat count) |
| `trips` | Scheduled departures linking route + bus |
| `seats` | Individual seats per trip with status |
| `bookings` | Customer bookings with payment method and status |
| `payments` | Payment transaction log with raw callback |
| `complaints` | Escalated issues from the agent |
| `service_gaps` | Districts customers requested that we don't serve |
| `nearest_hubs` | Static lookup: remote district → nearest hub |

### Step 3: Seed trips for testing

After running the schema, add test trips so the agent can search:

```sql
-- Add a bus first
INSERT INTO buses (plate, class, seat_count) VALUES ('T123 DAR', 'economy', 50);

-- Add a trip (tomorrow 05:00 Dar → Mbeya)
INSERT INTO trips (route_id, bus_id, departure_at, price, status)
SELECT r.id, b.id, NOW() + INTERVAL '1 day' + TIME '05:00', 30000, 'SCHEDULED'
FROM routes r, buses b
WHERE r.origin = 'Dar es Salaam' AND r.destination = 'Mbeya'
AND b.plate = 'T123 DAR';

-- Add seats for that trip
INSERT INTO seats (trip_id, seat_number, is_window)
SELECT t.id, generate_series(1, 50), (generate_series(1,50) % 4 = 1)
FROM trips t WHERE t.price = 30000 LIMIT 1;
```

---

## 3. n8n Instance Setup

### Option A: n8n Cloud

1. Sign up at https://app.n8n.cloud
2. Your webhook base URL will be: `https://your-workspace.app.n8n.cloud`
3. Note this URL — you will use it as `N8N_WEBHOOK_BASE`

### Option B: Self-hosted (Docker)

```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -e N8N_BASIC_AUTH_ACTIVE=true \
  -e N8N_BASIC_AUTH_USER=admin \
  -e N8N_BASIC_AUTH_PASSWORD=yourpassword \
  -e WEBHOOK_URL=https://your-domain.com \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

> **Important:** Your n8n instance must be publicly accessible on HTTPS for VAPI webhooks to reach it. Use a reverse proxy (nginx/Caddy) with a domain and SSL certificate if self-hosting.

---

## 4. n8n Credentials Configuration

Go to **Settings → Credentials → New Credential** for each of the following.

---

### 4A. PostgreSQL Credential

**Credential Type:** `PostgreSQL`

| Field | Value |
|---|---|
| **Name** | `Postgres BUS TZ PAWA` |
| **Host** | Your Postgres host (e.g. `db.supabase.co`) |
| **Database** | `bustanzania` |
| **User** | Your Postgres user |
| **Password** | Your Postgres password |
| **Port** | `5432` (default) |
| **SSL** | Enable if your host requires it (Supabase: Yes) |

After saving, **copy the credential ID** from the URL bar (it looks like `abc123xyz`).

Then open each JSON workflow file and replace every instance of:
```
"id": "REPLACE_PG_CREDENTIAL_ID"
```
with your actual credential ID:
```
"id": "abc123xyz"
```

Do this for all 5 workflow files: `01_vapi_tools.json`, `02_payment_callback.json`, `03_seat_hold_expiry.json`, `04_lifecycle_messages.json`, `05_retargeting.json`

---

### 4B. SMTP Credential (for Manager Email Alerts)

**Credential Type:** `SMTP`

| Field | Gmail Example | Zoho Example |
|---|---|---|
| **Name** | `SMTP BUS TZ PAWA` | `SMTP BUS TZ PAWA` |
| **Host** | `smtp.gmail.com` | `smtp.zoho.com` |
| **Port** | `465` | `465` |
| **SSL/TLS** | `SSL/TLS` | `SSL/TLS` |
| **User** | your-email@gmail.com | your-email@zoho.com |
| **Password** | App Password (not your Google password) | Your Zoho password |

> **Gmail users:** You must create an **App Password**:
> 1. Go to Google Account → Security → 2-Step Verification → App Passwords
> 2. Create an App Password for "Mail"
> 3. Use that 16-character password here, not your Google account password

After saving, copy the credential ID and replace `REPLACE_SMTP_CREDENTIAL_ID` in `02_payment_callback.json`.

---

## 5. n8n Environment Variables

Go to **Settings → Environment Variables** in n8n and add the following:

| Variable Name | Example Value | Required By |
|---|---|---|
| `N8N_WEBHOOK_BASE` | `https://your-n8n-domain.com` | Payment callback URL sent to gateway |
| `PAYMENT_GATEWAY_URL` | `https://api.selcom.net/v1` | Initiate USSD push |
| `PAYMENT_GATEWAY_TOKEN` | `Bearer sk_live_xxxxx` | Auth for payment gateway |
| `PAYMENT_GATEWAY_SECRET` | `whsec_xxxxx` | HMAC signature verification |
| `AT_API_KEY` | `atsk_xxxxx` | Africa's Talking SMS / WhatsApp |
| `AT_USERNAME` | `BusTZPawa` | Africa's Talking account username |
| `AT_SENDER_ID` | `BUSTزPAWA` | SMS sender name (max 11 chars, alphanumeric) |
| `AT_WHATSAPP_NUMBER` | `+255741000000` | Africa's Talking WhatsApp business number (for `send_whatsapp` tool) |
| `ANTHROPIC_API_KEY` | `sk-ant-api03-xxxxx` | Claude — used by VAPI as the assistant's LLM |
| `VAPI_PRIVATE_KEY` | `vapi_priv_xxxxx` | n8n → VAPI outbound call API |
| `VAPI_PHONE_NUMBER_ID` | `pn_xxxxx` | The VAPI-provisioned number used for outbound calls |
| `VAPI_ASSISTANT_ID` | `as_xxxxx` | The PAWA assistant ID in VAPI |
| `MANAGER_PHONE` | `+255741632744` | Phone the agent calls when it triggers `manager_escalation` |
| `MANAGER_EMAILS` | `ops@bustanzania.com,cfo@bustanzania.com` | Who receives payment email alerts |
| `MANAGER_FROM_EMAIL` | `noreply@bustanzania.com` | From address on manager emails |
| `MANAGER_NOTIFY_URL` | `https://yourapp.com/webhooks/escalate` | Escalation notification endpoint |
| `MANAGER_NOTIFY_TOKEN` | `Bearer your_token` | Auth for escalation endpoint |

> **Tip:** For `MANAGER_EMAILS`, separate multiple addresses with commas. The Email Managers node will send to all of them.

---

## 6. Import & Activate Workflows

### How to import a workflow in n8n

1. Click **"Add workflow"** (or the `+` button)
2. Click the three-dot menu `⋮` → **"Import from file"**
3. Select the JSON file from the `n8n/` folder
4. After import, click **"Save"**
5. Review all nodes for any red error indicators
6. Click the **toggle switch** (top right) to **Activate** the workflow

### Import order

Import in this order:

| # | File | Workflow Name |
|---|---|---|
| 1 | `01_vapi_tools.json` | BUS TZ PAWA — VAPI Tools |
| 2 | `01b_extended_tools.json` | BUS TZ PAWA — Extended Agent Tools (cargo + proactive + manager) |
| 3 | `02_payment_callback.json` | BUS TZ PAWA — Payment Callback & Ticket Delivery |
| 4 | `03_seat_hold_expiry.json` | BUS TZ PAWA — Seat Hold Expiry |
| 5 | `04_lifecycle_messages.json` | BUS TZ PAWA — Lifecycle Messages |
| 6 | `05_retargeting.json` | BUS TZ PAWA — Retargeting |
| 7 | `06_outbound_caller.json` | Pawa — Outbound Caller |

> **Two Postgres credentials.** `01b_extended_tools.json` references both `Postgres BUS TZ PAWA` (booking DB) and `Postgres Pawa Website` (the Supabase project that owns `agents`, `buses`, `shipments`, `regions`). Create both credentials and replace `REPLACE_PG_CREDENTIAL_ID` and `REPLACE_PG_WEBSITE_CREDENTIAL_ID` in the workflow JSON before activating. If you've consolidated everything into one database, point both credentials at the same host.

### Get webhook URLs after import

Once a workflow is activated, click any **Webhook node** and copy the **Production URL**. It will look like:

```
https://your-n8n-domain.com/webhook/vapi/search-trips
```

Save all webhook URLs — you will paste them into VAPI in section 10.

---

## 7. Workflow 01 — VAPI Tools (Node-by-Node Guide)

This workflow contains **9 tools** that the VAPI agent calls during conversations. Each tool is a mini-pipeline of 4 nodes: `Webhook → Parse Args → DB Query → Format → Respond`.

---

### Tool 1: search-trips

**What it does:** Searches available trips for a given origin, destination, and date.

#### Node: `WH /search-trips` (Webhook)
- **HTTP Method:** `POST`
- **Path:** `vapi/search-trips`
- **Response Mode:** `responseNode` (response is sent by the Respond node, not here)
- **Webhook URL (production):** `https://your-n8n.com/webhook/vapi/search-trips`

#### Node: `Parse Search Args` (Code)
Extracts `origin`, `destination`, `date` from VAPI's tool call JSON.

VAPI sends this format:
```json
{
  "message": {
    "toolCalls": [{
      "id": "call_abc123",
      "function": {
        "name": "search_trips",
        "arguments": "{\"origin\":\"Dar es Salaam\",\"destination\":\"Mbeya\",\"date\":\"2026-04-27\"}"
      }
    }]
  }
}
```

The node parses `arguments` (a JSON string) and extracts the fields. `toolCallId` is saved for the response.

#### Node: `DB Search Trips` (Postgres)
Runs this query:
```sql
SELECT t.id AS trip_id, r.origin, r.destination, t.departure_at, t.price,
  (SELECT COUNT(*) FROM seats s WHERE s.trip_id = t.id AND s.status = 'AVAILABLE') AS available_seats
FROM trips t JOIN routes r ON r.id = t.route_id
WHERE LOWER(r.origin) = LOWER($1)
  AND LOWER(r.destination) = LOWER($2)
  AND t.departure_at::date = $3::date
  AND t.status = 'SCHEDULED'
ORDER BY t.departure_at;
```
Parameters: `$1=origin`, `$2=destination`, `$3=date`

#### Node: `Format Search` (Code)
Formats DB rows into a Swahili text list. If no trips found, returns a polite "no trips" message. Output format VAPI requires:
```json
{ "results": [{ "toolCallId": "call_abc123", "result": "Safari zinazopatikana:\n1. Trip ID 5 | ..." }] }
```

#### Node: `Respond Search` (Respond to Webhook)
Sends the JSON back to VAPI. Set to:
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 2: check-seats

**What it does:** Returns available seat numbers for a given trip, prioritizing window seats if requested.

#### Node: `WH /check-seats` (Webhook)
- **Path:** `vapi/check-seats`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/check-seats`

#### Node: `Parse Seats Args` (Code)
Extracts: `trip_id` (integer), `prefer_window` (boolean, optional).

#### Node: `DB Available Seats` (Postgres)
```sql
SELECT seat_number, is_window FROM seats
WHERE trip_id = $1 AND status = 'AVAILABLE'
ORDER BY (CASE WHEN $2::boolean THEN is_window END) DESC NULLS LAST, seat_number
LIMIT 20;
```
If `prefer_window = true`, window seats appear first.

#### Node: `Format Seats` (Code)
Splits results into window seats and normal seats. Returns two lists. Returns "no seats" message if empty.

#### Node: `Respond Seats` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 3: hold-seat

**What it does:** Atomically locks a seat and creates a booking with HELD status. Uses `FOR UPDATE SKIP LOCKED` to prevent double-booking.

#### Node: `WH /hold-seat` (Webhook)
- **Path:** `vapi/hold-seat`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/hold-seat`

#### Node: `Parse Hold Args` (Code)
Extracts: `trip_id`, `seat_number`, `passenger_name`, `phone`, `id_type` (optional), `id_number` (optional), `payment_method` (default: `mpesa`).

Also:
- Normalizes phone to local format (strips `+255`, replaces with `0`)
- Generates booking ref: `PAWA-2026-XXXXXX` (random alphanumeric)

Throws an error if required fields are missing (n8n will return error to VAPI gracefully).

#### Node: `DB Create Hold` (Postgres)
Uses a CTE transaction:
1. `locked_seat` — selects the seat with `FOR UPDATE SKIP LOCKED`
2. `upd` — marks seat as `HELD`
3. `INSERT INTO bookings` — creates booking with:
   - `status = 'HELD'`
   - `hold_expires_at = NOW() + 10 minutes` (or 30 min for cash)

Returns: `ref`, `amount`, `hold_expires_at`, `payment_method`

If seat was just taken by someone else, returns 0 rows → Format node returns "seat taken" message.

#### Node: `Format Hold` (Code)
On success: returns booking ref, amount, and how many minutes the customer has to pay.
On failure (0 rows): returns "seat already taken" message in Swahili.

#### Node: `Respond Hold` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 4: initiate-payment

**What it does:** Tags the booking with payment provider, optionally updates the payment phone number, then sends a USSD push to the customer's phone.

#### Node: `WH /initiate-payment` (Webhook)
- **Path:** `vapi/initiate-payment`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/initiate-payment`

#### Node: `Parse Payment Args` (Code)
Extracts: `booking_ref`, `phone`, `alt_payment_phone` (optional), `payment_method`.

**Auto-detects provider from phone prefix:**

| Prefix | Provider |
|---|---|
| 071, 074, 075, 076 | mpesa |
| 065, 067, 077 | tigopesa |
| 068, 069, 078 | airtel |
| 062, 061 | halopesa |
| 066 | azampesa |

#### Node: `DB Tag Booking` (Postgres)
Updates the booking's `payment_method` and `alt_payment_phone` if different from registered phone:
```sql
UPDATE bookings SET payment_method = $2, alt_payment_phone = CASE WHEN $3 <> phone THEN $3 ELSE alt_payment_phone END
WHERE ref = $1 AND status = 'HELD'
RETURNING ref, amount, phone, hold_expires_at;
```

#### Node: `Send USSD Push` (HTTP Request)
**Method:** `POST`
**URL:** `{{ $env.PAYMENT_GATEWAY_URL }}/ussd-push`
**Headers:**
- `Authorization: Bearer {{ $env.PAYMENT_GATEWAY_TOKEN }}`
- `Content-Type: application/json`

**Body (JSON):**
```json
{
  "phone": "{{ push_phone }}",
  "amount": {{ booking.amount }},
  "reference": "{{ booking.ref }}",
  "provider": "{{ provider }}",
  "callback_url": "{{ $env.N8N_WEBHOOK_BASE }}/webhook/vapi/payment-callback"
}
```
> The `callback_url` tells the payment gateway where to send the result. This must be the URL of the Payment Callback Webhook in workflow 02.

**Options:** `ignoreHttpStatusErrors: true` — prevents n8n from stopping execution if the gateway returns a 4xx/5xx.

#### Node: `Format Payment` (Code)
Returns confirmation message: "USSD push sent to phone X. You have 10 minutes."

#### Node: `Respond Payment` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 5: cancel-booking

**What it does:** Cancels a booking, checks eligibility, and returns the appropriate refund or reschedule message.

#### Node: `WH /cancel-booking` (Webhook)
- **Path:** `vapi/cancel-booking`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/cancel-booking`

#### Node: `Parse Cancel Args` (Code)
Extracts: `booking_ref`, `choice` (`refund` or `reschedule`, default: `refund`)

#### Node: `DB Cancel Booking` (Postgres)
Uses a CTE to:
1. Check departure time eligibility (>2 hours = OK, <2 hours = LATE, past = NO_SHOW)
2. Update booking to `CANCELLED` if eligible
3. Release seat back to `AVAILABLE`

Returns: `eligibility`, `amount`, `cancelled` (count of rows updated)

**Eligibility rules:**
- `OK` → 75% refund available
- `LATE` → no refund, free reschedule only
- `NO_SHOW` → nothing

#### Node: `Format Cancel` (Code)
Returns appropriate Swahili message based on eligibility and customer's choice (refund vs reschedule).

#### Node: `Respond Cancel` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 6: nearest-hub

**What it does:** Looks up the nearest serviced hub for an unserved district, and logs the request as a service gap.

#### Node: `WH /nearest-hub` (Webhook)
- **Path:** `vapi/nearest-hub`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/nearest-hub`

#### Node: `Parse Hub Args` (Code)
Extracts: `district`, `region` (optional)

#### Node: `DB Lookup Hub` (Postgres)
Two operations in one CTE:
1. `lookup` — finds the hub in `nearest_hubs` table
2. `gap` — upserts into `service_gaps` to increment request count

Returns hub name, alt hub, and notes.

#### Node: `Format Hub` (Code)
If hub found: returns "Nearest hub is X. Can I book from there?"
If not found: returns a polite "we don't cover that area yet" message.

#### Node: `Respond Hub` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 7: escalate

**What it does:** Logs a customer complaint and notifies a manager via webhook.

#### Node: `WH /escalate` (Webhook)
- **Path:** `vapi/escalate`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/escalate`

#### Node: `Parse Escalate Args` (Code)
Extracts: `booking_ref` (optional), `phone` (optional), `summary` (free text of the issue)

#### Node: `DB Log Complaint` (Postgres)
Inserts into `complaints` table: `booking_ref`, `phone`, `summary`. Returns the new complaint `id`.

#### Node: `Notify Manager` (HTTP Request)
Sends a POST to `$env.MANAGER_NOTIFY_URL` with complaint details.

**Configuration:**
- **Method:** POST
- **URL:** `={{ $env.MANAGER_NOTIFY_URL }}`
- **Headers:** `Authorization: Bearer {{ $env.MANAGER_NOTIFY_TOKEN }}`
- **Body:** JSON with booking_ref, phone, summary, complaint_id

> Set `MANAGER_NOTIFY_URL` to your Slack webhook, Telegram bot URL, or internal API endpoint that pings the manager.

#### Node: `Format Escalate` (Code)
Returns: "Manager has been notified. They will call you within 1 hour."

#### Node: `Respond Escalate` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 8: find-next-available

**What it does:** Finds upcoming trips from a given datetime that still have seats. Used when a specific date is fully booked.

#### Node: `WH /find-next-available` (Webhook)
- **Path:** `vapi/find-next-available`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/find-next-available`

#### Node: `Parse NextAvail Args` (Code)
Extracts: `origin`, `destination`, `from_datetime` (ISO timestamp or YYYY-MM-DD), `limit` (1–10, default 5), `seats_needed` (default 1)

Normalizes date-only input to `YYYY-MM-DDT00:00:00` and defaults `from_datetime` to now.

#### Node: `DB Next Available` (Postgres)
Finds trips after `from_datetime` with at least `seats_needed` available seats. Returns up to `limit` results.

#### Node: `Format NextAvail` (Code)
Formats trips in Swahili with day names (Jumatatu, Jumanne, etc.) and Swahili month names. Returns "no trips found" if empty.

#### Node: `Respond NextAvail` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

### Tool 9: hold-next-available

**What it does:** Finds the next available seat across multiple upcoming trips and immediately holds it. One combined search + hold operation.

#### Node: `WH /hold-next-available` (Webhook)
- **Path:** `vapi/hold-next-available`
- **Webhook URL:** `https://your-n8n.com/webhook/vapi/hold-next-available`

#### Node: `Parse HoldNext Args` (Code)
Extracts all passenger details plus: `origin`, `destination`, `from_datetime`, `prefer_window`, `max_lookahead` (max trips to scan, 1–10, default 5)

Generates booking ref and normalizes phone.

#### Node: `DB Hold Next` (Postgres)
A large atomic CTE that:
1. Finds up to `max_lookahead` candidate trips from `from_datetime`
2. Locks the first available seat across all of them with `FOR UPDATE SKIP LOCKED`
3. Marks seat as `HELD`
4. Creates the booking

All in a single transaction — no race condition possible.

#### Node: `Format HoldNext` (Code)
Returns confirmed booking details: which trip, departure date/time in Swahili, seat number and type, amount, booking ref, time to pay.

#### Node: `Respond HoldNext` (Respond to Webhook)
- **Respond With:** `JSON`
- **Response Body:** `={{ $json }}`

---

## 8. Workflow 02 — Payment Callback & Ticket Delivery

This workflow is triggered by the **payment gateway** (not VAPI) when a payment attempt completes (success, failure, or insufficient funds).

### Full node flow:

```
Payment Callback Webhook
  → Verify HMAC
    → If Signature Valid
      → [VALID] Switch Status
          → [success]      DB Confirm Booking → Build Ticket SMS → Send Ticket SMS
                             → Calculate Payment Total → Email Managers → Acknowledge Provider
          → [insufficient] DB Log Insufficient → Acknowledge Provider
          → [failed]       DB Log Failed → Acknowledge Provider
      → [INVALID] Reject Bad Signature
```

---

### Node: `Payment Callback Webhook`

- **HTTP Method:** POST
- **Path:** `vapi/payment-callback`
- **Response Mode:** `responseNode`
- **Options:** `rawBody: true` — required for HMAC verification (must read the raw body before it gets parsed)

**Webhook URL:** `https://your-n8n.com/webhook/vapi/payment-callback`

> This URL goes into your payment gateway's dashboard as the callback/webhook URL. Some gateways call it "Result URL", "IPN URL", or "Notification URL".

---

### Node: `Verify HMAC` (Code)

Validates that the callback genuinely came from your payment gateway (not a spoofed request).

**How it works:**
1. Reads `x-signature` or `x-callback-signature` from the request headers
2. Computes `HMAC-SHA256(rawBody, PAYMENT_GATEWAY_SECRET)`
3. Compares computed hash with the header value
4. If `PAYMENT_GATEWAY_SECRET` env var is empty, skips verification (for testing)

**Output fields:**
- `valid` — boolean
- `ref` — booking reference
- `status` — `SUCCESS`, `INSUFFICIENT_FUNDS`, or `FAILED`
- `txn_ref` — payment gateway transaction ID
- `amount` — amount paid
- `provider` — mobile money provider
- `reason` — failure reason (if applicable)
- `raw` — full raw body for storage

---

### Node: `If Signature Valid`

- **Condition:** `valid === true`
- **True path** → Switch Status
- **False path** → Reject Bad Signature (returns HTTP 401)

---

### Node: `Switch Status`

Routes to different paths based on payment status:

| Output | Condition | Next Node |
|---|---|---|
| `success` | `status == "SUCCESS"` | DB Confirm Booking |
| `insufficient` | `status == "INSUFFICIENT_FUNDS"` | DB Log Insufficient |
| `failed` (fallback) | anything else | DB Log Failed |

---

### Node: `DB Confirm Booking` (Postgres)

On successful payment, runs a multi-step atomic CTE:
1. Updates `bookings` → `status = 'CONFIRMED'`, `paid_at = NOW()`
2. Updates `seats` → `status = 'CONFIRMED'`
3. Inserts into `payments` table with `status = 'SUCCESS'`
4. JOINs all tables to return full trip details for ticket generation

**Returns:** `ref`, `passenger_name`, `phone`, `amount`, `departure_at`, `origin`, `destination`, `seat_number`, `plate`, `class`

---

### Node: `Build Ticket SMS` (Code)

Builds the Swahili ticket SMS text using the booking data.

**Sample output:**
```
Bus TZ PAWA — Tiketi yako: PAWA-2026-AB1234
Jina: John Mwamba
Safari: Dar es Salaam -> Mbeya
Tarehe: 27/4/2026 saa 05:00
Kiti: 5
Basi: T123 DAR (economy)
Malipo: TZS 30,000 - YAMEKAMILIKA
Fika eneo la kupanda dakika 30 kabla. Safari njema!
```

---

### Node: `Send Ticket SMS` (HTTP Request)

Sends the SMS via Africa's Talking API.

**Configuration:**
- **Method:** POST
- **URL:** `https://api.africastalking.com/version1/messaging`
- **Headers:**
  - `apiKey: {{ $env.AT_API_KEY }}`
  - `Content-Type: application/x-www-form-urlencoded`
  - `Accept: application/json`
- **Body (form-urlencoded):**
  - `username: {{ $env.AT_USERNAME }}`
  - `to: {{ phone with +255 prefix }}`
  - `message: {{ $json.message }}`
  - `from: {{ $env.AT_SENDER_ID }}`

**Phone normalization:** The node auto-converts `07XXXXXXXX` to `+25507XXXXXXXX` for Africa's Talking.

---

### Node: `Calculate Payment Total` (Code) ← NEW

Pulls booking data from `DB Confirm Booking` using `$('DB Confirm Booking').first().json` and builds a formatted HTML email for managers.

**Output fields:**
- `ref` — booking reference
- `total_amount` — numeric amount in TZS
- `total_amount_formatted` — e.g. `TZS 30,000`
- `email_subject` — e.g. `[BUS TZ PAWA] Payment Confirmed: PAWA-2026-AB1234 — TZS 30,000`
- `email_html` — full HTML email with a styled table of all booking details

**Why this node is needed:** The `Send Ticket SMS` node's output only contains the SMS API response, not the booking data. This node reaches back to the DB Confirm Booking node to retrieve all the fields needed for the email.

---

### Node: `Email Managers` (Email Send) ← NEW

Sends the payment summary email to all managers.

**Credential:** `SMTP BUS TZ PAWA` (set up in section 4B)

**Configuration:**

| Field | Value |
|---|---|
| **From Email** | `={{ $env.MANAGER_FROM_EMAIL }}` |
| **To Email** | `={{ $env.MANAGER_EMAILS }}` |
| **Subject** | `={{ $json.email_subject }}` |
| **Email Type** | `HTML` |
| **HTML Body** | `={{ $json.email_html }}` |

**Manager receives an email like this:**

```
Subject: [BUS TZ PAWA] Payment Confirmed: PAWA-2026-AB1234 — TZS 30,000

BUS TZ PAWA — New Payment Received

Booking Ref    | PAWA-2026-AB1234
Passenger      | John Mwamba
Phone          | 0712345678
Route          | Dar es Salaam → Mbeya
Departure      | 27/4/2026 05:00
Seat           | 5
Bus            | T123 DAR (economy)
Total Paid     | TZS 30,000   ← highlighted green
Paid At        | 26/4/2026 14:32:00

Payment confirmed successfully.
```

---

### Node: `DB Log Insufficient` / `DB Log Failed` (Postgres)

Records failed payment attempts in the `payments` table with appropriate status. Does not change the booking status (seat remains HELD until the hold expires).

---

### Node: `Acknowledge Provider` (Respond to Webhook)

Returns `{ "ok": true }` with HTTP 200 to the payment gateway. **This must respond quickly** — most gateways timeout in 30 seconds. If the gateway doesn't receive an acknowledgement, it will retry the callback.

---

## 9. VAPI Assistant Configuration

### Step 1: Log in to VAPI

Go to https://dashboard.vapi.ai and log in.

---

### Step 2: Create a New Assistant

1. Click **"Assistants"** → **"Create Assistant"**
2. Choose **"Blank Assistant"**

---

### Step 3: Set Assistant Name and Voice

| Field | Value |
|---|---|
| **Name** | `PAWA - Bus TZ Booking Agent` |
| **Voice Provider** | `ElevenLabs` or `PlayHT` |
| **Voice** | Choose a warm, natural female or male Swahili voice |
| **Language** | `Swahili (sw)` — or set to `Multilingual` for Swahili + English |

---

### Step 4: Set the System Prompt

In the **"System Prompt"** field, paste the full contents of `BUS_TZ_PAWA_AGENT_PROMPT.md`.

This gives PAWA its:
- Identity and personality
- Service area knowledge
- Route and pricing reference
- Booking process flow
- Payment handling rules
- Swahili scripts for every situation

---

### Step 5: Configure Model Settings

| Field | Required Value |
|---|---|
| **Model Provider** | `Anthropic` |
| **Model** | `claude-opus-4-7` (preferred) or `claude-sonnet-4-6` (faster, cheaper) |
| **Temperature** | `0.3` (lower = more consistent, less creative) |
| **Max Tokens** | `500` (keep voice responses short) |

> **Anthropic credential in VAPI.** In VAPI dashboard → **Provider Keys** → **Anthropic**, paste your `ANTHROPIC_API_KEY` (the same value you set in n8n env). VAPI will use this key for every Claude inference during a call.

---

### Step 6: Voice Settings

| Field | Value |
|---|---|
| **End of Turn Detection** | `Smart` (recommended for Swahili) |
| **Background Noise Suppression** | Enabled |
| **Interruption Handling** | `Enabled` (allow customer to cut agent off) |

---

### Step 7: Configure Server URL (Webhook)

Under **"Server"** or **"Advanced"** settings:

**Server URL:** `https://your-n8n-domain.com/webhook/vapi/tool-calls`

> This is where VAPI sends tool call requests when the AI decides to invoke a tool during a conversation.

Actually with n8n, **each tool has its own webhook URL** (not a single server URL). In VAPI, set the Server URL per tool (explained in section 10).

---

## 10. VAPI Tools — Webhook Connection per Tool

In VAPI, go to **"Tools"** (left sidebar) → **"Create Tool"** for each of the following.

Each tool:
1. Has a name and description the AI uses to decide when to call it
2. Has parameters that the AI fills from the conversation
3. Has a Server URL (your n8n webhook URL)

---

### Tool 1: `search_trips`

**Tool Name:** `search_trips`
**Description:** Search for available bus trips between two cities on a specific date. Call this when the customer specifies origin, destination, and travel date.

**Server URL:** `https://your-n8n.com/webhook/vapi/search-trips`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `origin` | string | Yes | Departure city, e.g. "Dar es Salaam" |
| `destination` | string | Yes | Arrival city, e.g. "Mbeya" |
| `date` | string | Yes | Travel date in YYYY-MM-DD format |

---

### Tool 2: `check_seats`

**Tool Name:** `check_seats`
**Description:** Get available seat numbers for a specific trip. Call this after the customer selects a trip and you need to show them seat options.

**Server URL:** `https://your-n8n.com/webhook/vapi/check-seats`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `trip_id` | number | Yes | Trip ID returned by search_trips |
| `prefer_window` | boolean | No | Set true if customer prefers a window seat |

---

### Tool 3: `hold_seat`

**Tool Name:** `hold_seat`
**Description:** Reserve a specific seat for a passenger and create a booking. This locks the seat for 10 minutes (30 minutes for cash). Call this after the customer confirms their seat choice and provides their details.

**Server URL:** `https://your-n8n.com/webhook/vapi/hold-seat`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `trip_id` | number | Yes | Trip ID |
| `seat_number` | number | Yes | Selected seat number |
| `passenger_name` | string | Yes | Full name of the passenger |
| `phone` | string | Yes | Passenger's phone number (e.g. 0712345678) |
| `id_type` | string | No | NIDA, Passport, or Driving License |
| `id_number` | string | No | ID document number |
| `payment_method` | string | No | mpesa, tigopesa, airtel, halopesa, azampesa, cash (default: mpesa) |

---

### Tool 4: `initiate_payment`

**Tool Name:** `initiate_payment`
**Description:** Send a USSD push payment request to the customer's phone. Call this after the seat is held and the customer is ready to pay. The payment gateway will call back n8n when done.

**Server URL:** `https://your-n8n.com/webhook/vapi/initiate-payment`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `booking_ref` | string | Yes | Booking reference from hold_seat |
| `phone` | string | Yes | Customer's registered phone number |
| `alt_payment_phone` | string | No | Different phone to use for payment if registered phone has insufficient funds |
| `payment_method` | string | No | Payment provider (auto-detected from phone prefix if omitted) |

---

### Tool 5: `cancel_booking`

**Tool Name:** `cancel_booking`
**Description:** Cancel an existing booking. Returns the refund amount or reschedule option based on how far the departure is.

**Server URL:** `https://your-n8n.com/webhook/vapi/cancel-booking`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `booking_ref` | string | Yes | The booking reference to cancel |
| `choice` | string | No | "refund" or "reschedule" (default: refund) |

---

### Tool 6: `nearest_hub`

**Tool Name:** `nearest_hub`
**Description:** Find the nearest Bus TZ PAWA hub for a district that does not have a direct bus stop. Use this when a customer's origin or destination is not on a direct route.

**Server URL:** `https://your-n8n.com/webhook/vapi/nearest-hub`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `district` | string | Yes | The district name the customer mentioned |
| `region` | string | No | The region name (helps with logging) |

---

### Tool 7: `escalate`

**Tool Name:** `escalate`
**Description:** Log a complaint and notify a human manager. Call this when the customer is very unhappy, asks for a supervisor/manager, or the issue cannot be resolved by the agent.

**Server URL:** `https://your-n8n.com/webhook/vapi/escalate`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `booking_ref` | string | No | Related booking reference, if any |
| `phone` | string | No | Customer phone number |
| `summary` | string | Yes | Brief summary of the complaint or issue |

---

### Tool 8: `find_next_available`

**Tool Name:** `find_next_available`
**Description:** Find upcoming trips with available seats from a given date/time onwards. Use this when a customer's desired date is fully booked or when they want to see future options.

**Server URL:** `https://your-n8n.com/webhook/vapi/find-next-available`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `origin` | string | Yes | Departure city |
| `destination` | string | Yes | Arrival city |
| `from_datetime` | string | No | ISO datetime or YYYY-MM-DD to search from (default: now) |
| `limit` | number | No | Max results to return (1–10, default 5) |
| `seats_needed` | number | No | Minimum available seats required (default 1) |

---

### Tool 9: `hold_next_available`

**Tool Name:** `hold_next_available`
**Description:** Find the next available trip and immediately hold a seat for a passenger in one step. Use this when a customer wants to book immediately and doesn't care which specific trip, just the next one available.

**Server URL:** `https://your-n8n.com/webhook/vapi/hold-next-available`

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `origin` | string | Yes | Departure city |
| `destination` | string | Yes | Arrival city |
| `passenger_name` | string | Yes | Passenger's full name |
| `phone` | string | Yes | Passenger's phone number |
| `from_datetime` | string | No | Earliest acceptable departure (default: now) |
| `prefer_window` | boolean | No | Prefer window seat |
| `payment_method` | string | No | mpesa, tigopesa, airtel, halopesa, azampesa, cash |
| `id_type` | string | No | ID document type |
| `id_number` | string | No | ID document number |
| `max_lookahead` | number | No | How many upcoming trips to scan (1–10, default 5) |

---

### How to add tools to the VAPI assistant

1. In VAPI dashboard, go to your assistant → **"Tools"** tab
2. Click **"Add Tool"**
3. Select **"Custom Tool"** → **"Function"**
4. Fill in:
   - **Function Name** (must match the tool name exactly, e.g. `search_trips`)
   - **Description** (copy from above)
   - **Server URL** (your n8n webhook URL)
   - **Parameters** (add each parameter from the table above with correct type and required flag)
5. Click **Save**
6. Repeat for all 9 tools

---

### Tools 10–24: Extended Agent Tools (from `01b_extended_tools.json`)

After importing `01b_extended_tools.json` in n8n, register these 15 tools in VAPI the same way (Custom Tool → Function). Function name must match exactly. Server URL = `https://your-n8n.com/webhook/<path>` from the table below. Parameter shapes are documented in `BUS_TZ_PAWA_AGENT_PROMPT.md` under **EXTENDED TOOL CATALOG**.

#### Cargo / Parcel

| Function name | n8n path |
|---|---|
| `find_buses_for_route` | `vapi/find-buses-for-route` |
| `find_agents` | `vapi/find-agents` |
| `track_shipment` | `vapi/track-shipment` |
| `compute_freight_quote` | `vapi/compute-freight-quote` |
| `register_shipment` | `vapi/register-shipment` |

#### Proactive action

| Function name | n8n path |
|---|---|
| `send_sms` | `vapi/send-sms` |
| `send_whatsapp` | `vapi/send-whatsapp` |
| `trigger_outbound_call` | `vapi/trigger-outbound-call` |
| `schedule_reminder` | `vapi/schedule-reminder` |
| `get_bus_photo` | `vapi/get-bus-photo` |

#### Manager / operational

| Function name | n8n path |
|---|---|
| `today_bookings_summary` | `vapi/today-bookings-summary` |
| `revenue_summary` | `vapi/revenue-summary` |
| `pending_holds` | `vapi/pending-holds` |
| `service_gap_report` | `vapi/service-gap-report` |
| `customer_history` | `vapi/customer-history` |

---

## 11. Africa's Talking SMS Setup

1. Sign up at https://africastalking.com
2. Go to **SMS → Sender IDs** → request a Sender ID (e.g. `BUSTزPAWA`)
   - Sender IDs must be approved by Africa's Talking (takes 24–48 hours in Tanzania)
   - In sandbox mode, you can use `AFTKTEST`
3. Go to **Settings → API Key** → copy your API key
4. Set in n8n environment variables:
   - `AT_API_KEY` = your API key
   - `AT_USERNAME` = your Africa's Talking username (shown on dashboard)
   - `AT_SENDER_ID` = your approved Sender ID

**Sandbox testing:**
- Set `AT_USERNAME = sandbox`
- Use the Africa's Talking simulator to test SMS delivery without spending credits

---

## 12. SMTP Email Setup (Manager Notifications)

After a successful payment, managers receive an HTML email via the `Email Managers` node in workflow 02.

### Required setup:

1. Create the SMTP credential in n8n (see section 4B)
2. Set environment variables:
   - `MANAGER_FROM_EMAIL` = `noreply@bustanzania.com`
   - `MANAGER_EMAILS` = `manager1@bustanzania.com,manager2@bustanzania.com`
3. In `02_payment_callback.json`, replace `REPLACE_SMTP_CREDENTIAL_ID` with your actual SMTP credential ID

### What triggers the email:

Only **successful payments** (status = `SUCCESS`) trigger the email. Failed and insufficient-funds callbacks do NOT send emails to managers — they just log to the database.

### Email content:

Each email contains:
- Booking reference
- Passenger name and phone
- Route, departure date/time
- Seat number and bus details
- **Total amount paid (highlighted)**
- Exact timestamp of payment confirmation

---

## 13. Payment Gateway Setup

The payment gateway connects the n8n initiate-payment node to the actual mobile money network.

### Recommended gateways for Tanzania:

| Gateway | Providers Supported | Website |
|---|---|---|
| **Selcom** | M-Pesa, Tigo, Airtel, Halopesa, AzamPesa | selcom.net |
| **Azampay** | M-Pesa, Tigo, Airtel, Halopesa | azampay.co.tz |
| **Maxmalipo** | Multiple providers | maxmalipo.com |

### Configuration steps:

1. Sign up with your chosen gateway
2. Get your API credentials:
   - `PAYMENT_GATEWAY_URL` (API base URL, e.g. `https://apigw.selcommobile.com/v1`)
   - `PAYMENT_GATEWAY_TOKEN` (your API key or Bearer token)
   - `PAYMENT_GATEWAY_SECRET` (webhook secret for HMAC verification)
3. Set these in n8n environment variables
4. In the gateway dashboard, set the **Callback/Result URL** to:
   ```
   https://your-n8n.com/webhook/vapi/payment-callback
   ```
5. Set the **HMAC Secret** in the gateway dashboard — use the same value as `PAYMENT_GATEWAY_SECRET`

### How the payment flow works:

```
VAPI Agent
  → calls initiate_payment tool
  → n8n sends USSD push to gateway API
  → Gateway sends USSD prompt to customer's phone
  → Customer enters PIN
  → Gateway posts result to callback URL (n8n)
  → n8n verifies HMAC, confirms booking, sends ticket SMS + manager email
```

---

## 14. End-to-End Testing Checklist

### Test 1: Database connection
- Open any Postgres node in n8n, click **"Test credential"** — should show green checkmark

### Test 2: Search trips webhook (manual)

Use curl or Postman:
```bash
curl -X POST https://your-n8n.com/webhook/vapi/search-trips \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "toolCalls": [{
        "id": "test-001",
        "function": {
          "name": "search_trips",
          "arguments": "{\"origin\":\"Dar es Salaam\",\"destination\":\"Mbeya\",\"date\":\"2026-04-27\"}"
        }
      }]
    }
  }'
```

Expected response:
```json
{ "results": [{ "toolCallId": "test-001", "result": "Safari zinazopatikana:\n1. Trip ID 1 | ..." }] }
```

### Test 3: Hold seat webhook
```bash
curl -X POST https://your-n8n.com/webhook/vapi/hold-seat \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "toolCalls": [{
        "id": "test-002",
        "function": {
          "name": "hold_seat",
          "arguments": "{\"trip_id\":1,\"seat_number\":5,\"passenger_name\":\"John Mwamba\",\"phone\":\"0712345678\",\"payment_method\":\"mpesa\"}"
        }
      }]
    }
  }'
```

Expected: booking ref returned, seat marked HELD in database.

### Test 4: Payment callback (simulate success)
```bash
curl -X POST https://your-n8n.com/webhook/vapi/payment-callback \
  -H "Content-Type: application/json" \
  -H "x-signature: skip-for-testing" \
  -d '{
    "reference": "PAWA-2026-XXXXXX",
    "status": "SUCCESS",
    "transaction_id": "TXN-TEST-001",
    "amount": 30000,
    "provider": "mpesa"
  }'
```

> **Note:** Set `PAYMENT_GATEWAY_SECRET` to empty string `""` temporarily to skip HMAC verification during testing.

Expected:
- Booking status → CONFIRMED in database
- Seat status → CONFIRMED in database
- SMS sent to passenger phone (check Africa's Talking sandbox)
- Email sent to manager emails (check inbox)
- Response: `{ "ok": true }`

### Test 5: VAPI voice call
1. In VAPI dashboard → your assistant → click **"Test"**
2. Say: "Nataka tiketi ya kwenda Mbeya kesho"
3. Agent should ask for origin, date, then call `search_trips`
4. Check n8n execution history for the triggered workflow run
5. Complete a test booking end-to-end

### Test 6: Manager email content
After a successful payment, check the manager inbox. Verify:
- Subject contains booking ref and amount
- HTML table shows all booking details
- Total amount is highlighted in green
- Paid-at timestamp is in Tanzania time

---

## 15. Troubleshooting Reference

| Problem | Likely Cause | Fix |
|---|---|---|
| Webhook returns 404 | Workflow not activated | Toggle the workflow active switch |
| Webhook returns 502 | n8n not publicly accessible | Check your domain, nginx config, and SSL cert |
| "invalid signature" on payment callback | HMAC mismatch | Check `PAYMENT_GATEWAY_SECRET` matches gateway setting |
| DB query fails | Credential not set / wrong ID | Replace `REPLACE_PG_CREDENTIAL_ID` in JSON files |
| SMS not delivered | Wrong API key or username | Verify AT_API_KEY and AT_USERNAME in n8n env vars |
| Email not sending | SMTP auth failure | For Gmail, use App Password not Google password |
| Seat not released after hold expires | Workflow 03 not activated | Activate `03_seat_hold_expiry.json` |
| VAPI tool call times out | n8n takes >30s to respond | Check DB query performance, add indexes |
| Double booking | DB constraint missing | Ensure `FOR UPDATE SKIP LOCKED` is in the hold query |
| Email managers node shows red | Credential ID not replaced | Replace `REPLACE_SMTP_CREDENTIAL_ID` in JSON |
| VAPI tool not called | Wrong function name | Function name in VAPI must exactly match tool name |
| `$env.X` returns empty | Env var not set | Add the variable in n8n Settings → Environment Variables |

---

*BUS TZ PAWA — Tunakufanya usafiri kwa urahisi, usalama, na starehe.*

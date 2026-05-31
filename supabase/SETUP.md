# Supabase Setup Guide

The Pawa back-end runs entirely on Supabase: Postgres for data, Auth for user
identity, Storage for photos, and Edge Functions for everything that can't
safely run in the browser (payment provider calls, tenant secret encryption,
the AI agent loop). This folder is the single source of truth for all of it.

Older standalone schemas (`schema_v2.sql` … `schema_v10.sql`, `payments_schema.sql`,
`rides_schema.sql`, `meet_schema.sql`, the `fix_*.sql` patches, etc.) have been
merged into `schema_master.sql` and moved to `archive/` — do **not** re-run them.

---

## TL;DR — Setup order for Supabase Cloud

Do these phases in order. Inside a phase the order is flexible; the phases
themselves are sequential (you cannot deploy Edge Functions before the schema
exists; you cannot configure secrets before the project exists).

### Phase 0 · Create the project (one-time)

Supabase Cloud → **New project** → pick a region close to Tanzania
(`eu-west-2` is fine). Copy these for later:

- **Project URL**: `https://<ref>.supabase.co` → goes into `js/config.js` (`SUPABASE_URL`).
- **anon (publishable) key** → goes into `js/config.js` (`SUPABASE_ANON_KEY`). Safe to ship to browsers because RLS is enforced.
- **service_role key** → goes into n8n env vars (`SUPABASE_SERVICE_KEY`) and Edge Function secrets (Supabase auto-injects this as `SUPABASE_SERVICE_ROLE_KEY` — do not set it manually). **Never** put this in `js/config.js` — it bypasses RLS.
- **DB password** — used for the Postgres n8n credential.

### Phase 1 · Run the SQL — in this exact order

Supabase Cloud → **SQL Editor → New query** → paste each file in turn → **Run**.
Every file is idempotent (`create … if not exists`, `add column if not exists`),
so re-running them on an existing DB is safe.

| # | File | What it does | Why this position |
|---|------|--------------|-------------------|
| **1** | `schema_master.sql` | The full schema: tables, RLS policies, triggers, RPCs (booking, payments, agents, shipments, rides, meet rooms, tenants, reminders, pending-changes queue). | Defines every table the next files reference. Run this first or the others will error on missing relations. |
| **2** | `tenants_helpers_v2.sql` | The four tenant RPCs that `schema_master.sql` doesn't include: `tenant_id_for_slug`, `tenant_get_secrets`, `tenant_resolve_by_slug`, `update_tenant_secret`. They decrypt per-tenant API keys with a passphrase. | Edge functions (`agent-chat`, `get-tenant-config`, `update-tenant-keys`) call these by name; they must exist before those functions are invoked. |
| **3** | `fix_bus_photos_rls.sql` | Storage RLS policies for the `bus-photos` bucket (public read + authenticated upload/update/delete). | The bucket exists from Phase 2 below, but without these policies admins get "row violates row-level security" when uploading. Run after the bucket is created — see Phase 2. |
| **4** *(optional)* | `seed.sql` | Inserts the 26 Tanzania mainland regions and 12 demo bus companies. | Skip on production if you already have real bus data; run on fresh dev/demo DBs. |

> A typical first-time run of `schema_master.sql` takes ~30 seconds in the
> SQL Editor. If it times out, split it by section headers (lines starting with
> `-- 1.`, `-- 2.` …) and run each piece separately.

### Phase 2 · Storage buckets

Supabase Cloud → **Storage → New bucket** — create all three:

| Bucket | Public? | Max file size | Used by |
|--------|---------|---------------|---------|
| `bus-photos` | yes (read) | 20 MB | admin.html, dashboard.html bus photo uploads |
| `agent-photos` | yes (read) | 20 MB | agents.html, agent-register.html |
| `ride-driver-photos` | yes (read) | 20 MB | ride.html driver onboarding |

Then re-run `fix_bus_photos_rls.sql` (Phase 1 step 3) if you hadn't already —
it needs the `bus-photos` bucket to exist before the policies will attach.

The `agent-photos` and `ride-driver-photos` buckets have their policies created
inside `schema_master.sql`; only `bus-photos` needs the separate file.

### Phase 3 · Auth settings

Supabase Cloud → **Authentication → Providers → Email**:

- Enable Email Provider.
- For dev: turn off "Confirm email" so the demo admin and new tenant owners can sign in immediately.
- For production: leave confirmation on and configure SMTP under **Auth → SMTP Settings**.

The seed admin row (`pawa4761@gmail.com`) is inserted by section 3 of
`schema_master.sql`. To add other admins, insert into `public.admins` with
`email` + `role` (`admin` | `accountant` | `auditor`).

### Phase 4 · Edge Function secrets

Supabase Cloud → **Project Settings → Edge Functions → Secrets**. The
following are read by `Deno.env.get(...)` inside `functions/`:

```bash
# ---- Tenant secret encryption ----
TENANT_SECRET_PASSPHRASE=<random 32+ char string>   # used by tenants_helpers_v2 RPCs to AES-GCM tenant API keys

# ---- Platform admin allow-list ----
ADMIN_EMAILS=pawa4761@gmail.com                     # comma-separated; required by approve-tenant
ADMIN_PIN=                                          # optional second factor on approve-tenant (leave empty to disable)

# ---- Payment provider routing ----
PRIMARY_PROVIDER=selcom                             # selcom | clickpesa | azampay | flutterwave
# Optional method-specific overrides:
# PROVIDER_MPESA=clickpesa
# PROVIDER_CARD=flutterwave

# ---- Selcom ----
SELCOM_API_KEY=
SELCOM_API_SECRET=
SELCOM_VENDOR=

# ---- ClickPesa ----
CLICKPESA_CLIENT_ID=
CLICKPESA_API_KEY=
CLICKPESA_WEBHOOK_SECRET=

# ---- AzamPay ----
AZAMPAY_TOKEN=                                      # OR the OAuth pair below:
AZAMPAY_CLIENT_ID=
AZAMPAY_CLIENT_SECRET=
AZAMPAY_APP_NAME=

# ---- Flutterwave ----
FLW_SECRET_KEY=
FLW_HASH=

# ---- n8n base (for agent-chat to call tools) ----
N8N_WEBHOOK_BASE=https://n8n.yourdomain.com         # same value as js/config.js

# ---- Anthropic (global key for ai-chat / ai-think / ai-map) ----
ANTHROPIC_API_KEY=                                  # required by the three system AI functions; per-tenant keys still handle agent-chat
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by Supabase
into every Edge Function — do **not** set them manually.

### Phase 5 · Deploy Edge Functions — in this order

Install the Supabase CLI (`npm i -g supabase`), then from the **repo root**
run `supabase link --project-ref <your-ref>` once. After that, deploy each
function. Order matters only insofar as a function can't be tested until the
ones it depends on are live; you can deploy them in any order with the CLI but
the table below is the recommended onboarding sequence.

| # | Function | Endpoint | Depends on |
|---|----------|----------|------------|
| **1** | `create-tenant` | `POST /functions/v1/create-tenant` | Phase 1 schema only |
| **2** | `approve-tenant` | `POST /functions/v1/approve-tenant` | `create-tenant` (must have a tenant to approve), `ADMIN_EMAILS` env |
| **3** | `update-tenant-keys` | `POST /functions/v1/update-tenant-keys` | `tenants_helpers_v2.sql` (`update_tenant_secret` RPC), `TENANT_SECRET_PASSPHRASE` env |
| **4** | `get-tenant-config` | `POST /functions/v1/get-tenant-config` | `tenants_helpers_v2.sql` (`tenant_resolve_by_slug`, `tenant_get_secrets`), `TENANT_SECRET_PASSPHRASE` env |
| **5** | `create-payment` | `POST /functions/v1/create-payment` | All payment provider env vars + `_shared/` adapters |
| **6** | `payment-callback` | `POST /functions/v1/payment-callback?provider=<name>` | `create-payment` (writes the rows this function updates) |
| **7** | `agent-chat` | `POST /functions/v1/agent-chat` | `get-tenant-config`, `N8N_WEBHOOK_BASE` env, tenant must have `anthropic_api_key` set via #3 |
| **8** | `ai-chat`    | `POST /functions/v1/ai-chat`    | `ANTHROPIC_API_KEY` env — generic chat proxy for chat.html |
| **9** | `ai-think`   | `POST /functions/v1/ai-think`   | `ANTHROPIC_API_KEY` env — structured decision / algorithm engine |
| **10** | `ai-map`    | `POST /functions/v1/ai-map`     | `ANTHROPIC_API_KEY` env — natural-language map query parser |

Deploy command for each:

```bash
supabase functions deploy create-tenant
supabase functions deploy approve-tenant
supabase functions deploy update-tenant-keys
supabase functions deploy get-tenant-config
supabase functions deploy create-payment
supabase functions deploy payment-callback
supabase functions deploy agent-chat
supabase functions deploy ai-chat
supabase functions deploy ai-think
supabase functions deploy ai-map
```

Set the Anthropic key once for all three system AI functions:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

The `_shared/` folder is auto-bundled with every function that imports from it
(CORS helpers, payment provider adapters, registry) — you do **not** deploy it
separately.

### Phase 6 · Configure payment provider webhooks

For each payment provider you've enabled, set the callback URL to:

```
https://<your-ref>.supabase.co/functions/v1/payment-callback?provider=<name>
```

| Provider | Dashboard path | Query param |
|----------|----------------|-------------|
| Selcom   | Merchant portal → Webhooks → Callback URL | `?provider=selcom` |
| ClickPesa | Dashboard → Settings → Webhooks | `?provider=clickpesa` |
| AzamPay  | Sandbox → Callback URL | `?provider=azampay` |
| Flutterwave | Dashboard → Settings → Webhooks → Secret hash | `?provider=flutterwave` (also set `FLW_HASH` to the same value) |

### Phase 7 · Wire the front-end

Edit `js/config.js`:

```js
SUPABASE_URL:      "https://<your-ref>.supabase.co",
SUPABASE_ANON_KEY: "sb_publishable_...",                 // from Phase 0
ADMIN_EMAILS:      ["pawa4761@gmail.com"],
N8N_WEBHOOK_BASE:  "https://n8n.yourdomain.com",
```

(Voice / Mapbox / VAPI keys are documented in the file itself.)

### Phase 8 · Smoke test

| Test | How |
|------|-----|
| Schema sanity | `select count(*) from public.bookings;` should return 0 (or whatever your data is). `select tenant_id_for_slug('bus-tz-pawa');` should return the demo tenant UUID. |
| Storage RLS | Open `admin.html` → Buses → Add bus with a photo. Should succeed without "row violates RLS". |
| create-tenant | `curl -X POST https://<ref>.supabase.co/functions/v1/create-tenant -H 'Content-Type: application/json' -d '{"slug":"test-co","display_name":"Test","contact_email":"test@x.com","password":"hunter2hunter"}'` — returns `{ok:true, tenant_id, …}`. |
| Tenant key encryption | Call `update-tenant-keys` with a fake key; then call `get-tenant-config` with the service-role bearer — the same plaintext should round-trip. |
| Payment init | `create-payment` with `method:"cash"` returns a `payments.id` and the row exists with `status='completed'` (cash auto-completes via the demo adapter). |

---

## Files in this folder

| File | Required? | Purpose |
|------|-----------|---------|
| `schema_master.sql` | **yes** | The authoritative schema. Safe to re-run on a live DB. |
| `tenants_helpers_v2.sql` | **yes** | Four RPCs for tenant resolution + AES-GCM secret encryption. Not in `schema_master`. |
| `fix_bus_photos_rls.sql` | **yes** | Storage RLS for the `bus-photos` bucket. Not in `schema_master`. |
| `seed.sql` | optional | 26 regions + 12 demo bus companies. Useful for fresh dev/demo DBs. |
| `add_routes.js` | optional admin script | One-off Node script to PATCH `buses.routes` via the Management API. Needs `SUPABASE_PAT` env var. |
| `functions/` | **yes** | Seven Edge Functions + shared payment-provider adapters. |

---

## Folder map: `functions/`

```
functions/
├── _shared/                  ← bundled into every function that imports it
│   ├── cors.ts               ← corsHeaders + json() helper
│   ├── providers.ts          ← PaymentProvider interface, detectNetwork()
│   ├── registry.ts           ← pickProvider() routing logic
│   ├── selcom.ts             ← Selcom Pay adapter
│   ├── clickpesa.ts          ← ClickPesa adapter
│   ├── azampay.ts            ← AzamPay adapter
│   ├── flutterwave.ts        ← Flutterwave adapter
│   └── demo.ts               ← Fallback (cash + dev) adapter
│
├── create-tenant/index.ts    ← POST signup: auth user + tenant + tenant_users
├── approve-tenant/index.ts   ← Super-admin flips tenants.status
├── update-tenant-keys/index.ts ← Tenant owner saves encrypted API keys
├── get-tenant-config/index.ts  ← Service-role only: returns decrypted config
├── create-payment/index.ts   ← Initiates a payment via the picked provider
├── payment-callback/index.ts ← Receives provider webhook callbacks
├── agent-chat/index.ts       ← Per-tenant Claude tool-use agent
│   └── tools.ts              ← Tool schemas pointing at n8n webhook paths
├── ai-chat/index.ts          ← Generic Claude chat proxy (chat.html)
├── ai-think/index.ts         ← Claude decision / algorithm engine (structured JSON)
└── ai-map/index.ts           ← NL → map intent parser
```

---

## Schema dependencies cheat-sheet

If you're editing the SQL and want to know which Edge Functions depend on which
RPCs, here's the map:

| Edge function | SQL it calls / reads | Tables it writes |
|---------------|----------------------|------------------|
| `create-tenant` | direct SQL (`tenants`, `tenant_users`, `tenant_settings`) | `tenants`, `tenant_users`, `tenant_settings`, `tenant_secret_status`, `auth.users` |
| `approve-tenant` | direct SQL | `tenants` (status/approved_at), `manager_actions` (if exists) |
| `update-tenant-keys` | `update_tenant_secret(uuid, text, text, text)` | `tenant_settings` (encrypted columns) |
| `get-tenant-config` | `tenant_resolve_by_slug(text, text)`, `tenant_get_secrets(uuid, text)` | read-only |
| `create-payment` | direct SQL | `payments` |
| `payment-callback` | direct SQL | `payments` (status/paid_at), `payment_callbacks` (audit row), triggers in master flip `bookings.status` → `confirmed` |
| `agent-chat` | `tenant_resolve_by_slug`, `tenant_get_secrets` | conversation history (in-memory in v1) |

---

## Archive

`supabase/archive/` keeps the historical files that built up to today's schema.
None of them need to run any more — `schema_master.sql` is a clean rewrite that
includes (and supersedes) all of them. They're kept for reference / blame.

| Archived | Why archived |
|----------|--------------|
| `schema.sql` | v1 base; superseded |
| `schema_v2.sql` … `schema_v10.sql` | Incremental schema bumps; all rolled into `schema_master.sql`. |
| `tenants_schema.sql` | Tenant identity tables — now sections 30-32 of `schema_master.sql`. |
| `tenants_migration.sql` | Backfill columns — now section 41 of `schema_master.sql`. |
| `tenant_saas_write_policies.sql` | RLS policies — now section 42 of `schema_master.sql`. |
| `payments_schema.sql` | Payment tables — now sections 15-16 of `schema_master.sql`. |
| `rides_schema.sql` | Ride-hailing tables — now sections 21-24 of `schema_master.sql`. |
| `meet_schema.sql` | Meet rooms + live_locations — now sections 19-20 of `schema_master.sql`. |
| `pending_changes.sql` / `_migration_section55.sql` | Generic admin approval queue — now section 55 of `schema_master.sql`. |
| `tracking_id_function.sql` | `generate_tracking_code()` — now at line 1229 of `schema_master.sql`. |
| `photos.sql` | Storage RLS for agent + ride photos — now in `schema_master.sql`. (Bus photos still need the separate `fix_bus_photos_rls.sql`.) |
| `fix_tenant_id.sql` | One-shot data fix — already applied. |
| `fix_approve_agent_tenant.sql` | RPC fix — now in `schema_master.sql` (section 9 `approve_agent_application`). |
| `fix_shipments_freight_fee.sql` | Column add — now baked into the `shipments` table definition (section 11). |
| `fix_shipments_size_and_suggested_fee.sql` | Column add — now baked into the `shipments` table definition (section 11). |

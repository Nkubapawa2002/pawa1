# Slice 3 — Per-tenant agent runtime runbook

This runbook takes the Slice 3 code from "merged" to "live". It assumes Slice 1 + Slice 2 have already been applied: tenancy tables exist, every data table has a tenant_id / tenant_slug, and the demo tenant `bus-tz-pawa` is seeded.

The headline change in Slice 3 is **per-tenant operation**: each tenant's encrypted Anthropic / VAPI / Africa's Talking / payment-gateway keys are loaded at call time. The original 24 n8n tools and the new web agent both use the calling tenant's keys, queries are filtered by `tenant_slug`, and a tenant dashboard lets the owner manage everything.

---

## What landed in Slice 3

**SQL**
- `bus web/supabase/tenants_helpers_v2.sql` — `tenant_id_for_slug()`, `tenant_get_secrets(uuid, passphrase)`, `tenant_resolve_by_slug(slug, passphrase)`, `update_tenant_secret()`, `update_tenant_branding()`, `tenant_secret_status` view, `log_agent_action()`.
- `n8n/db_schema_v2.sql` — `customer_history_v` view updated to expose `tenant_slug`.

**Edge Functions**
- `bus web/supabase/functions/update-tenant-keys/index.ts` — owner / admin posts plaintext keys; encrypted server-side via `update_tenant_secret`.
- `bus web/supabase/functions/get-tenant-config/index.ts` — service-role only; returns decrypted runtime config.
- `bus web/supabase/functions/agent-chat/index.ts` + `.../tools.ts` — per-tenant Claude tool-use loop over the 24 n8n webhook tools. Logs every tool call to `agent_actions_log`.

**Frontend**
- `bus web/dashboard.html` + `bus web/js/dashboard.js` — branding + key management + today's metrics.
- `bus web/chat.html` + `bus web/js/chat.js` — now talks to `agent-chat` instead of Anthropic directly. Loads tenant context via `tenant.js`.

**Tooling**
- `scripts/patch_workflows_for_tenancy.js` — idempotent transformer that adds `tenant_slug` parsing + DB filters to all 24 tool nodes in `n8n/01_vapi_tools.json` and `n8n/01b_extended_tools.json`. Output verified: 24/24 parse blocks and 24/24 Postgres queries now reference `tenant_slug`.

---

## Apply order

### 1. Run the SQL helpers

```bash
# In Supabase SQL Editor (website project), paste & run:
#   bus web/supabase/tenants_helpers_v2.sql
# Then re-run (because the v2 view changed):
#   n8n/db_schema_v2.sql      ← against the booking DB
#   n8n/db_schema_v3_tenants.sql  ← only if you haven't from Slice 2
```

Verify:

```sql
-- Website Supabase
select public.tenant_id_for_slug('bus-tz-pawa');                         -- expect uuid
select * from public.tenant_secret_status limit 5;                       -- columns of booleans

-- Booking DB
select column_name from information_schema.columns
  where table_name='customer_history_v' and column_name='tenant_slug';   -- expect 1 row
```

### 2. Set the platform passphrase

Pick a long random string (at least 32 chars). Store it where it'll be backed up — losing this passphrase means losing access to all stored secrets.

```bash
supabase secrets set TENANT_SECRET_PASSPHRASE='<long-random-string>'
supabase secrets set N8N_WEBHOOK_BASE='https://your-n8n.com'
```

### 3. Re-import the patched n8n workflows

Both `01_vapi_tools.json` and `01b_extended_tools.json` were rewritten by the patcher. Either:

- In n8n UI: open each workflow, **Replace from file**, pick the file, save, ensure it stays activated.
- Or use n8n's CLI / API to push the JSONs.

Each tool now reads `tenant_slug` from the inbound webhook body (or from VAPI's `assistantOverrides.variableValues.tenant_slug`) and filters every DB query by it.

**Important:** After re-import, replace `REPLACE_PG_CREDENTIAL_ID` and `REPLACE_PG_WEBSITE_CREDENTIAL_ID` again — n8n strips actual credential IDs on export.

### 4. Configure VAPI to forward `tenant_slug`

In each tenant's VAPI assistant, under **Variables / Variable Values**, add `tenant_slug = <their-slug>`. Every tool call from that assistant will then include the slug, and the n8n tools will scope queries automatically.

For the demo tenant: keep `bus-tz-pawa` as the default — this is what the old workflows fall back to in absence of a slug.

### 5. Deploy the Edge Functions

```bash
cd "bus web/supabase"
supabase functions deploy update-tenant-keys
supabase functions deploy get-tenant-config
supabase functions deploy agent-chat
```

The functions inherit `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TENANT_SECRET_PASSPHRASE`, and `N8N_WEBHOOK_BASE` from the secrets you just set.

### 6. Open the tenant dashboard

```
/dashboard.html
```

Sign in as the tenant owner (created via `/signup.html`, approved via `/super-admin.html`).

- Save branding (display name, agent name, color, default language). Saved to `tenant_settings.branding`.
- Paste the tenant's Anthropic API key. Once saved, the field shows `set`. Plaintext is encrypted server-side with the platform passphrase.
- Optionally paste VAPI / Africa's Talking / payment gateway credentials.

### 7. Smoke-test the web agent

On `/chat.html`, send: *"Habari, niambie buki za leo"*. The expected flow:

1. Browser POSTs to `/functions/v1/agent-chat` with `tenant_slug=bus-tz-pawa`.
2. Function decrypts the tenant's Claude key, builds the per-tenant system prompt.
3. Claude calls `today_bookings_summary`. Function POSTs to `n8n/webhook/vapi/today-bookings-summary` with `tenant_slug=bus-tz-pawa`.
4. n8n filters the bookings query by `tenant_slug` and returns the count.
5. Claude reads the result, generates a Swahili reply.
6. The browser displays it; `agent_actions_log` has a fresh row.

If step 2 errors with `anthropic_key_missing`, paste a key on `/dashboard.html` and retry.

---

## Smoke checks

```bash
# (a) Tenant resolution + secret round-trip — should return one row
curl -s -X POST "$SUPABASE_URL/functions/v1/get-tenant-config" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenant_slug":"bus-tz-pawa"}' | jq '.ok, .anthropic_model, .branding.agent_name'

# (b) Agent chat (no auth required from browsers; uses anon key)
curl -s -X POST "$SUPABASE_URL/functions/v1/agent-chat" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenant_slug":"bus-tz-pawa","user_message":"Niambie buki za leo"}' | jq '.reply'

# (c) Audit trail — every tool call logged
psql "$WEBSITE_DB" -c "select tool_name, ok, latency_ms, created_at from agent_actions_log order by created_at desc limit 5;"
```

---

## Rollback

Slice 3 is mostly additive. The biggest reversible risk is the n8n workflow patch.

```bash
# Restore the un-patched workflow files from git
git checkout HEAD -- n8n/01_vapi_tools.json n8n/01b_extended_tools.json
# Re-import them in n8n.

# Drop the helper functions (data is untouched)
psql "$WEBSITE_DB" <<SQL
drop function if exists public.tenant_id_for_slug(text);
drop function if exists public.tenant_get_secrets(uuid, text);
drop function if exists public.tenant_resolve_by_slug(text, text);
drop function if exists public.update_tenant_secret(uuid, text, text, text);
drop function if exists public.update_tenant_branding(uuid, jsonb, text[], text, text);
drop function if exists public.log_agent_action(text, text, text, jsonb, text, integer, boolean, text);
drop view if exists public.tenant_secret_status;
SQL

# Remove deployed Edge Functions
supabase functions delete update-tenant-keys
supabase functions delete get-tenant-config
supabase functions delete agent-chat
```

Encrypted key columns and tenant_settings rows survive — they're meaningless without the passphrase, and re-applying Slice 3 will restore decryptability.

---

## What's next (Slice 4 preview)

1. **Phase-2 RLS** — flip on the commented block in `tenants_migration.sql` so each tenant only sees its own rows. Requires every web page to use `tenantQuery(...)`. Dashboard, signup, super-admin already do; the legacy pages (admin.html, agents.html, buses.html, send.html, etc.) need a one-line audit.
2. **Per-tenant VAPI assistant provisioner** — given a tenant's VAPI key, auto-create an assistant from a template + register all 24 tools via VAPI's API. Today this step is manual.
3. **Tenant invitations** — `/invite.html` flow that consumes `tenant_invites.token` so owners can add admins/agents without sharing passwords.
4. **Streaming** in `agent-chat` — switch the Anthropic call to `stream: true` so the chat feels live.
5. **Billing & quotas** — wire `tenant_settings.monthly_call_quota` into a counter that blocks agent-chat past the cap (or charges via Stripe).

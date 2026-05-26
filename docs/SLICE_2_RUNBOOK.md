# Slice 2 — Multi-tenancy runbook

This runbook is the operator's checklist for taking the multi-tenant code that landed in Slice 2 from sitting in the repo to actually running. **Phase 1 is non-breaking** — existing pages keep working unchanged because every backfilled row gets the demo tenant id. **Phase 2 (RLS tightening) is opt-in.**

---

## What landed in Slice 2

**SQL**
- `bus web/supabase/tenants_schema.sql` — `tenants`, `tenant_users`, `tenant_settings`, `tenant_invites`, status/role enums, encryption helpers, RLS for the tenancy tables, demo-tenant seed.
- `bus web/supabase/tenants_migration.sql` — `tenant_id` column added to every data table, backfilled to the demo tenant, indexed. Phase 2 RLS block at the bottom is commented out.
- `n8n/db_schema_v3_tenants.sql` — `tenant_slug` (TEXT) added to every booking-DB table.

**Frontend**
- `bus web/saas.html` — SaaS marketing landing.
- `bus web/signup.html` + `bus web/js/signup.js` — applicant flow.
- `bus web/super-admin.html` + `bus web/js/super-admin.js` — approval dashboard.
- `bus web/js/tenant.js` — runtime tenant resolver (URL slug, membership, demo fallback) and `tenantQuery(...)` helper.

**Edge Functions**
- `bus web/supabase/functions/create-tenant/index.ts` — atomic signup.
- `bus web/supabase/functions/approve-tenant/index.ts` — super-admin status flip.

---

## Apply order

Do these in sequence. Each step is reversible; later steps depend on earlier ones.

### 1. Run the website-DB migrations

```bash
# In Supabase SQL Editor, paste & run in this order:
#   1) tenants_schema.sql
#   2) tenants_migration.sql
```

Verify:

```sql
select count(*) as t_count from public.tenants;                   -- expect ≥ 1 (the demo)
select column_name from information_schema.columns
  where table_name='shipments' and column_name='tenant_id';        -- expect 1 row
select tenant_id, count(*) from public.shipments group by 1;       -- all rows on demo tenant
```

If any step fails, see **Rollback** at the bottom.

### 2. Run the booking-DB migration

```bash
# Against the n8n Postgres (e.g. via psql or the Supabase project that hosts it):
\i n8n/db_schema_v3_tenants.sql
```

Verify:

```sql
select column_name from information_schema.columns
  where table_name='bookings' and column_name='tenant_slug';      -- expect 1 row
select tenant_slug, count(*) from public.bookings group by 1;     -- 'bus-tz-pawa' for legacy rows
```

### 3. Deploy the Edge Functions

```bash
cd "bus web/supabase"
supabase functions deploy create-tenant
supabase functions deploy approve-tenant

# Set the secrets (the function pulls these at runtime):
supabase secrets set ADMIN_EMAILS=pawa4761@gmail.com
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-populated by the platform.
```

Verify create-tenant is reachable:

```bash
curl -i -X POST "$SUPABASE_URL/functions/v1/create-tenant" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"acme-buses","display_name":"ACME Buses","contact_email":"founder@acme.test","password":"super-strong-pw-99"}'
```

Expect HTTP 201 and `{ ok: true, tenant_id: "..." }`. If you re-run with the same slug you should get HTTP 409 `slug_taken`.

### 4. Open the new pages in a browser

```
/saas.html         → marketing landing
/signup.html       → applicant form (use a throwaway email)
/super-admin.html  → log in as pawa4761@gmail.com → approve the new tenant
```

After approval, the applicant's user can log into any existing page, and `tenant.js` will pin them to their tenant.

### 5. (Optional) Tighten RLS — Phase 2

This is the breaking step. Don't run it until every existing page either passes through `tenantQuery(...)` or otherwise sets `tenant_id` on every insert. Phase 2 is the commented block at the bottom of `tenants_migration.sql`. To activate:

```bash
# Uncomment the do $rls$ … end $rls$ block, then run it in Supabase SQL Editor.
```

After Phase 2:
- Anonymous users can no longer read tenant data unless they're in `tenant_users` for that tenant.
- The legacy demo-tenant fallback in `tenant.js` will keep public pages working for the demo only.

---

## Updating tool workflows for tenant scoping (deferred)

The 24 n8n agent tools currently query without a tenant filter. Slice 3 covers this. The minimum change per tool will be:

- Parse Args block reads `tenant_slug` from VAPI's `assistantOverrides.variableValues` (or the inbound webhook body).
- DB query gains `AND tenant_slug = $N`.
- Format block stays the same.

A bulk pass over `01_vapi_tools.json` and `01b_extended_tools.json` will accomplish this in Slice 3.

---

## Smoke test (after every step)

```bash
# Website is still up
curl -sI http://localhost:3000/index.html | head -1   # (or your prod URL)

# Demo tenant exists and has the seeded settings
psql "$WEBSITE_DB" -c "select slug,status from tenants where slug='bus-tz-pawa';"
psql "$WEBSITE_DB" -c "select tenant_id, branding->>'agent_name' from tenant_settings limit 5;"

# Existing data is still queryable and on the demo tenant
psql "$WEBSITE_DB" -c "select tenant_id, count(*) from shipments group by 1;"
```

If those four commands all return as expected, Slice 2 is live and additive.

---

## Rollback

Each step has an undo. The migrations only ADD columns and tables — none of them DROP anything from the existing schema.

```sql
-- Undo tenants_migration.sql (drops tenant_id from every data table)
do $$
declare t text; tenant_tables text[] := array[
  'shipments','shipment_messages','buses','agents','agent_applications',
  'agent_reviews','call_requests','cash_retargets','bookings','payments',
  'payment_callbacks','org_expenses','tax_rates','meet_rooms','live_locations',
  'ride_requests','ride_drivers','ride_messages','drivers_online'];
begin
  foreach t in array tenant_tables loop
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name=t and column_name='tenant_id') then
      execute format('alter table public.%I drop column if exists tenant_id', t);
    end if;
  end loop;
end $$;

-- Undo tenants_schema.sql (full teardown — DESTRUCTIVE for tenant data)
drop table if exists public.tenant_invites  cascade;
drop table if exists public.tenant_settings cascade;
drop table if exists public.tenant_users    cascade;
drop table if exists public.tenants         cascade;
drop type  if exists tenant_role;
drop type  if exists tenant_status;
drop function if exists public.current_user_tenant_ids;
drop function if exists public.is_super_admin;
drop function if exists public.tenant_encrypt;
drop function if exists public.tenant_decrypt;

-- Undo Edge Functions
supabase functions delete create-tenant
supabase functions delete approve-tenant
```

**Don't** run the tenants_schema teardown if real signups have come in — you'll lose them. Suspend the SaaS landing first by removing the link from the nav.

---

## What's still ahead (Slice 3 preview)

1. Per-tenant Claude / VAPI / Africa's Talking key wiring from `tenant_settings` into the actual call path. Today the system uses one global key set in n8n env. Slice 3 plumbs the tenant's encrypted keys through the agent-chat Edge Function and a per-tenant VAPI assistant provisioner.
2. Bulk update of all 24 n8n tools to filter by `tenant_slug`.
3. A `dashboard.html` per tenant where the owner pastes their keys, edits branding, manages routes & buses.
4. Activate Phase 2 RLS once steps 1–3 are in place.

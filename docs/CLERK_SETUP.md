# Clerk + Supabase + PostHog setup

This app is **buildless static** (GitHub Pages) on **Supabase** (Postgres + RLS).
Clerk and PostHog are wired **feature-flagged**: with no keys set, nothing loads
and the app keeps using the built-in Supabase email/password auth.

---

## 1. PostHog (analytics) — ready now

1. Create a PostHog project → copy the **Project API key** (starts `phc_`).
2. Put it in `js/core/config.js` (or, to keep it out of git, in `js/config.local.js`):
   ```js
   POSTHOG_KEY: "phc_xxx",
   POSTHOG_HOST: "https://us.i.posthog.com", // or https://eu.i.posthog.com
   ```
3. Reload. `js/core/analytics.js` loads only when the key is set. It autocaptures
   clicks/pageviews and identifies the signed-in user. Add custom events
   anywhere with `window.Analytics.capture("event_name", { ...props })`.

Privacy: when `POSTHOG_KEY` is empty, **no analytics script loads and nothing is
sent**.

---

## 2. Clerk as Supabase's third-party auth issuer

This keeps **Row-Level Security working** — Supabase trusts Clerk-issued JWTs and
RLS reads the Clerk user id from the token. Your data-authorization model does
not change; only the identity provider does.

### A. Clerk dashboard
1. Create a Clerk application. Copy the **Publishable key** (`pk_test_`/`pk_live_`)
   and your **Frontend API** host (e.g. `clerk.your-app.com`).
2. Enable the **Supabase integration** (Clerk → Configure → Integrations →
   Supabase). This makes Clerk mint tokens with the claims Supabase needs
   (`role: authenticated`, `sub` = Clerk user id). No JWT template needed.

### B. Supabase dashboard
1. **Authentication → Sign In / Up → Third-Party Auth → Add provider → Clerk.**
2. Paste your Clerk **domain** (Frontend API host). Save.
   Supabase will now accept Clerk JWTs; `auth.jwt()->>'sub'` is the Clerk user id.

### C. This repo
Set both values in `js/core/config.js` (or `js/config.local.js`):
```js
CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
CLERK_DOMAIN: "clerk.your-app.com",   // no https://
```
When both are set, `js/core/config.js` flips `window.CLERK_ENABLED = true`, which:
- makes the Supabase client send Clerk's token on every request
  (`accessToken` in `js/core/data.js`), and
- loads `js/core/auth-clerk.js`, which replaces `window.Auth` with a Clerk-backed
  version mirroring `js/core/auth.js` (so `login.js` and the dashboard gates keep
  working against the same API).

### D. RLS — DONE (migration applied 2026-06-15)
`auth.uid()` casts the JWT `sub` to **uuid**, so a Clerk id (`user_2ab…`, text)
throws `22P02 invalid input syntax for type uuid`. This was fixed by
**`supabase/auth/clerk_text_user_ids.sql`** (already applied to the live project):
- adds `public.app_uid()` → returns the `sub` claim as **text** (NULL when anon);
- converts the six owner columns Clerk users write from `uuid` → `text`
  (`houses`/`trucks`/`services`/`house_tenancies.owner_user_id`,
  `house_demand_pins.user_id`, `agents.user_id`);
- drops those columns' FKs to `auth.users` (Clerk users don't live there);
- rewrites every `auth.uid()` policy/function to `column::text = app_uid()`
  (`claim_agent_profile`, `my_agent_subscription`, `current_user_tenant_ids`,
  `agent_owns_shipment`, `uid_suspended`→text overload, ~35 policies).

It's **backward compatible**: a Supabase-Auth `sub` IS the user uuid, so existing
rows still match (`uuid::text = sub`). Admins are gated by email
(`auth.jwt()->>'email'` in `is_admin()`), which is unchanged. Re-runnable +
transactional. Verify with `tests/clerk_supabase_check.mjs` (pass `SBP_TOKEN`)
and the live end-to-end `tests/_clerk_backend_e2e.mjs` (needs `CK_SECRET`).

### E. Data migration (existing rows)
Rows created under Supabase Auth store Supabase user **UUIDs** in
`owner_user_id`. Clerk ids differ, so previous owners won't match until migrated.
Options:
- **Pre-launch / little data:** wipe and re-create listings under Clerk.
- **Has real data:** map each Supabase `auth.users.id` → the matching Clerk user
  id (by email) and `UPDATE` the owner columns. Do this once, server-side.

### F. Auth flows — DONE (complete & verified end-to-end)
All of `window.Auth` (the Clerk facade in `js/core/auth-clerk.js`) handles the Clerk
code flows through ONE shared modal (`authCodePrompt`), so every page works with
no per-page UI — admin, accounting, dashboard, super-admin (via `window.Auth.*`)
and the agent portals (via `sb.auth.*`).
- **`sb.auth` shim lives in `js/core/data.js`** (single source of truth). It's durable
  (forwards every Clerk auth change, not once) and delegates the interactive
  methods to `window.Auth`. `auth-clerk.js` no longer swaps `sb.auth`.
- **Sign-in:** `Auth.signIn` → on `needs_client_trust` (new-device) / 2FA /
  first-factor, the modal collects the emailed `email_code` and completes →
  returns a session. Callers just get a session.
- **Sign-up:** `Auth.signUp` → completes Clerk email-code verification via the
  modal → returns a session.
- **Forgot password:** `Auth.resetPassword(email)` → `reset_password_email_code`;
  modal collects code + new password → signs in. Wired into `login.js`'s
  "Forgot password?" and `sb.auth.resetPasswordForEmail`.
- **Client Trust** (new-device codes) is ON by default for instances created
  before 2025-11-14; turn it OFF in Clerk Dashboard → Updates if you don't want
  the step (no Backend API for it).
- Verified by `tests/_clerk_signin_e2e.mjs`, `tests/_clerk_flows_e2e.mjs`,
  `tests/_clerk_backend_e2e.mjs`, `tests/_login_init_smoke.mjs`.

Remaining cleanup (optional): remove `js/core/auth.js` (Supabase-only facade) — it's
still the pre-Clerk-load fallback; harmless to keep.

---

## Rollback
Clear `CLERK_PUBLISHABLE_KEY` / `CLERK_DOMAIN` (and `POSTHOG_KEY`) in config and
reload — the app reverts to Supabase Auth with nothing external loaded.

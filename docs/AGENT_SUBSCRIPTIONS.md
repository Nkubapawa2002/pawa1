# Agent subscriptions — Clerk identity + self-serve mobile-money billing

How Pawa manages each agent's monthly subscription (houses agents, service
providers, truck owners). **Clerk owns the identity**; **mobile money collects
the fee**; **Supabase gates access**. Agents renew themselves — no manual admin
step required (the admin "All Agents" tab still works as an override).

## The model

- Flat fee: `APP_CONFIG.AGENT_MONTHLY_FEE_TZS` (default **TZS 10,000 / month**).
- New agents get a **48-hour grace** period from first registration
  (`AGENT_GRACE_HOURS`); after that, unpaid accounts auto-pause (listings hidden)
  until paid.
- An agent's subscription is keyed to a stable **`agent_key`**:
  - `uid:<user-id>` — the logged-in identity. **With Clerk on, this is the Clerk
    user id** (the Supabase third-party JWT `sub` claim = `auth.uid()`).
  - `ph:<last 9 digits>` / `nm:<name>` — legacy fallbacks for accountless agents.

## The flow (self-serve)

```
Agent dashboard
  └─ my_agent_subscription()  → { reason, paid_until, agent_key, … }
  └─ paywall banner shows "Pay now — TZS 10,000/month"   (grace / expired states)
       └─ openAgentSubscribeModal()  (js/config.js)
            └─ POST /functions/v1/create-payment
                 reference      = "<agent_key>|<unique>"
                 reference_type = "agent_subscription"
                 amount_tzs     = fee,  method = mpesa|tigopesa|airtel|…
            └─ mobile-money USSD push → agent approves on phone
  payment completes (real provider webhook → payment-callback, OR demo auto-confirm)
       └─ trigger apply_agent_subscription_payment()  (agent_subscription_selfpay.sql)
            └─ agent_billing.paid_until = max(today, current) + 1 month, status='paid', active=true
  └─ dashboard polls my_agent_subscription() → active → reloads → listings unhide (RLS)
```

Access gating is unchanged: the `houses` / `trucks` / `agents` SELECT policies hide
a suspended agent's rows via `uid_suspended()` / `phone_suspended()`
(`agent_subscription.sql` + `agent_grace_active.sql`).

## Deploy (once)

1. **SQL** — run in the Supabase SQL editor, in order (all idempotent):
   - `supabase/agent_billing.sql`
   - `supabase/agent_subscription.sql`
   - `supabase/agent_grace_active.sql`
   - `supabase/agent_subscription_selfpay.sql`  ← **new** (self-serve trigger + reference_type)
2. **Payments** — a mobile-money provider must be configured as Edge Function
   secrets (Selcom / ClickPesa / AzamPay / Flutterwave) and `create-payment` +
   `payment-callback` deployed. Point each provider's webhook at
   `/functions/v1/payment-callback?provider=<name>`.
   - **No provider yet?** With no credentials the rail falls back to the **demo**
     provider and auto-confirms (`DEMO_AUTO_CONFIRM` defaults true) — so you can
     test the entire flow end-to-end before going live.
3. **Clerk** — finish the SupabaseClerk setup in `docs/CLERK_SETUP.md` so
   `auth.uid()` resolves to the Clerk user id (keeps `agent_key = uid:<clerk-id>`).

## Test checklist

- [ ] New agent (no billing row) → dashboard shows the amber grace banner with a
      live countdown and a **Pay now** button.
- [ ] Tap **Pay now** → modal lists the enabled mobile-money methods + phone box.
- [ ] Pay (demo or real) → modal shows "Waiting for confirmation…", then
      "Subscription active!" and reloads.
- [ ] `agent_billing` row for `uid:<id>` now has `status='paid'`,
      `paid_until ≈ today + 1 month`, `updated_by='self-serve'`.
- [ ] Public directory: the agent's listings are visible again.
- [ ] Re-pay before expiry → `paid_until` stacks (current expiry + 1 month), not reset to today+1.
- [ ] Admin "All Agents" tab still shows/overrides the same row.

## Notes / future

- Card subscriptions (Clerk Billing / Stripe) were intentionally **not** used —
  Tanzanian agents pay by mobile money. The hook point is `reference_type`, so a
  card rail can be added later without changing the gating.
- To let agents renew **proactively** (before expiry), wire any button to
  `window.openAgentSubscribeModal()`.

# Selcom payment integration — go-live runbook

This is the doc for the **merchant** (you) to fill in once Selcom approves
your KYC. The integration code is already in production. The flow:

```
Browser → create-payment edge fn → Selcom API → USSD push lands on payer's SIM
            ↓ inserts payments row                      ↓ payer enters PIN
       (status='awaiting_payment')                ↓
                                                  Selcom POSTs callback
                                                  ↓
                                          payment-callback edge fn
                                                  ↓ flips payments.status='completed'
                                       DB trigger handle_payment_completion
                                                  ↓
                                          bookings.status='confirmed'
                                                  ↓
                                          book-fast.html poller sees it,
                                          shows the ticket
```

Both edge functions are deployed. The only thing missing for **real money**
to move is the four Selcom secrets below.

---

## Step 1 — Apply for a Selcom merchant account

Go to <https://developers.selcommobile.com> and start the application. You
need:

| Document | Why |
|---|---|
| Business registration (BRELA cert.) | Selcom verifies you're a real TZ company |
| TRA TIN certificate | Tax compliance |
| Director's NIDA | Identity check |
| Settlement bank account details | Where Selcom sweeps the money daily (NMB/CRDB/NBC etc.) |
| Sample customer flow / use case | "Bus ticket sales via web + voice agent" |

Typical timeline: 3–10 working days. They'll sandbox you first (keys that
look real but no money moves), then approve a switch to production after a
test transaction.

---

## Step 2 — Set Supabase secrets

When Selcom hands you the keys, set them in
**Supabase Dashboard → Edge Functions → Manage secrets**:

| Secret | Where in Selcom dashboard |
|---|---|
| `SELCOM_API_KEY` | Settings → API Credentials → API Key |
| `SELCOM_API_SECRET` | Settings → API Credentials → API Secret |
| `SELCOM_VENDOR` | Settings → Profile → Vendor ID (e.g. `TILL12345`) |
| `SELCOM_WEBHOOK_SECRET` | Settings → Webhooks → Shared secret (set this for HMAC verification — without it the callback verifier fails-open, which is fine for sandbox but **not for production**) |
| `PRIMARY_PROVIDER` | Set to `selcom` so the registry picks Selcom for every method it supports |
| `DEMO_AUTO_CONFIRM` | Set to `false` once Selcom is live, so the demo auto-confirm path can't accidentally fire |

For the sandbox phase, set `SELCOM_BASE_URL=https://apigwtest.selcommobile.com`
(default points at production).

After setting secrets, **re-deploy** both functions so they pick up new env:

```bash
SUPABASE_PAT=sbp_... node scripts/deploy-create-payment.js --all
```

(Setting secrets alone is enough — Supabase reads them on each cold start —
but a redeploy guarantees a fresh process.)

---

## Step 3 — Whitelist the callback URL in Selcom

The webhook URL Selcom should POST to:

```
https://kkdpacoiwntrcukgwksh.functions.supabase.co/payment-callback?provider=selcom
```

Add this in Selcom dashboard → Webhooks → "Payment status URL". Selcom
retries with exponential backoff for ~24h on non-2xx responses; our
function always returns 200 once the callback is stored, so retries
should stop after the first successful delivery.

---

## Step 4 — Smoke test in sandbox

1. From the browser book-fast page, pick a bus + a green seat, hold it.
2. In the Pay section, pick M-Pesa.
3. Enter a **Selcom-sandbox test MSISDN** (Selcom gives you a few when
   sandbox is enabled — usually `255744123456` or similar).
4. Tap **Send USSD push & pay**. The sandbox does NOT push to a real
   phone — Selcom calls your callback URL synchronously with a fake
   success after a few seconds.
5. Within ~3 s the booking flips to `confirmed` and the ticket card
   appears. The `payment_callbacks` table will have an audit row with the
   signature check result.

If anything sticks, query:

```sql
select id, reference, status, error_message, raw_response, created_at, paid_at
from payments order by created_at desc limit 5;

select payment_id, provider, event_type, signature_ok, raw_body, received_at
from payment_callbacks order by received_at desc limit 5;
```

---

## Step 5 — Switch to production

Once you've verified at least one sandbox payment confirms a booking:

1. In Selcom dashboard, request the switch from sandbox to production.
   They'll usually require you to submit a brief test report.
2. Replace `SELCOM_API_KEY` / `SELCOM_API_SECRET` / `SELCOM_VENDOR` /
   `SELCOM_WEBHOOK_SECRET` with the **production** values from the
   dashboard (the sandbox keys stop working).
3. Unset `SELCOM_BASE_URL` (so it defaults to the production URL).
4. Make a real test transaction with a small amount (e.g. 1 000 TZS) on
   one of your own SIMs.

That's it. Real USSD pushes will go to real payers' phones; their PIN
authorises the debit; Selcom settles to your registered bank account
typically T+1.

---

## What about banks / cards?

Selcom covers them via the same `create-payment` call:

- **Banks** (NMB / CRDB / NBC / Equity / Stanbic / Other Bank): the
  function calls `/v1/checkout/create-order` and returns a `payment_url`
  — the browser opens that in a new tab and Selcom presents a redirect
  page for the bank's online banking login or USSD push (depending on
  the bank's flow).
- **Card**: same — returns a hosted-checkout `payment_url`.

The book-fast.js UI already opens `payment_url` in a new tab when the
edge function returns one, so banks/cards work out of the box.

---

## Switching providers later

The architecture is provider-agnostic: just add the relevant secrets and
set `PRIMARY_PROVIDER`. Currently supported:

- `selcom` (recommended for TZ)
- `clickpesa` — set `CLICKPESA_CLIENT_ID`, `CLICKPESA_API_KEY`, `CLICKPESA_WEBHOOK_SECRET`
- `azampay` — set `AZAMPAY_CLIENT_ID` + `AZAMPAY_CLIENT_SECRET` + `AZAMPAY_APP_NAME` (or the static `AZAMPAY_TOKEN`)
- `flutterwave` — set `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH`

You can also override per-method, e.g. `PROVIDER_MPESA=clickpesa`,
`PROVIDER_CARD=flutterwave`, while keeping Selcom as the catch-all.

---

## Files in this integration

| File | Purpose |
|---|---|
| `bus web/supabase/functions/create-payment/index.ts` | Validates request → inserts `payments` row → routes to Selcom adapter → returns `payment_id` + instructions |
| `bus web/supabase/functions/_shared/selcom.ts` | Selcom-specific `initiate()` + `verifyCallback()` |
| `bus web/supabase/functions/payment-callback/index.ts` | Receives Selcom's POST → verifies signature → updates `payments` → DB trigger flips `bookings.status='confirmed'` |
| `bus web/supabase/functions/_shared/registry.ts` | Picks the provider for a given method based on `PRIMARY_PROVIDER` + `PROVIDER_<METHOD>` env vars |
| `scripts/deploy-create-payment.js` | Re-deploys either or both functions via the Supabase Management API |

// =====================================================================
// AzamPay (Tanzania) — adapter
//   Docs: https://azampay.co.tz / developer portal
//   Two endpoints: /azampay/mno/checkout (mobile money)
//                  /azampay/bank/checkout (banks)
// =====================================================================

import {
  PaymentProvider, InitiateInput, InitiateResult,
  CallbackVerifyInput, CallbackVerifyResult, PaymentMethod
} from "./providers.ts";

const BASE      = Deno.env.get("AZAMPAY_BASE_URL")   || "https://checkout.azampay.co.tz";
const AUTH_BASE = Deno.env.get("AZAMPAY_AUTH_URL")   || "https://authenticator.azampay.co.tz";
const APP_NAME  = Deno.env.get("AZAMPAY_APP_NAME")   || "";
const CLIENT_ID = Deno.env.get("AZAMPAY_CLIENT_ID")  || "";
const CLIENT_SECRET = Deno.env.get("AZAMPAY_CLIENT_SECRET") || "";
const TOKEN     = Deno.env.get("AZAMPAY_TOKEN")      || "";
const HOOK_KEY  = Deno.env.get("AZAMPAY_WEBHOOK_SECRET") || "";

const MNO: Record<string,string> = {
  mpesa:   "Mpesa",
  tigopesa:"Tigo",
  airtel:  "Airtel",
  halopesa:"Halopesa",
  azampesa:"Azampesa",
};

const BANK: Record<string,string> = {
  crdb:   "CRDB",
  nmb:    "NMB",
  nbc:    "NBC",
  equity: "Equity",
  stanbic:"Stanbic",
};

let bearer: { value: string; exp: number } | null = null;

async function tokenFor(): Promise<string> {
  if (TOKEN) return TOKEN;
  if (bearer && bearer.exp > Date.now()) return bearer.value;
  const res = await fetch(`${AUTH_BASE}/AppRegistration/GenerateToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName:     APP_NAME,
      clientId:    CLIENT_ID,
      clientSecret:CLIENT_SECRET,
    }),
  });
  const j = await res.json();
  const tok = j?.data?.accessToken;
  if (!tok) throw new Error("AzamPay auth failed");
  bearer = { value: tok, exp: Date.now() + 25 * 60 * 1000 };
  return tok;
}

export const azampay: PaymentProvider = {
  name: "azampay",

  supports(method: PaymentMethod) {
    return method in MNO || method in BANK;
  },

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (!APP_NAME && !TOKEN) throw new Error("AzamPay not configured");
    const tok  = await tokenFor();
    const isBank = input.method in BANK;
    const path = isBank ? "/azampay/bank/checkout" : "/azampay/mno/checkout";

    const body: any = isBank ? {
      additionalProperties: { property1: null, property2: null },
      amount:         String(Math.round(input.amount_tzs)),
      currencyCode:   "TZS",
      merchantAccountNumber: Deno.env.get("AZAMPAY_MERCHANT_ACCOUNT") || "",
      merchantMobileNumber:  Deno.env.get("AZAMPAY_MERCHANT_MSISDN") || "",
      merchantName:   Deno.env.get("AZAMPAY_MERCHANT_NAME") || "Pawa",
      otp:            "",
      provider:       BANK[input.method],
      referenceId:    input.reference,
    } : {
      accountNumber:  input.phone,
      additionalProperties: { property1: null, property2: null },
      amount:         String(Math.round(input.amount_tzs)),
      currency:       "TZS",
      externalId:     input.reference,
      provider:       MNO[input.method],
    };

    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${tok}`,
      },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j.success === false) throw new Error(j.message || `AzamPay ${res.status}`);

    return {
      provider:     "azampay",
      provider_ref: String(j.transactionId || j.message || input.reference),
      instructions: isBank
        ? "Complete the payment in your banking app."
        : "Approve the USSD push prompt on your phone.",
      raw:          j,
    };
  },

  verifyCallback({ headers, body }: CallbackVerifyInput): CallbackVerifyResult {
    const sig = headers["x-signature"] || headers["authorization"] || "";
    const ok  = !HOOK_KEY || sig.includes(HOOK_KEY);
    const b: any = body || {};
    const s   = String(b.transactionstatus || b.status || "").toUpperCase();

    let status: CallbackVerifyResult["status"] = "unknown";
    if (s === "SUCCESS" || s === "COMPLETED")    status = "completed";
    else if (s === "FAILED" || s === "FAILURE")  status = "failed";
    else if (s === "CANCELLED")                  status = "cancelled";
    else if (s === "PENDING")                    status = "processing";

    return {
      valid:        ok,
      provider_ref: b.transactionId || b.reference || null,
      status,
      external_ref: b.reference || b.transactionReference,
      paid_at:      b.paidAt,
      raw:          body,
    };
  },
};

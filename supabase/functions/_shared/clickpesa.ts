// =====================================================================
// ClickPesa (Tanzania) — adapter
//   Docs: https://docs.clickpesa.com
//   Strong support for M-Pesa & Tigo Pesa USSD push.
// =====================================================================

import {
  PaymentProvider, InitiateInput, InitiateResult,
  CallbackVerifyInput, CallbackVerifyResult, PaymentMethod
} from "./providers.ts";

const BASE       = Deno.env.get("CLICKPESA_BASE_URL") || "https://api.clickpesa.com";
const CLIENT_ID  = Deno.env.get("CLICKPESA_CLIENT_ID") || "";
const API_KEY    = Deno.env.get("CLICKPESA_API_KEY")   || "";
const SHARED_KEY = Deno.env.get("CLICKPESA_WEBHOOK_SECRET") || "";

let cachedToken: { value: string; exp: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now()) return cachedToken.value;
  const res = await fetch(`${BASE}/third-parties/generate-token`, {
    method: "POST",
    headers: { "client-id": CLIENT_ID, "api-key": API_KEY },
  });
  const j = await res.json();
  if (!j.token) throw new Error("ClickPesa auth failed");
  cachedToken = { value: j.token, exp: Date.now() + 25 * 60 * 1000 };
  return cachedToken.value;
}

const METHOD_TO_RAIL: Record<string,string> = {
  mpesa:   "MPESA-TZ",
  tigopesa:"TIGO-TZ",
  airtel:  "AIRTEL-TZ",
  halopesa:"HALOPESA-TZ",
  azampesa:"AZAMPESA-TZ",
};

export const clickpesa: PaymentProvider = {
  name: "clickpesa",

  supports(method: PaymentMethod) {
    return method in METHOD_TO_RAIL;
  },

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (!API_KEY) throw new Error("ClickPesa not configured");
    const tok = await token();

    const body = {
      amount:         String(Math.round(input.amount_tzs)),
      currency:       "TZS",
      orderReference: input.reference,
      phoneNumber:    input.phone,
    };
    const res = await fetch(`${BASE}/third-parties/payments/initiate-ussd-push-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tok}`,
      },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || `ClickPesa ${res.status}`);

    return {
      provider:     "clickpesa",
      provider_ref: String(j.id || j.reference || input.reference),
      ussd_session: j.id,
      instructions: "Approve the USSD push that just arrived on your phone.",
      raw:          j,
    };
  },

  verifyCallback({ headers, body }: CallbackVerifyInput): CallbackVerifyResult {
    const sig = headers["x-signature"] || headers["clickpesa-signature"] || "";
    const ok  = !SHARED_KEY || sig === SHARED_KEY;
    const b: any = body || {};
    const s   = String(b.status || "").toUpperCase();

    let status: CallbackVerifyResult["status"] = "unknown";
    if (s === "SUCCESS" || s === "COMPLETED" || s === "PAID") status = "completed";
    else if (s === "FAILED" || s === "DECLINED")              status = "failed";
    else if (s === "CANCELLED")                               status = "cancelled";
    else if (s === "PROCESSING" || s === "PENDING")           status = "processing";

    return {
      valid:        ok,
      provider_ref: b.id || b.orderReference || null,
      status,
      external_ref: b.transactionId,
      paid_at:      b.paidAt || b.updatedAt,
      raw:          body,
    };
  },

  async queryStatus(provider_ref: string) {
    const tok = await token();
    const res = await fetch(
      `${BASE}/third-parties/payments/${encodeURIComponent(provider_ref)}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    const j = await res.json();
    const s = String(j.status || "").toUpperCase();
    let status: "completed" | "failed" | "cancelled" | "processing" | "unknown" = "unknown";
    if (s === "SUCCESS" || s === "COMPLETED") status = "completed";
    else if (s === "FAILED")     status = "failed";
    else if (s === "CANCELLED")  status = "cancelled";
    else if (s === "PROCESSING" || s === "PENDING") status = "processing";
    return { status, external_ref: j.transactionId, paid_at: j.paidAt };
  },
};

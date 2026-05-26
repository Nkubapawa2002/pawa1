// =====================================================================
// Flutterwave (Pan-African) — adapter
//   Used here primarily for card payments and bank transfers.
//   Docs: https://developer.flutterwave.com
// =====================================================================

import {
  PaymentProvider, InitiateInput, InitiateResult,
  CallbackVerifyInput, CallbackVerifyResult, PaymentMethod
} from "./providers.ts";

const BASE     = Deno.env.get("FLW_BASE_URL")     || "https://api.flutterwave.com/v3";
const SECRET   = Deno.env.get("FLW_SECRET_KEY")   || "";
const HOOK_KEY = Deno.env.get("FLW_WEBHOOK_HASH") || "";

const SUPPORTED: PaymentMethod[] = ["card","bank_transfer","other_bank","mpesa","tigopesa","airtel"];

export const flutterwave: PaymentProvider = {
  name: "flutterwave",

  supports(method: PaymentMethod) {
    return SUPPORTED.includes(method);
  },

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (!SECRET) throw new Error("Flutterwave not configured");

    if (input.method === "card" || input.method === "bank_transfer" || input.method === "other_bank") {
      // Hosted checkout for cards / banks
      const body = {
        tx_ref:      input.reference,
        amount:      Math.round(input.amount_tzs),
        currency:    "TZS",
        redirect_url:Deno.env.get("FLW_REDIRECT_URL") || "https://example.com/payment-return",
        customer: {
          email:      input.customer_email || "guest@pawa.co.tz",
          phonenumber:input.phone,
          name:       input.customer_name || "Customer",
        },
        customizations: { title: "Pawa Bus Cargo", description: input.description || "" },
        payment_options: input.method === "card" ? "card" : "banktransfer",
      };
      const res = await fetch(`${BASE}/payments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || j.status !== "success") throw new Error(j.message || `Flutterwave ${res.status}`);
      return {
        provider:    "flutterwave",
        provider_ref:input.reference,
        payment_url: j.data.link,
        instructions:"Open the secure checkout link to pay.",
        raw:         j,
      };
    }

    // Mobile money via Flutterwave
    const network = ({ mpesa: "TZ", tigopesa: "TZ", airtel: "TZ" } as any)[input.method] || "TZ";
    const body = {
      tx_ref:      input.reference,
      amount:      Math.round(input.amount_tzs),
      currency:    "TZS",
      country:     network,
      email:       input.customer_email || "guest@pawa.co.tz",
      phone_number:input.phone,
      fullname:    input.customer_name || "Customer",
    };
    const res = await fetch(`${BASE}/charges?type=mobile_money_tanzania`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j.status !== "success") throw new Error(j.message || `Flutterwave ${res.status}`);

    return {
      provider:     "flutterwave",
      provider_ref: String(j.data?.id ?? input.reference),
      ussd_session: j.data?.flw_ref,
      instructions: "Approve the USSD push on your phone.",
      raw:          j,
    };
  },

  verifyCallback({ headers, body }: CallbackVerifyInput): CallbackVerifyResult {
    const sig = headers["verif-hash"] || headers["x-verif-hash"] || "";
    const ok  = !HOOK_KEY || sig === HOOK_KEY;
    const b: any = body || {};
    const data = b.data || b;
    const s = String(data.status || "").toUpperCase();
    let status: CallbackVerifyResult["status"] = "unknown";
    if (s === "SUCCESSFUL" || s === "SUCCESS" || s === "COMPLETED") status = "completed";
    else if (s === "FAILED")    status = "failed";
    else if (s === "CANCELLED") status = "cancelled";
    else if (s === "PENDING")   status = "processing";

    return {
      valid:        ok,
      provider_ref: String(data.id || data.tx_ref || b.txRef || ""),
      status,
      external_ref: data.flw_ref,
      paid_at:      data.created_at,
      raw:          body,
    };
  },
};

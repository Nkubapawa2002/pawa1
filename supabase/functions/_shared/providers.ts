// =====================================================================
// Provider abstraction layer.
//
// Every aggregator (Selcom / ClickPesa / AzamPay / Flutterwave / …)
// implements the PaymentProvider interface so the rest of the platform
// can stay provider-agnostic.
//
// Routing rule (see `pickProvider`):
//   1. If a method is mapped to a specific provider via env var, use it.
//   2. Otherwise pick the first provider whose `supports(method)` is true.
//   3. Fall back to the demo provider so the flow always completes
//      (useful for staging / no-API-key environments).
// =====================================================================

export type PaymentMethod =
  | "mpesa" | "tigopesa" | "airtel" | "halopesa" | "azampesa"
  | "nmb" | "crdb" | "nbc" | "equity" | "stanbic" | "other_bank"
  | "card" | "cash" | "bank_transfer";

export interface InitiateInput {
  reference:    string;            // our internal ref (ticket / tracking code)
  amount_tzs:   number;
  method:       PaymentMethod;
  phone:        string;            // E.164 ideally (+255…)
  customer_name?: string;
  customer_email?: string;
  description?: string;
}

export interface InitiateResult {
  provider:       string;          // 'selcom' | 'clickpesa' | …
  provider_ref:   string;          // aggregator transaction id
  ussd_session?:  string;
  payment_url?:   string;          // for redirect flows (cards, bank transfer)
  instructions?:  string;          // human-readable next step
  expires_at?:    string;          // ISO timestamp
  raw?:           unknown;
}

export interface CallbackVerifyInput {
  headers: Record<string,string>;
  body:    unknown;
}

export interface CallbackVerifyResult {
  valid:        boolean;
  provider_ref: string | null;
  status:       "completed" | "failed" | "cancelled" | "processing" | "unknown";
  external_ref?: string;
  paid_at?:     string;
  error?:       string;
  raw?:         unknown;
}

export interface PaymentProvider {
  name: string;
  supports(method: PaymentMethod): boolean;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  verifyCallback(input: CallbackVerifyInput): CallbackVerifyResult;
  queryStatus?(provider_ref: string): Promise<{
    status: "completed" | "failed" | "cancelled" | "processing" | "unknown";
    external_ref?: string;
    paid_at?: string;
  }>;
}

// ---------------------------------------------------------------------
// Tanzania mobile-money network detection by phone prefix.
// Used as a hint for the agent and to validate the chosen method.
// ---------------------------------------------------------------------
export function detectNetwork(phone: string): PaymentMethod | null {
  const digits = phone.replace(/[^0-9]/g, "");
  // Strip leading 255 / 0
  const local = digits.startsWith("255") ? digits.slice(3)
              : digits.startsWith("0")    ? digits.slice(1)
              : digits;
  const p2 = local.slice(0, 2);
  if (["74","75","76"].includes(p2))         return "mpesa";    // Vodacom
  if (["65","67","71"].includes(p2))         return "tigopesa"; // Tigo (Mixx by Yas)
  if (["68","69","78"].includes(p2))         return "airtel";
  if (["62","61"].includes(p2))              return "halopesa"; // Halotel
  if (["73","77"].includes(p2))              return "azampesa";
  return null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
export function envBool(name: string): boolean {
  const v = (Deno.env.get(name) || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

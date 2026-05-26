// =====================================================================
// Demo / fallback provider — fires when no real provider is configured.
// Generates a deterministic provider_ref and accepts any callback payload.
// Lets the rest of the platform (UI + DB triggers) be exercised end-to-end.
// =====================================================================

import {
  PaymentProvider, InitiateInput, InitiateResult,
  CallbackVerifyInput, CallbackVerifyResult, PaymentMethod
} from "./providers.ts";

export const demo: PaymentProvider = {
  name: "demo",
  supports(_m: PaymentMethod) { return true; },

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const ref = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    return {
      provider:     "demo",
      provider_ref: ref,
      ussd_session: ref,
      instructions: `(Demo mode) Press “I’ve paid” to simulate payment confirmation for ${input.amount_tzs} TZS.`,
      raw: { simulated: true, method: input.method },
    };
  },

  verifyCallback({ body }: CallbackVerifyInput): CallbackVerifyResult {
    const b: any = body || {};
    return {
      valid:        true,
      provider_ref: b.provider_ref || b.reference || null,
      status:       (b.status as any) || "completed",
      external_ref: b.external_ref,
      paid_at:      b.paid_at || new Date().toISOString(),
      raw:          body,
    };
  },

  async queryStatus(_ref: string) {
    return { status: "completed", paid_at: new Date().toISOString() };
  },
};

// =====================================================================
// Provider registry: chooses the right adapter for a given method.
//
// Routing precedence (highest → lowest):
//   1. PROVIDER_<METHOD> env var (e.g. PROVIDER_MPESA=clickpesa)
//   2. PRIMARY_PROVIDER global (e.g. PRIMARY_PROVIDER=selcom)
//   3. First adapter in REGISTRY whose .supports() returns true and is configured
//   4. Demo provider (fallback)
// =====================================================================

import { PaymentProvider, PaymentMethod } from "./providers.ts";
import { selcom }      from "./selcom.ts";
import { clickpesa }   from "./clickpesa.ts";
import { azampay }     from "./azampay.ts";
import { flutterwave } from "./flutterwave.ts";
import { demo }        from "./demo.ts";

export const REGISTRY: Record<string, PaymentProvider> = {
  selcom, clickpesa, azampay, flutterwave, demo
};

const PRIMARY = (Deno.env.get("PRIMARY_PROVIDER") || "selcom").toLowerCase();

function isConfigured(name: string): boolean {
  switch (name) {
    case "selcom":      return !!Deno.env.get("SELCOM_API_KEY");
    case "clickpesa":   return !!Deno.env.get("CLICKPESA_API_KEY");
    case "azampay":     return !!(Deno.env.get("AZAMPAY_TOKEN") || Deno.env.get("AZAMPAY_CLIENT_ID"));
    case "flutterwave": return !!Deno.env.get("FLW_SECRET_KEY");
    case "demo":        return true;
    default:            return false;
  }
}

export function pickProvider(method: PaymentMethod): PaymentProvider {
  // 1. Method-specific override
  const envKey = `PROVIDER_${method.toUpperCase()}`;
  const override = Deno.env.get(envKey);
  if (override && REGISTRY[override] && REGISTRY[override].supports(method) && isConfigured(override)) {
    return REGISTRY[override];
  }

  // 2. Primary provider (if it supports this method and is configured)
  if (REGISTRY[PRIMARY] && REGISTRY[PRIMARY].supports(method) && isConfigured(PRIMARY)) {
    return REGISTRY[PRIMARY];
  }

  // 3. First configured supporting adapter
  for (const name of ["selcom","clickpesa","azampay","flutterwave"]) {
    const p = REGISTRY[name];
    if (p && p.supports(method) && isConfigured(name)) return p;
  }

  // 4. Demo fallback
  return demo;
}

export function providerByName(name: string): PaymentProvider | null {
  return REGISTRY[name] || null;
}

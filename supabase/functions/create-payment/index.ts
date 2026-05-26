// =====================================================================
// POST /functions/v1/create-payment
// Initiates a payment with the right provider for the chosen method,
// records it in `payments`, and returns the next-step instructions to the
// browser (USSD push, redirect URL, or demo confirm).
//
// Body: {
//   reference:       string,    // ticket_code | tracking_code | …
//   reference_type:  string,    // booking | shipment | reschedule | other
//   amount_tzs:      number,
//   method:          string,    // mpesa | tigopesa | airtel | nmb | card | cash | …
//   phone:           string,
//   customer_name?:  string,
//   customer_email?: string,
//   description?:    string
// }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { pickProvider } from "../_shared/registry.ts";
import { detectNetwork, PaymentMethod } from "../_shared/providers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_METHODS: PaymentMethod[] = [
  "mpesa","tigopesa","airtel","halopesa","azampesa",
  "nmb","crdb","nbc","equity","stanbic","other_bank",
  "card","cash","bank_transfer"
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const {
    reference, reference_type = "booking", amount_tzs, method, phone,
    customer_name, customer_email, description,
  } = payload || {};

  // ---- validation -------------------------------------------------
  if (!reference || typeof reference !== "string")
    return json({ error: "reference_required" }, 400);
  if (!amount_tzs || amount_tzs <= 0)
    return json({ error: "amount_required" }, 400);
  if (!ALLOWED_METHODS.includes(method))
    return json({ error: "invalid_method", method }, 400);
  if (!phone || phone.length < 7)
    return json({ error: "phone_required" }, 400);

  // Mobile-money sanity check: warn (not block) if user picks a different telco
  const detected = detectNetwork(phone);
  const mobileMoney = ["mpesa","tigopesa","airtel","halopesa","azampesa"];
  if (mobileMoney.includes(method) && detected && detected !== method) {
    // Still proceed but record the mismatch in raw_request
    payload.network_mismatch = { picked: method, detected };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
  });

  // Cancel any earlier non-completed payment on this reference so the
  // partial unique index doesn't reject the new row.
  await sb.from("payments")
    .update({ status: "cancelled", error_message: "superseded by new attempt" })
    .eq("reference", reference)
    .in("status", ["pending","awaiting_payment","processing"]);

  // ---- cash short-circuit: no provider needed ----------------------
  if (method === "cash") {
    const { data, error } = await sb.from("payments").insert({
      reference, reference_type,
      amount_tzs, method,
      provider: "cash",
      status:   "awaiting_payment",
      customer_name, customer_phone: phone, customer_email,
      raw_request: payload,
    }).select().single();
    if (error) return json({ error: error.message }, 500);
    return json({
      payment_id:   data.id,
      provider:     "cash",
      status:       data.status,
      instructions: "Pay the bus agent in cash. Once they validate, your ticket will be issued.",
    });
  }

  // ---- pick provider and initiate ---------------------------------
  const provider = pickProvider(method);

  // Insert pending payment first (so we have an id even if provider call fails)
  const { data: row, error: insErr } = await sb.from("payments").insert({
    reference, reference_type,
    amount_tzs, method,
    provider:       provider.name,
    status:         "pending",
    customer_name,  customer_phone: phone, customer_email,
    raw_request:    payload,
  }).select().single();
  if (insErr) return json({ error: insErr.message }, 500);

  try {
    const result = await provider.initiate({
      reference, amount_tzs, method,
      phone, customer_name, customer_email, description,
    });

    await sb.from("payments")
      .update({
        status:        "awaiting_payment",
        provider_ref:  result.provider_ref,
        ussd_session:  result.ussd_session,
        payment_url:   result.payment_url,
        raw_response:  result.raw ?? null,
        attempts:      1,
      })
      .eq("id", row.id);

    // Demo / dev shortcut: no real provider means no callback is going to
    // flip the payment to 'completed' on its own. Auto-confirm right here
    // so book-fast.html can demonstrate the full flow end-to-end without
    // gateway credentials. Disable by setting DEMO_AUTO_CONFIRM=false.
    let finalStatus: "awaiting_payment" | "completed" = "awaiting_payment";
    const demoAutoConfirm = (Deno.env.get("DEMO_AUTO_CONFIRM") ?? "true").toLowerCase() !== "false";
    if (provider.name === "demo" && demoAutoConfirm) {
      const paidAt = new Date().toISOString();
      // ORDER MATTERS: write fare onto the booking BEFORE flipping the
      // payment to 'completed', because the payment-completion trigger
      // flips the booking to 'confirmed' which in turn fires
      // set_default_reminder. That trigger snapshots fare_tzs into the
      // SMS body — if we updated fare AFTER the status flip, the SMS
      // would go out saying "Nauli: TZS 0".
      if (reference_type === "booking") {
        await sb.from("bookings")
          .update({ fare_tzs: amount_tzs })
          .eq("ticket_code", reference);
      }
      await sb.from("payments")
        .update({ status: "completed", paid_at: paidAt })
        .eq("id", row.id);
      // Belt-and-braces: in case handle_payment_completion misses the row
      // (e.g. status guard excludes it), also flip the booking directly.
      if (reference_type === "booking") {
        await sb.from("bookings")
          .update({ status: "confirmed" })
          .eq("ticket_code", reference)
          .in("status", ["awaiting_payment","pending","held"]);
      }
      finalStatus = "completed";
    }

    return json({
      payment_id:   row.id,
      provider:     result.provider,
      provider_ref: result.provider_ref,
      payment_url:  result.payment_url,
      instructions: result.instructions,
      status:       finalStatus,
    });
  } catch (e: any) {
    await sb.from("payments")
      .update({
        status:        "failed",
        error_message: String(e?.message || e),
        attempts:      1,
      })
      .eq("id", row.id);
    return json({ error: "provider_failed", message: String(e?.message || e), payment_id: row.id }, 502);
  }
});

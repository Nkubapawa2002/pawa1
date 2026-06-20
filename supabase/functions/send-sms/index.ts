// send-sms — admin → agent SMS fallback (Africa's Talking or Twilio)
// ----------------------------------------------------------------------------
// So a message the admin sends still reaches PHONE-ONLY agents and anyone who's
// OFFLINE (they won't see the in-app dashboard message). The browser calls this
// with the admin's JWT; we verify the caller is an admin, then fan the SMS out.
//
// Body: { to: string | string[], message: string }
// Returns: { sent: number, failed: number, provider } | { error }
//
// Secrets (supabase secrets set …):
//   ADMIN_EMAILS            comma-separated admin emails allowed to send
//   SMS_PROVIDER            "africas_talking" (default) | "twilio"
//   Africa's Talking:  AT_USERNAME, AT_API_KEY, AT_SENDER_ID (optional shortcode)
//   Twilio:            TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//
// Deploy:  supabase functions deploy send-sms
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Normalise a TZ number to +255XXXXXXXXX.
function normTz(raw: string): string | null {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return d;
  if (d.startsWith("255")) return "+" + d;
  if (d.startsWith("0")) return "+255" + d.slice(1);
  if (d.length === 9) return "+255" + d;
  return "+" + d;
}

// Verify the caller is an admin by reading their JWT via Supabase Auth.
async function callerEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token || token === ANON || !SUPABASE_URL) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return (u?.email || "").toLowerCase() || null;
  } catch { return null; }
}

async function sendAfricasTalking(numbers: string[], message: string) {
  const username = Deno.env.get("AT_USERNAME") || "";
  const apiKey = Deno.env.get("AT_API_KEY") || "";
  const sender = Deno.env.get("AT_SENDER_ID") || "";
  if (!username || !apiKey) throw new Error("Africa's Talking not configured");
  const body = new URLSearchParams({ username, to: numbers.join(","), message });
  if (sender) body.set("from", sender);
  const r = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  const recips = data?.SMSMessageData?.Recipients || [];
  const sent = recips.filter((x: any) => /success|sent/i.test(x.status || "")).length;
  return { sent: sent || (r.ok ? numbers.length : 0), failed: numbers.length - (sent || 0) };
}

async function sendTwilio(numbers: string[], message: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  const from = Deno.env.get("TWILIO_FROM") || "";
  if (!sid || !tok || !from) throw new Error("Twilio not configured");
  let sent = 0, failed = 0;
  for (const to of numbers) {
    const body = new URLSearchParams({ To: to, From: from, Body: message });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    r.ok ? sent++ : failed++;
  }
  return { sent, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Admin gate — only an admin may send SMS to agents.
  const email = await callerEmail(req);
  if (!email || (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(email)))
    return json({ error: "not authorized" }, 403);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const message = String(payload?.message || "").trim();
  const toRaw = Array.isArray(payload?.to) ? payload.to : [payload?.to];
  const numbers = [...new Set(toRaw.map(normTz).filter(Boolean))] as string[];
  if (!message) return json({ error: "empty message" }, 400);
  if (!numbers.length) return json({ error: "no valid numbers" }, 400);

  const provider = (Deno.env.get("SMS_PROVIDER") || "africas_talking").toLowerCase();
  try {
    const res = provider === "twilio"
      ? await sendTwilio(numbers, message)
      : await sendAfricasTalking(numbers, message);
    return json({ ...res, provider });
  } catch (e) {
    return json({ error: (e as Error).message, provider }, 502);
  }
});

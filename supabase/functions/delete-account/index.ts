// =====================================================================
// POST /functions/v1/delete-account
//
// Removes the CALLER'S account: their data through account_erase(), their
// uploaded files, and finally the auth.users row itself.
//
// WHY THIS FUNCTION HAS TO EXIST AT ALL.
// Deleting an auth.users row needs the service_role key. The browser holds
// only the publishable key (js/core/config.js), and it must stay that way —
// service_role bypasses every RLS policy in the schema. So the deletion of
// the auth row is the one step that cannot happen in the page, and this is
// the smallest possible server that can do it.
//
// IT TAKES NO USER ID, AND MUST NEVER TAKE ONE.
// The subject comes from the caller's own JWT, verified here against the auth
// server. A body-supplied id would turn this into "delete any account in
// Tanzania, from anywhere, with a key that is printed in every browser".
// That is why there is no `p_user` anywhere below, and why the Authorization
// header is checked before anything is touched.
//
// ORDER MATTERS AND IS NOT ARBITRARY:
//   1. verify who is calling
//   2. account_erase()  — the rows, including every public listing
//   3. storage          — the files, which no SQL can reach
//   4. auth.users       — last, because once it is gone the JWT above can no
//                         longer be verified and a retry could not identify
//                         the caller to finish the job
// A failure at 2 stops everything: a half-deleted account that still owns
// listings is worse than one that is still whole and can try again.
//
// DEPLOY:  supabase functions deploy delete-account
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

// Every bucket that can hold something a person uploaded. Files are stored
// under a per-owner prefix; anything that is not is swept by gc-orphan-media
// the following day, once its row is gone.
const BUCKETS = [
  "house-photos",
  "truck-photos",
  "service-photos",
  "agent-photos",
  "region-videos",
  "bus-photos",
  "ride-driver-photos",
];

async function removePrefix(sb: ReturnType<typeof createClient>, bucket: string, uid: string) {
  let removed = 0;
  try {
    const { data, error } = await sb.storage.from(bucket).list(uid, { limit: 1000 });
    if (error || !data?.length) return 0;
    const paths = data.filter((e) => e.id !== null).map((e) => `${uid}/${e.name}`);
    if (!paths.length) return 0;
    const { error: rmErr } = await sb.storage.from(bucket).remove(paths);
    if (!rmErr) removed = paths.length;
  } catch (_) {
    // A bucket that does not exist on this project is not an error here: the
    // list is deliberately broader than any one deployment.
  }
  return removed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return json({ error: "sign_in_required" }, 401);
  }

  // Step 1 — who is calling. This client carries the CALLER'S token and the
  // publishable key, so it can do nothing the caller could not already do.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });

  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  const uid = who?.user?.id;
  if (whoErr || !uid) return json({ error: "sign_in_required" }, 401);

  // An anonymous session has pm_guest_forget, which ends it properly and
  // leaves no auth row worth removing.
  if (who!.user!.is_anonymous === true) {
    return json({ error: "guest_session" }, 400);
  }

  let body: { wipe_messages?: boolean } = {};
  try { body = await req.json(); } catch (_) { /* an empty body is fine */ }

  // Step 2 — the rows. Run AS THE CALLER, deliberately: account_erase() reads
  // app_uid() and can only ever reach the person asking, so running it here
  // keeps that guarantee instead of trusting this function to pass the right
  // id. It also means the "last admin" refusal reaches the caller intact.
  const { data: erased, error: eraseErr } = await asCaller.rpc("account_erase", {
    p_wipe_messages: body.wipe_messages !== false,
  });
  if (eraseErr) {
    return json({ error: "erase_failed", detail: eraseErr.message }, 400);
  }

  // Step 3 — the files.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  let files = 0;
  for (const b of BUCKETS) files += await removePrefix(admin, b, uid);

  // Step 4 — the account itself, last.
  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) {
    // The data is already gone, so say so rather than reporting a bare
    // failure: the person's listings are down and their key is unpublished,
    // and a retry of this endpoint would now fail at step 1 with no session.
    return json({
      error: "auth_delete_failed",
      detail: delErr.message,
      erased,
      files,
    }, 500);
  }

  return json({ ok: true, erased, files });
});

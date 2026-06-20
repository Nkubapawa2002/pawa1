// =====================================================================
// verify_registration.mjs — end-to-end proof that agent registration works
// against the LIVE Supabase project, using the public anon client exactly
// like the browser does.
//
// This is the real test of the "Clerk off → Storage owner_id is a UUID" fix:
// it signs in as a test agent, uploads a tiny image to the house-photos bucket
// (the step that was throwing `invalid input syntax for type uuid` under Clerk),
// inserts a houses row, reads it back, then deletes both so nothing is left
// behind.
//
// Reads from environment (load .env first):
//   TEST_EMAIL, TEST_PASSWORD      — a throwaway agent account on the live site
//   SUPABASE_URL, SUPABASE_ANON_KEY — optional; falls back to the public values
//                                     baked into js/config.js
//
// Run:
//   set -a; . ./.env; set +a; node scripts/verify_registration.mjs
// (PowerShell: load the vars then `node scripts/verify_registration.mjs`)
// =====================================================================
import { createClient } from "@supabase/supabase-js";

// Public, browser-safe defaults (same as js/config.js). Override via env.
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://kkdpacoiwntrcukgwksh.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const BUCKET = "house-photos";

let pass = 0, fail = 0;
const ok = (m) => { console.log("  ✓ " + m); pass++; };
const bad = (m, e) => { console.log("  ✗ " + m + (e ? "  → " + (e.message || e) : "")); fail++; };
const step = (m) => console.log("\n" + m);

// A 1x1 transparent PNG — the smallest valid image upload.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/foeAAAAAElFTkSuQmCC",
  "base64"
);

if (!EMAIL || !PASSWORD) {
  console.error(
    "TEST_EMAIL and TEST_PASSWORD must be set (put them in .env, then:\n" +
    "  set -a; . ./.env; set +a; node scripts/verify_registration.mjs)\n" +
    "TEST_PASSWORD is currently " + (PASSWORD ? "set" : "EMPTY") + "."
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let uid = null;
let insertedId = null;
let uploadedPath = null;

async function main() {
  step("1. Sign in (native Supabase Auth)");
  {
    const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (error) { bad("sign in", error); return; }
    uid = data.user?.id;
    if (!uid) { bad("no user id on session"); return; }
    // The whole point: a native Supabase uid is a UUID, not a Clerk "user_..." id.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid);
    isUuid ? ok(`signed in — uid is a UUID (${uid})`)
           : bad(`signed in but uid is NOT a uuid (${uid}) — Clerk may still be active`);
  }

  step("2. Upload a photo to the " + BUCKET + " bucket  (the step that failed under Clerk)");
  {
    uploadedPath = `${uid}/verify-${Date.now()}.png`;
    const { error } = await sb.storage.from(BUCKET).upload(uploadedPath, PNG_1PX, {
      contentType: "image/png", upsert: false,
    });
    if (error) { bad("storage upload", error); uploadedPath = null; }
    else {
      ok("upload succeeded (owner_id accepted the UUID)");
      const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(uploadedPath);
      console.log("    public url: " + (pub?.publicUrl || "(n/a)"));
    }
  }

  step("3. Insert a houses row owned by this user");
  {
    insertedId = "verify-" + Date.now().toString(36);
    const row = {
      id: insertedId,
      title: "[verify] delete me",
      type: "room", listing: "rent", period: "month",
      price_tzs: 1, currency: "TZS",
      lat: -6.7924, lng: 39.2083,
      photo: uploadedPath, photos: uploadedPath ? [uploadedPath] : [],
      owner_user_id: uid,
    };
    const { data, error } = await sb.from("houses").insert(row).select();
    if (error) { bad("insert houses row", error); insertedId = null; }
    else if (!data || !data.length) { bad("insert returned no row (RLS dropped it silently?)"); insertedId = null; }
    else ok("insert succeeded and RLS returned the row");
  }

  step("4. Read it back as the owner");
  if (insertedId) {
    const { data, error } = await sb.from("houses").select("id, owner_user_id").eq("id", insertedId).maybeSingle();
    if (error) bad("read back", error);
    else if (!data) bad("row not visible on read back");
    else if (data.owner_user_id !== uid) bad(`owner_user_id mismatch (${data.owner_user_id})`);
    else ok("row reads back with correct owner");
  }
}

async function cleanup() {
  step("5. Cleanup (leave nothing behind)");
  if (insertedId) {
    const { error } = await sb.from("houses").delete().eq("id", insertedId);
    error ? bad("delete test row", error) : ok("deleted test houses row");
  }
  if (uploadedPath) {
    const { error } = await sb.storage.from(BUCKET).remove([uploadedPath]);
    error ? bad("delete test upload", error) : ok("deleted test upload");
  }
  try { await sb.auth.signOut(); } catch (_) {}
}

await main().catch((e) => bad("unexpected error", e));
await cleanup().catch((e) => bad("cleanup error", e));

console.log(`\n${"=".repeat(48)}\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// ============================================================================
// verify_video_space.mjs — "is the homepage video space actually live?"
//
// Checks every dependency the video space has, in the order they are needed,
// and prints exactly which step is missing. Run it after applying
// supabase/features/video/region_video_space.sql, and any time the space is
// showing nothing on the homepage.
//
// WHY THIS TALKS HTTPS, NOT POSTGRES
//   The other scripts in this folder connect on port 5432, which is blocked on
//   plenty of networks (corporate Wi-Fi, some VPNs, most mobile hotspots). This
//   one goes through PostgREST and the Storage API on 443 with the public anon
//   key, so it runs from anywhere the site itself runs. That also makes it an
//   honest test: it exercises the same endpoints the browser uses.
//
//   The trade-off is that it can only see what an anonymous visitor can see. It
//   proves the read path works; it cannot prove the admin write path does.
//
//   usage:  node scripts/db/verify_video_space.mjs
// ============================================================================

const URL_BASE = "https://kkdpacoiwntrcukgwksh.supabase.co";
const ANON = "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const GATEWAY = "https://pawa-video-gateway-oymf.onrender.com";
const BUCKET = "region-videos";

const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" };

let failures = 0;
const pass = (m, extra = "") => console.log(`  PASS  ${m}${extra ? "  — " + extra : ""}`);
const fail = (m, why) => { failures++; console.log(`  FAIL  ${m}\n        ${why}`); };
const note = (m) => console.log(`  ....  ${m}`);

async function get(path, opts = {}) {
  const res = await fetch(`${URL_BASE}${path}`, { headers: H, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* empty body is fine */ }
  return { ok: res.ok, status: res.status, body };
}

console.log("\nVideo space — dependency check\n");

// ---- 1. regions -------------------------------------------------------------
// region_videos.region is a foreign key onto regions(name). An unseeded regions
// table means every claim fails with 'unknown_region' and nothing explains why.
console.log("1. Regions");
{
  const r = await get("/rest/v1/regions?select=name");
  if (!r.ok) {
    fail("public.regions readable", JSON.stringify(r.body));
  } else if (!Array.isArray(r.body) || r.body.length < 31) {
    fail(`public.regions seeded (found ${r.body?.length ?? 0}, expected 31)`,
         "run supabase/ops/regions_seed.sql");
  } else {
    pass("public.regions seeded", `${r.body.length} regions`);
    // The client resolves a region from js/lib/tz-places.js and sends the NAME.
    // A mismatch here is invisible until someone in that region tries to post.
    const have = new Set(r.body.map((x) => x.name));
    const missing = ["Dar es Salaam", "Mwanza", "Arusha", "Mjini Magharibi"].filter((n) => !have.has(n));
    if (missing.length) fail("gazetteer names match regions", `missing: ${missing.join(", ")}`);
    else pass("gazetteer names match regions");
  }
}

// ---- 2. tables --------------------------------------------------------------
console.log("\n2. Tables");
for (const [table, query] of [
  ["region_videos", "/rest/v1/region_videos?select=id&limit=1"],
  ["region_video_defaults", "/rest/v1/region_video_defaults?select=region&limit=1"],
]) {
  const r = await get(query);
  if (r.ok) pass(`public.${table} exists and is readable`);
  else if (r.body?.code === "PGRST205") fail(`public.${table} exists`, "run supabase/features/video/region_video_space.sql");
  else fail(`public.${table} readable`, JSON.stringify(r.body));
}

// ---- 3. RPCs ----------------------------------------------------------------
// current_region_video is the ONLY call the homepage makes to decide what to
// play, so if it is missing the space renders empty forever with no error.
console.log("\n3. RPCs");
{
  const r = await get("/rest/v1/rpc/current_region_video", {
    method: "POST", body: JSON.stringify({ p_region: "Dar es Salaam" }),
  });
  if (r.ok) {
    const src = r.body?.source || "none";
    pass("current_region_video(text) callable by anon", `Dar es Salaam → source="${src}"`);
    if (src === "none") note("nothing playing in Dar yet — set a default in admin.html → Video space");
  } else if (r.body?.code === "PGRST202") {
    fail("current_region_video(text) exists", "run supabase/features/video/region_video_space.sql");
  } else {
    fail("current_region_video(text) callable", JSON.stringify(r.body));
  }

  // The write RPCs must exist but must NOT be callable anonymously. A 401/403
  // here is the CORRECT answer; a 200 would mean anyone can seize a slot.
  for (const [fn, args] of [
    ["claim_region_video_slot", { p_region: "Dar es Salaam" }],
    ["publish_region_video", { p_claim_id: "00000000-0000-0000-0000-000000000000", p_path: "x/y.mp4" }],
  ]) {
    const w = await get(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    if (w.body?.code === "PGRST202") fail(`${fn} exists`, "run region_video_space.sql");
    else if (w.ok && w.body?.ok === false && w.body?.reason === "auth_required") pass(`${fn} refuses anonymous callers`);
    else if (!w.ok && [401, 403, 404].includes(w.status)) pass(`${fn} not granted to anon`, `HTTP ${w.status}`);
    else fail(`${fn} refuses anonymous callers`, `got HTTP ${w.status} ${JSON.stringify(w.body)}`);
  }
}

// ---- 4. storage bucket ------------------------------------------------------
// Public read is what lets a <video src> play without a signed URL. If the
// bucket is private every clip is a black rectangle with a 400 behind it.
//
// Ask the BUCKET endpoint, not object/list: listing a bucket that does not
// exist returns an empty array rather than a 404, so it can never tell the
// difference between "no bucket" and "bucket with nothing in it".
console.log("\n4. Storage");
{
  const r = await fetch(`${URL_BASE}/storage/v1/bucket/${BUCKET}`, { headers: H });
  const b = await r.json().catch(() => null);
  if (!r.ok || b?.code === "NoSuchBucket") {
    fail(`bucket "${BUCKET}" exists`, "run supabase/features/video/region_video_space.sql (it creates the bucket)");
  } else if (b?.public !== true) {
    fail(`bucket "${BUCKET}" is public`, "clips would need signed URLs; the homepage uses public ones");
  } else {
    const mb = b.file_size_limit ? `${Math.round(b.file_size_limit / 1048576)} MB cap` : "no size cap";
    pass(`bucket "${BUCKET}" exists and is public`, mb);
  }
}

// ---- 5. video gateway -------------------------------------------------------
// Free-tier Render sleeps after ~15 min idle, so the first call can take a
// while. That is not a failure — it is why the uploader falls back gracefully.
console.log("\n5. Video gateway (trimming)");
{
  note("waking the gateway — a cold free-tier instance takes up to ~60s…");
  try {
    const ctl = AbortSignal.timeout(90_000);
    const r = await fetch(`${GATEWAY}/health`, { signal: ctl });
    const h = await r.json();
    if (h.faststart === "ready") pass("ffmpeg present");
    else fail("ffmpeg present", `/health says faststart="${h.faststart}"`);

    if (h.trim === "ready") {
      pass("trimming enabled", `cap ${h.max_duration_s}s`);
    } else if (h.trim === undefined) {
      fail("gateway is running the NEW code",
           "/health has no \"trim\" field — this is the pre-video-space build.\n" +
           "        Merge services/python/main.py to main; Render autoDeploy rebuilds it.");
    } else {
      fail("trimming enabled", `/health says trim="${h.trim}" — ffprobe is missing from the image`);
    }
  } catch (e) {
    fail("gateway reachable", `${e.message} — clips over the cap will be refused until it is up`);
  }
}

// ---- verdict ----------------------------------------------------------------
console.log(
  failures === 0
    ? "\nAll checks passed — the video space is ready to take its first video.\n"
    : `\n${failures} check(s) failed — see above. The video space is not fully live yet.\n`,
);
process.exit(failures === 0 ? 0 : 1);

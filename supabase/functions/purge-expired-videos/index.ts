// =====================================================================
// POST /functions/v1/purge-expired-videos
//
// The janitor for the video space. Every community video lives 9 hours; this
// removes the blobs once that is up, and clears out unfinished claims.
//
// IMPORTANT — this is NOT what makes a video stop showing. Expiry is enforced
// at read time (current_region_video filters on expires_at > now(), and the
// claim RPC releases aged rows before it inserts), so if this function is late,
// wedged or never runs at all, viewers still see the right thing and the slot
// still frees on schedule. All that accumulates is dead bytes in the bucket.
// That separation is deliberate: a cron failure must never become a correctness
// failure, only a storage bill.
//
// Triggered hourly by pg_cron via pg_net — see region_video_ttl_cron.sql.
// Uses the service role (auto-injected) so it can purge across all owners and
// bypass RLS. If PURGE_SECRET is set, callers must send a matching x-purge-key
// header, exactly as purge-expired-houses does.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PURGE_SECRET = Deno.env.get("PURGE_SECRET") || "";
const BUCKET       = "region-videos";

// How long an expired row is kept before its blob is deleted. A small grace so
// a viewer who started playing seconds before expiry is not cut off mid-clip.
const GRACE_MINUTES = 10;

// Orphan sweep: an object whose upload finished but whose publish never landed
// (tab closed, connection dropped). Anything unreferenced and older than this
// is dead weight. Generous enough that a slow in-flight upload is never eaten.
const ORPHAN_HOURS = 3;

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  if (PURGE_SECRET && req.headers.get("x-purge-key") !== PURGE_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. Move anything aged out to 'expired'. Same statement the claim RPC runs,
  //    called here for every region at once so slots free even in a region
  //    nobody is currently trying to post to.
  const { error: relErr } = await sb.rpc("release_expired_region_videos", { p_region: null });
  if (relErr) return json({ error: "release_failed", detail: relErr.message }, 500);

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString();

  // 2. Delete the blobs behind expired rows, then the rows.
  const { data: dead, error: qErr } = await sb
    .from("region_videos")
    .select("id, storage_path")
    .eq("status", "expired")
    .lte("expires_at", cutoff);
  if (qErr) return json({ error: "query_failed", detail: qErr.message }, 500);

  // Never delete a blob an admin default points at. A default is normally
  // uploaded by an admin and has no region_videos row, but an admin promoting a
  // community clip to the default would otherwise have it swept out from under
  // them 9 hours later.
  const { data: defaults } = await sb.from("region_video_defaults").select("storage_path");
  const kept = new Set((defaults || []).map((d) => d.storage_path).filter(Boolean));

  let filesRemoved = 0;
  let rowsRemoved = 0;

  if (dead?.length) {
    const paths = [...new Set(
      dead.map((r) => r.storage_path).filter((p): p is string => !!p && !kept.has(p)),
    )];
    for (const group of chunk(paths, 100)) {
      const { data, error } = await sb.storage.from(BUCKET).remove(group);
      if (!error && Array.isArray(data)) filesRemoved += data.length;
    }
    for (const group of chunk(dead.map((r) => r.id), 100)) {
      const { error, count } = await sb
        .from("region_videos").delete({ count: "exact" }).in("id", group);
      if (!error) rowsRemoved += count || 0;
    }
  }

  // 3. Orphan sweep — objects in the bucket that no row and no default
  //    references. Uploads live at `<uid>/<file>`, so list the top level then
  //    one level down, the same shape gc-orphan-media uses.
  let orphansRemoved = 0;
  try {
    const { data: refRows } = await sb
      .from("region_videos").select("storage_path").not("storage_path", "is", null);
    const referenced = new Set<string>([
      ...(refRows || []).map((r) => r.storage_path as string),
      ...kept,
    ]);

    const orphanCutoff = Date.now() - ORPHAN_HOURS * 60 * 60 * 1000;
    const { data: folders } = await sb.storage.from(BUCKET).list("", { limit: 1000 });
    const orphans: string[] = [];

    for (const folder of folders || []) {
      // Entries with no id are prefixes (folders); files at the root are not
      // something this bucket's policies can produce, so skip them.
      if (folder.id) continue;
      const { data: files } = await sb.storage.from(BUCKET).list(folder.name, { limit: 1000 });
      for (const f of files || []) {
        const path = `${folder.name}/${f.name}`;
        if (referenced.has(path)) continue;
        const created = Date.parse(f.created_at || f.updated_at || "");
        if (!isFinite(created) || created > orphanCutoff) continue;  // too young to judge
        orphans.push(path);
      }
    }
    for (const group of chunk(orphans, 100)) {
      const { data, error } = await sb.storage.from(BUCKET).remove(group);
      if (!error && Array.isArray(data)) orphansRemoved += data.length;
    }
  } catch (_) {
    // The orphan sweep is best-effort; a failure here must not fail the run.
  }

  return json({ ok: true, filesRemoved, rowsRemoved, orphansRemoved });
});

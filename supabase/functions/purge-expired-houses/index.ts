// =====================================================================
// POST /functions/v1/purge-expired-houses
//
// Enforces the 15-day Time-To-Live on house/room listings: every listing
// older than 15 days (houses.created_at) has its media files removed from the
// house-photos bucket via the Storage API (the ONLY supported way — direct
// SQL deletes on storage.objects are blocked) and then its row deleted.
//
// Triggered daily by pg_cron (via pg_net) — see supabase/house_media_ttl.sql.
// Uses the service role (auto-injected) so it can purge across all owners and
// bypass RLS. If PURGE_SECRET is set, callers must send a matching x-purge-key
// header — the daily cron passes it; that keeps the public endpoint from being
// triggered by strangers (the action is idempotent regardless).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PURGE_SECRET = Deno.env.get("PURGE_SECRET") || "";
const BUCKET       = "house-photos";
const TTL_DAYS     = 15;

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  // Optional shared-secret gate (the cron sends it; see Vault secret 'purge_secret').
  if (PURGE_SECRET && req.headers.get("x-purge-key") !== PURGE_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Listings whose 15 days are up.
  const { data: expired, error } = await sb
    .from("houses")
    .select("id, photo, photos, videos")
    .lte("created_at", cutoff);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);

  let filesRemoved = 0;
  let removed = 0;
  if (expired?.length) {
    // Collect every in-bucket media path (skip external URLs and bundled demo assets).
    const paths = new Set<string>();
    for (const h of expired) {
      for (const p of [h.photo, ...(h.photos || []), ...(h.videos || [])]) {
        if (p && typeof p === "string" && !p.startsWith("http") && !p.startsWith("data/")) {
          paths.add(p);
        }
      }
    }
    for (const group of chunk([...paths], 100)) {
      const { data, error: rmErr } = await sb.storage.from(BUCKET).remove(group);
      if (!rmErr && Array.isArray(data)) filesRemoved += data.length;
    }
    // Delete the rows (house_tenancies.house_id is ON DELETE SET NULL → history survives).
    for (const group of chunk(expired.map((h) => h.id), 100)) {
      const { error: delErr, count } = await sb
        .from("houses")
        .delete({ count: "exact" })
        .in("id", group);
      if (!delErr) removed += count || 0;
    }
  }

  // Garbage-collect orphaned media: files in the bucket that NO listing references
  // (e.g. left behind by older deletes). Enumerate via the Storage API — the
  // `storage` schema isn't exposed to PostgREST, so we can't SELECT it. Uploads
  // are stored at `<uid>/<file>`, so we list the top level then one level down.
  // 1-day margin so a file uploaded moments before its row is saved is safe.
  let orphansRemoved = 0;
  const dayMs = Date.now() - 24 * 60 * 60 * 1000;
  const allPaths: string[] = [];
  const { data: top } = await sb.storage.from(BUCKET).list("", { limit: 1000 });
  for (const entry of top || []) {
    if (entry.id === null) {
      // a folder (prefix) — list its files
      const { data: sub } = await sb.storage.from(BUCKET).list(entry.name, { limit: 1000 });
      for (const f of sub || []) {
        if (f.id && new Date(f.created_at).getTime() < dayMs) allPaths.push(`${entry.name}/${f.name}`);
      }
    } else if (new Date(entry.created_at).getTime() < dayMs) {
      allPaths.push(entry.name);
    }
  }
  const { data: live } = await sb.from("houses").select("photo, photos, videos");
  const referenced = new Set<string>();
  for (const h of live || []) {
    for (const p of [h.photo, ...(h.photos || []), ...(h.videos || [])]) {
      if (p && typeof p === "string") referenced.add(p);
    }
  }
  const orphans = allPaths.filter((n) => !referenced.has(n));
  for (const group of chunk(orphans, 100)) {
    const { data, error: rmErr } = await sb.storage.from(BUCKET).remove(group);
    if (!rmErr && Array.isArray(data)) orphansRemoved += data.length;
  }

  return json({ ok: true, removed, files_removed: filesRemoved, orphans_removed: orphansRemoved });
});

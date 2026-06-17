// =====================================================================
// POST /functions/v1/gc-orphan-media
//
// Garbage-collects orphaned media: files in the directory storage buckets that
// no live listing/profile references (left behind by deletes/edits — and still
// publicly reachable by URL until removed). Runs across every directory bucket
// against its owning table's path columns. Uses the service role (auto-injected)
// so it can read every table and delete via the Storage API (direct SQL deletes
// on storage.objects are blocked).
//
// Triggered daily by pg_cron (via pg_net) — see supabase/gc_orphan_media.sql.
// A 1-day margin protects files uploaded moments before their row is saved.
// If PURGE_SECRET is set, callers must send a matching x-purge-key header.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PURGE_SECRET = Deno.env.get("PURGE_SECRET") || "";

// bucket -> { table, columns } whose values hold in-bucket storage paths.
const BUCKETS: Record<string, { table: string; columns: string[] }> = {
  "house-photos":   { table: "houses",   columns: ["photo", "photos", "videos"] },
  "truck-photos":   { table: "trucks",   columns: ["photo", "photos"] },
  "agent-photos":   { table: "agents",   columns: ["photo_path"] },
  "service-photos": { table: "services", columns: ["photo", "photos"] },
};

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
  const dayMs = Date.now() - 24 * 60 * 60 * 1000;
  const result: Record<string, number> = {};

  // Recursively list every object path in a bucket (folders have id === null).
  async function listAll(bucket: string, prefix = "", depth = 0): Promise<{ path: string; created: number }[]> {
    if (depth > 5) return [];
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error || !data) return [];
    const out: { path: string; created: number }[] = [];
    for (const e of data) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) {
        out.push(...await listAll(bucket, full, depth + 1));     // a folder
      } else {
        out.push({ path: full, created: new Date(e.created_at).getTime() });
      }
    }
    return out;
  }

  for (const [bucket, cfg] of Object.entries(BUCKETS)) {
    // Build the set of paths still referenced by a live row (skip URLs / demo assets).
    const { data: rows, error } = await sb.from(cfg.table).select(cfg.columns.join(", "));
    if (error) { result[bucket] = -1; continue; }   // table missing → skip safely
    const referenced = new Set<string>();
    for (const row of rows || []) {
      for (const col of cfg.columns) {
        const v = (row as Record<string, unknown>)[col];
        for (const p of Array.isArray(v) ? v : [v]) {
          if (p && typeof p === "string" && !p.startsWith("http") && !p.startsWith("data/")) {
            referenced.add(p);
          }
        }
      }
    }

    const objects = await listAll(bucket);
    const orphans = objects.filter((o) => o.created < dayMs && !referenced.has(o.path)).map((o) => o.path);
    let removed = 0;
    for (const group of chunk(orphans, 100)) {
      const { data, error: rmErr } = await sb.storage.from(bucket).remove(group);
      if (!rmErr && Array.isArray(data)) removed += data.length;
    }
    result[bucket] = removed;
  }

  return json({ ok: true, removed: result });
});

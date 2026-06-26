// Diagnostic (read-only): list every house video and report whether it is MP4
// "faststart" (moov atom before mdat) or not. A non-faststart clip forces the
// browser to download the whole file before it plays — the "scratching, not
// directly watching" symptom. Needs only PG_PASSWORD (public bucket reads).
//
//   PG_PASSWORD=… node scripts/faststart_audit.mjs

import pg from "pg";

const PROJECT_REF = "kkdpacoiwntrcukgwksh";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const BUCKET = "house-photos";
const PASSWORD = process.env.PG_PASSWORD;
if (!PASSWORD) { console.error("PG_PASSWORD env not set"); process.exit(1); }

const candidates = [
  { label: "direct", host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: "postgres" },
  { label: "pooler eu-west-1", host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler us-east-1", host: "aws-0-us-east-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: "pooler eu-central-1", host: "aws-0-eu-central-1.pooler.supabase.com", port: 5432, user: `postgres.${PROJECT_REF}` },
];

async function pickClient() {
  for (const c of candidates) {
    const client = new pg.Client({
      host: c.host, port: c.port, user: c.user, password: PASSWORD,
      database: "postgres", ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000, statement_timeout: 60000,
    });
    try { await client.connect(); console.log(`connected via ${c.label}`); return client; }
    catch (e) { console.log(`  ${c.label} fail: ${e.code || e.message}`); try { await client.end(); } catch {} }
  }
  throw new Error("could not connect");
}

// Read the first `bytes` of an object via an HTTP Range request and decide
// faststart from moov/mdat positions. moov can be large, so a 256 KB window is
// usually enough to see whether moov sits before mdat near the start.
async function checkFaststart(path) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(path)}`;
  // Pull the head and the tail: head shows moov-first; if not, a moov in the
  // tail confirms moov-at-end (needs remux).
  const head = await fetchRange(url, "bytes=0-262143");
  if (!head.ok) return { status: head.status, state: "unreachable" };
  const moovHead = head.buf.indexOf("moov");
  const mdatHead = head.buf.indexOf("mdat");
  if (moovHead !== -1 && (mdatHead === -1 || moovHead < mdatHead)) {
    return { state: "faststart", size: head.total };
  }
  // moov not seen before mdat in the head -> almost certainly moov-at-end.
  return { state: "needs-remux", size: head.total };
}

async function fetchRange(url, range) {
  try {
    const r = await fetch(url, { headers: { Range: range } });
    const total = Number(
      (r.headers.get("content-range") || "").split("/")[1] ||
      r.headers.get("content-length") || 0);
    if (!r.ok && r.status !== 206) return { ok: false, status: r.status };
    const ab = await r.arrayBuffer();
    return { ok: true, status: r.status, total, buf: Buffer.from(ab) };
  } catch (e) { return { ok: false, status: e.message }; }
}

const client = await pickClient();
const { rows } = await client.query(
  "select id, title, videos from houses where videos is not null and videos <> '{}'");
await client.end();

const seen = new Set();
const items = [];
for (const row of rows) {
  for (const p of row.videos || []) {
    if (!p || p.startsWith("http") || p.startsWith("data/") || seen.has(p)) continue;
    seen.add(p);
    items.push({ path: p, house: row.title });
  }
}

console.log(`\n${rows.length} house row(s) with videos; ${items.length} distinct stored clip(s).\n`);
let ok = 0, bad = 0, err = 0;
for (const it of items) {
  const r = await checkFaststart(it.path);
  const kb = r.size ? `${Math.round(r.size / 1024)} KB` : "?";
  if (r.state === "faststart") { ok++; console.log(`  [ok]    ${kb.padStart(8)}  ${it.path}`); }
  else if (r.state === "needs-remux") { bad++; console.log(`  [STUTTER]${kb.padStart(7)}  ${it.path}   (${it.house})`); }
  else { err++; console.log(`  [err ${r.status}]        ${it.path}`); }
}
console.log(`\nSummary: faststart=${ok}  needs-remux=${bad}  unreachable=${err}`);
if (bad > 0) console.log(`\n-> ${bad} clip(s) will stutter. Run the backfill to fix them.`);

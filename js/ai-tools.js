// =====================================================================
// js/ai-tools.js — the AI assistant's tool belt (agentic search).
//
// Gives the chat brain the ability to LOOK THINGS UP across the app
// (houses, services, trucks, day jobs, agents, buses, parcels, places)
// instead of answering from a static snapshot.
//
// SECURITY MODEL — why this can't leak data:
//   • Every query runs in the browser through the PUBLIC anon Supabase
//     client (window.DataStore), so Postgres RLS is the boundary: the AI
//     can only ever read what an anonymous visitor of the site can read.
//   • Tools are a fixed allowlist with fixed filters — the model can pick
//     parameters, never tables, columns or raw SQL.
//   • Each tool returns a column-allowlisted, row-capped (≤8) projection.
//   • Parcel lookup needs the EXACT tracking code (same rule as track.html)
//     and masks phone numbers; there is no "list parcels" tool.
//   • No tool touches job claims, tenants, payments or any account table.
//
// Load AFTER js/data.js + js/ai.js:  <script src="js/ai-tools.js"></script>
// =====================================================================

(function () {
  const MAX_ROWS = 8;
  const str = (v, n = 90) => (v == null ? "" : String(v).slice(0, n));
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const maskPhone = (p) => {
    p = str(p, 20);
    return p.length > 6 ? p.slice(0, 5) + "****" + p.slice(-2) : (p ? "***" : "");
  };
  const norm = (s) => String(s || "").toLowerCase();
  const matches = (hay, q) => !q || norm(hay).includes(norm(q));
  // Listings keep contact in an `owner` jsonb ({name, phone, whatsapp});
  // it's shown publicly on every listing page, so tools may quote it too.
  const ownerPhone = (x) => str(x?.owner?.phone || x?.owner?.whatsapp || x?.phone || x?.contact, 20);

  // ---- tool implementations -----------------------------------------

  async function search_houses(a = {}) {
    const all = await window.DataStore.getHouses();
    const out = (all || []).filter((h) => {
      // Mirror the public directory (houses.js): a listing marked unavailable
      // (deal completed / deactivated by the owner) is OFF the public list, so
      // the AI must not surface it either. RLS already hides suspended owners.
      if (h.available === false) return false;
      if (a.listing && norm(h.listing || "rent") !== norm(a.listing)) return false;
      if (a.region && !matches(h.region, a.region)) return false;
      if (a.area && !matches([h.area, h.address, h.ward, h.district].join(" "), a.area)) return false;
      if (num(a.max_price) && +h.price_tzs > num(a.max_price)) return false;
      if (num(a.min_bedrooms) && (+h.bedrooms || 0) < num(a.min_bedrooms)) return false;
      if (a.type && !matches(h.type, a.type)) return false;
      if (a.query && !matches([h.title, h.description, h.area, h.region, h.type].join(" "), a.query)) return false;
      return true;
    }).slice(0, MAX_ROWS).map((h) => ({
      title: str(h.title), type: str(h.type, 30),
      where: str([h.area, h.region].filter(Boolean).join(", "), 60),
      price_tzs: num(h.price_tzs), listing: str(h.listing || "rent", 10),
      bedrooms: num(h.bedrooms), phone: ownerPhone(h),
      link: h.id ? "house.html?id=" + h.id : "houses.html",
    }));
    return { count: out.length, results: out };
  }

  async function search_services(a = {}) {
    const all = await window.DataStore.getServices();
    const out = (all || []).filter((s) =>
      (!a.category || matches(s.category || s.type, a.category)) &&
      (!a.region || matches(s.region, a.region)) &&
      (!a.area || matches([s.area, s.address].join(" "), a.area)) &&
      (!a.query || matches([s.name, s.title, s.description, s.category, s.area].join(" "), a.query))
    ).slice(0, MAX_ROWS).map((s) => ({
      name: str(s.name || s.title), category: str(s.category || s.type, 30),
      where: str([s.area, s.region].filter(Boolean).join(", "), 60),
      price_hint: str(s.price_note || s.price_tzs, 40), phone: ownerPhone(s),
      link: "services.html",
    }));
    return { count: out.length, results: out };
  }

  async function search_trucks(a = {}) {
    const all = await window.DataStore.getTrucks();
    const out = (all || []).filter((t) =>
      (!a.region || matches(t.region, a.region)) &&
      (!a.size || matches(t.size || t.capacity, a.size)) &&
      (!a.query || matches([t.name, t.title, t.description, t.size, t.area, t.region].join(" "), a.query))
    ).slice(0, MAX_ROWS).map((t) => ({
      name: str(t.name || t.title), size: str(t.size || t.capacity, 30),
      where: str([t.area, t.region].filter(Boolean).join(", "), 60),
      phone: ownerPhone(t), link: t.id ? "truck.html?id=" + t.id : "trucks.html",
    }));
    return { count: out.length, results: out };
  }

  async function search_jobs(a = {}) {
    const sb = window.DataStore?.sb;
    if (!sb) return { count: 0, results: [], note: "jobs need a live connection" };
    // Open, unexpired, PUBLIC job posts only — claims (worker names/phones)
    // are intentionally NOT reachable from any tool.
    let q = sb.from("day_jobs")
      .select("title,company_name,region,area,pay_tzs,pay_note,work_date,time_note,workers_needed,claimed_count")
      .eq("status", "open").gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }).limit(MAX_ROWS);
    if (a.region) q = q.ilike("region", "%" + String(a.region).slice(0, 40) + "%");
    const { data, error } = await q;
    if (error) return { error: "lookup failed" };
    const out = (data || []).filter((j) =>
      !a.query || matches([j.title, j.company_name, j.area].join(" "), a.query)
    ).map((j) => ({
      title: str(j.title), company: str(j.company_name),
      where: str([j.area, j.region].filter(Boolean).join(", "), 60),
      pay_tzs: num(j.pay_tzs), pay_note: str(j.pay_note, 60),
      date: str(j.work_date, 20), time: str(j.time_note, 40),
      slots_left: Math.max(0, (j.workers_needed || 0) - (j.claimed_count || 0)),
      link: "jobs.html",
    }));
    return { count: out.length, results: out };
  }

  async function locate_place(a = {}) {
    if (!window.AI?.locate) return { error: "locating unavailable" };
    const hit = await window.AI.locate(String(a.query || "").slice(0, 120));
    return hit ? { label: str(hit.label, 90), lat: hit.lat, lng: hit.lng, region: str(hit.region, 30) }
               : { found: false };
  }

  // ---- registry + prompt contract ------------------------------------

  const TOOLS = {
    search_houses, search_services, search_trucks, search_jobs, locate_place,
  };

  // Compact tool sheet for the system prompt.
  const definitions = `
TOOLS — you can LOOK UP live data before answering. To call a tool, reply with ONLY this JSON on a single line (no other text):
{"tool":"<name>","args":{...}}
You will receive a TOOL_RESULT message; then answer the user using it. Call at most 3 tools per question. Available tools:
- search_houses {query?, region?, area?, max_price?, min_bedrooms?, type?, listing?("rent"|"sale")} — live house listings
- search_services {query?, category?, region?, area?} — daily-service providers (fundi, cleaning, …)
- search_trucks {query?, region?, size?} — moving trucks
- search_jobs {query?, region?} — open day jobs (vibarua)
- locate_place {query} — resolve a place description to a map point
Use tools whenever the user asks about specific listings, providers, jobs, routes, prices or places — do not answer such questions from memory. Results are everything a public visitor may see; if a tool returns nothing, say so honestly.`;

  // Detect a tool call in a model reply. Accepts the bare JSON line or a
  // fenced block around it; everything else means "no call".
  function parse(reply) {
    const m = String(reply || "").match(/\{\s*"tool"\s*:\s*"([a-z_]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (!m) return null;
    if (!TOOLS[m[1]]) return null;
    let args = {};
    try { args = JSON.parse(m[2]); } catch { return null; }
    return { name: m[1], args };
  }

  async function run(name, args) {
    if (!TOOLS[name]) return { error: "unknown tool" };
    try {
      const r = await TOOLS[name](args && typeof args === "object" ? args : {});
      // Hard cap the payload so a tool can never flood the conversation.
      if (JSON.stringify(r).length > 4000 && Array.isArray(r.results)) {
        r.results = r.results.slice(0, 3);
        r.truncated = true;
      }
      return r;
    } catch (e) {
      console.warn("[ai-tools]", name, e);
      return { error: "lookup failed" };
    }
  }

  window.AITools = { definitions, parse, run, MAX_TOOL_ROUNDS: 3 };
})();

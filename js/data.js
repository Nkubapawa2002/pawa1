// =====================================================
// Data layer
// Uses Supabase if configured, falls back to local JSON.
// =====================================================

(function () {
  const cfg = window.APP_CONFIG || {};
  const hasSupabase = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase;
  let sb = null;
  if (hasSupabase) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    window.SB = sb;
  }

  const cache = {};

  // -------- Generic JSON loader (fallback) --------
  async function loadJSON(name) {
    if (cache[name]) return cache[name];
    const res = await fetch(`data/${name}.json`);
    if (!res.ok) throw new Error(`Missing data/${name}.json`);
    cache[name] = await res.json();
    return cache[name];
  }

  // -------- Read-through cache (browser-side stand-in for Redis) --------
  // Two-tier: in-memory Map for sub-ms hits within a page lifetime, plus
  // localStorage so a reload still skips the round-trip until TTL expires.
  // Each entry is {v, exp} where exp is epoch ms. Anything past exp is
  // treated as a miss and the caller refetches. Writes invalidate the
  // matching key so mutations show up immediately in the same session.
  const KCACHE_PREFIX = "pawa_cache:";
  const mem = new Map();

  function kcacheGet(key) {
    // Memory first
    const hit = mem.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    if (hit) mem.delete(key);
    // Then storage
    try {
      const raw = localStorage.getItem(KCACHE_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.exp <= Date.now()) {
        localStorage.removeItem(KCACHE_PREFIX + key);
        return null;
      }
      mem.set(key, parsed);   // promote to memory
      return parsed.v;
    } catch { return null; }
  }

  function kcacheSet(key, val, ttlMs) {
    const entry = { v: val, exp: Date.now() + ttlMs };
    mem.set(key, entry);
    try { localStorage.setItem(KCACHE_PREFIX + key, JSON.stringify(entry)); } catch {}
  }

  function kcacheInvalidate(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      mem.delete(k);
      try { localStorage.removeItem(KCACHE_PREFIX + k); } catch {}
    }
  }

  function kcacheClear() {
    mem.clear();
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(KCACHE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  // Wraps an async fetcher with cache. Pass {fresh: true} on the caller to
  // force a network round-trip and refresh the cache.
  async function cached(key, ttlMs, fetcher, opts = {}) {
    if (!opts.fresh) {
      const hit = kcacheGet(key);
      if (hit !== null) return hit;
    }
    const val = await fetcher();
    kcacheSet(key, val, ttlMs);
    return val;
  }

  // TTLs — tune here, not at every call site.
  const TTL = {
    regions:  24 * 60 * 60 * 1000,   // 1 day — almost never changes
    buses:         5 * 60 * 1000,    // 5 min
    agents:        5 * 60 * 1000,    // 5 min
    houses:        2 * 60 * 1000     // 2 min — listings churn faster
  };

  // -------- Mappers (DB -> UI shape) --------
  const mapShipment = (r) => ({
    tracking_code: r.tracking_code,
    sender: { name: r.sender_name, phone: r.sender_phone, region: r.sender_region },
    receiver: { name: r.receiver_name, phone: r.receiver_phone, region: r.receiver_region },
    product: {
      description: r.product_description,
      weight_kg: Number(r.product_weight_kg),
      value_tzs: Number(r.product_value_tzs || 0),
      insured: r.insured !== false
    },
    bus: { name: r.bus_name, route: r.bus_route, departure: r.bus_departure },
    agent_origin: { name: r.agent_origin_name, phone: r.agent_origin_phone },
    agent_destination: { name: r.agent_destination_name, phone: r.agent_destination_phone },
    status: r.status,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at
  });

  const reverseShipment = (s) => ({
    tracking_code: s.tracking_code,
    sender_name: s.sender.name,
    sender_phone: s.sender.phone,
    sender_region: s.sender.region,
    receiver_name: s.receiver.name,
    receiver_phone: s.receiver.phone,
    receiver_region: s.receiver.region,
    product_description: s.product.description,
    product_weight_kg: s.product.weight_kg,
    product_size_category: s.product.size_category || "medium",
    product_freight_fee: s.product.freight_fee || 0,
    product_suggested_fee: s.product.suggested_fee || 0,
    product_value_tzs: s.product.value_tzs || 0,
    insured: s.product.insured !== false,
    bus_name: s.bus.name,
    bus_route: s.bus.route,
    bus_departure: s.bus.departure,
    agent_origin_name: s.agent_origin?.name || null,
    agent_origin_phone: s.agent_origin?.phone || null,
    agent_destination_name: s.agent_destination?.name || null,
    agent_destination_phone: s.agent_destination?.phone || null,
    status: s.status || "Awaiting Price",
    notes: s.notes || null
  });

  // -------- Public API --------
  window.DataStore = {
    isOnline: !!sb,
    sb,

    busPhotoUrl(path) {
      if (!path) return "";
      if (path.startsWith("http")) return path;
      if (!sb) return `data/${path}`;
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.BUS_PHOTOS_BUCKET) || "bus-photos";
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    },

    agentPhotoUrl(path) {
      if (!path) return "";
      if (path.startsWith("http")) return path;
      if (!sb) return `data/${path}`;
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.AGENT_PHOTOS_BUCKET) || "agent-photos";
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    },

    // ---------- contacts helpers ----------
    cleanPhone(p) { return (p || "").replace(/\s/g, ""); },

    waLink(p) { return "https://wa.me/" + this.cleanPhone(p).replace(/^\+/, ""); },

    // Shared SVG icons for the Call / WhatsApp buttons.
    _phoneIconSvg() {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.35 2 2 0 0 1 3.6 1.13h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.73a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16z"/></svg>`;
    },
    _waIconSvg() {
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.08-.13-.27-.2-.57-.35"/></svg>`;
    },

    // Build the Call + WhatsApp button group for a single number.
    // Used by every contact-rendering helper so the UX is consistent across
    // the site (bus directory, agent directory, dashboards, etc.).
    renderCallButtons(num, opts = {}) {
      const clean = this.cleanPhone(num);
      const showWa = opts.whatsapp !== false;
      const callLabel = (window.t && window.t("action_call")) || "Call";
      const waLabel   = (window.t && window.t("action_whatsapp")) || "WhatsApp";
      const callBtn = `<a href="tel:${clean}" class="btn btn-call btn-xs" title="${callLabel} ${num}" aria-label="${callLabel} ${num}">${this._phoneIconSvg()}<span>${callLabel}</span></a>`;
      const waBtn = showWa
        ? `<a href="${this.waLink(num)}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-xs" title="${waLabel}" aria-label="${waLabel}">${this._waIconSvg()}<span>${waLabel}</span></a>`
        : "";
      return callBtn + waBtn;
    },

    // Render an array of {label, number, whatsapp} into a contact list with
    // visible Call + WhatsApp buttons for every entry.
    renderContacts(contacts, opts = {}) {
      if (!Array.isArray(contacts) || !contacts.length) return "";
      const showLabels = opts.showLabels !== false;
      return `<ul class="phone-list">${contacts.map(c => {
        const num = c.number || "";
        if (!num) return "";
        const lbl = showLabels && c.label ? `<span class="phone-label">${c.label}</span>` : "";
        return `<li>
          ${lbl}
          <a class="phone-num" href="tel:${this.cleanPhone(num)}">${num}</a>
          <span class="phone-actions">${this.renderCallButtons(num, { whatsapp: c.whatsapp !== false })}</span>
        </li>`;
      }).join("")}</ul>`;
    },

    // For agents — phones is text[] (no labels). Assume WhatsApp on the first.
    renderAgentPhones(phones) {
      if (!Array.isArray(phones) || !phones.length) return "";
      return `<ul class="phone-list">${phones.map((num, i) => `
        <li>
          <a class="phone-num" href="tel:${this.cleanPhone(num)}">${num}</a>
          <span class="phone-actions">${this.renderCallButtons(num, { whatsapp: true })}</span>
          ${i === 0 ? `<span class="phone-label">primary</span>` : ""}
        </li>`).join("")}</ul>`;
    },

    // Match a search query against multiple phone forms (with/without spaces, country code).
    phoneMatchesAny(phones, q) {
      const norm = (s) => (s || "").replace(/\s|-/g, "");
      const needle = norm(q).toLowerCase();
      if (!needle) return false;
      return (phones || []).some(p => norm(p).toLowerCase().includes(needle));
    },

    // Regions
    async getRegions(opts = {}) {
      return cached("regions", TTL.regions, async () => {
        if (sb) {
          const { data, error } = await sb.from("regions").select("name").order("name");
          if (error) throw error;
          return data.map(r => r.name);
        }
        return loadJSON("regions");
      }, opts);
    },

    // Buses
    async getBuses(opts = {}) {
      return cached("buses", TTL.buses, async () => {
        if (sb) {
          const { data, error } = await sb.from("buses").select("*").order("name");
          if (error) throw error;
          return data;
        }
        return loadJSON("buses");
      }, opts);
    },

    // Agents
    async getAgents(opts = {}) {
      return cached("agents", TTL.agents, async () => {
        if (sb) {
          const { data, error } = await sb.from("agents").select("*").order("region");
          if (error) throw error;
          return data;
        }
        return loadJSON("agents");
      }, opts);
    },

    // Houses — public property listings (House Booking TZ). Tries Supabase
    // first, but falls back to data/houses.json if the table is missing
    // (e.g. the SQL in supabase/schema_master.sql hasn't been applied
    // yet). That way the page always works for visitors.
    async getHouses(opts = {}) {
      return cached("houses", TTL.houses, async () => {
        if (sb) {
          try {
            const { data, error } = await sb.from("houses").select("*").order("created_at", { ascending: false });
            if (error) throw error;
            if (Array.isArray(data) && data.length) return data;
          } catch (e) {
            console.warn("[houses] Supabase query failed, falling back to JSON:", e?.message || e);
          }
        }
        return loadJSON("houses");
      }, opts);
    },

    // Trucks — public moving-truck listings (the "move my goods to the new
    // home" companion to houses). Same pattern as getHouses: Supabase first,
    // falling back to data/trucks.json when the table isn't applied yet.
    async getTrucks(opts = {}) {
      return cached("trucks", TTL.houses, async () => {
        if (sb) {
          try {
            const { data, error } = await sb.from("trucks").select("*").order("created_at", { ascending: false });
            if (error) throw error;
            if (Array.isArray(data) && data.length) return data;
          } catch (e) {
            console.warn("[trucks] Supabase query failed, falling back to JSON:", e?.message || e);
          }
        }
        return loadJSON("trucks");
      }, opts);
    },

    // Manual cache controls — admin pages can call these after a write
    // so the next read goes straight to Postgres instead of returning stale.
    invalidateCache(keys) { kcacheInvalidate(keys); },
    clearCache() { kcacheClear(); },

    housePhotoUrl(path) {
      if (!path) return "";
      if (path.startsWith("http") || path.startsWith("data/")) return path;
      if (!sb) return `data/${path}`;
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.HOUSE_PHOTOS_BUCKET) || "house-photos";
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    },

    truckPhotoUrl(path) {
      if (!path) return "";
      if (path.startsWith("http") || path.startsWith("data/")) return path;
      if (!sb) return `data/${path}`;
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.TRUCK_PHOTOS_BUCKET) || "truck-photos";
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    },

    // Shipments
    async getShipments() {
      if (sb) {
        const { data, error } = await sb.from("shipments").select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        return data.map(mapShipment);
      }
      const seed = await loadJSON("shipments");
      const local = JSON.parse(localStorage.getItem("shipments_local") || "[]");
      const overrides = JSON.parse(localStorage.getItem("shipment_overrides") || "{}");
      return [...local, ...seed].map(s => overrides[s.tracking_code]
        ? { ...s, ...overrides[s.tracking_code] } : s);
    },

    async findShipment(code) {
      if (sb) {
        const { data, error } = await sb.from("shipments").select("*")
          .ilike("tracking_code", code).maybeSingle();
        if (error) throw error;
        return data ? mapShipment(data) : null;
      }
      const all = await this.getShipments();
      return all.find(s => s.tracking_code.toLowerCase() === code.toLowerCase()) || null;
    },

    async findShipmentsByPhone(phone, role) {
      // role: 'sender' | 'receiver'
      // `phone` may be a single value, a comma/space-separated list of phones,
      // or a name. We split on commas/semicolons and OR every term.
      const col = role === "sender" ? "sender_phone" : "receiver_phone";
      const nameCol = role === "sender" ? "sender_name" : "receiver_name";
      const terms = phone.split(/[,;]/).map(s => s.trim()).filter(Boolean);
      if (!terms.length) return [];
      if (sb) {
        const ors = terms.flatMap(t => [
          `${col}.ilike.%${t}%`,
          `${nameCol}.ilike.%${t}%`
        ]).join(",");
        const { data, error } = await sb.from("shipments").select("*")
          .or(ors)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return data.map(mapShipment);
      }
      const all = await this.getShipments();
      return all.filter(s => {
        const p = role === "sender" ? s.sender : s.receiver;
        const phoneNorm = (p.phone || "").replace(/\s/g, "");
        return terms.some(t => {
          const tNorm = t.replace(/\s/g, "");
          return phoneNorm.includes(tNorm) || (p.name || "").toLowerCase().includes(t.toLowerCase());
        });
      });
    },

    async createShipment(s) {
      if (sb) {
        const { error } = await sb.from("pending_changes").insert({
          entity_type:  "shipment",
          action:       "insert",
          entity_id:    s.tracking_code,
          payload:      reverseShipment(s),
          requested_by: `${s.sender.name} / ${s.sender.phone}`
        });
        if (error) throw error;
        return s;
      }
      // Offline fallback — no approval gate in local mode
      const local = JSON.parse(localStorage.getItem("shipments_local") || "[]");
      local.unshift(s);
      localStorage.setItem("shipments_local", JSON.stringify(local));
      return s;
    },

    async updateShipmentStatus(code, status) {
      if (sb) {
        const { error } = await sb.from("shipments").update({ status }).eq("tracking_code", code);
        if (error) throw error;
        return true;
      }
      const overrides = JSON.parse(localStorage.getItem("shipment_overrides") || "{}");
      overrides[code] = { ...(overrides[code] || {}), status };
      localStorage.setItem("shipment_overrides", JSON.stringify(overrides));
      return true;
    },

    // Public tracking-chat confirmation (Arrived / Delivered). Direct table
    // UPDATE is now restricted to admins + the assigned signed-in agent, so the
    // public confirm buttons go through the narrow confirm_shipment_status RPC.
    async confirmShipmentStatus(code, status) {
      if (sb) {
        const { error } = await sb.rpc("confirm_shipment_status", { p_code: code, p_status: status });
        if (error) throw error;
        return true;
      }
      const overrides = JSON.parse(localStorage.getItem("shipment_overrides") || "{}");
      overrides[code] = { ...(overrides[code] || {}), status };
      localStorage.setItem("shipment_overrides", JSON.stringify(overrides));
      return true;
    },

    // Messages thread
    async getMessages(code) {
      if (sb) {
        const { data, error } = await sb.from("shipment_messages").select("*")
          .eq("tracking_code", code).order("created_at");
        if (error) throw error;
        return data;
      }
      const all = JSON.parse(localStorage.getItem("messages_" + code) || "[]");
      return all;
    },

    async addMessage(code, fromRole, fromName, message) {
      const row = { tracking_code: code, from_role: fromRole, from_name: fromName, message };
      if (sb) {
        const { error } = await sb.from("shipment_messages").insert(row);
        if (error) throw error;
        return true;
      }
      const all = JSON.parse(localStorage.getItem("messages_" + code) || "[]");
      all.push({ ...row, id: Date.now(), created_at: new Date().toISOString() });
      localStorage.setItem("messages_" + code, JSON.stringify(all));
      return true;
    },

    // Realtime subscriptions (Supabase only)
    subscribeShipment(code, callback) {
      if (!sb) return { unsubscribe() {} };
      const channel = sb.channel("shipment_" + code)
        .on("postgres_changes", {
          event: "*", schema: "public", table: "shipments",
          filter: `tracking_code=eq.${code}`
        }, callback)
        .subscribe();
      return channel;
    },

    subscribeMessages(code, callback) {
      if (!sb) return { unsubscribe() {} };
      const channel = sb.channel("messages_" + code)
        .on("postgres_changes", {
          event: "INSERT", schema: "public", table: "shipment_messages",
          filter: `tracking_code=eq.${code}`
        }, callback)
        .subscribe();
      return channel;
    },

    // Helpers
    // Server-side generator (RPC) guarantees uniqueness via a Postgres sequence;
    // if it's available we trust it. Otherwise we fall back to the client-side
    // algorithm in js/tracking-id.js, which is collision-resistant by design
    // (32^4 random suffix per ms + Damm check digit).
    async generateTrackingCode(originRegion, destRegion) {
      if (sb) {
        const { data, error } = await sb.rpc("generate_tracking_code", {
          p_origin: originRegion,
          p_dest:   destRegion
        });
        if (!error && data) return data;
      }
      if (window.TrackingID?.generate) {
        return window.TrackingID.generate({ origin: originRegion, destination: destRegion });
      }
      // Last-resort fallback if tracking-id.js wasn't loaded
      const code = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "XXX";
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const seq  = String(Math.floor(Math.random() * 9000) + 1000);
      return `TZ-${code(originRegion)}-${code(destRegion)}-${date}-${seq}`;
    },

    findBusesForRoute(buses, from, to) {
      return buses.filter(b => (b.routes || []).some(r =>
        r.from?.toLowerCase() === from.toLowerCase() &&
        r.to?.toLowerCase() === to.toLowerCase()
      ));
    },

    findAgentsByRegion(agents, region) {
      return agents.filter(a => a.region?.toLowerCase() === region.toLowerCase());
    },

    clearLocal() {
      localStorage.removeItem("shipments_local");
      localStorage.removeItem("shipment_overrides");
      Object.keys(localStorage).filter(k => k.startsWith("messages_"))
        .forEach(k => localStorage.removeItem(k));
    }
  };
})();

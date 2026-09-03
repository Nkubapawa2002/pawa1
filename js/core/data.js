// =====================================================
// Data layer
// Uses Supabase if configured, falls back to local JSON.
// =====================================================

// Global HTML-escape helper. Use it on ANY user-controlled value before
// interpolating into innerHTML / template strings, to prevent stored XSS
// (listing names, agent profiles, messages, etc. all come from untrusted users).
window.escHtml = function (v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
};

// Returns the URL only if it uses a safe scheme, else "". Use for any
// user-supplied link (listing website, etc.) before putting it in an href,
// so a `javascript:` / `data:` URL can't run script on click.
window.safeUrl = function (u) {
  const s = String(u == null ? "" : u).trim();
  if (/^https?:\/\//i.test(s) || /^(mailto:|tel:)/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return "https://" + s; // bare domain
  return "";
};

(function () {
  const cfg = window.APP_CONFIG || {};
  const hasSupabase = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase;
  let sb = null;
  if (hasSupabase) {
    const opts = {};
    // Clerk third-party auth: attach Clerk's session token to every request so
    // Supabase RLS resolves the Clerk user. The function is called lazily per
    // request, so it works even though Clerk finishes loading after this runs
    // (returns null → anonymous, which is correct for public reads). NOTE:
    // supabase-js disables its own sb.auth.* methods when accessToken is set,
    // so we only enable this in Clerk mode.
    if (window.CLERK_ENABLED) {
      const tpl = cfg.CLERK_JWT_TEMPLATE || null;  // adds role+email claims for RLS
      opts.accessToken = async () => {
        try {
          const c = window.Clerk;
          if (c && c.session) return (await c.session.getToken(tpl ? { template: tpl } : undefined)) || null;
        } catch (_) {}
        return null;
      };
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, opts);
    window.SB = sb;

    // In Clerk mode, supabase-js THROWS on ANY sb.auth.* access (because the
    // accessToken option is set). The whole app calls sb.auth.* (~40 sites:
    // agent portals, login, dashboards), so we install ONE durable Clerk-backed
    // sb.auth here. It is the single source of truth (auth-clerk.js no longer
    // swaps sb.auth) and delegates the interactive methods to window.Auth (the
    // Clerk facade auth-clerk.js installs), so login/sign-up/reset code flows are
    // handled in one place. Reads + the auth-state listener wait for Clerk to
    // finish loading, so any page reading the session at load gets the REAL one.
    if (window.CLERK_ENABLED) {
      let _readyResolve;
      const _clerkReady = new Promise((res) => { _readyResolve = res; });
      window.addEventListener("clerk-ready", () => _readyResolve(), { once: true });
      setTimeout(() => _readyResolve(), 8000);   // never hang if Clerk fails to load
      const _mapClerk = () => {
        const c = window.Clerk;
        if (!c || !c.user || !c.session) return null;
        let email = "";
        try { email = c.user.primaryEmailAddress ? c.user.primaryEmailAddress.emailAddress : ""; } catch (_) {}
        return { user: { id: c.user.id, email: email }, clerk: true };
      };
      // Delegate to the Clerk facade (window.Auth = ClerkAuth) at call time, so
      // we always hit the real implementation once auth-clerk.js has loaded.
      const A = () => window.Auth || {};
      const shim = {
        getSession: async () => { await _clerkReady; return { data: { session: _mapClerk() }, error: null }; },
        getUser:    async () => { await _clerkReady; const s = _mapClerk(); return { data: { user: s ? s.user : null }, error: null }; },
        // Fire on load AND on every subsequent Clerk auth change (durable), so a
        // page that subscribed before Clerk finished loading still gets routed
        // after a later sign-in / sign-out.
        onAuthStateChange: (cb) => {
          let off = null;
          _clerkReady.then(() => {
            const fire = () => { try { cb(window.Clerk && window.Clerk.session ? "SIGNED_IN" : "SIGNED_OUT", _mapClerk()); } catch (_) {} };
            fire();
            try { const u = window.Clerk && window.Clerk.addListener(fire); if (typeof u === "function") off = u; } catch (_) {}
          });
          return { data: { subscription: { unsubscribe: () => { try { off && off(); } catch (_) {} } } } };
        },
        signInWithPassword: async (a) => { try { const s = await A().signIn(a.email, a.password); return { data: { user: s && s.user, session: s }, error: null }; } catch (e) { return { data: { user: null, session: null }, error: e }; } },
        signUp:             async (a) => { try { const s = await A().signUp(a.email, a.password); return { data: { user: s && s.user, session: s }, error: null }; } catch (e) { return { data: { user: null, session: null }, error: e }; } },
        signOut:            async () => { try { await A().signOut(); } catch (_) {} return { error: null }; },
        resend:             async () => ({ data: {}, error: null }),   // Clerk emails its own codes
        updateUser:         async () => ({ data: { user: null }, error: new Error("Manage your account in Clerk.") }),
        resetPasswordForEmail: async (email) => { try { if (A().resetPassword) { await A().resetPassword(email); return { data: {}, error: null }; } return { data: {}, error: new Error("Password reset is handled by Clerk.") }; } catch (e) { return { data: {}, error: e }; } },
      };
      try {
        sb.auth = shim;
        if (sb.auth !== shim) Object.defineProperty(sb, "auth", { value: shim, writable: true, configurable: true });
      } catch (_) {
        try { Object.defineProperty(sb, "auth", { value: shim, writable: true, configurable: true }); } catch (__) {}
      }
    }
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

  // Reads the ENTRY, expired or not, and lets the caller decide. kcacheGet()
  // below keeps the old "expired is a miss" contract; the stale-while-
  // revalidate path needs to see the expired value, which is why the eviction
  // no longer happens inside the read. An entry that is merely expired is
  // still an answer; it is only rubbish once it is past the hard limit.
  function kcacheEntry(key) {
    const hit = mem.get(key);
    if (hit) return hit;
    try {
      const raw = localStorage.getItem(KCACHE_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.exp !== "number") return null;
      mem.set(key, parsed);   // promote to memory
      return parsed;
    } catch { return null; }
  }

  function kcacheGet(key) {
    const e = kcacheEntry(key);
    if (!e) return null;
    if (e.exp > Date.now()) return e.v;
    return null;
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
      // A flight started BEFORE the write would otherwise land afterwards and
      // put the pre-write value back. Dropping it here means the next reader
      // starts a new request instead of joining a stale one.
      inflight.delete(k);
      try { localStorage.removeItem(KCACHE_PREFIX + k); } catch {}
    }
  }

  function kcacheClear() {
    mem.clear();
    inflight.clear();
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(KCACHE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  // ---- the request layer --------------------------------------------------
  //
  // Three things sit between a caller and the network, and each exists because
  // of a measured fault rather than a theory.
  //
  // 1. SINGLE FLIGHT. The old cached() read the cache, missed, and awaited the
  //    fetcher. Nothing is written until that fetcher RESOLVES, so two
  //    components asking the same question in the same tick both missed and
  //    both went to the network. Measured on index.html: the identical houses
  //    query, twice, plus four /rest/v1/houses calls on one page load. Every
  //    caller now joins the promise that is already running, so N callers cost
  //    one request. This is the whole fix for the stampede and it cannot serve
  //    anything stale: everybody gets the same fresh answer.
  //
  // 2. STALE WHILE REVALIDATE. A miss used to block the UI on the network. An
  //    entry that is past its TTL but inside HARD_STALE is returned at once and
  //    refreshed in the background, so the second visit to a page paints
  //    immediately and corrects itself. Past HARD_STALE it is not served: a
  //    listing from yesterday is worse than a spinner.
  //
  // 3. FAILURES ARE NOT CACHED. A rejected fetch clears the flight and leaves
  //    the old value alone, so the next caller retries rather than inheriting
  //    an error for the length of a TTL. Every waiter on that flight rejects
  //    together, which is what they would have done individually anyway.
  //
  // The map is keyed by the same string the cache is, so "the request that is
  // running" and "the value that was stored" can never drift apart.
  const inflight = new Map();

  // How far past its TTL an entry may still be SERVED while the refresh runs.
  // Deliberately a multiple of the TTL rather than a constant: a key that is
  // allowed to be two minutes old can be served at four, and one that is
  // allowed to be a day old is not suddenly served at a day plus two minutes.
  const HARD_STALE = 2;

  function flight(key, ttlMs, fetcher) {
    const running = inflight.get(key);
    if (running) return running;
    const p = Promise.resolve()
      .then(fetcher)
      .then((val) => { kcacheSet(key, val, ttlMs); return val; })
      .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  // Wraps an async fetcher with cache. {fresh: true} skips the READ but still
  // joins the flight, so three components all asking for fresh data at once is
  // still one request. {swr: false} opts out of being served a stale value.
  async function cached(key, ttlMs, fetcher, opts = {}) {
    if (!opts.fresh) {
      const hit = kcacheGet(key);
      if (hit !== null) return hit;

      if (opts.swr !== false) {
        const e = kcacheEntry(key);
        if (e && Date.now() < e.exp + ttlMs * HARD_STALE) {
          // Kick the refresh off and DO NOT await it. The catch is required:
          // an unhandled rejection here would be a background refresh taking
          // down a page that already had its answer.
          flight(key, ttlMs, fetcher).catch(() => {});
          return e.v;
        }
      }
    }
    return flight(key, ttlMs, fetcher);
  }

  // TTLs — tune here, not at every call site.
  const TTL = {
    regions:  24 * 60 * 60 * 1000,   // 1 day — almost never changes
    houses:        2 * 60 * 1000     // 2 min — listings churn faster
  };

  // -------- Public API --------
  window.DataStore = {
    isOnline: !!sb,
    sb,

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
    // the site (house listings, agent directory, dashboards, etc.).
    renderCallButtons(num, opts = {}) {
      // Phone is user-controlled (agent/provider registration). Restrict the
      // href to digits/+ and HTML-escape the displayed number so a value like
      // `" onerror=…` can't break out of the attribute (stored XSS).
      const tel = this.cleanPhone(num).replace(/[^\d+]/g, "");
      const numSafe = window.escHtml(num);
      const showWa = opts.whatsapp !== false;
      const callLabel = (window.t && window.t("action_call")) || "Call";
      const waLabel   = (window.t && window.t("action_whatsapp")) || "WhatsApp";
      const callBtn = `<a href="tel:${tel}" class="btn btn-call btn-xs" title="${callLabel} ${numSafe}" aria-label="${callLabel} ${numSafe}">${this._phoneIconSvg()}<span>${callLabel}</span></a>`;
      const waBtn = showWa
        ? `<a href="https://wa.me/${tel.replace(/^\+/, "")}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-xs" title="${waLabel}" aria-label="${waLabel}">${this._waIconSvg()}<span>${waLabel}</span></a>`
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
        const lbl = showLabels && c.label ? `<span class="phone-label">${window.escHtml(c.label)}</span>` : "";
        return `<li>
          ${lbl}
          <a class="phone-num" href="tel:${this.cleanPhone(num).replace(/[^\d+]/g, "")}">${window.escHtml(num)}</a>
          <span class="phone-actions">${this.renderCallButtons(num, { whatsapp: c.whatsapp !== false })}</span>
        </li>`;
      }).join("")}</ul>`;
    },

    // For agents — phones is text[] (no labels). Assume WhatsApp on the first.
    renderAgentPhones(phones) {
      if (!Array.isArray(phones) || !phones.length) return "";
      return `<ul class="phone-list">${phones.map((num, i) => `
        <li>
          <a class="phone-num" href="tel:${this.cleanPhone(num).replace(/[^\d+]/g, "")}">${window.escHtml(num)}</a>
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

    // Houses — public property listings (House Booking TZ). Tries Supabase
    // first, but falls back to data/houses.json if the table is missing
    // (e.g. the SQL in supabase/schema/schema_master.sql hasn't been applied
    // yet). That way the page always works for visitors.
    async getHouses(opts = {}) {
      return cached("houses", TTL.houses, async () => {
        if (sb) {
          try {
            // Listings live 15 days from the day posted (see supabase/features/house/house_media_ttl.sql).
            // A daily cron purges expired rows + their media; this filter hides any
            // that are already past 15 days in the window before the sweep runs.
            const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await sb.from("houses").select("*")
              .gte("created_at", cutoff)
              .order("created_at", { ascending: false });
            if (error) throw error;
            // Trust a successful query even when it returns zero rows — an empty
            // directory (e.g. every owner deactivated/suspended) is a real state,
            // NOT a reason to show the bundled demo seed. The JSON fallback below
            // is only for when the table is missing / the request errors.
            if (Array.isArray(data)) return data;
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
            // Trust a successful query even when empty (see getHouses note).
            if (Array.isArray(data)) return data;
          } catch (e) {
            console.warn("[trucks] Supabase query failed, falling back to JSON:", e?.message || e);
          }
        }
        return loadJSON("trucks");
      }, opts);
    },

    // Services — public daily-services marketplace listings (cleaning,
    // plumbing, electrical, etc.). Same pattern as getTrucks: Supabase first,
    // falling back to data/services.json when the table isn't applied yet.
    async getServices(opts = {}) {
      return cached("services", TTL.houses, async () => {
        if (sb) {
          try {
            const { data, error } = await sb.from("services").select("*").order("created_at", { ascending: false });
            if (error) throw error;
            // Trust a successful query even when empty (see getHouses note).
            if (Array.isArray(data)) return data;
          } catch (e) {
            console.warn("[services] Supabase query failed, falling back to JSON:", e?.message || e);
          }
        }
        return loadJSON("services");
      }, opts);
    },

    // Day jobs — short-lived casual work posts (jobs.html). Unlike houses /
    // trucks / services there is NO bundled JSON seed: a day job is worthless
    // the moment it is stale, so an offline visitor gets an empty list rather
    // than demo work that no longer exists.
    //
    // Only open, unexpired posts. The `expires_at` filter matters because the
    // status column is moved to 'expired' by a cron — between sweeps a row can
    // still say 'open' while its date has passed.
    async getDayJobs(opts = {}) {
      return cached("day_jobs", TTL.houses, async () => {
        if (!sb) return [];
        // A failed query THROWS rather than returning []. Callers that merge
        // several catalogues (js/lib/explore-index.js) need to tell "nobody is
        // hiring today" apart from "the table is missing" — collapsing both to
        // an empty array would quietly present an outage as an answer.
        const { data, error } = await sb.from("day_jobs").select("*")
          .eq("status", "open")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false });
        if (error) throw error;
        return Array.isArray(data) ? data : [];
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

    servicePhotoUrl(path) {
      if (!path) return "";
      if (path.startsWith("http") || path.startsWith("data/")) return path;
      if (!sb) return `data/${path}`;
      const bucket = (window.APP_CONFIG && window.APP_CONFIG.SERVICE_PHOTOS_BUCKET) || "service-photos";
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    }
  };
})();

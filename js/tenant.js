// =====================================================
// Tenant resolver — figures out which tenant context the
// current page is operating under, and exposes:
//   window.PAWA_TENANT  → { id, slug, display_name, branding, ... } | null
//   window.tenantId()   → uuid or null
//   window.tenantSlug() → slug or null
//   window.tenantQuery(table) → sb.from(table) with tenant_id filter
//
// Resolution order:
//   1. ?tenant=<slug> URL parameter (explicit)
//   2. Authed user's tenant_users membership (if exactly one)
//   3. localStorage.PAWA_TENANT_SLUG (last selected)
//   4. The 'bus-tz-pawa' demo tenant (Phase 1 fallback)
// =====================================================

(function () {
  const DEMO_SLUG = "bus-tz-pawa";
  const STORAGE_KEY = "PAWA_TENANT_SLUG";

  function readUrlSlug() {
    try {
      const u = new URL(location.href);
      // Support both ?tenant=foo and pathname /t/foo/...
      const q = u.searchParams.get("tenant");
      if (q) return q.toLowerCase();
      const m = u.pathname.match(/\/t\/([a-z0-9][a-z0-9-]+)(?:\/|$)/i);
      if (m) return m[1].toLowerCase();
      return null;
    } catch { return null; }
  }

  async function resolveTenant() {
    const sb = window.SB;
    const urlSlug = readUrlSlug();
    let candidateSlug = urlSlug || localStorage.getItem(STORAGE_KEY) || null;

    // If the user is signed in, prefer their actual membership(s).
    let memberships = [];
    if (sb) {
      try {
        const { data: session } = await sb.auth.getSession();
        if (session?.session?.user) {
          const { data, error } = await sb
            .from("tenant_users")
            .select("tenant_id, role, tenants ( id, slug, display_name, status )")
            .eq("user_id", session.session.user.id);
          if (!error && Array.isArray(data)) memberships = data;
        }
      } catch { /* offline; fall through */ }
    }

    // If URL specifies a slug, prefer it (but only if user is a member or super-admin).
    if (urlSlug) {
      const m = memberships.find(x => x.tenants?.slug === urlSlug);
      if (m) return shapeTenant(m.tenants);
      // For unauthenticated browsing of a tenant page (e.g. their public booking widget)
      // fall through to fetch the tenant by slug below.
    }

    // Single membership → automatic.
    if (!urlSlug && memberships.length === 1) {
      candidateSlug = memberships[0].tenants?.slug || null;
    }

    // Fetch by slug (RLS allows reading active tenants the user belongs to;
    // for demo tenant or public-facing pages, anonymous read is permitted by
    // policy "tenant members read" if super-admin, OR we tolerate failure
    // and fall back to demo).
    if (sb && candidateSlug) {
      const { data, error } = await sb
        .from("tenants")
        .select("id, slug, display_name, status, contact_email, country")
        .eq("slug", candidateSlug)
        .maybeSingle();
      if (!error && data) return shapeTenant(data);
    }

    // Last resort: demo tenant for legacy pages.
    if (sb) {
      const { data } = await sb
        .from("tenants")
        .select("id, slug, display_name, status, contact_email, country")
        .eq("slug", DEMO_SLUG)
        .maybeSingle();
      if (data) return shapeTenant(data);
    }

    return null;
  }

  async function loadBranding(tenantId) {
    const sb = window.SB;
    if (!sb || !tenantId) return null;
    const { data } = await sb
      .from("tenant_settings")
      .select("branding, languages, default_language, anthropic_model, vapi_assistant_id, vapi_phone_number_id, at_sender_id, at_whatsapp_number")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return data || null;
  }

  function shapeTenant(t) {
    return {
      id:           t.id,
      slug:         t.slug,
      display_name: t.display_name,
      status:       t.status,
      contact_email: t.contact_email,
      country:       t.country
    };
  }

  function applyBranding(branding) {
    if (!branding) return;
    if (branding.primary_color) {
      document.documentElement.style.setProperty("--brand-primary", branding.primary_color);
    }
    if (branding.company_name_display) {
      document.querySelectorAll("[data-tenant-name]").forEach(el => {
        el.textContent = branding.company_name_display;
      });
    }
    if (branding.logo_url) {
      document.querySelectorAll("[data-tenant-logo]").forEach(el => {
        if (el.tagName === "IMG") el.src = branding.logo_url;
      });
    }
  }

  // Tenant-aware query helper. Drop-in replacement for sb.from(table) when
  // you want every read filtered by the active tenant.
  function tenantQuery(table) {
    const sb = window.SB;
    const t  = window.PAWA_TENANT;
    if (!sb) throw new Error("Supabase not initialised");
    if (!t) throw new Error("No active tenant");
    const q = sb.from(table);
    // Make subsequent .select / .insert / .update / .delete tenant-scoped.
    return new Proxy(q, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig !== "function") return orig;
        if (prop === "select") {
          return (...args) => target.select(...args).eq("tenant_id", t.id);
        }
        if (prop === "update" || prop === "delete") {
          return (...args) => orig.apply(target, args).eq("tenant_id", t.id);
        }
        if (prop === "insert" || prop === "upsert") {
          return (rows, options) => {
            const inject = (r) => Object.assign({ tenant_id: t.id }, r);
            const stamped = Array.isArray(rows) ? rows.map(inject) : inject(rows);
            return orig.call(target, stamped, options);
          };
        }
        return orig.bind(target);
      }
    });
  }

  // Bootstrap on page load.
  window.PAWA_TENANT = null;
  window.tenantId   = () => window.PAWA_TENANT?.id || null;
  window.tenantSlug = () => window.PAWA_TENANT?.slug || null;
  window.tenantQuery = tenantQuery;
  window.loadTenantContext = async () => {
    const t = await resolveTenant();
    if (!t) return null;
    window.PAWA_TENANT = t;
    if (t.slug) localStorage.setItem(STORAGE_KEY, t.slug);
    const settings = await loadBranding(t.id);
    if (settings) {
      window.PAWA_TENANT.branding = settings.branding;
      window.PAWA_TENANT.languages = settings.languages;
      window.PAWA_TENANT.default_language = settings.default_language;
      applyBranding(settings.branding);
    }
    return window.PAWA_TENANT;
  };
})();

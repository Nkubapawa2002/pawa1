// =====================================================
// Signup — creates a pending tenant + owner account
// Calls the create-tenant Edge Function so we can do the
// auth.signUp + tenants insert + tenant_users insert as one
// atomic server-side operation. Falls back to client-side
// flow if the function isn't deployed (dev convenience).
// =====================================================

window.initSignupPage = () => {
  const form    = document.getElementById("signupForm");
  const status  = document.getElementById("signupStatus");
  const btn     = document.getElementById("submitBtn");
  const card    = document.getElementById("signupCard");
  const done    = document.getElementById("signupDone");

  function showStatus(kind, msg) {
    status.style.display = "block";
    status.className = "signup-status " + kind;
    status.textContent = msg;
  }
  function showDone() {
    card.style.display = "none";
    done.classList.add("show");
  }

  // Slug helper: auto-suggest from display_name if user hasn't typed one.
  const dn = document.getElementById("display_name");
  const sl = document.getElementById("slug");
  let slugTouched = false;
  sl.addEventListener("input", () => slugTouched = true);
  dn.addEventListener("input", () => {
    if (slugTouched) return;
    sl.value = dn.value.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Submitting...";
    status.style.display = "none";

    const payload = {
      display_name:  form.display_name.value.trim(),
      legal_name:    form.legal_name.value.trim() || null,
      slug:          form.slug.value.trim().toLowerCase(),
      contact_email: form.contact_email.value.trim(),
      contact_phone: form.contact_phone.value.trim() || null,
      password:      form.password.value,
      country:       form.country.value,
      notes:         form.notes.value.trim() || null
    };

    try {
      const result = await submitSignup(payload);
      if (result.ok) {
        showDone();
      } else {
        throw new Error(result.error || "Signup failed");
      }
    } catch (err) {
      console.error(err);
      showStatus("err", err.message || String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit application";
    }
  });

  async function submitSignup(payload) {
    const cfg = window.APP_CONFIG || {};
    const fnUrl = (cfg.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1/create-tenant";

    // Preferred path: Edge Function (atomic on server).
    try {
      const res = await fetch(fnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey":  cfg.SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const json = await res.json();
        return { ok: true, ...json };
      }
      // 404 or 503 -> function not deployed; fall back below.
      if (res.status === 404 || res.status === 503) throw new Error("FN_MISSING");
      const txt = await res.text();
      return { ok: false, error: "Signup function rejected: " + txt };
    } catch (e) {
      if (e.message !== "FN_MISSING") {
        // Network error or non-200; surface but try fallback anyway.
        console.warn("Edge function path failed, trying client fallback:", e);
      }
    }

    // Fallback (dev): client-side signup + tenant insert.
    return await clientSideSignup(payload);
  }

  async function clientSideSignup(p) {
    const sb = window.SB;
    if (!sb) return { ok: false, error: "Supabase not configured" };

    // 1) Auth signup. If email confirmation is on, the user must
    // confirm before tenant_users link works — we still record the
    // pending tenant.
    const { data: auth, error: aerr } = await sb.auth.signUp({
      email: p.contact_email,
      password: p.password
    });
    if (aerr) return { ok: false, error: "Auth: " + aerr.message };
    const userId = auth.user?.id || null;

    // 2) Insert tenant (status pending_approval, owner_user_id = new user)
    const { data: t, error: terr } = await sb.from("tenants").insert({
      slug:          p.slug,
      display_name:  p.display_name,
      legal_name:    p.legal_name,
      contact_email: p.contact_email,
      contact_phone: p.contact_phone,
      country:       p.country,
      status:        "pending_approval",
      owner_user_id: userId
    }).select().single();
    if (terr) return { ok: false, error: "Tenant: " + terr.message };

    // 3) Membership row (owner)
    if (userId) {
      const { error: merr } = await sb.from("tenant_users").insert({
        tenant_id: t.id, user_id: userId, role: "owner"
      });
      if (merr) return { ok: false, error: "Membership: " + merr.message };
    }

    // 4) Stub tenant_settings so the dashboard has somewhere to write.
    await sb.from("tenant_settings").insert({ tenant_id: t.id });

    return { ok: true, tenant_id: t.id, status: "pending_approval" };
  }
};

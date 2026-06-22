// ============================================================================
//  Home app feed  (index.html)
//  Wires the "Twilight" app-shell home design to real data:
//    • featured carousel + category-switchable listing feed (houses / services
//      / trucks / near) pulled from DataStore (Supabase → JSON fallback)
//    • working search, save-to-favorites hearts (houses), trust-strip counters
//    • greeting/avatar reflect the signed-in user; everything is i18n-aware
//  No framework — plain DOM, matching the rest of this buildless static app.
// ============================================================================

(function () {
  const t = (k, f) => (window.t && window.t(k)) || f;
  const DS = window.DataStore;
  const esc = window.escHtml || ((s) => String(s == null ? "" : s));

  // ---- price → compact label (same rules as houses.js / favorites.js) ----
  function fmtPrice(p) {
    p = Number(p) || 0;
    if (p >= 1e9) return (p / 1e9).toFixed(2) + "B";
    if (p >= 1e6) return (p / 1e6).toFixed(p % 1e6 === 0 ? 0 : 1) + "M";
    if (p >= 1e3) return (p / 1e3).toFixed(0) + "k";
    return String(p);
  }
  const photo0 = (r) => r.photo || (Array.isArray(r.photos) && r.photos[0]) || "";

  // ---- favorites (houses only — same store the heart on house.html uses) --
  function getFavs() {
    try { return new Set(JSON.parse(localStorage.getItem("pawa_house_favs") || "[]")); }
    catch { return new Set(); }
  }
  function toggleFav(id) {
    const favs = getFavs();
    const order = (() => { try { return JSON.parse(localStorage.getItem("pawa_house_fav_order") || "[]"); } catch { return []; } })();
    if (favs.has(id)) { favs.delete(id); }
    else { favs.add(id); if (!order.includes(id)) order.push(id); }
    localStorage.setItem("pawa_house_favs", JSON.stringify([...favs]));
    localStorage.setItem("pawa_house_fav_order", JSON.stringify(order.filter((x) => favs.has(x))));
    return favs.has(id);
  }

  // ---- normalize each listing kind into one card model -------------------
  function normHouse(h) {
    return {
      kind: "house", id: h.id, title: h.title || "Home",
      area: [h.area, h.region].filter(Boolean).join(", ") || "—",
      img: DS.housePhotoUrl(photo0(h)),
      price: "TSh " + fmtPrice(h.price_tzs),
      unit: h.listing === "sale" ? "" : "/" + (h.period || "mo"),
      specs: [h.bedrooms && h.bedrooms + " bd", h.bathrooms && h.bathrooms + " ba", h.size_sqm && h.size_sqm + " m²"].filter(Boolean).join(" · "),
      verified: !!h.verified, href: "house.html?id=" + encodeURIComponent(h.id),
      favable: true, saved: getFavs().has(h.id),
    };
  }
  function normService(s) {
    return {
      kind: "service", id: s.id, title: s.title || (s.category || "Service"),
      area: [s.area, s.region].filter(Boolean).join(", ") || "—",
      img: DS.servicePhotoUrl(photo0(s)),
      price: s.price_tzs ? "TSh " + fmtPrice(s.price_tzs) : "Quote",
      unit: s.price_tzs ? "/" + (s.period || "job") : "",
      specs: s.category || "",
      verified: !!s.verified, href: "service.html?id=" + encodeURIComponent(s.id),
      favable: false,
    };
  }
  function normTruck(tk) {
    return {
      kind: "truck", id: tk.id, title: tk.title || "Moving truck",
      area: [tk.area, tk.region].filter(Boolean).join(", ") || "—",
      img: DS.truckPhotoUrl(photo0(tk)),
      price: tk.price_tzs ? "TSh " + fmtPrice(tk.price_tzs) : "Quote",
      unit: tk.price_tzs ? "/" + (tk.period || "trip") : "",
      specs: tk.truck_type || "",
      verified: !!tk.verified, href: "truck.html?id=" + encodeURIComponent(tk.id),
      favable: false,
    };
  }

  // ---- SVG bits ----------------------------------------------------------
  const SVG = {
    pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z" stroke="rgba(231,241,236,.55)" stroke-width="1.6"/><circle cx="12" cy="10" r="2.2" stroke="rgba(231,241,236,.55)" stroke-width="1.5"/></svg>`,
    verified: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#2EE6A6" stroke-width="1.6"/><path d="M8.5 12l2.2 2.2L15.5 9.5" stroke="#2EE6A6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    heart: (filled) => filled
      ? `<svg width="19" height="19" viewBox="0 0 24 24" fill="#2EE6A6"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.3 2 4.7 5.4 4.7c2 0 3.3 1.1 4.1 2.4l.5.8.5-.8c.8-1.3 2.1-2.4 4.1-2.4 3.4 0 5 3.6 3.4 7C19.5 16.4 12 21 12 21z"/></svg>`
      : `<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 20s-6.8-4.2-9.1-8.5C1.4 8.4 2.8 5.5 5.7 5.5c1.8 0 3 1 3.8 2.1l.5.7.5-.7c.8-1.1 2-2.1 3.8-2.1 2.9 0 4.3 2.9 2.8 6C18.8 15.8 12 20 12 20z" stroke="#fff" stroke-width="1.7"/></svg>`,
    star: `<svg width="12" height="12" viewBox="0 0 24 24" fill="#FFC24B"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>`,
  };

  function placeholderImg(kind) {
    const c = kind === "service" ? "1f2a23" : kind === "truck" ? "23201a" : "13231c";
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='#${c}'/></svg>`);
  }

  // ---- card renderers ----------------------------------------------------
  function featuredCard(m) {
    const img = m.img || placeholderImg(m.kind);
    return `<a class="ha-feat" href="${m.href}">
      <img src="${esc(img)}" alt="" loading="lazy" onerror="this.style.opacity=0" />
      <span class="ha-scrim"></span>
      ${m.verified ? `<span class="ha-chip-verified">${SVG.verified}<span>${t("home_verified", "Verified")}</span></span>` : ""}
      ${m.favable ? `<button class="ha-heart" data-fav="${esc(m.id)}" aria-label="Save">${SVG.heart(m.saved)}</button>` : ""}
      <span class="ha-feat-body">
        <span class="ha-feat-title">${esc(m.title)}</span>
        <span class="ha-row"><span class="ha-muted">${esc(m.area)}</span></span>
        <span class="ha-price">${esc(m.price)}<small>${esc(m.unit)}</small></span>
      </span>
    </a>`;
  }

  function feedCard(m) {
    const img = m.img || placeholderImg(m.kind);
    return `<a class="ha-card" href="${m.href}">
      <span class="ha-card-photo">
        <img src="${esc(img)}" alt="" loading="lazy" onerror="this.style.opacity=0" />
        <span class="ha-scrim"></span>
        ${m.verified ? `<span class="ha-chip-verified">${SVG.verified}<span>${t("home_verified", "Verified")}</span></span>` : ""}
        ${m.favable ? `<button class="ha-heart" data-fav="${esc(m.id)}" aria-label="Save">${SVG.heart(m.saved)}</button>` : ""}
      </span>
      <span class="ha-card-body">
        <span class="ha-card-title">${esc(m.title)}</span>
        <span class="ha-row">${SVG.pin}<span class="ha-muted">${esc(m.area)}</span></span>
        ${m.specs ? `<span class="ha-specs">${esc(m.specs)}</span>` : ""}
        <span class="ha-price">${esc(m.price)}<small>${esc(m.unit)}</small></span>
      </span>
    </a>`;
  }

  // ---- data loading (cached per category for the session) ----------------
  const cacheByCat = {};
  async function loadCat(cat) {
    if (cacheByCat[cat]) return cacheByCat[cat];
    let rows = [];
    try {
      if (cat === "services") rows = (await DS.getServices()).map(normService);
      else if (cat === "trucks") rows = (await DS.getTrucks()).map(normTruck);
      else if (cat === "near") {
        const [h, tk] = await Promise.all([DS.getHouses(), DS.getTrucks()]);
        rows = [...h.map(normHouse), ...tk.map(normTruck)];
      } else rows = (await DS.getHouses()).map(normHouse);
    } catch (e) {
      console.warn("[home] load", cat, e);
      rows = [];
    }
    cacheByCat[cat] = rows;
    return rows;
  }

  // ---- wire favorites hearts inside a container --------------------------
  function wireHearts(root) {
    root.querySelectorAll("[data-fav]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = btn.getAttribute("data-fav");
        const saved = toggleFav(id);
        btn.innerHTML = SVG.heart(saved);
        // keep duplicate cards (same id in featured + feed) in sync
        root.ownerDocument.querySelectorAll('[data-fav="' + CSS.escape(id) + '"]')
          .forEach((b) => { b.innerHTML = SVG.heart(saved); });
      });
    });
  }

  // ---- render the active category feed -----------------------------------
  const feedTitleKey = { houses: "home_feed_houses", services: "home_feed_services", trucks: "home_feed_trucks", near: "home_feed_near" };
  async function renderFeed(cat) {
    const feedEl = document.getElementById("haFeed");
    const titleEl = document.getElementById("haFeedTitle");
    if (!feedEl) return;
    titleEl && (titleEl.textContent = t(feedTitleKey[cat], "Listings"));
    feedEl.setAttribute("aria-busy", "true");
    feedEl.innerHTML = `<div class="ha-empty">${t("home_loading", "Loading…")}</div>`;
    const rows = await loadCat(cat);
    feedEl.setAttribute("aria-busy", "false");
    if (!rows.length) {
      feedEl.innerHTML = `<div class="ha-empty"><b>${t("home_empty", "Nothing here yet")}</b><span>${t("home_empty_sub", "Check back soon.")}</span></div>`;
      return;
    }
    feedEl.innerHTML = rows.slice(0, 12).map(feedCard).join("");
    wireHearts(feedEl);
  }

  // ---- featured carousel (always the best houses) ------------------------
  async function renderFeatured() {
    const el = document.getElementById("haFeatured");
    if (!el) return;
    const rows = await loadCat("houses");
    const featured = [...rows].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0)).slice(0, 6);
    if (!featured.length) { el.closest(".ha-featured-wrap")?.style.setProperty("display", "none"); return; }
    el.innerHTML = featured.map(featuredCard).join("");
    wireHearts(el);
  }

  // ---- category chips ----------------------------------------------------
  function wireChips() {
    const chips = document.querySelectorAll(".ha-chip[data-cat]");
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const cat = chip.getAttribute("data-cat");
        chips.forEach((c) => c.classList.toggle("active", c === chip));
        renderFeed(cat);
      });
    });
  }

  // ---- search ------------------------------------------------------------
  function wireSearch() {
    const input = document.getElementById("haSearch");
    const go = () => {
      const q = (input.value || "").trim();
      const active = document.querySelector(".ha-chip.active")?.getAttribute("data-cat") || "houses";
      const page = active === "services" ? "services.html" : active === "trucks" ? "trucks.html" : active === "near" ? "near-me.html" : "houses.html";
      location.href = page + (q ? "?q=" + encodeURIComponent(q) : "");
    };
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    document.getElementById("haSearchBtn")?.addEventListener("click", go);
  }

  // ---- greeting + avatar reflect the signed-in user ----------------------
  async function hydrateUser() {
    const nameEl = document.getElementById("haGreetName");
    const avEl = document.getElementById("haAvatar");
    try {
      const email = window.Auth && (await window.Auth.currentEmail());
      if (email) {
        const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        if (nameEl) nameEl.textContent = ", " + name;
        if (avEl) avEl.textContent = (name[0] || "A").toUpperCase();
        if (avEl) avEl.setAttribute("href", "agent-houses.html");
      }
    } catch (_) {}
  }

  // ---- trust-strip count-up ---------------------------------------------
  function countUp() {
    document.querySelectorAll(".ha-stat-num[data-to]").forEach((el) => {
      const target = Number(el.dataset.to) || 0;
      const suffix = el.dataset.suffix || "";
      const start = performance.now(), dur = 1400;
      const tick = (now) => {
        const k = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + suffix;
        if (k < 1) requestAnimationFrame(tick);
      };
      const io = new IntersectionObserver((ents) => {
        ents.forEach((e) => { if (e.isIntersecting) { requestAnimationFrame(tick); io.disconnect(); } });
      }, { threshold: 0.4 });
      io.observe(el);
    });
  }

  // ---- language toggle (shares the site-wide setLang) --------------------
  function wireLang() {
    const btn = document.getElementById("haLang");
    const txt = document.getElementById("haLangTxt");
    const cur = (window.getLang && window.getLang()) || "en";
    if (txt) txt.textContent = cur.toUpperCase();
    btn?.addEventListener("click", () => {
      const next = ((window.getLang && window.getLang()) || "en") === "en" ? "sw" : "en";
      window.setLang && window.setLang(next);
    });
  }

  // ---- boot --------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("haFeed")) return;
    wireChips();
    wireSearch();
    wireLang();
    hydrateUser();
    countUp();
    renderFeatured();
    renderFeed("houses");
  });
})();

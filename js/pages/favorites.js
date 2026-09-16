// ============================================================================
//  Favorites page  (favorites.html)
//  - Reads fav house ids from localStorage["pawa_house_favs"] (set by the
//    heart button on house.html)
//  - Pulls the matching property records from DataStore.getHouses()
//    (Supabase first, JSON fallback if the table is missing)
//  - Renders a grid of cards with sort, remove and clear-all
//  - Save-order is preserved in localStorage["pawa_house_fav_order"] so we
//    can show "recently saved" first without needing a timestamp DB
// ============================================================================

window.initFavoritesPage = async () => {
  // INSIDE this function on purpose. A top-level `function t()` in a classic
  // script IS window.t, so declaring one here would replace i18n's own
  // function with this one, and the first line below would then call itself
  // until the stack ran out. That is not hypothetical: it is what the first
  // version of this change did, and the page died with "Maximum call stack
  // size exceeded" before it drew anything.
  //
  // Otherwise the same helper as profile.js, for the same reason: window.t
  // takes a key and nothing else, and it returns the KEY ITSELF when a string
  // is missing, so without the fallback a missing key renders as "fav_empty_t"
  // on the screen. The vars pass fills {n} and {title}.
  const t = (key, fallback, vars) => {
    let s = window.t ? window.t(key) : key;
    if (!s || s === key) s = fallback;
    if (vars) Object.keys(vars).forEach((k) => {
      s = String(s).replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    });
    return s;
  };

  const toolbarEl = document.getElementById("favToolbar");
  const countEl   = document.getElementById("favCount");
  const sortEl    = document.getElementById("favSort");
  const clearBtn  = document.getElementById("favClearAll");
  const gridEl    = document.getElementById("favGrid");
  const stateEl   = document.getElementById("favState");

  let all = [];      // every house record we could find
  let favs = getFavs();
  let lastRemoved = null;   // for "Undo"
  let toastTimer  = null;

  // ---- Load all houses, then filter to favorites --------------------------
  try {
    all = await window.DataStore.getHouses();
  } catch (e) {
    gridEl.innerHTML = "";
    gridEl.setAttribute("aria-busy", "false");
    stateEl.innerHTML = `<div class="hp-empty" role="alert">
      <div class="hp-empty__art" style="background:var(--c-danger-soft,#fce4e4);color:var(--c-danger,#b91c1c);box-shadow:inset 0 0 0 1px rgba(185,28,28,.18)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1"/>
        </svg>
      </div>
      <div class="hp-empty__title">${esc(t("fav_err_t", "Could not load the houses"))}</div>
      <div class="hp-empty__sub">${esc(e.message || String(e))}</div>
      <button class="hp-empty__cta" type="button" onclick="location.reload()">${esc(t("fav_retry", "Try again"))}</button>
    </div>`;
    return;
  }

  // ---- Sort change --------------------------------------------------------
  sortEl.addEventListener("change", render);

  // ---- Clear all ----------------------------------------------------------
  clearBtn.addEventListener("click", () => {
    if (!favs.size) return;
    if (!confirm(t("fav_clear_confirm",
                   "Remove all {n} saved houses? This cannot be undone.",
                   { n: favs.size }))) return;
    favs.clear();
    saveFavs(favs);
    saveOrder([]);
    render();
  });

  render();

  // ====================================================================
  //  Render
  // ====================================================================
  function render() {
    favs = getFavs();
    const order = getOrder();
    const sort = sortEl.value;

    // Match every fav id to a record. Anything not found (stale id from a
    // listing that was later deleted) is silently dropped.
    const byId = new Map(all.map(h => [h.id, h]));
    let visible = [...favs].map(id => byId.get(id)).filter(Boolean);

    // Sort
    visible.sort((a, b) => {
      if (sort === "price_asc")  return (a.price_tzs || 0) - (b.price_tzs || 0);
      if (sort === "price_desc") return (b.price_tzs || 0) - (a.price_tzs || 0);
      if (sort === "title")      return (a.title || "").localeCompare(b.title || "");
      // recent — use the saved-order array (most recent ids are appended last)
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      return bi - ai;   // descending by save-time
    });

    if (!visible.length) {
      toolbarEl.hidden = true;
      gridEl.innerHTML = "";
      gridEl.setAttribute("aria-busy", "false");
      stateEl.innerHTML = `<div class="hp-empty" role="status">
        <div class="hp-empty__art" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </div>
        <div class="hp-empty__title">${esc(t("fav_empty_t", "Nothing saved yet"))}</div>
        <div class="hp-empty__sub">${esc(t("fav_empty_sub", "Tap the heart on any house to keep it here. Your list stays on this device."))}</div>
        <a class="hp-empty__cta" href="houses.html">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>
          ${esc(t("fav_browse", "Browse houses"))}
        </a>
        <div class="hp-empty__hint">${esc(t("fav_hint", "Browsing privately? Saved houses still work, because the list never leaves this device."))}</div>
      </div>`;
      return;
    }

    toolbarEl.hidden = false;
    // The number keeps its own emphasis, but the sentence around it comes from
    // i18n, so a language can put the count anywhere in it. Split on the
    // placeholder and put the count back as the only unescaped part.
    const said = t("fav_count", "{n} saved").split("{n}");
    countEl.innerHTML = esc(said[0]) + "<strong>" + visible.length + "</strong>" +
                        esc(said.slice(1).join("{n}"));
    stateEl.innerHTML = "";
    gridEl.setAttribute("aria-busy", "false");

    gridEl.innerHTML = visible.map(h => {
      const photo    = window.DataStore.housePhotoUrl(h.photo);
      const listing  = h.listing === "sale"
        ? t("fav_for_sale", "For sale")
        : t("fav_for_rent", "For rent");
      const price    = formatPrice(h);
      const verified = h.verified
        ? `<span class="verified"> ${esc(t("fav_verified", "Verified"))}</span>` : "";
      // Swahili does not pluralise by adding an "s", so the singular and the
      // plural are two keys rather than one key with a suffix bolted on.
      const meta = [
        h.bedrooms ? `<span> ${esc(t(h.bedrooms === 1 ? "fav_beds" : "fav_beds_p",
                                     h.bedrooms === 1 ? "{n} bed" : "{n} beds",
                                     { n: h.bedrooms }))}</span>` : "",
        h.bathrooms ? `<span> ${esc(t(h.bathrooms === 1 ? "fav_baths" : "fav_baths_p",
                                      h.bathrooms === 1 ? "{n} bath" : "{n} baths",
                                      { n: h.bathrooms }))}</span>` : "",
        h.size_sqm ? `<span> ${h.size_sqm} m²</span>` : ""
      ].filter(Boolean).join("");

      return `<div class="fav-card" data-id="${esc(h.id)}">
        <div class="fav-card-photo" data-loading="true" style="background-image:url('${photo}')">
          <span class="badge">${esc(listing)}</span>
          ${verified}
          <button class="remove" type="button" aria-label="${esc(t("fav_remove_aria", "Remove {title} from saved", { title: h.title || "" }))}" title="${esc(t("fav_remove_aria", "Remove {title} from saved", { title: h.title || "" }))}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        <div class="fav-card-body">
          <div class="fav-card-price">${price.value} <small>${price.unit}</small></div>
          <div class="fav-card-title">${esc(h.title)}</div>
          <div class="fav-card-meta">${meta}</div>
          <div class="fav-card-loc"> ${esc(h.area || "—")}${h.region ? `, ${esc(h.region)}` : ""}</div>
          <a class="fav-card-view" href="house.html?id=${encodeURIComponent(h.id)}">${esc(t("fav_view", "View details"))} →</a>
        </div>
      </div>`;
    }).join("");

    // Wire up remove buttons
    gridEl.querySelectorAll(".fav-card").forEach(card => {
      card.querySelector(".remove").addEventListener("click", (e) => {
        e.stopPropagation();
        const id = card.dataset.id;
        const removed = byId.get(id);
        removeFav(id);
        lastRemoved = removed;
        showToast(t("fav_removed", "Removed {title}",
                    { title: "“" + (removed?.title || "") + "”" }), true);
        render();
      });
    });

    // Drop shimmer once each card photo loads.
    gridEl.querySelectorAll(".fav-card-photo[data-loading]").forEach(el => {
      const m = el.getAttribute("style").match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!m) { el.removeAttribute("data-loading"); return; }
      const img = new Image();
      img.decoding = "async"; img.loading = "lazy";
      img.onload = img.onerror = () => el.removeAttribute("data-loading");
      img.src = m[1];
    });
  }

  // ====================================================================
  //  Toast (with Undo)
  // ====================================================================
  function showToast(text, undoable) {
    const existing = document.querySelector(".fav-toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const toast = document.createElement("div");
    toast.className = "fav-toast";
    toast.innerHTML = `<span>${esc(text)}</span>${undoable ? `<button class="undo" type="button">${esc(t("fav_undo", "Undo"))}</button>` : ""}`;
    document.body.appendChild(toast);

    if (undoable) {
      toast.querySelector(".undo").addEventListener("click", () => {
        if (lastRemoved) {
          const f = getFavs(); f.add(lastRemoved.id); saveFavs(f);
          const o = getOrder(); if (!o.includes(lastRemoved.id)) o.push(lastRemoved.id); saveOrder(o);
        }
        toast.remove();
        render();
      });
    }
    toastTimer = setTimeout(() => toast.remove(), 4500);
  }

  // ====================================================================
  //  localStorage helpers
  // ====================================================================
  function getFavs() {
    try { return new Set(JSON.parse(localStorage.getItem("pawa_house_favs") || "[]")); }
    catch { return new Set(); }
  }
  function saveFavs(set) {
    localStorage.setItem("pawa_house_favs", JSON.stringify([...set]));
  }
  function getOrder() {
    try { return JSON.parse(localStorage.getItem("pawa_house_fav_order") || "[]"); }
    catch { return []; }
  }
  function saveOrder(arr) {
    localStorage.setItem("pawa_house_fav_order", JSON.stringify(arr));
  }
  function removeFav(id) {
    const f = getFavs(); f.delete(id); saveFavs(f);
    const o = getOrder().filter(x => x !== id); saveOrder(o);
  }

  // ====================================================================
  //  Format helpers (same shape as houses.js / house.js)
  // ====================================================================
  function formatPrice(h) {
    const p = h.price_tzs || 0;
    let value;
    if (p >= 1_000_000_000) value = (p / 1_000_000_000).toFixed(2) + "B";
    else if (p >= 1_000_000) value = (p / 1_000_000).toFixed(p % 1_000_000 === 0 ? 0 : 1) + "M";
    else if (p >= 1_000)     value = (p / 1_000).toFixed(0) + "k";
    else value = String(p);
    const unit = h.listing === "sale" ? "TZS" : `TZS / ${h.period || "month"}`;
    return { value, unit };
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
};

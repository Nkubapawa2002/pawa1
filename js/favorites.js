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
      <div class="hp-empty__title">Couldn't load properties</div>
      <div class="hp-empty__sub">${esc(e.message || String(e))}</div>
      <button class="hp-empty__cta" type="button" onclick="location.reload()">Try again</button>
    </div>`;
    return;
  }

  // ---- Sort change --------------------------------------------------------
  sortEl.addEventListener("change", render);

  // ---- Clear all ----------------------------------------------------------
  clearBtn.addEventListener("click", () => {
    if (!favs.size) return;
    if (!confirm(`Remove all ${favs.size} favorites? This can't be undone.`)) return;
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
        <div class="hp-empty__title">No favorites yet</div>
        <div class="hp-empty__sub">Tap the heart icon on any property to save it here. Your list stays on this device.</div>
        <a class="hp-empty__cta" href="houses.html">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>
          Browse properties
        </a>
        <div class="hp-empty__hint">Browsing privately? Your favorites still work — they're stored locally.</div>
      </div>`;
      return;
    }

    toolbarEl.hidden = false;
    countEl.textContent = visible.length;
    stateEl.innerHTML = "";
    gridEl.setAttribute("aria-busy", "false");

    gridEl.innerHTML = visible.map(h => {
      const photo    = window.DataStore.housePhotoUrl(h.photo);
      const listing  = h.listing === "sale" ? "For sale" : "For rent";
      const price    = formatPrice(h);
      const verified = h.verified ? `<span class="verified">✓ Verified</span>` : "";
      const meta = [
        h.bedrooms ? `<span>🛏 ${h.bedrooms} bed${h.bedrooms !== 1 ? "s" : ""}</span>` : "",
        h.bathrooms ? `<span>🛁 ${h.bathrooms} bath${h.bathrooms !== 1 ? "s" : ""}</span>` : "",
        h.size_sqm ? `<span>📐 ${h.size_sqm} m²</span>` : ""
      ].filter(Boolean).join("");

      return `<div class="fav-card" data-id="${esc(h.id)}">
        <div class="fav-card-photo" data-loading="true" style="background-image:url('${photo}')">
          <span class="badge">${listing}</span>
          ${verified}
          <button class="remove" type="button" aria-label="Remove ${esc(h.title)} from favorites" title="Remove from favorites">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        <div class="fav-card-body">
          <div class="fav-card-price">${price.value} <small>${price.unit}</small></div>
          <div class="fav-card-title">${esc(h.title)}</div>
          <div class="fav-card-meta">${meta}</div>
          <div class="fav-card-loc">📍 ${esc(h.area || "—")}${h.region ? `, ${esc(h.region)}` : ""}</div>
          <a class="fav-card-view" href="house.html?id=${encodeURIComponent(h.id)}">View details →</a>
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
        showToast(`Removed "${(removed?.title || "listing")}"`, true);
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
    toast.innerHTML = `<span>${esc(text)}</span>${undoable ? `<button class="undo" type="button">Undo</button>` : ""}`;
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

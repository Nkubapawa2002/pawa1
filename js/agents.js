window.initAgentsPage = async () => {
  const grid = document.getElementById("agentsGrid");
  const regionFilter = document.getElementById("regionFilter");
  const searchInput = document.getElementById("searchInput");

  let agents = [], regions = [];
  try {
    [agents, regions] = await Promise.all([
      window.DataStore.getAgents(),
      window.DataStore.getRegions()
    ]);
  } catch (e) {
    grid.innerHTML = `<div class="banner error">${e.message}</div>`;
    return;
  }

  regions.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r; opt.textContent = r;
    regionFilter.appendChild(opt);
  });

  const phoneClean = (p) => p.replace(/\s/g, "");

  const PAGE_SIZE = 12;
  let visibleCount = PAGE_SIZE;

  const render = () => {
    const region = regionFilter.value;
    const search = searchInput.value.toLowerCase().trim();
    visibleCount = PAGE_SIZE;

    const filtered = agents.filter(a => {
      if (region && a.region !== region) return false;
      if (search) {
        const phones = (a.phones && a.phones.length) ? a.phones : [a.phone];
        const phoneHay = phones.join(" ");
        const haystack = `${a.name} ${phoneHay} ${a.region} ${a.terminal} ${(a.buses || []).join(" ")}`.toLowerCase();
        const phoneHit = window.DataStore.phoneMatchesAny(phones, search);
        if (!haystack.includes(search) && !phoneHit) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty"><div class="icon">[--]</div><p>${window.t("agents_no_match")}</p></div>`;
      return;
    }

    const renderPage = () => {
      const page = filtered.slice(0, visibleCount);
      const hasMore = visibleCount < filtered.length;
      grid.innerHTML = page.map(a => {
      const verified = a.verified !== false
        ? `<span class="verified-badge" title="ID-verified by Pawa">✓ ${window.t("label_verified")}</span>` : "";
      const rating = Number(a.rating_avg) || 0;
      const count = a.rating_count || 0;
      const stars = renderStars(rating);
      const exp   = a.experience_years ? `<p class="meta"><strong>${window.t("label_experience")}:</strong> ${a.experience_years} ${window.t("label_years")}</p>` : "";
      const about = a.about ? `<p class="meta agent-about">${a.about}</p>` : "";
      const photo = window.DataStore.agentPhotoUrl(a.photo_path);
      const initials = (a.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
      const avatar = photo
        ? `<img src="${photo}" alt="${a.name}" loading="lazy"/>`
        : `<span class="agent-no-photo" style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:50%;">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gray)" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
             <span style="font-size:0.6rem;color:var(--gray);font-weight:600">${window.t("agents_no_photo")}</span>
           </span>`;
      const phones = (a.phones && a.phones.length) ? a.phones : (a.phone ? [a.phone] : []);
      const phonesHtml = window.DataStore.renderAgentPhones(phones);
      return `
      <div class="card agent-card">
        <div class="agent-card-head">
          <div class="agent-avatar">${avatar}</div>
          <div class="agent-card-id">
            <h3>${a.name} ${verified}</h3>
            <div class="rating-row">${stars} <small>${rating.toFixed(1)} · ${count} ${count === 1 ? window.t("review_singular") : window.t("review_plural")}</small></div>
          </div>
        </div>
        <p class="meta"><strong>${window.t("label_region")}:</strong> ${a.region}</p>
        <p class="meta"><strong>${window.t("label_terminal")}:</strong> ${a.terminal || "-"}</p>
        <p class="meta"><strong>${window.t("label_phones")}:</strong></p>
        ${phonesHtml}
        <p class="meta"><strong>${window.t("label_buses")}:</strong> ${(a.buses || []).join(", ")}</p>
        ${exp}
        ${about}
      </div>
    `;}).join("");
      grid.innerHTML += hasMore
        ? `<div style="grid-column:1/-1;text-align:center;margin-top:16px;">
             <button id="loadMoreAgents" class="btn btn-outline">
               Load more (${filtered.length - visibleCount} remaining)
             </button>
           </div>`
        : "";
      document.getElementById("loadMoreAgents")?.addEventListener("click", () => {
        visibleCount += PAGE_SIZE;
        renderPage();
      });
    };
    renderPage();
  };

  function renderStars(rating) {
    const full = Math.floor(rating);
    const half = rating - full >= 0.5;
    let html = "";
    for (let i = 0; i < 5; i++) {
      if (i < full) html += `<span class="star full">★</span>`;
      else if (i === full && half) html += `<span class="star half">★</span>`;
      else html += `<span class="star empty">☆</span>`;
    }
    return `<span class="stars">${html}</span>`;
  }

  regionFilter.addEventListener("change", render);
  searchInput.addEventListener("input", render);
  render();
};

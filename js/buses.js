window.initBusesPage = async () => {
  const grid = document.getElementById("busesGrid");
  const fromFilter = document.getElementById("fromFilter");
  const toFilter = document.getElementById("toFilter");
  const searchInput = document.getElementById("searchInput");

  let buses = [], regions = [];
  try {
    [buses, regions] = await Promise.all([
      window.DataStore.getBuses(),
      window.DataStore.getRegions()
    ]);
  } catch (e) {
    grid.innerHTML = `<div class="banner error">${e.message}</div>`;
    return;
  }

  regions.forEach(r => {
    const optA = document.createElement("option"); optA.value = r; optA.textContent = r; fromFilter.appendChild(optA);
    const optB = document.createElement("option"); optB.value = r; optB.textContent = r; toFilter.appendChild(optB);
  });

  const phoneClean = (p) => p.replace(/\s/g, "");

  const PAGE_SIZE = 12;
  let visibleCount = PAGE_SIZE;

  const render = () => {
    const from = fromFilter.value;
    const to = toFilter.value;
    const search = searchInput.value.toLowerCase().trim();
    visibleCount = PAGE_SIZE; // reset on filter change

    const filtered = buses.filter(b => {
      if (search && !b.name.toLowerCase().includes(search)) return false;
      if (from || to) {
        return (b.routes || []).some(r =>
          (!from || r.from === from) && (!to || r.to === to)
        );
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty"><div class="icon">[--]</div><p>${window.t("buses_no_match")}</p></div>`;
      return;
    }

    const renderPage = () => {
      const page = filtered.slice(0, visibleCount);
      const hasMore = visibleCount < filtered.length;
      grid.innerHTML = page.map(b => {
      const routes = (b.routes || [])
        .filter(r => (!from || r.from === from) && (!to || r.to === to))
        .map(r => `<li>${r.from} &rarr; ${r.to} <small style="color:var(--gray)">(${r.departure}, ~${r.duration_hours}h)</small></li>`)
        .join("");
      const photo = window.DataStore.busPhotoUrl(b.photo_path);
      const verified = b.verified !== false
        ? `<span class="verified-badge" title="Verified by Pawa">✓ ${window.t("label_verified")}</span>` : "";
      const contacts = (Array.isArray(b.contacts) && b.contacts.length)
        ? b.contacts
        : (b.contact ? [{ label: "Main", number: b.contact, whatsapp: true }] : []);
      const phonesHtml = window.DataStore.renderContacts(contacts);
      const meta = [
        b.hq ? `<strong>${window.t("label_hq")}:</strong> ${b.hq}` : "",
        b.year_founded ? `<strong>${window.t("label_since")}:</strong> ${b.year_founded}` : "",
        b.website ? `<a href="${b.website}" target="_blank" rel="noopener" class="text-green">${window.t("label_website")}</a>` : ""
      ].filter(Boolean).join(" · ");
      const prefixBadge = b.ticket_prefix
        ? `<span title="Ticket series for this company" style="display:inline-block;font-family:monospace;font-size:0.72rem;font-weight:700;letter-spacing:1.5px;background:var(--green-light,#e8f5e8);color:var(--green-dark,#0a6f4d);border:1px solid var(--green-mid,#86efac);border-radius:5px;padding:2px 7px;margin-left:6px;vertical-align:middle">${b.ticket_prefix}‑XXXXXX</span>`
        : "";
      return `
        <div class="card bus-card">
          ${photo ? `<div class="bus-photo"><img src="${photo}" alt="${b.name}" loading="lazy"/></div>` : ""}
          <div class="bus-card-body">
            <h3>${b.name} ${verified}${prefixBadge}</h3>
            ${b.about ? `<p class="meta">${b.about}</p>` : ""}
            ${meta ? `<p class="meta">${meta}</p>` : ""}
            <p class="meta" style="margin-top:8px"><strong>${window.t("label_phones")}:</strong></p>
            ${phonesHtml}
            <p class="meta" style="margin-top:8px"><strong>${window.t("label_routes")}:</strong></p>
            <ul style="margin-left:20px;font-size:0.92rem;color:var(--black)">${routes || `<li><em>${window.t("buses_no_routes_match")}</em></li>`}</ul>
            <div class="contact-actions">
              <a href="book-fast.html?bus=${encodeURIComponent(b.id)}" class="btn btn-primary btn-sm">${window.t("action_book")}</a>
            </div>
          </div>
        </div>
      `;
      }).join("");
      grid.innerHTML += hasMore
        ? `<div style="grid-column:1/-1;text-align:center;margin-top:16px;">
             <button id="loadMoreBuses" class="btn btn-outline">
               Load more (${filtered.length - visibleCount} remaining)
             </button>
           </div>`
        : "";
      document.getElementById("loadMoreBuses")?.addEventListener("click", () => {
        visibleCount += PAGE_SIZE;
        renderPage();
      });
    };
    renderPage();
  };

  fromFilter.addEventListener("change", render);
  toFilter.addEventListener("change", render);
  searchInput.addEventListener("input", render);
  render();
};

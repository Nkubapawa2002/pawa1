// ============================================================================
//  House detail page  (house.html?id=h-001)
//
//  WHAT THIS SCREEN IS
//  One property, told in the order somebody decides in: what it looks like,
//  which space they would actually take and what THAT space costs to move
//  into, what the agent promises, where it is, who to call.
//
//  THE ARRANGEMENT, AND WHY IT CHANGED
//  This used to be a flat stack of nine cards that each held a quarter of an
//  answer. The price sat in one; the months you must pay upfront in a second;
//  the bills in a third; the agent's commission in a fourth — and nothing ever
//  added them together. Worse, "Rooms & specifications" drew tiles built from
//  `room_kind` and `price_tzs`, which are NOT facts about the listing: they are
//  the CHEAPEST room's category and price, projected onto two columns so old
//  queries keep working (js/lib/house-spec.js explains why). So a tile reading
//  "Room: Single" sat beside "4 bedrooms" and, three cards down, a master room
//  in the price table — three accounts of one building, and no way to tell
//  which the headline price belonged to.
//
//  Now the page has a spine:
//
//    hero        the media, with the identity written over it
//    money       ONE card: this space's price, and the itemised move-in total
//    rooms       pick a space; the money, the tiles and the vacancy follow it
//    evidence    description, the agent's own rules/area/services/paperwork,
//                the bills, the amenities
//    place       map, pin provenance, nearest main road, commute measure
//    nearby      what is actually around it
//    agent       who to reach, and how
//
//  A section rail across the top tracks which of those you are reading, and it
//  is built from the sections that actually rendered — a listing with no
//  description never gets a chip pointing at nothing.
//
//  WHAT LIVES ELSEWHERE
//    js/lib/house-spec.js   the shape of the spec sheet (rooms[] + groups[])
//    js/lib/house-rooms.js  the room model, the per-room tiles, the move-in sum
//    css/house-detail.css   the whole skin, in design-system tokens
//
//  Favourites stay in localStorage["pawa_house_favs"] (no auth needed).
// ============================================================================

// T() and fillT() come from js/lib/house-ui.js, which loads first. They are not
// redeclared here: this file and house-sections.js share one global scope.

window.initHousePage = async () => {
  const bodyEl   = document.getElementById("hdBody");
  const params   = new URLSearchParams(location.search);
  const id       = params.get("id");

  if (!id) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: T("hd_none_h", "No listing selected"),
      sub: T("hd_none_p", "Open a property from the houses directory to see its details."),
      ctaHref: "houses.html",
      ctaLabel: T("hd_none_cta", "Browse listings")
    });
    return;
  }

  // Skeleton is already in the DOM (from the HTML). Just wait for data.
  let h;
  try {
    const all = await window.DataStore.getHouses();
    h = all.find(x => x.id === id);
  } catch (e) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: T("hd_fail_h", "Could not load this listing"),
      sub: esc(e.message || String(e)),
      ctaHref: "javascript:location.reload()",
      ctaLabel: T("hd_fail_cta", "Try again"),
      danger: true
    });
    return;
  }

  if (!h) {
    bodyEl.setAttribute("aria-busy", "false");
    bodyEl.innerHTML = emptyState({
      title: T("hd_missing_h", "Listing not found"),
      sub: fillT(T("hd_missing_p", "No property with id \"{id}\" is listed. It may have been taken down."),
                 { id: esc(id) }),
      ctaHref: "houses.html",
      ctaLabel: T("hd_missing_cta", "Back to listings")
    });
    return;
  }
  bodyEl.setAttribute("aria-busy", "false");

  // Set the page title so browser tabs / WhatsApp previews look right.
  document.title = `${h.title} · Pawa`;

  render(h);
};

// ============================================================================
// Render
// ============================================================================
function render(h) {
  const bodyEl   = document.getElementById("hdBody");
  const stickyEl = document.getElementById("hdSticky");
  const HR       = window.HouseRooms;

  // ---- media -------------------------------------------------------------
  // photos[] and videos[] become one carousel. Back-compat: a row that predates
  // the multi-media migration has an empty photos[], so fall back to `photo`.
  const photoList = (Array.isArray(h.photos) && h.photos.length)
    ? h.photos
    : (h.photo ? [h.photo] : []);
  const videoList = Array.isArray(h.videos) ? h.videos : [];
  const slides = [
    ...photoList.map(p => ({ kind: "photo", url: window.DataStore.housePhotoUrl(p) })),
    ...videoList.map(v => ({ kind: "video", url: window.DataStore.housePhotoUrl(v) })),
  ];
  if (!slides.length) {
    slides.push({ kind: "photo", url: "https://kkdpacoiwntrcukgwksh.supabase.co/storage/v1/object/public/site-photos/tierra-mallorca-rgJ1J8SDEAY-unsplash.jpg" });
  }

  // ---- the spaces --------------------------------------------------------
  // Every priced space in this listing, and the one to land on: the cheapest
  // that is still free.
  const roomList = HR ? HR.rooms(h) : [];
  let picked = HR && roomList.length ? HR.defaultRoom(roomList) : 0;

  const listing  = T(h.listing === "sale" ? "hd_for_sale" : "hd_for_rent",
                     h.listing === "sale" ? "For sale" : "For rent");
  const price    = formatPrice(h);
  const pinLine  = pinProvenance(h);

  // ---- agent + links -----------------------------------------------------
  const agentName  = h.agent?.name  || T("hd_agent", "Listing agent");
  const agentPhone = h.agent?.phone || "";
  const agentPhoneClean = agentPhone.replace(/\s+/g, "");
  const waNumber   = agentPhone.replace(/^\+/, "").replace(/\s+/g, "");
  const initials   = agentName.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  const mapsUrl   = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;
  const meetCode  = roomCodeFor(h.id);
  // &house=<id> turns the meet room into a "live viewing" — the listing is
  // pinned on the live map and shown in the room's side panel.
  const meetQuery = `code=${meetCode}&house=${encodeURIComponent(h.id)}`;
  const meetUrl   = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}meet.html?${meetQuery}`;
  // One message, three lines, assembled from keys rather than pasted English:
  // who they are, what it is about, and the viewing invitation with its code.
  const waText    = encodeURIComponent(
    fillT(T("hd_wa_1", "Hello {agent}, I am interested in your listing on Pawa:"),
          { agent: agentName }) + "\n" +
    `"${h.title}" (${listing}, ${price.value} ${price.unit}).\n` +
    fillT(T("hd_wa_2", "Could we do a live viewing? Join me on Pawa Live Meet, code {code}: {url}"),
          { code: meetCode, url: meetUrl }));
  const waHref    = waNumber ? `https://wa.me/${waNumber}?text=${waText}` : "";

  // ---- sections ----------------------------------------------------------
  const sections = {
    "sec-money":     moneySectionHtml(h, roomList, picked),
    "sec-rooms":     roomsSectionHtml(h, roomList, picked),
    "sec-about":     aboutSectionHtml(h),
    "sec-rules":     groupsSectionHtml(h),
    "sec-costs":     billsSectionHtml(h),
    "sec-amenities": amenitiesSectionHtml(h),
    "sec-place":     placeSectionHtml(h, mapsUrl, meetCode, pinLine),
    "sec-nearby":    nearbySectionHtml(h),
    "sec-agent":     agentSectionHtml(h, { agentName, agentPhone, agentPhoneClean, waHref, meetCode, initials }),
  };
  const present = SECTION_ORDER.filter(id => sections[id]);

  bodyEl.innerHTML = `
    ${heroHtml(h, slides, photoList.length, listing)}
    ${railHtml(present)}
    <div class="hx-layout">
      <!-- The aside is first in the document deliberately: on a phone it sits at
           the top, and DOM order is what the tab key and a screen reader follow.
           css/house-detail.css moves it to the right-hand rail on desktop by
           explicit grid placement, not by reordering it. -->
      <aside class="hx-aside">
        ${sections["sec-money"] || ""}
        ${sections["sec-agent"] || ""}
      </aside>
      <div class="hx-main">
        ${sections["sec-rooms"] || ""}
        ${sections["sec-about"] || ""}
        ${sections["sec-rules"] || ""}
        ${sections["sec-costs"] || ""}
        ${sections["sec-amenities"] || ""}
        ${sections["sec-place"] || ""}
        ${sections["sec-nearby"] || ""}
      </div>
    </div>
  `;

  // ---- wiring ------------------------------------------------------------
  if (slides.length > 1) wireGallery(slides.length);
  else hookSingleVideoAutopause(bodyEl);

  wireTopbar(h, price);
  wireRail(present);
  wireAccordion();
  wireMoveIn();

  // The room picker is the spine of the page: changing it re-draws the space's
  // own panel AND the money card above it, so the two can never disagree.
  document.querySelectorAll(".hx-roomtab").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.room, 10);
      if (!Number.isFinite(i) || i === picked) return;
      picked = i;
      document.querySelectorAll(".hx-roomtab").forEach(b =>
        b.setAttribute("aria-selected", String(parseInt(b.dataset.room, 10) === picked)));
      const panel = document.getElementById("hxRoomPanel");
      if (panel) panel.innerHTML = HR.roomPanel(roomList[picked]);
      const money = document.getElementById("sec-money");
      if (money) {
        money.innerHTML = moneyInnerHtml(h, roomList, picked);
        wireMoveIn();
      }
    });
  });

  wireFavShare(h, price);
  wireSticky(h, stickyEl, { agentPhone, agentPhoneClean, waHref, meetCode });
  mountMap(h);
  // The area readout is NOT part of the map. A listing whose survey was saved
  // when it was posted can answer "what is nearby" with no pin, no tiles and no
  // network at all — so it is asked here rather than from inside mountMap,
  // where a missing pin used to take the whole card away with it.
  renderNearbySummary(h);
}

// ============================================================================
// Wiring
// ============================================================================

/** The top bar takes on its border and the listing's name once the hero goes. */
function wireTopbar(h, price) {
  const bar = document.getElementById("hxTopbar");
  const hero = document.getElementById("hxHero");
  const title = document.getElementById("hxTopTitle");
  if (title) title.textContent = h.title || "";
  if (!bar || !hero || typeof IntersectionObserver !== "function") return;
  new IntersectionObserver(([e]) => {
    bar.classList.toggle("is-stuck", !e.isIntersecting);
  }, { rootMargin: "-56px 0px 0px 0px", threshold: 0 }).observe(hero);
}

/** Scroll-spy: the rail chip for the section you are reading lights up. */
function wireRail(ids) {
  const rail = document.getElementById("hxRail");
  if (!rail || typeof IntersectionObserver !== "function") return;
  const links = new Map();
  rail.querySelectorAll(".hx-rail__link").forEach(a => links.set(a.dataset.sec, a));

  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => seen.set(e.target.id, e.intersectionRatio));
    // The section with the most of itself on screen wins, so a short card
    // sandwiched between two long ones never steals the highlight.
    let best = null, bestRatio = 0;
    seen.forEach((r, id) => { if (r > bestRatio) { bestRatio = r; best = id; } });
    links.forEach((a, id) => a.classList.toggle("is-active", id === best && bestRatio > 0));
  }, { threshold: [0, 0.15, 0.35, 0.6, 0.9], rootMargin: "-96px 0px -40% 0px" });

  ids.forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });

  // Smooth-scroll without leaving a hash in the URL, which would otherwise
  // make the browser Back button walk the sections instead of the history.
  rail.addEventListener("click", (ev) => {
    const a = ev.target.closest(".hx-rail__link");
    if (!a) return;
    const el = document.getElementById(a.dataset.sec);
    if (!el) return;
    ev.preventDefault();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/** The fact-group accordion. */
function wireAccordion() {
  document.querySelectorAll(".hx-acc__btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      const panel = document.getElementById(btn.getAttribute("aria-controls"));
      if (panel) panel.classList.toggle("is-open", !open);
    });
  });
}

/** The move-in breakdown. Re-bound whenever the money card is re-rendered. */
function wireMoveIn() {
  const btn = document.getElementById("hxMoveinBtn");
  const body = document.getElementById("hxMoveinBody");
  if (!btn || !body) return;
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    body.classList.toggle("is-open", !open);
  });
  // The cost bars live inside this body. Wiring them here rather than on the
  // toggle means a keyboard user can tab straight into a segment whether or
  // not the panel was opened by a click.
  if (window.HouseCostChart) window.HouseCostChart.wire(body);
}

/** Save + share, which now live in the persistent top bar. */
function wireFavShare(h, price) {
  const favBtn = document.getElementById("hdFavBtn");
  const shareBtn = document.getElementById("hdShareBtn");
  if (favBtn) favBtn.hidden = false;
  if (shareBtn) shareBtn.hidden = false;

  const paint = () => {
    if (!favBtn) return;
    const on = getFavs().has(h.id);
    favBtn.classList.toggle("is-on", on);
    favBtn.querySelector("svg")?.setAttribute("fill", on ? "currentColor" : "none");
    favBtn.setAttribute("aria-pressed", String(on));
  };
  paint();

  // Save-order is recorded alongside the set so the favourites page can sort by
  // "recently saved" without needing a per-id timestamp.
  favBtn?.addEventListener("click", () => {
    const favs = getFavs();
    let order;
    try { order = JSON.parse(localStorage.getItem("pawa_house_fav_order") || "[]"); }
    catch { order = []; }
    if (favs.has(h.id)) {
      favs.delete(h.id);
      order = order.filter(x => x !== h.id);
    } else {
      favs.add(h.id);
      order = order.filter(x => x !== h.id);
      order.push(h.id);
    }
    localStorage.setItem("pawa_house_favs", JSON.stringify([...favs]));
    localStorage.setItem("pawa_house_fav_order", JSON.stringify(order));
    paint();
  });

  shareBtn?.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?id=${h.id}`;
    const text = `${h.title} — ${price.value} ${price.unit} on Pawa Houses`;
    if (navigator.share) {
      try { await navigator.share({ title: h.title, text, url }); } catch (_) {}
      return;
    }
    // The Clipboard API fails on insecure contexts (http://, some in-app
    // browsers) and when the user has blocked clipboard access. Fall back to a
    // hidden <input> + execCommand("copy"), then to a prompt() the link can at
    // least be selected out of.
    try {
      await navigator.clipboard.writeText(url);
      alert(T("hd_copied", "Link copied to clipboard"));
    } catch (_) {
      try {
        const tmp = document.createElement("input");
        tmp.value = url;
        tmp.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(tmp);
        tmp.select();
        const ok = document.execCommand("copy");
        tmp.remove();
        if (ok) alert(T("hd_copied", "Link copied to clipboard"));
        else window.prompt(T("hd_copy_prompt", "Copy this link:"), url);
      } catch (_2) {
        window.prompt(T("hd_copy_prompt", "Copy this link:"), url);
      }
    }
  });
}

/**
 * The sticky action bar.
 *
 * Below 1024px this IS the contact row — the in-page one is hidden there — so
 * the encrypted door has to be here too, or it exists only for people on a
 * desktop. The bar also appears for a listing that has an owner but no phone
 * number, which used to leave a phone visitor with no way to ask at all.
 */
function wireSticky(h, stickyEl, ctx) {
  const { agentPhone, agentPhoneClean, waHref, meetCode } = ctx;
  const msgHref = window.PMReach ? window.PMReach.href(window.PMReach.ownerOf(h)) : "";
  if (!agentPhone && !msgHref) return;

  const stickyMsg = document.getElementById("hdStickyMsg");
  if (stickyMsg && msgHref) { stickyMsg.href = msgHref; stickyMsg.hidden = false; }

  const stickyCall = document.getElementById("hdStickyCall");
  const stickyWa   = document.getElementById("hdStickyWa");
  if (agentPhone) {
    stickyCall.href = `tel:${agentPhoneClean}`;
    stickyWa.href   = waHref;
  } else {
    // No number on the listing: two buttons pointing at nothing are worse than
    // two buttons that are not there.
    stickyCall.hidden = true;
    stickyWa.hidden = true;
  }
  document.getElementById("hdStickyMeet").href = `meet.html?${meetCode}`;
  stickyEl.hidden = false;
}

// ============================================================================
// Media gallery — scroll-snap carousel with prev/next, dots, thumbnails.
// Videos auto-pause when they scroll out of view to keep CPU + data usage sane.
// ============================================================================
function wireGallery(total) {
  const stage   = document.getElementById("hdGalleryStage");
  const prev    = document.getElementById("hdGalleryPrev");
  const next    = document.getElementById("hdGalleryNext");
  const counter = document.getElementById("hdGalleryCounter");
  const dots    = document.querySelectorAll(".hd-gallery-dot");
  const thumbs  = document.querySelectorAll("#hdGalleryThumbs .hd-gallery-thumb");
  if (!stage) return;

  let current = 0;

  function goTo(i) {
    current = Math.max(0, Math.min(total - 1, i));
    const slide = stage.children[current];
    if (slide) stage.scrollTo({ left: slide.offsetLeft, behavior: "smooth" });
    update();
  }
  function update() {
    if (counter) counter.textContent = `${current + 1} / ${total}`;
    dots.forEach((d, i)   => d.classList.toggle("active", i === current));
    thumbs.forEach((t, i) => t.classList.toggle("active", i === current));
    if (prev) prev.disabled = current <= 0;
    if (next) next.disabled = current >= total - 1;
    stage.querySelectorAll("video").forEach((v, i) => {
      if (i !== current) try { v.pause(); } catch (_) {}
    });
  }

  prev?.addEventListener("click", () => goTo(current - 1));
  next?.addEventListener("click", () => goTo(current + 1));
  thumbs.forEach(t => t.addEventListener("click", () => goTo(parseInt(t.dataset.i, 10))));

  // Scroll-snap on iOS triggers many `scroll` events — debounce + read the
  // currently-snapped slide based on scrollLeft / stage width.
  let scrollDebounce;
  stage.addEventListener("scroll", () => {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      const w = stage.clientWidth || 1;
      const i = Math.round(stage.scrollLeft / w);
      if (i !== current) { current = Math.max(0, Math.min(total - 1, i)); update(); }
    }, 60);
  }, { passive: true });

  stage.tabIndex = 0;
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft")  { e.preventDefault(); goTo(current - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); goTo(current + 1); }
  });

  update();
}

function hookSingleVideoAutopause(rootEl) {
  const v = rootEl.querySelector(".hd-gallery video");
  if (!v) return;
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) try { v.pause(); } catch (_) {}
  }, { threshold: 0.1 });
  io.observe(v);
}

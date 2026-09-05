// ============================================================================
//  Home bands  (index.html)
//  The trust strip: three counters, each read from real data.
//
//  This file used to drive two more bands, the Frame and the Earn pitch, each
//  rotating a line of copy every six seconds behind a progress bar. Both are
//  now plain cards that say one thing and hold still (css/action-cards.css),
//  so the rotator and its clock went with them.
//
//  The rule that is left is the important one: a counter never invents a
//  number. Every figure below is derived from something the app can point at,
//  the category catalogue it ships, the rows in public.regions, the verified
//  listings actually posted. A stat that resolves to zero is not padded and
//  not floored, it is REMOVED, because an empty claim is worse than a missing
//  one. As the marketplace fills, the tile comes back on its own.
// ============================================================================

(function () {
  const t = (k, f) => (window.t && window.t(k)) || f;

  const REDUCED = (() => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (_) { return false; }
  })();

  // The five regions of Zanzibar. public.regions holds all 31 regions of the
  // United Republic; the strip says "mainland", so it has to say 26. Matched
  // on the normalized name because the table has no mainland flag to read.
  const ZANZIBAR = new Set([
    "kaskazini pemba", "kaskazini unguja",
    "kusini pemba", "kusini unguja",
    "mjini magharibi",
  ]);
  const norm = (s) => String(s || "").trim().toLowerCase();

  // ==========================================================================
  //  1. Live stats
  // ==========================================================================

  // One provider, one entry. Prefer the account id; fall back to the typed
  // name so a lister who posted before accounts existed still counts once.
  // The prefix keeps an id and a name from ever colliding.
  function providerKey(row) {
    const id = row.owner_user_id;
    if (id) return "u:" + id;
    const name = norm(row.owner || row.agent);
    return name ? "n:" + name : "";
  }

  async function readStats() {
    const DS = window.DataStore;
    const stats = { categories: 0, regions: 0, providers: 0 };

    // Categories: the catalogue this marketplace actually offers, which is the
    // claim the label makes. Not "categories that happen to have a listing".
    stats.categories = (window.SERVICE_CATEGORIES || []).length;

    if (!DS) return stats;

    const [regions, houses, services, trucks] = await Promise.all([
      DS.getRegions().catch(() => null),
      DS.getHouses().catch(() => null),
      DS.getServices().catch(() => null),
      DS.getTrucks().catch(() => null),
    ]);

    if (Array.isArray(regions)) {
      stats.regions = regions.filter((r) => !ZANZIBAR.has(norm(r))).length;
    }

    const seen = new Set();
    [houses, services, trucks].forEach((rows) => {
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => {
        if (!row || !row.verified) return;
        const key = providerKey(row);
        if (key) seen.add(key);
      });
    });
    stats.providers = seen.size;

    return stats;
  }

  const COUNT_MS = 1400;

  function countUp(el, to) {
    const from = Number(el.dataset.shown) || 0;
    el.dataset.shown = String(to);
    if (REDUCED || from === to) { el.textContent = String(to); return; }
    const start = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - start) / COUNT_MS);
      el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // A tile shows only once its figure is both known and non-zero. Until then
  // it stays out of the strip entirely rather than standing there as a "0".
  function paintStats(root, stats, animate) {
    let shown = 0;
    root.querySelectorAll("[data-stat]").forEach((tile) => {
      const value = Number(stats[tile.dataset.stat]) || 0;
      const num = tile.querySelector(".ha-stat-num");
      if (!value || !num) { tile.hidden = true; return; }
      tile.hidden = false;
      shown++;
      if (animate) countUp(num, value);
      else { num.dataset.shown = String(value); num.textContent = String(value); }
    });
    root.hidden = shown === 0;
  }

  const REFRESH_MS = 5 * 60 * 1000;

  function wireTrust() {
    const root = document.querySelector(".ha-trust");
    if (!root) return;

    // Nothing is claimed until the real figures land.
    root.hidden = true;

    let last = 0;
    const refresh = async (animate) => {
      last = Date.now();
      let stats;
      try { stats = await readStats(); }
      catch (e) { console.warn("[home] stats", e); return; }
      paintStats(root, stats, animate);
    };

    // First paint waits for the strip to be on screen, so the count-up is
    // something the reader actually sees happen.
    //
    // What is watched is the 1px marker above the strip, NOT the strip. The
    // strip ships `hidden` and stays display:none until it has a figure, and
    // an element that is not laid out never intersects anything: observing it
    // was a deadlock that left the strip blank for the whole session. The
    // marker is always in flow, and sitting immediately above, it enters the
    // viewport a moment before the strip does, which is when the count should
    // start anyway.
    let armed = false;
    const arm = () => {
      if (armed) return;
      armed = true;
      refresh(true);
    };
    const mark = document.querySelector(".ha-trust-mark") || root;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        arm();
      });
    }, { threshold: 0 });
    io.observe(mark);

    // Auto-advancement: the figures re-read themselves while the page is open,
    // so a strip left on a phone all afternoon is not quoting the morning.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !armed) return;
      if (Date.now() - last > REFRESH_MS) refresh(true);
    });
    setInterval(() => {
      if (document.hidden || !armed) return;
      refresh(true);
    }, REFRESH_MS);
  }

  document.addEventListener("DOMContentLoaded", wireTrust);
})();

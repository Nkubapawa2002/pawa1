// ============================================================================
//  Home bands  (index.html)
//  The three self-advancing bands under the helper cards:
//
//    1. The Frame   — four lenses on an area, rotating one at a time
//    2. Earn        — the listing pitch, with a rotating proof line
//    3. Trust strip — three counters, each read from real data
//
//  Two rules hold this file together.
//
//  A counter never invents a number. Every figure below is derived from
//  something the app can point at: the category catalogue it ships, the rows
//  in public.regions, the verified listings actually posted. A stat that
//  resolves to zero is not padded and not floored, it is REMOVED, because an
//  empty claim is worse than a missing one. As the marketplace fills, the tile
//  comes back on its own.
//
//  A rotation never steals the reader. Advancement is driven by the progress
//  bar's own animationend, so pausing the bar pauses the band and the two can
//  never drift apart. Hover, focus, a hidden tab or a tap on any lens all stop
//  it, and prefers-reduced-motion means it never starts.
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
    let armed = false;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting || armed) return;
        armed = true;
        io.disconnect();
        refresh(true);
      });
    }, { threshold: 0.4 });
    io.observe(root);

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

  // ==========================================================================
  //  2. Rotator, shared by the Frame and the Earn band
  // ==========================================================================
  //  The progress bar IS the clock. Its CSS animation runs for the dwell time
  //  and its animationend advances the rotation, so "paused bar" and "paused
  //  rotation" are the same state and cannot disagree.
  // ==========================================================================

  //  `bar` is the track; the span inside it is the fill that actually animates.
  //  Both matter: the fill carries the clock, and the track is what a reader
  //  sees, so a rotation that has stopped for good hides the whole thing
  //  rather than leaving an empty groove that will never fill again.
  function makeRotator({ root, bar, count, show }) {
    const fill = bar && bar.querySelector("span");
    let index = 0;
    let pinned = false;

    const restart = () => {
      if (!fill || REDUCED || pinned) return;
      fill.style.animation = "none";
      void fill.offsetWidth;         // force reflow so the animation re-runs
      fill.style.animation = "";
      fill.style.animationPlayState = "running";
    };

    const go = (next, byHand) => {
      index = ((next % count) + count) % count;
      show(index);
      if (byHand) {
        // A tap is a decision. Stop moving under the reader's finger, and take
        // the clock away with it.
        pinned = true;
        if (fill) fill.style.animationPlayState = "paused";
        if (bar) bar.hidden = true;
      } else {
        restart();
      }
    };

    show(0);

    if (REDUCED || count < 2 || !fill) {
      if (bar) bar.hidden = true;
      return { go };
    }

    fill.addEventListener("animationend", () => go(index + 1, false));

    // Reading, hovering or tabbing through the band holds it still.
    const hold = () => { if (!pinned) fill.style.animationPlayState = "paused"; };
    const release = () => { if (!pinned) fill.style.animationPlayState = "running"; };
    root.addEventListener("pointerenter", hold);
    root.addEventListener("pointerleave", release);
    root.addEventListener("focusin", hold);
    root.addEventListener("focusout", release);
    document.addEventListener("visibilitychange", () => (document.hidden ? hold() : release()));

    restart();
    return { go };
  }

  // ==========================================================================
  //  3. The Frame band
  // ==========================================================================

  function wireFrame() {
    const root = document.getElementById("haFrame");
    if (!root) return;
    const tabs = [...root.querySelectorAll("[data-lens]")];
    const copy = document.getElementById("haFrameCopy");
    const bar = root.querySelector(".ha-frame-bar");
    if (!tabs.length || !copy) return;

    const show = (i) => {
      tabs.forEach((tab, n) => {
        const on = n === i;
        tab.classList.toggle("is-on", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
      });
      // Swapping data-i18n as well as the text keeps the language toggle
      // honest: applyTranslations() re-reads whichever lens is showing.
      const key = tabs[i].dataset.copy;
      copy.dataset.i18n = key;
      copy.textContent = t(key, "");
      if (REDUCED) return;
      copy.classList.remove("is-in");
      void copy.offsetWidth;
      copy.classList.add("is-in");
    };

    const rot = makeRotator({ root, bar, count: tabs.length, show });

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => rot.go(i, true));
      tab.addEventListener("keydown", (e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
                   : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = (i + step + tabs.length) % tabs.length;
        rot.go(next, true);
        tabs[next].focus();
      });
    });
  }

  // ==========================================================================
  //  4. The Earn band
  // ==========================================================================

  function wireEarn() {
    const root = document.getElementById("haEarn");
    if (!root) return;
    const line = document.getElementById("haEarnProof");
    const bar = root.querySelector(".ha-earn-bar");
    if (!line) return;

    const keys = (line.dataset.keys || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return;

    const show = (i) => {
      line.dataset.i18n = keys[i];
      line.textContent = t(keys[i], "");
      if (REDUCED) return;
      line.classList.remove("is-in");
      void line.offsetWidth;
      line.classList.add("is-in");
    };

    makeRotator({ root, bar, count: keys.length, show });
  }

  // ==========================================================================

  document.addEventListener("DOMContentLoaded", () => {
    wireFrame();
    wireEarn();
    wireTrust();
  });
})();

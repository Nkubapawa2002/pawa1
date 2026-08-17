// ============================================================================
//  find-mode.js — the "how do you want to find it?" prompt shown atop every
//  location-aware directory (houses, trucks, services, near-me).
//
//  Two distinct intents, two reasonings:
//    •  Near me        → fire the page's GPS button → rank by real distance.
//    •  A specific area → focus the search/area box → browse ANYWHERE in TZ by
//                          typing a town / district / ward (far from the user).
//
//  The markup lives in each page (a `.find-mode[data-near][data-area]` block,
//  hidden by default so no-JS users never see dead buttons); this wires it up
//  and reveals it. Dismissal is remembered per page for the session so it
//  greets once, then gets out of the way.
// ============================================================================
(function () {
  "use strict";
  function wire(p) {
    const nearId = p.dataset.near, areaId = p.dataset.area;
    const key = "fmDismiss:" + (p.id || nearId || "x");
    if (sessionStorage.getItem(key) === "1") { p.style.display = "none"; return; }
    p.style.display = "";   // reveal now that JS is here to make the buttons work
    const close = () => { try { sessionStorage.setItem(key, "1"); } catch (_) {} p.style.display = "none"; };
    p.querySelector(".fm-near")?.addEventListener("click", () => {
      document.getElementById(nearId)?.click();
      close();
    });
    p.querySelector(".fm-area")?.addEventListener("click", () => {
      const inp = document.getElementById(areaId);
      if (inp) {
        try { inp.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
        setTimeout(() => inp.focus(), 250);
      }
      close();
    });
    p.querySelector(".fm-x")?.addEventListener("click", close);
  }
  function injectCss() {
    if (document.getElementById("find-mode-css")) return;
    const s = document.createElement("style");
    s.id = "find-mode-css";
    s.textContent = `
      .find-mode{position:relative;background:linear-gradient(135deg,#0a6f4d,#075c39);color:#fff;border-radius:14px;padding:16px 18px 14px;margin:0 0 14px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
      .find-mode .fm-q{font-weight:700;font-size:1rem;margin:0 0 10px;padding-right:20px}
      .find-mode .fm-actions{display:flex;gap:10px;flex-wrap:wrap}
      .find-mode .fm-btn{flex:1;min-width:150px;text-align:left;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:10px;padding:12px 14px;cursor:pointer;font-weight:700;font-size:.95rem;display:flex;flex-direction:column;gap:3px}
      .find-mode .fm-btn small{font-weight:400;font-size:.78rem;opacity:.92}
      .find-mode .fm-btn:hover{background:rgba(255,255,255,.24)}
      .find-mode .fm-x{position:absolute;top:8px;right:10px;background:transparent;border:0;color:#fff;font-size:1.3rem;line-height:1;cursor:pointer;opacity:.85}`;
    document.head.appendChild(s);
  }
  function init() { injectCss(); document.querySelectorAll(".find-mode[data-near]").forEach(wire); }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();

// =====================================================================
// auth-ui.js — tiny, dependency-free helpers for auth.css surfaces.
// Auto-wires every <button class="auth-eye"> to show/hide the password
// input in the same .auth-input-wrap. Idempotent (safe to load anywhere,
// safe to call again after injecting markup). Exposes window.authMsg() for
// setting .auth-msg status boxes consistently.
// =====================================================================
(function () {
  function wireEyes(root) {
    (root || document).querySelectorAll(".auth-eye").forEach((btn) => {
      if (btn.dataset.authWired) return;
      btn.dataset.authWired = "1";
      btn.addEventListener("click", () => {
        const wrap = btn.closest(".auth-input-wrap") || btn.parentElement;
        const input = wrap && wrap.querySelector("input");
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-pressed", String(show));
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      });
    });
  }

  // Set an .auth-msg box. kind: "error" | "ok" | "" (clear/hide).
  function authMsg(el, kind, text) {
    if (!el) return;
    const node = typeof el === "string" ? document.getElementById(el) : el;
    if (!node) return;
    const mod = kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : "";
    node.className = "auth-msg" + (mod && text ? " " + mod + " is-show" : "");
    node.textContent = text || "";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => wireEyes());
  } else {
    wireEyes();
  }
  window.wireAuthEyes = wireEyes;
  window.authMsg = authMsg;
})();

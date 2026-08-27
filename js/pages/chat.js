// ============================================================================
//  js/pages/chat.js — the support page.
//
//  This file used to be the assistant: an "AI Assistant" tab, a "Voice AI" tab
//  with its own separate conversation, a system prompt, a tool loop and a
//  fallback chain — plus, incidentally, three phone numbers.
//
//  The assistant moved to PN-Zaki (js/lib/pn-zaki.js), inside P-Message, where
//  typing and speaking are one thread instead of two tabs. Everything that
//  held a key or spoke to a model went with it. What is left here is the one
//  thing that was never an assistant: how to reach a person.
//
//  So this file draws a list of contacts and nothing else. If you find
//  yourself adding a model call back into it, the thing you want is
//  window.PNZaki.
// ============================================================================

(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function t(key, fallback) {
    var s = window.t ? window.t(key) : key;
    return (!s || s === key) ? fallback : s;
  }

  var ICON = {
    person: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.8"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1A19.5 19.5 0 0 1 4.7 12 19.8 19.8 0 0 1 1.6 3.4 2 2 0 0 1 3.6 1.1h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L7.9 8.7a16 16 0 0 0 6 6l1-1a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7A2 2 0 0 1 21.7 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>',
  };

  // A phone number is the payload of this whole page, so it is rendered in the
  // mono face the rest of the site gives money and codes — the shape of the
  // digits is what somebody checks against the number they are dialling.
  window.renderSupportContacts = function () {
    var list = document.getElementById("supportContactsList");
    if (!list) return;
    var contacts = (window.APP_CONFIG && window.APP_CONFIG.SUPPORT_CONTACTS) || [];

    if (!contacts.length) {
      // No numbers configured is a deployment fact. Say it plainly rather than
      // drawing an empty box somebody will tap at.
      list.innerHTML = '<div class="sp-empty">' +
        esc(t("sp_none", "No support numbers are set up yet.")) + "</div>";
      return;
    }

    list.innerHTML = contacts.map(function (c) {
      var role = t(c.role, c.role);
      var tel = String(c.phone || "").replace(/\s+/g, "");
      return '<article class="sp-card">' +
        '<span class="sp-av">' + ICON.person + "</span>" +
        '<div class="sp-tx">' +
          '<span class="sp-role">' + esc(role) + "</span>" +
          '<span class="sp-name">' + esc(c.name || "") + "</span>" +
          '<span class="sp-phone">' + esc(c.phone || "") + "</span>" +
        "</div>" +
        '<div class="sp-acts">' +
          (tel ? '<a class="sp-btn is-call" href="tel:' + encodeURIComponent(tel) + '">' +
            ICON.phone + "<span>" + esc(t("support_call", "Call")) + "</span></a>" : "") +
          (c.whatsapp ? '<a class="sp-btn is-wa" href="https://wa.me/' + encodeURIComponent(c.whatsapp) +
            '" target="_blank" rel="noopener">' + ICON.whatsapp +
            "<span>" + esc(t("support_whatsapp", "WhatsApp")) + "</span></a>" : "") +
        "</div>" +
      "</article>";
    }).join("");
  };
})();

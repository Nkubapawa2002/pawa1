// ============================================================================
//  js/lib/pn-zaki-ui.js — everything PN-Zaki looks like.
//
//  The brain (js/lib/pn-zaki.js) has no DOM at all. This file is the other
//  half: the panel you land on, the way an answer is drawn, and the voice dock
//  that opens inside the conversation instead of on a screen of its own.
//
//  ONE CONVERSATION, TWO INPUTS. The old design had a "Voice AI" tab beside an
//  "AI Assistant" tab — two logs, two histories, and a spoken question whose
//  answer you could not scroll back to after switching tabs. Here voice is a
//  MODE of the one conversation: what you say and what PN-Zaki says land in
//  the same log as what you typed, in order, and survive the mic being turned
//  off. That is the reason the dock is a strip above the log rather than a
//  panel that replaces it.
//
//  WHY THE ORB ONLY MOVES WHEN SOMETHING IS HAPPENING. An assistant avatar
//  that pulses forever is decoration and teaches people to ignore it. This one
//  is still at rest, breathes while listening, and spins while thinking — so
//  the animation is the status, not the branding. `prefers-reduced-motion`
//  turns all of it off and the state badge carries the meaning alone, which is
//  why the badge always says the state in words too.
// ============================================================================

(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // A translator is passed in by the page so this file never reaches for a
  // global that may not be loaded yet.
  function tr(t) {
    return typeof t === "function" ? t : function (k, fb) { return fb; };
  }

  // --------------------------------------------------------------------------
  //  Drawing an answer
  //
  //  The model writes light Markdown and page names. Escaping happens FIRST
  //  and formatting second, so a reply containing "<script>" is text and a
  //  reply containing "**bold**" is bold — never the other way round.
  //
  //  Page names are linked because the whole job of this assistant is to end
  //  with a tap. "Browse homes on houses.html" that cannot be tapped is a
  //  sentence asking the reader to retype a filename.
  // --------------------------------------------------------------------------
  var PAGES = ["houses", "house", "services", "service", "trucks", "truck", "jobs",
               "near-me", "meet", "explore", "favorites", "login", "p-message",
               "p-chat", "profile", "agent-houses", "agent-services", "agent-trucks",
               "area", "share-location"];

  function format(text) {
    var html = esc(String(text == null ? "" : text));

    // Bold and inline code before anything that inserts tags of its own.
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, '<code class="pz-code">$1</code>');

    // TZS amounts get the mono treatment the rest of the site gives money.
    html = html.replace(/\bTZS\s?([\d,]+)/g, '<span class="pz-money">TZS $1</span>');

    // A page name becomes a link. The list is an allowlist on purpose: a model
    // that hallucinates "admin.html" must not be handed a link to it, and one
    // that writes an external URL must not be handed an anchor at all.
    html = html.replace(new RegExp("\\b(" + PAGES.join("|") + ")\\.html(\\?[\\w=&.,%-]*)?", "g"),
      function (m) { return '<a class="pz-link" href="' + m + '">' + m + "</a>"; });

    // Bullets: a run of "- " lines becomes one list. Done on the whole string
    // rather than per line so consecutive bullets do not each become a list of
    // one, which is what puts a gap between every item.
    html = html.replace(/(?:^|\n)((?:[-•*]\s+[^\n]*(?:\n|$))+)/g, function (_, block) {
      var items = block.trim().split(/\n/).map(function (line) {
        return "<li>" + line.replace(/^[-•*]\s+/, "") + "</li>";
      }).join("");
      return '<ul class="pz-list">' + items + "</ul>";
    });

    // Whatever newlines are left are line breaks, but never the ones the list
    // markup already consumed.
    html = html.replace(/\n{2,}/g, "<br/><br/>").replace(/\n/g, "<br/>");
    return html;
  }

  // --------------------------------------------------------------------------
  //  Icons — Lucide-style strokes, per the design system. No emoji in chrome.
  // --------------------------------------------------------------------------
  var ICON = {
    mic: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" stroke="currentColor" stroke-width="1.8"/><path d="M19 11v1a7 7 0 0 1-14 0v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 19v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12l16-8-7 16-2-6-7-2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1A19.5 19.5 0 0 1 4.7 12 19.8 19.8 0 0 1 1.6 3.4 2 2 0 0 1 3.6 1.1h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L7.9 8.7a16 16 0 0 0 6 6l1-1a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7A2 2 0 0 1 21.7 16z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  };

  // --------------------------------------------------------------------------
  //  The panel you land on
  //
  //  Three things, in the order somebody actually needs them: WHO this is and
  //  the two ways to talk to it; WHAT it can be asked, as taps rather than a
  //  blank box; and the one honest warning, which stays above the fold because
  //  it is the difference between this thread and every other one on the page.
  //
  //  Contact support is last and deliberately looks like an ordinary row: it
  //  is a phone number to a person, not a feature, and the only thing left on
  //  the old "voice agent and support" screen now that the assistant lives
  //  here.
  // --------------------------------------------------------------------------
  function renderPane(mount, opts) {
    if (!mount) return;
    opts = opts || {};
    var t = tr(opts.t);
    var last = opts.last || "";
    var canVoice = window.PNZaki && window.PNZaki.voiceAvailable();

    var caps = [
      { k: "pz_cap_room",   d: "A room in my budget",  q: t("pz_ask_room",   "I need a room to rent — what is there?") },
      { k: "pz_cap_fundi",  d: "Find me a fundi",      q: t("pz_ask_fundi",  "I need a fundi near me") },
      { k: "pz_cap_job",    d: "Day jobs today",       q: t("pz_ask_job",    "What day jobs are open right now?") },
      { k: "pz_cap_truck",  d: "A truck to move",      q: t("pz_ask_truck",  "I am moving house — which trucks are available?") },
      { k: "pz_cap_price",  d: "Is this a fair price?", q: t("pz_ask_price", "What does rent normally cost in my area?") },
      { k: "pz_cap_how",    d: "How does Pawa work?",  q: t("pz_ask_how",    "How does this site work?") },
    ];

    mount.innerHTML =
      '<section class="pz-hero">' +
        '<div class="pz-hero-top">' +
          '<span class="pz-orb" data-state="idle" aria-hidden="true"><i class="pz-orb-ring"></i><b class="pz-orb-mark">PZ</b></span>' +
          '<span class="pz-hero-tx">' +
            '<span class="pz-hero-name">' + esc(t("pm_ai_name", "PN-Zaki assistant")) +
              '<span class="pz-tag">' + esc(t("pz_tag", "AI")) + "</span>" +
              // Beside the name, not only in the paragraph below it. The
              // paragraph is what somebody reads once; the badge is what they
              // see every time, and this is the one thread on the page where
              // the word "encrypted" would be a lie.
              '<span class="pm-badge warn">' + esc(t("pm_badge_open", "Not encrypted")) + "</span></span>" +
            '<span class="pz-hero-sub">' + esc(last || t("pz_hero_sub",
              "Knows every listing, price and page on Pawa. Ask by typing, or talk to it.")) + "</span>" +
          "</span>" +
        "</div>" +
        '<div class="pz-hero-acts">' +
          '<button class="pz-cta" type="button" data-pz="open">' + ICON.spark +
            "<span>" + esc(t("pz_open", "Start asking")) + "</span></button>" +
          (canVoice
            ? '<button class="pz-cta is-ghost" type="button" data-pz="voice">' + ICON.mic +
              "<span>" + esc(t("pz_talk", "Talk to it")) + "</span></button>"
            : "") +
        "</div>" +
      "</section>" +

      '<div class="pz-caps-h">' + esc(t("pz_caps_h", "Try one of these")) + "</div>" +
      '<div class="pz-caps">' +
        caps.map(function (c) {
          return '<button class="pz-cap" type="button" data-pz-ask="' + esc(c.q) + '">' +
            esc(t(c.k, c.d)) + "</button>";
        }).join("") +
      "</div>" +

      '<div class="pm-note warn pz-warn">' + t("pm_ai_warn",
        "<b>PN-Zaki is not end-to-end encrypted.</b> A model that answers you has to read what you wrote. " +
        "Ask it about places, prices and how the site works — not about anything you would only tell one person.") +
      "</div>" +

      '<div class="pz-caps-h">' + esc(t("pz_human_h", "Rather talk to a person?")) + "</div>" +
      '<a class="pm-row pz-support" href="chat.html">' +
        '<span class="pm-av is-cast pz-av">' + ICON.phone + "</span>" +
        '<span class="pm-rtx">' +
          '<span class="pm-name">' + esc(t("pm_voice", "Contact support")) + "</span>" +
          '<span class="pm-sub">' + esc(t("pm_voice_d",
            "Call or WhatsApp a real person on the Pawa support line.")) + "</span>" +
        "</span>" +
      "</a>";

    // The pane is redrawn after every answer, so the handler is bound ONCE
    // and reads the latest options off the element. Re-binding on each draw is
    // how a single tap ends up sending the same question four times — the
    // accumulating-listener bug this repo has already paid for once.
    mount._pzOpts = opts;
    if (mount._pzBound) return;
    mount._pzBound = true;
    mount.addEventListener("click", function (e) {
      var o = mount._pzOpts || {};
      var askBtn = e.target.closest("[data-pz-ask]");
      if (askBtn) { o.onAsk && o.onAsk(askBtn.dataset.pzAsk); return; }
      var act = e.target.closest("[data-pz]");
      if (!act) return;
      if (act.dataset.pz === "open") o.onOpen && o.onOpen();
      if (act.dataset.pz === "voice") o.onVoice && o.onVoice();
    });
  }

  // --------------------------------------------------------------------------
  //  The conversation log
  //
  //  Rows are { role: "user"|"assistant", text, voice?: true }. A line that
  //  arrived by microphone is marked, because "did I say that or type it?" is
  //  a real question when scrolling back through a mixed conversation — and
  //  because a transcript is the model's best guess at what it heard, which
  //  deserves to look slightly less certain than a line somebody typed.
  // --------------------------------------------------------------------------
  function renderLog(mount, rows, opts) {
    if (!mount) return;
    opts = opts || {};
    var t = tr(opts.t);

    if (!rows || !rows.length) {
      mount.innerHTML =
        '<div class="pz-empty">' +
          '<span class="pz-orb is-big" data-state="idle" aria-hidden="true"><i class="pz-orb-ring"></i><b class="pz-orb-mark">PZ</b></span>' +
          "<h3>" + esc(t("pm_ai_name", "PN-Zaki assistant")) + "</h3>" +
          "<p>" + esc(t("pm_ai_empty",
            "Ask anything about the site, an area, or what a fair price looks like.")) + "</p>" +
        "</div>";
      return;
    }

    mount.innerHTML = rows.map(function (m) {
      var mine = m.role === "user";
      return '<div class="pm-msg pz-msg' + (mine ? " mine" : "") + (m.voice ? " is-voice" : "") + '">' +
        (m.voice ? '<span class="pz-voice-mark">' + ICON.mic +
          esc(t("pz_spoken", "spoken")) + "</span>" : "") +
        '<div class="pz-body">' + format(m.text) + "</div>" +
      "</div>";
    }).join("");

    if (opts.thinking) {
      mount.insertAdjacentHTML("beforeend",
        '<div class="pm-msg pz-msg pz-thinking"><span></span><span></span><span></span></div>');
    }
    mount.scrollTop = mount.scrollHeight;
  }

  // --------------------------------------------------------------------------
  //  The voice dock
  //
  //  A strip above the log, not a screen. Turning the mic on must not take
  //  away what was already said — the whole complaint about the old two-tab
  //  design — so the log stays exactly where it is and the dock is the only
  //  new thing on screen.
  //
  //  It is created once and reused. The mic button is the only control that
  //  changes shape (mic ↔ stop), because a separate "end" button beside a mic
  //  button is two ways to do one thing and people press the wrong one.
  // --------------------------------------------------------------------------
  var STATES = {
    idle:       { key: "pz_st_idle",   en: "Tap to talk",        hint: "pz_hint_idle",   hintEn: "PN-Zaki will listen and answer out loud." },
    connecting: { key: "pz_st_conn",   en: "Connecting",         hint: "pz_hint_conn",   hintEn: "Opening the line…" },
    listening:  { key: "pz_st_listen", en: "Listening",          hint: "pz_hint_listen", hintEn: "Speak now — Swahili or English." },
    thinking:   { key: "pz_st_think",  en: "Thinking",           hint: "pz_hint_think",  hintEn: "Looking it up…" },
    speaking:   { key: "pz_st_speak",  en: "Speaking",           hint: "pz_hint_speak",  hintEn: "Talk over it any time to interrupt." },
    error:      { key: "pz_st_err",    en: "Could not connect",  hint: "pz_hint_err",    hintEn: "Voice is unavailable right now. Typing still works." },
  };

  function attachVoice(opts) {
    opts = opts || {};
    var t = tr(opts.t);
    var dock = opts.dock;
    if (!dock) return null;

    dock.innerHTML =
      '<button class="pz-dock-mic" type="button" data-pz-mic aria-label="' +
        esc(t("pz_talk", "Talk to it")) + '">' +
        '<span class="pz-orb" data-state="idle" aria-hidden="true"><i class="pz-orb-ring"></i>' +
          '<b class="pz-orb-icon">' + ICON.mic + "</b></span>" +
      "</button>" +
      '<span class="pz-dock-tx">' +
        '<span class="pz-state" data-pz-state>' + esc(t(STATES.idle.key, STATES.idle.en)) + "</span>" +
        '<span class="pz-hint" data-pz-hint>' + esc(t(STATES.idle.hint, STATES.idle.hintEn)) + "</span>" +
      "</span>" +
      '<button class="pz-dock-x" type="button" data-pz-close aria-label="' +
        esc(t("pz_hide", "Hide voice")) + '">&times;</button>';

    var orb = dock.querySelector(".pz-orb");
    var stateEl = dock.querySelector("[data-pz-state]");
    var hintEl = dock.querySelector("[data-pz-hint]");
    var micBtn = dock.querySelector("[data-pz-mic]");
    var iconEl = dock.querySelector(".pz-orb-icon");

    function paint(state) {
      var s = STATES[state] || STATES.idle;
      dock.dataset.state = state;
      if (orb) orb.dataset.state = state;
      if (stateEl) stateEl.textContent = t(s.key, s.en);
      if (hintEl) hintEl.textContent = t(s.hint, s.hintEn);
      if (iconEl) iconEl.innerHTML = (state === "idle" || state === "error") ? ICON.mic : ICON.stop;
      if (opts.onState) opts.onState(state);
    }

    async function toggle() {
      if (!window.PNZaki) return;
      if (window.PNZaki.voiceActive()) { window.PNZaki.stopVoice(); paint("idle"); return; }
      dock.hidden = false;
      paint("connecting");
      await window.PNZaki.startVoice({
        onTranscript: function (role, text) { opts.onLine && opts.onLine(role, text); },
        onState: paint,
      });
    }

    micBtn && micBtn.addEventListener("click", toggle);
    dock.querySelector("[data-pz-close]").addEventListener("click", function () {
      window.PNZaki && window.PNZaki.stopVoice();
      paint("idle");
      dock.hidden = true;
      opts.onHide && opts.onHide();
    });

    paint("idle");
    dock.hidden = true;

    return {
      // Showing the dock does NOT open the microphone. Two taps, on purpose:
      // a page that starts recording because a thread was opened is a page
      // nobody should trust with a microphone.
      show: function () { dock.hidden = false; paint(window.PNZaki && window.PNZaki.voiceActive() ? "listening" : "idle"); },
      hide: function () { window.PNZaki && window.PNZaki.stopVoice(); dock.hidden = true; paint("idle"); },
      toggle: toggle,
      visible: function () { return !dock.hidden; },
    };
  }

  window.PNZakiUI = { renderPane: renderPane, renderLog: renderLog, attachVoice: attachVoice,
                      format: format, ICON: ICON };
})();

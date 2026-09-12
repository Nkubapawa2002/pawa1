// ============================================================================
//  notify-mute.js — "stop telling me about this", and where that is written.
//
//  WHY THIS IS ITS OWN FILE, AND NOT PART OF js/core/notify.js.
//  Three places need to know whether a kind of news is switched off:
//
//    the bell        js/core/notify.js, which counts it
//    the settings    js/pages/profile.js, which offers it back
//    the banner      js/pages/houses.js, which raises a bar across the top of
//                    the listings page and can fire an operating-system
//                    notification, neither of which goes through the bell
//
//  Only the first of those wants the notification ENGINE. notify.js polls four
//  catalogues every two minutes, opens realtime channels and keeps a cache;
//  loading all of that onto Profile so it can read one boolean, or onto the
//  houses page so it can decide whether to draw a bar, would be paying for a
//  subscription to answer a question. So the question lives here, in a file
//  with no network in it, and notify.js delegates to it.
//
//  THE LINE THIS DRAWS IS THE WHOLE DESIGN: you may mute news about the
//  CATALOGUE, never a person. houses, services, trucks and jobs are the app
//  noticing that strangers posted things. An unread message, being added to a
//  room, a note from the admin, a customer waiting for a call and a safety
//  number that changed are all somebody addressing YOU. A switch that silences
//  those is not a preference, it is a way to miss the only things on the panel
//  that were meant for you — so they are not offered here and must not be
//  added.
//
//  It shares one localStorage key with the bell (`pawa_notify_seen`) rather
//  than opening a second: that object already holds `billingOff`, which was
//  the only dismissal in the app that persisted correctly, and this is the
//  same kind of fact about the same device. One key, one thing to clear.
// ============================================================================
(function () {
  "use strict";

  var SEEN_KEY = "pawa_notify_seen";

  var MUTABLE = { houses: true, services: true, trucks: true, jobs: true };

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }

  function write(next) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch (_) {}
  }

  /** Is this kind switched off on this device? Unknown keys are never muted. */
  function isMuted(key) {
    if (!MUTABLE[key]) return false;
    var s = read();
    return !!(s && s.off && s.off[key]);
  }

  /** Everything currently off, so a settings screen can offer it back. */
  function mutedKeys() {
    var s = read();
    return Object.keys(MUTABLE).filter(function (k) {
      return !!(s && s.off && s.off[k]);
    });
  }

  /**
   * Switch one kind off, or back on. Returns false for anything that is not
   * mutable, so a caller cannot quietly silence a person by passing the wrong
   * key.
   *
   * It writes into whatever object is already under the key, creating one only
   * if there is none: the bell keeps its watermarks in the same place, and
   * replacing the object wholesale would reset "what have I already seen" as a
   * side effect of switching something off.
   */
  function setMuted(key, on) {
    if (!MUTABLE[key]) return false;
    var s = read() || {};
    s.off = s.off || {};
    if (on) s.off[key] = true; else delete s.off[key];
    write(s);
    try {
      window.dispatchEvent(new CustomEvent("pawa:notifymute", {
        detail: { key: key, muted: !!on },
      }));
    } catch (_) {}
    return true;
  }

  window.NotifyMute = {
    MUTABLE: MUTABLE,
    isMutable: function (key) { return !!MUTABLE[key]; },
    isMuted: isMuted,
    mutedKeys: mutedKeys,
    setMuted: setMuted,
  };
})();

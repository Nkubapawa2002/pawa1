// =====================================================================
// analytics.js — PostHog product analytics
// ---------------------------------------------------------------------
// Loaded dynamically by js/config.js ONLY when APP_CONFIG.POSTHOG_KEY is set,
// so when analytics is disabled nothing here runs and nothing is sent.
//
// Exposes a tiny, provider-agnostic facade so the rest of the app never
// touches PostHog directly (makes it swappable later):
//     window.Analytics.capture(event, props)
//     window.Analytics.identify(userId, props)
//     window.Analytics.reset()
//
// It auto-ties events to the signed-in user. That currently reads the Supabase
// session; if/when auth moves to Clerk, only the identify() wiring at the
// bottom needs to change.
// =====================================================================
(function () {
  var cfg = window.APP_CONFIG || {};
  var KEY = cfg.POSTHOG_KEY;
  if (!KEY) return; // disabled — should not happen (config.js guards), but be safe

  // ---- Official PostHog loader stub (queues calls until array.js loads) ----
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(KEY, {
    api_host: cfg.POSTHOG_HOST || "https://us.i.posthog.com",
    person_profiles: "identified_only", // only create profiles for signed-in users
    capture_pageview: true,             // SPA-ish nav is rare here; per-page load is fine
    autocapture: true,                  // clicks / form submits without manual events
    persistence: "localStorage+cookie",
  });

  // ---- Provider-agnostic facade (replaces the no-op shim from config.js) ----
  window.Analytics = {
    capture: function (event, props) { try { window.posthog.capture(event, props || {}); } catch (_) {} },
    identify: function (id, props) { try { window.posthog.identify(id, props || {}); } catch (_) {} },
    reset: function () { try { window.posthog.reset(); } catch (_) {} },
  };

  // ---- Tie events to the signed-in user --------------------------------
  // NOTE: change this block if auth moves to Clerk (use the Clerk user id).
  (async function () {
    try {
      var session = (window.Auth && window.Auth.getSession) ? await window.Auth.getSession() : null;
      if (session && session.user) {
        window.Analytics.identify(session.user.id, { email: session.user.email });
      }
      var sb = window.SB || (window.DataStore && window.DataStore.sb);
      if (sb && sb.auth && sb.auth.onAuthStateChange) {
        sb.auth.onAuthStateChange(function (evt, sess) {
          if (evt === "SIGNED_IN" && sess && sess.user) {
            window.Analytics.identify(sess.user.id, { email: sess.user.email });
          } else if (evt === "SIGNED_OUT") {
            window.Analytics.reset();
          }
        });
      }
    } catch (_) {}
  })();
})();

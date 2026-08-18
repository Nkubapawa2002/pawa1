/* ===========================================================================
 * admin-video-space.js — the "Video space" tab in admin.html.
 *
 * Two jobs:
 *   1. Manage the DEFAULT video each region falls back to when no community
 *      video is live. One per region, plus a global fallback (region = null).
 *   2. Show what is live right now, with a way to pull something down.
 *
 * Admin writes go through the region_video_defaults table directly — RLS gates
 * them on is_admin(), so a non-admin who loads this file gets nothing but
 * permission errors. The upload still passes through the same validate/normalise
 * path as a public post, because a 40-minute default would break the space just
 * as thoroughly as a 40-minute community clip.
 * =========================================================================== */
(function () {
  "use strict";

  var VS = window.VideoSpace;
  var panel = document.getElementById("tab-videospace");
  if (!VS || !panel) return;

  var els = {
    region:  document.getElementById("vsAdminRegion"),
    upload:  document.getElementById("vsAdminUpload"),
    clear:   document.getElementById("vsAdminClear"),
    file:    document.getElementById("vsAdminFile"),
    status:  document.getElementById("vsAdminStatus"),
    note:    document.getElementById("vsAdminNote"),
    list:    document.getElementById("vsAdminList"),
    refresh: document.getElementById("vsAdminRefresh"),
    badge:   document.getElementById("vsAdminBadge"),
  };

  var BUCKET = (window.APP_CONFIG && window.APP_CONFIG.REGION_VIDEOS_BUCKET) || "region-videos";
  var loaded = false;

  function sb() { return window.SB || null; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function say(msg, isErr) {
    if (!els.status) return;
    els.status.textContent = msg || "";
    els.status.style.color = isErr ? "#b3261e" : "";
  }
  function note(msg) {
    if (!els.note) return;
    els.note.textContent = msg || "";
    els.note.hidden = !msg;
  }
  function fmt(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isFinite(d.getTime()) ? d.toLocaleString() : "—";
  }

  // ---- Regions --------------------------------------------------------------
  async function loadRegions() {
    var client = sb();
    if (!client || !els.region) return;
    var res = await client.from("regions").select("name").order("name");
    if (res.error) return;
    // Keep the "global" option at the top; append every region after it.
    (res.data || []).forEach(function (r) {
      var o = document.createElement("option");
      o.value = r.name;
      o.textContent = r.name;
      els.region.appendChild(o);
    });
  }

  // ---- Render ---------------------------------------------------------------
  async function load() {
    var client = sb();
    if (!client) return;
    note("");

    var live = await client
      .from("region_videos")
      .select("id, region, status, storage_path, published_at, expires_at, duration_s, bytes")
      .eq("status", "live")
      .gt("expires_at", new Date().toISOString())
      .order("published_at", { ascending: false });

    var defs = await client
      .from("region_video_defaults")
      .select("id, region, storage_path, label, updated_at")
      .order("region", { nullsFirst: true });

    if (live.error || defs.error) {
      note("Couldn't load the video space: " + ((live.error || defs.error).message));
      return;
    }

    var liveRows = live.data || [];
    var defRows = defs.data || [];
    if (els.badge) els.badge.textContent = liveRows.length ? String(liveRows.length) : "";

    var html = "";

    html += '<h4 style="margin:14px 0 6px;">Live now (' + liveRows.length + ')</h4>';
    if (!liveRows.length) {
      html += '<p class="hint" style="margin:0 0 14px;">Nothing is live — every region is showing its default.</p>';
    } else {
      html += '<div class="aa-list">';
      liveRows.forEach(function (r) {
        html +=
          '<div class="aa-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.07);">' +
            '<video src="' + esc(VS.publicUrl(r.storage_path)) + '" muted playsinline preload="metadata" ' +
              'style="width:78px;height:104px;object-fit:cover;border-radius:8px;background:#111;"></video>' +
            '<div style="flex:1;min-width:180px;">' +
              '<strong>' + esc(r.region) + '</strong><br>' +
              '<span class="hint">posted ' + esc(fmt(r.published_at)) +
              ' · expires ' + esc(fmt(r.expires_at)) +
              (r.duration_s ? ' · ' + Math.round(r.duration_s) + 's' : '') +
              (r.bytes ? ' · ' + (r.bytes / 1048576).toFixed(1) + ' MB' : '') +
              '</span>' +
            '</div>' +
            '<button class="btn btn-outline btn-sm" data-pull="' + esc(r.id) + '" ' +
              'data-path="' + esc(r.storage_path) + '" type="button">Take down</button>' +
          '</div>';
      });
      html += '</div>';
    }

    html += '<h4 style="margin:18px 0 6px;">Defaults (' + defRows.length + ')</h4>';
    if (!defRows.length) {
      html += '<p class="hint" style="margin:0;">No default set. Regions with no community video show the ' +
              '"be the first" invitation instead — set a global default so there is always something playing.</p>';
    } else {
      html += '<div class="aa-list">';
      defRows.forEach(function (d) {
        html +=
          '<div class="aa-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.07);">' +
            '<video src="' + esc(VS.publicUrl(d.storage_path)) + '" muted playsinline preload="metadata" ' +
              'style="width:78px;height:104px;object-fit:cover;border-radius:8px;background:#111;"></video>' +
            '<div style="flex:1;min-width:180px;">' +
              '<strong>' + esc(d.region || "Global default") + '</strong><br>' +
              '<span class="hint">updated ' + esc(fmt(d.updated_at)) + '</span>' +
            '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    if (els.list) els.list.innerHTML = html;
  }

  // ---- Take down a live video ----------------------------------------------
  async function pull(id, path) {
    var client = sb();
    if (!client) return;
    if (!confirm("Take this video down? The region falls back to its default immediately.")) return;
    say("Removing…");
    // Deleting the row frees the slot at once — the partial unique index only
    // counts claiming/live rows, so the next person can post straight away.
    var del = await client.from("region_videos").delete().eq("id", id);
    if (del.error) { say("Couldn't remove it: " + del.error.message, true); return; }
    if (path) await client.storage.from(BUCKET).remove([path]).catch(function () {});
    say("Removed.");
    load();
  }

  // ---- Set / clear the default ---------------------------------------------
  async function setDefault(file) {
    var client = sb();
    if (!client || !file) return;
    var region = els.region.value || null;
    var label = region || "Global default";

    say("Checking the video…");
    try {
      await VS.validate(file);           // same gate as a public post
    } catch (err) {
      say(err.message, true);
      return;
    }

    say("Preparing…");
    var norm = await VS.normalize(file);
    if (!norm.ok) {
      // A default is set rarely and deliberately, so unlike a public post we
      // refuse rather than quietly storing an unprocessed file that might be
      // over the cap or slow to start.
      say("The video gateway is unreachable — wait a moment and try again.", true);
      return;
    }

    say("Uploading…");
    var session = await client.auth.getSession();
    var uid = session && session.data && session.data.session && session.data.session.user
      ? session.data.session.user.id : null;
    if (!uid) { say("Sign in again — your session expired.", true); return; }

    var ext = norm.file.type === "video/webm" ? "webm" : "mp4";
    var path = uid + "/default-" + (region ? region.replace(/\W+/g, "-").toLowerCase() : "global") +
               "-" + Date.now() + "." + ext;
    var up = await client.storage.from(BUCKET).upload(path, norm.file, {
      contentType: norm.file.type || "video/mp4", upsert: false,
    });
    if (up.error) { say("Upload failed: " + up.error.message, true); return; }

    // Find the row this replaces so its blob can be cleaned up afterwards.
    // `region is null` needs .is(), not .eq() — PostgREST treats them differently
    // and .eq("region", null) would match nothing.
    var lookup = client.from("region_video_defaults").select("id, storage_path");
    lookup = region === null ? lookup.is("region", null) : lookup.eq("region", region);
    var existing = (await lookup.maybeSingle()).data || null;

    var row = { region: region, storage_path: path, label: label, updated_by: uid, updated_at: new Date().toISOString() };
    var write = existing
      ? await client.from("region_video_defaults").update(row).eq("id", existing.id)
      : await client.from("region_video_defaults").insert(row);

    if (write.error) {
      await client.storage.from(BUCKET).remove([path]).catch(function () {});
      say("Couldn't save the default: " + write.error.message, true);
      return;
    }
    if (existing && existing.storage_path && existing.storage_path !== path) {
      await client.storage.from(BUCKET).remove([existing.storage_path]).catch(function () {});
    }

    say(norm.trimmed ? "Default set — trimmed to 2m39s." : "Default set.");
    load();
  }

  async function clearDefault() {
    var client = sb();
    if (!client) return;
    var region = els.region.value || null;
    if (!confirm("Remove the " + (region || "global") + " default video?")) return;

    var q = client.from("region_video_defaults").select("id, storage_path");
    q = region === null ? q.is("region", null) : q.eq("region", region);
    var found = await q.maybeSingle();
    if (found.error || !found.data) { say("There's no default set for that.", true); return; }

    var del = await client.from("region_video_defaults").delete().eq("id", found.data.id);
    if (del.error) { say("Couldn't remove it: " + del.error.message, true); return; }
    if (found.data.storage_path) {
      await client.storage.from(BUCKET).remove([found.data.storage_path]).catch(function () {});
    }
    say("Default removed.");
    load();
  }

  // ---- Wire up --------------------------------------------------------------
  if (els.upload && els.file) {
    els.upload.addEventListener("click", function () { els.file.click(); });
    els.file.addEventListener("change", async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) await setDefault(f);
    });
  }
  if (els.clear)   els.clear.addEventListener("click", clearDefault);
  if (els.refresh) els.refresh.addEventListener("click", load);

  if (els.list) {
    els.list.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-pull]");
      if (btn) pull(btn.getAttribute("data-pull"), btn.getAttribute("data-path"));
    });
  }

  // Load on first reveal. admin.js owns the tab switching, so watch the panel's
  // `hidden` attribute rather than duplicating its click wiring.
  var mo = new MutationObserver(function () {
    if (!panel.hidden && !loaded) {
      loaded = true;
      loadRegions().then(load);
    }
  });
  mo.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  if (!panel.hidden) { loaded = true; loadRegions().then(load); }
})();

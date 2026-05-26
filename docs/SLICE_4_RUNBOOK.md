# Slice 4 — Phone-first compaction runbook

This slice converts Pawa from a desktop-first website with mobile-friendly bits into a **phone-first installable app**. Most Tanzanian customers are on phones, and most agent interactions (book a seat, send a parcel, track, talk to PAWA) happen with one thumb — the UI now reflects that.

---

## What landed

**Installable app shell**
- `bus web/manifest.json` — app metadata + 4 home-screen shortcuts (Book, Send, Chat, Track).
- `bus web/icons/icon-maskable.svg` — single SVG icon (any + maskable purpose).
- `bus web/service-worker.js` — precache app shell, network-first for HTML, stale-while-revalidate for static assets, pass-through for cross-origin (Supabase, Anthropic, n8n).
- `bus web/js/sw-register.js` — registers the SW silently.

**Phone navigation**
- `bus web/js/mobile-nav.js` — sticky bottom tab bar, 5 destinations (Home, Book, Send, Chat, Account). Visible on ≤700 px only; desktop nav stays.
- `bus web/css/mobile.css` — bottom-nav styles, iOS safe-area handling, fluid type, tappable button heights, single-column form/grid collapse on phones.

**Universal agent FAB**
- `bus web/js/fab.js` — floating "Talk to PAWA" button on every page. Tapping opens a slide-up sheet that talks to `/functions/v1/agent-chat`. Tenant context flows through automatically. The same script also wires the **Install Pawa** prompt on Android Chrome.

**Per-page mobile polish**
- Chat page becomes a true messaging app on phones: hero collapses, container fills the viewport, composer is sticky above the bottom nav, tap targets are 44 px.
- Hero CTAs stack to full-width.
- Tables become horizontally scrollable instead of overflowing.

**Wiring**
- `scripts/wire_mobile_into_pages.js` — idempotent injector that added the manifest link, mobile metadata, `mobile.css`, `data-page="<file>"` body attribute, and three end-of-body scripts (`mobile-nav.js`, `fab.js`, `sw-register.js`) to all 18 HTML pages in one pass.

---

## How to test

### 1. Local sanity check (desktop browser)

```bash
node serve.js   # whatever your dev server is
# Open http://localhost:<port>/index.html
```

In Chrome DevTools:
- **Application → Manifest** — should show "Pawa Bus Cargo" + 4 shortcuts + the SVG icon.
- **Application → Service Workers** — should show `service-worker.js` activated for the origin.
- **Lighthouse** → Mobile / PWA — expect a green "Installable" verdict.

### 2. Phone test

The proper test is on a phone. Easiest paths:

- **Android Chrome:** open the site, tap **⋮ → Add to Home screen** (or wait for the in-app *Install Pawa* button to appear, which we render on `beforeinstallprompt`).
- **iOS Safari:** open the site, tap the share icon → **Add to Home Screen**. The icon comes from `apple-touch-icon` (the same SVG).
- After install, launch from the home-screen icon. The address bar disappears (`display: standalone`).

### 3. Smoke checklist on phone

| Check | Expected |
|---|---|
| Bottom tab bar visible | Yes, sticky, 5 tabs, active tab highlighted |
| Top desktop dropdowns | Hidden (only the brand + hamburger remain) |
| Tap any tab | Page navigates, active state moves |
| Tap "Talk to PAWA" FAB | Slide-up sheet opens with PAWA greeting in Swahili by default |
| Type a message in the FAB sheet | Posts to `agent-chat`, reply shows up |
| Open `/chat.html` | Hero is hidden, full-height messaging layout, composer sticky |
| Open `/dashboard.html` | Forms render single-column, color picker works |
| Open `/saas.html` | Hero collapses cleanly, CTAs stack |
| iOS notch / home indicator | Content not clipped; bottom nav respects safe-area |
| Reload in airplane mode | App shell still loads (precached); tool calls fail gracefully |

### 4. Disable the service worker (if it ever misbehaves)

The cleanest way to drop it in development:

- Chrome DevTools → **Application → Service Workers** → **Unregister**.
- Then refresh.

To kill it in production for everyone:

```js
// Add this to a temporary build of service-worker.js, redeploy, then delete the file:
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()
    .then(clients => clients.forEach(c => c.navigate(c.url)))));
});
```

---

## Architecture notes

- **The desktop nav and the bottom nav coexist.** They're two views of the same set of destinations; CSS media queries hide whichever doesn't apply. No JS toggling, no state to keep in sync.
- **The FAB is universal.** It's the same code on every page; the chat page itself hides the FAB so we don't show "open chat" inside chat.
- **The agent endpoint is one URL.** `chat.html` and the FAB sheet both POST to `/functions/v1/agent-chat` with `tenant_slug`. There's no second code path to maintain.
- **The service worker never caches Supabase / Anthropic / n8n calls.** All cross-origin GETs pass through. The SW only handles our own static files and HTML, so live data stays live.
- **Install prompt is opportunistic.** We don't badger anyone — `beforeinstallprompt` only fires when Chrome's heuristics decide the user is engaged enough.

---

## Rollback

Slice 4 is purely additive. To remove:

```bash
# 1. Stop registering the service worker (immediate effect for new visitors)
rm bus\ web/js/sw-register.js

# 2. Remove the script tags & mobile bundle on each page
# Run this small undo:
node -e "
const fs=require('fs'),path=require('path');
const root='bus web';
fs.readdirSync(root).filter(f=>f.endsWith('.html')).forEach(f=>{
  const p=path.join(root,f);
  let s=fs.readFileSync(p,'utf8');
  s=s.replace(/\\s*<link rel=\"manifest\".*?<!-- pawa-mobile-bundle -->/s,'');
  s=s.replace(/\\s*<script src=\"js\\/mobile-nav.js\"><\\/script>[\\s\\S]*?<!-- pawa-mobile-bundle -->/g,'');
  s=s.replace(/<body([^>]*) data-page=\"[^\"]+\"/,'<body\$1');
  fs.writeFileSync(p,s);
});
"

# 3. Tell currently-installed clients to bin their cache by pushing the
#    'kill' service-worker shown above for one deploy, then delete the file.
```

Encrypted-key, tenant, and agent infrastructure (Slices 1–3) are untouched.

---

## What's next (Slice 5 preview)

1. **Push notifications** — VAPID keys in tenant_settings, browser subscription on login, agent triggers `notify_user(tenant_slug, user_id, msg)` to ping someone after a payment confirmation, ETA update, or scheduled reminder fire.
2. **Voice input on phone** — wire Web Speech API into the FAB sheet so the customer can hold-to-talk to PAWA without typing.
3. **Native share / contact picker** — `navigator.share()` for tracking codes, `navigator.contacts.select()` to pick a passenger.
4. **Phase-2 RLS lockdown** (carryover from Slice 3 preview).

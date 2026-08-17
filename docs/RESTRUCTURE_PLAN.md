# Restructure Plan — structure first, errors to zero, then features

Status: **setup complete, awaiting go-ahead on Phase 1**
Baseline measured: 2026-08-17

---

## Why this order

Adding the self-hosted map stack to a codebase we can't cleanly reason about
would bury the new work in existing noise. So: arrange the code first, drive
errors to zero, *then* build features. This document is the plan and the
running record.

---

## The instrument

Three read-only audit scripts. They are the source of truth — every claim
below is a measurement, not an impression. Re-run them after every phase; if a
number moves the wrong way, the phase gets reverted.

| Script | Answers |
|---|---|
| `scripts/audit/structure.mjs` | broken refs, orphan scripts, duplicate globals, oversized files, CDN deps |
| `scripts/audit/runtime.mjs` | what actually breaks when each page runs in headless Chrome |
| `scripts/audit/ownership.mjs` | which page owns which script; how SQL and scripts cluster |

```bash
node scripts/audit/structure.mjs
node scripts/audit/runtime.mjs
node scripts/audit/ownership.mjs
```

Each writes JSON to `audit/` so runs can be diffed.

---

## Baseline (measured, 2026-08-17)

### Healthier than expected

| Check | Result |
|---|---|
| JS syntax errors | **0** of 109 live files |
| Broken local references | **0** |
| Pages that boot clean | **22 of 22** |
| Distinct runtime causes | **3** (1 missing favicon, 2 benign teardown artifacts) |

The runtime harness was verified against a real boot: 49 external resources
loaded, MapLibre + Leaflet + Supabase all initialized, map canvas rendered.
The clean result is real, not a silent failure to launch.

**Consequence: the "hundreds of errors" are not at page load.** They live in
one of the places the harness does not yet reach — see *Open question* below.

### The actual structural debt

| Problem | Count | Detail |
|---|---|---|
| Deleted-but-tracked files | 48 | bus-era leftovers still in git index |
| Uncommitted modifications | 16 | working tree never settled |
| Oversized files (>800 lines) | 18 | `styles.css` 4715, `houses.js` 3366, `agent-houses.js` 2781, `meet.js` 2447, `i18n.js` 2321 |
| Orphan scripts | 4 | `analytics.js`, `auth-clerk.js`, `fab.js`, `mobile-nav.js` — loaded by no page |
| Duplicate globals | 2 | `window.Auth` (auth.js + auth-clerk.js), `window.Analytics` (analytics.js + config.js) |
| Flat SQL files | 53 | one directory, 11 topics mixed together |
| Flat one-off scripts | 36 | one directory, 6 roles mixed together |
| Stale project doc | 1 | `CLAUDE.md` documents a **bus cargo** app; this is now a houses/trucks/services/jobs marketplace |

---

## Hard constraints

These are not preferences — violating them breaks production.

1. **HTML pages stay at repo root.** GitHub Pages serves from root with no
   build step. Moving them rewrites every public URL.
2. **`share-location.html` cannot move or be renamed.** Links of the form
   `share-location.html?c=<CODE>` have already been sent to real users.
3. **`manifest.json`, `service-worker.js`, and the icon paths stay put.** The
   PWA install contract and Capacitor's `webDir` depend on them.
4. **No build step may be introduced.** Static hosting is the deployment model.

---

## Target structure

Grouping by *role*, which the ownership data already proves out.

### `js/` — 55 files, currently flat

Ownership analysis puts every file cleanly into one of four buckets:

```
js/
├── core/        9 files loaded by ~all pages
│                config.js data.js auth.js i18n.js nav.js
│                theme.js app-shell.js sw-register.js premium.js
│
├── lib/        14 shared feature libraries (2–12 pages each)
│                geo.js geolocate.js geo-poly.js tz-places.js
│                area-boundary.js map-expand.js find-mode.js fx.js
│                ai.js ai-search.js auth-ui.js agent-profile.js
│                agent-demand-board.js request-place.js
│
├── pages/      28 page controllers, exactly one page each
│                houses.js house.js trucks.js truck.js services.js
│                service.js jobs.js meet.js admin.js …
│
└── _quarantine/ 4 orphans — kept one release, then deleted
                 analytics.js auth-clerk.js fab.js mobile-nav.js
```

Cost: `<script src>` paths update across 22 HTML files. Mechanical, and
`structure.mjs` proves correctness — broken refs must stay at 0.

### `supabase/` — 53 SQL files, currently flat

No code references these paths (they are run by hand), so this move is
zero-risk.

```
supabase/
├── schema/      schema_master.sql seed.sql audit_and_fix.sql
├── features/
│   ├── house/   14 files
│   ├── agent/   12 files
│   ├── truck/   2   service/ 1   job/ 1   meet/ 2
├── auth/        3 files
├── fixes/       6 files
├── functions/   (unchanged — edge functions)
└── archive/     (unchanged)
```

### `scripts/` — 36 files, currently flat

```
scripts/
├── audit/       structure.mjs runtime.mjs ownership.mjs probe.mjs
├── build/       6 files   build_app.mjs make_icons.mjs inject_theme.mjs …
├── upload/      6 files
├── db/          7 files   db_audit.mjs verify_* rls_anon_probe.mjs
├── media/       2 files   faststart_*
└── archive/     9 spent one-off migrations
```

---

## Phases

Each phase ends with all three audits re-run. Broken refs must be 0 and pages
booting must stay 22/22 before the next phase starts.

| # | Phase | Risk | Why this order |
|---|---|---|---|
| 1 | Settle the working tree — commit the 48 deletions and 16 modifications | none | Cannot measure change against a dirty tree |
| 2 | Reorganize `supabase/` and `scripts/` | none | Nothing references these paths |
| 3 | Reorganize `js/` into core/lib/pages, update 22 HTML files | low | Verified by the harness |
| 4 | Resolve orphans + duplicate globals | low | Removes real collision risk |
| 5 | Rewrite `CLAUDE.md` to describe the actual product | none | Every future session reads this file |
| 6 | Split the 18 oversized files | medium | Genuine refactor — do last, one file at a time |

Phase 6 is where real regressions could hide, which is exactly why it comes
after the harness is trusted and the tree is clean.

---

## Open question — where are the errors?

The measured baseline says the app boots clean on every page. The reported
"hundreds of errors" must therefore come from somewhere the harness does not
yet reach. Most likely, in order:

1. **Interaction paths** — modals, forms, submits. The harness only loads a
   page; it does not click. *Fix: extend it to drive real flows.*
2. **Signed-in / auth-gated code** — `admin`, `super-admin`, `agent-*` bail out
   early when logged out, so their real code never executes. *Fix: run the
   harness with a test session.*
3. **Supabase responses** — RLS denials and 4xx on writes, which only appear
   when actually saving data.
4. **The editor's problems panel** — with no `jsconfig.json`, VS Code
   type-checks these files against nothing and can report large numbers of
   phantom "cannot find name" errors. *Fix: add a `jsconfig.json`.*

Answering this decides whether Phase 0 is "extend the harness" or "add a
jsconfig". It does not block Phases 1–5.

# Pawa Bus Cargo — Project Guide

Tanzania bus cargo & passenger ticketing web app.

## Project layout

The frontend lives at the **repo root** (so GitHub Pages can serve it directly
without a build step). All HTML pages, `css/`, `js/`, `data/`, `supabase/`,
`voice/`, and `icons/` are top-level.

```
pawa2/
├── index.html              ← Homepage
├── book-fast.html          ← Flagship booking page (voice agent + web seat map)
├── book.html               ← Redirect → book-fast.html
├── send.html               ← Parcel shipment registration
├── track.html              ← Parcel tracking
├── ride.html               ← Ride-hailing (driver/rider)
├── meet.html               ← GPS location sharing
├── chat.html               ← AI assistant chat
├── agents.html             ← Agent directory
├── buses.html              ← Bus company directory
├── admin.html              ← System admin panel (auth-gated)
├── dashboard.html          ← Bus company dashboard (tenant auth-gated)
├── accounting.html         ← Finance portal
├── super-admin.html        ← Tenant management
├── agent.html              ← Agent shipment dashboard
├── agent-register.html     ← Agent self-registration
├── saas.html               ← B2B marketing page
├── signup.html             ← Bus company onboarding
├── manifest.json           ← PWA manifest
├── service-worker.js       ← PWA service worker
├── css/                    ← styles.css, mobile.css, accounting.css, etc.
├── js/                     ← One JS file per page + shared: data.js, auth.js, nav.js, i18n.js, config.js
├── data/                   ← Fallback JSON + hero images
│   └── _originals/         ← Pre-resize backups of hero images (gitignored)
├── icons/                  ← PWA icons
├── voice/                  ← VAPI assistant config JSON
├── supabase/
│   ├── schema_master.sql   ← Authoritative DB schema (run this in Supabase)
│   ├── functions/          ← Edge functions (Deno/TypeScript)
│   └── archive/            ← Old versioned schemas (reference only)
├── n8n/                    ← n8n workflow exports (import into your n8n instance)
├── scripts/                ← One-off admin scripts (photo upload, SQL runner)
├── docs/                   ← Setup guides, runbooks, AI agent prompt
├── tests/                  ← Test scripts
├── android/                ← Capacitor native Android app (see docs/APP_BUILD.md)
├── capacitor.config.json   ← Native app identity (com.maishahub.app, webDir: www/)
├── server.js               ← Simple static file server (port 8080)
├── serve.js                ← Alternative static server (port 3000)
└── .env.example            ← Environment variable template
```

## Website AND application

The site is an installable PWA (manifest.json + service-worker.js + PNG icons
in `icons/`, regenerate with `node scripts/make_icons.mjs`) and a native
Android app via Capacitor: `node scripts/build_app.mjs && npx cap sync android`
stages the site into `www/` (gitignored). Full runbook: `docs/APP_BUILD.md`.

> Historical note: this used to live under `bus web/`. It was flattened to the
> repo root so GitHub Pages can deploy it without a build step or workflow.

## Backend

- **Supabase** — PostgreSQL + Auth + Storage + Edge Functions
  - Project: `kkdpacoiwntrcukgwksh.supabase.co`
  - Storage buckets: `bus-photos` (20 MB), `agent-photos` (20 MB), `ride-driver-photos` — all public
  - Authoritative schema: `supabase/schema_master.sql`
- **n8n** — SMS via Africa's Talking, VAPI call triggers, seat-hold expiry cron
- **VAPI** — AI voice agent for bookings

## Key config

All runtime keys live in `js/config.js`.

## Dev server

```bash
node server.js
# open http://localhost:8080
```

## Production hosting (GitHub Pages)

Push the repo to GitHub, then Settings → Pages → Source: deploy from a branch,
pick `main` (or `master`) and `/` root. The site is published at
`https://<user>.github.io/<repo>/`. No build step needed — everything is
already static.

## Admin access

Email must be in `APP_CONFIG.ADMIN_EMAILS` (config.js) and in the `admins` table in Supabase.

## Coding rules (ECC)

Imported from the ECC plugin's rule sets (copied to `~/.claude/rules/ecc/`).
The ECC plugin itself stays disabled — these imports load only the rules below,
not ECC's 33k-token always-on layer or its hooks. Trim any line to reduce load.

General:
@~/.claude/rules/ecc/common/coding-style.md
@~/.claude/rules/ecc/common/patterns.md
@~/.claude/rules/ecc/common/security.md
@~/.claude/rules/ecc/common/testing.md
@~/.claude/rules/ecc/common/code-review.md
@~/.claude/rules/ecc/common/git-workflow.md
@~/.claude/rules/ecc/common/development-workflow.md
@~/.claude/rules/ecc/common/performance.md

Python (`services/python`):
@~/.claude/rules/ecc/python/coding-style.md
@~/.claude/rules/ecc/python/patterns.md
@~/.claude/rules/ecc/python/security.md
@~/.claude/rules/ecc/python/testing.md
@~/.claude/rules/ecc/python/fastapi.md

TypeScript:
@~/.claude/rules/ecc/typescript/coding-style.md
@~/.claude/rules/ecc/typescript/patterns.md
@~/.claude/rules/ecc/typescript/security.md
@~/.claude/rules/ecc/typescript/testing.md

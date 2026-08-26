# Pawa Bus Cargo — Project Guide

Tanzania bus cargo & passenger ticketing web app.

## Website AND application

The site is an installable PWA (manifest.json + service-worker.js + PNG icons
in `icons/`, regenerate with `node scripts/build/make_icons.mjs`) and a native
Android app via Capacitor: `node scripts/build/build_app.mjs && npx cap sync android`
stages the site into `www/` (gitignored). Full runbook: `docs/APP_BUILD.md`.

> Historical note: this used to live under `bus web/`. It was flattened to the
> repo root so GitHub Pages can deploy it without a build step or workflow.

## Design

The brand is a Claude Design project mirrored into `css/ds/tokens/`. Every page
links `css/design-system.css`, which `@import`s those tokens plus the five brand
webfonts. Use `var(--token)` — never a raw brand hex.

```bash
node scripts/design/check_tokens.mjs   # literals that should be tokens
```

Rules, the token table, the sync procedure and two known traps live in the
`design` skill (`.claude/skills/design/SKILL.md`) — read it before any UI work.

## Backend

- **Supabase** — PostgreSQL + Auth + Storage + Edge Functions
  - Project: `kkdpacoiwntrcukgwksh.supabase.co`
  - Storage buckets: `bus-photos` (20 MB), `agent-photos` (20 MB), `ride-driver-photos` — all public
  - Authoritative schema: `supabase/schema/schema_master.sql`
- **n8n** — SMS via Africa's Talking, VAPI call triggers, seat-hold expiry cron
- **VAPI** — AI voice agent for bookings

## Key config

All runtime keys live in `js/core/config.js`.

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

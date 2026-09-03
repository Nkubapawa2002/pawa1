---
name: run-pawa2
description: Build, run, screenshot and drive the Pawa web app (PN-Zaki / Maisha na Lifeza) locally. Use when asked to run, start, launch, serve, open, screenshot, smoke-test or visually check any page of this repo, or to confirm a change works in the real app rather than only in tests.
---

# Running Pawa

A static PWA (also wrapped as an Android app via Capacitor). There is **no
build step** for the web app: `server.js` serves the repo root on :8080 and
the browser loads the files as they are on disk. Edit a file, reload, done.

Drive it with **`.claude/skills/run-pawa2/driver.mjs`**, a puppeteer harness
that handles the four things that otherwise waste an afternoon here: the CORS
preflight, the `localStorage` cache, puppeteer's flakiness on this host, and
the auth gate that hides the two most interesting screens.

All paths below are relative to the repo root.

## Prerequisites

Node and the repo's own dev dependencies. Puppeteer is already one of them, so
there is nothing to install beyond:

```bash
npm install
```

Verified on Windows (win32 x64), Node v24.13.1, puppeteer 24.43.1.
`chromium-cli` is **not** available on this host, which is why the driver uses
puppeteer directly.

## Run: the server

```bash
node server.js
```

Prints `Server on http://localhost:8080`. It does not detach, so start it in a
background shell and leave it. Check it with:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/index.html
```

## Run: the agent path (use this one)

```bash
node .claude/skills/run-pawa2/driver.mjs check index.html
node .claude/skills/run-pawa2/driver.mjs shot  p-message.html --theme=light
node .claude/skills/run-pawa2/driver.mjs form  agent-houses.html
node .claude/skills/run-pawa2/driver.mjs eval  index.html "document.querySelectorAll('.ha-near').length"
node .claude/skills/run-pawa2/driver.mjs pages
```

| command | what it does |
|---|---|
| `check <page>` | loads it, reports console errors, same-origin 404s, and sideways scroll |
| `shot <page>` | the above, plus a PNG in `shots/` |
| `form <page>` | reveals the signed-in form on an agent portal, then shoots it |
| `eval <page> "<expr>"` | evaluates an expression in the page, prints the result |
| `pages` | lists the pages that exist |

Flags: `--theme=dark|light` (default dark), `--w=390 --h=1400`, `--wait=2500`,
`--full` (full-page shot), `--seed` (plant a GPS fix and two shared places),
`--live` (do **not** stub the network: real tiles, real Supabase).

Exit code is 0 only when the page has no errors, no 404s and does not scroll
sideways, so it drops straight into a loop:

```bash
for p in index.html houses.html p-message.html profile.html; do
  node .claude/skills/run-pawa2/driver.mjs check "$p" || echo "FAILED: $p"
done
```

**Look at the screenshot.** `shots/agent-houses_dark_form.png` and friends are
the point; a green `check` only says nothing threw.

## Run: the human path

`node server.js`, then open `http://localhost:8080` in a browser. Useful for
poking at it by hand, useless for anything you need to report on.

## Test

```bash
node tests/copy_rules_test.mjs        # no emoji, no spaced dashes, en+sw for every string
node tests/i18n_coverage.mjs          # 0 untranslated across the wired pages
node scripts/design/check_tokens.mjs  # brand hex that should be var(--token)
node tests/theme_light_check.mjs      # every page readable in light mode
node tests/house_room_spec_test.mjs   # the listing spec normaliser
```

Browser suites need the server already running (`pm_delete_test.mjs`,
`profile_page_test.mjs`, `theme_light_check.mjs`).

**Tests whose name ends `_test.mjs` and that import `scripts/db/sql.mjs` run
against PRODUCTION.** They prefix every row `pmtest_` and roll back, but they
need `PERSONAL_ACCESS_TOKEN` in `.env` and they are not offline.

## Gotchas

- **Answer the OPTIONS preflight or the page hangs forever.** With request
  interception on, an unanswered preflight produces no error, no timeout in the
  console and no clue: the page simply never finishes loading. This is the
  single most common "puppeteer can't load this repo". The driver answers it
  first, before any other rule.
- **`js/core/data.js` caches in `localStorage` with a TTL.** An empty result
  from one run is reused by the next, so a feature looks intermittently broken
  when nothing is broken. Clear storage in `evaluateOnNewDocument`, not after
  `goto` — the cache is read during boot.
- **Puppeteer fails spuriously on this host.** Launch failures and
  `Navigation timeout of N ms exceeded` happen several times an hour for no
  reason. Retry; do not debug the profile. ("Browser is already running" is a
  rewrite of any launch failure on Windows, not a real lock.)
- **`node server.js` exiting 1 usually means port 8080 is already taken** by a
  server you started earlier. Harmless. `curl` the port before assuming it is
  down.
- **Never pipe a test through `| tail`.** The pipeline's exit code is `tail`'s,
  so a suite that crashed halfway reports success. Redirect to a file and echo
  `$?` instead.
- **The agent portals hide everything behind a sign-in card.** Nothing on
  `agent-houses.html` past the gate exists in the DOM until auth routing runs.
  Flip `#ahAuthCard` hidden and unhide `#ahFormSection` by id — walking the DOM
  looking for hidden things races the page's own routing and measures whichever
  won. (`agent-services.html` is `#asAuthCard` / `#asFormSection`.)
- **`window.pawaLocate.lastKnown()` reads `pawa_last_pos`**, and
  `pawaLocate.best()` holds a watch open for up to **six seconds** tightening
  GPS accuracy. Seed the key rather than waiting for it. `--seed` does this.
- **Stubbing a Supabase client needs `getSession`, not `getUser`.**
  `AgentProfile` reads the session, and its region loader calls `.order()`, so
  a builder stub that only knows `select`/`eq` throws before the modal renders
  and the fields look missing when they are fine. Make the builder chainable
  for any method.
- **`window.t(key)` takes a key and nothing else.** No fallback, no
  interpolation, and it returns the KEY ITSELF when a string is missing. Handle
  both or a missing key prints as `near_live_within`.
- **Never drop a live SQL function outside a transaction.** Changing a
  `RETURNS TABLE` needs a drop, and if the create then fails you have taken a
  function the app calls on every page load out of production. Wrap
  `drop; create;` in `begin/commit`. Also: `create or replace` does not replace
  a function whose argument list changed, it makes a second overload, and
  PostgREST then refuses to choose between them.

## Troubleshooting

| symptom | fix |
|---|---|
| `net::ERR_CONNECTION_REFUSED at http://localhost:8080/...` | the server is not running, or died. `node server.js` again. |
| `Navigation timeout of 20000 ms exceeded` | retry. The driver already retries three times; if it still fails, check the server. |
| Page loads but is blank / spins forever | the preflight. Confirm the `OPTIONS` branch is first in the request handler. |
| A feature works on one run and not the next | the `localStorage` cache. Clear it in `evaluateOnNewDocument`. |
| `node server.js` exits 1 immediately | port 8080 already in use. One is already running. |
| Form fields "missing" on an agent portal | the auth gate. Use `driver.mjs form`, or flip the ids listed above. |
| A DB test fails with "Failed to run sql query" | `PERSONAL_ACCESS_TOKEN` missing from `.env`, or `api.supabase.com` flaked. It flakes often; retry. |

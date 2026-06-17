# AI search — houses, rides & "near me"

The natural-language brain behind house search, ride search, and "near me"
queries. It reads a free-text question (English **or** Swahili) and produces a
structured intent the existing frontend engines already understand.

> **Status: ready — waiting only on the Anthropic API key.**
> Everything below is built and wired. The site works today using the built-in
> regex parser; the moment the key is set, Claude takes over automatically with
> no code change.

## How it fits together

```
 Browser (static, buildless)                 Server (holds the key)
 ┌──────────────────────────┐                ┌─────────────────────────────┐
 │ houses.js / ride.js      │   query +      │ Supabase Edge Function       │
 │   └─ js/ai-search.js  ───┼── context ─── │   ai-search/index.ts         │
 │        window.AISearch   │                │   → Anthropic Messages API   │
 │                          │ ── intent ────│   (ANTHROPIC_API_KEY secret) │
 │  fallback: parseSmartQuery (regex)         └─────────────────────────────┘
 │  ranker:   house-match.js (Rust→WASM)         OR self-host:
 └──────────────────────────┘                 services/python/main.py (same contract)
```

- **The API key never reaches the browser.** `js/ai-search.js` only knows the
  endpoint URL. The key lives in a Supabase secret (or the Python server's env).
- **Graceful by design.** No key / call fails / offline → `AISearch.*` returns
  `null` and the page falls back to the regex parser + WASM ranker. Nothing breaks.

## Files

| File | Role |
|------|------|
| `supabase/functions/ai-search/index.ts` | The AI brain (Deno Edge Function). Holds the key, calls Claude, returns intent JSON. |
| `services/python/main.py` | Same contract, self-hostable (stdlib only). For local testing or non-Supabase hosting. |
| `js/ai-search.js` | Browser client `window.AISearch`. Drop-in over the regex parser; silent fallback. |
| `js/config.js` | `AI_SEARCH_PATH` (Edge Function) and optional `AI_SEARCH_URL` (override). |
| `js/houses.js` | Wires AI into house smart search (`enhanceSmartSearchWithAI`). Regex stays the baseline. |
| `js/ride.js` + `ride.html` | " Tell us your trip" box → `AISearch.parseRide()` fills pickup / dropoff / vehicle. Manual fields always work. |

## Activate it — the only step left

### Option A — Supabase Edge Function (production, recommended)

```bash
# 1. set the key as a secret (never committed, never in the browser)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# 2. deploy the function
supabase functions deploy ai-search
```

Then flip the switch in `js/config.js`:

```js
AI_SEARCH_ENABLED: true,
```

(The flag keeps the AI UI hidden in production until the key is live, so users
never see a box that doesn't work yet.) Reload `houses.html`, type
"2 bedroom apartment near Mwenge under 700k" → the AI pass lights up ( chip).
On `ride.html` the " Tell us your trip" box appears — try "bajaji from here to
Mwenge".

### Option B — self-host the Python brain (local testing / non-Supabase)

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
cd services/python
uv run main.py            # or: python main.py   → listens on :8094
```

Then point the frontend at it in `js/config.local.js` (gitignored):

```js
window.APP_CONFIG.AI_SEARCH_URL = "http://127.0.0.1:8094/ai-search";
```

## The intent contract

`POST` body: `{ query, origin?{lat,lng}, areas?[], vehicleTypes?[], lang?, model? }`

Response `{ ok:true, intent, raw, model, usage }` where `intent` is:

```jsonc
{
  "domain": "house" | "ride" | "unknown",
  "answer": "one short sentence, in the user's language",
  "nearMe": false,
  "place":  { "name": "Mwenge" } | null,     // a landmark to geocode (TZ-only)
  "house": {
    "listing": "rent" | "sale" | null,
    "type": "apartment" | "house" | "plot" | "office" | null,
    "bedrooms": 2, "bathrooms": null,
    "area": "Mikocheni", "priceMax": 700000, "priceMin": null,
    "amenities": ["parking"], "keywords": ["modern"]
  },
  "ride": {
    "vehicleType": "bajaji" | null,
    "pickup":  { "name": "..." } | null,       // null + nearMe ⇒ use GPS
    "dropoff": { "name": "..." } | null,
    "when": "now" | null
  }
}
```

`intent.house` is the **exact** shape `houses.js parseSmartQuery()` returns, so
the WASM ranker consumes it unchanged.

> Keep the prompt/contract identical across `ai-search/index.ts` and
> `services/python/main.py` if you edit one.

## Cost / model

Default model `claude-sonnet-4-6`, `max_tokens` 700, `temperature` 0.1, with
prompt-caching on the system prompt — each search is a few hundred cached input
tokens plus a small JSON output. Override per request with `model` in the body,
or globally via `ANTHROPIC_MODEL` (Python) / the default in the function.

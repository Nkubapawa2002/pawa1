# Video space

One community video per region, live for 9 hours, at the bottom of the homepage.
First upload wins the slot; when the 9 hours are up (or nobody has claimed it)
the region falls back to a default clip an admin posted. Every video is capped at
**2 min 39 s** — longer clips are trimmed, never rejected.

This replaced the brand manifesto that used to sit in that band.

---

## How it fits together

```
index.html  #videoSpace
   └── js/pages/video-space-home.js     the screen: render, countdown, region picker
        └── js/lib/video-space.js       the flow: validate → claim → trim → upload → publish
             ├── services/python        /normalize — trims to 2m39s + faststart (ffmpeg)
             └── Supabase
                  ├── region_videos           one row per claim; THE slot
                  ├── region_video_defaults   admin fallbacks (per region + one global)
                  └── RPCs  claim_region_video_slot · publish_region_video · current_region_video

admin.html  "Video space" tab
   └── js/pages/admin-video-space.js    set/clear defaults, see what is live, take things down
```

### The one invariant

At most **one active video per region**. This is not enforced in application code —
it is a partial unique index:

```sql
create unique index ... on region_videos (region) where status in ('claiming','live');
```

Two people hitting upload in the same millisecond both reach the INSERT; exactly
one wins and the other gets a `unique_violation`, which the claim RPC turns into a
friendly "the space frees up at HH:MM". No locks, no queue, no coordinator.

### Claim before upload

The slot is claimed *before* the bytes are sent, so the loser of a race finds out
in ~50 ms instead of after pushing 40 MB up a Tanzanian mobile link. Unfinished
claims carry a 10-minute `claim_expires_at` and release themselves.

### Expiry is read-time, not cron-time

Every read filters on `expires_at > now()`, and the claim RPC releases aged rows
before it inserts. The hourly cron only deletes storage blobs. **If the cron is
late, wedged, or never runs, viewers still see the right thing and slots still
free on schedule** — all that accumulates is dead bytes. A cron failure is a
storage bill, never a correctness bug.

---

## Bringing it up

Run this from the repo root at any point to see exactly which step is missing:

```bash
node scripts/db/verify_video_space.mjs
```

It talks HTTPS (not port 5432), so it works from any network, and it checks the
same endpoints the browser uses.

### 1. Database — required

Apply, in this order, either in the Supabase SQL editor (Dashboard → SQL Editor →
paste → Run) or via `node scripts/db/run_sql.mjs <file>`:

| File | What it creates | Required? |
|---|---|---|
| `supabase/ops/regions_seed.sql` | the 31 regions `region_videos.region` points at | yes, if not already seeded |
| `supabase/features/video/region_video_space.sql` | tables, RLS, the `region-videos` bucket, all three RPCs | **yes** |
| `supabase/features/video/region_video_ttl_cron.sql` | hourly blob sweep | optional (storage only) |

Both feature files are idempotent — re-running them is safe.

> `run_sql.mjs` connects on port **5432**, which plenty of networks block
> (some VPNs, corporate Wi-Fi, most mobile hotspots). If every candidate host
> times out, use the SQL editor instead; it goes over 443.

### 2. Edge Function — optional

```bash
npx supabase functions deploy purge-expired-videos
```

Only needed if you ran the cron file. It deletes expired blobs and sweeps
orphans; nothing about correctness depends on it.

### 3. Video gateway — required for clips over 2m39s

`services/python` does the actual trimming. Render redeploys it automatically
when `main` moves (`render.yaml`, `autoDeploy: true`). Confirm with:

```bash
curl https://pawa-video-gateway-oymf.onrender.com/health
```

You want `"trim": "ready"` and a `max_duration_s` field. A response *without* a
`trim` field is the old pre-video-space build — clips over the cap will be
refused (`gateway_down`) until it redeploys.

`trim: "no_ffprobe"` means ffmpeg is present but ffprobe isn't, so the service
cannot measure duration and silently stops enforcing the cap. Both ship in
Debian's `ffmpeg` package; see `services/python/Dockerfile`.

> Free-tier Render sleeps after ~15 min idle. The first request after a quiet
> spell takes up to a minute — that's why the uploader degrades gracefully
> instead of failing.

### 4. First video

Admin → `admin.html` → **Video space** tab → pick *Global default* → **Set default
video…**. Every region with nothing live now plays it, so the space is never empty
while the community fills it in.

---

## Limits, and where each one is actually enforced

| Limit | Value | Enforced by |
|---|---|---|
| Duration | 159 s (2 m 39 s) | `services/python` trims; `publish_region_video` rejects > 165 s |
| File size | 50 MB | bucket `file_size_limit`, mirrored in the browser |
| Formats | MP4 / WebM / MOV | bucket `allowed_mime_types` + byte-level container sniff |
| Slot lifetime | 9 hours | `publish_region_video` sets `expires_at` server-side |
| Per user | 1 post per 9 h, platform-wide | `claim_region_video_slot` |
| Unfinished claim | 10 minutes | `claim_expires_at` |

The browser repeats several of these. **Every browser check is a courtesy**, run
so someone on a mobile link learns their clip is too big *before* uploading it —
each one is re-run somewhere a browser cannot reach.

The 165 s figure in `publish_region_video` is 159 s plus grace: a `-c copy` trim
can only cut on a keyframe, so a legitimate trim can land slightly over.

---

## Changing the cap

Four places, and they must agree:

1. `js/core/config.js` → `VIDEO_MAX_DURATION_S`
2. `js/lib/video-space.js` → `MAX_DURATION_S`
3. `services/python/main.py` → `MAX_DURATION_S` ← the only one that actually cuts
4. `supabase/features/video/region_video_space.sql` → the `> 165` guard in
   `publish_region_video` (keep ~6 s of grace above the cap)

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Space stays on the loading shimmer | `current_region_video` missing — run `region_video_space.sql` |
| Space shows "be the first" in every region | working as designed; no default set yet (step 4) |
| "We couldn't tell which region you're in" | the region name isn't in `public.regions` — run `regions_seed.sql` |
| Long clips fail with the "trimming service is asleep" message | gateway is cold, or still on the old build (step 3) |
| Video is a black rectangle | the `region-videos` bucket isn't public |
| Slot never frees | it does, at read time — check `expires_at`, not the cron |
| Raw keys like `vs_badge_default` on screen | an i18n key is missing from `js/core/i18n.js` |

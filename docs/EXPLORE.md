# Explore

The global view: one search across **rooms, trucks, services and day jobs**,
anywhere in Tanzania — and the cross-vertical matches between them ("you found
a room; here are the trucks near it").

`explore.html` is what the Explore tab points at. It used to point at
`houses.html`, which meant the tab could only ever show one quarter of what the
site offers.

---

## Files

```
explore.html                  the screen — self-contained "Twilight" styling
js/pages/explore.js           interaction only: wiring, rendering, URL state
js/lib/explore-index.js       four tables → one Item shape
js/lib/explore-query.js       free text → intent (which vertical, what filters)
js/lib/explore-rank.js        the scoring model + diversity re-rank
js/lib/explore-match.js       the cross-vertical companion rules
js/lib/explore-roads.js       straight lines → real road distance (OSRM)
js/lib/explore-map.js         the map view — lazy-loads Leaflet on first use
tests/explore_engine_test.mjs 62 assertions over the engine libs
```

The engine libs are pure — no DOM, and their only network dependency
(`pawaRoute.table`) is injected, not imported. That is what makes the test file
possible: it gives them a `window`, evals them in order, stubs the routing call,
and drives the exact globals the page drives. (`explore-map.js` is the exception
— it is all DOM, which is why it is tested in a browser instead.)

```bash
node tests/explore_engine_test.mjs
```

### Why it doesn't load the site's CSS

Every other directory page loads eight stylesheets — `styles.css` (131 KB) plus
`neon-pro`, `premium`, `claude-design`, `houses-pro`, `mobile`, and more — written
at different times, competing for every control. Explore loads **none** of them.
It is styled inline in the "Twilight" language the homepage feed already uses, so
Explore and Home read as one app.

---

## The Item shape

Nothing downstream ever sees a raw table row. `explore-index.js` flattens all
four into:

| field | notes |
|---|---|
| `kind` | `room` \| `truck` \| `service` \| `job` |
| `id`, `title`, `href` | identity and where tapping goes |
| `price`, `priceUnit` | normalised to TZS; `priceUnit` is `month`/`trip`/`per_job`/… |
| `lat`, `lng`, `pinned` | `pinned` is explicit — plenty of real listings only name an area |
| `region`, `area` | |
| `facets` | the per-kind specifics (bedrooms, tonnage, category, spots left) |
| `text` | lowercased search blob, with Swahili synonyms folded in |

The synonym fold is what makes `fundi umeme` find a listing whose category is the
English enum `electrical`.

---

## The algorithm

### 1. Intent (`explore-query.js`)

Scores all four verticals from weighted bilingual cues, then keeps every vertical
within half the leader's score. Two rules matter:

- **No evidence → search all four.** An empty query is someone browsing, not a
  failure to understand. This is what makes it a global view.
- **Ambiguity is preserved.** "cleaning" is genuinely both a service and a job;
  picking one would be a guess dressed up as an answer.

Also extracts budget (`under 300k`, `chini ya 500k`, `between 200k and 400k`),
bedrooms, room kind, truck type, tonnage, service category, and a map anchor via
the `tz-places` gazetteer.

> `and`/`na` are accepted as range separators, which makes them a trap: `3 bedroom
> and 2 bathroom` must not parse as the range 2–3. Both sides must carry a
> magnitude suffix or clear 50,000 before a range is believed. (`houses.js` has
> its own older copy of this parser that still has the `between … and …` gap.)

### 2. Score (`explore-rank.js`)

Every signal is normalised to 0..1 **before** anything is compared — nothing is
ever compared in its own units. That is what lets a 400,000/month room and a
15,000/trip pickup share one ranked list.

| signal | what it measures |
|---|---|
| `text` | IDF-weighted term match, title-boosted, one-edit typo tolerance |
| `geo` | `exp(-d/τ)` — the gap between 1 km and 3 km matters; 40 km to 42 km does not |
| `price` | fit against a *stated* budget. **Neutral when none was stated** |
| `fresh` | age decay, per-kind half-life (jobs 3 days, services 30) |
| `quality` | verified · has photo · has a pin · has a real description |
| `facet` | bedrooms, tonnage, category, listing type |

Weights differ per vertical: you pick a house mostly on **where** it is, and a
fundi mostly on **whether they do the thing you asked for**.

Two deliberate refusals:

- **"Cheaper is better" is not assumed.** With no budget stated, price scores
  neutral. An unusually cheap listing in a stated range is more often mispriced
  than a bargain.
- **Unpinned listings are never dropped by a radius filter.** Doing so would
  silently hide whole towns whose agents never dropped a map pin.

Hard filters are only for "would showing this be *wrong*?" — wrong listing type,
double the stated budget, a job with no spots left. The bar is high: a filter that
removes the only three listings in a town turns a working search into an empty
page, and an empty page is the one result nobody can act on.

### 3. Diversity re-rank

The last pass is not about relevance. One agent with forty near-identical listings
would otherwise own the entire first screen, so repeats from the same owner
(×0.72) and area (×0.93) are progressively discounted as the list is built. The
discount is multiplicative and shallow — this breaks up runs, it does not overturn
the ranking. Disabled automatically for explicit sorts.

### 4. Cross-vertical match (`explore-match.js`)

The reason Explore is one page instead of four.

| you're looking at | you're offered | radius |
|---|---|---|
| **room** | trucks that can move you in | 25 km |
| **room** | cleaning, plumbing, electrical, carpentry, painting, moving help, appliance repair | 12 km |
| **truck** | people who load and carry | 20 km |
| **service** | day jobs around this area | 20 km |
| **job** | rooms to rent near the work, capped at ~30× the daily pay | 15 km |

Two rules:

- **Match on the result's own pin, not the search anchor.** You searched "rooms in
  Mbezi" but you're looking at a specific house — the trucks that matter are the
  ones near *that house*.
- **No auto-widening, ever.** A truck 90 km away is not "the truck for this house".
  If nothing is genuinely near, nothing is shown. (The *main* results do auto-widen
  — and say so.)

The job → room budget cap exists because pairing a day job with a 2 M/month
apartment would be an insult dressed up as a suggestion.

---

## Search is local

The whole catalogue is fetched once and ranked in memory on every keystroke.
Tanzania's listings are thousands of rows, not millions — a round trip per
keystroke would be slower, would fail on a bad link, and would make the ranking
impossible to do properly (you cannot compute IDF over a page of results you have
not fetched).

A vertical that fails to load is skipped, not fatal, and the screen **says so**.
`DataStore.getDayJobs()` deliberately throws on a query error rather than
returning `[]`, so "nobody is hiring today" stays distinguishable from "the table
is missing".

The one network call after load is the road-distance matrix, and it is
deliberately off the critical path — see below.

---

## Road distance (`explore-roads.js`)

A haversine distance is a lie that is usually close enough. Over a Tanzanian city
it stops being close enough in exactly the cases people care about: a house across
a creek is 900 m away and a 26 km drive, and the Kigamboni ferry hop is 3 km by
boat against a bridge detour by car. Ranking those by straight line puts the wrong
listing first.

`js/lib/geo.js` already solves the hard part — `pawaRoute.table()` is an OSRM
matrix with a Valhalla fallback, per-pair caching, and ferry-aware re-measurement.
This lib is the policy around it: *which* listings are worth measuring, *when*, and
what to do when the answer arrives late.

**Road distance is an upgrade, never a dependency.** The list paints instantly with
straight lines; the matrix lands ~500 ms after the typing stops and corrects them.
If OSRM is down, rate-limited, or the user is offline, nothing breaks and nothing
waits — the numbers just stay approximate. Every failure path returns quietly.

| decision | why |
|---|---|
| top **40** results only | OSRM's public endpoints are a shared free service. Measuring 2,000 listings because someone typed a letter is slow and rude, and 1,960 of those answers are never looked at. 40 is >1 screenful and <OSRM's 99-destination limit, so a settled search is **one** request. |
| **500 ms** debounce | typing fires `run()` constantly; a matrix per keystroke is indefensible. |
| a **token** per request | by the time a matrix returns the user has often typed something else. Applying old distances to new results would put confident, precise, *wrong* numbers on screen. Stale answers are dropped, not merged. |
| cache cleared on **anchor change** | road distance is origin-relative. Keeping it would attribute distances-from-Mbezi to a search from Mwanza. `pawaRoute` keeps its own per-pair cache, so re-measuring is nearly free. |
| road < **0.85 ×** straight line → discard | a road cannot be meaningfully shorter than the crow flies. A matrix that says so has snapped to the wrong road, and a confident wrong number is worse than an honest approximate one. |

### What changes when it lands

The re-rank runs with the real distances, and **a radius now means a drivable
radius** — a 26 km drive falls outside "within 25 km" even if it is 900 m away.
Cards labelled `1.4 km by road` are measured; unlabelled ones are still estimates.

Re-rendering swaps cards under whatever the reader is looking at, so:

- **not scrolled or tapped yet** → full re-render through `run()`, which keeps the
  auto-widen ladder. (A road distance can push the last result outside the radius;
  that must widen and say so, not empty the page.)
- **already scrolled or tapped** → order is left alone and only the distance text
  is corrected in place. A number quietly getting more accurate is fine; the list
  moving under a finger is not.

Either way the note under the count says **"measured by road"**, so a listing
leaving the results because its *drive* is 26 km reads as a better answer rather
than a glitch.

> **Companions still use straight-line distance.** Each selection would be another
> matrix call, and rails render on the top 3 cards — 3 requests per search. A
> companion group is ≤6 items inside a tight radius, where the crow flies is a
> reasonable proxy. The ferry case does apply here too; this is a deliberate
> trade, not an oversight.

---

## The map (`explore-map.js`)

`List ⇄ Map` sits next to the result count. **Nothing map-related is fetched
until the first tap on Map** — Leaflet plus its CSS is ~160 KB, most visits never
open it, and Explore's whole promise is that search responds in a frame.

What it draws:

- **Price pills, not pins.** A dot says a listing exists somewhere; `100k` in the
  vertical's own colour says what it is and what it costs without a tap. Ranking
  survives being drawn — a better result sits above a worse one where pills overlap.
- **The anchor and its radius.** "Within 10 km" is a promise the list already
  makes; the circle makes it checkable.
- **The companion overlay.** Selecting a result draws its cross-vertical matches
  as smaller satellite markers, each tied back with a dashed line. The pairing the
  list states in words becomes a shape you can see. This is the map's real job.
- **The same ranked results the list has** — not a second query. A map that
  disagrees with the list under it is worse than no map, so `show()` takes the
  result array verbatim and never filters on its own. It draws the *whole* ranked
  set, not the visible page: "show 24 more" is a list affordance.

**Viewport rendering instead of clustering.** Thousands of overlapping pills are
unreadable and a clustering plugin is another CDN dependency. Only markers inside
the current bounds are drawn, capped at 140, redrawn on move — the same trick
`near-me.js` uses for its reference pins. Panning reveals more, which is what
people already expect a map to do.

**Search this area** appears once the map has genuinely been dragged away from
where the results were framed (drift > 60% of the visible span), then re-anchors
on the map centre and snaps the radius to the nearest step the `<select>` can
actually express — so the control never disagrees with what was searched.

Tapping a pin and switching back to List opens the list **on that card**, briefly
outlined. Once the map has been dragged it stays where it was put and the pins
update underneath — a keystroke re-running the search does not yank the view back.

Two failure modes are handled out loud rather than silently:

- Leaflet's CDN blocked or slow → the map area says so and the list still works.
- Listings with no coordinates → *"N without a map pin"* under the map. They have
  not been filtered out; they simply cannot be drawn, and the reader must be told.

> **Leaflet's stylesheet loads *after* this page's `<style>`**, because it is
> lazy-loaded. Equal-specificity overrides therefore lose on source order — which
> shipped white zoom buttons and a white layer switcher on a near-black page.
> Every Leaflet override in `explore.html` is scoped under `.xp-map` purely to
> outrank Leaflet regardless of load order, which is also why no `!important` is
> needed.

---

## URL state

Deep links are first-class — sharing a search is the natural thing to do with one.

```
explore.html?q=chumba+Mbezi&k=room&place=Mbezi&r=10&sort=cheap&view=map
```

`q` query · `k` scope · `place` anchor name · `r` radius km · `sort`
`best`\|`near`\|`cheap`\|`new` · `view=map` opens on the map. A GPS anchor is
deliberately **not** serialised — someone else's "near me" is not yours.

---

## Adding a fifth vertical

1. A normaliser in `explore-index.js` (`fromX`) + its entry in the `load()` job list.
2. Cue patterns in `explore-query.js` `CUES` — English and Swahili in the same array.
3. A weight profile and freshness half-life in `explore-rank.js`.
4. Rows in `explore-match.js` `RULES` — both directions, if it pairs with anything.
5. i18n keys `xp_k_<kind>` / `xp_one_<kind>` and an accent colour in `KIND_META`.

Steps 2–4 are data, not code. That is on purpose.

---

## Known gaps

- **Companion rails rank by straight line**, not road — see the trade-off note in
  the road-distance section above.
- **Pills overlap at low zoom.** Two listings a few hundred metres apart draw on
  top of each other until you zoom in, and the top one takes the tap. Ranking
  decides who is on top, so it is never arbitrary — but it is not clustering.
- **AI parsing is not connected.** `js/lib/ai-search.js` handles long sentences
  better, and `houses.js` already upgrades its regex parse with it. The same
  pattern would apply here — regex as the instant floor, AI as the async upgrade.
- `houses.js` keeps its own older budget parser with the `between … and …` gap
  described above.

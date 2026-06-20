# The Frame

> A **Frame** is one bounded area looked at as a *room for business*.
> You don't sell a house, a service, a job or a truck in the abstract —
> you sell it **inside a Frame**: a place where people already gather, move
> and spend. Find the Frame, read it correctly, and demand becomes visible
> *before* anyone posts a listing.

The seed idea, in the founder's own words:

```
need finding the important area that gathers people — i mean a population
to show nearby services used by many people, like roads
the population of an area
the key operations in the area
```

This document turns those four lines into a model the app can actually run.

---

## 1. Why "Frame" and not "location"

A location is a dot. A Frame is a **room with walls, a floor, doors, and
traffic through it**. Everything Pawa sells lives in a room:

| Pawa product        | What the Frame tells you                                  |
|---------------------|-----------------------------------------------------------|
| Houses / rooms      | Where renters *want* to be (near work, transport, school) |
| Services            | Where daily-need demand concentrates (food, repair, salon)|
| Day jobs (vibarua)  | Where labour gathers and where work originates            |
| Trucks / moving     | Which corridors and nodes generate movement               |
| Agents              | Which Frame an agent should *own* and farm                 |

So the unit of strategy is **not** the listing and **not** the city — it is
the Frame. One agent, one Frame, farmed deeply, beats ten agents spread thin.

A Frame has four readable layers. The rest of this doc is those four layers,
then how to score them, store them, and ship them in the product.

---

## 2. Layer 1 — The Magnets (what gathers the population)

People do not spread evenly. They **clump around magnets**. A magnet is any
fixed thing that pulls a crowd to one spot on a predictable rhythm. The Frame
is defined by the magnets inside its walls.

### Tanzania magnet taxonomy (real anchors, real Swahili names)

| Class            | Anchor (TZ)                          | Rhythm of the crowd               |
|------------------|--------------------------------------|-----------------------------------|
| **Transport**    | Stendi (bus stand), daladala stage (kituo), boda/bajaji stage, ferry, train station | All-day pulse, dawn & dusk peaks |
| **Market**       | Soko (Kariakoo-type), machinga zone, mama-lishe row, butchery row | Morning + evening, market-days   |
| **Worship**      | Msikiti (mosque), kanisa (church)    | Friday / Sunday peaks, 5× daily   |
| **Learning**     | Shule, chuo / university, VETA       | Term-time, school-run hours       |
| **Health**       | Hospitali, zahanati (dispensary)     | Steady daytime, queues at open    |
| **Money**        | Benki, M-Pesa/Tigo/Airtel agent row, ATM | Payday, month-end spikes       |
| **Work**         | Kiwanda (factory), industrial area, port, construction site, mine | Shift changes, payday          |
| **Government**   | Ofisi ya kata / mtaa, court, TRA     | Office hours, deadline days       |
| **Leisure**      | Uwanja (football ground), baa/grocery, beach, bar strip | Evenings, weekends, match days |
| **Utility**      | Water point (bomba), fuel station, water kiosk | Morning water-fetch, refuel    |

A Frame usually has **one dominant magnet** that names it (a "stendi Frame", a
"chuo Frame", a "soko Frame") plus supporting magnets. The combination is the
Frame's fingerprint.

### The road is the master magnet

The founder's line — *"services used by many people, like roads"* — is the key
one. **The road is not a magnet, it is the river.** Magnets line up along it.
So a Frame is really:

```
a stretch of a busy road (the river)
  + the magnets clustered on it (the anchors)
  + the residential catchment feeding it (the people)
```

Rank roads by **how much population they carry**, not by length:
- Trunk / tarmac highway with daladala routes on it → highest carry
- Junction of two carrying roads → a **node** (magnets stack at nodes)
- Feeder / murram road into a residential ward → catchment, lower carry

**Nodes (junctions of carrying roads) are the richest Frames** — that is where
stendi, soko and money-agents naturally pile up.

---

## 3. Layer 2 — The Shared Services (what many people use)

Magnets pull the crowd in; **shared services are what the crowd uses while it
is there**. These are the everyday, high-frequency, low-ticket needs. Their
density is the single best proxy for "many people pass here".

Count, inside the Frame's walls:

- Food: mama-lishe, migahawa (eateries), chips/mayai stands, bakeries
- Water & fuel: water points, kiosks, petrol/diesel, gas refill
- Money: mobile-money agents, ATMs, kiosks selling vouchers/bundles
- Repair: fundi (mechanic, electronics, phone repair), welders, tailors
- Care: salon/kinyozi, pharmacy/duka la dawa, clinics
- Retail: duka la jumla/rejareja, hardware, agrovet

**Read it like this:** the more of these per 100 m of road, the more footfall
the road carries, the more the Frame is "used by many people". A high
shared-service density with *low* housing supply = a **hot Frame for rentals**
(people want to live where the daily needs already are). High shared-service
density with low *service* supply of one kind = a **service gap to fill**.

---

## 4. Layer 3 — The Population (who sits in the Frame)

You will rarely have a real census per Frame, so estimate it from signals you
*do* have. Three estimators, best-first:

1. **Observed pins** — Pawa's own data: listings, demand "needed-by" pins,
   day-job posts, agent activity, near-me searches in the Frame. Real revealed
   presence beats any external estimate.
2. **Magnet load** — sum the magnet "pull" scores (Section 2). A stendi + soko
   + chuo Frame carries far more people than a quiet residential ward.
3. **Built density** — rooftop / building density from the map (OSM building
   footprints) as a backstop where Pawa has no data yet.

Also tag the **population type**, because it changes what sells:

| Population type      | Tells you                                               |
|----------------------|---------------------------------------------------------|
| Dormitory / bedroom  | Empties by day → rooms cheap-ish, demand for transport  |
| Transient / hub      | Stendi crowd → short-stay, food, phone/charging, storage|
| Student              | Chuo Frame → shared rooms, cheap food, printing, hostels|
| Worker / industrial  | Kiwanda Frame → single rooms near gate, payday spending |
| Commercial / trader  | Soko Frame → storage, trucks, security, lockups         |
| Mixed high-street    | Node Frame → everything; highest, most stable demand    |

---

## 5. Layer 4 — The Key Operations (how the Frame earns)

The founder's last line: *"the key operations in the area"*. This is the
Frame's **economic engine** — the one or two activities that make most of the
money locally. It is the deepest layer because it explains the other three:
the operation creates the jobs, the jobs pull the population, the population
needs the housing and services.

Name the engine per Frame:

- **Trading hub** (soko/Kariakoo-type) → trucks, storage/lockups, porters
  (vibarua), security, short-stay rooms
- **Transport hub** (stendi) → food, parcels, charging, lodging, fundi
- **Industrial / port** → worker rooms, canteens, transport, day labour
- **University town** → hostels, cheap food, printing, electronics repair
- **Government town** → mid-rent housing, offices, stationery, banking
- **Farming / fishing belt** → seasonal labour, transport of produce, storage
- **Mining** → boom-rents, services, transport, high churn
- **Construction front** (a growing ward) → fundi, hardware, day jobs, trucks

The engine tells an agent **which Pawa product to lead with** in that Frame and
**when** (paydays, market days, term starts, harvest).

---

## 6. Scoring a Frame — the Opportunity Score

Turn the four layers into one comparable number so agents and admins can
**rank Frames** instead of guessing. Keep it simple and explainable.

```
FrameScore =
    w1 · MagnetPull        (how strongly the area gathers people)
  + w2 · ServiceDensity    (shared services per 100 m of carrying road)
  + w3 · PopulationWeight  (estimated people, by type)
  + w4 · RoadCarry         (traffic-carrying capacity of its roads/nodes)
  − w5 · SupplyAlready     (existing Pawa listings — saturation penalty)
  + w6 · RevealedDemand    (demand pins, alerts, near-me searches, job posts)
```

- **High score + low SupplyAlready** = an **open Frame** → tell agents to go.
- **High score + high SupplyAlready** = a **proven Frame** → optimise price,
  add adjacent products (a soko Frame full of rooms still needs trucks/storage).
- **High RevealedDemand + low Supply** = a **gap** → the sharpest signal Pawa
  has, because it is your own users asking and not finding.

Start weights equal, then tune from conversions. Always show *why* a Frame
scored high (its top magnets + the gap), never just the number.

### A worked read (illustrative)

> **Frame: "Mwenge node, Dar"** — junction of two carrying roads; magnets:
> stendi + chuo (UDSM nearby) + soko + money-agent row. Population: mixed
> high-street + student. Engine: transport/commercial + university.
> Read: very high MagnetPull and RoadCarry, strong RevealedDemand for student
> rooms and food services. Lead product: **rooms + services**; secondary:
> **storage/trucks** for the soko. An agent should *own* this Frame.

---

## 7. How the Frame maps onto the existing app

The Frame is not a new silo — it is a **lens over data Pawa already has**.

| Frame layer        | Already in the app                                         |
|--------------------|-----------------------------------------------------------|
| Walls (the area)   | `region → district → ward` auto-tagging from a pin; agent operating-area polygons; houses Area circle/draw |
| Magnets            | Map (OSM POIs) via the geocoder/map gateway; landmark gazetteer in `js/tz-places.js` |
| Roads / carry      | `pawaRoute` (OSRM) road distance + drawn routes already in near-me/houses |
| Shared services    | `services.html` marketplace listings (revealed supply)    |
| Population signal   | Listings, demand "needed-by" pins, area alerts, day-job posts, near-me searches |
| Key operations     | Day jobs board (labour), trucks (movement), agent notes   |

So the build is mostly **aggregation + scoring + a view**, not new plumbing.

---

## 8. Product: the "Frame view" (what to actually ship)

A single screen — **one Frame at a time**, matching the "this will be only one
frame" intent — that an agent or admin opens for any area and reads top-to-bottom:

1. **Frame header** — name (from dominant magnet), ward, FrameScore + the
   one-line "why".
2. **The map** — Frame walls drawn (circle/ward/polygon, reuse existing area
   tooling), carrying roads highlighted, magnets pinned by class, your own
   listings + demand pins overlaid.
3. **Four-layer readout** — Magnets / Shared services / Population / Operations,
   each one line with its top facts.
4. **The gap panel** — "People here are asking for X, supply is Y" (RevealedDemand
   vs SupplyAlready). This is the money screen.
5. **Action** — "List in this Frame", "Claim this Frame" (agent), "Alert me when
   a room opens here" (seeker) — all wire into existing flows.

### Build order (thin → deep)

1. **Frame primitive** — given a pin or ward, return its walls + the layer-1/2
   facts from the map (magnets, carrying road) and Pawa's own pins. No score yet.
2. **Overlay** — draw the Frame + magnets on the existing Leaflet maps (reuse
   `js/geo.js`, area-circle, poly tooling).
3. **Score** — add Section 6, equal weights, always with the "why".
4. **Gap panel** — join RevealedDemand vs SupplyAlready (Pawa's own tables).
5. **Agent assignment** — "one agent owns one Frame", surfaced in agent dashboards
   next to the existing operating-area + client-list tooling.

---

## 9. Data the Frame needs (and where it comes from)

- **Magnets / POIs** — OSM via the existing map gateway (`services/go`,
  LocationIQ key on Render; public Nominatim 429s the shared IP). Cache per
  Frame — magnets barely move.
- **Roads & nodes** — OSRM (`pawaRoute`); a node = junction of two carrying ways.
- **Pawa-revealed signals** — Supabase tables already in use: houses/services/
  trucks listings, demand/needed-by pins, area alerts, day-job posts, near-me
  search logs (if logged). These are the highest-trust inputs — they are *your*
  users, not a guess.
- **Built density backstop** — OSM building footprints where Pawa data is thin.

Persist a lightweight `frames` summary (walls + cached layer facts + last
score) so the view is instant and the score is reproducible; refresh on a cron.

---

## 10. One Frame, one discipline — operating rules

- **One agent owns one Frame.** Depth beats spread. The agent farms every
  product in it (rooms, services, jobs, trucks) instead of chasing scattered pins.
- **Lead with the engine.** Section 5 says which product to push and when
  (payday, market day, term start, harvest).
- **Chase gaps, not noise.** RevealedDemand − SupplyAlready is the only signal
  that is purely Pawa's own users. Trust it most.
- **Explain every score.** Agents act on reasons ("stendi + chuo + a demand gap
  for student rooms"), not on a bare number.
- **A Frame is alive.** Magnets are stable; population, demand and supply move.
  Re-score on a rhythm; a Frame can heat up (new kiwanda, new chuo) or cool down.

---

### One-line summary

> **Find the magnets that gather the crowd, read the road that carries them,
> estimate the population and name the operation that pays them — that is a
> Frame, and a Frame is a room you can do business in.**

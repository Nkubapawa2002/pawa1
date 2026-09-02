# Telling an agent where you mean

**The rule, in one line:** when the map cannot find the place, the request
carries the smallest administrative unit that *can* be named exactly, and the
local name travels beside it, never instead of it.

> ward if the seeker knows it, else district, exactly as written
> **plus** the name of the place they actually want, in their own words

This page is the reference for anything that puts a location in front of an
agent. Read it before changing `js/lib/request-place.js`,
`house_demand_near`, or any screen that asks a person where they want to be.

---

## Why this exists

Half the places people in Tanzania actually live are exact to a person and
invisible to a geocoder. *Kwa Ndege*, *Mwenge kwa Mafuriko*, *Sokoni kwa
Mchina* are addresses. Every agent working that street knows them. LocationIQ
returns nothing for all three.

`js/lib/request-place.js` already knew this and did the only safe thing
available to it: keep the **region** as a routing key and let the point fall
back to the region's centroid when the typed name geocoded to nothing.

That fallback is where the requests were dying, because matching was purely
geometric:

```sql
haversine(d.lat, d.lng, listing) <= greatest(d.radius_m, p_radius_m)
```

**A region centroid is not a location. It is an average.** Dar es Salaam's
centroid is roughly Kinondoni. A seeker who wants a room in Kigamboni and names
a street the geocoder misses got a pin about 15 km from where they meant, and
then either matched every agent in the wrong half of the city or, with a tight
radius, nobody at all. The seeker was told "Request sent" either way.

## Why widening the radius is the wrong fix

It is the obvious one and it makes things worse. A bigger circle around the
wrong centre buys **more wrong agents**, and the seeker's request competes with
more noise on every dashboard it lands on.

Matching on a name the seeker could state exactly is the only move that gets
**narrower and more correct at the same time**.

## The mechanism

A distance is evidence only when the point it is measured from is real. So the
pin records how its own coordinates were obtained, in
`house_demand_pins.anchor_kind`:

| `anchor_kind` | how the point was obtained | how it matches |
|---|---|---|
| `exact` | dragged pin, GPS fix, picked suggestion, or text that genuinely geocoded | geometry, exactly as before |
| `ward` | stand-in. The seeker named their ward | normalised ward equality |
| `district` | stand-in. The seeker knew only the district | normalised district equality |
| `region` | legacy rows written before this existed | geometry, so they do not vanish |

`house_demand_near` is two-armed on that column. When the anchor is not
`exact` it does not merely widen the tolerance, it **stops trusting the
coordinates at all** and matches on the named unit instead. It also returns
`distance_m` as `NULL` for those rows, so a fabricated "14 km" never appears
beside a request that was matched by name.

Ward is tried first because that is the unit agents work in: `agent_profiles`
has carried `ward` and `district` since it was written, and until now a demand
pin had no `ward` column to meet it on.

### Two fences that keep it from becoming a shotgun

- **A ward pin does not fall through to its district.** Somebody who could name
  their ward meant that ward.
- **An anchor that names nothing is not an anchor.** `house_demand_create`
  downgrades it to `region` rather than writing a row that can never match.

### Names are compared normalised

`hdp_place_norm()` lowercases, strips the Swahili prefixes (`Kata ya`,
`Wilaya ya`, `Mtaa wa`), strips either-language suffixes (`Ward`, `District`,
`Kata`, `Wilaya`, `Mtaa`), turns punctuation into spaces and collapses runs of
whitespace. So all of these are one place:

```
Mikocheni B    ·    mikocheni  b    ·    Mikocheni-B Ward    ·    Kata ya Mikocheni B
```

## What the seeker sees

The ward and district fields are **not** always on screen. They appear only
when the typed place failed to resolve, which is the case they exist for.
Asking everybody for a ward would be asking most people for something they did
not need to give.

When they do appear, the form says why in the seeker's terms, names the place
they typed, and states plainly what happens if they leave it blank:

> Without a ward or a district this goes to the whole region, which is a lot of
> agents and few of them yours.

## If you are changing this

- **Both sides must pass their unit.** `house_demand_near` takes `p_ward` and
  `p_district`; they are the *agent's* registered units. They are optional, so
  a caller that forgets them silently loses the named arm and every unmappable
  request goes invisible again. Both call sites in `js/pages/agent-houses.js`
  pass them.
- **`anchor_kind` defaults to `exact`.** Every row written before this existed,
  and any client that has not been updated, keeps the geometric behaviour it
  was written under.
- **There is one `house_demand_create`.** The old 16-argument overload was
  dropped rather than left beside the new one: two overloads whose extra
  arguments are all defaulted are ambiguous to PostgREST, which answers
  "could not choose the best candidate function" and fails every request.

## Files

```
supabase/features/house/house_demand_place.sql   the columns, the normaliser,
                                                 the two-armed match  (APPLIED)
tests/house_demand_place_test.mjs                13 checks, against the real DB
js/lib/request-place.js                          the anchor block and the rule
js/pages/agent-houses.js                         passes the agent's ward
```

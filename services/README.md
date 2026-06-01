# `services/` — Pawa polyglot backend

Backend capabilities, each written in the language that fits it best. See
[`../docs/LANGUAGE-ROUTING.md`](../docs/LANGUAGE-ROUTING.md) for *why* and *which
language for which job*.

The **frontend at the repo root stays buildless static** — nothing here is part
of the GitHub Pages bundle. These are standalone services / tools, or (for Rust)
the source of precompiled WASM artifacts that get copied into `js/`.

Each folder ships a tiny **dependency-free `/health` stub** so you can confirm
the toolchain works end to end before real code lands.

| Service   | Language    | Role                                  | Port | Run |
|-----------|-------------|---------------------------------------|------|-----|
| `go/`     | Go 1.26     | map area-fetching gateway (geocode + commute match) | 8091 | `cd services/go && go run .` |
| `rust/`   | Rust 1.96   | CPU-bound / perf-critical / Rust→WASM | 8092 | `cd services/rust && cargo run` |
| `java/`   | Java 21 LTS | enterprise / payments / accounting    | 8093 | `cd services/java && java Health.java` |
| `python/` | Python 3.13 | AI reasoning / ML / data / scripting  | 8094 | `cd services/python && uv run main.py` |

Every stub answers `GET /health` with JSON like
`{"lang":"go","status":"ok","role":"…"}`. Override the listen port with the
`PORT` environment variable.

> Check it at `http://127.0.0.1:<port>/health`. On Windows prefer `127.0.0.1`
> over `localhost` — `localhost` can resolve to IPv6 (`::1`) first, which won't
> reach a service bound to IPv4 loopback.

## Per-language notes

- **Go** — std-lib `net/http`; `go run .` builds and runs in one step. This is
  the **map area-fetching gateway** — it fronts OpenStreetMap/Nominatim so the
  browser never calls it directly (Nominatim caps you at ~1 req/s and requires a
  User-Agent; many browsers calling it directly gets the IP blocked). Endpoints:
  - `GET  /geocode?q=Mlimani+City[&limit=8]` → Tanzania-filtered places `[{name,lat,lng,tag}]`
  - `GET  /reverse?lat=-6.76&lng=39.25`      → friendly area label `{area:"Mikocheni B, Dar es Salaam"}`
  - `POST /match {places:[…],listings:[…]}`  → listings ranked by total commute time
  - `GET  /health`
  Built in: a 1 req/s token-bucket limiter, a 6 h TTL cache, and singleflight
  dedup (N identical concurrent lookups → 1 upstream call). The haversine +
  commute maths in `geo.go` are ported 1:1 from `js/houses.js` — keep them in
  sync. To move the frontend onto it, point `geocodePlace`/`searchPlaces`/
  `reverseName` at this service instead of `nominatim.openstreetmap.org`.
- **Rust** — std-lib only (no crates to download). On Windows this uses the
  **GNU** toolchain (self-contained linker, no Visual Studio Build Tools). For
  browser math later: `rustup target add wasm32-unknown-unknown`.
- **Java** — built-in `com.sun.net.httpserver`, run via JDK 21 single-file
  launch, so **no Maven/Gradle** is required yet. Add a `pom.xml` only when a
  real dependency shows up.
- **Python** — std-lib `http.server`. `uv run main.py` uses the `pyproject.toml`
  env; plain `python main.py` works too (no dependencies).

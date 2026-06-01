# Language routing — pick the best tool per capability

Pawa is **polyglot on purpose**. We do *not* default to JavaScript. When a piece
of work "drops," identify the **capability** first, then route it to the language
that fits — and to the right place in the repo.

> **Hard constraint** (from `CLAUDE.md`): the **frontend at the repo root stays
> buildless static** — GitHub Pages serves it directly. New languages live in
> `services/`, `scripts/`, or `supabase/functions/`, or ship as **precompiled
> artifacts** (e.g. Rust→WASM copied into `js/`). Never add a build step to the
> repo root.

## The stack and what each language owns

| Capability / kind of work | Language | Why this one | Lives in |
|---|---|---|---|
| AI reasoning, LLM orchestration, agents, ML, data wrangling, geocoding, scraping, admin/automation scripts | **Python** | richest AI/ML + data ecosystem, fastest to write, `uv` for envs | `services/python/`, `scripts/` |
| Real-time / high-concurrency I/O: seat-hold expiry, live GPS fan-out (`meet`), websockets, SMS/webhook gateways, high-throughput JSON APIs | **Go** | cheap goroutines, excellent net stack, single static binary to deploy, low latency | `services/go/` |
| CPU-bound, perf-critical, memory-safe compute: fare/seat-map math, route optimization across many listings, geo distance over big sets — **and heavy in-browser math via Rust→WASM** | **Rust** | top performance + memory safety; compiles to WASM so the static frontend runs it with no build step | `services/rust/` (+ prebuilt `.wasm` in `js/`) |
| Enterprise integrations & money: payment/settlement, bank & mobile-money SDKs, formal accounting/ledger logic, a future Android app | **Java** | mature, audited enterprise & payment SDKs; strong typing for money; Android | `services/java/` |
| Server logic / webhooks already deployed | **TypeScript/Deno** | already in use on Supabase | `supabase/functions/` |
| Database schema & queries | **SQL** | source of truth | `supabase/schema_master.sql` |
| Frontend UI | **HTML/CSS/JS (vanilla)** | buildless, GitHub-Pages-served | repo root, `js/`, `css/` |

## How to route a task that "drops"

1. **Name the capability**, not the language. ("Expire seat holds every minute"
   → real-time/concurrent → Go.)
2. Match it to the table above.
3. **Browser + heavy compute?** → Rust→WASM. Build the `.wasm` offline and commit
   the artifact into `js/`; the page just `fetch`/`import`s it. No root build step.
4. **Go vs Rust tie-breaker:** I/O-bound or many concurrent connections → Go;
   CPU-bound, numeric, safety-critical, or targeting WASM → Rust.
5. **Anything touching money or external financial SDKs** → Java.
6. **Anything AI/ML/data/automation** → Python (the default "reasoning" home).
7. Keep the **frontend root buildless**; put new code under `services/`.

## Toolchains on this machine

Installed and verified **2026-06-01**:

| Tool | Version | Notes |
|---|---|---|
| Python | 3.13.2 | + `uv` 0.8.x, `pip` |
| Go | 1.26.3 | `C:\Program Files\Go` |
| Rust | 1.96.0 | **GNU** toolchain (`stable-x86_64-pc-windows-gnu`) set as default — self-contained linker, **no Visual Studio Build Tools needed**. For browser builds: `rustup target add wasm32-unknown-unknown`. |
| Java | Temurin 21 LTS (21.0.11) | `JAVA_HOME` set; single-file launch (`java X.java`) — no Maven/Gradle yet |

> winget's PATH edits don't reach an already-open shell. If a freshly opened
> terminal can't find `cargo` / `go` / `java`, open a **new** terminal (or
> refresh PATH from the registry).

## Service stubs

Each language has a dependency-free `/health` stub under `services/` so you can
confirm the toolchain end-to-end. See [`../services/README.md`](../services/README.md)
to run them.

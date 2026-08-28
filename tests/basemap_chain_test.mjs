// ============================================================================
//  Basemaps — the provider chain behind every map in the app
//
//  Every map used to draw straight from whichever free, unkeyed endpoint the
//  page happened to name, and went blank whenever one of them rate-limited.
//  This checks the chain that replaced that: MapTiler, then Mapbox, then the
//  free Esri/CARTO stack, with a provider demoted for the session once it
//  stops answering.
//
//  Tiles are answered locally (a 1x1 PNG) rather than fetched, so this asks
//  only "which host did the map ask for?" and never spends provider quota.
//  A dead provider is simulated by refusing its tiles.
//
//  Every case runs in its own browser context: these pages register a service
//  worker, and a js/config.local.js served from its cache would defeat the
//  last case, which is the deploy that never received that file.
//
//  Usage: node server.js   then:  node tests/basemap_chain_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const SUPABASE_STUB = `window.supabase={createClient:function(){
function q(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[],error:null}).then(r,j)};return b}
return{rpc:function(){return Promise.resolve({data:[],error:null})},from:q,
auth:{getSession:function(){return Promise.resolve({data:{session:null},error:null})},
getUser:function(){return Promise.resolve({data:{user:null},error:null})},
onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const TILE_HOSTS = /api\.maptiler\.com|api\.mapbox\.com|arcgisonline|cartocdn|tile\.openstreetmap/;

let passed = 0;
const fails = [];
const ok = (cond, what, detail) => {
  if (cond) { passed++; console.log("  PASS  " + what); }
  else { fails.push(what); console.log("  FAIL  " + what); if (detail) console.log("        " + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the predicate holds, or give up. Returns whether it held. */
const waitUntil = async (fn, timeout = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return true;
    await sleep(200);
  }
  return false;
};

/** Did the page ask this host for a tile? Waits for it rather than assuming. */
const asked = (hosts, re) => waitUntil(() => hosts.some((u) => re.test(u)));

/** Was a GL map actually built? Everything downstream is meaningless if not. */
const glMapUp = (page, sel) =>
  page.waitForSelector(sel + " canvas", { timeout: 25000 }).then(() => true).catch(() => false);

/**
 * maplibre-gl and leaflet come off jsdelivr on every page load, and every
 * context here runs with the cache off. When one of those fetches loses, the
 * page has no map library, initMap() returns early, no map is built, and
 * assertions about what the map asked for fail while nothing is actually
 * wrong. So the bundles are fetched ONCE here and served from memory. This
 * file is about the provider chain, not about a CDN.
 */
const LIBS = new Map();
for (const url of [
  "https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.js",
  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/leaflet@1.9/dist/leaflet.js",
]) {
  try {
    const res = await fetch(url);
    if (res.ok) LIBS.set(url, Buffer.from(await res.arrayBuffer()));
  } catch (e) { /* fall through to the live CDN below */ }
}
if (!LIBS.size) {
  console.error("Could not fetch the map libraries. Check the network and retry.");
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

/**
 * Open a page in a context of its own.
 *   refuse   hosts to answer 404 for, which is how a provider is killed
 *   noKeys   404 js/config.local.js, which is the GitHub Pages deploy
 * Returns the page, the tile URLs it asked for, and a close().
 */
async function open(url, { refuse = null, noKeys = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const hosts = [];
  await page.setViewport({ width: 390, height: 900 });
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() === "OPTIONS") {
      return r.respond({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (noKeys && /config\.local\.js/.test(u)) return r.respond({ status: 404, body: "" });
    if (/cdn\.jsdelivr\.net.*supabase/.test(u)) {
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: SUPABASE_STUB });
    }
    if (LIBS.has(u)) {
      return r.respond({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: LIBS.get(u),
      });
    }
    if (TILE_HOSTS.test(u)) {
      hosts.push(u);
      if (refuse && refuse.test(u)) {
        return r.respond({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
      }
      const font = /\.pbf/.test(u);
      return r.respond({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "content-type": font ? "application/x-protobuf" : "image/png",
        },
        body: font ? Buffer.alloc(0) : PNG,
      });
    }
    if (/supabase\.co/.test(u)) {
      return r.respond({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: "[]",
      });
    }
    if (/fonts\.googleapis|fonts\.gstatic/.test(u)) {
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    }
    r.continue();
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for the registry rather than sleeping a hopeful two seconds: several
  // of these contexts run at once, and under that load a fixed wait failed
  // this file's first three assertions while nothing was actually wrong.
  await page.waitForFunction(() => !!window.PawaBasemaps, { timeout: 30000 });
  return { page, hosts, close: () => ctx.close() };
}

// ---------------------------------------------------------------------------
console.log("\n1. The keys reach the browser, on a page that is not meet.html");
{
  // js/config.local.js was loaded by meet.html and nowhere else, so every other
  // map in the app ran unkeyed even on a machine that had the keys.
  const t = await open(BASE + "/jobs.html");
  await sleep(2000);
  const cfg = await t.page.evaluate(() => ({
    maptiler: !!(window.APP_CONFIG && window.APP_CONFIG.MAPTILER_KEY),
    mapbox: !!(window.APP_CONFIG && window.APP_CONFIG.MAPBOX_TOKEN),
    registry: typeof window.PawaBasemaps === "object",
  }));
  ok(cfg.registry, "PawaBasemaps is on the page");
  ok(cfg.maptiler, "the MapTiler key is loaded");
  ok(cfg.mapbox, "the Mapbox token is loaded");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n2. A keyed map draws from MapTiler, not the free stack");
{
  const t = await open(BASE + "/jobs.html");
  ok(await glMapUp(t.page, "#jobsMap"), "a GL map was built (else the page's scripts never arrived)");
  ok(await asked(t.hosts, /api\.maptiler\.com\/maps\/hybrid/),
     "the GL map asks MapTiler for hybrid imagery");
  ok(!t.hosts.some((u) => /arcgisonline/.test(u)),
     "and no longer asks Esri for anything");
  ok(!t.hosts.some((u) => /cartocdn/.test(u)),
     "nor CARTO, because the keyed hybrid carries its own labels");
  const style = await t.page.evaluate(() => {
    const s = window.pawaGlHybridStyle();
    return { ids: s.layers.map((l) => l.id), keyed: /maptiler/.test(s.glyphs || "") };
  });
  // Four raster layers per tile became one, because the keyed hybrid already
  // has the road and label overlays baked into the imagery.
  ok(style.ids.join(",") === "pawa_street,pawa_satellite",
     "one imagery layer and one street layer, not four", style.ids.join(","));
  ok(style.keyed, "and a glyph server, so symbol labels can draw");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n3. A Leaflet map goes through the same chain");
{
  const t = await open(BASE + "/share-location.html");
  await sleep(2500);
  const chain = await t.page.evaluate(() => (window.PawaBasemaps ? {
    sat: window.PawaBasemaps.pick("satellite").id,
    street: window.PawaBasemaps.pick("street").id,
  } : null));
  ok(chain && chain.sat === "maptiler-hybrid", "satellite resolves to MapTiler", JSON.stringify(chain));
  ok(chain && chain.street === "maptiler-streets", "street resolves to MapTiler", JSON.stringify(chain));
  // This page drew raw tile.openstreetmap.org, which OSM's tile usage policy
  // asks applications not to use, and which carries no imagery at all.
  ok(!t.hosts.some((u) => /tile\.openstreetmap\.org/.test(u)),
     "and share-location no longer hits tile.openstreetmap.org");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n4. A provider that stops serving is demoted, not stared at");
{
  const t = await open(BASE + "/jobs.html", { refuse: /api\.maptiler\.com/ });
  ok(await glMapUp(t.page, "#jobsMap"), "a GL map was built");
  // Wait for the burial, don't guess at how long it takes. The probe gives a
  // silent provider 8 seconds before calling it dead, so any fixed sleep short
  // of that is a coin flip on a loaded machine.
  await t.page.waitForFunction(
    () => JSON.parse(sessionStorage.getItem("pawa_basemap_dead") || "[]").length > 0,
    { timeout: 30000 });
  const state = await t.page.evaluate(() => ({
    dead: JSON.parse(sessionStorage.getItem("pawa_basemap_dead") || "[]"),
    now: window.PawaBasemaps.pick("satellite").id,
  }));
  ok(state.dead.includes("maptiler-hybrid"),
     "MapTiler is buried once it stops answering", JSON.stringify(state.dead));
  ok(state.now === "mapbox-satellite-streets",
     "and the next map on the page picks Mapbox", state.now);
  ok(await asked(t.hosts, /api\.mapbox\.com/),
     "the live map repointed itself without a reload");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n5. The deploy, which never receives js/config.local.js");
{
  // The MapTiler key sits in the tracked js/core/config.js precisely so this
  // case is keyed. The Mapbox token cannot join it there: GitHub's push
  // protection rejects a tracked `pk.` token.
  const t = await open(BASE + "/jobs.html", { noKeys: true });
  ok(await glMapUp(t.page, "#jobsMap"), "a GL map was built");
  const drew = await asked(t.hosts, /api\.maptiler\.com\/maps\/hybrid/);
  const cfg = await t.page.evaluate(() => ({
    maptiler: !!window.APP_CONFIG.MAPTILER_KEY,
    mapbox: !!window.APP_CONFIG.MAPBOX_TOKEN,
    sat: window.PawaBasemaps.pick("satellite").id,
  }));
  ok(cfg.maptiler, "MapTiler is keyed without the local file");
  ok(!cfg.mapbox, "Mapbox is not, and is skipped rather than called blank");
  ok(cfg.sat === "maptiler-hybrid", "so the deploy still draws keyed imagery", cfg.sat);
  ok(drew, "and asks MapTiler for it");
  ok(!t.hosts.some((u) => /api\.mapbox\.com/.test(u)),
     "with no call to Mapbox carrying an empty token");
  await t.close();
}

// ---------------------------------------------------------------------------
console.log("\n6. Strip both keys and the free stack comes back");
{
  const t = await open(BASE + "/jobs.html");
  await sleep(2000);
  // apiKey() reads APP_CONFIG when it is asked, so emptying it here is the
  // same as never having set it.
  const free = await t.page.evaluate(() => {
    window.APP_CONFIG.MAPTILER_KEY = "";
    window.APP_CONFIG.MAPBOX_TOKEN = "";
    const s = window.pawaGlHybridStyle();
    return {
      sat: window.PawaBasemaps.pick("satellite").id,
      street: window.PawaBasemaps.pick("street").id,
      ids: s.layers.map((l) => l.id),
      hasGlyphs: !!s.glyphs,
    };
  });
  ok(free.sat === "esri-imagery", "satellite falls to Esri", free.sat);
  ok(free.street === "carto-voyager", "street falls to CARTO", free.street);
  ok(free.ids.includes("pawa_roads") && free.ids.includes("pawa_labels"),
     "and the label overlay the free imagery needs is drawn back on", free.ids.join(","));
  // A style pointing at a glyph server that 404s is worse than one with none.
  ok(!free.hasGlyphs, "with no glyph server claimed, because there is none");
  await t.close();
}


console.log("\n" + passed + " passed, " + fails.length + " failed");
await browser.close();
process.exit(fails.length ? 1 : 0);

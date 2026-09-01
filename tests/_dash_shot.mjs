// Look at the DASHBOARD half of a portal page: the toolbar, the reminder note
// and the list of what you have already posted. Signed out it never renders,
// so the section is unhidden by hand and the list is filled with a couple of
// fake rows in the shape the page script writes.
import puppeteer from "puppeteer";
const file  = process.argv[2] || "agent-services.html";
const theme = process.argv[3] || "dark";
const W = Number(process.argv[4] || 390);
const H = Number(process.argv[5] || 844);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const STUB = `(function(){function C(){return new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive||k==="valueOf"||k==="toString"?()=>0:C(),apply:()=>C(),construct:()=>C()})}
window.maplibregl=C();window.L=C();
function q(){const p=Promise.resolve({data:[],error:null});const h=new Proxy(function(){},{get:(t,k)=>k==="then"?p.then.bind(p):k==="catch"?p.catch.bind(p):q(),apply:()=>q()});return h}
window.supabase={createClient:()=>({from:()=>q(),rpc:()=>q(),channel:()=>C(),removeChannel:()=>{},storage:{from:()=>q()},functions:{invoke:()=>Promise.resolve({data:null,error:null})},auth:{getSession:()=>Promise.resolve({data:{session:null}}),getUser:()=>Promise.resolve({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:()=>Promise.resolve({})}})};})();`;

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: W < 700 });
await p.setRequestInterception(true);
p.on("request", (r) => {
  const u = r.url();
  if (/service-worker\.js/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
  if (/cdn\.jsdelivr\.net.*\.css|fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/cdn\.jsdelivr\.net/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: STUB });
  if (/arcgisonline|basemaps|mapbox|maptiler|openstreetmap|supabase\.co\/storage|\.mp4$/.test(u))
    return r.respond({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
  if (/supabase\.co|locationiq|nominatim|osrm|overpass/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" }, body: "[]" });
  if (/^https?:\/\/(?!localhost)/.test(u)) return r.abort();
  r.continue();
});
const errs = [];
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (e) {} }, theme);
await p.goto("http://localhost:8080/" + file, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2000));

const pre = file.startsWith("agent-houses") ? "ah" : "as";
await p.evaluate((pre) => {
  document.getElementById(pre + "AuthCard").hidden = true;
  document.getElementById(pre + "FormSection").hidden = true;
  document.getElementById(pre + "Dashboard").hidden = false;
  document.getElementById(pre + "UserEmail").textContent = "neema@example.com";
  const list = document.getElementById(pre + "List");
  const t = (k) => window.t(k);
  if (pre === "as") {
    list.setAttribute("aria-busy", "false");
    list.innerHTML = [
      { title: "Home and office deep cleaning", where: "Mikocheni, Dar es Salaam" },
      { title: "Emergency plumbing, day or night", where: "Sakina, Arusha" },
      { title: "Maths and physics tutoring, Form 1 to 6", where: "" },
    ].map((r) => `<article class="ap-card">
        <div class="ap-card__photo" data-empty="${t("ap_no_photo")}"></div>
        <div class="ap-card__body">
          <h4 class="ap-card__title">${r.title}</h4>
          <span class="ap-card__meta">${r.where || t("ap_no_area")}</span>
        </div>
        <div class="ap-card__acts">
          <button type="button" class="ap-btn ap-btn--sm">${t("ap_edit")}</button>
          <button type="button" class="ap-btn ap-btn--sm ap-btn--danger">${t("ap_delete")}</button>
        </div>
      </article>`).join("");
  } else {
    list.className = "ah-list ah-table-mode";
    list.setAttribute("aria-busy", "false");
    list.innerHTML = `<table class="ah-table"><thead><tr>
        <th></th><th>Listing</th><th>Type</th><th>Area</th><th>Price</th><th></th></tr></thead>
      <tbody>
        <tr><td class="ah-td-photo"><span class="ah-thumb"></span></td>
          <td><span class="ah-row-title">Modern 2-bed with ocean view</span></td>
          <td class="ah-td-type"><span class="ah-pill ah-pill-rent">For rent</span></td>
          <td class="ah-td-area">Masaki</td>
          <td class="ah-td-price"><strong>1,800,000</strong><br><small>per month</small></td>
          <td class="ah-td-actions"><button class="ah-btn">Edit</button> <button class="ah-btn ah-btn-danger">Delete</button></td></tr>
        <tr><td class="ah-td-photo"><span class="ah-thumb"></span></td>
          <td><span class="ah-row-title">Godown on Nyerere Road</span></td>
          <td class="ah-td-type"><span class="ah-pill ah-pill-sale">For sale</span></td>
          <td class="ah-td-area">Vingunguti</td>
          <td class="ah-td-price"><strong>96,000,000</strong><br><small>total</small></td>
          <td class="ah-td-actions"><button class="ah-btn">Edit</button> <button class="ah-btn ah-btn-danger">Delete</button></td></tr>
      </tbody></table>`;
  }
}, pre);
await new Promise((r) => setTimeout(r, 600));

const base = `tests/_dash_${file.replace(/\W+/g, "_")}_${theme}_${W}`;
const total = await p.evaluate(() => document.documentElement.scrollHeight);
const shots = Math.min(4, Math.ceil(total / H));
for (let i = 0; i < shots; i++) {
  await p.evaluate((y) => window.scrollTo(0, y), i * H);
  await new Promise((r) => setTimeout(r, 300));
  await p.screenshot({ path: `${base}_${i}.png` });
}
console.log(`${base}_0..${shots - 1}.png (docH ${total})`);
console.log(errs.length ? errs.join("\n") : "no page errors");
await b.close();

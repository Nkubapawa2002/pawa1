// Same idea as _shot_light.mjs, but for p-message.html, which shows nothing at
// all until it has a signed-in session: the whole supabase-js module is replaced
// with a stub that answers pm_directory and pm_inbox, so the thread list and the
// directory actually have rows to draw. Dismisses the identity modal that opens
// on a device with no key, then shoots tests/_look_pmessage_<theme>.png.
//
// Usage: node server.js   then:  node tests/_shot_pm_light.mjs [light|dark]
import puppeteer from "puppeteer";
const theme = process.argv[2] || "light";
const stub = `window.supabase={createClient:function(){var s={user:{id:"u1",email:"pawa4761@gmail.com",is_anonymous:false}};
function t(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b};});
b.then=function(r,j){return Promise.resolve({data:[],error:null}).then(r,j)};return b}
return{rpc:function(n,a){if(n==="pm_directory")return Promise.resolve({data:[{user_id:"a1",display_name:"Juma Mwanga",region:"Mwanza",area:"Nyamagana",is_agent:true,reachable:true,public_key:"x",fingerprint:"1111 2222 3333"}],error:null});
if(n==="pm_inbox")return Promise.resolve({data:[{thread_id:"t1",kind:"direct",other_id:"a1",other_name:"Juma Mwanga",other_area:"Nyamagana",other_region:"Mwanza",other_guest:false,last_at:new Date().toISOString(),unread:2}],error:null});
return Promise.resolve({data:[],error:null})},from:t,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},getUser:function(){return Promise.resolve({data:{user:s.user},error:null})},signOut:function(){return Promise.resolve({error:null})},onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
await p.setRequestInterception(true);
p.on("request", (r) => {
  const u = r.url();
  if (/cdn\.jsdelivr\.net.*supabase/.test(u)) return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
  if (/fonts\.googleapis|fonts\.gstatic/.test(u)) return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  if (/supabase\.co/.test(u)) return r.respond({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
  r.continue();
});
await p.evaluateOnNewDocument((t) => { try { localStorage.setItem("pawa-theme", t); } catch (e) {} }, theme);
await p.goto("http://localhost:8080/p-message.html", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2000));
await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });
await p.screenshot({ path: `tests/_look_pmessage_${theme}.png` });
console.log("ok");
await b.close();

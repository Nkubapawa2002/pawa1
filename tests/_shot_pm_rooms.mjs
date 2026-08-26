// Screenshots of the three P-Message screens that did not exist before: the
// admin's member picker, a room's roster, and a conversation header that says
// where the other person works.
//
// Usage: node server.js   then:  node tests/_shot_pm_rooms.mjs [light|dark]
import puppeteer from "puppeteer";

const theme = process.argv[2] || "dark";
const AGENTS = [
  { user_id: "a1", display_name: "Juma Mwanga", region: "Mwanza", area: "Nyamagana",
    district: "Nyamagana", ward: "Mirongo", is_agent: true, n_houses: 6, n_trucks: 0, n_services: 0 },
  { user_id: "a2", display_name: "Neema Kileo", region: "Mwanza", area: "Ilemela",
    district: "Ilemela", ward: "Pasiansi", is_agent: true, n_houses: 0, n_trucks: 3, n_services: 0 },
  { user_id: "a3", display_name: "Rashid Omari", region: "Mwanza", area: null,
    district: null, ward: null, is_agent: true, n_houses: 0, n_trucks: 0, n_services: 2 },
  { user_id: "a4", display_name: "Salma Hamisi", region: "Mwanza", area: "Sengerema",
    district: "Sengerema", ward: "Nyamazugo", is_agent: true, n_houses: 2, n_trucks: 1, n_services: 0 },
];

const stub = `window.supabase={createClient:function(){
var AG=${JSON.stringify(AGENTS)};
var s={user:{id:"me",email:"pawa4761@gmail.com",is_anonymous:false}};
function t(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[{id:"room1",kind:"group",key_generation:0,title:"Mwanza house agents",region:"Mwanza",category:"houses"}],error:null}).then(r,j)};return b}
function rows(extra){return AG.map(function(a){var o={};for(var k in a)o[k]=a[k];o.public_key=window.__PK||"x";o.reachable=true;o.fingerprint="11111 22222 33333 44444 55555 66666";for(var k2 in (extra||{}))o[k2]=extra[k2];return o})}
return{rpc:function(n,a){
 if(n==="pm_agent_finder"||n==="pm_directory")return Promise.resolve({data:rows(),error:null});
 if(n==="pm_group_candidates")return Promise.resolve({data:rows(),error:null});
 if(n==="pm_thread_keys")return Promise.resolve({data:rows({role:"member",is_guest:false,joined_at:new Date().toISOString()}).concat([{user_id:"me",display_name:"You",public_key:"x",role:"owner",is_agent:false,is_guest:false,region:"Mwanza",area:null,district:null,ward:null}]),error:null});
 if(n==="pm_thread_size")return Promise.resolve({data:5,error:null});
 if(n==="pm_peer")return Promise.resolve({data:[{user_id:"a1",display_name:"Juma Mwanga",public_key:window.__PK||"x",fingerprint:"11111 22222 33333 44444 55555 66666",is_agent:true,is_guest:false,region:"Mwanza",area:"Nyamagana",area_kind:null,district:"Nyamagana",ward:"Mirongo"}],error:null});
 if(n==="pm_inbox")return Promise.resolve({data:[
   {thread_id:"room1",kind:"group",title:"Mwanza house agents",region:"Mwanza",other_id:null,other_name:null,other_area:null,other_region:null,other_guest:false,last_at:new Date().toISOString(),unread:3},
   {thread_id:"t1",kind:"direct",other_id:"a1",other_name:"Juma Mwanga",other_area:"Nyamagana",other_region:"Mwanza",other_guest:false,last_at:new Date().toISOString(),unread:1}],error:null});
 if(n==="pm_thread_messages")return Promise.resolve({data:[],error:null});
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2200);
// A REAL public key, so the safety number the header derives can actually be
// derived. With a placeholder, peer() throws inside fingerprint() and the
// header quietly keeps whatever the tapped row happened to know — which is the
// exact bug this screenshot exists to check for.
await p.evaluate(async () => {
  window.__PK = (await window.PMCrypto.generateIdentity()).publicKey;
});
await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });

// 1. The admin's picker, with the roster previewed.
await p.evaluate(() => document.getElementById("pmRoomsBtn").click());
await wait(400);
await p.evaluate(() => document.getElementById("pmRoomWho").click());
await wait(900);
await p.screenshot({ path: `tests/shot_pm_picker_${theme}.png` });

// 2. The room roster.
await p.evaluate(() => { document.getElementById("pmModalBack").classList.remove("is-on"); });
await p.evaluate(() => {
  const row = document.querySelector('#pmInbox [data-kind="group"]');
  if (row) row.click();
});
await wait(900);
await p.evaluate(() => document.getElementById("pmMembers").click());
await wait(900);
await p.screenshot({ path: `tests/shot_pm_roster_${theme}.png` });

// 3. A direct conversation header, which now says where they work.
await p.evaluate(() => { document.getElementById("pmModalBack").classList.remove("is-on"); });
await p.evaluate(() => document.getElementById("pmBack").click());
await wait(300);
await p.evaluate(() => {
  const row = document.querySelector('#pmInbox [data-kind="direct"]');
  if (row) row.click();
});
await wait(1400);
await p.screenshot({ path: `tests/shot_pm_header_${theme}.png` });

console.log("ok");
await b.close();

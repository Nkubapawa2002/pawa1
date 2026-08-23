// Screenshots of the three things the Agents tab and its storefront gained:
// presence, the kind of work, and a reply drawn under the thing it answers.
//
// Usage: node server.js   then:  node tests/_shot_pm_agents.mjs [light|dark]
import puppeteer from "puppeteer";

const theme = process.argv[2] || "dark";

// Presence is seeded rather than derived so the picture shows all three states
// at once — online, hours ago, and never seen, which must draw NOTHING.
const NOW = Date.now();
const AGENTS = [
  { user_id: "a1", display_name: "Juma Mwanga", region: "Mwanza", area: "Nyamagana",
    district: "Nyamagana", ward: "Mirongo", is_agent: true,
    n_houses: 6, n_trucks: 0, n_services: 0, n_jobs: 0,
    kinds: ["apartment", "house", "shop"],
    last_seen_at: new Date(NOW - 20 * 1000).toISOString(),
    last_listed_at: new Date(NOW - 2 * 86400000).toISOString() },
  { user_id: "a2", display_name: "Neema Kileo", region: "Mwanza", area: "Ilemela",
    district: "Ilemela", ward: "Pasiansi", is_agent: true,
    n_houses: 0, n_trucks: 3, n_services: 0, n_jobs: 0,
    kinds: ["canter", "7ton"],
    last_seen_at: new Date(NOW - 11 * 60 * 1000).toISOString(),
    last_listed_at: new Date(NOW - 5 * 86400000).toISOString() },
  { user_id: "a3", display_name: "Salma Hamisi", region: "Mwanza", area: "Sengerema",
    district: "Sengerema", ward: "Nyamazugo", is_agent: true,
    n_houses: 0, n_trucks: 0, n_services: 9, n_jobs: 0,
    kinds: ["plumbing", "electrical", "appliance_repair"],
    last_seen_at: new Date(NOW - 4 * 3600 * 1000).toISOString(),
    last_listed_at: new Date(NOW - 10 * 86400000).toISOString() },
  { user_id: "a4", display_name: "Rashid Omari", region: "Mwanza", area: null,
    district: null, ward: null, is_agent: true,
    n_houses: 0, n_trucks: 0, n_services: 0, n_jobs: 0, kinds: null,
    last_seen_at: null },
];

const LISTINGS = [
  { cat: "houses", listing_id: "h1", title: "Two rooms, Mirongo", kind: "apartment",
    price_tzs: 250000, unit: "month", photo: null, region: "Mwanza", area: "Nyamagana",
    verified: true, active: true, created_at: new Date(NOW).toISOString() },
  { cat: "houses", listing_id: "h2", title: "Shop on the main road", kind: "shop",
    price_tzs: 900000, unit: "month", photo: null, region: "Mwanza", area: "Nyamagana",
    verified: false, active: true, created_at: new Date(NOW).toISOString() },
  { cat: "houses", listing_id: "h3", title: "Self-contained near the market", kind: "house",
    price_tzs: 180000, unit: "month", photo: null, region: "Mwanza", area: "Nyamagana",
    verified: false, active: true, created_at: new Date(NOW).toISOString() },
];

const stub = `window.supabase={createClient:function(){
var AG=${JSON.stringify(AGENTS)};
var LS=${JSON.stringify(LISTINGS)};
var s={user:{id:"me",email:"pawa4761@gmail.com",is_anonymous:false}};
var MSGS=[];
function t(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[{id:"t1",kind:"direct",key_generation:0,title:null,region:"Mwanza",category:null}],error:null}).then(r,j)};return b}
function rows(){return AG.map(function(a){var o={};for(var k in a)o[k]=a[k];o.public_key=window.__PK||"x";o.reachable=true;o.fingerprint="11111 22222 33333 44444 55555 66666";return o})}
return{rpc:function(n,a){
 if(n==="pm_agent_finder"||n==="pm_directory"){var C=(a||{}).p_category,R=rows();
   if(C)R=R.filter(function(r){return C==="houses"?r.n_houses>0:C==="services"?r.n_services>0:C==="trucks"?r.n_trucks>0:C==="jobs"?r.n_jobs>0:false});
   return Promise.resolve({data:R,error:null})}
 if(n==="pm_online_window")return Promise.resolve({data:150,error:null});
 if(n==="pm_touch_seen")return Promise.resolve({data:new Date().toISOString(),error:null});
 if(n==="pm_agent_card")return Promise.resolve({data:[{user_id:"a1",display_name:"Juma Mwanga",is_agent:true,is_guest:false,reachable:true,region:"Mwanza",area:"Nyamagana",area_kind:"ward",district:"Nyamagana",ward:"Mirongo",lat:null,lng:null,bio:"Nimekuwa nikitafuta nyumba Nyamagana kwa miaka kumi. Ninajua kila mtaa, na sipendi kupoteza muda wa mteja.",n_houses:6,n_services:0,n_trucks:0,n_jobs:0,n_verified:2,kinds:["apartment","house","shop"],last_seen_at:new Date(Date.now()-20000).toISOString(),joined_at:new Date(Date.now()-90*86400000).toISOString()}],error:null});
 if(n==="pm_agent_listings")return Promise.resolve({data:LS,error:null});
 if(n==="pm_peer")return Promise.resolve({data:[{user_id:"a1",display_name:"Juma Mwanga",public_key:window.__PK||"x",fingerprint:"11111 22222 33333 44444 55555 66666",is_agent:true,is_guest:false,region:"Mwanza",area:"Nyamagana",area_kind:null,district:"Nyamagana",ward:"Mirongo",last_seen_at:new Date(Date.now()-20000).toISOString()}],error:null});
 if(n==="pm_start_direct")return Promise.resolve({data:"t1",error:null});
 if(n==="pm_thread_keys")return Promise.resolve({data:[{user_id:"a1",display_name:"Juma Mwanga",public_key:window.__PK||"x",role:"member",is_agent:true,is_guest:false,region:"Mwanza",area:"Nyamagana",area_kind:null,district:null,ward:null},{user_id:"me",display_name:"You",public_key:(window.PMCrypto&&window.PMCrypto.load()||{}).publicKey||"x",role:"owner",is_agent:false,is_guest:false,region:"Mwanza",area:null,district:null,ward:null}],error:null});
 if(n==="pm_thread_size")return Promise.resolve({data:2,error:null});
 if(n==="pm_send"){var id="m"+(MSGS.length+1);var mine=(a.p_keys||[]).filter(function(k){return k.user_id==="me"})[0]||{};MSGS.push({id:id,thread_id:"t1",sender_id:"me",iv:a.p_iv,ciphertext:a.p_ciphertext,epk:mine.epk||null,wrapped_key:mine.wrapped_key||null,reply_to:a.p_reply_to||null,sent_at:new Date().toISOString()});return Promise.resolve({data:id,error:null})}
 if(n==="pm_thread_messages")return Promise.resolve({data:MSGS.map(function(m){return{id:m.id,thread_id:"t1",sender_id:"me",sender_name:"You",sender_guest:false,alg:null,iv:m.iv,ciphertext:m.ciphertext,epk:m.epk,wrapped_key:m.wrapped_key,generation:null,seq:null,reply_to:m.reply_to,sent_at:m.sent_at}}),error:null});
 if(n==="pm_inbox")return Promise.resolve({data:[{thread_id:"t1",kind:"direct",other_id:"a1",other_name:"Juma Mwanga",other_area:"Nyamagana",other_region:"Mwanza",other_guest:false,last_at:new Date().toISOString(),unread:0}],error:null});
 return Promise.resolve({data:[],error:null})},from:t,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},getUser:function(){return Promise.resolve({data:{user:s.user},error:null})},signOut:function(){return Promise.resolve({error:null})},onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(path) {
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
  await p.goto("http://localhost:8080/" + path, { waitUntil: "domcontentloaded" });
  await wait(2200);
  return p;
}

// 1. The agent list: presence, kinds, and a link to each storefront.
{
  const p = await open("p-message.html");
  // A real key so the peer's safety number can actually be derived.
  await p.evaluate(async () => { window.__PK = (await window.PMCrypto.generateIdentity()).publicKey; });
  await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });
  await p.evaluate(() => document.getElementById("segPeople").click());
  await wait(1200);
  await p.screenshot({ path: `tests/shot_pm_agents_${theme}.png` });
  await p.close();
}

// 2. A reply, drawn under the thing it answers.
{
  const p = await open("p-message.html");
  await p.evaluate(async () => { window.__PK = (await window.PMCrypto.generateIdentity()).publicKey; });
  await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });
  await p.evaluate(() => document.getElementById("segPeople").click());
  await wait(900);
  await p.evaluate(() => document.querySelector('[data-person="a1"]').click());
  await wait(1400);
  for (const line of ["Nyumba ya vyumba viwili Nyamagana iko wapi?", "Bei ni ngapi kwa mwezi?"]) {
    await p.evaluate((txt) => {
      document.getElementById("pmInput").value = txt;
      document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
    }, line);
    await wait(900);
  }
  // Answer the FIRST one, so the quote is visibly not the message above it.
  await p.evaluate(() => document.querySelector("#pmLog [data-reply]").click());
  await wait(300);
  await p.evaluate(() => {
    document.getElementById("pmInput").value = "Iko Mkuyuni, karibu na soko kubwa.";
    document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
  });
  await wait(1100);
  // And leave one chosen, so the strip above the composer is in the picture.
  await p.evaluate(() => document.querySelector("#pmLog [data-reply]").click());
  await wait(400);
  await p.screenshot({ path: `tests/shot_pm_reply_${theme}.png` });
  await p.close();
}

// 3. The storefront.
{
  const p = await open("agent.html?u=a1");
  await wait(900);
  await p.screenshot({ path: `tests/shot_pm_storefront_${theme}.png`, fullPage: true });
  await p.close();
}

console.log("ok");
await b.close();

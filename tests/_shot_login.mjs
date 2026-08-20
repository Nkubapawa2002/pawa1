// Screenshot login.html in dark + light with supabase-js/fonts stubbed.
import puppeteer from "puppeteer";
import fs from "node:fs";

const SUPABASE_STUB = `(function(){
  function builder(){var b={};["select","eq","neq","gt","gte","lt","lte","in","is","or","filter","order","limit","range","match","single","maybeSingle"].forEach(function(m){b[m]=function(){return b;};});
    b.then=function(res,rej){return Promise.resolve({data:[],error:null}).then(res,rej);};return b;}
  var noSession=function(){return Promise.resolve({data:{session:null,user:null},error:null});};
  window.supabase={createClient:function(){return{from:builder,rpc:function(){return Promise.resolve({data:null,error:null});},
    auth:{getSession:noSession,getUser:noSession,signInWithPassword:noSession,signUp:noSession,signInWithOtp:noSession,verifyOtp:noSession,resetPasswordForEmail:noSession,updateUser:noSession,signInAnonymously:noSession,signOut:function(){return Promise.resolve({error:null});},onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}},
    storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}};}};}},
    channel:function(){return{on:function(){return this;},subscribe:function(){return this;}};},removeChannel:function(){}};}};
})();`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");

const page_url = process.argv[2] || "http://localhost:8080/login.html";
const out = process.argv[3] || "tests/_shot_login";
const browser = await puppeteer.launch({ headless: "new", args:["--no-sandbox","--disable-dev-shm-usage"], protocolTimeout: 120000 });

for (const theme of ["dark","light"]) {
  for (const [name,vp] of [["mobile",{width:414,height:896,deviceScaleFactor:2}],["desktop",{width:1280,height:900,deviceScaleFactor:1}]]) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("cdn.jsdelivr.net")) return r.respond({ status:200, contentType:"application/javascript", body: SUPABASE_STUB });
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return r.respond({ status:200, contentType:"text/css", body:"" });
      if (/arcgisonline|cartocdn|mapbox|supabase\.co\/storage/.test(u)) return r.respond({ status:200, contentType:"image/png", body: PNG });
      if (u.includes("supabase.co")) {
        if (r.method()==="OPTIONS") return r.respond({status:204, headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"}});
        return r.respond({ status:200, contentType:"application/json", headers:{"access-control-allow-origin":"*"}, body:"[]" });
      }
      r.continue();
    });
    const errs=[];
    page.on("pageerror",(e)=>errs.push(String(e)));
    page.on("console",(m)=>{ if(m.type()==="error") errs.push("console: "+m.text()); });
    await page.evaluateOnNewDocument((t)=>{ try{localStorage.setItem("pawa-theme",t);}catch(_){} }, theme);
    await page.goto(page_url, { waitUntil:"domcontentloaded", timeout: 60000 });
    await new Promise(r=>setTimeout(r,1800));
    const f = `${out}_${theme}_${name}.png`;
    await page.screenshot({ path: f, fullPage: true });
    process.stdout.write(`wrote ${f}\n`);
    if (errs.length) process.stdout.write("  errors: " + errs.slice(0,6).join(" | ") + "\n");
    await page.close();
  }
}
await browser.close();

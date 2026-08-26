import puppeteer from "puppeteer";
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const GEO=JSON.stringify([{place_id:1,lat:"-6.7724",lon:"39.2083",name:"Mlimani City",display_name:"Mlimani City, Ubungo, Dar es Salaam, Tanzania",type:"mall",category:"shop",addresstype:"mall"}]);
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"],protocolTimeout:60000});
const p=await b.newPage();
await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
p.on("pageerror",e=>console.log("PAGEERROR:",String(e).split("\n")[0]));
p.on("console",m=>{if(m.type()==="error")console.log("CONSOLE:",m.text().slice(0,140));});
await p.setRequestInterception(true);
p.on("request",r=>{const u=r.url();
  if(r.method()==="OPTIONS")return r.respond({status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"}});
  if(/cdn\.jsdelivr|fonts\./.test(u))return r.respond({status:200,headers:{"content-type":"text/css"},body:""});
  if(/arcgisonline|cartocdn|mapbox|openstreetmap|storage|\.mp4$/.test(u))return r.respond({status:200,headers:{"content-type":"image/png"},body:PNG});
  if(/nominatim|locationiq|\/search\?/.test(u))return r.respond({status:200,headers:{"access-control-allow-origin":"*","content-type":"application/json"},body:GEO});
  if(/supabase\.co|osrm/.test(u))return r.respond({status:200,headers:{"access-control-allow-origin":"*","content-type":"application/json"},body:"[]"});
  r.continue();});
await p.goto("http://localhost:8080/houses.html?life=1",{waitUntil:"domcontentloaded"});
await new Promise(r=>setTimeout(r,2200));
await p.evaluate(()=>{const i=document.getElementById("mpSearchInput");i.value="Mlimani";i.dispatchEvent(new Event("input",{bubbles:true}));});
await new Promise(r=>setTimeout(r,2200));
console.log(JSON.stringify(await p.evaluate(()=>{
  const r=document.getElementById("mpSearchResults");
  return { hidden:r.hidden, html:r.innerHTML.slice(0,400),
    firstChild:r.firstElementChild?.tagName+"."+r.firstElementChild?.className };
}),null,1));
// click the first row properly
await p.evaluate(()=>{const el=document.querySelector("#mpSearchResults > *"); el && el.click();});
await new Promise(r=>setTimeout(r,800));
console.log("after click:", await p.evaluate(()=>document.getElementById("mpCoords").textContent.trim()));
await b.close();

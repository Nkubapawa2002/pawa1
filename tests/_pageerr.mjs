import puppeteer from "puppeteer";
const URLS=["houses.html","near-me.html","house.html","agent-houses.html","area.html","frame.html"];
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
for(const u of URLS){
  const p=await b.newPage();
  const errs=[];
  p.on("pageerror",e=>errs.push(e.message));
  await p.goto("http://localhost:8080/"+u,{waitUntil:"domcontentloaded",timeout:20000}).catch(e=>errs.push("GOTO:"+e.message));
  await new Promise(r=>setTimeout(r,3500));
  console.log(u.padEnd(22), errs.length? "ERR: "+errs.slice(0,3).join(" | ") : "ok");
  await p.close();
}
await b.close();
